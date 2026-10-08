from django.contrib import admin

from .models import ConsentTemplate, PatientConsent, Prescription, ToothState, TreatmentPlan, TreatmentPlanLine, VisitNote


class LineInline(admin.TabularInline):
    model = TreatmentPlanLine
    extra = 0
    raw_id_fields = ["appointment"]


@admin.register(TreatmentPlan)
class TreatmentPlanAdmin(admin.ModelAdmin):
    list_display = ["patient", "dentist", "title", "status", "clinic"]
    list_filter = ["clinic", "status"]
    raw_id_fields = ["patient"]
    inlines = [LineInline]


for model in (ToothState, VisitNote, Prescription, ConsentTemplate, PatientConsent):
    admin.site.register(model)
