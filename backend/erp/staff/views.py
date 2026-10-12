from collections import defaultdict
from datetime import date, timedelta
from decimal import Decimal

from django.db import transaction
from django.db.models import Prefetch
from django.shortcuts import get_object_or_404
from django.utils import timezone
from rest_framework import permissions
from rest_framework.decorators import action
from rest_framework.exceptions import NotFound, PermissionDenied, ValidationError
from rest_framework.response import Response
from rest_framework.views import APIView

from erp.core.api import AuditContextMixin, ClinicScopedViewSet, ModulePermission, require_clinic
from erp.masterdata.models import Branch, StaffMember

from . import services
from .models import (
    ZERO,
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
from .serializers import (
    AttendanceRecordSerializer,
    EmploymentProfileSerializer,
    LeaveRequestSerializer,
    PayrollLineSerializer,
    PayrollRunDetailSerializer,
    PayrollRunSerializer,
    PayrollSettingsSerializer,
    RosterEntrySerializer,
    SalaryAdvanceSerializer,
    ShiftTemplateSerializer,
    local_hm,
    money,
    named,
    person,
)

MODULE = "staff"


def parse_day(value, field, default=None):
    try:
        return date.fromisoformat(value) if value else default
    except ValueError as exc:
        raise ValidationError({field: "Use a date like 2026-10-09."}) from exc


def require(user, act):
    if not user.has_module_perm(MODULE, act):
        raise PermissionDenied("Your role does not allow this.")


def staff_of(clinic, pk, field="staff"):
    member = StaffMember.objects.filter(clinic=clinic, pk=pk).first() if pk not in (None, "") else None
    if member is None:
        raise ValidationError({field: "Not found."})
    return member


class StaffView(AuditContextMixin, APIView):
    permission_classes = [ModulePermission]
    module = MODULE


def shift_out(e):
    return {
        "id": e.pk,
        "start": e.start_time.strftime("%H:%M"),
        "end": e.end_time.strftime("%H:%M"),
        "break_minutes": e.break_minutes,
        "minutes": e.minutes,
        "branch": e.branch_id,
        "template": e.template_id,
        "color": (e.template.color if e.template_id and e.template else "") or "",
        "name": {"en": e.template.name_en, "ar": e.template.name_ar} if e.template_id and e.template else None,
        "note": e.note,
    }


def record_out(r):
    return {
        "id": r.pk, "date": r.date, "in": local_hm(r.clock_in), "out": local_hm(r.clock_out), "clock_in": r.clock_in,
        "clock_out": r.clock_out, "source": r.source, "branch": r.branch_id, "note": r.note, "minutes": r.minutes,
    }


def row_out(row, staff=None, now=None, rules=None):
    out = {
        "date": row["date"],
        "status": row["status"],
        "shifts": [shift_out(e) for e in row["shifts"]],
        "records": [record_out(r) for r in row["records"]],
        "leave": {"id": row["leave"].pk, "kind": row["leave"].kind} if row["leave"] else None,
        **{k: row[k] for k in ("rostered_minutes", "worked_minutes", "worked_now", "late_minutes", "early_leave_minutes", "overtime_minutes")},
    }
    if row["status"] == "not_in" and now and rules:
        out["late_minutes"] = services.minutes_between(row["shifts"][0].start_at + timedelta(minutes=rules.late_grace_minutes), now)
    if staff is not None:
        out["staff"] = person(staff)
    return out


# ------------------------------------------------------------ settings


class SettingsView(StaffView):
    def get(self, request):
        rules = PayrollSettings.for_clinic(require_clinic(request.user))
        return Response(PayrollSettingsSerializer(rules).data)

    def patch(self, request):
        require(request.user, "edit")
        rules = PayrollSettings.for_clinic(require_clinic(request.user))
        data = PayrollSettingsSerializer(rules, data=request.data, partial=True)
        data.is_valid(raise_exception=True)
        data.save()
        return Response(data.data)


class ProfilesView(StaffView):
    """Every staff member with their pay profile (null when not set yet)."""

    def get(self, request):
        clinic = require_clinic(request.user)
        qs = StaffMember.objects.filter(clinic=clinic).select_related("employment", "user").prefetch_related("branches")
        if not request.query_params.get("all"):
            qs = qs.filter(is_active=True)
        year = timezone.localdate().year
        closed = services.closed_weekdays(clinic)
        out = []
        for s in qs.order_by("name_en"):
            profile = getattr(s, "employment", None)
            out.append({
                **person(s),
                "is_active": s.is_active,
                "user": s.user_id,
                "branches": [b.pk for b in s.branches.all()],
                "commission_type": s.commission_type,
                "commission_value": money(s.commission_value),
                "profile": EmploymentProfileSerializer(profile).data if profile else None,
                "leave": services.leave_balance(clinic, s, year, closed),
            })
        return Response(out)


class ProfileView(StaffView):
    def get(self, request, staff_id):
        member = staff_of(require_clinic(request.user), staff_id)
        profile = getattr(member, "employment", None)
        return Response({**person(member), "profile": EmploymentProfileSerializer(profile).data if profile else None})

    def patch(self, request, staff_id):
        require(request.user, "edit")
        clinic = require_clinic(request.user)
        member = staff_of(clinic, staff_id)
        profile = EmploymentProfile.objects.filter(staff=member).first() or EmploymentProfile(clinic=clinic, staff=member)
        data = EmploymentProfileSerializer(profile, data=request.data, partial=True)
        data.is_valid(raise_exception=True)
        data.save(clinic=clinic, staff=member)
        return Response({**person(member), "profile": data.data})

    put = patch


# ---------------------------------------------------------- shifts, roster


class ShiftTemplateViewSet(ClinicScopedViewSet):
    queryset = ShiftTemplate.objects.select_related("branch")
    serializer_class = ShiftTemplateSerializer
    module = MODULE

    def get_queryset(self):
        qs = super().get_queryset()
        if self.request.query_params.get("active"):
            qs = qs.filter(is_active=True)
        return qs


class RosterViewSet(ClinicScopedViewSet):
    queryset = RosterEntry.objects.select_related("staff", "template", "branch")
    serializer_class = RosterEntrySerializer
    module = MODULE
    required_actions = {"week": "view", "copy_week": "create", "clear": "delete"}

    def get_queryset(self):
        qs = super().get_queryset()
        p = self.request.query_params
        start, end = parse_day(p.get("from"), "from"), parse_day(p.get("to"), "to")
        if start:
            qs = qs.filter(date__gte=start)
        if end:
            qs = qs.filter(date__lte=end)
        for field in ("staff", "branch"):
            if p.get(field):
                qs = qs.filter(**{field: p[field]})
        return qs

    @action(detail=False, methods=["get"])
    def week(self, request):
        """Seven days from ?start= (a Monday by default) for every active person."""
        clinic = require_clinic(request.user)
        today = timezone.localdate()
        start = parse_day(request.query_params.get("start"), "start", today - timedelta(days=today.weekday()))
        days = [start + timedelta(days=i) for i in range(7)]
        branch = request.query_params.get("branch")
        people = StaffMember.objects.filter(clinic=clinic, is_active=True).prefetch_related("branches")
        if branch:
            people = people.filter(branches=branch)
        entries = RosterEntry.objects.filter(clinic=clinic, date__range=(days[0], days[-1])).select_related("template")
        if branch:
            entries = entries.filter(branch=branch)
        leaves = services.approved_leave(clinic, days[0], days[-1])
        cells = defaultdict(list)
        for e in entries:
            cells[(e.staff_id, e.date)].append(e)
        rows = []
        seen = set()
        for s in people.order_by("name_en"):
            seen.add(s.pk)
            rows.append(self._row(s, days, cells, leaves))
        # People rostered here from elsewhere still show.
        for s in StaffMember.objects.filter(pk__in={k[0] for k in cells} - seen).order_by("name_en"):
            rows.append(self._row(s, days, cells, leaves))
        return Response({"start": days[0], "end": days[-1], "days": days, "rows": rows})

    def _row(self, s, days, cells, leaves):
        out = []
        for d in days:
            lv = next((x for x in leaves.get(s.pk, []) if x.start_date <= d <= x.end_date), None)
            entries = sorted(cells.get((s.pk, d), []), key=lambda e: e.start_time)
            out.append({"date": d, "shifts": [shift_out(e) for e in entries], "leave": lv.kind if lv else None})
        minutes = sum(sh["minutes"] for c in out for sh in c["shifts"])
        return {"staff": person(s), "days": out, "minutes": minutes}

    @action(detail=False, methods=["post"], url_path="copy-week")
    def copy_week(self, request):
        """Copy the week before ?start= into the week starting there, skipping clashes."""
        clinic = require_clinic(request.user)
        start = parse_day(request.data.get("start"), "start")
        if start is None:
            raise ValidationError({"start": "Give the first day of the week to fill."})
        branch = request.data.get("branch")
        source = RosterEntry.objects.filter(clinic=clinic, date__range=(start - timedelta(days=7), start - timedelta(days=1)))
        if branch:
            source = source.filter(branch=branch)
        created = skipped = 0
        with transaction.atomic():
            for e in source.select_related("staff"):
                if not e.staff.is_active:
                    skipped += 1
                    continue
                copy = RosterEntry(
                    clinic=clinic, staff=e.staff, date=e.date + timedelta(days=7), template=e.template,
                    start_time=e.start_time, end_time=e.end_time, break_minutes=e.break_minutes, branch=e.branch, note=e.note,
                )
                clash = any(
                    copy.start_at < o.end_at and o.start_at < copy.end_at
                    for o in RosterEntry.objects.filter(staff=e.staff, date=copy.date)
                )
                if clash:
                    skipped += 1
                    continue
                copy.save()
                created += 1
        return Response({"created": created, "skipped": skipped}, status=201 if created else 200)


# -------------------------------------------------------------- attendance


class AttendanceViewSet(ClinicScopedViewSet):
    queryset = AttendanceRecord.objects.select_related("staff", "branch")
    serializer_class = AttendanceRecordSerializer
    module = MODULE
    required_actions = {"clock": "create", "day": "view", "days": "view", "summary": "view"}

    def get_queryset(self):
        qs = super().get_queryset()
        p = self.request.query_params
        start, end = parse_day(p.get("from"), "from"), parse_day(p.get("to"), "to")
        if start:
            qs = qs.filter(date__gte=start)
        if end:
            qs = qs.filter(date__lte=end)
        for field in ("staff", "branch"):
            if p.get(field):
                qs = qs.filter(**{field: p[field]})
        return qs

    def perform_create(self, serializer):
        serializer.save(clinic=require_clinic(self.request.user), source="manual")

    def perform_destroy(self, instance):
        reason = str(self.request.data.get("reason", "") or self.request.query_params.get("reason", "")).strip()
        if not reason:
            raise ValidationError({"reason": "Say why the record is deleted."})
        # Keep the reason in the audit log before the record goes.
        instance.edit_reason = f"Deleted: {reason}"[:255]
        instance.save(update_fields=["edit_reason", "updated_at"])
        instance.delete()

    @action(detail=False, methods=["post"])
    def clock(self, request):
        """A manager clocks someone in or out now (the day board's buttons)."""
        clinic = require_clinic(request.user)
        member = staff_of(clinic, request.data.get("staff"))
        kind = request.data.get("action")
        branch = request.data.get("branch")
        branch = Branch.objects.filter(clinic=clinic, pk=branch).first() if branch else None
        note = str(request.data.get("note", ""))[:255]
        if kind == "in":
            record = clock_in(member, branch, source="manual", note=note or "Clocked in by a manager")
            return Response(AttendanceRecordSerializer(record, context={"request": request}).data, status=201)
        if kind == "out":
            record = clock_out(member)
            return Response(AttendanceRecordSerializer(record, context={"request": request}).data)
        raise ValidationError({"action": "Use in or out."})

    @action(detail=False, methods=["get"])
    def day(self, request):
        """The day board: who is rostered, in, late, absent or on leave."""
        clinic = require_clinic(request.user)
        day = parse_day(request.query_params.get("date"), "date", timezone.localdate())
        branch = request.query_params.get("branch") or None
        return Response(day_board(clinic, day, branch))

    @action(detail=False, methods=["get"])
    def days(self, request):
        """One row per person per day over a range, with the worked-out minutes."""
        clinic = require_clinic(request.user)
        p = request.query_params
        today = timezone.localdate()
        end = parse_day(p.get("to"), "to", today)
        start = parse_day(p.get("from"), "from", end - timedelta(days=6))
        if (end - start).days > 92:
            raise ValidationError({"from": "Choose up to three months."})
        staff_ids = [int(p["staff"])] if p.get("staff") else None
        rules = PayrollSettings.for_clinic(clinic)
        rows = services.day_rows(clinic, start, end, staff_ids, branch=p.get("branch") or None, rules=rules)
        people = {s.pk: s for s in StaffMember.objects.filter(pk__in={k[0] for k in rows})}
        out = [row_out(r, people[k[0]]) for k, r in rows.items() if r["status"] not in ("scheduled", "not_in")]
        out.sort(key=lambda r: (r["date"], r["staff"]["en"]))
        out.sort(key=lambda r: r["date"], reverse=True)
        return Response({"from": start, "to": end, "rows": out})

    @action(detail=False, methods=["get"])
    def summary(self, request):
        """Each person's month: rostered, present, absent, late, overtime, leave."""
        clinic = require_clinic(request.user)
        first = services.parse_month(request.query_params.get("month"))
        people = StaffMember.objects.filter(clinic=clinic, is_active=True)
        if request.query_params.get("staff"):
            people = people.filter(pk=request.query_params["staff"])
        sums = services.month_summaries(clinic, first, [s.pk for s in people])
        rows = [{"staff": person(s), **sums[s.pk]} for s in people.order_by("name_en")]
        return Response({"month": first, "rows": rows})


def day_board(clinic, day, branch=None):
    rules = PayrollSettings.for_clinic(clinic)
    now = timezone.now()
    rows = services.day_rows(clinic, day, day, branch=branch, rules=rules, now=now)
    people = {s.pk: s for s in StaffMember.objects.filter(pk__in={k[0] for k in rows})}
    out = [row_out(r, people[k[0]], now, rules) for k, r in rows.items()]
    order = {"in": 0, "not_in": 1, "missing_out": 2, "scheduled": 3, "out": 4, "absent": 5, "leave": 6, "off": 7}
    out.sort(key=lambda r: (order.get(r["status"], 9), r["staff"]["en"]))
    counts = {
        "rostered": sum(1 for r in out if r["shifts"]),
        "in_now": sum(1 for r in out if r["status"] == "in"),
        "late": sum(1 for r in out if r["late_minutes"] > 0 and r["status"] not in ("leave",)),
        "absent": sum(1 for r in out if r["status"] == "absent"),
        "not_in": sum(1 for r in out if r["status"] == "not_in"),
        "on_leave": sum(1 for r in out if r["status"] == "leave"),
    }
    return {"date": day, "grace": rules.late_grace_minutes, "counts": counts, "rows": out}


def open_record(member, now=None):
    now = now or timezone.now()
    return (
        AttendanceRecord.objects.filter(staff=member, clock_out__isnull=True, clock_in__gte=now - services.OPEN_LIMIT)
        .order_by("-clock_in")
        .first()
    )


def clock_in(member, branch=None, source="self", note=""):
    with transaction.atomic():
        StaffMember.objects.select_for_update().get(pk=member.pk)
        if not member.is_active:
            raise ValidationError("This staff profile is not active.")
        if open_record(member):
            raise ValidationError("Already clocked in. Clock out first.")
        now = timezone.now()
        today = timezone.localdate()
        if branch is None:
            shift = RosterEntry.objects.filter(staff=member, date=today, branch__isnull=False).order_by("start_time").first()
            branch = shift.branch if shift else None
        if branch is None:
            branches = list(member.branches.all()[:2])
            branch = branches[0] if len(branches) == 1 else None
        return AttendanceRecord.objects.create(
            clinic=member.clinic, staff=member, date=today, clock_in=now, branch=branch, source=source, note=note[:255]
        )


def auto_clock_in(user):
    """Clock a staff member in when they sign in, once a day. Nothing happens for a
    login without an active staff profile, for someone who already has a record
    today (open or closed), or for someone on approved leave today. Returns the
    new record or None."""
    if not user.clinic_id:
        return None
    member = StaffMember.objects.filter(user=user, clinic=user.clinic_id, is_active=True).first()
    if member is None:
        return None
    today = timezone.localdate()
    if AttendanceRecord.objects.filter(staff=member, date=today).exists() or open_record(member):
        return None
    if LeaveRequest.objects.filter(staff=member, status="approved", start_date__lte=today, end_date__gte=today).exists():
        return None
    try:
        return clock_in(member, source="auto", note="Clocked in automatically at sign-in")
    except ValidationError:
        # Someone else clocked them in at the same moment.
        return None


def clock_out(member):
    with transaction.atomic():
        StaffMember.objects.select_for_update().get(pk=member.pk)
        record = open_record(member)
        if record is None:
            raise ValidationError("Not clocked in.")
        record.clock_out = max(timezone.now(), record.clock_in)
        record.save(update_fields=["clock_out", "updated_at"])
        return record


# ------------------------------------------------------------------- leave


class LeaveViewSet(ClinicScopedViewSet):
    queryset = LeaveRequest.objects.select_related("staff", "decided_by")
    serializer_class = LeaveRequestSerializer
    module = MODULE
    http_method_names = ["get", "post", "patch", "delete", "head", "options"]
    required_actions = {"approve": "approve", "reject": "approve", "cancel": "edit", "balances": "view"}

    def get_queryset(self):
        qs = super().get_queryset()
        p = self.request.query_params
        if p.get("status"):
            qs = qs.filter(status__in=p["status"].split(","))
        if p.get("staff"):
            qs = qs.filter(staff=p["staff"])
        if p.get("kind"):
            qs = qs.filter(kind=p["kind"])
        if p.get("year"):
            year = int(p["year"])
            qs = qs.filter(start_date__lte=date(year, 12, 31), end_date__gte=date(year, 1, 1))
        return qs

    def perform_update(self, serializer):
        if serializer.instance.status != "pending":
            raise ValidationError("Only a pending request can be changed.")
        serializer.save()

    def perform_destroy(self, instance):
        if instance.status == "approved":
            raise ValidationError("Approved leave cannot be deleted. Cancel it instead.")
        instance.delete()

    def decide(self, request, status):
        leave = self.get_object()
        if leave.status != "pending":
            raise ValidationError("This request is already decided.")
        leave.status = status
        leave.decided_by = request.user
        leave.decided_at = timezone.now()
        leave.decision_note = str(request.data.get("note", ""))[:255]
        leave.save(update_fields=["status", "decided_by", "decided_at", "decision_note", "updated_at"])
        return Response(self.get_serializer(leave).data)

    @action(detail=True, methods=["post"])
    def approve(self, request, pk=None):
        return self.decide(request, "approved")

    @action(detail=True, methods=["post"])
    def reject(self, request, pk=None):
        return self.decide(request, "rejected")

    @action(detail=True, methods=["post"])
    def cancel(self, request, pk=None):
        leave = self.get_object()
        if leave.status not in ("pending", "approved"):
            raise ValidationError("This request is already closed.")
        if leave.status == "approved":
            require(request.user, "approve")
            if PayrollLine.objects.filter(
                staff=leave.staff, run__status__in=("approved", "paid"),
                run__period__lte=leave.end_date, run__period__gte=leave.start_date.replace(day=1),
            ).exists():
                raise ValidationError("A payroll that counts this leave is already approved.")
        leave.status = "cancelled"
        leave.decided_by = request.user
        leave.decided_at = timezone.now()
        leave.decision_note = str(request.data.get("note", ""))[:255]
        leave.save(update_fields=["status", "decided_by", "decided_at", "decision_note", "updated_at"])
        return Response(self.get_serializer(leave).data)

    @action(detail=False, methods=["get"])
    def balances(self, request):
        clinic = require_clinic(request.user)
        year = int(request.query_params.get("year") or timezone.localdate().year)
        closed = services.closed_weekdays(clinic)
        people = StaffMember.objects.filter(clinic=clinic, is_active=True).select_related("employment").order_by("name_en")
        rows = []
        leaves = services.approved_leave(clinic, date(year, 1, 1), date(year, 12, 31))
        for s in people:
            by_kind = defaultdict(int)
            for lv in leaves.get(s.pk, []):
                by_kind[lv.kind] += services.leave_days(lv.start_date, lv.end_date, closed, date(year, 1, 1), date(year, 12, 31))
            rows.append({"staff": person(s), **services.leave_balance(clinic, s, year, closed), "by_kind": dict(by_kind)})
        return Response({"year": year, "rows": rows})


# ---------------------------------------------------------------- advances


class AdvanceViewSet(ClinicScopedViewSet):
    queryset = SalaryAdvance.objects.select_related("staff").prefetch_related("repayments__line")
    serializer_class = SalaryAdvanceSerializer
    module = MODULE
    http_method_names = ["get", "post", "patch", "delete", "head", "options"]
    required_actions = {"cancel": "approve"}

    def get_queryset(self):
        qs = super().get_queryset()
        p = self.request.query_params
        if p.get("status"):
            qs = qs.filter(status__in=p["status"].split(","))
        if p.get("staff"):
            qs = qs.filter(staff=p["staff"])
        return qs

    def perform_update(self, serializer):
        if serializer.instance.status != "active":
            raise ValidationError("This advance is closed.")
        serializer.save()

    def perform_destroy(self, instance):
        if instance.repayments.exists() or instance.payroll_items.exists():
            raise ValidationError("This advance is on a payroll. Cancel it instead.")
        instance.delete()

    @action(detail=True, methods=["post"])
    def cancel(self, request, pk=None):
        adv = self.get_object()
        if adv.status != "active":
            raise ValidationError("This advance is already closed.")
        if adv.payroll_items.filter(line__run__status__in=("draft", "approved")).exists():
            raise ValidationError("An unpaid payroll deducts this advance. Recalculate or pay it first.")
        adv.status = "cancelled"
        adv.save(update_fields=["status", "updated_at"])
        return Response(self.get_serializer(adv).data)


# ----------------------------------------------------------------- payroll


LINE_PREFETCH = Prefetch("lines", queryset=PayrollLine.objects.select_related("staff").prefetch_related("items"))


class PayrollRunViewSet(ClinicScopedViewSet):
    queryset = PayrollRun.objects.select_related("branch", "approved_by", "paid_by").prefetch_related(LINE_PREFETCH)
    serializer_class = PayrollRunSerializer
    module = MODULE
    http_method_names = ["get", "post", "patch", "delete", "head", "options"]
    required_actions = {
        "recalculate": "edit", "approve": "approve", "reopen": "approve", "pay": "approve", "totals": "view",
        "partial_update": "edit",
    }

    def get_serializer_class(self):
        return PayrollRunDetailSerializer if self.action != "list" else PayrollRunSerializer

    def get_queryset(self):
        qs = super().get_queryset()
        p = self.request.query_params
        if p.get("status"):
            qs = qs.filter(status__in=p["status"].split(","))
        if p.get("year"):
            qs = qs.filter(period__year=p["year"])
        return qs

    def fresh(self, run, status=200):
        return Response(PayrollRunDetailSerializer(self.get_queryset().get(pk=run.pk), context=self.get_serializer_context()).data, status=status)

    def create(self, request, *args, **kwargs):
        clinic = require_clinic(request.user)
        period = services.parse_month(request.data.get("month"))
        c_month = request.data.get("commission_month")
        commission_period = services.parse_month(c_month, "commission_month") if c_month else period
        branch = request.data.get("branch") or None
        if branch:
            branch = Branch.objects.filter(clinic=clinic, pk=branch).first()
            if branch is None:
                raise ValidationError({"branch": "Not found."})
        same = PayrollRun.objects.filter(clinic=clinic, period=period)
        if same.filter(branch=branch).exists():
            raise ValidationError({"month": "There is already a payroll for this month."})
        if branch is None and same.exists():
            raise ValidationError({"month": "This month already has branch payrolls."})
        if branch is not None and same.filter(branch__isnull=True).exists():
            raise ValidationError({"month": "This month already has a payroll for all branches."})
        with transaction.atomic():
            run = PayrollRun.objects.create(
                clinic=clinic, period=period, branch=branch, commission_period=commission_period,
                notes=str(request.data.get("notes", ""))[:2000],
            )
            services.calculate_run(run)
        return self.fresh(run, 201)

    def perform_update(self, serializer):
        if serializer.instance.status != "draft":
            raise ValidationError("Only a draft payroll can be changed.")
        serializer.save()

    def partial_update(self, request, *args, **kwargs):
        run = self.get_object()
        if run.status != "draft":
            raise ValidationError("Only a draft payroll can be changed.")
        changed = []
        if "notes" in request.data:
            run.notes = str(request.data["notes"])[:2000]
            changed.append("notes")
        if request.data.get("commission_month"):
            run.commission_period = services.parse_month(request.data["commission_month"], "commission_month")
            changed.append("commission_period")
        if changed:
            run.save(update_fields=[*changed, "updated_at"])
        if "commission_period" in changed:
            services.calculate_run(run)
        return self.fresh(run)

    def perform_destroy(self, instance):
        if instance.status != "draft":
            raise ValidationError("Only a draft payroll can be deleted.")
        instance.delete()

    @action(detail=True, methods=["post"])
    def recalculate(self, request, pk=None):
        run = self.get_object()
        services.calculate_run(run)
        return self.fresh(run)

    @action(detail=True, methods=["post"])
    def approve(self, request, pk=None):
        run = self.get_object()
        if run.status != "draft":
            raise ValidationError("Only a draft payroll can be approved.")
        if not run.lines.exists():
            raise ValidationError("This payroll has nobody on it.")
        run.status = "approved"
        run.approved_by = request.user
        run.approved_at = timezone.now()
        run.save(update_fields=["status", "approved_by", "approved_at", "updated_at"])
        return self.fresh(run)

    @action(detail=True, methods=["post"])
    def reopen(self, request, pk=None):
        run = self.get_object()
        if run.status != "approved":
            raise ValidationError("Only an approved, unpaid payroll can be reopened.")
        run.status = "draft"
        run.approved_by = None
        run.approved_at = None
        run.save(update_fields=["status", "approved_by", "approved_at", "updated_at"])
        return self.fresh(run)

    @action(detail=True, methods=["post"])
    def pay(self, request, pk=None):
        run = self.get_object()
        paid_on = parse_day(request.data.get("paid_on"), "paid_on", timezone.localdate())
        methods = request.data.get("methods") or {}
        if not isinstance(methods, dict):
            raise ValidationError({"methods": "Give a payout method per line."})
        services.pay_run(run, paid_on, methods, request.user)
        return self.fresh(run)

    @action(detail=True, methods=["get"])
    def totals(self, request, pk=None):
        return Response(services.run_totals(self.get_object()))


class PayrollLineViewSet(ClinicScopedViewSet):
    queryset = PayrollLine.objects.select_related("run", "staff").prefetch_related("items")
    serializer_class = PayrollLineSerializer
    module = MODULE
    http_method_names = ["get", "patch", "head", "options"]
    required_actions = {"payslip": "view"}

    def get_permissions(self):
        # Anyone may ask for a payslip; the view checks it is theirs or they hold staff view.
        if self.action == "payslip":
            return [permissions.IsAuthenticated()]
        return super().get_permissions()

    def get_queryset(self):
        qs = super().get_queryset()
        if self.request.query_params.get("run"):
            qs = qs.filter(run=self.request.query_params["run"])
        if self.request.query_params.get("staff"):
            qs = qs.filter(staff=self.request.query_params["staff"])
        return qs

    def partial_update(self, request, *args, **kwargs):
        line = self.get_object()
        if line.run.status != "draft":
            raise ValidationError("This payroll is approved. Reopen it to make changes.")
        data = PayrollLineSerializer(line, data=request.data, partial=True, context=self.get_serializer_context())
        data.is_valid(raise_exception=True)
        v = data.validated_data
        items = v.pop("items", None)
        with transaction.atomic():
            for field in ("income_tax", "waived", "payout_method", "payout_account", "note"):
                if field in v:
                    setattr(line, field, v[field])
            line.save()
            if items is not None:
                line.items.filter(is_manual=True).delete()
                for item in items:
                    PayrollItem.objects.create(line=line, kind=item["kind"], label=item.get("label", "")[:120], amount=item["amount"])
            if "waived" in v:
                # Waiving or restoring a worked-out deduction needs the figures again.
                services.calculate_run(line.run)
                line.refresh_from_db()
            line = PayrollLine.objects.prefetch_related("items").get(pk=line.pk)
            line.total()
            line.save(update_fields=["gross", "total_deductions", "net", "updated_at"])
        line = self.get_queryset().get(pk=line.pk)
        return Response(PayrollLineSerializer(line, context=self.get_serializer_context()).data)

    @action(detail=True, methods=["get"])
    def payslip(self, request, pk=None):
        clinic = require_clinic(request.user)
        line = PayrollLine.objects.filter(clinic=clinic, pk=pk).select_related("run", "staff").first()
        if line is None:
            raise NotFound()
        own = line.staff.user_id == request.user.pk
        if not (request.user.has_module_perm(MODULE, "view") or (own and line.run.status != "draft")):
            raise PermissionDenied("Only your own payslips.")
        return Response(payslip(line, request))


def payslip(line, request=None):
    staff = line.staff
    profile = getattr(staff, "employment", None)
    run = line.run
    advances = SalaryAdvance.objects.filter(staff=staff, status="active").prefetch_related("repayments")
    remaining = sum((a.remaining for a in advances), ZERO)
    if run.status != "paid":
        # Installments on this slip are only recorded as repaid once the run is paid.
        remaining -= sum((i.amount for i in line.items.all() if i.kind == "advance"), ZERO)
    return {
        "line": PayrollLineSerializer(line, context={"request": request}).data,
        "run": {"id": run.pk, "period": run.period, "status": run.status, "paid_on": run.paid_on, "branch": named(run.branch)},
        "staff": {
            **person(staff),
            "national_id": profile.national_id if profile else "",
            "hire_date": profile.hire_date if profile else None,
        },
        "advances_remaining": money(max(remaining, ZERO)),
    }


# ----------------------------------------------------- summary, dashboard


class SummaryView(StaffView):
    """Today's counts for the page header, and what waits for a decision (the sidebar badge)."""

    def get(self, request):
        clinic = require_clinic(request.user)
        board = day_board(clinic, timezone.localdate(), request.query_params.get("branch") or None)
        return Response({
            **board["counts"],
            "pending_leave": LeaveRequest.objects.filter(clinic=clinic, status="pending").count(),
            "draft_runs": PayrollRun.objects.filter(clinic=clinic, status="draft").count(),
            "approved_runs": PayrollRun.objects.filter(clinic=clinic, status="approved").count(),
            "active_advances": SalaryAdvance.objects.filter(clinic=clinic, status="active").count(),
        })


class DashboardView(StaffView):
    def get(self, request):
        clinic = require_clinic(request.user)
        first = services.parse_month(request.query_params.get("month"))
        last = services.month_end(first)
        today = timezone.localdate()

        active = StaffMember.objects.filter(clinic=clinic, is_active=True)
        headcount = active.count()
        on_payroll = active.filter(employment__isnull=False).count()

        months = [services.add_months(first, -i) for i in range(11, -1, -1)]
        cost = {m: {"gross": ZERO, "employer": ZERO, "net": ZERO, "runs": set()} for m in months}
        for line in PayrollLine.objects.filter(run__clinic=clinic, run__period__in=months).select_related("run"):
            c = cost[line.run.period]
            c["gross"] += line.gross
            c["employer"] += line.employer_insurance
            c["net"] += line.net
            c["runs"].add(line.run.status)
        trend = [
            {
                "month": m, "gross": money(c["gross"]), "employer_insurance": money(c["employer"]),
                "cost": money(c["gross"] + c["employer"]), "net": money(c["net"]),
                "status": "paid" if c["runs"] == {"paid"} else "approved" if c["runs"] and c["runs"] <= {"approved", "paid"} else "draft" if c["runs"] else None,
            }
            for m, c in cost.items()
        ]

        people = {s.pk: s for s in active}
        rows = services.day_rows(clinic, first, min(last, today) if first <= today else last, list(people))
        sums = services.month_summaries(clinic, first, list(people))
        rostered_past = [r for (sid, d), r in rows.items() if r["shifts"] and d <= today and r["status"] not in ("scheduled", "not_in")]
        attended = [r for r in rostered_past if r["records"]]
        excused = [r for r in rostered_past if r["status"] == "leave"]
        base = len(rostered_past) - len(excused)
        late_rows = sorted(
            ({"staff": person(people[sid]), "minutes": s["late_minutes"], "days": s["late_days"]} for sid, s in sums.items() if s["late_minutes"] > 0 and sid in people),
            key=lambda r: -r["minutes"],
        )
        overtime_rows = sorted(
            ({"staff": person(people[sid]), "minutes": s["overtime_minutes"]} for sid, s in sums.items() if s["overtime_minutes"] > 0 and sid in people),
            key=lambda r: -r["minutes"],
        )
        leave_by_kind = defaultdict(int)
        for s in sums.values():
            for kind, n in s["leave_days"].items():
                leave_by_kind[kind] += n

        commission = defaultdict(lambda: {"amount": ZERO, "status": set()})
        for line in PayrollLine.objects.filter(run__clinic=clinic, run__period=first, commission__gt=0).select_related("staff", "run"):
            c = commission[line.staff_id]
            c["staff"] = person(line.staff)
            c["amount"] += line.commission
            c["status"].add(line.run.status)
        advances = [a for a in SalaryAdvance.objects.filter(clinic=clinic, status="active").select_related("staff").prefetch_related("repayments")]
        month_cost = next(t for t in trend if t["month"] == first)
        return Response({
            "month": first,
            "headcount": headcount,
            "on_payroll": on_payroll,
            "payroll_cost": month_cost["cost"],
            "payroll_net": month_cost["net"],
            "payroll_status": month_cost["status"],
            "attendance_rate": round(len(attended) / base * 100, 1) if base > 0 else None,
            "rostered_days": len(rostered_past),
            "absent_days": sum(s["absent_days"] for s in sums.values()),
            "late_minutes": sum(s["late_minutes"] for s in sums.values()),
            "late_days": sum(s["late_days"] for s in sums.values()),
            "overtime_minutes": sum(s["overtime_minutes"] for s in sums.values()),
            "trend": trend,
            "top_late": late_rows[:8],
            "overtime": overtime_rows[:8],
            "leave_by_kind": [{"kind": k, "days": n} for k, n in sorted(leave_by_kind.items(), key=lambda kv: -kv[1])],
            "commission": sorted(
                ({"staff": c["staff"], "amount": money(c["amount"]), "paid": c["status"] == {"paid"}} for c in commission.values()),
                key=lambda r: -Decimal(r["amount"]),
            ),
            "advances_outstanding": money(sum((a.remaining for a in advances), ZERO)),
            "advances": sorted(
                ({"id": a.pk, "staff": person(a.staff), "remaining": money(a.remaining), "installment": money(a.monthly_installment)} for a in advances),
                key=lambda r: -Decimal(r["remaining"]),
            )[:8],
        })


# --------------------------------------------------------- the staff member


class MeBase(AuditContextMixin, APIView):
    """A user's own attendance, leave and payslips. Needs no staff module
    rights, only a login linked to a staff profile."""

    permission_classes = [permissions.IsAuthenticated]

    def member(self, request):
        require_clinic(request.user)
        member = StaffMember.objects.filter(user=request.user, clinic=request.user.clinic_id).first()
        if member is None:
            raise PermissionDenied("Your login is not linked to a staff profile.")
        return member


class MeView(MeBase):
    def get(self, request):
        member = self.member(request)
        clinic = member.clinic
        rules = PayrollSettings.for_clinic(clinic)
        now = timezone.now()
        today = timezone.localdate()
        rows = services.day_rows(clinic, today, today, [member.pk], rules=rules, now=now)
        row = rows.get((member.pk, today))
        record = open_record(member, now)
        first = today.replace(day=1)
        month = services.month_summaries(clinic, first, [member.pk], rules=rules, now=now)[member.pk]
        lines = PayrollLine.objects.filter(staff=member, run__status__in=("approved", "paid")).select_related("run").order_by("-run__period")[:12]
        leave = LeaveRequest.objects.filter(staff=member).order_by("-start_date")[:10]
        return Response({
            "staff": person(member),
            "today": {
                "date": today,
                **(row_out(row, None, now, rules) if row else {"status": "off", "shifts": [], "records": [], "leave": None, "worked_now": 0, "late_minutes": 0}),
                "open_record": record_out(record) if record else None,
            },
            "grace": rules.late_grace_minutes,
            "month": {"month": first, **month},
            "payslips": [
                {"id": ln.pk, "period": ln.run.period, "status": ln.run.status, "net": money(ln.net), "paid_on": ln.run.paid_on}
                for ln in lines
            ],
            "leave": {
                "balance": services.leave_balance(clinic, member, today.year),
                "requests": LeaveRequestSerializer(leave, many=True, context={"request": request}).data,
            },
        })


class MeClockInView(MeBase):
    def post(self, request):
        member = self.member(request)
        branch = request.data.get("branch")
        branch = Branch.objects.filter(clinic=member.clinic, pk=branch).first() if branch else None
        record = clock_in(member, branch)
        return Response(record_out(record), status=201)


class MeClockOutView(MeBase):
    def post(self, request):
        record = clock_out(self.member(request))
        return Response(record_out(record))


class MeLeaveView(MeBase):
    def get(self, request):
        member = self.member(request)
        rows = LeaveRequest.objects.filter(staff=member).order_by("-start_date")
        return Response(LeaveRequestSerializer(rows, many=True, context={"request": request}).data)

    def post(self, request):
        member = self.member(request)
        data = LeaveRequestSerializer(data={**request.data, "staff": member.pk}, context={"request": request})
        data.is_valid(raise_exception=True)
        leave = data.save(clinic=member.clinic)
        return Response(LeaveRequestSerializer(leave, context={"request": request}).data, status=201)


class MeLeaveCancelView(MeBase):
    def post(self, request, pk):
        member = self.member(request)
        leave = get_object_or_404(LeaveRequest, pk=pk, staff=member)
        if leave.status != "pending":
            raise ValidationError("Only a pending request can be withdrawn.")
        leave.status = "cancelled"
        leave.decided_at = timezone.now()
        leave.decided_by = request.user
        leave.decision_note = "Withdrawn"
        leave.save(update_fields=["status", "decided_by", "decided_at", "decision_note", "updated_at"])
        return Response(LeaveRequestSerializer(leave, context={"request": request}).data)


class MePayslipView(MeBase):
    def get(self, request, pk):
        member = self.member(request)
        line = PayrollLine.objects.filter(pk=pk, staff=member, run__status__in=("approved", "paid")).select_related("run", "staff").first()
        if line is None:
            raise NotFound()
        return Response(payslip(line, request))

