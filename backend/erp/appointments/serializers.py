from datetime import timedelta

from django.utils import timezone
from rest_framework import serializers

from erp.core.api import ClinicScopedSerializer
from erp.masterdata.models import WorkingHours

from .models import Appointment


def clashes(appointment_id, *, chair, dentist, start, end):
    """Active appointments that overlap this time on the same chair or with the same dentist."""
    qs = Appointment.objects.filter(status__in=Appointment.ACTIVE, start__lt=end, end__gt=start)
    if appointment_id:
        qs = qs.exclude(pk=appointment_id)
    found = {}
    if chair is not None:
        other = qs.filter(chair=chair).select_related("patient").first()
        if other:
            found["chair"] = f"This chair is booked from {timezone.localtime(other.start):%H:%M} to {timezone.localtime(other.end):%H:%M}."
    other = qs.filter(dentist=dentist).select_related("patient").first()
    if other:
        found["dentist"] = (
            f"This dentist has another patient from {timezone.localtime(other.start):%H:%M} to {timezone.localtime(other.end):%H:%M}."
        )
    return found


def outside_hours(branch, start, end):
    """Return a message if the visit falls outside the branch's working hours, else None."""
    local_start, local_end = timezone.localtime(start), timezone.localtime(end)
    hours = WorkingHours.objects.filter(branch=branch, weekday=local_start.weekday()).first()
    if hours is None:
        return None  # hours not set up for this day: do not block booking
    if hours.is_closed:
        return "The branch is closed on this day."
    if local_end.date() != local_start.date() or local_start.time() < hours.opens_at or local_end.time() > hours.closes_at:
        return f"The branch is open from {hours.opens_at:%H:%M} to {hours.closes_at:%H:%M} on this day."
    return None


class AppointmentSerializer(ClinicScopedSerializer):
    patient_name = serializers.SerializerMethodField()
    patient_file_number = serializers.CharField(source="patient.file_number", read_only=True)
    patient_phone = serializers.CharField(source="patient.phone", read_only=True)
    patient_alerts = serializers.SerializerMethodField()
    dentist_name_ar = serializers.CharField(source="dentist.name_ar", read_only=True)
    dentist_name_en = serializers.CharField(source="dentist.name_en", read_only=True)
    dentist_color = serializers.CharField(source="dentist.color", read_only=True)
    procedure_name_ar = serializers.CharField(source="procedure.name_ar", read_only=True, default="")
    procedure_name_en = serializers.CharField(source="procedure.name_en", read_only=True, default="")
    duration_minutes = serializers.IntegerField(min_value=5, max_value=600, required=False)
    allow_outside_hours = serializers.BooleanField(write_only=True, required=False, default=False)

    class Meta:
        model = Appointment
        fields = [
            "id",
            "patient",
            "patient_name",
            "patient_file_number",
            "patient_phone",
            "patient_alerts",
            "dentist",
            "dentist_name_ar",
            "dentist_name_en",
            "dentist_color",
            "branch",
            "chair",
            "procedure",
            "procedure_name_ar",
            "procedure_name_en",
            "start",
            "duration_minutes",
            "end",
            "status",
            "reason",
            "notes",
            "cancel_reason",
            "arrived_at",
            "seated_at",
            "completed_at",
            "reminder_sent_at",
            "allow_outside_hours",
        ]
        # Status changes go through the status action so the steps stay in order.
        read_only_fields = [
            "id", "end", "status", "cancel_reason", "arrived_at", "seated_at", "completed_at", "reminder_sent_at",
        ]

    def get_patient_name(self, obj):
        return {"ar": obj.patient.name_ar, "en": obj.patient.name_en}

    def get_patient_alerts(self, obj):
        return [a.text for a in obj.patient.alerts.all() if a.is_active]

    def validate(self, attrs):
        allow_outside_hours = attrs.pop("allow_outside_hours", False)
        current = lambda name: attrs.get(name, getattr(self.instance, name, None))  # noqa: E731
        patient, dentist, branch, chair = current("patient"), current("dentist"), current("branch"), current("chair")
        procedure, start = current("procedure"), current("start")
        duration = attrs.get("duration_minutes")
        if duration is None:
            duration = self.instance.duration_minutes if self.instance else (
                procedure.default_duration_minutes if procedure and procedure.default_duration_minutes else 30
            )
            attrs["duration_minutes"] = duration

        if patient is not None and not patient.is_active:
            raise serializers.ValidationError({"patient": "This patient's file is closed."})
        if dentist.staff_type != "dentist" or not dentist.is_active:
            raise serializers.ValidationError({"dentist": "Choose an active dentist."})
        if dentist.branches.exists() and not dentist.branches.filter(pk=branch.pk).exists():
            raise serializers.ValidationError({"dentist": "This dentist does not work at this branch."})
        if chair is not None and chair.branch_id != branch.pk:
            raise serializers.ValidationError({"chair": "This chair is in a different branch."})

        status = getattr(self.instance, "status", "booked")
        if status in Appointment.ACTIVE:
            end = start + timedelta(minutes=duration)
            found = clashes(getattr(self.instance, "pk", None), chair=chair, dentist=dentist, start=start, end=end)
            if found:
                raise serializers.ValidationError(found)
            moved = self.instance is None or any(k in attrs for k in ("start", "duration_minutes", "branch"))
            if moved and not allow_outside_hours:
                message = outside_hours(branch, start, end)
                if message:
                    raise serializers.ValidationError({"start": message, "code": "outside_hours"})
        return attrs
