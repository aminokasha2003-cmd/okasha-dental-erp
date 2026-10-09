from django.apps import AppConfig


class BillingConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "erp.billing"
    label = "billing"
    verbose_name = "Billing"
