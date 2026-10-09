"""Phase 3: invoices built from treatment plan lines, payments, installments,
the daily cashbox closing, and what each dentist's commission rule earns."""

from decimal import Decimal

from django.db import models, transaction
from django.utils import timezone
from django.utils.translation import gettext_lazy as _

from erp.core.models import ClinicScopedModel

ZERO = Decimal("0.00")
CENT = Decimal("0.01")


class DocumentCounter(models.Model):
    """Next number per clinic for invoices and receipts (INV-00001, RC-00001)."""

    clinic = models.ForeignKey("core.Clinic", on_delete=models.CASCADE, related_name="+")
    kind = models.CharField(max_length=20)
    last = models.PositiveIntegerField(default=0)

    class Meta:
        constraints = [models.UniqueConstraint(fields=["clinic", "kind"], name="unique_counter_per_clinic")]

    @classmethod
    def next(cls, clinic, kind, prefix):
        with transaction.atomic():
            counter, _created = cls.objects.select_for_update().get_or_create(clinic=clinic, kind=kind)
            counter.last += 1
            counter.save(update_fields=["last"])
        return f"{prefix}-{counter.last:05d}"


class Invoice(ClinicScopedModel):
    STATUSES = [("issued", _("Issued")), ("void", _("Void"))]

    number = models.CharField(_("number"), max_length=20, editable=False)
    patient = models.ForeignKey("patients.Patient", on_delete=models.PROTECT, related_name="invoices")
    branch = models.ForeignKey("masterdata.Branch", null=True, blank=True, on_delete=models.PROTECT, related_name="invoices")
    issue_date = models.DateField(_("date"), default=timezone.localdate)
    status = models.CharField(_("status"), max_length=10, choices=STATUSES, default="issued")
    discount = models.DecimalField(_("invoice discount"), max_digits=12, decimal_places=2, default=0)
    tax_rate = models.DecimalField(_("tax rate %"), max_digits=5, decimal_places=2, default=0)
    notes = models.TextField(_("notes"), blank=True)
    void_reason = models.CharField(_("void reason"), max_length=255, blank=True)
    voided_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        verbose_name = _("invoice")
        verbose_name_plural = _("invoices")
        ordering = ["-issue_date", "-id"]
        constraints = [models.UniqueConstraint(fields=["clinic", "number"], name="unique_invoice_number")]

    def __str__(self):
        return self.number

    def save(self, *args, **kwargs):
        if not self.number:
            self.number = DocumentCounter.next(self.clinic, "invoice", "INV")
        super().save(*args, **kwargs)

    # Totals are worked out from the lines and payments so they never drift.
    @property
    def subtotal(self):
        return sum((line.total for line in self.lines.all()), ZERO)

    @property
    def tax(self):
        return ((self.subtotal - self.discount) * self.tax_rate / 100).quantize(CENT)

    @property
    def total(self):
        return self.subtotal - self.discount + self.tax

    @property
    def paid(self):
        return sum((p.amount for p in self.payments.all() if not p.voided_at), ZERO)

    @property
    def balance(self):
        return ZERO if self.status == "void" else self.total - self.paid

    @property
    def payment_status(self):
        if self.status == "void":
            return "void"
        if self.paid <= 0:
            return "unpaid"
        return "paid" if self.balance <= 0 else "partly_paid"


class InvoiceLine(models.Model):
    invoice = models.ForeignKey(Invoice, on_delete=models.CASCADE, related_name="lines")
    plan_line = models.ForeignKey(
        "clinical.TreatmentPlanLine", null=True, blank=True, on_delete=models.PROTECT, related_name="invoice_lines"
    )
    procedure = models.ForeignKey("masterdata.Procedure", null=True, blank=True, on_delete=models.PROTECT, related_name="+")
    dentist = models.ForeignKey("masterdata.StaffMember", null=True, blank=True, on_delete=models.PROTECT, related_name="invoice_lines")
    description = models.CharField(_("description"), max_length=255)
    tooth = models.PositiveSmallIntegerField(_("tooth"), null=True, blank=True)
    quantity = models.PositiveSmallIntegerField(_("quantity"), default=1)
    unit_price = models.DecimalField(_("unit price"), max_digits=10, decimal_places=2)
    discount = models.DecimalField(_("discount"), max_digits=10, decimal_places=2, default=0)

    class Meta:
        ordering = ["id"]

    @property
    def total(self):
        return self.unit_price * self.quantity - self.discount


