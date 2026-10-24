from collections import defaultdict
from datetime import date
from decimal import Decimal

from django.db import transaction
from django.db.models import Count, Q
from django.shortcuts import get_object_or_404
from django.utils import timezone
from django.utils.dateparse import parse_datetime
from rest_framework import mixins, viewsets
from rest_framework.decorators import action
from rest_framework.exceptions import PermissionDenied, ValidationError
from rest_framework.response import Response
from rest_framework.views import APIView

from erp.appointments.models import Appointment
from erp.core.api import (
    AuditContextMixin,
    ClinicScopedViewSet,
    ModulePermission,
    require_clinic,
)
from erp.inventory.models import StockItem
from erp.masterdata.models import Branch, Chair, Procedure, StaffMember
from erp.patients.models import Patient

from . import services
from .models import (
    BookingRequest,
    BookingSettings,
    ComplianceSettings,
    DailyChecklist,
    EInvoiceDocument,
    EInvoiceSettings,
    Equipment,
    EtaBranchAddress,
    EtaItemCode,
    InstrumentPack,
    Licence,
    MaintenancePlan,
    MaintenanceRecord,
    PackLoad,
    SterilizationCycle,
    WorkOrder,
)
from .serializers import (
    BookingRequestSerializer,
    BookingSettingsSerializer,
    ChecklistSerializer,
    ComplianceSettingsSerializer,
    CycleDetailSerializer,
    CycleSerializer,
    EInvoiceDocumentSerializer,
    EInvoiceSettingsSerializer,
    EquipmentSerializer,
    InstrumentPackSerializer,
    LicenceSerializer,
    MaintenancePlanSerializer,
    MaintenanceRecordSerializer,
    WorkOrderSerializer,
    load_out,
    local_dt,
    money,
    named,
)

ZERO = Decimal("0")


def parse_day(value, field="date", default=None):
    try:
        return date.fromisoformat(value) if value else default
    except ValueError as exc:
        raise ValidationError({field: "Use a date like 2026-10-09."}) from exc


def require(user, module, act):
    if not user.has_module_perm(module, act):
        raise PermissionDenied("Your role does not allow this.")


def of_clinic(model, clinic, pk, field):
    obj = model.objects.filter(clinic=clinic, pk=pk).first() if pk not in (None, "") else None
    if obj is None:
        raise ValidationError({field: "Not found."})
    return obj


class ModuleView(AuditContextMixin, APIView):
    permission_classes = [ModulePermission]
    module = "compliance"


# ================================================================ overview


class SummaryView(AuditContextMixin, APIView):
    """Hero numbers and sidebar badges. Each part only for users who can see that area."""

    def get(self, request):
        return Response(services.summary_counts(require_clinic(request.user), request.user))


class SettingsView(ModuleView):
    def get(self, request):
        return Response(ComplianceSettingsSerializer(ComplianceSettings.for_clinic(require_clinic(request.user))).data)

    def patch(self, request):
        require(request.user, "compliance", "approve")
        obj = ComplianceSettings.for_clinic(require_clinic(request.user))
        ser = ComplianceSettingsSerializer(obj, data=request.data, partial=True)
        ser.is_valid(raise_exception=True)
        ser.save()
        return Response(ser.data)


