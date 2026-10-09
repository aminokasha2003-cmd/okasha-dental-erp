from decimal import Decimal

from django.utils import timezone
from rest_framework import serializers

from erp.core.api import ClinicScopedSerializer

from .models import ProcedureMaterial, PurchaseOrder, PurchaseOrderLine, StockItem, StockLot, StockMovement, Supplier


def money(value):
    return f"{Decimal(value or 0):.2f}"


def qty(value):
    return f"{Decimal(value or 0):.3f}"


def named(obj):
    return {"id": obj.pk, "en": obj.name_en, "ar": obj.name_ar} if obj else None


def item_info(item):
    return {
        "id": item.pk,
        "code": item.code,
        "en": item.name_en,
        "ar": item.name_ar,
        "category": item.category,
        "unit": item.unit,
        "tracks_lots": item.tracks_lots,
    }


class SupplierSerializer(ClinicScopedSerializer):
    class Meta:
        model = Supplier
        fields = [
            "id", "name", "contact_person", "phone", "whatsapp", "email", "address", "payment_terms", "notes",
            "is_active", "created_at",
        ]
        read_only_fields = ["id", "created_at"]


class StockItemSerializer(ClinicScopedSerializer):
    category_label = serializers.CharField(source="get_category_display", read_only=True)
    unit_label = serializers.CharField(source="get_unit_display", read_only=True)
    preferred_supplier_name = serializers.CharField(source="preferred_supplier.name", read_only=True, default=None)
    on_hand = serializers.SerializerMethodField()
    stock_value = serializers.SerializerMethodField()
    is_low = serializers.SerializerMethodField()
    next_expiry = serializers.SerializerMethodField()
    stock = serializers.SerializerMethodField()
    last_cost = serializers.DecimalField(max_digits=12, decimal_places=2, required=False, min_value=0)
    reorder_level = serializers.DecimalField(max_digits=12, decimal_places=3, required=False, min_value=0)
    reorder_quantity = serializers.DecimalField(max_digits=12, decimal_places=3, required=False, min_value=0)
    tracks_lots = serializers.BooleanField(required=False)

    class Meta:
        model = StockItem
        fields = [
            "id", "code", "name_en", "name_ar", "category", "category_label", "unit", "unit_label",
            "units_per_pack", "preferred_supplier", "preferred_supplier_name", "last_cost", "reorder_level",
            "reorder_quantity", "tracks_lots", "is_active", "notes", "brand", "system", "diameter", "length",
            "on_hand", "stock_value", "is_low", "next_expiry", "stock", "created_at",
        ]
        read_only_fields = ["id", "created_at"]

    def _lots(self, obj):
        """Lots holding stock, limited to ?branch= when the list asks for one."""
        branch = self.context.get("branch")
        return [x for x in obj.lots.all() if x.quantity != 0 and (branch is None or x.branch_id == branch)]

    def get_on_hand(self, obj):
        value = getattr(obj, "on_hand", None)
        return qty(value if value is not None else sum((x.quantity for x in self._lots(obj)), Decimal("0")))

    def get_stock_value(self, obj):
        return money(sum((x.quantity * x.unit_cost for x in self._lots(obj)), Decimal("0")))

    def get_is_low(self, obj):
        return obj.reorder_level > 0 and Decimal(self.get_on_hand(obj)) <= obj.reorder_level

    def get_next_expiry(self, obj):
        dates = [x.expiry_date for x in self._lots(obj) if x.expiry_date and x.quantity > 0]
        return min(dates) if dates else None

    def get_stock(self, obj):
        by_branch = {}
        for lot in self._lots(obj):
            row = by_branch.setdefault(lot.branch_id, {"branch": named(lot.branch), "quantity": Decimal("0")})
            row["quantity"] += lot.quantity
        return [{**row, "quantity": qty(row["quantity"])} for row in by_branch.values()]

    def validate_code(self, value):
        value = value.strip()
        if value:
            clinic = self.context["request"].user.clinic_id
            clash = StockItem.objects.filter(clinic_id=clinic, code__iexact=value)
            if self.instance is not None:
                clash = clash.exclude(pk=self.instance.pk)
            if clash.exists():
                raise serializers.ValidationError("Another item already uses this code.")
        return value

    def validate(self, attrs):
        instance = self.instance
        if instance is None and "tracks_lots" not in attrs:
            attrs["tracks_lots"] = attrs.get("category", "consumable") in StockItem.LOT_CATEGORIES
        if (
            instance is not None
            and "tracks_lots" in attrs
            and attrs["tracks_lots"] != instance.tracks_lots
            and instance.lots.exists()
        ):
            raise serializers.ValidationError({"tracks_lots": "Lot tracking cannot change once the item has stock."})
        return attrs


