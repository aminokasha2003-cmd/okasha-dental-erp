from datetime import date, timedelta
from decimal import ROUND_DOWN, Decimal

from django.db import transaction
from django.db.models import Prefetch, Q
from django.utils import timezone
from rest_framework import serializers
from rest_framework.decorators import action
from rest_framework.exceptions import ValidationError
from rest_framework.response import Response
from rest_framework.views import APIView

from erp.core.api import ClinicScopedViewSet, ModulePermission, require_clinic
from erp.masterdata.models import Branch, StaffMember

from .models import ZERO, CashboxClosing, Installment, Invoice, InvoiceLine, Payment
from .serializers import (
    CashboxClosingSerializer,
    InstallmentSerializer,
    InvoiceCreateSerializer,
    InvoiceSerializer,
    PaymentSerializer,
    day_is_closed,
    invoiced_line_ids,
    money,
)

ACTIVE_PAYMENTS = Prefetch("payments", queryset=Payment.objects.filter(voided_at__isnull=True))


def parse_day(value, default=None):
    try:
        return date.fromisoformat(value) if value else default
    except ValueError as exc:
        raise ValidationError({"date": "Use a date like 2026-10-09."}) from exc


def add_months(day, months):
    month = day.month - 1 + months
    year = day.year + month // 12
    month = month % 12 + 1
    for d in (day.day, 30, 29, 28):
        try:
            return day.replace(year=year, month=month, day=d)
        except ValueError:
            continue
    return day


