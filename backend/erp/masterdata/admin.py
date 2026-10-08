from django.contrib import admin

from .models import Branch, Chair, Procedure, ProcedureCategory, Room, StaffMember, WorkingHours

for model in (Branch, Room, Chair, WorkingHours, StaffMember, ProcedureCategory):
    admin.site.register(model)


@admin.register(Procedure)
class ProcedureAdmin(admin.ModelAdmin):
    list_display = ["code", "name_en", "name_ar", "category", "default_price", "default_duration_minutes", "needs_lab"]
    list_filter = ["clinic", "category", "needs_lab", "is_active"]
    search_fields = ["code", "name_en", "name_ar"]
