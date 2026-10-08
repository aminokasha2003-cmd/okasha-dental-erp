from django.conf import settings
from django.db import models
from django.utils.translation import gettext_lazy as _

from erp.core.models import ClinicScopedModel


class Branch(ClinicScopedModel):
    name_en = models.CharField(_("name (English)"), max_length=150)
    name_ar = models.CharField(_("name (Arabic)"), max_length=150)
    phone = models.CharField(_("phone"), max_length=30, blank=True)
    address_en = models.TextField(_("address (English)"), blank=True)
    address_ar = models.TextField(_("address (Arabic)"), blank=True)
    is_active = models.BooleanField(_("active"), default=True)

    class Meta:
        verbose_name = _("branch")
        verbose_name_plural = _("branches")
        ordering = ["id"]

    def __str__(self):
        return self.name_en


class Room(ClinicScopedModel):
    branch = models.ForeignKey(Branch, on_delete=models.PROTECT, related_name="rooms")
    name_en = models.CharField(_("name (English)"), max_length=100)
    name_ar = models.CharField(_("name (Arabic)"), max_length=100)
    is_active = models.BooleanField(_("active"), default=True)

    class Meta:
        verbose_name = _("room")
        verbose_name_plural = _("rooms")
        ordering = ["branch_id", "id"]

    def __str__(self):
        return self.name_en


class Chair(ClinicScopedModel):
    branch = models.ForeignKey(Branch, on_delete=models.PROTECT, related_name="chairs")
    room = models.ForeignKey(Room, null=True, blank=True, on_delete=models.SET_NULL, related_name="chairs")
    name_en = models.CharField(_("name (English)"), max_length=100)
    name_ar = models.CharField(_("name (Arabic)"), max_length=100)
    is_active = models.BooleanField(_("active"), default=True)
    sort_order = models.PositiveSmallIntegerField(_("order"), default=0)

    class Meta:
        verbose_name = _("chair")
        verbose_name_plural = _("chairs")
        ordering = ["branch_id", "sort_order", "id"]

    def __str__(self):
        return self.name_en


class WorkingHours(ClinicScopedModel):
    WEEKDAYS = [
        (0, _("Monday")),
        (1, _("Tuesday")),
        (2, _("Wednesday")),
        (3, _("Thursday")),
        (4, _("Friday")),
        (5, _("Saturday")),
        (6, _("Sunday")),
    ]

    branch = models.ForeignKey(Branch, on_delete=models.CASCADE, related_name="working_hours")
    weekday = models.PositiveSmallIntegerField(_("day"), choices=WEEKDAYS)
    is_closed = models.BooleanField(_("closed"), default=False)
    opens_at = models.TimeField(_("opens at"), null=True, blank=True)
    closes_at = models.TimeField(_("closes at"), null=True, blank=True)

    class Meta:
        verbose_name = _("working hours")
        verbose_name_plural = _("working hours")
        ordering = ["branch_id", "weekday"]
        constraints = [models.UniqueConstraint(fields=["branch", "weekday"], name="unique_hours_per_branch_day")]

    def __str__(self):
        return f"{self.branch} {self.get_weekday_display()}"


class StaffMember(ClinicScopedModel):
    TYPES = [
        ("dentist", _("Dentist")),
        ("assistant", _("Dental assistant")),
        ("technician", _("Lab technician")),
        ("reception", _("Receptionist")),
        ("accountant", _("Accountant")),
        ("other", _("Other")),
    ]
    COMMISSION_TYPES = [
        ("none", _("No commission")),
        ("percent_collected", _("Percent of amount collected")),
        ("percent_billed", _("Percent of amount billed")),
        ("fixed_per_procedure", _("Fixed amount per procedure")),
    ]

    user = models.OneToOneField(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="staff_profile"
    )
    name_en = models.CharField(_("name (English)"), max_length=150)
    name_ar = models.CharField(_("name (Arabic)"), max_length=150)
    staff_type = models.CharField(_("type"), max_length=20, choices=TYPES)
    phone = models.CharField(_("phone"), max_length=30, blank=True)
    branches = models.ManyToManyField(Branch, blank=True, related_name="staff", verbose_name=_("branches"))
    commission_type = models.CharField(_("commission rule"), max_length=30, choices=COMMISSION_TYPES, default="none")
    commission_value = models.DecimalField(_("commission value"), max_digits=10, decimal_places=2, default=0)
    color = models.CharField(_("calendar color"), max_length=7, blank=True)
    is_active = models.BooleanField(_("active"), default=True)

    class Meta:
        verbose_name = _("staff member")
        verbose_name_plural = _("staff")
        ordering = ["name_en"]

    def __str__(self):
        return self.name_en


class ProcedureCategory(ClinicScopedModel):
    name_en = models.CharField(_("name (English)"), max_length=100)
    name_ar = models.CharField(_("name (Arabic)"), max_length=100)
    sort_order = models.PositiveSmallIntegerField(_("order"), default=0)

    class Meta:
        verbose_name = _("procedure category")
        verbose_name_plural = _("procedure categories")
        ordering = ["sort_order", "id"]

    def __str__(self):
        return self.name_en


class Procedure(ClinicScopedModel):
    code = models.CharField(_("code"), max_length=20)
    name_en = models.CharField(_("name (English)"), max_length=200)
    name_ar = models.CharField(_("name (Arabic)"), max_length=200)
    category = models.ForeignKey(ProcedureCategory, on_delete=models.PROTECT, related_name="procedures")
    default_price = models.DecimalField(_("default price"), max_digits=12, decimal_places=2, default=0)
    default_duration_minutes = models.PositiveSmallIntegerField(_("default duration (minutes)"), default=30)
    needs_lab = models.BooleanField(_("needs lab work"), default=False)
    is_active = models.BooleanField(_("active"), default=True)

    class Meta:
        verbose_name = _("procedure")
        verbose_name_plural = _("procedure catalog")
        ordering = ["category__sort_order", "code"]
        constraints = [models.UniqueConstraint(fields=["clinic", "code"], name="unique_procedure_code_per_clinic")]

    def __str__(self):
        return f"{self.code} {self.name_en}"
