"""Phase 8: compliance and integrations.

- Tax Authority e-invoicing: the clinic's ETA settings, item codes per
  procedure, and one ETA document per issued invoice with its status.
- Sterilisation: autoclave cycles with their tests, instrument packs, which
  cycle each pack went through and which patient it was opened for.
- Equipment: the register, preventive maintenance plans, breakdown work orders
  (with parts taken from stock) and licences / certificates that expire.
- Website booking: the public booking page's settings and the requests it
  collects for reception to confirm.
"""

from datetime import timedelta
from decimal import Decimal

from django.conf import settings
from django.db import models
from django.utils import timezone
from django.utils.translation import gettext_lazy as _

from erp.core.models import ClinicScopedModel

ZERO = Decimal("0.00")
MONEY = {"max_digits": 12, "decimal_places": 2}


def for_clinic(cls, clinic):
    obj, _created = cls.objects.get_or_create(clinic=clinic)
    return obj


# ------------------------------------------------------------------ settings


class ComplianceSettings(ClinicScopedModel):
    pack_shelf_days = models.PositiveSmallIntegerField(_("sterile pack shelf life (days)"), default=30)
    bi_every_days = models.PositiveSmallIntegerField(_("biological indicator every (days)"), default=7)
    licence_warn_days = models.PositiveSmallIntegerField(_("warn before licences expire (days)"), default=60)
    maintenance_warn_days = models.PositiveSmallIntegerField(_("warn before maintenance is due (days)"), default=14)

    class Meta:
        constraints = [models.UniqueConstraint(fields=["clinic"], name="one_compliance_settings_per_clinic")]

    for_clinic = classmethod(for_clinic)


# ------------------------------------------------------------ e-invoicing


class EInvoiceSettings(ClinicScopedModel):
    ENVIRONMENTS = [("preprod", _("Pre-production (testing)")), ("prod", _("Production"))]
    MODES = [("simulation", _("Simulation (nothing is sent)")), ("live", _("Live: send to the Tax Authority"))]

    is_registered = models.BooleanField(_("registered for e-invoicing"), default=False)
    mode = models.CharField(_("mode"), max_length=12, choices=MODES, default="simulation")
    environment = models.CharField(_("ETA environment"), max_length=10, choices=ENVIRONMENTS, default="preprod")
    rin = models.CharField(_("tax registration number (RIN)"), max_length=20, blank=True)
    issuer_name = models.CharField(_("registered name"), max_length=200, blank=True)
    activity_code = models.CharField(_("activity code"), max_length=10, default="8623")
    default_tax_rate = models.DecimalField(_("VAT rate %"), max_digits=5, decimal_places=2, default=0)
    exempt_subtype = models.CharField(_("tax sub-type when the rate is 0"), max_length=10, default="V003")
    taxed_subtype = models.CharField(_("tax sub-type when VAT applies"), max_length=10, default="V009")
    person_id_threshold = models.DecimalField(_("national ID needed from (EGP)"), **MONEY, default=Decimal("50000"))
    start_date = models.DateField(_("send invoices issued from"), null=True, blank=True)
    default_item_type = models.CharField(_("default code type"), max_length=4, default="EGS")
    default_item_code = models.CharField(_("default item code"), max_length=100, blank=True)
    # Head office address (branch code "0"); branches can override below.
    governate = models.CharField(_("governorate"), max_length=100, blank=True)
    region_city = models.CharField(_("city / district"), max_length=100, blank=True)
    street = models.CharField(_("street"), max_length=200, blank=True)
    building_number = models.CharField(_("building number"), max_length=20, blank=True)
    postal_code = models.CharField(_("postal code"), max_length=20, blank=True)
    # Credentials for the real API. The secret is stored encrypted and never sent back.
    client_id = models.CharField(_("ETA client ID"), max_length=200, blank=True)
    client_secret_enc = models.TextField(blank=True, editable=False)
    signer_url = models.URLField(_("signing service URL"), blank=True)

    class Meta:
        constraints = [models.UniqueConstraint(fields=["clinic"], name="one_einvoice_settings_per_clinic")]

    for_clinic = classmethod(for_clinic)

    @property
    def has_secret(self):
        return bool(self.client_secret_enc)

    @property
    def live_ready(self):
        """Live sending needs credentials and a signer; otherwise the simulation is used."""
        return self.mode == "live" and bool(self.client_id and self.client_secret_enc and self.signer_url and self.rin)


