from collections import defaultdict
from datetime import date

from django.db import transaction
from django.db.models import Q
from django.utils import timezone
from rest_framework.decorators import action
from rest_framework.exceptions import PermissionDenied, ValidationError
from rest_framework.response import Response
from rest_framework.views import APIView

from erp.clinical.models import TreatmentPlanLine
from erp.core.api import ClinicScopedViewSet, ModulePermission, require_clinic
from erp.core.notifications import notify

from .models import ZERO, LabCase, StageEvent
from .serializers import LabCaseSerializer, RemakeSerializer, StageMoveSerializer, guess_from_procedure, money

OPEN = Q(cancelled_at__isnull=True) & ~Q(stage="delivered")


def parse_day(value, field):
    try:
        return date.fromisoformat(value) if value else None
    except ValueError as exc:
        raise ValidationError({field: "Use a date like 2026-10-09."}) from exc


def describe(case):
    tooth = f", tooth {case.plan_line.tooth}" if case.plan_line.tooth else ""
    return f"{case.get_restoration_display()}{tooth}"


class LabCaseViewSet(ClinicScopedViewSet):
    queryset = LabCase.objects.select_related(
        "patient", "plan_line__procedure", "plan_line__plan", "dentist", "technician", "appointment", "remake_of"
    ).prefetch_related("events__created_by", "remakes")
    serializer_class = LabCaseSerializer
    module = "lab"
    http_method_names = ["get", "post", "patch", "head", "options"]
    required_actions = {"stage": "edit", "remake": "create", "cancel": "delete", "orderable": "view"}

    def get_queryset(self):
        qs = super().get_queryset()
        p = self.request.query_params
        if p.get("patient"):
            qs = qs.filter(patient=p["patient"])
        if p.get("stage"):
            qs = qs.filter(stage=p["stage"])
        if p.get("open"):
            qs = qs.filter(OPEN)
        if p.get("closed"):
            qs = qs.exclude(OPEN).order_by("-updated_at")
        if p.get("technician") == "me":
            staff = getattr(self.request.user, "staff_profile", None)
            qs = qs.filter(technician=staff) if staff else qs.none()
        elif p.get("technician") == "none":
            qs = qs.filter(technician__isnull=True)
        elif p.get("technician"):
            qs = qs.filter(technician=p["technician"])
        if p.get("overdue"):
            qs = qs.filter(OPEN, due_date__lt=timezone.localdate()).exclude(stage="ready")
        if p.get("search"):
            term = p["search"].strip()
            qs = qs.filter(
                Q(number__icontains=term)
                | Q(patient__search_text__icontains=term.lower())
                | Q(patient__file_number__iexact=term)
                | Q(shade__iexact=term)
            )
        return qs

    def perform_create(self, serializer):
        clinic = require_clinic(self.request.user)
        line = serializer.validated_data["plan_line"]
        dentist = serializer.validated_data.get("dentist") or line.plan.dentist
        with transaction.atomic():
            case = serializer.save(clinic=clinic, patient=line.plan.patient, dentist=dentist)
            StageEvent.objects.create(clinic=clinic, case=case, stage=case.stage)

    @action(detail=False, methods=["get"])
    def orderable(self, request):
        """The patient's plan lines a lab case can be ordered from, lab procedures first."""
        clinic = require_clinic(request.user)
        patient = request.query_params.get("patient")
        if not patient:
            raise ValidationError({"patient": "Give a patient."})
        lines = (
            TreatmentPlanLine.objects.filter(clinic=clinic, plan__patient=patient)
            .exclude(status="cancelled")
            .select_related("procedure", "plan__dentist", "appointment")
        )
        busy = set(LabCase.objects.filter(OPEN, clinic=clinic, plan_line__in=lines).values_list("plan_line_id", flat=True))
        rows = []
        for line in lines:
            restoration, material = guess_from_procedure(line.procedure)
            rows.append(
                {
                    "id": line.pk,
                    "procedure_name_en": line.procedure.name_en,
                    "procedure_name_ar": line.procedure.name_ar,
                    "needs_lab": line.procedure.needs_lab,
                    "tooth": line.tooth,
                    "status": line.status,
                    "dentist": line.plan.dentist_id,
                    "appointment": line.appointment_id,
                    "appointment_start": line.appointment.start if line.appointment else None,
                    "has_open_case": line.pk in busy,
                    "restoration": restoration,
                    "material": material,
                }
            )
        rows.sort(key=lambda r: (r["has_open_case"], not r["needs_lab"], r["id"]))
        return Response(rows)

    @action(detail=True, methods=["post"])
    def stage(self, request, pk=None):
        case = self.get_object()
        if case.cancelled_at is not None:
            raise ValidationError("This case is cancelled.")
        if case.stage == "delivered":
            raise ValidationError("This case is already delivered.")
        data = StageMoveSerializer(data=request.data)
        data.is_valid(raise_exception=True)
        new = data.validated_data["stage"]
        if new == case.stage:
            raise ValidationError({"stage": "The case is already at that stage."})
        with transaction.atomic():
            case.stage = new
            fields = ["stage", "updated_at"]
            if new == "delivered":
                case.delivered_at = timezone.now()
                fields.append("delivered_at")
            case.save(update_fields=fields)
            StageEvent.objects.create(clinic=case.clinic, case=case, stage=new, note=data.validated_data.get("note", ""))
        if new == "ready" and case.dentist.user_id:
            notify(
                case.clinic,
                "in_app",
                f"{case.number} is ready for try-in: {describe(case)} for {case.patient.name_en or case.patient.name_ar}.",
                user=case.dentist.user,
                subject="Lab case ready",
            )
        return Response(self.get_serializer(self.get_queryset().get(pk=case.pk)).data)

    @action(detail=True, methods=["post"])
    def remake(self, request, pk=None):
        original = self.get_object()
        if original.cancelled_at is not None:
            raise ValidationError("A cancelled case cannot be remade.")
        if original.stage not in ("ready", "delivered"):
            raise ValidationError("Only finished work can be remade. Move the case back a stage instead.")
        if original.remakes.filter(cancelled_at__isnull=True).exclude(stage="delivered").exists():
            raise ValidationError("This case already has a remake in the lab.")
        data = RemakeSerializer(data=request.data)
        data.is_valid(raise_exception=True)
        v = data.validated_data
        with transaction.atomic():
            if original.stage != "delivered":
                # The first piece never reaches the patient, so it is closed here.
                original.cancelled_at = timezone.now()
                original.cancel_reason = f"Remade ({dict(LabCase.REMAKE_REASONS)[v['reason']]})"
                original.save(update_fields=["cancelled_at", "cancel_reason", "updated_at"])
            copy = LabCase.objects.create(
                clinic=original.clinic,
                patient=original.patient,
                plan_line=original.plan_line,
                dentist=original.dentist,
                technician=original.technician,
                restoration=original.restoration,
                material=original.material,
                shade=original.shade,
                teeth=original.teeth,
                units=original.units,
                instructions=original.instructions,
                due_date=v["due_date"],
                appointment=original.appointment,
                remake_of=original,
                remake_reason=v["reason"],
                remake_note=v.get("note", ""),
                remake_charged_to=v["charged_to"],
            )
            StageEvent.objects.create(clinic=copy.clinic, case=copy, stage="received", note=v.get("note", ""))
        return Response(self.get_serializer(self.get_queryset().get(pk=copy.pk)).data, status=201)

    @action(detail=True, methods=["post"])
    def cancel(self, request, pk=None):
        case = self.get_object()
        if not case.is_open:
            raise ValidationError("Only an open case can be cancelled.")
        reason = str(request.data.get("reason", "")).strip()
        if not reason:
            raise ValidationError({"reason": "Say why the case is cancelled."})
        case.cancelled_at = timezone.now()
        case.cancel_reason = reason[:255]
        case.save(update_fields=["cancelled_at", "cancel_reason", "updated_at"])
        return Response(self.get_serializer(case).data)


