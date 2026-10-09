from decimal import Decimal

from django.db.models import Q
from rest_framework import serializers

from erp.clinical.models import TreatmentPlanLine
from erp.core.api import ClinicScopedSerializer
from erp.masterdata.models import Branch, Procedure

from .models import ZERO, CashboxClosing, Installment, Invoice, InvoiceLine, Payment


def money(value):
    return f"{Decimal(value):.2f}"


def patient_info(patient):
    return {"id": patient.pk, "ar": patient.name_ar, "en": patient.name_en, "file_number": patient.file_number, "phone": patient.phone}


def staff_name(member):
    return {"ar": member.name_ar, "en": member.name_en} if member else None


def invoiced_line_ids(clinic, exclude_invoice=None):
    qs = InvoiceLine.objects.filter(invoice__clinic=clinic, plan_line__isnull=False).exclude(invoice__status="void")
    if exclude_invoice is not None:
        qs = qs.exclude(invoice=exclude_invoice)
    return set(qs.values_list("plan_line_id", flat=True))


class InvoiceLineSerializer(serializers.ModelSerializer):
    total = serializers.SerializerMethodField()
    dentist_name = serializers.SerializerMethodField()

    class Meta:
        model = InvoiceLine
        fields = ["id", "plan_line", "procedure", "dentist", "dentist_name", "description", "tooth", "quantity", "unit_price", "discount", "total"]

    def get_total(self, obj):
        return money(obj.total)

    def get_dentist_name(self, obj):
        return staff_name(obj.dentist)


class InstallmentSerializer(serializers.ModelSerializer):
    paid = serializers.SerializerMethodField()
    remaining = serializers.SerializerMethodField()
    status = serializers.ReadOnlyField()
    invoice_number = serializers.CharField(source="invoice.number", read_only=True)
    patient_info = serializers.SerializerMethodField()

    class Meta:
        model = Installment
        fields = ["id", "invoice", "invoice_number", "patient_info", "number", "due_date", "amount", "paid", "remaining", "status"]

    def get_paid(self, obj):
        return money(obj.paid)

    def get_remaining(self, obj):
        return money(obj.remaining)

    def get_patient_info(self, obj):
        return patient_info(obj.invoice.patient)


class InvoiceSerializer(ClinicScopedSerializer):
    lines = InvoiceLineSerializer(many=True, read_only=True)
    installments = InstallmentSerializer(many=True, read_only=True)
    patient_info = serializers.SerializerMethodField()
    totals = serializers.SerializerMethodField()
    payment_status = serializers.ReadOnlyField()

    class Meta:
        model = Invoice
        fields = [
            "id", "number", "patient", "patient_info", "branch", "issue_date", "status", "payment_status", "discount", "tax_rate",
            "notes", "void_reason", "voided_at", "lines", "installments", "totals", "created_at",
        ]
        read_only_fields = ["id", "number", "status", "tax_rate", "void_reason", "voided_at", "created_at"]

    def get_patient_info(self, obj):
        return patient_info(obj.patient)

    def get_totals(self, obj):
        return {k: money(getattr(obj, k)) for k in ("subtotal", "tax", "total", "paid", "balance")}


class ExtraLineSerializer(serializers.Serializer):
    description = serializers.CharField(max_length=255, required=False, allow_blank=True)
    procedure = serializers.IntegerField(required=False, allow_null=True)
    quantity = serializers.IntegerField(min_value=1, default=1)
    unit_price = serializers.DecimalField(max_digits=10, decimal_places=2, min_value=0)
    discount = serializers.DecimalField(max_digits=10, decimal_places=2, min_value=0, default=ZERO)
    dentist = serializers.IntegerField(required=False, allow_null=True)


