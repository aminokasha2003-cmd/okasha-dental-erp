from django.db import transaction
from django.utils import timezone
from rest_framework import serializers
from rest_framework.decorators import action
from rest_framework.exceptions import ValidationError
from rest_framework.response import Response

from erp.core.api import ClinicScopedViewSet, require_clinic

from .defaults import ensure_starter_consents
from .models import ConsentTemplate, PatientConsent, Prescription, ToothState, TreatmentPlan, TreatmentPlanLine, VisitNote
from .serializers import (
    ConsentTemplateSerializer,
    PatientConsentSerializer,
    PrescriptionSerializer,
    ToothStateSerializer,
    TreatmentPlanLineSerializer,
    TreatmentPlanSerializer,
    VisitNoteSerializer,
)


class PatientFilterMixin:
    """?patient=<id> limits a list to one patient."""

    def get_queryset(self):
        qs = super().get_queryset()
        patient = self.request.query_params.get("patient")
        if patient:
            qs = qs.filter(**{self.patient_field: patient})
        return qs

    patient_field = "patient"


class ToothStateViewSet(PatientFilterMixin, ClinicScopedViewSet):
    """The dental chart. Teeth with no record are sound."""

    queryset = ToothState.objects.all()
    serializer_class = ToothStateSerializer
    module = "clinical"
    pagination_class = None
    http_method_names = ["get", "post", "head", "options"]
    required_actions = {"save_tooth": "edit"}

    def create(self, request, *args, **kwargs):
        return self.save_tooth(request)

    @action(detail=False, methods=["post"], url_path="save")
    def save_tooth(self, request):
        """Create or replace one tooth's record (patient + tooth)."""
        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data
        with transaction.atomic():
            tooth, _created = ToothState.objects.select_for_update().get_or_create(
                clinic=require_clinic(request.user), patient=data["patient"], tooth=data["tooth"]
            )
            for field in ("missing", "crown", "implant", "root_canal_treated", "surfaces", "note"):
                if field in data:
                    setattr(tooth, field, data[field])
            tooth.save()
        return Response(self.get_serializer(tooth).data)


class TreatmentPlanViewSet(PatientFilterMixin, ClinicScopedViewSet):
    queryset = TreatmentPlan.objects.select_related("dentist", "patient").prefetch_related("lines__procedure", "lines__appointment")
    serializer_class = TreatmentPlanSerializer
    module = "clinical"
    pagination_class = None
    required_actions = {"set_status": "edit"}

    def get_queryset(self):
        qs = super().get_queryset()
        if self.request.query_params.get("status"):
            qs = qs.filter(status__in=self.request.query_params["status"].split(","))
        return qs

    def perform_destroy(self, instance):
        if instance.lines.filter(status__in=("in_progress", "done")).exists():
            raise ValidationError("Work on this plan has started. Cancel it instead of deleting it.")
        instance.delete()

    @action(detail=True, methods=["post"], url_path="status")
    def set_status(self, request, pk=None):
        """accept (the patient agreed), cancel, or reopen a cancelled plan as proposed."""
        plan = self.get_object()
        new = request.data.get("status")
        allowed = {"accepted": ("proposed",), "cancelled": ("proposed", "accepted", "in_progress"), "proposed": ("cancelled", "accepted")}
        if new not in allowed or plan.status not in allowed[new]:
            raise ValidationError({"status": f"A {plan.status} plan cannot become {new}."})
        plan.status = new
        plan.accepted_at = timezone.now() if new == "accepted" else (None if new == "proposed" else plan.accepted_at)
        plan.save()
        if new == "accepted":
            plan.refresh_status()
        if new == "cancelled":
            plan.lines.filter(status="planned").update(status="cancelled")
        return Response(self.get_serializer(TreatmentPlan.objects.get(pk=plan.pk)).data)


