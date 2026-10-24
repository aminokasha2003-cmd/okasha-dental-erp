from django.utils import timezone
from rest_framework import serializers

from erp.core.api import ClinicScopedSerializer

from . import services
from .models import Campaign, CampaignRecipient, Feedback, Lead, LeadActivity, RecallContact, RecallRule


def named(obj):
    return {"id": obj.pk, "ar": obj.name_ar, "en": obj.name_en} if obj is not None else None


def money(value):
    return f"{value:.2f}"


class LeadActivitySerializer(ClinicScopedSerializer):
    author = serializers.SerializerMethodField()

    class Meta:
        model = LeadActivity
        fields = ["id", "lead", "kind", "text", "stage_from", "stage_to", "author", "created_at"]
        read_only_fields = ["id", "stage_from", "stage_to", "author", "created_at"]

    def get_author(self, obj):
        u = obj.created_by
        return (u.get_full_name() or u.username) if u else ""

    def validate_kind(self, value):
        if value == "stage":
            raise serializers.ValidationError("Stage changes are recorded by moving the lead.")
        return value


class LeadSerializer(ClinicScopedSerializer):
    interest_info = serializers.SerializerMethodField()
    assigned_info = serializers.SerializerMethodField()
    patient_info = serializers.SerializerMethodField()
    last_activity = serializers.SerializerMethodField()
    follow_up_due = serializers.SerializerMethodField()
    allow_duplicate = serializers.BooleanField(write_only=True, required=False, default=False)

    class Meta:
        model = Lead
        fields = [
            "id", "name_ar", "name_en", "phone", "gender", "language", "whatsapp_opt_in", "source", "referred_by",
            "interest", "interest_info", "interest_text", "estimated_value", "assigned_to", "assigned_info", "branch",
            "stage", "stage_changed_at", "lost_reason", "next_follow_up", "follow_up_due", "notes",
            "patient", "patient_info", "converted_at", "consultation", "campaign", "last_activity",
            "allow_duplicate", "created_at",
        ]
        read_only_fields = ["id", "stage", "stage_changed_at", "lost_reason", "patient", "converted_at", "consultation", "created_at"]

    def get_interest_info(self, obj):
        p = obj.interest
        return {"id": p.pk, "code": p.code, "ar": p.name_ar, "en": p.name_en, "price": money(p.default_price)} if p else None

    def get_assigned_info(self, obj):
        return named(obj.assigned_to)

    def get_patient_info(self, obj):
        p = obj.patient
        return {"id": p.pk, "file_number": p.file_number, "ar": p.name_ar, "en": p.name_en} if p else None

    def get_last_activity(self, obj):
        acts = getattr(obj, "recent_activities", None)
        a = acts[0] if acts else obj.activities.first()
        return {"kind": a.kind, "text": a.text, "at": a.created_at} if a else None

    def get_follow_up_due(self, obj):
        return bool(obj.next_follow_up and obj.is_open and obj.next_follow_up <= timezone.localdate())

    def validate(self, attrs):
        allow = attrs.pop("allow_duplicate", False)
        name_ar = attrs.get("name_ar", getattr(self.instance, "name_ar", ""))
        name_en = attrs.get("name_en", getattr(self.instance, "name_en", ""))
        if not (name_ar or "").strip() and not (name_en or "").strip():
            raise serializers.ValidationError({"name_ar": "Enter the name in Arabic or English."})
        phone = attrs.get("phone")
        if phone is not None and len(services.phone_key(phone)) < 8:
            raise serializers.ValidationError({"phone": "Enter a mobile number."})
        changed_phone = phone is not None and (self.instance is None or services.phone_key(phone) != services.phone_key(self.instance.phone))
        if changed_phone and not allow:
            request = self.context["request"]
            found = services.duplicates(request.user.clinic, phone, exclude_lead=getattr(self.instance, "pk", None))
            open_leads = [x for x in found["leads"] if x["stage"] in Lead.OPEN_STAGES]
            if found["patients"] or open_leads:
                raise serializers.ValidationError({
                    "phone": "This number already belongs to a patient or an open lead.",
                    "duplicates": found,
                })
        return attrs


class RecallRuleSerializer(ClinicScopedSerializer):
    procedure_info = serializers.SerializerMethodField()

    class Meta:
        model = RecallRule
        fields = ["id", "name_en", "name_ar", "kind", "procedures", "procedure_info", "interval_months", "is_active", "sort_order"]
        read_only_fields = ["id"]

    def get_procedure_info(self, obj):
        return [{"id": p.pk, "code": p.code, "ar": p.name_ar, "en": p.name_en} for p in obj.procedures.all()]

    def validate_interval_months(self, value):
        if not 1 <= value <= 36:
            raise serializers.ValidationError("Between 1 and 36 months.")
        return value

    def validate(self, attrs):
        kind = attrs.get("kind", getattr(self.instance, "kind", "checkup"))
        procs = attrs.get("procedures")
        if procs is None and self.instance is not None:
            procs = list(self.instance.procedures.all())
        if kind == "after_procedure" and not procs:
            raise serializers.ValidationError({"procedures": "Choose the procedures this recall follows."})
        return attrs