class InvoiceViewSet(ClinicScopedViewSet):
    queryset = Invoice.objects.select_related("patient", "branch").prefetch_related(
        "lines__dentist", "payments", Prefetch("installments", queryset=Installment.objects.prefetch_related("payments"))
    )
    serializer_class = InvoiceSerializer
    module = "billing"
    http_method_names = ["get", "post", "patch", "head", "options"]
    required_actions = {"void": "delete", "set_installments": "edit", "billable": "view"}

    def get_queryset(self):
        qs = super().get_queryset()
        p = self.request.query_params
        if p.get("patient"):
            qs = qs.filter(patient=p["patient"])
        if p.get("search"):
            term = p["search"].strip()
            qs = qs.filter(Q(number__icontains=term) | Q(patient__search_text__icontains=term.lower()) | Q(patient__file_number__iexact=term))
        if p.get("open"):
            qs = qs.filter(status="issued")
        return qs

    def get_serializer_class(self):
        return InvoiceCreateSerializer if self.action == "create" else InvoiceSerializer

    def create(self, request, *args, **kwargs):
        clinic = require_clinic(request.user)
        data = InvoiceCreateSerializer(data=request.data, context={"clinic": clinic})
        data.is_valid(raise_exception=True)
        v = data.validated_data
        with transaction.atomic():
            invoice = Invoice.objects.create(
                clinic=clinic, patient=v["patient"], branch=v["branch"], discount=v["discount"], notes=v["notes"], tax_rate=clinic.tax_rate
            )
            for line in v["plan_lines"]:
                InvoiceLine.objects.create(
                    invoice=invoice,
                    plan_line=line,
                    procedure=line.procedure,
                    dentist=line.plan.dentist,
                    description=line.procedure.name_en if v["patient"].language == "en" else (line.procedure.name_ar or line.procedure.name_en),
                    tooth=line.tooth,
                    unit_price=line.price,
                    discount=line.discount,
                )
            for extra in v["extra_lines"]:
                InvoiceLine.objects.create(
                    invoice=invoice,
                    procedure=extra.get("procedure"),
                    dentist=extra.get("dentist"),
                    description=extra["description"],
                    quantity=extra["quantity"],
                    unit_price=extra["unit_price"],
                    discount=extra["discount"],
                )
        invoice = self.get_queryset().get(pk=invoice.pk)
        return Response(InvoiceSerializer(invoice, context=self.get_serializer_context()).data, status=201)

    def perform_update(self, serializer):
        # Only the notes can change after issue; money changes go through a new invoice.
        allowed = {"notes"}
        if set(serializer.validated_data) - allowed:
            raise ValidationError("Only the notes can change on an issued invoice. Void it and issue a new one.")
        serializer.save()

    @action(detail=True, methods=["post"])
    def void(self, request, pk=None):
        invoice = self.get_object()
        if invoice.status == "void":
            raise ValidationError("This invoice is already void.")
        if invoice.paid > 0:
            raise ValidationError("Void its payments first, or refund them.")
        reason = str(request.data.get("reason", "")).strip()
        if not reason:
            raise ValidationError({"reason": "Give a reason."})
        invoice.status = "void"
        invoice.void_reason = reason[:255]
        invoice.voided_at = timezone.now()
        invoice.save()
        return Response(self.get_serializer(self.get_queryset().get(pk=invoice.pk)).data)

    @action(detail=True, methods=["post"], url_path="installments")
    def set_installments(self, request, pk=None):
        """Split what is still owed into monthly installments (replaces unpaid ones)."""
        invoice = self.get_object()
        if invoice.status == "void":
            raise ValidationError("This invoice is void.")
        try:
            count = int(request.data.get("count", 0))
            every = int(request.data.get("every_months", 1))
        except (TypeError, ValueError) as exc:
            raise ValidationError({"count": "Give a number of installments."}) from exc
        if not 1 <= count <= 36 or not 1 <= every <= 12:
            raise ValidationError({"count": "Between 1 and 36 installments, 1 to 12 months apart."})
        first = parse_day(request.data.get("first_due"), timezone.localdate())
        with transaction.atomic():
            kept = [i for i in invoice.installments.all() if i.paid > 0]
            for inst in invoice.installments.all():
                if inst.paid == 0:
                    inst.delete()
            # A partly paid installment keeps only what was paid on it.
            for inst in kept:
                inst.amount = inst.paid
                inst.save(update_fields=["amount"])
            remaining = invoice.balance
            if remaining <= 0:
                raise ValidationError("Nothing is left to pay on this invoice.")
            share = (remaining / count).quantize(Decimal("1"), rounding=ROUND_DOWN) or (remaining / count).quantize(Decimal("0.01"))
            start = len(kept)
            for i in range(count):
                amount = share if i < count - 1 else remaining - share * (count - 1)
                Installment.objects.create(invoice=invoice, number=start + i + 1, due_date=add_months(first, i * every), amount=amount)
        return Response(self.get_serializer(self.get_queryset().get(pk=invoice.pk)).data)

    @action(detail=False, methods=["get"])
    def billable(self, request):
        """A patient's treatment plan lines not yet on an invoice."""
        from erp.clinical.models import TreatmentPlanLine  # noqa: PLC0415

        clinic = require_clinic(request.user)
        patient = request.query_params.get("patient")
        if not patient:
            raise ValidationError({"patient": "Choose a patient."})
        taken = invoiced_line_ids(clinic)
        lines = (
            TreatmentPlanLine.objects.filter(clinic=clinic, plan__patient=patient)
            .exclude(status="cancelled")
            .exclude(plan__status="cancelled")
            .exclude(pk__in=taken)
            .select_related("procedure", "plan__dentist")
        )
        return Response([
            {
                "id": line.pk,
                "plan_title": line.plan.title,
                "procedure_name_en": line.procedure.name_en,
                "procedure_name_ar": line.procedure.name_ar,
                "tooth": line.tooth,
                "surfaces": line.surfaces,
                "status": line.status,
                "net": money(line.net),
                "dentist": {"ar": line.plan.dentist.name_ar, "en": line.plan.dentist.name_en},
            }
            for line in lines
        ])


class PaymentViewSet(ClinicScopedViewSet):
    queryset = Payment.objects.select_related("patient", "invoice", "installment", "created_by")
    serializer_class = PaymentSerializer
    module = "billing"
    http_method_names = ["get", "post", "head", "options"]
    required_actions = {"void": "delete"}

    def get_queryset(self):
        qs = super().get_queryset()
        p = self.request.query_params
        if p.get("patient"):
            qs = qs.filter(patient=p["patient"])
        if p.get("invoice"):
            qs = qs.filter(invoice=p["invoice"])
        if p.get("date"):
            qs = qs.filter(paid_on=parse_day(p["date"]))
        if p.get("branch"):
            qs = qs.filter(branch=p["branch"])
        return qs

    @action(detail=True, methods=["post"])
    def void(self, request, pk=None):
        payment = self.get_object()
        if payment.voided_at:
            raise ValidationError("This payment is already void.")
        if day_is_closed(payment.clinic, payment.branch, payment.paid_on):
            raise ValidationError("The cashbox for that day is closed.")
        reason = str(request.data.get("reason", "")).strip()
        if not reason:
            raise ValidationError({"reason": "Give a reason."})
        payment.voided_at = timezone.now()
        payment.void_reason = reason[:255]
        payment.save()
        return Response(self.get_serializer(payment).data)


