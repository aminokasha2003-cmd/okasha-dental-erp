from collections import defaultdict
from datetime import date, timedelta
from decimal import Decimal

from django.db import transaction
from django.db.models import Count, DecimalField, Exists, F, OuterRef, Prefetch, Q, Sum, Value
from django.db.models.functions import Coalesce
from django.utils import timezone
from rest_framework.decorators import action
from rest_framework.exceptions import PermissionDenied, ValidationError
from rest_framework.response import Response
from rest_framework.views import APIView

from erp.clinical.models import TreatmentPlanLine
from erp.core.api import AuditContextMixin, ClinicScopedViewSet, ModulePermission, require_clinic
from erp.lab.models import LabCase
from erp.masterdata.models import Branch

from . import services
from .models import (
    ZERO,
    ProcedureMaterial,
    PurchaseOrder,
    PurchaseOrderLine,
    StockItem,
    StockLot,
    StockMovement,
    Supplier,
)
from .serializers import (
    AdjustSerializer,
    ConsumeSerializer,
    ProcedureMaterialSerializer,
    PurchaseOrderSerializer,
    ReceiveSerializer,
    StockItemSerializer,
    StockLotSerializer,
    StockMovementSerializer,
    SupplierSerializer,
    TransferSerializer,
    item_info,
    money,
    named,
    qty,
)

MODULE = "inventory"
QTY_FIELD = DecimalField(max_digits=14, decimal_places=3)
MONEY_FIELD = DecimalField(max_digits=18, decimal_places=5)
NOTHING = Value(Decimal("0"), output_field=QTY_FIELD)
LINE_VALUE = F("quantity") * F("unit_cost")


def parse_day(value, field):
    try:
        return date.fromisoformat(value) if value else None
    except ValueError as exc:
        raise ValidationError({field: "Use a date like 2026-10-09."}) from exc


def parse_int(value, field):
    try:
        return int(value)
    except (TypeError, ValueError) as exc:
        raise ValidationError({field: "Give a number."}) from exc


def get_or_400(model, clinic, pk, field, **extra):
    obj = model.objects.filter(clinic=clinic, pk=pk, **extra).first() if pk is not None else None
    if obj is None:
        raise ValidationError({field: "Not found."})
    return obj


def with_on_hand(queryset, branch=None):
    lots = Q(lots__branch=branch) if branch else Q()
    return queryset.annotate(on_hand=Coalesce(Sum("lots__quantity", filter=lots), NOTHING))


def require(user, action):
    if not user.has_module_perm(MODULE, action):
        raise PermissionDenied("Your role does not allow this.")


class InventoryView(AuditContextMixin, APIView):
    permission_classes = [ModulePermission]
    module = MODULE


# Catalogue screens: assistants and technicians may record usage (create) but
# only roles with edit rights maintain suppliers, items and procedure materials.
CATALOGUE_ACTIONS = {"create": "edit"}


class SupplierViewSet(ClinicScopedViewSet):
    queryset = Supplier.objects.all()
    serializer_class = SupplierSerializer
    module = MODULE
    required_actions = CATALOGUE_ACTIONS

    def get_queryset(self):
        qs = super().get_queryset()
        p = self.request.query_params
        if p.get("active"):
            qs = qs.filter(is_active=True)
        if p.get("search"):
            term = p["search"].strip()
            qs = qs.filter(Q(name__icontains=term) | Q(contact_person__icontains=term) | Q(phone__icontains=term))
        return qs

    def perform_destroy(self, instance):
        if instance.purchase_orders.exists() or instance.lots.exists():
            raise ValidationError("This supplier has orders or stock. Mark it inactive instead.")
        instance.delete()


