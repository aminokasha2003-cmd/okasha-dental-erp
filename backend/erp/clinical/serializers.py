from django.utils import timezone
from rest_framework import serializers

from erp.core.api import ClinicScopedSerializer

from .models import (
    SURFACE_STATES,
    SURFACES,
    ConsentTemplate,
    PatientConsent,
    Prescription,
    ToothState,
    TreatmentPlan,
    TreatmentPlanLine,
    VisitNote,
)


def staff_name(member):
    return {"ar": member.name_ar, "en": member.name_en} if member else None


def default_dentist(serializer, attrs):
    """Fill in the signed-in dentist when no dentist was chosen."""
    if attrs.get("dentist") is None and serializer.instance is None:
        request = serializer.context.get("request")
        member = getattr(getattr(request, "user", None), "staff_profile", None)
        if member is None or member.staff_type != "dentist":
            raise serializers.ValidationError({"dentist": "Choose a dentist."})
        attrs["dentist"] = member
    dentist = attrs.get("dentist")
    if dentist is not None and dentist.staff_type != "dentist":
        raise serializers.ValidationError({"dentist": "Choose a dentist."})
    return attrs


def patient_info(patient):
    return {"id": patient.pk, "ar": patient.name_ar, "en": patient.name_en, "file_number": patient.file_number}


def user_name(user):
    return (user.get_full_name() or user.username) if user else ""


class ToothStateSerializer(ClinicScopedSerializer):
    class Meta:
        model = ToothState
        fields = ["id", "patient", "tooth", "missing", "crown", "implant", "root_canal_treated", "surfaces", "note", "updated_at"]
        read_only_fields = ["id", "updated_at"]
        validators = []  # one row per tooth is handled by the upsert action

    def validate_surfaces(self, value):
        if not isinstance(value, dict):
            raise serializers.ValidationError("Give surfaces as {surface: state}.")
        cleaned = {}
        for surface, state in value.items():
            if surface not in SURFACES or state not in SURFACE_STATES:
                raise serializers.ValidationError(f"Unknown surface or state: {surface}={state}.")
            if state != "sound":
                cleaned[surface] = state
        return cleaned


class TreatmentPlanLineSerializer(ClinicScopedSerializer):
    procedure_code = serializers.CharField(source="procedure.code", read_only=True)
    procedure_name_en = serializers.CharField(source="procedure.name_en", read_only=True)
    procedure_name_ar = serializers.CharField(source="procedure.name_ar", read_only=True)
    needs_lab = serializers.BooleanField(source="procedure.needs_lab", read_only=True)
    net = serializers.DecimalField(max_digits=10, decimal_places=2, read_only=True)
    appointment_start = serializers.DateTimeField(source="appointment.start", read_only=True, default=None)
    surfaces = serializers.CharField(max_length=10, required=False, allow_blank=True)
    price = serializers.DecimalField(max_digits=10, decimal_places=2, required=False, min_value=0)
    discount = serializers.DecimalField(max_digits=10, decimal_places=2, required=False, min_value=0)

    class Meta:
        model = TreatmentPlanLine
        fields = [
            "id", "plan", "procedure", "procedure_code", "procedure_name_en", "procedure_name_ar", "needs_lab",
            "tooth", "surfaces", "price", "discount", "net", "status", "sort_order", "notes",
            "appointment", "appointment_start", "completed_at",
        ]
        read_only_fields = ["id", "completed_at"]

    def validate_surfaces(self, value):
        return "".join(ch for ch in "MDOBL" if ch in (value or "").upper())

    def validate(self, attrs):
        plan = attrs.get("plan", getattr(self.instance, "plan", None))
        procedure = attrs.get("procedure", getattr(self.instance, "procedure", None))
        if self.instance is None and "price" not in attrs and procedure is not None:
            attrs["price"] = procedure.default_price
        price = attrs.get("price", getattr(self.instance, "price", 0))
        discount = attrs.get("discount", getattr(self.instance, "discount", 0))
        if discount > price:
            raise serializers.ValidationError({"discount": "The discount is more than the price."})
        appointment = attrs.get("appointment")
        if appointment is not None and plan is not None and appointment.patient_id != plan.patient_id:
            raise serializers.ValidationError({"appointment": "That appointment is for another patient."})
        if plan is not None and plan.status in ("completed", "cancelled") and self.instance is None:
            raise serializers.ValidationError({"plan": "This plan is closed. Start a new plan."})
        return attrs


class TreatmentPlanSerializer(ClinicScopedSerializer):
    lines = TreatmentPlanLineSerializer(many=True, read_only=True)
    dentist_name = serializers.SerializerMethodField()
    patient_info = serializers.SerializerMethodField()
    totals = serializers.SerializerMethodField()

    class Meta:
        model = TreatmentPlan
        fields = [
            "id", "patient", "patient_info", "dentist", "dentist_name", "title", "status", "notes", "accepted_at", "lines", "totals",
            "created_at",
        ]
        read_only_fields = ["id", "status", "accepted_at", "created_at"]
        extra_kwargs = {"dentist": {"required": False}}

    def get_dentist_name(self, obj):
        return staff_name(obj.dentist)

    def get_patient_info(self, obj):
        return patient_info(obj.patient)

    def get_totals(self, obj):
        amounts = {"done": 0, "in_progress": 0, "planned": 0, "total": 0}
        count = done_count = 0
        for line in obj.lines.all():
            if line.status == "cancelled":
                continue
            amounts[line.status] += line.net
            amounts["total"] += line.net
            count += 1
            done_count += line.status == "done"
        return {**{k: f"{v:.2f}" for k, v in amounts.items()}, "count": count, "done_count": done_count}

    def validate(self, attrs):
        return default_dentist(self, attrs)