class DashboardView(ModuleView):
    """Six months of sterilisation and maintenance, for charts and the PDF report."""

    def get(self, request):
        clinic = require_clinic(request.user)
        today = timezone.localdate()
        first = services.add_months(today.replace(day=1), -5)
        start, _ = services.day_bounds(first)
        cycles = SterilizationCycle.objects.filter(clinic=clinic, started_at__gte=start)
        months = [services.add_months(first, i) for i in range(6)]
        by_month = {m: {"month": m, "cycles": 0, "failed": 0, "packs": 0, "maintenance_cost": ZERO, "downtime": 0.0} for m in months}
        for c in cycles.annotate(n=Count("loads")).values("started_at", "result", "n"):
            m = timezone.localtime(c["started_at"]).date().replace(day=1)
            if m in by_month:
                by_month[m]["cycles"] += 1
                by_month[m]["failed"] += c["result"] == "fail"
                by_month[m]["packs"] += c["n"]
        for r in MaintenanceRecord.objects.filter(clinic=clinic, done_on__gte=first):
            m = r.done_on.replace(day=1)
            if m in by_month:
                by_month[m]["maintenance_cost"] += r.cost
        orders = WorkOrder.objects.filter(clinic=clinic, reported_at__gte=start).select_related("equipment")
        by_category = defaultdict(lambda: {"orders": 0, "downtime": 0.0})
        for o in orders:
            m = timezone.localtime(o.reported_at).date().replace(day=1)
            if m in by_month:
                by_month[m]["downtime"] += o.downtime_hours
            by_category[o.equipment.category]["orders"] += 1
            by_category[o.equipment.category]["downtime"] += o.downtime_hours
        machines = []
        for e in Equipment.objects.filter(clinic=clinic, category="autoclave").exclude(status="retired"):
            qs = cycles.filter(machine=e)
            machines.append({"id": e.pk, "name": named(e), "cycles": qs.count(), "failed": qs.filter(result="fail").count()})
        total = cycles.count()
        failed = cycles.filter(result="fail").count()
        due = services.plans_with_due(clinic, today)
        done_plans = MaintenanceRecord.objects.filter(clinic=clinic, done_on__gte=first, plan__isnull=False).count()
        overdue = sum(1 for _p, d in due if d["state"] == "overdue")
        return Response({
            "start": first, "end": today,
            "cycles": total, "failed": failed, "pass_rate": round(100 * (total - failed) / total, 1) if total else None,
            "packs": PackLoad.objects.filter(clinic=clinic, cycle__started_at__gte=start).count(),
            "packs_used": PackLoad.objects.filter(clinic=clinic, used_at__gte=start).count(),
            "bi_runs": cycles.filter(bi_used=True).count(),
            "maintenance_done": done_plans,
            "maintenance_overdue": overdue,
            "on_time_rate": round(100 * len([1 for _p, d in due if d["state"] != "overdue"]) / len(due), 1) if due else None,
            "maintenance_cost": money(sum((m["maintenance_cost"] for m in by_month.values()), ZERO)),
            "downtime_hours": round(sum(m["downtime"] for m in by_month.values()), 1),
            "work_orders": orders.count(),
            "months": [{**m, "maintenance_cost": money(m["maintenance_cost"]), "downtime": round(m["downtime"], 1)} for m in by_month.values()],
            "machines": machines,
            "by_category": sorted(({"category": k, **v} for k, v in by_category.items()), key=lambda r: -r["orders"]),
        })


# ================================================================ equipment


class EquipmentViewSet(ClinicScopedViewSet):
    queryset = Equipment.objects.select_related("branch", "chair", "supplier")
    serializer_class = EquipmentSerializer
    module = "compliance"
    pagination_class = None

    def get_queryset(self):
        qs = super().get_queryset()
        p = self.request.query_params
        for key in ("category", "branch", "status"):
            if p.get(key):
                qs = qs.filter(**{key: p[key]})
        if not p.get("status") and not p.get("all"):
            qs = qs.exclude(status="retired")
        if p.get("search"):
            qs = qs.filter(services.q_search(p["search"].strip(), "name_en", "name_ar", "code", "serial_number", "manufacturer", "model_name"))
        return qs

    def get_serializer_context(self):
        ctx = super().get_serializer_context()
        clinic = self.request.user.clinic
        if clinic is not None:
            ctx["cycle_counts"] = services.cycle_counts(clinic)
            ctx["open_orders"] = dict(
                WorkOrder.objects.filter(clinic=clinic, status__in=WorkOrder.OPEN).values_list("equipment").annotate(n=Count("id"))
            )
        return ctx

    def perform_destroy(self, instance):
        if instance.work_orders.exists() or instance.cycles.exists():
            raise ValidationError({"detail": "This equipment has history. Mark it retired instead."})
        instance.delete()


class PlanViewSet(ClinicScopedViewSet):
    queryset = MaintenancePlan.objects.select_related("equipment", "equipment__branch")
    serializer_class = MaintenancePlanSerializer
    module = "compliance"
    pagination_class = None
    required_actions = {"done": "edit"}

    def get_queryset(self):
        qs = super().get_queryset()
        p = self.request.query_params
        if p.get("equipment"):
            qs = qs.filter(equipment=p["equipment"])
        return qs

    def list(self, request, *args, **kwargs):
        clinic = require_clinic(request.user)
        pairs = services.plans_with_due(clinic, qs=self.get_queryset())
        state = request.query_params.get("state")
        if state == "attention":
            pairs = [x for x in pairs if x[1]["state"] != "ok"]
        elif state:
            pairs = [x for x in pairs if x[1]["state"] == state]
        order = {"overdue": 0, "due_soon": 1, "ok": 2}
        pairs.sort(key=lambda x: (order[x[1]["state"]], x[1]["due_date"] or date.max, x[1]["cycles_left"] or 0))
        ctx = {**self.get_serializer_context(), "due": {p.pk: d for p, d in pairs}}
        return Response(MaintenancePlanSerializer([p for p, _d in pairs], many=True, context=ctx).data)

    @action(detail=True, methods=["post"])
    def done(self, request, pk=None):
        plan = self.get_object()
        d = request.data
        record = services.complete_plan(
            plan, done_on=parse_day(d.get("done_on"), "done_on", timezone.localdate()), performed_by=d.get("performed_by", ""),
            cost=Decimal(str(d.get("cost") or 0)), notes=d.get("notes", ""), user=request.user,
        )
        return Response(MaintenanceRecordSerializer(record).data)