class TreatmentPlanLineViewSet(ClinicScopedViewSet):
    queryset = TreatmentPlanLine.objects.select_related("procedure", "plan", "appointment")
    serializer_class = TreatmentPlanLineSerializer
    module = "clinical"
    pagination_class = None

    def get_queryset(self):
        qs = super().get_queryset()
        params = self.request.query_params
        if params.get("plan"):
            qs = qs.filter(plan=params["plan"])
        if params.get("patient"):
            qs = qs.filter(plan__patient=params["patient"])
        if params.get("status"):
            qs = qs.filter(status__in=params["status"].split(","))
        return qs

    def perform_create(self, serializer):
        line = serializer.save(clinic=require_clinic(self.request.user))
        line.plan.refresh_status()

    def perform_update(self, serializer):
        before = serializer.instance.status
        line = serializer.save()
        if line.status != before:
            line.completed_at = timezone.now() if line.status == "done" else None
            line.save(update_fields=["completed_at", "updated_at"])
            line.plan.refresh_status()

    def perform_destroy(self, instance):
        if instance.status in ("in_progress", "done"):
            raise ValidationError("Work on this line has started. Mark it cancelled instead.")
        plan = instance.plan
        instance.delete()
        plan.refresh_status()


class VisitNoteViewSet(PatientFilterMixin, ClinicScopedViewSet):
    queryset = VisitNote.objects.select_related("dentist", "signed_by", "patient").prefetch_related("lines")
    serializer_class = VisitNoteSerializer
    module = "clinical"
    pagination_class = None
    required_actions = {"sign": "approve"}

    def get_queryset(self):
        qs = super().get_queryset()
        if self.request.query_params.get("unsigned"):
            qs = qs.filter(signed_at__isnull=True)
        return qs

    def perform_destroy(self, instance):
        if instance.signed_at:
            raise ValidationError("A signed note cannot be deleted.")
        instance.delete()

    @action(detail=True, methods=["post"])
    def sign(self, request, pk=None):
        """Lock the note under the signing dentist's name."""
        note = self.get_object()
        if note.signed_at:
            raise ValidationError("This note is already signed.")
        note.signed_at = timezone.now()
        note.signed_by = request.user
        note.save(update_fields=["signed_at", "signed_by", "updated_at"])
        return Response(self.get_serializer(note).data)


class PrescriptionViewSet(PatientFilterMixin, ClinicScopedViewSet):
    queryset = Prescription.objects.select_related("dentist", "patient")
    serializer_class = PrescriptionSerializer
    module = "clinical"
    pagination_class = None


class ConsentTemplateViewSet(ClinicScopedViewSet):
    queryset = ConsentTemplate.objects.all()
    serializer_class = ConsentTemplateSerializer
    module = "clinical"

    def get_queryset(self):
        ensure_starter_consents(require_clinic(self.request.user))
        qs = super().get_queryset()
        if self.request.query_params.get("is_active"):
            qs = qs.filter(is_active=True)
        return qs

    def perform_destroy(self, instance):
        # Forms already given to patients keep their own copy of the text.
        instance.is_active = False
        instance.save(update_fields=["is_active", "updated_at"])


class SignSerializer(serializers.Serializer):
    signer_name = serializers.CharField(max_length=200)
    signer_relation = serializers.CharField(max_length=100, required=False, allow_blank=True)
    signature = serializers.CharField(max_length=400_000)

    def validate_signature(self, value):
        if not value.startswith("data:image/png;base64,"):
            raise serializers.ValidationError("Sign in the box first.")
        return value


class PatientConsentViewSet(PatientFilterMixin, ClinicScopedViewSet):
    queryset = PatientConsent.objects.select_related("patient")
    serializer_class = PatientConsentSerializer
    module = "clinical"
    pagination_class = None
    required_actions = {"sign": "edit"}

    def perform_destroy(self, instance):
        if instance.signed_at:
            raise ValidationError("A signed consent cannot be deleted.")
        instance.delete()

    @action(detail=True, methods=["post"])
    def sign(self, request, pk=None):
        consent = self.get_object()
        if consent.signed_at:
            raise ValidationError("This form is already signed.")
        data = SignSerializer(data=request.data)
        data.is_valid(raise_exception=True)
        for field, value in data.validated_data.items():
            setattr(consent, field, value)
        consent.signed_at = timezone.now()
        consent.save()
        return Response(self.get_serializer(consent).data)