class EtaBranchAddress(ClinicScopedModel):
    branch = models.OneToOneField("masterdata.Branch", on_delete=models.CASCADE, related_name="eta_address")
    branch_code = models.CharField(_("ETA branch code"), max_length=20, default="0")
    governate = models.CharField(_("governorate"), max_length=100, blank=True)
    region_city = models.CharField(_("city / district"), max_length=100, blank=True)
    street = models.CharField(_("street"), max_length=200, blank=True)
    building_number = models.CharField(_("building number"), max_length=20, blank=True)
    postal_code = models.CharField(_("postal code"), max_length=20, blank=True)


class EtaItemCode(ClinicScopedModel):
    """The code the Tax Authority knows a procedure by (EGS codes are registered by the clinic, GS1 are global)."""

    TYPES = [("EGS", "EGS"), ("GS1", "GS1")]

    procedure = models.OneToOneField("masterdata.Procedure", on_delete=models.CASCADE, related_name="eta_code")
    item_type = models.CharField(_("code type"), max_length=4, choices=TYPES, default="EGS")
    item_code = models.CharField(_("item code"), max_length=100)
    unit_type = models.CharField(_("unit"), max_length=10, default="EA")


class EInvoiceDocument(ClinicScopedModel):
    STATUSES = [
        ("draft", _("Needs fixing")),
        ("ready", _("Ready to send")),
        ("submitted", _("Sent, waiting")),
        ("valid", _("Valid")),
        ("invalid", _("Invalid")),
        ("rejected", _("Rejected")),
        ("cancelled", _("Cancelled")),
    ]
    SENDABLE = ("ready",)
    REBUILDABLE = ("draft", "ready", "invalid", "rejected")

    invoice = models.OneToOneField("billing.Invoice", on_delete=models.PROTECT, related_name="eta_document")
    document_type = models.CharField(max_length=2, default="I")
    status = models.CharField(_("status"), max_length=10, choices=STATUSES, default="draft")
    payload = models.JSONField(default=dict, blank=True)
    errors = models.JSONField(default=list, blank=True)
    receiver_type = models.CharField(max_length=2, default="P")
    total_amount = models.DecimalField(max_digits=16, decimal_places=5, default=0)
    tax_amount = models.DecimalField(max_digits=16, decimal_places=5, default=0)
    uuid = models.CharField(_("ETA UUID"), max_length=64, blank=True, db_index=True)
    long_id = models.CharField(max_length=200, blank=True)
    submission_id = models.CharField(max_length=64, blank=True)
    simulated = models.BooleanField(default=False)
    attempts = models.PositiveSmallIntegerField(default=0)
    prepared_at = models.DateTimeField(null=True, blank=True)
    submitted_at = models.DateTimeField(null=True, blank=True)
    validated_at = models.DateTimeField(null=True, blank=True)
    cancelled_at = models.DateTimeField(null=True, blank=True)
    cancel_reason = models.CharField(max_length=255, blank=True)

    class Meta:
        ordering = ["-invoice__issue_date", "-id"]

    def __str__(self):
        return f"ETA {self.invoice_id} {self.status}"


# ------------------------------------------------------------- equipment


