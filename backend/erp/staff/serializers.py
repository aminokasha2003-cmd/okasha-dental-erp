from datetime import datetime, time, timedelta
from decimal import Decimal

from django.utils import timezone
from rest_framework import serializers

from erp.core.api import ClinicScopedSerializer

from .models import (
    AttendanceRecord,
    EmploymentProfile,
    LeaveRequest,
    PayrollItem,
    PayrollLine,
    PayrollRun,
    PayrollSettings,
    RosterEntry,
    SalaryAdvance,
    ShiftTemplate,
)
from .services import closed_weekdays, leave_days


def money(value):
    return f"{Decimal(value or 0):.2f}"


def named(obj):
    return {"id": obj.pk, "en": obj.name_en, "ar": obj.name_ar} if obj else None


def person(staff):
    return {"id": staff.pk, "en": staff.name_en, "ar": staff.name_ar, "staff_type": staff.staff_type, "color": staff.color}


def local_hm(value):
    return timezone.localtime(value).strftime("%H:%M") if value else None


def overlaps(a_start, a_end, b_start, b_end):
    return a_start < b_end and b_start < a_end


class PayrollSettingsSerializer(serializers.ModelSerializer):
    class Meta:
        model = PayrollSettings
        fields = [
            "employee_insurance_rate", "employer_insurance_rate", "late_grace_minutes", "deduct_lateness",
            "deduct_absence", "work_days_per_month", "hours_per_day",
        ]

    def validate(self, attrs):
        for field in ("employee_insurance_rate", "employer_insurance_rate"):
            if field in attrs and not 0 <= attrs[field] <= 100:
                raise serializers.ValidationError({field: "Between 0 and 100."})
        if "work_days_per_month" in attrs and not 1 <= attrs["work_days_per_month"] <= 31:
            raise serializers.ValidationError({"work_days_per_month": "Between 1 and 31."})
        if "hours_per_day" in attrs and not 0 < attrs["hours_per_day"] <= 24:
            raise serializers.ValidationError({"hours_per_day": "Between 1 and 24."})
        return attrs


class EmploymentProfileSerializer(serializers.ModelSerializer):
    class Meta:
        model = EmploymentProfile
        fields = [
            "pay_type", "base_salary", "daily_rate", "hourly_rate", "overtime_multiplier", "hire_date", "national_id",
            "payout_method", "payout_account", "insured", "insurable_wage", "annual_leave_days", "notes", "updated_at",
        ]
        read_only_fields = ["updated_at"]

    def validate(self, attrs):
        for field in ("base_salary", "daily_rate", "hourly_rate", "insurable_wage"):
            if field in attrs and attrs[field] < 0:
                raise serializers.ValidationError({field: "Cannot be negative."})
        if "overtime_multiplier" in attrs and not 1 <= attrs["overtime_multiplier"] <= 5:
            raise serializers.ValidationError({"overtime_multiplier": "Between 1 and 5."})
        national_id = attrs.get("national_id", "").strip()
        if national_id and not (national_id.isdigit() and len(national_id) == 14):
            raise serializers.ValidationError({"national_id": "An Egyptian national ID has 14 digits."})
        return attrs


class ShiftTemplateSerializer(ClinicScopedSerializer):
    hours = serializers.SerializerMethodField()

    class Meta:
        model = ShiftTemplate
        fields = ["id", "name_en", "name_ar", "start_time", "end_time", "break_minutes", "branch", "color", "is_active", "hours"]
        read_only_fields = ["id"]

    def get_hours(self, obj):
        return round(shift_minutes(obj.start_time, obj.end_time, obj.break_minutes) / 60, 2)

    def validate(self, attrs):
        start = attrs.get("start_time", getattr(self.instance, "start_time", None))
        end = attrs.get("end_time", getattr(self.instance, "end_time", None))
        brk = attrs.get("break_minutes", getattr(self.instance, "break_minutes", 0))
        if start == end:
            raise serializers.ValidationError({"end_time": "The shift must end after it starts."})
        if shift_minutes(start, end, 0) <= brk:
            raise serializers.ValidationError({"break_minutes": "The break is longer than the shift."})
        return attrs