class InvoiceCreateSerializer(serializers.Serializer):
    """An invoice from chosen treatment plan lines plus any extra items."""

    patient = serializers.IntegerField()
    plan_lines = serializers.ListField(child=serializers.IntegerField(), required=False, default=list)
    extra_lines = ExtraLineSerializer(many=True, required=False, default=list)
    branch = serializers.IntegerField(required=False, allow_null=True)
    discount = serializers.DecimalField(max_digits=12, decimal_places=2, min_value=0, default=ZERO)
    notes = serializers.CharField(required=False, allow_blank=True, default="")

    def validate(self, attrs):
        clinic = self.context["clinic"]
        from erp.patients.models import Patient  # noqa: PLC0415

        patient = Patient.objects.filter(clinic=clinic, pk=attrs["patient"]).first()
        if patient is None:
            raise serializers.ValidationError({"patient": "Patient not found."})
        attrs["patient"] = patient
        ids = list(dict.fromkeys(attrs["plan_lines"]))
        lines = list(
            TreatmentPlanLine.objects.filter(clinic=clinic, pk__in=ids, plan__patient=patient)
            .select_related("procedure", "plan__dentist")
        )
        if len(lines) != len(ids):
            raise serializers.ValidationError({"plan_lines": "A plan line is missing or belongs to another patient."})
        if any(line.status == "cancelled" for line in lines):
            raise serializers.ValidationError({"plan_lines": "A cancelled procedure cannot be invoiced."})
        if invoiced_line_ids(clinic) & set(ids):
            raise serializers.ValidationError({"plan_lines": "A procedure is already on another invoice."})
        attrs["plan_lines"] = lines
        for extra in attrs["extra_lines"]:
            proc = extra.get("procedure")
            if proc:
                extra["procedure"] = Procedure.objects.filter(clinic=clinic, pk=proc).first()
                if extra["procedure"] is None:
                    raise serializers.ValidationError({"extra_lines": "Unknown procedure."})
                extra.setdefault("description", "")
                extra["description"] = extra["description"] or extra["procedure"].name_en
            if not extra.get("description"):
                raise serializers.ValidationError({"extra_lines": "Each extra item needs a description."})
            if extra["discount"] > extra["unit_price"] * extra["quantity"]:
                raise serializers.ValidationError({"extra_lines": "A discount is more than the item's price."})
            dentist = extra.get("dentist")
            if dentist:
                from erp.masterdata.models import StaffMember  # noqa: PLC0415

                extra["dentist"] = StaffMember.objects.filter(clinic=clinic, pk=dentist, staff_type="dentist").first()
        if not lines and not attrs["extra_lines"]:
            raise serializers.ValidationError("Choose at least one procedure or add an item.")
        subtotal = sum((line.net for line in lines), ZERO) + sum(
            (e["unit_price"] * e["quantity"] - e["discount"] for e in attrs["extra_lines"]), ZERO
        )
        if attrs["discount"] > subtotal:
            raise serializers.ValidationError({"discount": "The discount is more than the invoice."})
        branch = attrs.get("branch")
        if branch:
            attrs["branch"] = Branch.objects.filter(clinic=clinic, pk=branch).first()
        else:
            attrs["branch"] = patient.home_branch or Branch.objects.filter(clinic=clinic, is_active=True).first()
        return attrs


class PaymentSerializer(ClinicScopedSerializer):
    patient_info = serializers.SerializerMethodField()
    invoice_number = serializers.CharField(source="invoice.number", read_only=True, default="")
    received_by = serializers.SerializerMethodField()
    installment_number = serializers.IntegerField(source="installment.number", read_only=True, default=None)

    class Meta:
        model = Payment
        fields = [
            "id", "receipt_number", "patient", "patient_info", "invoice", "invoice_number", "installment", "installment_number",
            "branch", "paid_on", "amount", "method", "reference", "notes", "voided_at", "void_reason", "received_by", "created_at",
        ]
        read_only_fields = ["id", "receipt_number", "voided_at", "void_reason", "created_at"]
        extra_kwargs = {"amount": {"min_value": Decimal("0.01")}}

    def get_patient_info(self, obj):
        return patient_info(obj.patient)

    def get_received_by(self, obj):
        user = obj.created_by
        return (user.get_full_name() or user.username) if user else ""

    def validate(self, attrs):
        if self.instance is not None:
            raise serializers.ValidationError("A payment cannot be changed. Void it and record it again.")
        invoice = attrs.get("invoice")
        installment = attrs.get("installment")
        patient = attrs["patient"]
        if invoice is not None:
            if invoice.patient_id != patient.pk:
                raise serializers.ValidationError({"invoice": "That invoice is for another patient."})
            if invoice.status == "void":
                raise serializers.ValidationError({"invoice": "That invoice is void."})
            if attrs["amount"] > invoice.balance:
                raise serializers.ValidationError({"amount": f"More than the invoice balance ({money(invoice.balance)})."})
            attrs.setdefault("branch", invoice.branch)
        if installment is not None:
            if invoice is None or installment.invoice_id != invoice.pk:
                raise serializers.ValidationError({"installment": "That installment is on another invoice."})
            if attrs["amount"] > installment.remaining:
                raise serializers.ValidationError({"amount": f"More than this installment ({money(installment.remaining)})."})
        if attrs.get("branch") is None:
            attrs["branch"] = patient.home_branch or Branch.objects.filter(clinic=patient.clinic, is_active=True).first()
        if day_is_closed(patient.clinic, attrs["branch"], attrs.get("paid_on")):
            raise serializers.ValidationError({"paid_on": "The cashbox for that day is closed."})
        return attrs


def day_is_closed(clinic, branch, day):
    from django.utils import timezone  # noqa: PLC0415

    day = day or timezone.localdate()
    return CashboxClosing.objects.filter(clinic=clinic, date=day).filter(Q(branch=branch) | Q(branch__isnull=True)).exists()


class CashboxClosingSerializer(ClinicScopedSerializer):
    difference = serializers.SerializerMethodField()
    closed_by = serializers.SerializerMethodField()

    class Meta:
        model = CashboxClosing
        fields = ["id", "branch", "date", "totals", "payment_count", "expected_cash", "counted_cash", "difference", "notes", "closed_by", "created_at"]
        read_only_fields = ["id", "totals", "payment_count", "expected_cash", "created_at"]

    def get_difference(self, obj):
        return money(obj.difference)

    def get_closed_by(self, obj):
        user = obj.created_by
        return (user.get_full_name() or user.username) if user else ""