class LabSummaryView(APIView):
    """Counts for the lab board header and the sidebar badge."""

    permission_classes = [ModulePermission]
    module = "lab"

    def get(self, request):
        clinic = require_clinic(request.user)
        today = timezone.localdate()
        open_cases = LabCase.objects.filter(OPEN, clinic=clinic)
        by_stage = {code: 0 for code in LabCase.STAGE_ORDER[:-1]}
        for stage in open_cases.values_list("stage", flat=True):
            by_stage[stage] += 1
        staff = getattr(request.user, "staff_profile", None)
        return Response(
            {
                "by_stage": by_stage,
                "open": open_cases.count(),
                "overdue": open_cases.filter(due_date__lt=today).exclude(stage="ready").count(),
                "due_today": open_cases.filter(due_date=today).exclude(stage="ready").count(),
                "unassigned": open_cases.filter(technician__isnull=True).count(),
                "mine": open_cases.filter(technician=staff).count() if staff else 0,
                # What needs this user: cases they work on, or cases they ordered that are ready.
                "attention": (
                    open_cases.filter(Q(technician=staff) & ~Q(stage="ready") | Q(dentist=staff, stage="ready")).count()
                    if staff
                    else open_cases.filter(technician__isnull=True).count()
                ),
            }
        )


class LabCostReportView(APIView):
    """Cost per unit by restoration and material for work delivered in a period, with remakes."""

    permission_classes = [ModulePermission]
    module = "lab"

    def get(self, request):
        if not request.user.has_module_perm("lab", "approve"):
            raise PermissionDenied("Your role does not allow this.")
        clinic = require_clinic(request.user)
        today = timezone.localdate()
        start = parse_day(request.query_params.get("start"), "start") or today.replace(day=1)
        end = parse_day(request.query_params.get("end"), "end") or today
        delivered = LabCase.objects.filter(
            clinic=clinic, delivered_at__date__gte=start, delivered_at__date__lte=end
        ).prefetch_related("events")
        # A first piece that was remade before delivery never reaches the patient, but its cost is real.
        scrapped = LabCase.objects.filter(
            clinic=clinic, delivered_at__isnull=True, remakes__isnull=False,
            cancelled_at__date__gte=start, cancelled_at__date__lte=end,
        ).distinct()
        groups = defaultdict(lambda: {"cases": 0, "units": 0, "cost": ZERO, "remakes": 0, "scrap": ZERO})
        for case in delivered:
            g = groups[(case.restoration, case.material)]
            g["cases"] += 1
            g["units"] += case.units
            g["cost"] += case.cost_total
            g["remakes"] += 1 if case.remake_of_id else 0
        for case in scrapped:
            groups[(case.restoration, case.material)]["scrap"] += case.cost_total
        labels_r = dict(LabCase.RESTORATIONS)
        labels_m = dict(LabCase.MATERIALS)
        rows = [
            {
                "restoration": restoration,
                "restoration_label": str(labels_r[restoration]),
                "material": material,
                "material_label": str(labels_m[material]),
                "cases": g["cases"],
                "units": g["units"],
                "cost": money(g["cost"]),
                "cost_per_unit": money(g["cost"] / g["units"]) if g["units"] else money(ZERO),
                "remakes": g["remakes"],
                "scrap_cost": money(g["scrap"]),
            }
            for (restoration, material), g in sorted(groups.items())
        ]
        count = len(delivered)
        remakes = sum(1 for c in delivered if c.remake_of_id)
        return Response(
            {
                "start": start,
                "end": end,
                "rows": rows,
                "delivered": count,
                "remakes": remakes,
                "remake_rate": round(remakes * 100 / count, 1) if count else 0,
                "on_time": on_time(delivered),
            }
        )


def on_time(cases):
    """Share of delivered cases that were ready for try-in by their due date."""
    total = good = 0
    for case in cases:
        ready = next((e.created_at for e in case.events.all() if e.stage in ("ready", "delivered")), None)
        if ready is None:
            continue
        total += 1
        good += timezone.localtime(ready).date() <= case.due_date
    return round(good * 100 / total) if total else None