class RecordViewSet(AuditContextMixin, mixins.ListModelMixin, viewsets.GenericViewSet):
    permission_classes = [ModulePermission]
    module = "compliance"
    serializer_class = MaintenanceRecordSerializer

    def get_queryset(self):
        qs = MaintenanceRecord.objects.filter(clinic=require_clinic(self.request.user)).select_related("equipment", "plan", "work_order")
        if self.request.query_params.get("equipment"):
            qs = qs.filter(equipment=self.request.query_params["equipment"])
        return qs


class WorkOrderViewSet(ClinicScopedViewSet):
    queryset = WorkOrder.objects.select_related("equipment", "equipment__branch", "reported_by").prefetch_related("parts__item")
    serializer_class = WorkOrderSerializer
    module = "compliance"
    http_method_names = ["get", "post", "patch", "head", "options"]
    required_actions = {"parts": "edit", "close": "edit", "set_status": "edit"}

    def get_queryset(self):
        qs = super().get_queryset()
        p = self.request.query_params
        if p.get("open"):
            qs = qs.filter(status__in=WorkOrder.OPEN)
        if p.get("closed"):
            qs = qs.exclude(status__in=WorkOrder.OPEN)
        if p.get("equipment"):
            qs = qs.filter(equipment=p["equipment"])
        return qs

    def perform_create(self, serializer):
        data = dict(serializer.validated_data)
        equipment = data.pop("equipment")
        issue = data.pop("issue")
        serializer.instance = services.open_work_order(require_clinic(self.request.user), equipment, issue=issue, user=self.request.user, **data)

    @action(detail=True, methods=["post"], url_path="status")
    def set_status(self, request, pk=None):
        order = self.get_object()
        status = request.data.get("status")
        if status not in ("open", "in_progress", "waiting_parts"):
            raise ValidationError({"status": "Use close to finish or cancel a work order."})
        if order.status not in WorkOrder.OPEN:
            raise ValidationError({"status": "This work order is already closed."})
        order.status = status
        order.save(update_fields=["status", "updated_at"])
        return Response(WorkOrderSerializer(order, context=self.get_serializer_context()).data)

    @action(detail=True, methods=["post"])
    def parts(self, request, pk=None):
        order = self.get_object()
        clinic = require_clinic(request.user)
        require(request.user, "inventory", "view")
        item = of_clinic(StockItem, clinic, request.data.get("item"), "item")
        branch = of_clinic(Branch, clinic, request.data.get("branch") or order.equipment.branch_id, "branch")
        try:
            qty = Decimal(str(request.data.get("quantity") or "0"))
        except Exception as exc:  # noqa: BLE001
            raise ValidationError({"quantity": "Enter a number."}) from exc
        services.add_part(order, item, branch, qty, user=request.user)
        order.refresh_from_db()
        return Response(WorkOrderSerializer(order, context=self.get_serializer_context()).data)

    @action(detail=True, methods=["post"])
    def close(self, request, pk=None):
        order = self.get_object()
        status = request.data.get("status", "done")
        if status not in ("done", "cancelled"):
            raise ValidationError({"status": "Choose done or cancelled."})
        labour = request.data.get("labour_cost")
        services.close_work_order(
            order, status=status, resolution=request.data.get("resolution", ""),
            labour_cost=Decimal(str(labour)) if labour not in (None, "") else None, user=request.user,
        )
        return Response(WorkOrderSerializer(order, context=self.get_serializer_context()).data)


class LicenceViewSet(ClinicScopedViewSet):
    queryset = Licence.objects.select_related("equipment", "staff", "branch")
    serializer_class = LicenceSerializer
    module = "compliance"
    pagination_class = None
    required_actions = {"renew": "edit"}

    def get_serializer_context(self):
        ctx = super().get_serializer_context()
        if self.request.user.clinic_id:
            ctx["warn_days"] = ComplianceSettings.for_clinic(self.request.user.clinic).licence_warn_days
        return ctx

    @action(detail=True, methods=["post"])
    def renew(self, request, pk=None):
        lic = self.get_object()
        expires = parse_day(request.data.get("expires_on"), "expires_on")
        if expires is None or expires <= lic.expires_on:
            raise ValidationError({"expires_on": "Give the new expiry date, after the current one."})
        lic.issued_on = parse_day(request.data.get("issued_on"), "issued_on", timezone.localdate())
        lic.expires_on = expires
        if request.data.get("reference"):
            lic.reference = request.data["reference"]
        if request.data.get("last_reading_msv") not in (None, ""):
            lic.last_reading_msv = Decimal(str(request.data["last_reading_msv"]))
        lic.save()
        return Response(LicenceSerializer(lic, context=self.get_serializer_context()).data)


