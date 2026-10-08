from django.contrib import admin

from .models import MedicalAlert, MedicalHistory, Patient


class MedicalAlertInline(admin.TabularInline):
    model = MedicalAlert
    extra = 0
    fields = ["kind", "text", "is_active"]


@admin.register(Patient)
class PatientAdmin(admin.ModelAdmin):
    list_display = ["file_number", "name_ar", "name_en", "phone", "clinic", "is_active"]
    list_filter = ["clinic", "is_active"]
    search_fields = ["file_number", "name_ar", "name_en", "phone"]
    inlines = [MedicalAlertInline]


admin.site.register(MedicalHistory)