class StockLotSerializer(serializers.ModelSerializer):
    item_info = serializers.SerializerMethodField()
    branch_name = serializers.SerializerMethodField()
    supplier_name = serializers.CharField(source="supplier.name", read_only=True, default=None)
    purchase_order = serializers.CharField(source="purchase_order_line.order.number", read_only=True, default=None)
    value = serializers.SerializerMethodField()
    days_to_expiry = serializers.SerializerMethodField()

    class Meta:
        model = StockLot
        fields = [
            "id", "item", "item_info", "branch", "branch_name", "lot_number", "expiry_date", "days_to_expiry",
            "quantity", "unit_cost", "value", "received_at", "supplier", "supplier_name", "purchase_order",
        ]
        read_only_fields = fields

    def get_item_info(self, obj):
        return item_info(obj.item)

    def get_branch_name(self, obj):
        return named(obj.branch)

    def get_value(self, obj):
        return money(obj.quantity * obj.unit_cost)

    def get_days_to_expiry(self, obj):
        return (obj.expiry_date - timezone.localdate()).days if obj.expiry_date else None


class StockMovementSerializer(serializers.ModelSerializer):
    kind_label = serializers.CharField(source="get_kind_display", read_only=True)
    item_info = serializers.SerializerMethodField()
    branch_name = serializers.SerializerMethodField()
    other_branch_name = serializers.SerializerMethodField()
    lot_number = serializers.CharField(source="lot.lot_number", read_only=True)
    expiry_date = serializers.DateField(source="lot.expiry_date", read_only=True)
    patient_info = serializers.SerializerMethodField()
    purchase_order = serializers.CharField(source="purchase_order_line.order.number", read_only=True, default=None)
    lab_case_number = serializers.CharField(source="lab_case.number", read_only=True, default=None)
    value = serializers.SerializerMethodField()
    by = serializers.SerializerMethodField()

    class Meta:
        model = StockMovement
        fields = [
            "id", "created_at", "kind", "kind_label", "item", "item_info", "lot", "lot_number", "expiry_date",
            "branch", "branch_name", "other_branch", "other_branch_name", "quantity", "balance_after", "unit_cost",
            "value", "note", "plan_line", "appointment", "lab_case", "lab_case_number", "purchase_order_line",
            "purchase_order", "patient", "patient_info", "by",
        ]
        read_only_fields = fields

    def get_item_info(self, obj):
        return item_info(obj.item)

    def get_branch_name(self, obj):
        return named(obj.branch)

    def get_other_branch_name(self, obj):
        return named(obj.other_branch)

    def get_patient_info(self, obj):
        p = obj.patient
        return {"id": p.pk, "en": p.name_en, "ar": p.name_ar, "file_number": p.file_number} if p else None

    def get_value(self, obj):
        return money(obj.value)

    def get_by(self, obj):
        user = obj.created_by
        return (user.get_full_name() or user.username) if user else ""