class StockItemViewSet(ClinicScopedViewSet):
    queryset = StockItem.objects.select_related("preferred_supplier")
    serializer_class = StockItemSerializer
    module = MODULE
    required_actions = CATALOGUE_ACTIONS

    def branch(self):
        value = self.request.query_params.get("branch")
        return parse_int(value, "branch") if value else None

    def get_serializer_context(self):
        return {**super().get_serializer_context(), "branch": self.branch()}

    def get_queryset(self):
        branch = self.branch()
        qs = with_on_hand(super().get_queryset(), branch).prefetch_related(
            Prefetch("lots", queryset=StockLot.objects.select_related("branch"))
        ).order_by("name_en", "id")
        p = self.request.query_params
        if p.get("search"):
            term = p["search"].strip()
            qs = qs.filter(
                Q(code__icontains=term) | Q(name_en__icontains=term) | Q(name_ar__icontains=term)
                | Q(brand__icontains=term) | Q(system__icontains=term)
            )
        if p.get("category"):
            qs = qs.filter(category__in=p["category"].split(","))
        if p.get("supplier"):
            qs = qs.filter(preferred_supplier=p["supplier"])
        if p.get("active"):
            qs = qs.filter(is_active=True)
        if p.get("low"):
            qs = qs.filter(is_active=True, reorder_level__gt=0, on_hand__lte=F("reorder_level"))
        if p.get("expiring"):
            cutoff = timezone.localdate() + timedelta(days=parse_int(p["expiring"], "expiring"))
            lots = StockLot.objects.filter(item=OuterRef("pk"), quantity__gt=0, expiry_date__lte=cutoff)
            if branch:
                lots = lots.filter(branch=branch)
            qs = qs.filter(Exists(lots))
        return qs

    def perform_destroy(self, instance):
        if instance.movements.exists() or instance.order_lines.exists():
            raise ValidationError("This item has stock history. Mark it inactive instead.")
        instance.delete()


class StockLotViewSet(ClinicScopedViewSet):
    queryset = StockLot.objects.select_related("item", "branch", "supplier", "purchase_order_line__order")
    serializer_class = StockLotSerializer
    module = MODULE
    http_method_names = ["get", "head", "options"]

    def get_queryset(self):
        qs = super().get_queryset()
        p = self.request.query_params
        today = timezone.localdate()
        for field in ("item", "branch", "supplier"):
            if p.get(field):
                qs = qs.filter(**{field: p[field]})
        if p.get("category"):
            qs = qs.filter(item__category__in=p["category"].split(","))
        if p.get("lot"):
            qs = qs.filter(lot_number__icontains=p["lot"].strip())
        if p.get("in_stock"):
            qs = qs.filter(quantity__gt=0)
        if p.get("expiring"):
            cutoff = today + timedelta(days=parse_int(p["expiring"], "expiring"))
            qs = qs.filter(quantity__gt=0, expiry_date__gte=today, expiry_date__lte=cutoff)
        if p.get("expired"):
            qs = qs.filter(quantity__gt=0, expiry_date__lt=today)
        if p.get("expiring") or p.get("expired"):
            qs = qs.order_by("expiry_date", "id")
        return qs


class StockMovementViewSet(ClinicScopedViewSet):
    queryset = StockMovement.objects.select_related(
        "item", "lot", "branch", "other_branch", "patient", "lab_case", "purchase_order_line__order", "created_by"
    )
    serializer_class = StockMovementSerializer
    module = MODULE
    http_method_names = ["get", "head", "options"]

    def get_queryset(self):
        qs = super().get_queryset()
        p = self.request.query_params
        for field in ("item", "lot", "branch", "plan_line", "patient", "lab_case", "appointment"):
            if p.get(field):
                qs = qs.filter(**{field: p[field]})
        if p.get("kind"):
            qs = qs.filter(kind__in=p["kind"].split(","))
        if p.get("category"):
            qs = qs.filter(item__category__in=p["category"].split(","))
        if p.get("purchase_order"):
            qs = qs.filter(purchase_order_line__order=p["purchase_order"])
        start = parse_day(p.get("from"), "from")
        end = parse_day(p.get("to"), "to")
        if start:
            qs = qs.filter(created_at__date__gte=start)
        if end:
            qs = qs.filter(created_at__date__lte=end)
        return qs


