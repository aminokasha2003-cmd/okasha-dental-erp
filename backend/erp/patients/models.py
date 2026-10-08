from django.conf import settings
from django.db import IntegrityError, models, transaction
from django.utils.translation import gettext_lazy as _

from erp.core.models import ClinicScopedModel

ARABIC_FOLD = str.maketrans({"أ": "ا", "إ": "ا", "آ": "ا", "ٱ": "ا", "ة": "ه", "ى": "ي", "ؤ": "و", "ئ": "ي", "ـ": ""})
ARABIC_DIGITS = str.maketrans("٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹", "01234567890123456789")
DIACRITICS = {chr(c) for c in range(0x064B, 0x0653)}


def normalize_text(value):
    """Fold Arabic letter variants, diacritics and digits so searches match how people type."""
    value = (value or "").translate(ARABIC_DIGITS).translate(ARABIC_FOLD).lower()
    return "".join(ch for ch in value if ch not in DIACRITICS)


def normalize_phone(value):
    """Keep digits and a leading +, so '010 1234-5678' and '01012345678' match."""
    value = (value or "").translate(ARABIC_DIGITS).strip()
    digits = "".join(ch for ch in value if ch.isdigit())
    return ("+" + digits) if value.startswith("+") else digits


class Patient(ClinicScopedModel):
    GENDERS = [("female", _("Female")), ("male", _("Male"))]
    REFERRALS = [
        ("walk_in", _("Walk-in")),
        ("friend", _("Friend or family")),
        ("facebook", _("Facebook")),
        ("instagram", _("Instagram")),
        ("google", _("Google")),
        ("doctor", _("Referred by a doctor")),
        ("other", _("Other")),
    ]

    file_number = models.CharField(_("file number"), max_length=20, editable=False)
    name_ar = models.CharField(_("name (Arabic)"), max_length=200, blank=True)
    name_en = models.CharField(_("name (English)"), max_length=200, blank=True)
    gender = models.CharField(_("gender"), max_length=10, choices=GENDERS, blank=True)
    date_of_birth = models.DateField(_("date of birth"), null=True, blank=True)
    phone = models.CharField(_("mobile"), max_length=30)
    phone_alt = models.CharField(_("other phone"), max_length=30, blank=True)
    whatsapp_opt_in = models.BooleanField(_("WhatsApp messages allowed"), default=True)
    language = models.CharField(_("language"), max_length=2, choices=settings.LANGUAGES, default="ar")
    email = models.EmailField(_("email"), blank=True)
    national_id = models.CharField(_("national ID"), max_length=20, blank=True)
    address = models.TextField(_("address"), blank=True)
    occupation = models.CharField(_("occupation"), max_length=100, blank=True)
    referral_source = models.CharField(_("how they heard of us"), max_length=20, choices=REFERRALS, blank=True)
    home_branch = models.ForeignKey(
        "masterdata.Branch", null=True, blank=True, on_delete=models.SET_NULL, related_name="+", verbose_name=_("branch")
    )
    preferred_dentist = models.ForeignKey(
        "masterdata.StaffMember", null=True, blank=True, on_delete=models.SET_NULL, related_name="+", verbose_name=_("dentist")
    )
    notes = models.TextField(_("front-desk notes"), blank=True)
    emergency_contact_name = models.CharField(_("emergency contact"), max_length=150, blank=True)
    emergency_contact_phone = models.CharField(_("emergency contact phone"), max_length=30, blank=True)
    insurance = models.CharField(_("insurance"), max_length=150, blank=True)
    is_active = models.BooleanField(_("active"), default=True)
    # Lower-cased, Arabic-normalized copy of the searchable fields.
    search_text = models.TextField(editable=False, default="")

    class Meta:
        verbose_name = _("patient")
        verbose_name_plural = _("patients")
        ordering = ["-created_at"]
        constraints = [models.UniqueConstraint(fields=["clinic", "file_number"], name="unique_file_number_per_clinic")]
        indexes = [models.Index(fields=["clinic", "phone"])]

    def __str__(self):
        return f"{self.file_number} {self.name_ar or self.name_en}"

    @property
    def display_name(self):
        return self.name_ar or self.name_en

    def save(self, *args, **kwargs):
        self.phone = normalize_phone(self.phone)
        self.phone_alt = normalize_phone(self.phone_alt)
        if self.file_number:
            self.search_text = self._build_search_text()
            return super().save(*args, **kwargs)
        # Give the next file number in this clinic; retry if two people save at once.
        for _attempt in range(5):
            self.file_number = self._next_file_number()
            self.search_text = self._build_search_text()
            try:
                with transaction.atomic():
                    return super().save(*args, **kwargs)
            except IntegrityError:
                self.pk = None
                self._state.adding = True
                continue
        raise IntegrityError("Could not assign a file number.")

    def _build_search_text(self):
        parts = [self.file_number, self.name_ar, self.name_en, self.phone, self.phone_alt, self.national_id]
        return " ".join(normalize_text(p) for p in parts if p)

    def _next_file_number(self):
        last = Patient.objects.filter(clinic_id=self.clinic_id).order_by("-id").values_list("file_number", flat=True).first()
        last_number = int(last.split("-")[-1]) if last and last.split("-")[-1].isdigit() else 0
        return f"P-{last_number + 1:05d}"


