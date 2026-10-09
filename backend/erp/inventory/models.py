"""Phase 5: inventory and purchasing. Suppliers, a stock catalogue, stock kept
per branch in lots (with expiry dates), a movement ledger that is the only way
quantities change, materials used per procedure, purchase orders, and implant
lot tracking back to the patient."""

from decimal import Decimal

from django.db import models, transaction
from django.utils.translation import gettext_lazy as _

from erp.core.models import ClinicScopedModel

ZERO = Decimal("0.00")
QTY = {"max_digits": 12, "decimal_places": 3}


class PurchaseOrderCounter(models.Model):
    """Next purchase order number per clinic (PO-00001)."""

    clinic = models.OneToOneField("core.Clinic", on_delete=models.CASCADE, related_name="+")
    last = models.PositiveIntegerField(default=0)

    @classmethod
    def next(cls, clinic):
        with transaction.atomic():
            counter, _created = cls.objects.select_for_update().get_or_create(clinic=clinic)
            counter.last += 1
            counter.save(update_fields=["last"])
        return f"PO-{counter.last:05d}"


class Supplier(ClinicScopedModel):
    name = models.CharField(_("name"), max_length=200)
    contact_person = models.CharField(_("contact person"), max_length=150, blank=True)
    phone = models.CharField(_("phone"), max_length=30, blank=True)
    whatsapp = models.CharField(_("WhatsApp"), max_length=30, blank=True)
    email = models.EmailField(_("email"), blank=True)
    address = models.CharField(_("address"), max_length=255, blank=True)
    payment_terms = models.CharField(_("payment terms"), max_length=255, blank=True)
    notes = models.TextField(_("notes"), blank=True)
    is_active = models.BooleanField(_("active"), default=True)

    class Meta:
        verbose_name = _("supplier")
        verbose_name_plural = _("suppliers")
        ordering = ["name", "id"]

    def __str__(self):
        return self.name


class StockItem(ClinicScopedModel):
    CATEGORIES = [
        ("consumable", _("Consumable")),
        ("material", _("Dental material")),
        ("implant", _("Implant")),
        ("instrument", _("Instrument")),
        ("medicine", _("Medicine")),
        ("lab_material", _("Lab material")),
        ("office", _("Office supplies")),
        ("other", _("Other")),
    ]
    UNITS = [
        ("piece", _("Piece")),
        ("box", _("Box")),
        ("pack", _("Pack")),
        ("ml", _("Millilitre")),
        ("g", _("Gram")),
        ("cartridge", _("Cartridge")),
        ("syringe", _("Syringe")),
        ("capsule", _("Capsule")),
        ("tube", _("Tube")),
        ("bottle", _("Bottle")),
        ("roll", _("Roll")),
        ("pair", _("Pair")),
        ("disc", _("Disc")),
        ("block", _("Block")),
    ]
    # Categories that track lots unless told otherwise.
    LOT_CATEGORIES = ("implant", "medicine")

    code = models.CharField(_("code (SKU)"), max_length=40, blank=True)
    name_en = models.CharField(_("name (English)"), max_length=200)
    name_ar = models.CharField(_("name (Arabic)"), max_length=200)
    category = models.CharField(_("category"), max_length=20, choices=CATEGORIES, default="consumable")
    unit = models.CharField(_("unit"), max_length=20, choices=UNITS, default="piece")
    units_per_pack = models.PositiveIntegerField(_("units per pack"), default=1)
    preferred_supplier = models.ForeignKey(
        Supplier, null=True, blank=True, on_delete=models.SET_NULL, related_name="preferred_items"
    )
    last_cost = models.DecimalField(_("last cost"), max_digits=12, decimal_places=2, default=0)
    reorder_level = models.DecimalField(_("reorder level"), **QTY, default=0)
    reorder_quantity = models.DecimalField(_("reorder quantity"), **QTY, default=0)
    tracks_lots = models.BooleanField(_("tracks lots and expiry"), default=False)
    is_active = models.BooleanField(_("active"), default=True)
    notes = models.CharField(_("notes"), max_length=255, blank=True)
    # Implants only.
    brand = models.CharField(_("brand"), max_length=100, blank=True)
    system = models.CharField(_("system"), max_length=100, blank=True)
    diameter = models.DecimalField(_("diameter (mm)"), max_digits=4, decimal_places=2, null=True, blank=True)
    length = models.DecimalField(_("length (mm)"), max_digits=4, decimal_places=1, null=True, blank=True)

    class Meta:
        verbose_name = _("stock item")
        verbose_name_plural = _("stock items")
        ordering = ["name_en", "id"]
        constraints = [
            models.UniqueConstraint(
                fields=["clinic", "code"], condition=~models.Q(code=""), name="unique_stock_item_code"
            )
        ]

    def __str__(self):
        return f"{self.code} {self.name_en}".strip()


