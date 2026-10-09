from django.contrib import admin

from .models import LabCase, StageEvent


class StageEventInline(admin.TabularInline):
    model = StageEvent
    extra = 0


@admin.register(LabCase)
class LabCaseAdmin(admin.ModelAdmin):
    list_display = ["number", "patient", "restoration", "material", "stage", "due_date", "technician"]
    list_filter = ["stage", "restoration", "material"]
    search_fields = ["number", "patient__file_number", "patient__name_en", "patient__name_ar"]
    inlines = [StageEventInline]
