from decimal import Decimal

from django.utils import timezone
from rest_framework import serializers

from erp.core.api import ClinicScopedSerializer

from .models import LabCase, StageEvent


def money(value):
    return f"{Decimal(value):.2f}"


def staff_name(member):
    return {"id": member.pk, "ar": member.name_ar, "en": member.name_en} if member else None


def patient_info(patient):
    # Lab technicians are kept out of patient contact details, so no phone here.
    return {"id": patient.pk, "ar": patient.name_ar, "en": patient.name_en, "file_number": patient.file_number}


def guess_from_procedure(procedure):
    """Starting restoration and material for a new case, read from the procedure name."""
    name = f"{procedure.name_en} {procedure.code}".lower()
    restoration = "crown"
    for word, code in (
        ("bridge", "bridge"),
        ("veneer", "veneer"),
        ("inlay", "inlay_onlay"),
        ("onlay", "inlay_onlay"),
        ("post", "post_core"),
        ("night guard", "night_guard"),
        ("partial denture", "denture_partial"),
        ("denture", "denture_full"),
        ("temporary", "temporary"),
        ("implant", "implant_crown"),
    ):
        if word in name:
            restoration = code
            break
    material = "zirconia"
    for word, code in (
        ("e.max", "emax"),
        ("emax", "emax"),
        ("lithium", "emax"),
        ("porcelain fused", "pfm"),
        ("pfm", "pfm"),
        ("metal", "metal"),
        ("pmma", "pmma"),
        ("composite", "composite"),
        ("acrylic", "acrylic"),
        ("denture", "acrylic"),
        ("night guard", "acrylic"),
        ("temporary", "pmma"),
    ):
        if word in name:
            material = code
            break
    return restoration, material


class StageEventSerializer(serializers.ModelSerializer):
    by = serializers.SerializerMethodField()

    class Meta:
        model = StageEvent
        fields = ["id", "stage", "note", "created_at", "by"]

    def get_by(self, obj):
        user = obj.created_by
        return (user.get_full_name() or user.username) if user else ""