class StockLot(ClinicScopedModel):
    """Stock of one item at one branch. Items without lot tracking keep a single
    lot with a blank number per branch, so every quantity lives in a lot."""

    item = models.ForeignKey(StockItem, on_delete=models.PROTECT, related_name="lots")
    branch = models.ForeignKey("masterdata.Branch", on_delete=models.PROTECT, related_name="stock_lots")
    lot_number = models.CharField(_("lot number"), max_length=60, blank=True)
    expiry_date = models.DateField(_("expiry date"), null=True, blank=True)
    # Changed only by StockMovement through erp.inventory.services.
    quantity = models.DecimalField(_("quantity on hand"), **QTY, default=0, editable=False)
    unit_cost = models.DecimalField(_("unit cost"), max_digits=12, decimal_places=2, default=0)
    received_at = models.DateTimeField(_("received at"), null=True, blank=True)
    supplier = models.ForeignKey(Supplier, null=True, blank=True, on_delete=models.SET_NULL, related_name="lots")
    purchase_order_line = models.ForeignKey(
        "PurchaseOrderLine", null=True, blank=True, on_delete=models.SET_NULL, related_name="lots"
    )

    class Meta:
        verbose_name = _("stock lot")
        verbose_name_plural = _("stock lots")
        ordering = ["item_id", "branch_id", models.F("expiry_date").asc(nulls_last=True), "id"]
        constraints = [
            models.UniqueConstraint(fields=["item", "branch", "lot_number"], name="unique_lot_per_item_branch")
        ]

    def __str__(self):
        return f"{self.item} {self.lot_number or '-'} @ {self.branch}"


class StockMovement(ClinicScopedModel):
    KINDS = [
        ("receive", _("Received")),
        ("use", _("Used")),
        ("adjust", _("Stock count adjustment")),
        ("transfer_out", _("Transferred out")),
        ("transfer_in", _("Transferred in")),
        ("return_to_supplier", _("Returned to supplier")),
        ("waste", _("Expired or wasted")),
    ]
    # Kinds whose quantity is always negative.
    OUTGOING = ("use", "transfer_out", "return_to_supplier", "waste")

    item = models.ForeignKey(StockItem, on_delete=models.PROTECT, related_name="movements")
    lot = models.ForeignKey(StockLot, on_delete=models.PROTECT, related_name="movements")
    branch = models.ForeignKey("masterdata.Branch", on_delete=models.PROTECT, related_name="stock_movements")
    kind = models.CharField(_("kind"), max_length=20, choices=KINDS)
    quantity = models.DecimalField(_("quantity"), **QTY, help_text=_("Positive in, negative out."))
    balance_after = models.DecimalField(_("lot balance after"), **QTY, default=0)
    unit_cost = models.DecimalField(_("unit cost"), max_digits=12, decimal_places=2, default=0)
    note = models.CharField(_("reason or note"), max_length=255, blank=True)
    other_branch = models.ForeignKey(
        "masterdata.Branch", null=True, blank=True, on_delete=models.PROTECT, related_name="+"
    )
    plan_line = models.ForeignKey(
        "clinical.TreatmentPlanLine", null=True, blank=True, on_delete=models.PROTECT, related_name="stock_movements"
    )
    appointment = models.ForeignKey(
        "appointments.Appointment", null=True, blank=True, on_delete=models.SET_NULL, related_name="stock_movements"
    )
    lab_case = models.ForeignKey(
        "lab.LabCase", null=True, blank=True, on_delete=models.PROTECT, related_name="stock_movements"
    )
    purchase_order_line = models.ForeignKey(
        "PurchaseOrderLine", null=True, blank=True, on_delete=models.PROTECT, related_name="movements"
    )
    patient = models.ForeignKey(
        "patients.Patient", null=True, blank=True, on_delete=models.PROTECT, related_name="stock_movements"
    )

    class Meta:
        verbose_name = _("stock movement")
        verbose_name_plural = _("stock movements")
        ordering = ["-created_at", "-id"]

    def __str__(self):
        return f"{self.get_kind_display()} {self.quantity} {self.item}"

    @property
    def value(self):
        return (abs(self.quantity) * self.unit_cost).quantize(Decimal("0.01"))