class MedicalHistory(ClinicScopedModel):
    """The detailed medical questionnaire. Clinical staff only; reception sees alerts."""

    patient = models.OneToOneField(Patient, on_delete=models.CASCADE, related_name="medical_history")
    diabetes = models.BooleanField(_("diabetes"), default=False)
    hypertension = models.BooleanField(_("high blood pressure"), default=False)
    heart_disease = models.BooleanField(_("heart disease"), default=False)
    bleeding_disorder = models.BooleanField(_("bleeding disorder"), default=False)
    blood_thinners = models.BooleanField(_("takes blood thinners"), default=False)
    asthma = models.BooleanField(_("asthma"), default=False)
    epilepsy = models.BooleanField(_("epilepsy"), default=False)
    hepatitis = models.BooleanField(_("hepatitis"), default=False)
    kidney_disease = models.BooleanField(_("kidney disease"), default=False)
    pregnant = models.BooleanField(_("pregnant"), default=False)
    smoker = models.BooleanField(_("smoker"), default=False)
    allergies = models.TextField(_("allergies"), blank=True)
    medications = models.TextField(_("current medications"), blank=True)
    past_surgeries = models.TextField(_("past operations"), blank=True)
    anaesthesia_reactions = models.TextField(_("reactions to anaesthesia"), blank=True)
    notes = models.TextField(_("other notes"), blank=True)

    class Meta:
        verbose_name = _("medical history")
        verbose_name_plural = _("medical histories")

    def __str__(self):
        return f"Medical history of {self.patient}"


class MedicalAlert(ClinicScopedModel):
    """Short warnings everyone who sees the patient must notice (reception included)."""

    KINDS = [
        ("allergy", _("Allergy")),
        ("condition", _("Condition")),
        ("medication", _("Medication")),
        ("other", _("Other")),
    ]

    patient = models.ForeignKey(Patient, on_delete=models.CASCADE, related_name="alerts")
    kind = models.CharField(_("type"), max_length=20, choices=KINDS, default="condition")
    text = models.CharField(_("alert"), max_length=200)
    guidance = models.CharField(_("what to do"), max_length=255, blank=True)
    is_active = models.BooleanField(_("active"), default=True)

    class Meta:
        verbose_name = _("medical alert")
        verbose_name_plural = _("medical alerts")
        ordering = ["id"]

    def __str__(self):
        return self.text


class PatientNote(ClinicScopedModel):
    """Staff-only notes on a patient, each with its author and date (created_by / created_at)."""

    patient = models.ForeignKey(Patient, on_delete=models.CASCADE, related_name="staff_notes")
    text = models.TextField(_("note"))

    class Meta:
        verbose_name = _("patient note")
        verbose_name_plural = _("patient notes")
        ordering = ["-created_at", "-id"]

    def __str__(self):
        return self.text[:50]