class LabCaseSerializer(ClinicScopedSerializer):
    patient_info = serializers.SerializerMethodField()
    procedure = serializers.SerializerMethodField()
    dentist_name = serializers.SerializerMethodField()
    technician_name = serializers.SerializerMethodField()
    appointment_start = serializers.DateTimeField(source="appointment.start", read_only=True, default=None)
    events = StageEventSerializer(many=True, read_only=True)
    cost_total = serializers.SerializerMethodField()
    cost_per_unit = serializers.SerializerMethodField()
    is_open = serializers.ReadOnlyField()
    overdue = serializers.SerializerMethodField()
    remake_of_number = serializers.CharField(source="remake_of.number", read_only=True, default=None)
    remake_numbers = serializers.SerializerMethodField()
    material_cost = serializers.DecimalField(max_digits=10, decimal_places=2, required=False, min_value=0)
    labour_cost = serializers.DecimalField(max_digits=10, decimal_places=2, required=False, min_value=0)
    units = serializers.IntegerField(required=False, min_value=1, max_value=32)

    class Meta:
        model = LabCase
        fields = [
            "id", "number", "patient", "patient_info", "plan_line", "procedure", "dentist", "dentist_name",
            "technician", "technician_name", "restoration", "material", "shade", "teeth", "units", "instructions",
            "due_date", "appointment", "appointment_start", "stage", "events", "is_open", "overdue",
            "delivered_at", "cancelled_at", "cancel_reason", "remake_of", "remake_of_number", "remake_numbers",
            "remake_reason", "remake_note", "remake_charged_to", "material_cost", "labour_cost", "cost_total",
            "cost_per_unit", "created_at", "priority", "pan_number", "on_hold", "hold_reason", "shade_guide",
            "stump_shade", "cervical_shade", "incisal_shade", "margin", "contacts", "occlusion", "pontic",
            "implant_system", "implant_platform", "abutment", "retention", "enclosures", "outsourced_to",
            "outsource_tracking",
        ]
        read_only_fields = [
            "id", "number", "stage", "delivered_at", "cancelled_at", "cancel_reason", "remake_of",
            "remake_reason", "remake_note", "remake_charged_to", "created_at",
        ]
        extra_kwargs = {"dentist": {"required": False}, "patient": {"required": False}}

    def validate_enclosures(self, value):
        allowed = {code for code, _label in LabCase.ENCLOSURES}
        if not isinstance(value, list) or any(v not in allowed for v in value):
            raise serializers.ValidationError("Unknown item in the enclosures list.")
        return sorted(set(value))

    def get_patient_info(self, obj):
        return patient_info(obj.patient)

    def get_procedure(self, obj):
        line = obj.plan_line
        if line is None:
            return None
        return {"en": line.procedure.name_en, "ar": line.procedure.name_ar, "tooth": line.tooth, "status": line.status}

    def get_dentist_name(self, obj):
        return staff_name(obj.dentist)

    def get_technician_name(self, obj):
        return staff_name(obj.technician)

    def get_cost_total(self, obj):
        return money(obj.cost_total)

    def get_cost_per_unit(self, obj):
        return money(obj.cost_per_unit)

    def get_overdue(self, obj):
        return obj.is_open and obj.stage != "ready" and obj.due_date < timezone.localdate()

    def get_remake_numbers(self, obj):
        return [r.number for r in obj.remakes.all()]

    def validate_technician(self, value):
        if value is not None and value.staff_type not in ("technician", "dentist"):
            raise serializers.ValidationError("Choose a lab technician.")
        return value

    def validate_dentist(self, value):
        if value.staff_type != "dentist":
            raise serializers.ValidationError("Choose a dentist.")
        return value

    def validate(self, attrs):
        instance = self.instance
        line = attrs.get("plan_line", getattr(instance, "plan_line", None))
        if instance is not None:
            if instance.cancelled_at is not None:
                raise serializers.ValidationError("This case is cancelled.")
            if "plan_line" in attrs and attrs["plan_line"] != instance.plan_line:
                raise serializers.ValidationError({"plan_line": "A case stays with the plan line it was ordered from."})
            if "dentist" in attrs and attrs["dentist"] != instance.dentist:
                raise serializers.ValidationError({"dentist": "The ordering dentist cannot be changed."})
            if "patient" in attrs and attrs["patient"] != instance.patient:
                raise serializers.ValidationError({"patient": "A case stays with its patient."})
            patient = instance.patient
        else:
            if line is None and attrs.get("patient") is None:
                raise serializers.ValidationError({"patient": "Choose the patient, or the plan line this work is for."})
            if line is not None:
                if attrs.get("patient") is not None and attrs["patient"] != line.plan.patient:
                    raise serializers.ValidationError({"plan_line": "That plan line belongs to another patient."})
                if line.status == "cancelled":
                    raise serializers.ValidationError({"plan_line": "That plan line is cancelled."})
                if line.lab_cases.filter(cancelled_at__isnull=True).exclude(stage="delivered").exists():
                    raise serializers.ValidationError({"plan_line": "This plan line already has an open lab case."})
            elif attrs.get("dentist") is None:
                raise serializers.ValidationError({"dentist": "Choose the dentist ordering this work."})
            patient = line.plan.patient if line is not None else attrs["patient"]
        appointment = attrs.get("appointment")
        if appointment is not None and appointment.patient_id != patient.pk:
            raise serializers.ValidationError({"appointment": "That visit belongs to another patient."})
        if attrs.get("on_hold") and not attrs.get("hold_reason", getattr(instance, "hold_reason", "")):
            raise serializers.ValidationError({"hold_reason": "Say what the case is waiting for."})
        return attrs


class StageMoveSerializer(serializers.Serializer):
    stage = serializers.ChoiceField(choices=LabCase.STAGES)
    note = serializers.CharField(max_length=255, required=False, allow_blank=True)


class RemakeSerializer(serializers.Serializer):
    reason = serializers.ChoiceField(choices=LabCase.REMAKE_REASONS)
    note = serializers.CharField(max_length=255, required=False, allow_blank=True)
    charged_to = serializers.ChoiceField(choices=LabCase.CHARGED_TO)
    due_date = serializers.DateField()