class ChairsDownView(AuditContextMixin, APIView):
    """Chairs whose equipment is out of service, for the calendar and home page."""

    def get(self, request):
        clinic = require_clinic(request.user)
        if not (request.user.has_module_perm("appointments", "view") or request.user.has_module_perm("compliance", "view")):
            raise PermissionDenied("Your role does not allow this.")
        rows = Equipment.objects.filter(clinic=clinic, status="out_of_service", chair__isnull=False).select_related("chair")
        out = []
        for e in rows:
            order = e.work_orders.filter(status__in=WorkOrder.OPEN).order_by("-reported_at").first()
            out.append({"chair": e.chair_id, "chair_name": named(e.chair), "equipment": named(e), "issue": order.issue if order else "", "since": local_dt(order.reported_at) if order else None})
        return Response(out)


# ================================================================ sterilisation


class PackViewSet(ClinicScopedViewSet):
    queryset = InstrumentPack.objects.select_related("branch")
    serializer_class = InstrumentPackSerializer
    module = "compliance"
    pagination_class = None
    required_actions = {"use": "create", "history": "view", "lookup": "view"}

    def get_queryset(self):
        qs = super().get_queryset()
        p = self.request.query_params
        if not p.get("all"):
            qs = qs.filter(is_active=True)
        if p.get("branch"):
            qs = qs.filter(Q(branch=p["branch"]) | Q(branch__isnull=True))
        if p.get("search"):
            qs = qs.filter(services.q_search(p["search"].strip(), "code", "name_en", "name_ar"))
        return qs

    def get_serializer_context(self):
        ctx = super().get_serializer_context()
        if self.request.user.clinic_id and self.action == "list":
            ctx["latest"] = services.latest_loads(self.request.user.clinic)
        return ctx

    def list(self, request, *args, **kwargs):
        rows = self.get_serializer(self.get_queryset(), many=True).data
        state = request.query_params.get("state")
        if state:
            rows = [r for r in rows if r["state"] == state]
        return Response(rows)

    @action(detail=False, methods=["get"])
    def lookup(self, request):
        clinic = require_clinic(request.user)
        code = (request.query_params.get("code") or "").strip().upper()
        pack = InstrumentPack.objects.filter(clinic=clinic, code=code).first()
        if pack is None:
            raise ValidationError({"code": f"No pack with code {code}."})
        return Response(self.get_serializer(pack).data)

    @action(detail=True, methods=["post"])
    def use(self, request, pk=None):
        clinic = require_clinic(request.user)
        pack = self.get_object()
        appt = of_clinic(Appointment, clinic, request.data.get("appointment"), "appointment") if request.data.get("appointment") else None
        patient = of_clinic(Patient, clinic, request.data.get("patient"), "patient") if request.data.get("patient") else None
        load = services.use_pack(clinic, pack, appointment=appt, patient=patient, user=request.user)
        return Response(load_out(load))

    @action(detail=True, methods=["get"])
    def history(self, request, pk=None):
        pack = self.get_object()
        loads = pack.loads.select_related("cycle", "cycle__machine", "patient", "appointment__dentist", "pack").order_by("-cycle__started_at")[:50]
        return Response([
            {**load_out(ld), "cycle": {"id": ld.cycle_id, "number": ld.cycle.cycle_number, "machine": named(ld.cycle.machine), "started_at": local_dt(ld.cycle.started_at), "result": ld.cycle.result}}
            for ld in loads
        ])


