from django.contrib import admin

from .models import Appointment


@admin.register(Appointment)
class AppointmentAdmin(admin.ModelAdmin):
    list_display = ["start", "patient", "dentist", "chair", "status", "clinic"]
    list_filter = ["clinic", "status", "branch"]
    date_hierarchy = "start"
    raw_id_fields = ["patient"]