class ProcedureMaterialViewSet(ClinicScopedViewSet):
    queryset = ProcedureMaterial.objects.select_related("procedure", "item")
    serializer_class = ProcedureMaterialSerializer
    module = MODULE
    required_actions = CATALOGUE_ACTIONS

    def get_queryset(self):
        qs = super().get_queryset()
        p = self.request.query_params
        if p.get("procedure"):
            qs = qs.filter(procedure=p["procedure"])
        if p.get("item"):
            qs = qs.filter(item=p["item"])
        return qs


class PurchaseOrderViewSet(ClinicScopedViewSet):
    queryset = PurchaseOrder.objects.select_related("supplier", "branch").prefetch_related("lines__item")
    serializer_class = PurchaseOrderSerializer
    module = MODULE
    http_method_names = ["get", "post", "patch", "delete", "head", "options"]
    required_actions = {
        "partial_update": "create",
        "order": "approve",
        "receive": "create",
        "cancel": "approve",
        "suggest": "create",
    }

    def get_queryset(self):
        qs = super().get_queryset()
        p = self.request.query_params
        if p.get("status"):
            qs = qs.filter(status__in=p["status"].split(","))
        if p.get("open"):
            qs = qs.filter(status__in=PurchaseOrder.OPEN_STATUSES)
        for field in ("supplier", "branch"):
            if p.get(field):
                qs = qs.filter(**{field: p[field]})
        if p.get("search"):
            term = p["search"].strip()
            qs = qs.filter(Q(number__icontains=term) | Q(supplier__name__icontains=term))
        return qs

    def fresh(self, order, status=200):
        return Response(self.get_serializer(self.get_queryset().get(pk=order.pk)).data, status=status)

    def perform_destroy(self, instance):
        if instance.status != "draft":
            raise ValidationError("Only a draft order can be deleted. Cancel it instead.")
        instance.delete()

    @action(detail=True, methods=["post"])
    def order(self, request, pk=None):
        po = self.get_object()
        if po.status != "draft":
            raise ValidationError("Only a draft can be ordered.")
        if not po.lines.exists():
            raise ValidationError("Add at least one item first.")
        po.status = "ordered"
        po.ordered_at = timezone.now()
        po.save(update_fields=["status", "ordered_at", "updated_at"])
        return self.fresh(po)

    @action(detail=True, methods=["post"])
    def receive(self, request, pk=None):
        data = ReceiveSerializer(data=request.data)
        data.is_valid(raise_exception=True)
        clinic = require_clinic(request.user)
        with transaction.atomic():
            po = PurchaseOrder.objects.select_for_update().get(pk=self.get_object().pk)
            if po.status not in PurchaseOrder.OPEN_STATUSES:
                raise ValidationError("Only an ordered purchase order can be received.")
            lines = {line.pk: line for line in po.lines.select_related("item")}
            note = data.validated_data.get("note", "") or f"Received on {po.number}"
            for row in data.validated_data["lines"]:
                line = lines.get(row["line"])
                if line is None:
                    raise ValidationError({"lines": "A line is not on this order."})
                if row["quantity"] > line.remaining:
                    raise ValidationError(
                        {"lines": f"Only {services.fmt_qty(line.remaining)} of {line.item.name_en} are still due."}
                    )
                cost = row.get("unit_cost", line.unit_cost)
                lot = services.lot_for(
                    clinic, line.item, po.branch, row.get("lot_number", ""), row.get("expiry_date"),
                    unit_cost=cost, supplier=po.supplier, po_line=line,
                )
                services.move(lot, "receive", row["quantity"], unit_cost=cost, note=note, purchase_order_line=line)
                line.quantity_received += row["quantity"]
                line.save(update_fields=["quantity_received"])
                line.item.last_cost = cost
                line.item.save(update_fields=["last_cost", "updated_at"])
            done = all(line.remaining == 0 for line in lines.values())
            po.status = "received" if done else "partially_received"
            fields = ["status", "updated_at"]
            if done:
                po.received_at = timezone.now()
                fields.append("received_at")
            po.save(update_fields=fields)
        return self.fresh(po)

    @action(detail=True, methods=["post"])
    def cancel(self, request, pk=None):
        po = self.get_object()
        if po.status in ("received", "cancelled"):
            raise ValidationError("This order is already closed.")
        reason = str(request.data.get("reason", "")).strip()
        if not reason:
            raise ValidationError({"reason": "Say why the order is cancelled."})
        po.status = "cancelled"
        po.cancelled_at = timezone.now()
        po.cancel_reason = reason[:255]
        po.save(update_fields=["status", "cancelled_at", "cancel_reason", "updated_at"])
        return self.fresh(po)

    @action(detail=False, methods=["post"])
    def suggest(self, request):
        """Draft orders for items at or below their reorder level at a branch,
        one per preferred supplier. Stock already on open orders counts as coming."""
        clinic = require_clinic(request.user)
        branch = get_or_400(Branch, clinic, request.data.get("branch"), "branch")
        only = request.data.get("supplier")
        items = with_on_hand(
            StockItem.objects.filter(clinic=clinic, is_active=True, reorder_level__gt=0), branch
        ).select_related("preferred_supplier")
        if only:
            items = items.filter(preferred_supplier=only)
        incoming = dict(
            PurchaseOrderLine.objects.filter(
                order__clinic=clinic, order__branch=branch, order__status__in=("draft", *PurchaseOrder.OPEN_STATUSES)
            )
            .values("item")
            .annotate(due=Sum(F("quantity_ordered") - F("quantity_received")))
            .values_list("item", "due")
        )
        groups, orphans = defaultdict(list), []
        for item in items:
            coming = incoming.get(item.pk) or Decimal("0")
            if item.on_hand > item.reorder_level or item.on_hand + coming > item.reorder_level:
                continue
            need = item.reorder_quantity or max(item.reorder_level * 2 - item.on_hand - coming, Decimal("1"))
            if item.preferred_supplier_id is None or not item.preferred_supplier.is_active:
                orphans.append({**item_info(item), "on_hand": qty(item.on_hand), "suggested": qty(need)})
                continue
            groups[item.preferred_supplier].append((item, need))
        created = []
        with transaction.atomic():
            for supplier, rows in sorted(groups.items(), key=lambda kv: kv[0].name):
                po = PurchaseOrder.objects.create(
                    clinic=clinic, supplier=supplier, branch=branch, notes="Suggested from reorder levels."
                )
                PurchaseOrderLine.objects.bulk_create(
                    PurchaseOrderLine(order=po, item=item, quantity_ordered=need, unit_cost=item.last_cost)
                    for item, need in rows
                )
                created.append(po.pk)
        orders = [self.get_serializer(po).data for po in self.get_queryset().filter(pk__in=created).order_by("id")]
        return Response({"orders": orders, "no_supplier": orphans}, status=201 if created else 200)