class VisitNoteSerializer(ClinicScopedSerializer):
    dentist_name = serializers.SerializerMethodField()
    patient_info = serializers.SerializerMethodField()
    signed_by_name = serializers.SerializerMethodField()
    completed_lines = serializers.PrimaryKeyRelatedField(
        many=True, write_only=True, required=False, queryset=TreatmentPlanLine.objects.all()
    )

    class Meta:
        model = VisitNote
        fields = [
            "id", "patient", "patient_info", "appointment", "dentist", "dentist_name", "visit_date", "complaint", "findings",
            "work_done", "next_step", "lines", "completed_lines", "signed_at", "signed_by_name", "created_at",
        ]
        read_only_fields = ["id", "signed_at", "created_at"]
        extra_kwargs = {"dentist": {"required": False}, "visit_date": {"required": False}}

    def get_dentist_name(self, obj):
        return staff_name(obj.dentist)

    def get_patient_info(self, obj):
        return patient_info(obj.patient)

    def get_signed_by_name(self, obj):
        return user_name(obj.signed_by)

    def validate(self, attrs):
        if self.instance is not None and self.instance.signed_at:
            raise serializers.ValidationError("This note is signed and cannot be changed. Add a new note instead.")
        patient = attrs.get("patient", getattr(self.instance, "patient", None))
        appointment = attrs.get("appointment")
        if appointment is not None and appointment.patient_id != patient.pk:
            raise serializers.ValidationError({"appointment": "That appointment is for another patient."})
        for line in list(attrs.get("lines", [])) + list(attrs.get("completed_lines", [])):
            if line.plan.patient_id != patient.pk:
                raise serializers.ValidationError({"lines": "A plan line belongs to another patient."})
        if self.instance is None:
            attrs.setdefault("visit_date", timezone.localdate())
        return default_dentist(self, attrs)

    def _complete(self, note, lines):
        now = timezone.now()
        plans = set()
        for line in lines:
            note.lines.add(line)
            if line.status != "done":
                line.status = "done"
                line.completed_at = now
                line.save(update_fields=["status", "completed_at", "updated_at"])
            plans.add(line.plan)
        for plan in plans:
            if plan.status == "proposed":
                plan.status = "accepted"
                plan.accepted_at = now
                plan.save(update_fields=["status", "accepted_at", "updated_at"])
            plan.refresh_status()

    def create(self, validated):
        completed = validated.pop("completed_lines", [])
        note = super().create(validated)
        self._complete(note, completed)
        return note

    def update(self, instance, validated):
        completed = validated.pop("completed_lines", [])
        note = super().update(instance, validated)
        self._complete(note, completed)
        return note


class PrescriptionSerializer(ClinicScopedSerializer):
    dentist_name = serializers.SerializerMethodField()

    class Meta:
        model = Prescription
        fields = ["id", "patient", "dentist", "dentist_name", "visit_note", "items", "notes", "created_at"]
        read_only_fields = ["id", "created_at"]
        extra_kwargs = {"dentist": {"required": False}}

    def get_dentist_name(self, obj):
        return staff_name(obj.dentist)

    def validate_items(self, value):
        if not isinstance(value, list) or not value:
            raise serializers.ValidationError("Add at least one medicine.")
        keys = ("drug", "dose", "frequency", "duration", "notes")
        cleaned = []
        for item in value:
            if not isinstance(item, dict) or not str(item.get("drug", "")).strip():
                raise serializers.ValidationError("Each medicine needs a name.")
            cleaned.append({k: str(item.get(k, "")).strip()[:200] for k in keys})
        return cleaned

    def validate(self, attrs):
        return default_dentist(self, attrs)


class ConsentTemplateSerializer(ClinicScopedSerializer):
    class Meta:
        model = ConsentTemplate
        fields = ["id", "title_en", "title_ar", "body_en", "body_ar", "is_active"]


class PatientConsentSerializer(ClinicScopedSerializer):
    class Meta:
        model = PatientConsent
        fields = [
            "id", "patient", "template", "plan_line", "language", "title", "body", "signer_name", "signer_relation",
            "signature", "signed_at", "created_at",
        ]
        read_only_fields = ["id", "signer_name", "signer_relation", "signature", "signed_at", "created_at"]
        extra_kwargs = {"title": {"required": False}, "body": {"required": False}}

    def validate(self, attrs):
        if self.instance is not None and self.instance.signed_at:
            raise serializers.ValidationError("A signed consent cannot be changed.")
        template = attrs.get("template")
        language = attrs.get("language", getattr(self.instance, "language", "ar"))
        if template is not None and self.instance is None:
            attrs.setdefault("title", template.title_ar if language == "ar" else template.title_en)
            attrs.setdefault("body", template.body_ar if language == "ar" else template.body_en)
        if not attrs.get("title", getattr(self.instance, "title", "")) or not attrs.get("body", getattr(self.instance, "body", "")):
            raise serializers.ValidationError("Choose a form or write its title and text.")
        line = attrs.get("plan_line")
        patient = attrs.get("patient", getattr(self.instance, "patient", None))
        if line is not None and line.plan.patient_id != patient.pk:
            raise serializers.ValidationError({"plan_line": "That plan line belongs to another patient."})
        return attrs
