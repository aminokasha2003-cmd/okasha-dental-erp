from datetime import timedelta

from django.db import models
from django.utils.translation import gettext_lazy as _

from erp.core.models import ClinicScopedModel


class Appointment(ClinicScopedModel):
    STATUSES = [
        ("booked", _("Booked")),
        ("confirmed", _("Confirmed")),
        ("arrived", _("Arrived")),
        ("in_chair", _("In chair")),
        ("completed", _("Completed")),
        ("cancelled", _("Cancelled")),
        ("no_show", _("No-show")),
    ]
    # Statuses that hold the chair and the dentist's time.
    ACTIVE = ("booked", "confirmed", "arrived", "in_chair")
    # Allowed moves between statuses.
    TRANSITIONS = {
        "booked": {"confirmed", "arrived", "cancelled", "no_show"},
        "confirmed": {"booked", "arrived", "cancelled", "no_show"},
        "arrived": {"in_chair", "cancelled", "booked"},
        "in_chair": {"completed", "arrived"},
        "completed": {"in_chair"},
        "cancelled": {"booked"},
        "no_show": {"booked"},
    }

    patient = models.ForeignKey("patients.Patient", on_delete=models.PROTECT, related_name="appointments")
    dentist = models.ForeignKey("masterdata.StaffMember", on_delete=models.PROTECT, related_name="appointments")
    branch = models.ForeignKey("masterdata.Branch", on_delete=models.PROTECT, related_name="appointments")
    chair = models.ForeignKey("masterdata.Chair", null=True, blank=True, on_delete=models.PROTECT, related_name="appointments")
    procedure = models.ForeignKey(
        "masterdata.Procedure", null=True, blank=True, on_delete=models.SET_NULL, related_name="+", verbose_name=_("planned procedure")
    )
    start = models.DateTimeField(_("start"))
    duration_minutes = models.PositiveSmallIntegerField(_("duration (minutes)"), default=30)
    end = models.DateTimeField(_("end"), editable=False)
    status = models.CharField(_("status"), max_length=20, choices=STATUSES, default="booked")
    reason = models.CharField(_("reason for visit"), max_length=255, blank=True)
    notes = models.TextField(_("notes"), blank=True)
    cancel_reason = models.CharField(_("cancellation reason"), max_length=255, blank=True)
    arrived_at = models.DateTimeField(null=True, blank=True)
    seated_at = models.DateTimeField(null=True, blank=True)
    completed_at = models.DateTimeField(null=True, blank=True)
    reminder_sent_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        verbose_name = _("appointment")
        verbose_name_plural = _("appointments")
        ordering = ["start", "id"]
        indexes = [
            models.Index(fields=["clinic", "start"]),
            models.Index(fields=["chair", "start"]),
            models.Index(fields=["dentist", "start"]),
        ]

    def __str__(self):
        return f"{self.patient} {self.start:%Y-%m-%d %H:%M}"

    def save(self, *args, **kwargs):
        self.end = self.start + timedelta(minutes=self.duration_minutes)
        super().save(*args, **kwargs)

    @property
    def is_active(self):
        return self.status in self.ACTIVE
