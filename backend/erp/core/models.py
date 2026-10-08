from django.conf import settings
from django.contrib.auth.models import AbstractUser, UserManager
from django.contrib.contenttypes.fields import GenericForeignKey
from django.contrib.contenttypes.models import ContentType
from django.core.exceptions import ValidationError
from django.db import models
from django.utils.translation import gettext_lazy as _

from . import rbac


class Clinic(models.Model):
    """The tenant. Every other record carries a clinic ID through it."""

    name_en = models.CharField(_("name (English)"), max_length=200)
    name_ar = models.CharField(_("name (Arabic)"), max_length=200)
    phone = models.CharField(_("phone"), max_length=30, blank=True)
    email = models.EmailField(_("email"), blank=True)
    address_en = models.TextField(_("address (English)"), blank=True)
    address_ar = models.TextField(_("address (Arabic)"), blank=True)
    currency = models.CharField(_("currency"), max_length=3, default="EGP")
    default_language = models.CharField(
        _("default language"), max_length=2, choices=settings.LANGUAGES, default="ar"
    )
    tooth_numbering = models.CharField(
        _("tooth numbering"), max_length=10, choices=[("fdi", "FDI")], default="fdi"
    )
    tax_registration_number = models.CharField(_("tax registration number"), max_length=50, blank=True)
    commercial_register = models.CharField(_("commercial register"), max_length=50, blank=True)
    tax_rate = models.DecimalField(_("tax rate %"), max_digits=5, decimal_places=2, default=0)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        verbose_name = _("clinic")
        verbose_name_plural = _("clinics")

    def __str__(self):
        return self.name_en


class ClinicScopedModel(models.Model):
    """Base for every business record: clinic ID plus who/when stamps."""

    clinic = models.ForeignKey(Clinic, on_delete=models.PROTECT, related_name="+")
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="+", editable=False
    )
    updated_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="+", editable=False
    )

    class Meta:
        abstract = True


class Role(models.Model):
    clinic = models.ForeignKey(Clinic, on_delete=models.CASCADE, related_name="roles")
    code = models.SlugField(_("code"), max_length=50)
    name_en = models.CharField(_("name (English)"), max_length=100)
    name_ar = models.CharField(_("name (Arabic)"), max_length=100)
    permissions = models.JSONField(_("permissions"), default=dict, blank=True)
    is_system = models.BooleanField(
        _("built-in"), default=False, help_text=_("Built-in roles can be edited but not deleted.")
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        verbose_name = _("role")
        verbose_name_plural = _("roles")
        constraints = [models.UniqueConstraint(fields=["clinic", "code"], name="unique_role_code_per_clinic")]
        ordering = ["id"]

    def __str__(self):
        return self.name_en

    def clean(self):
        try:
            self.permissions = rbac.normalize_permissions(self.permissions)
        except ValueError as exc:
            raise ValidationError({"permissions": str(exc)}) from exc

    def allows(self, module, action):
        return action in self.permissions.get(module, [])


class User(AbstractUser):
    clinic = models.ForeignKey(Clinic, null=True, blank=True, on_delete=models.PROTECT, related_name="users")
    roles = models.ManyToManyField(Role, blank=True, related_name="users", verbose_name=_("roles"))
    phone = models.CharField(_("phone"), max_length=30, blank=True)
    language = models.CharField(_("language"), max_length=2, choices=settings.LANGUAGES, default="ar")

    objects = UserManager()

    class Meta:
        verbose_name = _("user")
        verbose_name_plural = _("users")

    def module_permissions(self):
        """Union of the permissions of every role the user holds."""
        if self.is_superuser:
            return {module: list(rbac.ACTIONS) for module in rbac.MODULES}
        merged = {}
        for role in self.roles.all():
            for module, actions in role.permissions.items():
                merged.setdefault(module, set()).update(actions)
        return {m: [a for a in rbac.ACTIONS if a in acts] for m, acts in merged.items()}

    def has_module_perm(self, module, action):
        if not self.is_active:
            return False
        if self.is_superuser:
            return True
        return any(role.allows(module, action) for role in self.roles.all())


class AuditEntry(models.Model):
    """Who created or changed a record, when, and the old and new values."""

    ACTIONS = [("create", _("Created")), ("update", _("Changed")), ("delete", _("Deleted"))]

    clinic = models.ForeignKey(Clinic, null=True, blank=True, on_delete=models.CASCADE, related_name="+")
    user = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    action = models.CharField(max_length=10, choices=ACTIONS)
    content_type = models.ForeignKey(ContentType, on_delete=models.PROTECT)
    object_id = models.CharField(max_length=64)
    object_repr = models.CharField(max_length=255)
    changes = models.JSONField(default=dict, help_text="{field: [old, new]}")
    ip_address = models.GenericIPAddressField(null=True, blank=True)
    timestamp = models.DateTimeField(auto_now_add=True, db_index=True)

    class Meta:
        verbose_name = _("audit entry")
        verbose_name_plural = _("audit log")
        ordering = ["-timestamp", "-id"]
        indexes = [models.Index(fields=["content_type", "object_id"])]

    def __str__(self):
        return f"{self.get_action_display()} {self.object_repr}"


class StoredFile(ClinicScopedModel):
    """A file attached to any record: X-ray, photo, scan, signed consent."""

    KINDS = [
        ("xray", _("X-ray")),
        ("photo", _("Photo")),
        ("scan", _("Scan / design file")),
        ("consent", _("Signed consent")),
        ("document", _("Document")),
        ("other", _("Other")),
    ]

    file = models.FileField(_("file"), upload_to="clinic_%Y/%m/")
    original_name = models.CharField(_("original name"), max_length=255)
    content_type_header = models.CharField(_("file type"), max_length=100)
    size = models.PositiveBigIntegerField(_("size in bytes"))
    kind = models.CharField(_("kind"), max_length=20, choices=KINDS, default="other")
    description = models.CharField(_("description"), max_length=255, blank=True)
    # The record this file is attached to (optional; a file can stand alone).
    attached_type = models.ForeignKey(ContentType, null=True, blank=True, on_delete=models.PROTECT, related_name="+")
    attached_id = models.CharField(max_length=64, blank=True)
    attached_to = GenericForeignKey("attached_type", "attached_id")

    class Meta:
        verbose_name = _("file")
        verbose_name_plural = _("files")
        ordering = ["-created_at"]
        indexes = [models.Index(fields=["attached_type", "attached_id"])]

    def __str__(self):
        return self.original_name


class Notification(ClinicScopedModel):
    """One message on one channel. Modules send through erp.core.notifications."""

    CHANNELS = [("in_app", _("In-app")), ("whatsapp", _("WhatsApp")), ("sms", _("SMS"))]
    STATUSES = [("queued", _("Queued")), ("sent", _("Sent")), ("failed", _("Failed")), ("read", _("Read"))]

    channel = models.CharField(max_length=10, choices=CHANNELS)
    recipient_user = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.CASCADE, related_name="notifications"
    )
    recipient_phone = models.CharField(max_length=30, blank=True)
    subject = models.CharField(max_length=200, blank=True)
    body = models.TextField()
    status = models.CharField(max_length=10, choices=STATUSES, default="queued")
    error = models.TextField(blank=True)
    provider_message_id = models.CharField(max_length=100, blank=True)
    sent_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        verbose_name = _("notification")
        verbose_name_plural = _("notifications")
        ordering = ["-created_at"]

    def __str__(self):
        return f"{self.channel}: {self.subject or self.body[:40]}"