class Equipment(ClinicScopedModel):
    CATEGORIES = [
        ("chair", _("Dental chair")),
        ("autoclave", _("Autoclave")),
        ("compressor", _("Compressor")),
        ("suction", _("Suction unit")),
        ("xray", _("Intraoral X-ray")),
        ("opg", _("Panoramic X-ray (OPG)")),
        ("cbct", _("CBCT")),
        ("scanner", _("Intraoral scanner")),
        ("milling", _("Milling machine")),
        ("printer", _("3D printer")),
        ("furnace", _("Lab furnace")),
        ("ultrasonic", _("Ultrasonic cleaner")),
        ("curing", _("Curing light")),
        ("other", _("Other")),
    ]
    STATUSES = [("in_service", _("In service")), ("out_of_service", _("Out of service")), ("retired", _("Retired"))]

    code = models.CharField(_("asset tag"), max_length=20, blank=True)
    name_en = models.CharField(_("name (English)"), max_length=150)
    name_ar = models.CharField(_("name (Arabic)"), max_length=150)
    category = models.CharField(_("type"), max_length=20, choices=CATEGORIES, default="other")
    branch = models.ForeignKey("masterdata.Branch", null=True, blank=True, on_delete=models.PROTECT, related_name="equipment")
    chair = models.ForeignKey("masterdata.Chair", null=True, blank=True, on_delete=models.SET_NULL, related_name="equipment")
    manufacturer = models.CharField(_("make"), max_length=100, blank=True)
    model_name = models.CharField(_("model"), max_length=100, blank=True)
    serial_number = models.CharField(_("serial number"), max_length=100, blank=True)
    supplier = models.ForeignKey("inventory.Supplier", null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    purchase_date = models.DateField(_("bought on"), null=True, blank=True)
    cost = models.DecimalField(_("cost"), **MONEY, default=0)
    warranty_end = models.DateField(_("warranty until"), null=True, blank=True)
    status = models.CharField(_("status"), max_length=20, choices=STATUSES, default="in_service")
    cycles_before = models.PositiveIntegerField(_("cycles before this system"), default=0)
    notes = models.TextField(_("notes"), blank=True)

    class Meta:
        ordering = ["branch_id", "category", "name_en"]

    def __str__(self):
        return self.name_en

    def save(self, *args, **kwargs):
        if not self.code:
            from erp.billing.models import DocumentCounter  # noqa: PLC0415

            self.code = DocumentCounter.next(self.clinic, "equipment", "EQ")
        super().save(*args, **kwargs)


class MaintenancePlan(ClinicScopedModel):
    """Preventive maintenance: every N days, months and/or autoclave cycles, whichever comes first."""

    KINDS = [
        ("service", _("Service")),
        ("calibration", _("Calibration")),
        ("inspection", _("Safety inspection")),
        ("validation", _("Validation")),
        ("filter", _("Filters and oil")),
        ("other", _("Other")),
    ]

    equipment = models.ForeignKey(Equipment, on_delete=models.CASCADE, related_name="plans")
    title_en = models.CharField(_("task (English)"), max_length=150)
    title_ar = models.CharField(_("task (Arabic)"), max_length=150)
    kind = models.CharField(_("kind"), max_length=20, choices=KINDS, default="service")
    every_months = models.PositiveSmallIntegerField(_("every (months)"), null=True, blank=True)
    every_days = models.PositiveSmallIntegerField(_("every (days)"), null=True, blank=True)
    every_cycles = models.PositiveIntegerField(_("every (cycles)"), null=True, blank=True)
    start_on = models.DateField(_("counting from"), default=timezone.localdate)
    last_done_on = models.DateField(_("last done"), null=True, blank=True)
    last_done_cycles = models.PositiveIntegerField(null=True, blank=True)
    vendor = models.CharField(_("done by"), max_length=150, blank=True)
    is_active = models.BooleanField(_("active"), default=True)

    class Meta:
        ordering = ["equipment_id", "id"]


class WorkOrder(ClinicScopedModel):
    PRIORITIES = [("low", _("Low")), ("normal", _("Normal")), ("high", _("High")), ("urgent", _("Urgent"))]
    STATUSES = [
        ("open", _("Open")),
        ("in_progress", _("In progress")),
        ("waiting_parts", _("Waiting for parts")),
        ("done", _("Done")),
        ("cancelled", _("Cancelled")),
    ]
    OPEN = ("open", "in_progress", "waiting_parts")

    number = models.CharField(_("number"), max_length=20, editable=False)
    equipment = models.ForeignKey(Equipment, on_delete=models.PROTECT, related_name="work_orders")
    kind = models.CharField(_("kind"), max_length=12, choices=[("repair", _("Repair")), ("preventive", _("Preventive"))], default="repair")
    plan = models.ForeignKey(MaintenancePlan, null=True, blank=True, on_delete=models.SET_NULL, related_name="work_orders")
    reported_by = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    reported_at = models.DateTimeField(_("reported at"), default=timezone.now)
    issue = models.TextField(_("problem"))
    priority = models.CharField(_("priority"), max_length=10, choices=PRIORITIES, default="normal")
    status = models.CharField(_("status"), max_length=15, choices=STATUSES, default="open")
    takes_out_of_service = models.BooleanField(_("out of service until fixed"), default=False)
    assigned_to = models.CharField(_("technician or company"), max_length=150, blank=True)
    supplier = models.ForeignKey("inventory.Supplier", null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    labour_cost = models.DecimalField(_("labour / service cost"), **MONEY, default=0)
    completed_at = models.DateTimeField(_("finished at"), null=True, blank=True)
    resolution = models.TextField(_("what was done"), blank=True)

    class Meta:
        ordering = ["-reported_at", "-id"]
        constraints = [models.UniqueConstraint(fields=["clinic", "number"], name="unique_work_order_number")]

    def __str__(self):
        return self.number

    def save(self, *args, **kwargs):
        if not self.number:
            from erp.billing.models import DocumentCounter  # noqa: PLC0415

            self.number = DocumentCounter.next(self.clinic, "work_order", "WO")
        super().save(*args, **kwargs)

    @property
    def downtime_hours(self):
        if not self.takes_out_of_service:
            return 0
        end = self.completed_at or timezone.now()
        return round(max((end - self.reported_at).total_seconds(), 0) / 3600, 1)


class WorkOrderPart(ClinicScopedModel):
    work_order = models.ForeignKey(WorkOrder, on_delete=models.CASCADE, related_name="parts")
    item = models.ForeignKey("inventory.StockItem", on_delete=models.PROTECT, related_name="+")
    branch = models.ForeignKey("masterdata.Branch", on_delete=models.PROTECT, related_name="+")
    quantity = models.DecimalField(_("quantity"), max_digits=12, decimal_places=3)
    cost = models.DecimalField(_("cost"), **MONEY, default=0)
    movements = models.ManyToManyField("inventory.StockMovement", blank=True, related_name="+")

    class Meta:
        ordering = ["id"]


class MaintenanceRecord(ClinicScopedModel):
    """A service that was done: closes a plan's period or a work order."""

    equipment = models.ForeignKey(Equipment, on_delete=models.CASCADE, related_name="records")
    plan = models.ForeignKey(MaintenancePlan, null=True, blank=True, on_delete=models.SET_NULL, related_name="records")
    work_order = models.ForeignKey(WorkOrder, null=True, blank=True, on_delete=models.SET_NULL, related_name="records")
    done_on = models.DateField(_("done on"), default=timezone.localdate)
    performed_by = models.CharField(_("done by"), max_length=150, blank=True)
    cost = models.DecimalField(_("cost"), **MONEY, default=0)
    cycle_count = models.PositiveIntegerField(null=True, blank=True)
    notes = models.TextField(_("notes"), blank=True)

    class Meta:
        ordering = ["-done_on", "-id"]


class Licence(ClinicScopedModel):
    """Licences, certificates and badges that expire: X-ray licence, dosimeters, pressure vessel test…"""

    KINDS = [
        ("xray_licence", _("X-ray radiation licence")),
        ("dosimeter", _("Dosimeter badge")),
        ("radiation_officer", _("Radiation safety officer")),
        ("pressure_vessel", _("Pressure vessel certificate")),
        ("clinic_licence", _("Clinic licence")),
        ("medical_waste", _("Medical waste contract")),
        ("fire_safety", _("Fire safety certificate")),
        ("other", _("Other")),
    ]

    kind = models.CharField(_("kind"), max_length=20, choices=KINDS, default="other")
    title_en = models.CharField(_("title (English)"), max_length=150)
    title_ar = models.CharField(_("title (Arabic)"), max_length=150)
    branch = models.ForeignKey("masterdata.Branch", null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    equipment = models.ForeignKey(Equipment, null=True, blank=True, on_delete=models.SET_NULL, related_name="licences")
    staff = models.ForeignKey("masterdata.StaffMember", null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    reference = models.CharField(_("number"), max_length=100, blank=True)
    authority = models.CharField(_("issued by"), max_length=150, blank=True)
    issued_on = models.DateField(_("issued on"), null=True, blank=True)
    expires_on = models.DateField(_("expires on"))
    last_reading_msv = models.DecimalField(_("last dose reading (mSv)"), max_digits=7, decimal_places=3, null=True, blank=True)
    notes = models.TextField(_("notes"), blank=True)

    class Meta:
        ordering = ["expires_on", "id"]


# ---------------------------------------------------------- sterilisation


class InstrumentPack(ClinicScopedModel):
    KINDS = [
        ("cassette", _("Cassette")),
        ("pouch", _("Pouch")),
        ("tray", _("Tray")),
        ("handpiece", _("Handpiece")),
        ("surgical", _("Surgical kit")),
        ("implant", _("Implant kit")),
    ]

    code = models.CharField(_("barcode / code"), max_length=40)
    name_en = models.CharField(_("name (English)"), max_length=150)
    name_ar = models.CharField(_("name (Arabic)"), max_length=150)
    kind = models.CharField(_("kind"), max_length=12, choices=KINDS, default="cassette")
    branch = models.ForeignKey("masterdata.Branch", null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    contents = models.TextField(_("contents"), blank=True)
    is_active = models.BooleanField(_("active"), default=True)

    class Meta:
        ordering = ["code"]
        constraints = [models.UniqueConstraint(fields=["clinic", "code"], name="unique_pack_code_per_clinic")]

    def __str__(self):
        return self.code


class SterilizationCycle(ClinicScopedModel):
    PROGRAMS = [
        ("134_wrapped", _("134 °C wrapped")),
        ("134_unwrapped", _("134 °C unwrapped")),
        ("121_wrapped", _("121 °C wrapped")),
        ("prion", _("134 °C prion (18 min)")),
        ("bowie_dick", _("Bowie-Dick test")),
        ("helix", _("Helix test")),
        ("vacuum", _("Vacuum leak test")),
    ]
    # Lowest temperature and holding time each program must reach.
    MINIMUMS = {
        "134_wrapped": (Decimal("134"), 4),
        "134_unwrapped": (Decimal("134"), 3),
        "121_wrapped": (Decimal("121"), 15),
        "prion": (Decimal("134"), 18),
    }
    TEST_PROGRAMS = ("bowie_dick", "helix", "vacuum")
    PASS_FAIL = [("", "—"), ("pass", _("Pass")), ("fail", _("Fail"))]
    BI_RESULTS = [("", "—"), ("pending", _("Incubating")), ("negative", _("Negative (pass)")), ("positive", _("Positive (fail)"))]
    RESULTS = [("pass", _("Passed")), ("fail", _("Failed"))]

    machine = models.ForeignKey(Equipment, on_delete=models.PROTECT, related_name="cycles")
    branch = models.ForeignKey("masterdata.Branch", null=True, blank=True, on_delete=models.PROTECT, related_name="+")
    cycle_number = models.PositiveIntegerField(_("cycle number"))
    started_at = models.DateTimeField(_("started at"), default=timezone.now)
    program = models.CharField(_("program"), max_length=15, choices=PROGRAMS, default="134_wrapped")
    temperature = models.DecimalField(_("temperature °C"), max_digits=5, decimal_places=1, null=True, blank=True)
    pressure = models.DecimalField(_("pressure (bar)"), max_digits=5, decimal_places=2, null=True, blank=True)
    hold_minutes = models.PositiveSmallIntegerField(_("holding time (min)"), null=True, blank=True)
    duration_minutes = models.PositiveSmallIntegerField(_("whole cycle (min)"), null=True, blank=True)
    operator = models.ForeignKey("masterdata.StaffMember", null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    air_removal_test = models.CharField(_("air removal test"), max_length=12, choices=[("", "—"), ("bowie_dick", "Bowie-Dick"), ("helix", "Helix")], blank=True)
    air_removal_result = models.CharField(_("air removal result"), max_length=5, choices=PASS_FAIL, blank=True)
    chemical_indicator = models.CharField(_("chemical indicator"), max_length=5, choices=PASS_FAIL, blank=True)
    bi_used = models.BooleanField(_("biological indicator in this load"), default=False)
    bi_lot = models.CharField(_("indicator lot"), max_length=50, blank=True)
    bi_result = models.CharField(_("biological indicator result"), max_length=10, choices=BI_RESULTS, blank=True)
    bi_read_at = models.DateTimeField(null=True, blank=True)
    result = models.CharField(_("result"), max_length=5, choices=RESULTS, default="pass")
    failure_reasons = models.JSONField(default=list, blank=True)
    printout = models.ForeignKey("core.StoredFile", null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    notes = models.TextField(_("notes"), blank=True)

    class Meta:
        ordering = ["-started_at", "-id"]
        constraints = [models.UniqueConstraint(fields=["machine", "cycle_number"], name="unique_cycle_number_per_machine")]

    def __str__(self):
        return f"{self.machine} #{self.cycle_number}"

    def evaluate(self):
        """Work out pass or fail from the readings and tests; returns the reasons it failed."""
        reasons = []
        minimum = self.MINIMUMS.get(self.program)
        if minimum and self.temperature is not None and self.temperature < minimum[0]:
            reasons.append(f"Temperature {self.temperature} °C is below {minimum[0]} °C.")
        if minimum and self.hold_minutes is not None and self.hold_minutes < minimum[1]:
            reasons.append(f"Holding time {self.hold_minutes} min is shorter than {minimum[1]} min.")
        if self.air_removal_result == "fail":
            reasons.append("The air removal (Bowie-Dick / helix) test failed.")
        if self.chemical_indicator == "fail":
            reasons.append("The chemical indicator did not change colour.")
        if self.bi_result == "positive":
            reasons.append("The biological indicator grew (positive).")
        return reasons

    def save(self, *args, **kwargs):
        self.failure_reasons = self.evaluate()
        self.result = "fail" if self.failure_reasons else "pass"
        if self.bi_used and not self.bi_result:
            self.bi_result = "pending"
        super().save(*args, **kwargs)


class PackLoad(ClinicScopedModel):
    """One pack in one cycle: sterile until it expires or is opened for a patient."""

    cycle = models.ForeignKey(SterilizationCycle, on_delete=models.CASCADE, related_name="loads")
    pack = models.ForeignKey(InstrumentPack, on_delete=models.PROTECT, related_name="loads")
    expires_on = models.DateField(_("sterile until"))
    used_at = models.DateTimeField(null=True, blank=True)
    appointment = models.ForeignKey("appointments.Appointment", null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    patient = models.ForeignKey("patients.Patient", null=True, blank=True, on_delete=models.PROTECT, related_name="+")
    used_by = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    recall_contacted_at = models.DateTimeField(null=True, blank=True)
    recall_note = models.CharField(max_length=255, blank=True)

    class Meta:
        ordering = ["-cycle__started_at", "-id"]
        constraints = [models.UniqueConstraint(fields=["cycle", "pack"], name="pack_once_per_cycle")]


class DailyChecklist(ClinicScopedModel):
    ITEMS = ("surfaces", "waterlines", "suction", "ultrasonic", "waste", "autoclave_clean")

    branch = models.ForeignKey("masterdata.Branch", on_delete=models.CASCADE, related_name="+")
    date = models.DateField(_("date"), default=timezone.localdate)
    items = models.JSONField(default=dict, blank=True)
    done_by = models.ForeignKey("masterdata.StaffMember", null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    notes = models.CharField(_("notes"), max_length=255, blank=True)

    class Meta:
        ordering = ["-date", "branch_id"]
        constraints = [models.UniqueConstraint(fields=["branch", "date"], name="one_checklist_per_branch_day")]


# ---------------------------------------------------------- website booking


class BookingSettings(ClinicScopedModel):
    enabled = models.BooleanField(_("online booking is on"), default=False)
    slug = models.SlugField(_("page address"), max_length=60, unique=True, null=True, blank=True)
    days_ahead = models.PositiveSmallIntegerField(_("days ahead"), default=30)
    min_notice_hours = models.PositiveSmallIntegerField(_("minimum notice (hours)"), default=3)
    slot_minutes = models.PositiveSmallIntegerField(_("slot length (minutes)"), default=30)
    allow_dentist_choice = models.BooleanField(_("patients can pick a dentist"), default=True)
    message_en = models.TextField(_("message (English)"), blank=True)
    message_ar = models.TextField(_("message (Arabic)"), blank=True)
    services = models.ManyToManyField("masterdata.Procedure", blank=True, related_name="+")
    branches = models.ManyToManyField("masterdata.Branch", blank=True, related_name="+")

    class Meta:
        constraints = [models.UniqueConstraint(fields=["clinic"], name="one_booking_settings_per_clinic")]

    for_clinic = classmethod(for_clinic)


class BookingRequest(ClinicScopedModel):
    STATUSES = [
        ("pending", _("Waiting")),
        ("confirmed", _("Confirmed")),
        ("rejected", _("Declined")),
        ("expired", _("Expired")),
    ]

    reference = models.CharField(max_length=12, db_index=True)
    branch = models.ForeignKey("masterdata.Branch", on_delete=models.PROTECT, related_name="+")
    procedure = models.ForeignKey("masterdata.Procedure", null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    dentist = models.ForeignKey("masterdata.StaffMember", null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    dentist_chosen = models.BooleanField(default=False)
    start = models.DateTimeField(_("start"))
    duration_minutes = models.PositiveSmallIntegerField(default=30)
    name = models.CharField(_("name"), max_length=150)
    phone = models.CharField(_("mobile"), max_length=30)
    note = models.CharField(_("note"), max_length=500, blank=True)
    language = models.CharField(max_length=2, default="ar")
    consent = models.BooleanField(default=False)
    status = models.CharField(_("status"), max_length=10, choices=STATUSES, default="pending")
    patient = models.ForeignKey("patients.Patient", null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    appointment = models.ForeignKey("appointments.Appointment", null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    decided_by = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    decided_at = models.DateTimeField(null=True, blank=True)
    reject_reason = models.CharField(max_length=255, blank=True)
    ip_address = models.GenericIPAddressField(null=True, blank=True)
    user_agent = models.CharField(max_length=255, blank=True)

    class Meta:
        ordering = ["start", "id"]
        indexes = [models.Index(fields=["clinic", "status"]), models.Index(fields=["ip_address", "created_at"])]

    @property
    def end(self):
        return self.start + timedelta(minutes=self.duration_minutes)
