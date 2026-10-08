from rest_framework.decorators import action
from rest_framework.exceptions import PermissionDenied
from rest_framework.response import Response

from erp.core.api import ClinicScopedViewSet

from .models import MedicalAlert, MedicalHistory, Patient, normalize_text
from .serializers import MedicalAlertSerializer, MedicalHistorySerializer, PatientSerializer


class PatientViewSet(ClinicScopedViewSet):
    queryset = Patient.objects.prefetch_related("alerts")
    serializer_class = PatientSerializer
    module = "patients"
    required_actions = {"medical_history": "view"}

    def get_queryset(self):
        qs = super().get_queryset()
        params = self.request.query_params
        # Every word typed must appear in the name, phone, file number or national ID.
        for word in normalize_text(params.get("search", "")).split():
            digits = word.lstrip("+")
            if digits.isdigit() and len(digits) >= 8:
                # A phone number: compare without Egypt's country code or the leading 0,
                # so "01012345678" and "+201012345678" find each other.
                if digits.startswith("20") and len(digits) >= 12:
                    digits = digits[2:]
                word = digits.lstrip("0") or digits
            qs = qs.filter(search_text__contains=word)
        if params.get("is_active", "") != "":
            qs = qs.filter(is_active=params["is_active"].lower() in {"1", "true", "yes"})
        for param in ("home_branch", "preferred_dentist"):
            if params.get(param):
                qs = qs.filter(**{param: params[param]})
        return qs

    def perform_destroy(self, instance):
        # A patient file is a medical record: closing it hides it, it is never erased.
        instance.is_active = False
        instance.save(update_fields=["is_active", "updated_at"])

    @action(detail=True, methods=["get", "put", "patch"], url_path="medical-history")
    def medical_history(self, request, pk=None):
        """The full questionnaire is clinical information, so it follows the clinical permission."""
        patient = self.get_object()
        needed = "view" if request.method == "GET" else "edit"
        if not request.user.has_module_perm("clinical", needed):
            raise PermissionDenied("Only clinical staff can see or change the medical history.")
        history = MedicalHistory.objects.filter(patient=patient).first()
        if request.method == "GET":
            data = MedicalHistorySerializer(history, context=self.get_serializer_context()).data if history else None
            return Response(data or {"exists": False})
        serializer = MedicalHistorySerializer(
            history, data=request.data, partial=request.method == "PATCH", context=self.get_serializer_context()
        )
        serializer.is_valid(raise_exception=True)
        serializer.save(patient=patient, clinic=patient.clinic)
        return Response(serializer.data)


class MedicalAlertViewSet(ClinicScopedViewSet):
    queryset = MedicalAlert.objects.select_related("patient")
    serializer_class = MedicalAlertSerializer
    module = "patients"

    def get_queryset(self):
        qs = super().get_queryset()
        if self.request.query_params.get("patient"):
            qs = qs.filter(patient=self.request.query_params["patient"])
        return qs