class CycleViewSet(ClinicScopedViewSet):
    queryset = SterilizationCycle.objects.select_related("machine", "operator")
    serializer_class = CycleSerializer
    module = "compliance"
    http_method_names = ["get", "post", "patch", "head", "options"]
    required_actions = {"bi": "edit", "affected": "view", "recall": "edit", "add_packs": "create"}

    def get_queryset(self):
        qs = super().get_queryset().annotate(n_packs=Count("loads", distinct=True), n_used=Count("loads", filter=Q(loads__used_at__isnull=False), distinct=True))
        p = self.request.query_params
        for key in ("machine", "result", "branch", "bi_result"):
            if p.get(key):
                qs = qs.filter(**{key: p[key]})
        if p.get("bi"):
            qs = qs.filter(bi_used=True)
        day_from = parse_day(p.get("date_from"), "date_from")
        day_to = parse_day(p.get("date_to"), "date_to")
        if day_from:
            qs = qs.filter(started_at__gte=services.day_bounds(day_from)[0])
        if day_to:
            qs = qs.filter(started_at__lt=services.day_bounds(day_to)[1])
        return qs.order_by("-started_at", "-id")

    def get_serializer_class(self):
        return CycleDetailSerializer if self.action == "retrieve" else CycleSerializer

    def perform_create(self, serializer):
        clinic = require_clinic(self.request.user)
        data = serializer.validated_data
        codes = data.pop("packs", [])
        machine = data["machine"]
        packs = self._packs(clinic, codes)
        with transaction.atomic():
            Equipment.objects.select_for_update().filter(pk=machine.pk).first()
            number = data.pop("cycle_number", None) or services.next_cycle_number(machine)
            if SterilizationCycle.objects.filter(machine=machine, cycle_number=number).exists():
                raise ValidationError({"cycle_number": f"Cycle {number} of this autoclave is already recorded."})
            if data.get("operator") is None:
                data["operator"] = StaffMember.objects.filter(clinic=clinic, user=self.request.user).first()
            cycle = serializer.save(clinic=clinic, cycle_number=number, branch=machine.branch, created_by=self.request.user)
            services.load_packs(cycle, packs)

    def perform_update(self, serializer):
        serializer.validated_data.pop("packs", None)
        serializer.save()

    @staticmethod
    def _packs(clinic, codes):
        packs = []
        for code in dict.fromkeys(str(c).strip().upper() for c in codes if str(c).strip()):
            pack = InstrumentPack.objects.filter(clinic=clinic, is_active=True).filter(Q(code=code) | Q(pk=int(code) if code.isdigit() else -1)).first()
            if pack is None:
                raise ValidationError({"packs": f"No active pack with code {code}."})
            packs.append(pack)
        return packs

    @action(detail=True, methods=["post"], url_path="packs")
    def add_packs(self, request, pk=None):
        cycle = self.get_object()
        if cycle.program in SterilizationCycle.TEST_PROGRAMS:
            raise ValidationError({"packs": "Test cycles run empty."})
        services.load_packs(cycle, self._packs(cycle.clinic, request.data.get("packs") or []))
        return Response(CycleDetailSerializer(self.get_queryset().get(pk=cycle.pk), context=self.get_serializer_context()).data)

    @action(detail=True, methods=["post"])
    def bi(self, request, pk=None):
        cycle = self.get_object()
        result = request.data.get("result")
        if not cycle.bi_used:
            raise ValidationError({"result": "No biological indicator was run with this cycle."})
        if result not in ("negative", "positive"):
            raise ValidationError({"result": "Choose negative (pass) or positive (fail)."})
        cycle.bi_result = result
        cycle.bi_read_at = timezone.now()
        cycle.save()
        return Response(CycleDetailSerializer(self.get_queryset().get(pk=cycle.pk), context=self.get_serializer_context()).data)

    @action(detail=True, methods=["get"])
    def affected(self, request, pk=None):
        cycle = self.get_object()
        found = services.affected_by_cycle(cycle)
        return Response({
            "cycle": CycleSerializer(cycle, context=self.get_serializer_context()).data,
            "patients": [{**load_out(ld), "cycle_number": ld.cycle.cycle_number} for ld in found["patients"]],
            "shelf": [load_out(ld) for ld in found["shelf"]],
        })

    @action(detail=True, methods=["post"])
    def recall(self, request, pk=None):
        cycle = self.get_object()
        load = get_object_or_404(services.suspect_loads(cycle), pk=request.data.get("load"))
        contacted = bool(request.data.get("contacted", True))
        load.recall_contacted_at = timezone.now() if contacted else None
        load.recall_note = (request.data.get("note") or "")[:255]
        load.save(update_fields=["recall_contacted_at", "recall_note", "updated_at"])
        return Response(load_out(load))


class PatientTraceView(ModuleView):
    """Which cycles sterilised the instruments used for this patient."""

    def get(self, request, patient_id):
        clinic = require_clinic(request.user)
        patient = of_clinic(Patient, clinic, patient_id, "patient")
        loads = services.patient_trace(clinic, patient)
        return Response([
            {
                **load_out(ld),
                "cycle": {
                    "id": ld.cycle_id, "number": ld.cycle.cycle_number, "machine": named(ld.cycle.machine), "program": ld.cycle.program,
                    "started_at": local_dt(ld.cycle.started_at), "result": ld.cycle.result, "operator": named(ld.cycle.operator),
                    "bi_result": ld.cycle.bi_result,
                },
            }
            for ld in loads
        ])


