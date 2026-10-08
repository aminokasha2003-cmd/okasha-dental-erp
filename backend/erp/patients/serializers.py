from datetime import date

from rest_framework import serializers

from erp.core.api import ClinicScopedSerializer

from .models import MedicalAlert, MedicalHistory, Patient, PatientNote


class MedicalAlertSerializer(ClinicScopedSerializer):
    class Meta:
        model = MedicalAlert
        fields = ["id", "patient", "kind", "text", "guidance", "is_active", "created_at"]
        read_only_fields = ["id", "created_at"]


class PatientSerializer(ClinicScopedSerializer):
    alerts = serializers.SerializerMethodField()
    age = serializers.SerializerMethodField()

    class Meta:
        model = Patient
        fields = [
            "id",
            "file_number",
            "name_ar",
            "name_en",
            "gender",
            "date_of_birth",
            "age",
            "phone",
            "phone_alt",
            "whatsapp_opt_in",
            "language",
            "email",
            "national_id",
            "address",
            "occupation",
            "referral_source",
            "home_branch",
            "preferred_dentist",
            "notes",
            "emergency_contact_name",
            "emergency_contact_phone",
            "insurance",
            "is_active",
            "alerts",
            "created_at",
        ]
        read_only_fields = ["id", "file_number", "age", "alerts", "created_at"]

    def get_alerts(self, obj):
        # Everyone who can open the patient sees the active alerts, reception included.
        return [{"id": a.id, "kind": a.kind, "text": a.text, "guidance": a.guidance} for a in obj.alerts.all() if a.is_active]

    def get_age(self, obj):
        born = obj.date_of_birth
        if not born:
            return None
        today = date.today()
        return today.year - born.year - ((today.month, today.day) < (born.month, born.day))

    def validate_date_of_birth(self, value):
        if value and value > date.today():
            raise serializers.ValidationError("The date of birth is in the future.")
        return value

    def validate(self, attrs):
        name_ar = attrs.get("name_ar", getattr(self.instance, "name_ar", ""))
        name_en = attrs.get("name_en", getattr(self.instance, "name_en", ""))
        if not (name_ar or "").strip() and not (name_en or "").strip():
            raise serializers.ValidationError({"name_ar": "Enter the patient's name in Arabic or English."})
        dentist = attrs.get("preferred_dentist")
        if dentist is not None and dentist.staff_type != "dentist":
            raise serializers.ValidationError({"preferred_dentist": "Choose a dentist."})
        return attrs


class MedicalHistorySerializer(ClinicScopedSerializer):
    class Meta:
        model = MedicalHistory
        fields = [
            "diabetes",
            "hypertension",
            "heart_disease",
            "bleeding_disorder",
            "blood_thinners",
            "asthma",
            "epilepsy",
            "hepatitis",
            "kidney_disease",
            "pregnant",
            "smoker",
            "allergies",
            "medications",
            "past_surgeries",
            "anaesthesia_reactions",
            "notes",
            "updated_at",
        ]
        read_only_fields = ["updated_at"]


class PatientNoteSerializer(ClinicScopedSerializer):
    author = serializers.SerializerMethodField()

    class Meta:
        model = PatientNote
        fields = ["id", "patient", "text", "author", "created_at"]
        read_only_fields = ["id", "author", "created_at"]

    def get_author(self, obj):
        user = obj.created_by
        if user is None:
            return ""
        return user.get_full_name() or user.username