class AdjustView(InventoryView):
    """A stock count (counted quantity or a signed change), waste, or a return to the supplier."""

    def post(self, request):
        require(request.user, "edit")
        data = AdjustSerializer(data=request.data)
        data.is_valid(raise_exception=True)
        v = data.validated_data
        clinic = require_clinic(request.user)
        item = get_or_400(StockItem, clinic, v["item"], "item")
        branch = get_or_400(Branch, clinic, v["branch"], "branch")
        with transaction.atomic():
            if v.get("lot"):
                lot = get_or_400(StockLot, clinic, v["lot"], "lot", item=item, branch=branch)
            else:
                lot = services.lot_for(
                    clinic, item, branch, v.get("lot_number", ""), v.get("expiry_date"), unit_cost=v.get("unit_cost")
                )
            if v["kind"] == "adjust":
                current = StockLot.objects.select_for_update().get(pk=lot.pk).quantity
                change = v["counted"] - current if "counted" in v else v["quantity"]
                if current + change < 0:
                    raise ValidationError({"quantity": "A count cannot leave less than nothing."})
                if change == 0:
                    raise ValidationError({"counted": "The count matches the stock; nothing to change."})
                movement = services.move(lot, "adjust", change, unit_cost=v.get("unit_cost"), note=v["reason"])
            else:
                movement = services.take(clinic, item, branch, abs(v["quantity"]), v["kind"], lot=lot, note=v["reason"])[0]
        return Response(StockMovementSerializer(movement).data, status=201)


