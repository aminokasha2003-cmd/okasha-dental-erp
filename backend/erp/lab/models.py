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
        ("milling", _("Milling")),
        ("finishing", _("Sintering and glaze")),
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

    number = models.CharField(_("number"), max_length=20, editable=False)
    patient = models.ForeignKey("patients.Patient", on_delete=models.PROTECT, related_name="lab_cases")
    plan_line = models.ForeignKey("clinical.TreatmentPlanLine", on_delete=models.PROTECT, related_name="lab_cases")
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