class ProcedureMaterialSerializer(ClinicScopedSerializer):
    item_info = serializers.SerializerMethodField()
    procedure_name = serializers.SerializerMethodField()
    quantity = serializers.DecimalField(max_digits=12, decimal_places=3, min_value=Decimal("0.001"))

    class Meta:
        model = ProcedureMaterial
        fields = ["id", "procedure", "procedure_name", "item", "item_info", "quantity"]
        read_only_fields = ["id"]

    def get_item_info(self, obj):
        return item_info(obj.item)

    def get_procedure_name(self, obj):
        return {"en": obj.procedure.name_en, "ar": obj.procedure.name_ar, "code": obj.procedure.code}

    def validate(self, attrs):
        procedure = attrs.get("procedure", getattr(self.instance, "procedure", None))
        item = attrs.get("item", getattr(self.instance, "item", None))
        clash = ProcedureMaterial.objects.filter(procedure=procedure, item=item)
        if self.instance is not None:
            clash = clash.exclude(pk=self.instance.pk)
        if clash.exists():
            raise serializers.ValidationError({"item": "This item is already listed for the procedure."})
        return attrs


class PurchaseOrderLineSerializer(serializers.ModelSerializer):
    item_info = serializers.SerializerMethodField()
    remaining = serializers.SerializerMethodField()
    total = serializers.SerializerMethodField()

    class Meta:
        model = PurchaseOrderLine
        fields = ["id", "item", "item_info", "quantity_ordered", "unit_cost", "quantity_received", "remaining", "total"]
        read_only_fields = fields

    def get_item_info(self, obj):
        return item_info(obj.item)

    def get_remaining(self, obj):
        return qty(obj.remaining)

    def get_total(self, obj):
        return money(obj.total)


class LineInputSerializer(serializers.Serializer):
    item = serializers.IntegerField()
    quantity_ordered = serializers.DecimalField(max_digits=12, decimal_places=3, min_value=Decimal("0.001"))
    unit_cost = serializers.DecimalField(max_digits=12, decimal_places=2, min_value=0, required=False)


class PurchaseOrderSerializer(ClinicScopedSerializer):
    supplier_name = serializers.CharField(source="supplier.name", read_only=True)
    branch_name = serializers.SerializerMethodField()
    status_label = serializers.CharField(source="get_status_display", read_only=True)
    lines = PurchaseOrderLineSerializer(many=True, read_only=True)
    items = LineInputSerializer(many=True, write_only=True, required=False)
    total = serializers.SerializerMethodField()
    received_value = serializers.SerializerMethodField()

    class Meta:
        model = PurchaseOrder
        fields = [
            "id", "number", "supplier", "supplier_name", "branch", "branch_name", "status", "status_label",
            "expected_date", "notes", "lines", "items", "total", "received_value", "ordered_at", "received_at",
            "cancelled_at", "cancel_reason", "created_at",
        ]
        read_only_fields = [
            "id", "number", "status", "ordered_at", "received_at", "cancelled_at", "cancel_reason", "created_at",
        ]

    def get_branch_name(self, obj):
        return named(obj.branch)

    def get_total(self, obj):
        return money(obj.total)

    def get_received_value(self, obj):
        return money(obj.received_value)

    def to_internal_value(self, data):
        # Lines are written as [{item, quantity_ordered, unit_cost}] and read back in full.
        if hasattr(data, "get") and "lines" in data and "items" not in data:
            data = {**data, "items": data["lines"]}
        return super().to_internal_value(data)

    def validate(self, attrs):
        if self.instance is not None and self.instance.status != "draft":
            raise serializers.ValidationError("Only a draft order can be changed.")
        if "items" in attrs:
            clinic = self.context["request"].user.clinic_id
            ids = [row["item"] for row in attrs["items"]]
            found = {i.pk: i for i in StockItem.objects.filter(clinic_id=clinic, pk__in=ids)}
            if len(found) != len(set(ids)):
                raise serializers.ValidationError({"items": "An item is missing."})
            if len(ids) != len(set(ids)):
                raise serializers.ValidationError({"items": "Each item can be on the order once."})
            for row in attrs["items"]:
                row["item"] = found[row["item"]]
                row.setdefault("unit_cost", row["item"].last_cost)
        elif self.instance is None:
            attrs["items"] = []
        return attrs

    def _write_lines(self, order, rows):
        order.lines.all().delete()
        PurchaseOrderLine.objects.bulk_create(PurchaseOrderLine(order=order, **row) for row in rows)

    def create(self, validated_data):
        rows = validated_data.pop("items", [])
        order = super().create(validated_data)
        self._write_lines(order, rows)
        return order

    def update(self, instance, validated_data):
        rows = validated_data.pop("items", None)
        order = super().update(instance, validated_data)
        if rows is not None:
            self._write_lines(order, rows)
        return order