class TransferView(InventoryView):
    def post(self, request):
        require(request.user, "edit")
        data = TransferSerializer(data=request.data)
        data.is_valid(raise_exception=True)
        v = data.validated_data
        clinic = require_clinic(request.user)
        item = get_or_400(StockItem, clinic, v["item"], "item")
        source = get_or_400(Branch, clinic, v["from_branch"], "from_branch")
        target = get_or_400(Branch, clinic, v["to_branch"], "to_branch")
        lot = get_or_400(StockLot, clinic, v["lot"], "lot") if v.get("lot") else None
        movements = services.transfer(clinic, item, source, target, v["quantity"], lot=lot, note=v.get("note", ""))
        return Response(StockMovementSerializer(movements, many=True).data, status=201)


class ConsumeView(InventoryView):
    """Record the materials used for a plan line (the procedure's list by
    default) or a lab case, taking stock first expiry first out."""

    def post(self, request):
        require(request.user, "create")
        data = ConsumeSerializer(data=request.data)
        data.is_valid(raise_exception=True)
        v = data.validated_data
        clinic = require_clinic(request.user)
        branch = get_or_400(Branch, clinic, v["branch"], "branch")
        line = case = None
        if v.get("lab_case"):
            case = get_or_400(LabCase, clinic, v["lab_case"], "lab_case")
            line = case.plan_line
            patient = case.patient
        elif v.get("plan_line"):
            line = get_or_400(TreatmentPlanLine, clinic, v["plan_line"], "plan_line")
            if line.status not in ("in_progress", "done"):
                raise ValidationError({"plan_line": "Record materials once the procedure is started or done."})
            patient = line.plan.patient
        else:
            patient = None
        if line is not None and case is None and not v["again"]:
            if StockMovement.objects.filter(plan_line=line, kind="use", lab_case__isnull=True).exists():
                raise ValidationError({"plan_line": "Materials are already recorded for this procedure."})

        if v.get("lines"):
            wanted = [(row["item"], row["quantity"], row.get("lot")) for row in v["lines"]]
        elif line is not None and case is None:
            chosen = {int(k): lot for k, lot in (v.get("lots") or {}).items() if str(k).isdigit()}
            wanted = [
                (m.item_id, m.quantity, chosen.get(m.item_id))
                for m in ProcedureMaterial.objects.filter(clinic=clinic, procedure=line.procedure_id)
            ]
            if not wanted:
                raise ValidationError({"lines": "No materials are listed for this procedure. List what was used."})
        else:
            raise ValidationError({"lines": "List the materials used."})

        links = {"patient": patient, "plan_line": line, "lab_case": case}
        if line is not None:
            links["appointment"] = line.appointment
        note = v.get("note", "")
        movements = []
        with transaction.atomic():
            for item_id, quantity, lot_id in wanted:
                item = get_or_400(StockItem, clinic, item_id, "item")
                lot = get_or_400(StockLot, clinic, lot_id, "lot") if lot_id else None
                movements += services.take(clinic, item, branch, quantity, "use", lot=lot, note=note, **links)
        total = sum((m.value for m in movements), ZERO)
        return Response(
            {"movements": StockMovementSerializer(movements, many=True).data, "total_value": money(total)}, status=201
        )


