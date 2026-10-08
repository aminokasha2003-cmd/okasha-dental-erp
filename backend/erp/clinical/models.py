"""Phase 2: dental chart, treatment plans, visit notes, prescriptions and consent forms.

The treatment plan line is the central record: appointments, visit notes and,
in later phases, invoice lines and lab cases point to it.
"""

from decimal import Decimal

from django.core.exceptions import ValidationError
from django.db import models
from django.utils.translation import gettext_lazy as _

from erp.core.models import ClinicScopedModel

# FDI permanent teeth: quadrants 1-4, teeth 1-8.
PERMANENT_TEETH = [q * 10 + n for q in (1, 2, 3, 4) for n in range(1, 9)]
SURFACES = ("M", "D", "O", "B", "L")
SURFACE_STATES = ("sound", "caries", "filling", "rct")


def validate_tooth(value):
    if value not in PERMANENT_TEETH:
        raise ValidationError(_("Use an FDI permanent tooth number (11 to 48)."))


def validate_surfaces(value):
    """'MOD' style string: each letter a surface, no repeats."""
    if any(ch not in SURFACES for ch in value) or len(set(value)) != len(value):
        raise ValidationError(_("Surfaces are letters from M, D, O, B, L, each once."))


class ToothState(ClinicScopedModel):
    """The current state of one tooth on a patient's chart."""

    patient = models.ForeignKey("patients.Patient", on_delete=models.CASCADE, related_name="teeth")
    tooth = models.PositiveSmallIntegerField(_("tooth"), validators=[validate_tooth])
    missing = models.BooleanField(_("missing"), default=False)
    crown = models.BooleanField(_("crown"), default=False)
    implant = models.BooleanField(_("implant"), default=False)
    root_canal_treated = models.BooleanField(_("root canal treated"), default=False)
    # {"M": "caries", "O": "filling"}; surfaces not listed are sound.
    surfaces = models.JSONField(_("surfaces"), default=dict, blank=True)
    note = models.TextField(_("note"), blank=True)

    class Meta:
        verbose_name = _("tooth")
        verbose_name_plural = _("teeth")
        ordering = ["tooth"]
        constraints = [models.UniqueConstraint(fields=["patient", "tooth"], name="unique_tooth_per_patient")]

    def __str__(self):
        return f"{self.patient} tooth {self.tooth}"

    def clean(self):
        for surface, state in (self.surfaces or {}).items():
            if surface not in SURFACES or state not in SURFACE_STATES:
                raise ValidationError({"surfaces": _("Unknown surface or state.")})


class TreatmentPlan(ClinicScopedModel):
    STATUSES = [
        ("proposed", _("Proposed")),
        ("accepted", _("Accepted")),
        ("in_progress", _("In progress")),
        ("completed", _("Completed")),
        ("cancelled", _("Cancelled")),
    ]

    patient = models.ForeignKey("patients.Patient", on_delete=models.PROTECT, related_name="treatment_plans")
    dentist = models.ForeignKey("masterdata.StaffMember", on_delete=models.PROTECT, related_name="treatment_plans")
    title = models.CharField(_("title"), max_length=200, blank=True)
    status = models.CharField(_("status"), max_length=20, choices=STATUSES, default="proposed")
    notes = models.TextField(_("notes"), blank=True)
    accepted_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        verbose_name = _("treatment plan")
        verbose_name_plural = _("treatment plans")
        ordering = ["-created_at", "-id"]

    def __str__(self):
        return self.title or f"Plan {self.pk}"

    def refresh_status(self):
        """Keep the plan's status in step with its lines once work has started."""
        if self.status in ("proposed", "cancelled"):
            return
        lines = [line.status for line in self.lines.all() if line.status != "cancelled"]
        if lines and all(s == "done" for s in lines):
            new = "completed"
        elif any(s in ("done", "in_progress") for s in lines):
            new = "in_progress"
        else:
            new = "accepted"
        if new != self.status:
            self.status = new
            self.save(update_fields=["status", "updated_at"])


