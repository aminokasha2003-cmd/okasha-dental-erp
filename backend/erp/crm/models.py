"""Phase 7: leads (enquiries before they become patients), recall rules and
the contacts made from the recall queue, campaigns with their recipients, and
patient feedback after a visit."""

import secrets

from django.conf import settings
from django.db import models
from django.utils.translation import gettext_lazy as _

from erp.core.models import ClinicScopedModel
from erp.patients.models import normalize_phone, normalize_text


class Lead(ClinicScopedModel):
    SOURCES = [
        ("phone", _("Phone call")),
        ("walk_in", _("Walk-in")),
        ("whatsapp", _("WhatsApp")),
        ("facebook", _("Facebook")),
        ("instagram", _("Instagram")),
        ("website", _("Website")),
        ("referral", _("Referral")),
        ("google", _("Google")),
        ("other", _("Other")),
    ]
    STAGES = [
        ("new", _("New")),
        ("contacted", _("Contacted")),
        ("consultation", _("Consultation booked")),
        ("accepted", _("Treatment accepted")),
        ("won", _("Won")),
        ("lost", _("Lost")),
    ]
    OPEN_STAGES = ("new", "contacted", "consultation", "accepted")
    LOST_REASONS = [
        ("price", _("Price too high")),
        ("no_answer", _("Could not reach them")),
        ("other_clinic", _("Chose another clinic")),
        ("not_ready", _("Not ready yet")),
        ("distance", _("Too far away")),
        ("other", _("Other")),
    ]
    # Lead source -> the patient's "how they heard of us".
    PATIENT_SOURCE = {
        "walk_in": "walk_in", "referral": "friend", "facebook": "facebook", "instagram": "instagram",
        "google": "google", "website": "google",
    }

    name_ar = models.CharField(_("name (Arabic)"), max_length=200, blank=True)
    name_en = models.CharField(_("name (English)"), max_length=200, blank=True)
    phone = models.CharField(_("mobile"), max_length=30)
    gender = models.CharField(_("gender"), max_length=10, choices=[("female", _("Female")), ("male", _("Male"))], blank=True)
    language = models.CharField(_("language"), max_length=2, choices=settings.LANGUAGES, default="ar")
    whatsapp_opt_in = models.BooleanField(_("WhatsApp messages allowed"), default=True)
    source = models.CharField(_("source"), max_length=20, choices=SOURCES, default="phone")
    referred_by = models.CharField(_("referred by"), max_length=200, blank=True)
    interest = models.ForeignKey(
        "masterdata.Procedure", null=True, blank=True, on_delete=models.SET_NULL, related_name="+", verbose_name=_("interested in")
    )
    interest_text = models.CharField(_("interest (free text)"), max_length=255, blank=True)
    estimated_value = models.DecimalField(_("estimated value"), max_digits=12, decimal_places=2, default=0)
    assigned_to = models.ForeignKey(
        "masterdata.StaffMember", null=True, blank=True, on_delete=models.SET_NULL, related_name="leads", verbose_name=_("assigned to")
    )
    branch = models.ForeignKey("masterdata.Branch", null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    stage = models.CharField(_("stage"), max_length=20, choices=STAGES, default="new")
    stage_changed_at = models.DateTimeField(null=True, blank=True)
    lost_reason = models.CharField(_("lost reason"), max_length=20, choices=LOST_REASONS, blank=True)
    next_follow_up = models.DateField(_("next follow-up"), null=True, blank=True)
    notes = models.TextField(_("notes"), blank=True)
    patient = models.ForeignKey(
        "patients.Patient", null=True, blank=True, on_delete=models.SET_NULL, related_name="leads", verbose_name=_("patient")
    )
    converted_at = models.DateTimeField(null=True, blank=True)
    consultation = models.ForeignKey(
        "appointments.Appointment", null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )
    campaign = models.ForeignKey("Campaign", null=True, blank=True, on_delete=models.SET_NULL, related_name="leads")
    search_text = models.TextField(editable=False, default="")

    class Meta:
        verbose_name = _("lead")
        verbose_name_plural = _("leads")
        ordering = ["-created_at", "-id"]
        indexes = [models.Index(fields=["clinic", "phone"]), models.Index(fields=["clinic", "stage"])]

    def __str__(self):
        return self.name_ar or self.name_en or self.phone

    @property
    def is_open(self):
        return self.stage in self.OPEN_STAGES

    def save(self, *args, **kwargs):
        self.phone = normalize_phone(self.phone)
        self.search_text = " ".join(normalize_text(p) for p in (self.name_ar, self.name_en, self.phone, self.interest_text) if p)
        super().save(*args, **kwargs)


class LeadActivity(ClinicScopedModel):
    KINDS = [
        ("call", _("Call")),
        ("whatsapp", _("WhatsApp")),
        ("sms", _("SMS")),
        ("visit", _("Visit")),
        ("note", _("Note")),
        ("stage", _("Stage change")),
    ]

    lead = models.ForeignKey(Lead, on_delete=models.CASCADE, related_name="activities")
    kind = models.CharField(_("type"), max_length=10, choices=KINDS, default="note")
    text = models.TextField(_("what happened"), blank=True)
    stage_from = models.CharField(max_length=20, blank=True)
    stage_to = models.CharField(max_length=20, blank=True)

    class Meta:
        verbose_name = _("lead activity")
        verbose_name_plural = _("lead activities")
        ordering = ["-created_at", "-id"]


class RecallRule(ClinicScopedModel):
    KINDS = [
        ("checkup", _("After any visit")),
        ("after_procedure", _("After a procedure")),
    ]

    name_en = models.CharField(_("name (English)"), max_length=150)
    name_ar = models.CharField(_("name (Arabic)"), max_length=150)
    kind = models.CharField(_("starts after"), max_length=20, choices=KINDS, default="checkup")
    procedures = models.ManyToManyField("masterdata.Procedure", blank=True, related_name="+", verbose_name=_("procedures"))
    interval_months = models.PositiveSmallIntegerField(_("every (months)"), default=6)
    is_active = models.BooleanField(_("active"), default=True)
    sort_order = models.PositiveSmallIntegerField(default=0)

    class Meta:
        verbose_name = _("recall rule")
        verbose_name_plural = _("recall rules")
        ordering = ["sort_order", "id"]

    def __str__(self):
        return self.name_en


class RecallContact(ClinicScopedModel):
    """One attempt to bring a patient back for a recall, with what came of it."""

    OUTCOMES = [
        ("no_answer", _("No answer")),
        ("booked", _("Booked")),
        ("call_later", _("Call later")),
        ("declined", _("Declined")),
        ("messaged", _("Message sent")),
    ]
    CHANNELS = [("call", _("Call")), ("whatsapp", _("WhatsApp")), ("sms", _("SMS"))]

    patient = models.ForeignKey("patients.Patient", on_delete=models.CASCADE, related_name="recall_contacts")
    rule = models.ForeignKey(RecallRule, on_delete=models.CASCADE, related_name="contacts")
    due_date = models.DateField(_("due date"))
    channel = models.CharField(_("channel"), max_length=10, choices=CHANNELS, default="call")
    outcome = models.CharField(_("outcome"), max_length=20, choices=OUTCOMES)
    note = models.CharField(_("note"), max_length=255, blank=True)
    snooze_until = models.DateField(_("snoozed until"), null=True, blank=True)

    class Meta:
        verbose_name = _("recall contact")
        verbose_name_plural = _("recall contacts")
        ordering = ["-created_at", "-id"]


class Campaign(ClinicScopedModel):
    CHANNELS = [("whatsapp", _("WhatsApp")), ("sms", _("SMS"))]
    STATUSES = [("draft", _("Draft")), ("sent", _("Sent"))]

    name = models.CharField(_("name"), max_length=200)
    channel = models.CharField(_("channel"), max_length=10, choices=CHANNELS, default="whatsapp")
    message_en = models.TextField(_("message (English)"), blank=True)
    message_ar = models.TextField(_("message (Arabic)"), blank=True)
    # See erp.crm.audience for the keys.
    filters = models.JSONField(_("audience filters"), default=dict, blank=True)
    status = models.CharField(_("status"), max_length=10, choices=STATUSES, default="draft")
    # Fills {date} for people with no visit booked (an offer's last day, say).
    offer_date = models.DateField(_("date for {date}"), null=True, blank=True)
    cost = models.DecimalField(_("cost"), max_digits=12, decimal_places=2, default=0)
    sent_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        verbose_name = _("campaign")
        verbose_name_plural = _("campaigns")
        ordering = ["-created_at", "-id"]

    def __str__(self):
        return self.name


class CampaignRecipient(models.Model):
    STATUSES = [
        ("sent", _("Sent")),
        ("failed", _("Failed")),
        ("skipped", _("Skipped: no consent")),
        ("manual", _("To send by hand")),
    ]

    campaign = models.ForeignKey(Campaign, on_delete=models.CASCADE, related_name="recipients")
    patient = models.ForeignKey("patients.Patient", null=True, blank=True, on_delete=models.CASCADE, related_name="campaign_messages")
    lead = models.ForeignKey(Lead, null=True, blank=True, on_delete=models.CASCADE, related_name="campaign_messages")
    phone = models.CharField(max_length=30)
    language = models.CharField(max_length=2, default="ar")
    body = models.TextField()
    status = models.CharField(max_length=10, choices=STATUSES)
    error = models.CharField(max_length=255, blank=True)
    notification = models.ForeignKey("core.Notification", null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    sent_at = models.DateTimeField(null=True, blank=True)
    responded_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["id"]


def new_token():
    return secrets.token_urlsafe(16)


class Feedback(ClinicScopedModel):
    """How a patient rated a visit, 1 to 5. A request made for a link has no score until answered."""

    SOURCES = [("reception", _("Entered by reception")), ("link", _("Patient link"))]

    patient = models.ForeignKey("patients.Patient", on_delete=models.CASCADE, related_name="feedback")
    appointment = models.ForeignKey("appointments.Appointment", null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    dentist = models.ForeignKey("masterdata.StaffMember", null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    score = models.PositiveSmallIntegerField(_("score"), null=True, blank=True)
    comment = models.TextField(_("comment"), blank=True)
    source = models.CharField(_("source"), max_length=10, choices=SOURCES, default="reception")
    token = models.CharField(max_length=40, unique=True, default=new_token, editable=False)
    answered_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        verbose_name = _("feedback")
        verbose_name_plural = _("feedback")
        ordering = ["-created_at", "-id"]