class ImplantTraceView(InventoryView):
    """Which patients received a lot (for a recall), or which lots a patient received."""

    def get(self, request):
        clinic = require_clinic(request.user)
        p = request.query_params
        if not (p.get("lot") or p.get("patient") or p.get("item")):
            raise ValidationError("Give a lot number, a patient or an item.")
        qs = StockMovement.objects.filter(clinic=clinic, kind="use", item__tracks_lots=True).select_related(
            "item", "lot", "branch", "patient", "plan_line__procedure", "plan_line__plan__dentist", "lab_case"
        )
        if p.get("lot"):
            qs = qs.filter(lot__lot_number__iexact=p["lot"].strip())
        if p.get("patient"):
            qs = qs.filter(patient=p["patient"])
        if p.get("item"):
            qs = qs.filter(item=p["item"])
        if p.get("category"):
            qs = qs.filter(item__category=p["category"])
        rows = []
        for m in qs.order_by("-created_at", "-id"):
            pl = m.plan_line
            rows.append(
                {
                    "id": m.pk,
                    "used_at": m.created_at,
                    "patient": (
                        {"id": m.patient.pk, "en": m.patient.name_en, "ar": m.patient.name_ar,
                         "file_number": m.patient.file_number} if m.patient else None
                    ),
                    "item": {**item_info(m.item), "brand": m.item.brand, "system": m.item.system,
                             "diameter": m.item.diameter, "length": m.item.length},
                    "lot": m.lot_id,
                    "lot_number": m.lot.lot_number,
                    "expiry_date": m.lot.expiry_date,
                    "quantity": qty(-m.quantity),
                    "branch": named(m.branch),
                    "plan_line": pl.pk if pl else None,
                    "procedure": {"en": pl.procedure.name_en, "ar": pl.procedure.name_ar, "code": pl.procedure.code}
                    if pl else None,
                    "tooth": pl.tooth if pl else None,
                    "dentist": named(pl.plan.dentist) if pl else None,
                    "lab_case": m.lab_case.number if m.lab_case else None,
                }
            )
        patients = {r["patient"]["id"] for r in rows if r["patient"]}
        return Response({"results": rows, "count": len(rows), "patients": len(patients)})


class SummaryView(InventoryView):
    def get(self, request):
        clinic = require_clinic(request.user)
        branch = request.query_params.get("branch")
        branch = parse_int(branch, "branch") if branch else None
        today = timezone.localdate()
        lots = StockLot.objects.filter(clinic=clinic, quantity__gt=0)
        moves = StockMovement.objects.filter(clinic=clinic)
        if branch:
            lots, moves = lots.filter(branch=branch), moves.filter(branch=branch)
        items = with_on_hand(StockItem.objects.filter(clinic=clinic, is_active=True), branch)

        def expiring(days):
            return lots.filter(expiry_date__gte=today, expiry_date__lte=today + timedelta(days=days)).count()

        value = lots.aggregate(v=Sum(LINE_VALUE, output_field=MONEY_FIELD))["v"] or ZERO
        used = moves.filter(kind="use", created_at__date__gte=today.replace(day=1)).aggregate(
            v=Sum(LINE_VALUE, output_field=MONEY_FIELD)
        )["v"] or ZERO
        orders = PurchaseOrder.objects.filter(clinic=clinic)
        if branch:
            orders = orders.filter(branch=branch)
        return Response(
            {
                "items": items.count(),
                "low_stock": items.filter(reorder_level__gt=0, on_hand__lte=F("reorder_level")).count(),
                "out_of_stock": items.filter(on_hand__lte=0).count(),
                "expiring_30": expiring(30),
                "expiring_60": expiring(60),
                "expiring_90": expiring(90),
                "expired_with_stock": lots.filter(expiry_date__lt=today).count(),
                "stock_value": money(value),
                "open_orders": orders.filter(status__in=PurchaseOrder.OPEN_STATUSES).count(),
                "draft_orders": orders.filter(status="draft").count(),
                "consumed_this_month": money(-used),
            }
        )


