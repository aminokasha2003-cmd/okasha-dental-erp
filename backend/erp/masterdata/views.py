from django.db.models import ProtectedError
from rest_framework.exceptions import ValidationError

from erp.core.api import ClinicScopedViewSet

from .models import Branch, Chair, Procedure, ProcedureCategory, Room, StaffMember, WorkingHours
from .serializers import (
    BranchSerializer,
    ChairSerializer,
    ProcedureCategorySerializer,
    ProcedureSerializer,
    RoomSerializer,
    StaffMemberSerializer,
    WorkingHoursSerializer,
)


class ProtectedDeleteMixin:
    def perform_destroy(self, instance):
        try:
            instance.delete()
        except ProtectedError as exc:
            raise ValidationError("Other records still use this one. Mark it inactive instead.") from exc


class FilterByParamsMixin:
    filter_params = ()

    def get_queryset(self):
        qs = super().get_queryset()
        for param in self.filter_params:
            value = self.request.query_params.get(param)
            if value not in (None, ""):
                if param in {"is_active", "needs_lab"}:
                    value = value.lower() in {"1", "true", "yes"}
                qs = qs.filter(**{param: value})
        return qs


# Clinic settings: branches, rooms, chairs and working hours. Changing them is a
# settings permission; anyone with master data view can read them (the calendar needs them).
class BranchViewSet(ProtectedDeleteMixin, FilterByParamsMixin, ClinicScopedViewSet):
    queryset = Branch.objects.all()
    serializer_class = BranchSerializer
    module = "settings"
    view_module = "masterdata"
    filter_params = ("is_active",)


class RoomViewSet(ProtectedDeleteMixin, FilterByParamsMixin, ClinicScopedViewSet):
    queryset = Room.objects.all()
    serializer_class = RoomSerializer
    module = "settings"
    view_module = "masterdata"
    filter_params = ("branch", "is_active")


class ChairViewSet(ProtectedDeleteMixin, FilterByParamsMixin, ClinicScopedViewSet):
    queryset = Chair.objects.all()
    serializer_class = ChairSerializer
    module = "settings"
    view_module = "masterdata"
    filter_params = ("branch", "is_active")


class WorkingHoursViewSet(FilterByParamsMixin, ClinicScopedViewSet):
    queryset = WorkingHours.objects.all()
    serializer_class = WorkingHoursSerializer
    module = "settings"
    view_module = "masterdata"
    filter_params = ("branch",)


# Master data: staff directory and procedure catalog.
class StaffMemberViewSet(ProtectedDeleteMixin, FilterByParamsMixin, ClinicScopedViewSet):
    queryset = StaffMember.objects.prefetch_related("branches")
    serializer_class = StaffMemberSerializer
    module = "masterdata"
    filter_params = ("staff_type", "is_active")


class ProcedureCategoryViewSet(ProtectedDeleteMixin, ClinicScopedViewSet):
    queryset = ProcedureCategory.objects.all()
    serializer_class = ProcedureCategorySerializer
    module = "masterdata"


class ProcedureViewSet(ProtectedDeleteMixin, FilterByParamsMixin, ClinicScopedViewSet):
    queryset = Procedure.objects.select_related("category")
    serializer_class = ProcedureSerializer
    module = "masterdata"
    filter_params = ("category", "needs_lab", "is_active")

    def get_queryset(self):
        qs = super().get_queryset()
        search = self.request.query_params.get("search", "").strip()
        if search:
            from django.db.models import Q

            qs = qs.filter(Q(code__icontains=search) | Q(name_en__icontains=search) | Q(name_ar__icontains=search))
        return qs