class InstallmentViewSet(ClinicScopedViewSet):
    """Installments due across the clinic (read only; schedules are set on the invoice)."""

    queryset = Installment.objects.select_related("invoice__patient").prefetch_related("payments")
    serializer_class = InstallmentSerializer
    module = "billing"
    http_method_names = ["get", "head", "options"]
    pagination_class = None

    def list(self, request, *args, **kwargs):
        qs = Installment.objects.filter(invoice__clinic=require_clinic(request.user), invoice__status="issued")
        qs = qs.select_related("invoice__patient").prefetch_related("payments")
        until = parse_day(request.query_params.get("until"), timezone.localdate() + timedelta(days=14))
        rows = [i for i in qs.filter(due_date__lte=until) if i.remaining > 0]
        return Response(self.get_serializer(rows, many=True).data)


def cashbox_summary(clinic, day, branch):
    payments = Payment.objects.filter(clinic=clinic, paid_on=day, voided_at__isnull=True)
    if branch is not None:
        payments = payments.filter(branch=branch)
    totals = {}
    for p in payments:
        totals[p.method] = totals.get(p.method, ZERO) + p.amount
    return payments, {k: money(v) for k, v in totals.items()}, totals.get("cash", ZERO)


class DailyTakingsView(APIView):
    """Money taken per day for the last N days (the home page's week chart)."""

    permission_classes = [ModulePermission]
    module = "billing"

    def get(self, request):
        clinic = require_clinic(request.user)
        try:
            days = min(max(int(request.query_params.get("days", 7)), 1), 62)
        except ValueError as exc:
            raise ValidationError({"days": "Give a number of days."}) from exc
        today = timezone.localdate()
        first = today - timedelta(days=days - 1)
        totals = {first + timedelta(days=i): ZERO for i in range(days)}
        for paid_on, amount in Payment.objects.filter(
            clinic=clinic, voided_at__isnull=True, paid_on__gte=first, paid_on__lte=today
        ).values_list("paid_on", "amount"):
            totals[paid_on] += amount
        return Response([{"date": day, "total": money(total)} for day, total in totals.items()])


class CashboxView(APIView):
    """The day's takings for one branch, and closing the day."""

    permission_classes = [ModulePermission]
    module = "billing"

    def get(self, request):
        clinic = require_clinic(request.user)
        day = parse_day(request.query_params.get("date"), timezone.localdate())
        branch = Branch.objects.filter(clinic=clinic, pk=request.query_params.get("branch")).first() if request.query_params.get("branch") else None
        payments, totals, cash = cashbox_summary(clinic, day, branch)
        closing = CashboxClosing.objects.filter(clinic=clinic, date=day, branch=branch).first()
        voided = Payment.objects.filter(clinic=clinic, paid_on=day, voided_at__isnull=False)
        if branch is not None:
            voided = voided.filter(branch=branch)
        ctx = {"request": request}
        return Response({
            "date": day.isoformat(),
            "branch": branch.pk if branch else None,
            "totals": totals,
            "total": money(sum((p.amount for p in payments), ZERO)),
            "expected_cash": money(cash),
            "payments": PaymentSerializer(payments.select_related("patient", "invoice", "installment", "created_by"), many=True, context=ctx).data,
            "voided": PaymentSerializer(voided.select_related("patient", "invoice", "installment", "created_by"), many=True, context=ctx).data,
            "closing": CashboxClosingSerializer(closing, context=ctx).data if closing else None,
        })

    def post(self, request):
        clinic = require_clinic(request.user)
        day = parse_day(request.data.get("date"), timezone.localdate())
        if day > timezone.localdate():
            raise ValidationError({"date": "A day can only be closed once it has started."})
        branch = Branch.objects.filter(clinic=clinic, pk=request.data.get("branch")).first() if request.data.get("branch") else None
        try:
            counted = Decimal(str(request.data.get("counted_cash", "")))
        except Exception as exc:  # noqa: BLE001
            raise ValidationError({"counted_cash": "Enter the cash counted in the drawer."}) from exc
        if counted < 0:
            raise ValidationError({"counted_cash": "Enter the cash counted in the drawer."})
        if CashboxClosing.objects.filter(clinic=clinic, date=day, branch=branch).exists():
            raise ValidationError("This day is already closed.")
        payments, totals, cash = cashbox_summary(clinic, day, branch)
        closing = CashboxClosing.objects.create(
            clinic=clinic, branch=branch, date=day, totals=totals, payment_count=payments.count(), expected_cash=cash,
            counted_cash=counted, notes=str(request.data.get("notes", ""))[:2000], created_by=request.user,
        )
        return Response(CashboxClosingSerializer(closing, context={"request": request}).data, status=201)