class RecallContactSerializer(ClinicScopedSerializer):
    author = serializers.SerializerMethodField()

    class Meta:
        model = RecallContact
        fields = ["id", "patient", "rule", "due_date", "channel", "outcome", "note", "snooze_until", "author", "created_at"]
        read_only_fields = ["id", "author", "created_at"]

    def get_author(self, obj):
        u = obj.created_by
        return (u.get_full_name() or u.username) if u else ""

    def validate(self, attrs):
        if attrs.get("outcome") == "call_later" and not attrs.get("snooze_until"):
            raise serializers.ValidationError({"snooze_until": "When should we call again?"})
        snooze = attrs.get("snooze_until")
        if snooze and snooze <= timezone.localdate():
            raise serializers.ValidationError({"snooze_until": "Choose a day after today."})
        return attrs


class CampaignSerializer(ClinicScopedSerializer):
    results = serializers.SerializerMethodField()
    author = serializers.SerializerMethodField()

    class Meta:
        model = Campaign
        fields = ["id", "name", "channel", "message_en", "message_ar", "filters", "offer_date", "status", "cost", "sent_at",
                  "results", "author", "created_at"]
        read_only_fields = ["id", "status", "sent_at", "results", "author", "created_at"]

    def get_author(self, obj):
        u = obj.created_by
        return (u.get_full_name() or u.username) if u else ""

    def get_results(self, obj):
        if obj.status != "sent":
            return None
        data = services.campaign_results(obj)
        data.pop("per_recipient")
        return data

    def validate_filters(self, value):
        if not isinstance(value, dict):
            raise serializers.ValidationError("Filters must be an object.")
        return value

    def validate(self, attrs):
        if self.instance is not None and self.instance.status == "sent":
            changing = set(attrs) - {"cost", "name"}
            if changing:
                raise serializers.ValidationError("A sent campaign can only have its name and cost changed.")
        en = attrs.get("message_en", getattr(self.instance, "message_en", ""))
        ar = attrs.get("message_ar", getattr(self.instance, "message_ar", ""))
        if not (en or "").strip() and not (ar or "").strip():
            raise serializers.ValidationError({"message_ar": "Write the message in Arabic, English or both."})
        return attrs


class CampaignRecipientSerializer(serializers.ModelSerializer):
    person = serializers.SerializerMethodField()

    class Meta:
        model = CampaignRecipient
        fields = ["id", "person", "phone", "language", "body", "status", "error", "sent_at", "responded_at"]

    def get_person(self, obj):
        if obj.patient_id:
            p = obj.patient
            return {"kind": "patient", "id": p.pk, "file_number": p.file_number, "ar": p.name_ar, "en": p.name_en}
        x = obj.lead
        return {"kind": "lead", "id": x.pk, "file_number": "", "ar": x.name_ar, "en": x.name_en, "patient": x.patient_id}


class FeedbackSerializer(ClinicScopedSerializer):
    patient_info = serializers.SerializerMethodField()
    dentist_info = serializers.SerializerMethodField()
    visit_date = serializers.SerializerMethodField()

    class Meta:
        model = Feedback
        fields = ["id", "patient", "patient_info", "appointment", "visit_date", "dentist", "dentist_info", "score", "comment",
                  "source", "token", "answered_at", "created_at"]
        read_only_fields = ["id", "source", "token", "answered_at", "created_at", "dentist"]

    def get_patient_info(self, obj):
        p = obj.patient
        return {"id": p.pk, "file_number": p.file_number, "ar": p.name_ar, "en": p.name_en}

    def get_dentist_info(self, obj):
        return named(obj.dentist)

    def get_visit_date(self, obj):
        return timezone.localtime(obj.appointment.start).date() if obj.appointment_id and obj.appointment else None

    def validate_score(self, value):
        if value is not None and not 1 <= value <= 5:
            raise serializers.ValidationError("Score from 1 to 5.")
        return value

    def validate(self, attrs):
        appt = attrs.get("appointment")
        patient = attrs.get("patient")
        if appt is not None and patient is not None and appt.patient_id != patient.pk:
            raise serializers.ValidationError({"appointment": "That visit belongs to another patient."})
        if appt is not None and appt.status != "completed":
            raise serializers.ValidationError({"appointment": "Feedback is for finished visits."})
        return attrs
