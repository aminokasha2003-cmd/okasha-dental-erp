from django.apps import AppConfig


class ComplianceConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "erp.compliance"
    label = "compliance"
    verbose_name = "Compliance and integrations"

    def ready(self):
        from . import signals  # noqa: F401