class BiStatusView(ModuleView):
    def get(self, request):
        clinic = require_clinic(request.user)
        return Response([
            {"machine": named(r["machine"]), "id": r["machine"].pk, "last_day": r["last_day"], "due": r["due"], "last_result": r["last"].bi_result if r["last"] else None}
            for r in services.bi_status(clinic)
        ])


class ChecklistViewSet(ClinicScopedViewSet):
    queryset = DailyChecklist.objects.select_related("done_by")
    serializer_class = ChecklistSerializer
    module = "compliance"
    http_method_names = ["get", "post", "patch", "head", "options"]

    def get_queryset(self):
        qs = super().get_queryset()
        if self.request.query_params.get("branch"):
            qs = qs.filter(branch=self.request.query_params["branch"])
        return qs

    def perform_create(self, serializer):
        clinic = require_clinic(self.request.user)
        data = serializer.validated_data
        existing = DailyChecklist.objects.filter(clinic=clinic, branch=data["branch"], date=data.get("date") or timezone.localdate()).first()
        if existing:
            raise ValidationError({"date": "Today's checklist for this branch is already saved; edit it instead."})
        if data.get("done_by") is None:
            data["done_by"] = StaffMember.objects.filter(clinic=clinic, user=self.request.user).first()
        serializer.save(clinic=clinic)


# ================================================================ e-invoicing


class EInvoiceView(AuditContextMixin, APIView):
    permission_classes = [ModulePermission]
    module = "einvoice"


def branch_addresses(clinic):
    rows = {a.branch_id: a for a in EtaBranchAddress.objects.filter(clinic=clinic)}
    out = []
    for b in Branch.objects.filter(clinic=clinic, is_active=True):
        a = rows.get(b.pk)
        out.append({
            "branch": b.pk, "branch_name": named(b),
            **{k: getattr(a, k, "") if a else "" for k in ("branch_code", "governate", "region_city", "street", "building_number", "postal_code")},
        })
        if not out[-1]["branch_code"]:
            out[-1]["branch_code"] = "0"
    return out


class EInvoiceSettingsView(EInvoiceView):
    def get(self, request):
        clinic = require_clinic(request.user)
        conf = EInvoiceSettings.for_clinic(clinic)
        return Response({**EInvoiceSettingsSerializer(conf).data, "branches": branch_addresses(clinic)})

    def patch(self, request):
        require(request.user, "einvoice", "approve")
        clinic = require_clinic(request.user)
        conf = EInvoiceSettings.for_clinic(clinic)
        ser = EInvoiceSettingsSerializer(conf, data=request.data, partial=True)
        ser.is_valid(raise_exception=True)
        with transaction.atomic():
            ser.save()
            for row in request.data.get("branches") or []:
                branch = of_clinic(Branch, clinic, row.get("branch"), "branches")
                addr, _ = EtaBranchAddress.objects.get_or_create(clinic=clinic, branch=branch)
                for k in ("branch_code", "governate", "region_city", "street", "building_number", "postal_code"):
                    if k in row:
                        setattr(addr, k, str(row[k] or "")[:200])
                addr.save()
        return Response({**EInvoiceSettingsSerializer(conf).data, "branches": branch_addresses(clinic)})