class ClosingViewSet(ClinicScopedViewSet):
    queryset = CashboxClosing.objects.select_related("created_by")
    serializer_class = CashboxClosingSerializer
    module = "billing"
    http_method_names = ["get", "head", "options"]


class CommissionReportView(APIView):
    """What each dentist's commission rule earns over a period.

    Billed = invoice lines on invoices issued in the period. Collected = payments
    in the period, shared across each invoice's lines by their value.
    """

    permission_classes = [ModulePermission]
    module = "billing"

    def get(self, request):
        clinic = require_clinic(request.user)
        today = timezone.localdate()
        start = parse_day(request.query_params.get("start"), today.replace(day=1))
        end = parse_day(request.query_params.get("end"), today)
        rows = {}

        def row(dentist):
            if dentist.pk not in rows:
                rows[dentist.pk] = {"dentist": dentist, "billed": ZERO, "collected": ZERO, "procedures": 0}
            return rows[dentist.pk]

        lines = InvoiceLine.objects.filter(
            invoice__clinic=clinic, invoice__status="issued", invoice__issue_date__range=(start, end), dentist__isnull=False
        ).select_related("dentist")
        for line in lines:
            r = row(line.dentist)
            r["billed"] += line.total
            r["procedures"] += line.quantity

        payments = Payment.objects.filter(
            clinic=clinic, voided_at__isnull=True, paid_on__range=(start, end), invoice__isnull=False, invoice__status="issued"
        ).prefetch_related("invoice__lines__dentist")
        for payment in payments:
            inv_lines = list(payment.invoice.lines.all())
            gross = sum((ln.total for ln in inv_lines), ZERO)
            if gross <= 0:
                continue
            for ln in inv_lines:
                if ln.dentist is not None:
                    row(ln.dentist)["collected"] += payment.amount * ln.total / gross

        for member in StaffMember.objects.filter(clinic=clinic, staff_type="dentist", is_active=True):
            row(member)

        out = []
        for r in rows.values():
            d = r["dentist"]
            value = d.commission_value
            commission = {
                "percent_collected": r["collected"] * value / 100,
                "percent_billed": r["billed"] * value / 100,
                "fixed_per_procedure": value * r["procedures"],
            }.get(d.commission_type, ZERO)
            out.append({
                "dentist": d.pk,
                "name": {"ar": d.name_ar, "en": d.name_en},
                "rule": d.commission_type,
                "value": money(value),
                "billed": money(r["billed"]),
                "collected": money(r["collected"].quantize(Decimal("0.01"))),
                "procedures": r["procedures"],
                "commission": money(Decimal(commission).quantize(Decimal("0.01"))),
            })
        out.sort(key=lambda x: x["name"]["en"])
        return Response({"start": start.isoformat(), "end": end.isoformat(), "rows": out})


class PatientAccountView(APIView):
    """Billed, paid and owed for one patient (the billing card on the patient file)."""

    permission_classes = [ModulePermission]
    module = "billing"

    def get(self, request, patient_id):
        clinic = require_clinic(request.user)
        invoices = Invoice.objects.filter(clinic=clinic, patient=patient_id, status="issued").prefetch_related("lines", ACTIVE_PAYMENTS)
        billed = sum((i.total for i in invoices), ZERO)
        paid_on_invoices = sum((i.paid for i in invoices), ZERO)
        on_account = sum(
            (p.amount for p in Payment.objects.filter(clinic=clinic, patient=patient_id, invoice__isnull=True, voided_at__isnull=True)), ZERO
        )
        return Response({
            "billed": money(billed),
            "paid": money(paid_on_invoices + on_account),
            "balance": money(billed - paid_on_invoices - on_account),
            "on_account": money(on_account),
        })