def shift_minutes(start, end, brk):
    day = datetime(2000, 1, 1)
    a, b = datetime.combine(day, start), datetime.combine(day, end)
    if b <= a:
        b += timedelta(days=1)
    return int((b - a).total_seconds() // 60) - brk


class RosterEntrySerializer(ClinicScopedSerializer):
    staff_info = serializers.SerializerMethodField()
    template_info = serializers.SerializerMethodField()
    minutes = serializers.IntegerField(read_only=True)
    start_time = serializers.TimeField(required=False)
    end_time = serializers.TimeField(required=False)
    break_minutes = serializers.IntegerField(required=False, min_value=0)

    class Meta:
        model = RosterEntry
        fields = [
            "id", "staff", "staff_info", "date", "template", "template_info", "start_time", "end_time", "break_minutes",
            "branch", "note", "minutes",
        ]
        read_only_fields = ["id"]

    def get_staff_info(self, obj):
        return person(obj.staff)

    def get_template_info(self, obj):
        t = obj.template
        return {"id": t.pk, "en": t.name_en, "ar": t.name_ar, "color": t.color} if t else None

    def validate(self, attrs):
        get = lambda f: attrs.get(f, getattr(self.instance, f, None))  # noqa: E731
        template = attrs.get("template")
        if template is not None:
            # A template fills in what was not given.
            attrs.setdefault("start_time", template.start_time)
            attrs.setdefault("end_time", template.end_time)
            attrs.setdefault("break_minutes", template.break_minutes)
            if "branch" not in attrs and template.branch_id:
                attrs["branch"] = template.branch
        start, end, staff, day = get("start_time"), get("end_time"), get("staff"), get("date")
        if start is None or end is None:
            raise serializers.ValidationError({"start_time": "Choose a shift or give the start and end times."})
        if start == end:
            raise serializers.ValidationError({"end_time": "The shift must end after it starts."})
        if not staff.is_active:
            raise serializers.ValidationError({"staff": "This person is not active."})
        entry = RosterEntry(staff=staff, date=day, start_time=start, end_time=end)
        others = RosterEntry.objects.filter(staff=staff, date=day)
        if self.instance is not None:
            others = others.exclude(pk=self.instance.pk)
        for other in others:
            if overlaps(entry.start_at, entry.end_at, other.start_at, other.end_at):
                raise serializers.ValidationError(
                    {"start_time": f"{staff.name_en} already works {other.start_time:%H:%M}–{other.end_time:%H:%M} that day."}
                )
        return attrs


def parse_hm(value, field):
    if value in (None, ""):
        return None
    try:
        return time.fromisoformat(value)
    except (TypeError, ValueError) as exc:
        raise serializers.ValidationError({field: "Use a time like 09:30."}) from exc


class AttendanceRecordSerializer(ClinicScopedSerializer):
    """Managers enter a day and local times; the clinic's time zone turns them
    into moments. A clock-out earlier than the clock-in is the next morning."""

    staff_info = serializers.SerializerMethodField()
    in_time = serializers.CharField(write_only=True, required=False)
    out_time = serializers.CharField(write_only=True, required=False, allow_blank=True, allow_null=True)
    reason = serializers.CharField(write_only=True, required=False, allow_blank=True)
    in_local = serializers.SerializerMethodField()
    out_local = serializers.SerializerMethodField()
    minutes = serializers.IntegerField(read_only=True)

    class Meta:
        model = AttendanceRecord
        fields = [
            "id", "staff", "staff_info", "date", "clock_in", "clock_out", "in_local", "out_local", "in_time", "out_time",
            "branch", "source", "note", "edit_reason", "reason", "minutes", "updated_at",
        ]
        read_only_fields = ["id", "clock_in", "clock_out", "source", "edit_reason", "updated_at"]

    def get_staff_info(self, obj):
        return person(obj.staff)

    def get_in_local(self, obj):
        return local_hm(obj.clock_in)

    def get_out_local(self, obj):
        return local_hm(obj.clock_out)

    def validate(self, attrs):
        inst = self.instance
        reason = (attrs.pop("reason", "") or "").strip()
        if not reason:
            raise serializers.ValidationError({"reason": "Say why the record is entered or changed by hand."})
        day = attrs.get("date", inst.date if inst else None)
        staff = attrs.get("staff", inst.staff if inst else None)
        in_t = parse_hm(attrs.pop("in_time", None), "in_time")
        out_raw = attrs.pop("out_time", "keep")
        if in_t is None and inst is not None:
            in_t = timezone.localtime(inst.clock_in).time()
        if in_t is None or day is None:
            raise serializers.ValidationError({"in_time": "Give the day and the clock-in time."})
        clock_in = timezone.make_aware(datetime.combine(day, in_t))
        if out_raw == "keep":
            clock_out = inst.clock_out if inst else None
            if clock_out is not None and inst is not None and (day != inst.date):
                out_t = timezone.localtime(clock_out).time()
                clock_out = timezone.make_aware(datetime.combine(day, out_t))
        else:
            out_t = parse_hm(out_raw, "out_time")
            clock_out = timezone.make_aware(datetime.combine(day, out_t)) if out_t else None
        if clock_out is not None and clock_out <= clock_in:
            clock_out += timedelta(days=1)
        if clock_out is not None and clock_out - clock_in > timedelta(hours=20):
            raise serializers.ValidationError({"out_time": "That is more than 20 hours of work."})
        if clock_in > timezone.now() + timedelta(minutes=5):
            raise serializers.ValidationError({"in_time": "The clock-in is in the future."})
        others = AttendanceRecord.objects.filter(staff=staff, date__gte=day - timedelta(days=1), date__lte=day + timedelta(days=1))
        if inst is not None:
            others = others.exclude(pk=inst.pk)
        far = timezone.now() + timedelta(days=3650)
        for other in others:
            if overlaps(clock_in, clock_out or far, other.clock_in, other.clock_out or far):
                raise serializers.ValidationError({"in_time": f"This overlaps another record on {other.date}."})
        attrs["clock_in"], attrs["clock_out"], attrs["edit_reason"] = clock_in, clock_out, reason[:255]
        attrs["date"] = day
        return attrs


class LeaveRequestSerializer(ClinicScopedSerializer):
    staff_info = serializers.SerializerMethodField()
    days = serializers.SerializerMethodField()
    decided_by_name = serializers.SerializerMethodField()

    class Meta:
        model = LeaveRequest
        fields = [
            "id", "staff", "staff_info", "kind", "start_date", "end_date", "days", "reason", "status", "decided_by",
            "decided_by_name", "decided_at", "decision_note", "created_at",
        ]
        read_only_fields = ["id", "status", "decided_by", "decided_at", "decision_note", "created_at"]

    def get_staff_info(self, obj):
        return person(obj.staff)

    def get_days(self, obj):
        closed = self.context.get("closed")
        if closed is None:
            closed = self.context["closed"] = closed_weekdays(obj.clinic)
        return leave_days(obj.start_date, obj.end_date, closed)

    def get_decided_by_name(self, obj):
        u = obj.decided_by
        return (u.get_full_name() or u.username) if u else None

    def validate(self, attrs):
        get = lambda f: attrs.get(f, getattr(self.instance, f, None))  # noqa: E731
        start, end, staff = get("start_date"), get("end_date"), get("staff")
        if end < start:
            raise serializers.ValidationError({"end_date": "The leave ends before it starts."})
        if (end - start).days > 120:
            raise serializers.ValidationError({"end_date": "Leave longer than 120 days needs separate requests."})
        clash = LeaveRequest.objects.filter(
            staff=staff, status__in=("pending", "approved"), start_date__lte=end, end_date__gte=start
        )
        if self.instance is not None:
            clash = clash.exclude(pk=self.instance.pk)
        if clash.exists():
            raise serializers.ValidationError({"start_date": "There is already leave asked for or approved on these days."})
        return attrs


class SalaryAdvanceSerializer(ClinicScopedSerializer):
    staff_info = serializers.SerializerMethodField()
    repaid = serializers.SerializerMethodField()
    remaining = serializers.SerializerMethodField()
    repayments = serializers.SerializerMethodField()
    amount = serializers.DecimalField(max_digits=12, decimal_places=2, min_value=Decimal("1"))
    monthly_installment = serializers.DecimalField(max_digits=12, decimal_places=2, min_value=Decimal("1"))

    class Meta:
        model = SalaryAdvance
        fields = [
            "id", "staff", "staff_info", "date", "amount", "monthly_installment", "reason", "status", "repaid",
            "remaining", "repayments", "created_at",
        ]
        read_only_fields = ["id", "status", "created_at"]

    def get_staff_info(self, obj):
        return person(obj.staff)

    def get_repaid(self, obj):
        return money(obj.repaid)

    def get_remaining(self, obj):
        return money(obj.remaining)

    def get_repayments(self, obj):
        return [{"date": r.date, "amount": money(r.amount), "run": r.line.run_id if r.line else None} for r in obj.repayments.all()]

    def validate(self, attrs):
        amount = attrs.get("amount", getattr(self.instance, "amount", None))
        installment = attrs.get("monthly_installment", getattr(self.instance, "monthly_installment", None))
        if installment > amount:
            raise serializers.ValidationError({"monthly_installment": "The installment is more than the advance."})
        if self.instance is not None and self.instance.repayments.exists() and "amount" in attrs and attrs["amount"] < self.instance.repaid:
            raise serializers.ValidationError({"amount": "Less than what is already repaid."})
        return attrs


class PayrollItemSerializer(serializers.ModelSerializer):
    direction = serializers.CharField(read_only=True)
    amount = serializers.DecimalField(max_digits=12, decimal_places=2, min_value=Decimal("0.01"))

    class Meta:
        model = PayrollItem
        fields = ["id", "kind", "label", "amount", "is_manual", "direction", "advance"]
        read_only_fields = ["id", "is_manual", "direction", "advance"]

    def validate_kind(self, value):
        if value in PayrollItem.AUTO:
            raise serializers.ValidationError("This deduction is worked out by payroll; waive it instead.")
        return value


class PayrollLineSerializer(serializers.ModelSerializer):
    staff_info = serializers.SerializerMethodField()
    items = PayrollItemSerializer(many=True, required=False)
    additions = serializers.SerializerMethodField()
    item_deductions = serializers.SerializerMethodField()
    run_status = serializers.CharField(source="run.status", read_only=True)
    period = serializers.DateField(source="run.period", read_only=True)
    income_tax = serializers.DecimalField(max_digits=12, decimal_places=2, min_value=Decimal("0"), required=False)

    class Meta:
        model = PayrollLine
        fields = [
            "id", "run", "run_status", "period", "staff", "staff_info", "pay_type", "rate", "figures", "base_pay",
            "overtime_pay", "commission", "commission_start", "commission_end", "commission_note",
            "employee_insurance", "employer_insurance", "income_tax", "waived", "additions", "item_deductions",
            "gross", "total_deductions", "net", "payout_method", "payout_account", "note", "items",
        ]
        read_only_fields = [
            "id", "run", "staff", "pay_type", "rate", "figures", "base_pay", "overtime_pay", "commission",
            "commission_start", "commission_end", "commission_note", "employee_insurance", "employer_insurance",
            "gross", "total_deductions", "net",
        ]

    def get_staff_info(self, obj):
        return person(obj.staff)

    def get_additions(self, obj):
        return money(obj.additions)

    def get_item_deductions(self, obj):
        return money(obj.item_deductions)

    def validate_waived(self, value):
        if not isinstance(value, list) or set(value) - set(PayrollItem.WAIVABLE):
            raise serializers.ValidationError(f"Only {', '.join(PayrollItem.WAIVABLE)} can be waived.")
        return sorted(set(value))


class PayrollRunSerializer(ClinicScopedSerializer):
    branch_info = serializers.SerializerMethodField()
    totals = serializers.SerializerMethodField()
    approved_by_name = serializers.SerializerMethodField()
    paid_by_name = serializers.SerializerMethodField()

    class Meta:
        model = PayrollRun
        fields = [
            "id", "period", "branch", "branch_info", "commission_period", "status", "notes", "calculated_at",
            "approved_by", "approved_by_name", "approved_at", "paid_by", "paid_by_name", "paid_on", "totals", "created_at",
        ]
        read_only_fields = fields

    def get_branch_info(self, obj):
        return named(obj.branch)

    def get_totals(self, obj):
        from .services import run_totals  # noqa: PLC0415

        return run_totals(obj)

    def _name(self, user):
        return (user.get_full_name() or user.username) if user else None

    def get_approved_by_name(self, obj):
        return self._name(obj.approved_by)

    def get_paid_by_name(self, obj):
        return self._name(obj.paid_by)


class PayrollRunDetailSerializer(PayrollRunSerializer):
    lines = PayrollLineSerializer(many=True, read_only=True)

    class Meta(PayrollRunSerializer.Meta):
        fields = [*PayrollRunSerializer.Meta.fields, "lines"]
        read_only_fields = fields