class ProcedureMaterial(ClinicScopedModel):
    """What one procedure uses from stock."""

    procedure = models.ForeignKey("masterdata.Procedure", on_delete=models.CASCADE, related_name="materials")
    item = models.ForeignKey(StockItem, on_delete=models.PROTECT, related_name="procedure_uses")
    quantity = models.DecimalField(_("quantity per procedure"), **QTY, default=1)

    class Meta:
        verbose_name = _("procedure material")
        verbose_name_plural = _("procedure materials")
        ordering = ["procedure_id", "id"]
        constraints = [models.UniqueConstraint(fields=["procedure", "item"], name="unique_material_per_procedure")]

    def __str__(self):
        return f"{self.procedure}: {self.quantity} {self.item}"


class PurchaseOrder(ClinicScopedModel):
    STATUSES = [
        ("draft", _("Draft")),
        ("ordered", _("Ordered")),
        ("partially_received", _("Partially received")),
        ("received", _("Received")),
        ("cancelled", _("Cancelled")),
    ]
    OPEN_STATUSES = ("ordered", "partially_received")

    number = models.CharField(_("number"), max_length=20, editable=False)
    supplier = models.ForeignKey(Supplier, on_delete=models.PROTECT, related_name="purchase_orders")
    branch = models.ForeignKey("masterdata.Branch", on_delete=models.PROTECT, related_name="purchase_orders")
    status = models.CharField(_("status"), max_length=20, choices=STATUSES, default="draft")
    expected_date = models.DateField(_("expected date"), null=True, blank=True)
    notes = models.TextField(_("notes"), blank=True)
    ordered_at = models.DateTimeField(null=True, blank=True)
    received_at = models.DateTimeField(null=True, blank=True)
    cancelled_at = models.DateTimeField(null=True, blank=True)
    cancel_reason = models.CharField(_("cancellation reason"), max_length=255, blank=True)

    class Meta:
        verbose_name = _("purchase order")
        verbose_name_plural = _("purchase orders")
        ordering = ["-created_at", "-id"]
        constraints = [models.UniqueConstraint(fields=["clinic", "number"], name="unique_po_number")]

    def __str__(self):
        return self.number

    def save(self, *args, **kwargs):
        if not self.number:
            self.number = PurchaseOrderCounter.next(self.clinic)
        super().save(*args, **kwargs)

    @property
    def total(self):
        return sum((line.total for line in self.lines.all()), ZERO)

    @property
    def received_value(self):
        return sum(((line.quantity_received * line.unit_cost) for line in self.lines.all()), ZERO).quantize(
            Decimal("0.01")
        )


class PurchaseOrderLine(models.Model):
    order = models.ForeignKey(PurchaseOrder, on_delete=models.CASCADE, related_name="lines")
    item = models.ForeignKey(StockItem, on_delete=models.PROTECT, related_name="order_lines")
    quantity_ordered = models.DecimalField(_("quantity ordered"), **QTY)
    unit_cost = models.DecimalField(_("unit cost"), max_digits=12, decimal_places=2, default=0)
    quantity_received = models.DecimalField(_("quantity received"), **QTY, default=0)

    class Meta:
        verbose_name = _("purchase order line")
        verbose_name_plural = _("purchase order lines")
        ordering = ["id"]

    def __str__(self):
        return f"{self.order}: {self.quantity_ordered} {self.item}"

    @property
    def remaining(self):
        return max(self.quantity_ordered - self.quantity_received, Decimal("0"))

    @property
    def total(self):
        return (self.quantity_ordered * self.unit_cost).quantize(Decimal("0.01"))