class ItemCodesView(EInvoiceView):
    def get(self, request):
        clinic = require_clinic(request.user)
        codes = {c.procedure_id: c for c in EtaItemCode.objects.filter(clinic=clinic)}
        out = []
        for p in Procedure.objects.filter(clinic=clinic).select_related("category").order_by("category__sort_order", "code"):
            c = codes.get(p.pk)
            out.append({
                "procedure": p.pk, "code": p.code, "name": named(p), "category": named(p.category), "active": p.is_active,
                "item_type": c.item_type if c else "", "item_code": c.item_code if c else "", "unit_type": c.unit_type if c else "EA",
            })
        return Response(out)

    def post(self, request):
        """Save codes: [{procedure, item_type, item_code, unit_type}]. An empty code removes the mapping.
        With {"generate": true}, fills EGS codes EG-<RIN>-<procedure code> for procedures without one."""
        require(request.user, "einvoice", "edit")
        clinic = require_clinic(request.user)
        if request.data.get("generate") if isinstance(request.data, dict) else False:
            conf = EInvoiceSettings.for_clinic(clinic)
            if not conf.rin:
                raise ValidationError({"rin": "Enter the clinic's RIN in the settings first."})
            have = set(EtaItemCode.objects.filter(clinic=clinic).values_list("procedure_id", flat=True))
            made = 0
            for p in Procedure.objects.filter(clinic=clinic).exclude(pk__in=have):
                EtaItemCode.objects.create(clinic=clinic, procedure=p, item_type="EGS", item_code=f"EG-{conf.rin}-{p.code}")
                made += 1
            return Response({"created": made})
        rows = request.data if isinstance(request.data, list) else request.data.get("rows", [])
        saved = 0
        with transaction.atomic():
            for row in rows:
                proc = of_clinic(Procedure, clinic, row.get("procedure"), "procedure")
                code = (row.get("item_code") or "").strip()
                if not code:
                    EtaItemCode.objects.filter(clinic=clinic, procedure=proc).delete()
                    continue
                kind = row.get("item_type") or "EGS"
                if kind not in ("EGS", "GS1"):
                    raise ValidationError({"item_type": "EGS or GS1."})
                EtaItemCode.objects.update_or_create(
                    clinic=clinic, procedure=proc, defaults={"item_type": kind, "item_code": code[:100], "unit_type": (row.get("unit_type") or "EA")[:10]}
                )
                saved += 1
        return Response({"saved": saved})


class DocumentViewSet(AuditContextMixin, viewsets.ReadOnlyModelViewSet):
    permission_classes = [ModulePermission]
    module = "einvoice"
    serializer_class = EInvoiceDocumentSerializer
    required_actions = {"rebuild": "edit", "send": "approve", "submit_ready": "approve", "refresh": "view", "cancel": "approve", "payload": "view", "months": "view", "prepare": "edit"}

    def get_queryset(self):
        clinic = require_clinic(self.request.user)
        qs = EInvoiceDocument.objects.filter(clinic=clinic).select_related("invoice", "invoice__patient", "invoice__branch")
        p = self.request.query_params
        if p.get("status"):
            statuses = p["status"].split(",")
            if "needs_cancel" in statuses:
                qs = qs.filter(status="valid", invoice__status="void")
            else:
                qs = qs.filter(status__in=statuses)
        if p.get("month"):
            try:
                year, month = (int(x) for x in p["month"].split("-")[:2])
            except ValueError as exc:
                raise ValidationError({"month": "Use 2026-10."}) from exc
            qs = qs.filter(invoice__issue_date__year=year, invoice__issue_date__month=month)
        if p.get("search"):
            term = p["search"].strip()
            qs = qs.filter(Q(invoice__number__icontains=term) | Q(invoice__patient__search_text__icontains=term.lower()) | Q(uuid__icontains=term))
        return qs.order_by("-invoice__issue_date", "-invoice_id")

    def get_serializer_context(self):
        ctx = super().get_serializer_context()
        if self.request.user.clinic_id:
            ctx["conf"] = EInvoiceSettings.for_clinic(self.request.user.clinic)
        return ctx

    def list(self, request, *args, **kwargs):
        services.prepare_missing(require_clinic(request.user))
        response = super().list(request, *args, **kwargs)
        clinic = request.user.clinic
        counts = dict(EInvoiceDocument.objects.filter(clinic=clinic).values_list("status").annotate(n=Count("id")))
        counts["needs_cancel"] = EInvoiceDocument.objects.filter(clinic=clinic, status="valid", invoice__status="void").count()
        response.data["counts"] = counts
        conf = EInvoiceSettings.for_clinic(clinic)
        response.data["mode"] = "live" if conf.live_ready else "simulation"
        response.data["registered"] = conf.is_registered
        return response

    def retrieve(self, request, *args, **kwargs):
        doc = self.get_object()
        return Response({**self.get_serializer(doc).data, "payload": doc.payload})

    @action(detail=False, methods=["post"])
    def prepare(self, request):
        return Response({"prepared": services.prepare_missing(require_clinic(request.user))})

    @action(detail=True, methods=["post"])
    def rebuild(self, request, pk=None):
        doc = self.get_object()
        if doc.status not in EInvoiceDocument.REBUILDABLE:
            raise ValidationError({"status": "Only documents not yet accepted can be rebuilt."})
        if doc.invoice.status == "void":
            raise ValidationError({"status": "The invoice was voided."})
        doc.status = "draft" if doc.status in ("invalid", "rejected") else doc.status
        doc.save(update_fields=["status"])
        doc = services.prepare(doc.invoice)
        return Response(self.get_serializer(doc).data)

    @action(detail=True, methods=["post"])
    def send(self, request, pk=None):
        doc = self.get_object()
        conf = EInvoiceSettings.for_clinic(doc.clinic)
        if doc.status in ("invalid", "rejected"):
            doc = services.prepare(doc.invoice, conf)
        if doc.status != "ready":
            raise ValidationError({"status": "Fix the problems listed before sending.", "errors": doc.errors})
        services.submit([doc], conf)
        doc.refresh_from_db()
        return Response(self.get_serializer(doc).data)

    @action(detail=False, methods=["post"], url_path="submit-ready")
    def submit_ready(self, request):
        clinic = require_clinic(request.user)
        conf = EInvoiceSettings.for_clinic(clinic)
        ids = request.data.get("ids")
        qs = EInvoiceDocument.objects.filter(clinic=clinic, status="ready").select_related("invoice")
        if ids:
            qs = qs.filter(pk__in=ids)
        docs = list(qs.order_by("invoice__issue_date", "id")[:100])  # the ETA takes up to 100 documents per submission
        return Response(services.submit(docs, conf))

    @action(detail=True, methods=["post"])
    def refresh(self, request, pk=None):
        doc = self.get_object()
        return Response(self.get_serializer(services.refresh_status(doc, EInvoiceSettings.for_clinic(doc.clinic))).data)

    @action(detail=True, methods=["post"])
    def cancel(self, request, pk=None):
        doc = self.get_object()
        reason = (request.data.get("reason") or "").strip()
        if not reason:
            raise ValidationError({"reason": "Give the reason the Tax Authority will see."})
        return Response(self.get_serializer(services.cancel(doc, EInvoiceSettings.for_clinic(doc.clinic), reason)).data)

    @action(detail=False, methods=["get"])
    def months(self, request):
        year = int(request.query_params.get("year") or timezone.localdate().year)
        rows = services.einvoice_months(require_clinic(request.user), year)
        return Response({"year": year, "months": [{**r, "total": money(r["total"]), "tax": money(r["tax"])} for r in rows]})


