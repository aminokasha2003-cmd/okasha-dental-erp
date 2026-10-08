from django.apps import AppConfig
from django.utils.translation import gettext_lazy as _


class PatientsConfig(AppConfig):
    name = "erp.patients"
    label = "patients"
    verbose_name = _("Patients")