class ReportView(InventoryView):
    """Usage and valuation for a period: consumption by item, category and
    procedure, current stock value by category, and purchases by supplier."""

    def get(self, request):
        require(request.user, "approve")
        clinic = require_clinic(request.user)
        p = request.query_params
        today = timezone.localdate()
        start = parse_day(p.get("from"), "from") or today.replace(day=1)
        end = parse_day(p.get("to"), "to") or today
        moves = StockMovement.objects.filter(clinic=clinic, created_at__date__gte=start, created_at__date__lte=end)
        lots = StockLot.objects.filter(clinic=clinic, quantity__gt=0)
        if p.get("branch"):
            moves, lots = moves.filter(branch=p["branch"]), lots.filter(branch=p["branch"])
        value = Sum(LINE_VALUE, output_field=MONEY_FIELD)
        used = moves.filter(kind="use")
        categories = dict(StockItem.CATEGORIES)

        by_item = [
            {
                "item": r["item"], "code": r["item__code"], "en": r["item__name_en"], "ar": r["item__name_ar"],
                "category": r["item__category"], "unit": r["item__unit"],
                "quantity": qty(-r["q"]), "value": money(-r["v"]),
            }
            for r in used.values("item", "item__code", "item__name_en", "item__name_ar", "item__category", "item__unit")
            .annotate(q=Sum("quantity"), v=value)
            .order_by("v")
        ]
        by_category = [
            {"category": r["item__category"], "label": str(categories[r["item__category"]]), "value": money(-r["v"])}
            for r in used.values("item__category").annotate(v=value).order_by("v")
        ]
        by_procedure = []
        for r in (
            used.filter(plan_line__isnull=False)
            .values("plan_line__procedure", "plan_line__procedure__code", "plan_line__procedure__name_en",
                    "plan_line__procedure__name_ar")
            .annotate(v=value)
            .order_by("v")
        ):
            count = used.filter(plan_line__procedure=r["plan_line__procedure"]).values("plan_line").distinct().count()
            by_procedure.append(
                {
                    "procedure": r["plan_line__procedure"], "code": r["plan_line__procedure__code"],
                    "en": r["plan_line__procedure__name_en"], "ar": r["plan_line__procedure__name_ar"],
                    "procedures_done": count, "value": money(-r["v"]),
                    "per_procedure": money(-r["v"] / count) if count else money(0),
                }
            )
        stock_by_category = [
            {"category": r["item__category"], "label": str(categories[r["item__category"]]),
             "items": r["n"], "value": money(r["v"])}
            for r in lots.values("item__category").annotate(v=value, n=Count("item", distinct=True)).order_by("-v")
        ]
        purchases = [
            {
                "supplier": r["purchase_order_line__order__supplier"],
                "name": r["purchase_order_line__order__supplier__name"],
                "orders": moves.filter(
                    kind="receive", purchase_order_line__order__supplier=r["purchase_order_line__order__supplier"]
                ).values("purchase_order_line__order").distinct().count(),
                "value": money(r["v"]),
            }
            for r in moves.filter(kind="receive", purchase_order_line__isnull=False)
            .values("purchase_order_line__order__supplier", "purchase_order_line__order__supplier__name")
            .annotate(v=value)
            .order_by("-v")
        ]
        waste = moves.filter(kind="waste").aggregate(v=value)["v"] or ZERO
        total_used = used.aggregate(v=value)["v"] or ZERO
        stock_value = lots.aggregate(v=value)["v"] or ZERO
        return Response(
            {
                "from": start,
                "to": end,
                "consumed_value": money(-total_used),
                "wasted_value": money(-waste),
                "stock_value": money(stock_value),
                "consumption_by_item": by_item,
                "consumption_by_category": by_category,
                "consumption_by_procedure": by_procedure,
                "stock_by_category": stock_by_category,
                "purchases_by_supplier": purchases,
            }
        )