class ReceiveLineSerializer(serializers.Serializer):
    line = serializers.IntegerField()
    quantity = serializers.DecimalField(max_digits=12, decimal_places=3, min_value=Decimal("0.001"))
    lot_number = serializers.CharField(max_length=60, required=False, allow_blank=True)
    expiry_date = serializers.DateField(required=False, allow_null=True)
    unit_cost = serializers.DecimalField(max_digits=12, decimal_places=2, min_value=0, required=False)


class ReceiveSerializer(serializers.Serializer):
    lines = ReceiveLineSerializer(many=True)
    note = serializers.CharField(max_length=255, required=False, allow_blank=True)


class ConsumeLineSerializer(serializers.Serializer):
    item = serializers.IntegerField()
    quantity = serializers.DecimalField(max_digits=12, decimal_places=3, min_value=Decimal("0.001"))
    lot = serializers.IntegerField(required=False, allow_null=True)


class ConsumeSerializer(serializers.Serializer):
    plan_line = serializers.IntegerField(required=False, allow_null=True)
    lab_case = serializers.IntegerField(required=False, allow_null=True)
    branch = serializers.IntegerField()
    lines = ConsumeLineSerializer(many=True, required=False)
    # {item id: lot id} to pick lots for the default materials without listing lines.
    lots = serializers.DictField(child=serializers.IntegerField(), required=False)
    note = serializers.CharField(max_length=255, required=False, allow_blank=True)
    again = serializers.BooleanField(required=False, default=False)


class AdjustSerializer(serializers.Serializer):
    KINDS = [("adjust", "adjust"), ("waste", "waste"), ("return_to_supplier", "return_to_supplier")]
    item = serializers.IntegerField()
    branch = serializers.IntegerField()
    kind = serializers.ChoiceField(choices=KINDS, default="adjust")
    lot = serializers.IntegerField(required=False, allow_null=True)
    lot_number = serializers.CharField(max_length=60, required=False, allow_blank=True)
    expiry_date = serializers.DateField(required=False, allow_null=True)
    counted = serializers.DecimalField(max_digits=12, decimal_places=3, min_value=0, required=False)
    quantity = serializers.DecimalField(max_digits=12, decimal_places=3, required=False)
    unit_cost = serializers.DecimalField(max_digits=12, decimal_places=2, min_value=0, required=False)
    reason = serializers.CharField(max_length=255)

    def validate(self, attrs):
        if ("counted" in attrs) == ("quantity" in attrs):
            raise serializers.ValidationError("Give either the counted quantity or the change.")
        if attrs["kind"] != "adjust" and "counted" in attrs:
            raise serializers.ValidationError({"quantity": "Give the quantity wasted or returned."})
        return attrs


class TransferSerializer(serializers.Serializer):
    item = serializers.IntegerField()
    from_branch = serializers.IntegerField()
    to_branch = serializers.IntegerField()
    quantity = serializers.DecimalField(max_digits=12, decimal_places=3, min_value=Decimal("0.001"))
    lot = serializers.IntegerField(required=False, allow_null=True)
    note = serializers.CharField(max_length=255, required=False, allow_blank=True)
