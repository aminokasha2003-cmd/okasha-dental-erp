"""Phase 4: the in-house lab. A lab case is ordered from a treatment plan line,
moves through the lab's stages, is assigned to a technician, carries its design
files, can be remade, and records what it cost."""

from decimal import Decimal

from django.db import models, transaction
from django.utils.translation import gettext_lazy as _

from erp.core.models import ClinicScopedModel

ZERO = Decimal("0.00")


class CaseCounter(models.Model):
    """Next lab case number per clinic (LAB-00001)."""

    clinic = models.OneToOneField("core.Clinic", on_delete=models.CASCADE, related_name="+")
    last = models.PositiveIntegerField(default=0)

    @classmethod
    def next(cls, clinic):
        with transaction.atomic():
            counter, _created = cls.objects.select_for_update().get_or_create(clinic=clinic)
            counter.last += 1
            counter.save(update_fields=["last"])
        return f"LAB-{counter.last:05d}"


class LabCase(ClinicScopedModel):
    # The stage list from the patient card design, plus delivery.
    STAGES = [
        ("received", _("Scan received")),
        ("design", _("CAD design")),
        ("milling", _("Milling and printing")),
        ("finishing", _("Sintering and glaze")),
        ("qc", _("Quality check")),
        ("ready", _("Ready for try-in")),
        ("delivered", _("Delivered")),
    ]
    STAGE_ORDER = [code for code, _label in STAGES]
    RESTORATIONS = [
        ("crown", _("Crown")),
        ("bridge", _("Bridge")),
        ("veneer", _("Veneer")),
        ("inlay_onlay", _("Inlay or onlay")),
        ("implant_crown", _("Implant crown")),
        ("post_core", _("Post and core")),
        ("denture_full", _("Full denture")),
        ("denture_partial", _("Partial denture")),
        ("night_guard", _("Night guard")),
        ("temporary", _("Temporary")),
        ("other", _("Other")),
    ]
    MATERIALS = [
        ("zirconia", _("Zirconia")),
        ("emax", _("Lithium disilicate (e.max)")),
        ("pfm", _("Porcelain fused to metal")),
        ("metal", _("Metal")),
        ("pmma", _("PMMA")),
        ("composite", _("Composite")),
        ("acrylic", _("Acrylic")),
        ("other", _("Other")),
    ]
    REMAKE_REASONS = [
        ("fit", _("Poor fit")),
        ("shade", _("Wrong shade")),
        ("fracture", _("Fracture")),
        ("design", _("Design or contacts")),
        ("patient", _("Patient request")),
        ("other", _("Other")),
    ]
    CHARGED_TO = [("lab", _("Lab")), ("clinic", _("Clinic"))]
    PRIORITIES = [("normal", _("Normal")), ("rush", _("Rush"))]
    SHADE_GUIDES = [("vita_classic", _("VITA Classical")), ("vita_3d", _("VITA 3D-Master")), ("other", _("Other"))]
    MARGINS = [
        ("chamfer", _("Chamfer")),
        ("shoulder", _("Shoulder")),
        ("knife_edge", _("Knife edge")),
        ("porcelain_butt", _("Porcelain butt margin")),
        ("metal_collar", _("Metal collar")),
    ]
    CONTACTS = [("light", _("Light")), ("normal", _("Normal")), ("tight", _("Tight"))]
    OCCLUSION = [("in", _("In occlusion")), ("light", _("Light occlusion")), ("out", _("Out of occlusion"))]
    PONTICS = [
        ("ridge_lap", _("Ridge lap")),
        ("modified_ridge_lap", _("Modified ridge lap")),
        ("ovate", _("Ovate")),
        ("sanitary", _("Sanitary (hygienic)")),
    ]
    ABUTMENTS = [
        ("stock", _("Stock abutment")),
        ("custom_ti", _("Custom titanium")),
        ("zirconia", _("Zirconia")),
        ("ti_base", _("Ti-base hybrid")),
    ]
    RETENTION = [("screw", _("Screw retained")), ("cement", _("Cement retained"))]
    # What came in with the order, checked off on arrival.
    ENCLOSURES = [
        ("scan", _("Digital scan")),
        ("impression_upper", _("Upper impression")),
        ("impression_lower", _("Lower impression")),
        ("bite", _("Bite registration")),
        ("models", _("Models")),
        ("photos", _("Shade photos")),
        ("implant_parts", _("Implant parts or analogs")),
        ("old_denture", _("Old denture")),
        ("custom_tray", _("Custom tray")),
        ("shade_tab", _("Shade tab")),
    ]

    number = models.CharField(_("number"), max_length=20, editable=False)
    patient = models.ForeignKey("patients.Patient", on_delete=models.PROTECT, related_name="lab_cases")
    # Usually ordered from a plan line; a direct order from the lab page may have none.
    plan_line = models.ForeignKey(
        "clinical.TreatmentPlanLine", null=True, blank=True, on_delete=models.PROTECT, related_name="lab_cases"
    )
    dentist = models.ForeignKey("masterdata.StaffMember", on_delete=models.PROTECT, related_name="ordered_lab_cases")
    technician = models.ForeignKey(
        "masterdata.StaffMember", null=True, blank=True, on_delete=models.PROTECT, related_name="lab_cases"
    )
    restoration = models.CharField(_("restoration"), max_length=20, choices=RESTORATIONS, default="crown")
    material = models.CharField(_("material"), max_length=20, choices=MATERIALS, default="zirconia")
    shade = models.CharField(_("shade"), max_length=20, blank=True)
    teeth = models.CharField(_("teeth"), max_length=60, blank=True)
    units = models.PositiveSmallIntegerField(_("units"), default=1)
    instructions = models.TextField(_("instructions"), blank=True)
    due_date = models.DateField(_("due date"))
    # The visit the work is fitted at (try-in or delivery).
    appointment = models.ForeignKey(
        "appointments.Appointment", null=True, blank=True, on_delete=models.SET_NULL, related_name="lab_cases"
    )
    stage = models.CharField(_("stage"), max_length=20, choices=STAGES, default="received")
    delivered_at = models.DateTimeField(null=True, blank=True)
    cancelled_at = models.DateTimeField(null=True, blank=True)
    cancel_reason = models.CharField(_("cancellation reason"), max_length=255, blank=True)
    remake_of = models.ForeignKey("self", null=True, blank=True, on_delete=models.PROTECT, related_name="remakes")
    remake_reason = models.CharField(_("remake reason"), max_length=20, choices=REMAKE_REASONS, blank=True)
    remake_note = models.CharField(_("remake note"), max_length=255, blank=True)
    remake_charged_to = models.CharField(_("remake cost carried by"), max_length=10, choices=CHARGED_TO, blank=True)
    priority = models.CharField(_("priority"), max_length=10, choices=PRIORITIES, default="normal")
    pan_number = models.CharField(_("pan number"), max_length=20, blank=True)
    on_hold = models.BooleanField(_("on hold"), default=False)
    hold_reason = models.CharField(_("hold reason"), max_length=255, blank=True)
    shade_guide = models.CharField(_("shade guide"), max_length=20, choices=SHADE_GUIDES, default="vita_classic")
    stump_shade = models.CharField(_("stump shade"), max_length=20, blank=True)
    cervical_shade = models.CharField(_("cervical shade"), max_length=20, blank=True)
    incisal_shade = models.CharField(_("incisal shade"), max_length=20, blank=True)
    margin = models.CharField(_("margin"), max_length=20, choices=MARGINS, blank=True)
    contacts = models.CharField(_("contacts"), max_length=10, choices=CONTACTS, blank=True)
    occlusion = models.CharField(_("occlusion"), max_length=10, choices=OCCLUSION, blank=True)
    pontic = models.CharField(_("pontic design"), max_length=20, choices=PONTICS, blank=True)
    implant_system = models.CharField(_("implant system"), max_length=100, blank=True)
    implant_platform = models.CharField(_("implant platform"), max_length=50, blank=True)
    abutment = models.CharField(_("abutment"), max_length=20, choices=ABUTMENTS, blank=True)
    retention = models.CharField(_("retention"), max_length=10, choices=RETENTION, blank=True)
    enclosures = models.JSONField(_("received with the order"), default=list, blank=True)
    outsourced_to = models.CharField(_("sent to outside lab"), max_length=150, blank=True)
    outsource_tracking = models.CharField(_("outside lab reference"), max_length=100, blank=True)
    material_cost = models.DecimalField(_("material cost"), max_digits=10, decimal_places=2, default=0)
    labour_cost = models.DecimalField(_("labour cost"), max_digits=10, decimal_places=2, default=0)

    class Meta:
        verbose_name = _("lab case")
        verbose_name_plural = _("lab cases")
        ordering = ["due_date", "id"]
        constraints = [models.UniqueConstraint(fields=["clinic", "number"], name="unique_lab_case_number")]

    def __str__(self):
        return self.number

    def save(self, *args, **kwargs):
        if not self.number:
            self.number = CaseCounter.next(self.clinic)
        super().save(*args, **kwargs)

    @property
    def is_open(self):
        return self.cancelled_at is None and self.stage != "delivered"

    @property
    def cost_total(self):
        return (self.material_cost or ZERO) + (self.labour_cost or ZERO)

    @property
    def cost_per_unit(self):
        return (self.cost_total / self.units).quantize(Decimal("0.01")) if self.units else self.cost_total


class StageEvent(ClinicScopedModel):
    """When a case entered a stage, who moved it, and an optional note."""

    case = models.ForeignKey(LabCase, on_delete=models.CASCADE, related_name="events")
    stage = models.CharField(_("stage"), max_length=20, choices=LabCase.STAGES)
    note = models.CharField(_("note"), max_length=255, blank=True)

    class Meta:
        verbose_name = _("lab stage")
        verbose_name_plural = _("lab stages")
        ordering = ["created_at", "id"]