class Installment(models.Model):
    invoice = models.ForeignKey(Invoice, on_delete=models.CASCADE, related_name="installments")
    number = models.PositiveSmallIntegerField(_("number"))
    due_date = models.DateField(_("due date"))
    amount = models.DecimalField(_("amount"), max_digits=12, decimal_places=2)

    class Meta:
        ordering = ["due_date", "number"]

    @property
    def paid(self):
        return sum((p.amount for p in self.payments.all() if not p.voided_at), ZERO)

    @property
    def remaining(self):
        return max(self.amount - self.paid, ZERO)

    @property
    def status(self):
        if self.remaining <= 0:
            return "paid"
        if self.due_date < timezone.localdate():
            return "overdue"
        return "partly_paid" if self.paid > 0 else "due"


class Payment(ClinicScopedModel):
    METHODS = [
        ("cash", _("Cash")),
        ("instapay", _("InstaPay")),
        ("card", _("Card")),
        ("wallet", _("Mobile wallet")),
        ("bank", _("Bank transfer")),
    ]

    receipt_number = models.CharField(_("receipt number"), max_length=20, editable=False)
    patient = models.ForeignKey("patients.Patient", on_delete=models.PROTECT, related_name="payments")
    invoice = models.ForeignKey(Invoice, null=True, blank=True, on_delete=models.PROTECT, related_name="payments")
    installment = models.ForeignKey(Installment, null=True, blank=True, on_delete=models.SET_NULL, related_name="payments")
    branch = models.ForeignKey("masterdata.Branch", null=True, blank=True, on_delete=models.PROTECT, related_name="payments")
    paid_on = models.DateField(_("date"), default=timezone.localdate)
    amount = models.DecimalField(_("amount"), max_digits=12, decimal_places=2)
    method = models.CharField(_("method"), max_length=10, choices=METHODS, default="cash")
    reference = models.CharField(_("reference"), max_length=100, blank=True)
    notes = models.CharField(_("notes"), max_length=255, blank=True)
    voided_at = models.DateTimeField(null=True, blank=True)
    void_reason = models.CharField(_("void reason"), max_length=255, blank=True)

    class Meta:
        verbose_name = _("payment")
        verbose_name_plural = _("payments")
        ordering = ["-paid_on", "-id"]
        constraints = [models.UniqueConstraint(fields=["clinic", "receipt_number"], name="unique_receipt_number")]

    def __str__(self):
        return self.receipt_number

    def save(self, *args, **kwargs):
        if not self.receipt_number:
            self.receipt_number = DocumentCounter.next(self.clinic, "receipt", "RC")
        super().save(*args, **kwargs)


class CashboxClosing(ClinicScopedModel):
    """End-of-day count for one branch. Payments of a closed day are locked."""

    branch = models.ForeignKey("masterdata.Branch", null=True, blank=True, on_delete=models.PROTECT, related_name="closings")
    date = models.DateField(_("date"))
    totals = models.JSONField(_("totals by method"), default=dict)
    payment_count = models.PositiveIntegerField(default=0)
    expected_cash = models.DecimalField(_("expected cash"), max_digits=12, decimal_places=2)
    counted_cash = models.DecimalField(_("counted cash"), max_digits=12, decimal_places=2)
    notes = models.TextField(_("notes"), blank=True)

    class Meta:
        verbose_name = _("cashbox closing")
        verbose_name_plural = _("cashbox closings")
        ordering = ["-date", "-id"]
        constraints = [
            models.UniqueConstraint(fields=["clinic", "branch", "date"], name="one_closing_per_branch_day", nulls_distinct=False)
        ]

    @property
    def difference(self):
        return self.counted_cash - self.expected_cash