class TreatmentPlanLine(ClinicScopedModel):
    STATUSES = [
        ("planned", _("Planned")),
        ("in_progress", _("In progress")),
        ("done", _("Done")),
        ("cancelled", _("Cancelled")),
    ]

    plan = models.ForeignKey(TreatmentPlan, on_delete=models.CASCADE, related_name="lines")
    procedure = models.ForeignKey("masterdata.Procedure", on_delete=models.PROTECT, related_name="+")
    tooth = models.PositiveSmallIntegerField(_("tooth"), null=True, blank=True, validators=[validate_tooth])
    surfaces = models.CharField(_("surfaces"), max_length=5, blank=True, validators=[validate_surfaces])
    price = models.DecimalField(_("price"), max_digits=10, decimal_places=2, default=Decimal("0"))
    discount = models.DecimalField(_("discount"), max_digits=10, decimal_places=2, default=Decimal("0"))
    status = models.CharField(_("status"), max_length=20, choices=STATUSES, default="planned")
    sort_order = models.PositiveSmallIntegerField(default=0)
    notes = models.CharField(_("notes"), max_length=255, blank=True)
    # The visit booked for this work, if any.
    appointment = models.ForeignKey(
        "appointments.Appointment", null=True, blank=True, on_delete=models.SET_NULL, related_name="plan_lines"
    )
    completed_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        verbose_name = _("treatment plan line")
        verbose_name_plural = _("treatment plan lines")
        ordering = ["sort_order", "id"]

    def __str__(self):
        tooth = f" tooth {self.tooth}" if self.tooth else ""
        return f"{self.procedure}{tooth}"

    @property
    def net(self):
        return self.price - self.discount


class VisitNote(ClinicScopedModel):
    """What the dentist found and did at a visit. Signed notes cannot be changed."""

    patient = models.ForeignKey("patients.Patient", on_delete=models.PROTECT, related_name="visit_notes")
    appointment = models.ForeignKey(
        "appointments.Appointment", null=True, blank=True, on_delete=models.SET_NULL, related_name="visit_notes"
    )
    dentist = models.ForeignKey("masterdata.StaffMember", on_delete=models.PROTECT, related_name="visit_notes")
    visit_date = models.DateField(_("visit date"))
    complaint = models.TextField(_("chief complaint"), blank=True)
    findings = models.TextField(_("findings"), blank=True)
    work_done = models.TextField(_("work done"), blank=True)
    next_step = models.TextField(_("next step"), blank=True)
    lines = models.ManyToManyField(TreatmentPlanLine, blank=True, related_name="visit_notes", verbose_name=_("plan lines worked on"))
    signed_at = models.DateTimeField(null=True, blank=True)
    signed_by = models.ForeignKey("core.User", null=True, blank=True, on_delete=models.PROTECT, related_name="+")

    class Meta:
        verbose_name = _("visit note")
        verbose_name_plural = _("visit notes")
        ordering = ["-visit_date", "-id"]

    def __str__(self):
        return f"{self.patient} {self.visit_date}"


class Prescription(ClinicScopedModel):
    patient = models.ForeignKey("patients.Patient", on_delete=models.PROTECT, related_name="prescriptions")
    dentist = models.ForeignKey("masterdata.StaffMember", on_delete=models.PROTECT, related_name="prescriptions")
    visit_note = models.ForeignKey(VisitNote, null=True, blank=True, on_delete=models.SET_NULL, related_name="prescriptions")
    # [{"drug": "Amoxicillin 500 mg", "dose": "1 capsule", "frequency": "every 8 hours", "duration": "5 days", "notes": ""}]
    items = models.JSONField(_("medicines"), default=list)
    notes = models.TextField(_("instructions"), blank=True)

    class Meta:
        verbose_name = _("prescription")
        verbose_name_plural = _("prescriptions")
        ordering = ["-created_at", "-id"]

    def __str__(self):
        return f"Prescription {self.pk} for {self.patient}"


class ConsentTemplate(ClinicScopedModel):
    title_en = models.CharField(_("title (English)"), max_length=200)
    title_ar = models.CharField(_("title (Arabic)"), max_length=200)
    body_en = models.TextField(_("text (English)"))
    body_ar = models.TextField(_("text (Arabic)"))
    is_active = models.BooleanField(_("active"), default=True)

    class Meta:
        verbose_name = _("consent form template")
        verbose_name_plural = _("consent form templates")
        ordering = ["title_en"]

    def __str__(self):
        return self.title_en


class PatientConsent(ClinicScopedModel):
    """A consent form given to a patient. The text is copied in, so later template edits do not change it."""

    patient = models.ForeignKey("patients.Patient", on_delete=models.PROTECT, related_name="consents")
    template = models.ForeignKey(ConsentTemplate, null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    plan_line = models.ForeignKey(TreatmentPlanLine, null=True, blank=True, on_delete=models.SET_NULL, related_name="consents")
    language = models.CharField(_("language"), max_length=2, default="ar")
    title = models.CharField(_("title"), max_length=200)
    body = models.TextField(_("text"))
    signer_name = models.CharField(_("signed by"), max_length=200, blank=True)
    signer_relation = models.CharField(_("relation to patient"), max_length=100, blank=True)
    # PNG data URL drawn on screen (tablet or mouse).
    signature = models.TextField(blank=True)
    signed_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        verbose_name = _("patient consent")
        verbose_name_plural = _("patient consents")
        ordering = ["-created_at", "-id"]

    def __str__(self):
        return self.title