# ================================================================ booking


def public_link(request, slug):
    return request.build_absolute_uri(f"/book/{slug}") if slug else ""


class BookingSettingsView(AuditContextMixin, APIView):
    permission_classes = [ModulePermission]
    module = "settings"
    view_module = "appointments"

    def get(self, request):
        conf = BookingSettings.for_clinic(require_clinic(request.user))
        return Response({**BookingSettingsSerializer(conf).data, "link": public_link(request, conf.slug)})

    def patch(self, request):
        conf = BookingSettings.for_clinic(require_clinic(request.user))
        ser = BookingSettingsSerializer(conf, data=request.data, partial=True)
        ser.is_valid(raise_exception=True)
        ser.save()
        return Response({**ser.data, "link": public_link(request, conf.slug)})


class BookingRequestViewSet(AuditContextMixin, viewsets.ReadOnlyModelViewSet):
    permission_classes = [ModulePermission]
    module = "appointments"
    serializer_class = BookingRequestSerializer
    required_actions = {"confirm": "create", "reject": "edit"}

    def get_queryset(self):
        clinic = require_clinic(self.request.user)
        qs = BookingRequest.objects.filter(clinic=clinic).select_related("branch", "procedure", "dentist", "patient", "decided_by")
        status = self.request.query_params.get("status")
        if status:
            qs = qs.filter(status__in=status.split(","))
        if status == "pending":
            qs = qs.order_by("start")
        else:
            qs = qs.order_by("-created_at")
        return qs

    def list(self, request, *args, **kwargs):
        services.expire_old_requests(require_clinic(request.user))
        response = super().list(request, *args, **kwargs)
        clinic = request.user.clinic
        response.data["counts"] = dict(BookingRequest.objects.filter(clinic=clinic).values_list("status").annotate(n=Count("id")))
        return response

    @action(detail=True, methods=["post"])
    def confirm(self, request, pk=None):
        req = self.get_object()
        clinic = require_clinic(request.user)
        d = request.data
        dentist = of_clinic(StaffMember, clinic, d.get("dentist"), "dentist") if d.get("dentist") else None
        chair = of_clinic(Chair, clinic, d.get("chair"), "chair") if d.get("chair") else None
        start = parse_datetime(d["start"]) if d.get("start") else None
        if d.get("start") and start is None:
            raise ValidationError({"start": "Use a date and time."})
        services.confirm_request(req, user=request.user, dentist=dentist, start=start, chair=chair)
        return Response(self.get_serializer(req).data)

    @action(detail=True, methods=["post"])
    def reject(self, request, pk=None):
        req = self.get_object()
        services.reject_request(req, user=request.user, reason=request.data.get("reason", ""))
        return Response(self.get_serializer(req).data)
