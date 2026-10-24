from decimal import Decimal

from django.utils import timezone
from rest_framework import serializers

from erp.billing.serializers import patient_info
from erp.core.api import ClinicScopedSerializer

from . import services
from .models import (
    BookingRequest,
    BookingSettings,
    ComplianceSettings,
    DailyChecklist,
    EInvoiceDocument,
    EInvoiceSettings,
    Equipment,
    InstrumentPack,
    Licence,
    MaintenancePlan,
    MaintenanceRecord,
    SterilizationCycle,
    WorkOrder,
    WorkOrderPart,
)


def money(value):
    return f"{Decimal(value or 0):.2f}"


def named(obj):
    return {"id": obj.pk, "en": obj.name_en, "ar": obj.name_ar} if obj else None


def local_dt(value):
    return timezone.localtime(value).isoformat() if value else None


class ComplianceSettingsSerializer(serializers.ModelSerializer):
    class Meta:
        model = ComplianceSettings
        fields = ["pack_shelf_days", "bi_every_days", "licence_warn_days", "maintenance_warn_days"]


# ------------------------------------------------------------ equipment


class EquipmentSerializer(ClinicScopedSerializer):
    branch_name = serializers.SerializerMethodField()
    chair_name = serializers.SerializerMethodField()
    supplier_name = serializers.CharField(source="supplier.name", read_only=True, default="")
    cycle_count = serializers.SerializerMethodField()
    open_work_orders = serializers.SerializerMethodField()
    warranty_active = serializers.SerializerMethodField()

    class Meta:
        model = Equipment
        fields = [
            "id", "code", "name_en", "name_ar", "category", "branch", "branch_name", "chair", "chair_name", "manufacturer",
            "model_name", "serial_number", "supplier", "supplier_name", "purchase_date", "cost", "warranty_end",
            "warranty_active", "status", "cycles_before", "cycle_count", "open_work_orders", "notes",
        ]
        read_only_fields = ["id"]
        extra_kwargs = {"code": {"required": False}}

    def get_branch_name(self, obj):
        return named(obj.branch)

    def get_chair_name(self, obj):
        return named(obj.chair)

    def get_cycle_count(self, obj):
        counts = self.context.get("cycle_counts")
        if obj.category != "autoclave":
            return None
        return counts.get(obj.pk, obj.cycles_before) if counts is not None else services.cycle_counts(obj.clinic, [obj.pk]).get(obj.pk)

    def get_open_work_orders(self, obj):
        open_map = self.context.get("open_orders")
        if open_map is not None:
            return open_map.get(obj.pk, 0)
        return obj.work_orders.filter(status__in=WorkOrder.OPEN).count()

    def get_warranty_active(self, obj):
        return bool(obj.warranty_end and obj.warranty_end >= timezone.localdate())

    def validate(self, attrs):
        branch = attrs.get("branch", getattr(self.instance, "branch", None))
        chair = attrs.get("chair", getattr(self.instance, "chair", None))
        if chair is not None and branch is not None and chair.branch_id != branch.pk:
            raise serializers.ValidationError({"chair": "This chair is in a different branch."})
        return attrs


class MaintenancePlanSerializer(ClinicScopedSerializer):
    equipment_info = serializers.SerializerMethodField()
    due = serializers.SerializerMethodField()

    class Meta:
        model = MaintenancePlan
        fields = [
            "id", "equipment", "equipment_info", "title_en", "title_ar", "kind", "every_months", "every_days", "every_cycles",
            "start_on", "last_done_on", "last_done_cycles", "vendor", "is_active", "due",
        ]
        read_only_fields = ["id", "last_done_cycles"]

    def get_equipment_info(self, obj):
        e = obj.equipment
        return {"id": e.pk, "code": e.code, "en": e.name_en, "ar": e.name_ar, "category": e.category, "status": e.status, "branch": named(e.branch)}

    def get_due(self, obj):
        due = (self.context.get("due") or {}).get(obj.pk)
        if due is None:
            due = services.plan_due(obj, services.cycle_counts(obj.clinic, [obj.equipment_id]))
        return {"date": due["due_date"], "cycles_left": due["cycles_left"], "state": due["state"]}

    def validate(self, attrs):
        get = lambda k: attrs.get(k, getattr(self.instance, k, None))  # noqa: E731
        if not (get("every_months") or get("every_days") or get("every_cycles")):
            raise serializers.ValidationError({"every_months": "Give how often: months, days or cycles."})
        equipment = get("equipment")
        if get("every_cycles") and equipment is not None and equipment.category != "autoclave":
            raise serializers.ValidationError({"every_cycles": "Cycle counts are only kept for autoclaves."})
        return attrs


class WorkOrderPartSerializer(serializers.ModelSerializer):
    item_name = serializers.SerializerMethodField()
    unit = serializers.CharField(source="item.unit", read_only=True)

    class Meta:
        model = WorkOrderPart
        fields = ["id", "item", "item_name", "unit", "branch", "quantity", "cost", "created_at"]

    def get_item_name(self, obj):
        return named(obj.item)


class WorkOrderSerializer(ClinicScopedSerializer):
    equipment_info = serializers.SerializerMethodField()
    reported_by_name = serializers.SerializerMethodField()
    parts = WorkOrderPartSerializer(many=True, read_only=True)
    parts_cost = serializers.SerializerMethodField()
    total_cost = serializers.SerializerMethodField()
    downtime_hours = serializers.ReadOnlyField()

    class Meta:
        model = WorkOrder
        fields = [
            "id", "number", "equipment", "equipment_info", "kind", "plan", "reported_by_name", "reported_at", "issue", "priority",
            "status", "takes_out_of_service", "assigned_to", "supplier", "labour_cost", "completed_at", "resolution", "parts",
            "parts_cost", "total_cost", "downtime_hours",
        ]
        read_only_fields = ["id", "number", "reported_at", "completed_at", "status"]

    def get_equipment_info(self, obj):
        e = obj.equipment
        return {"id": e.pk, "code": e.code, "en": e.name_en, "ar": e.name_ar, "category": e.category, "status": e.status, "branch": named(e.branch)}

    def get_reported_by_name(self, obj):
        u = obj.reported_by
        return (u.get_full_name() or u.username) if u else ""

    def get_parts_cost(self, obj):
        return money(sum((p.cost for p in obj.parts.all()), Decimal("0")))

    def get_total_cost(self, obj):
        return money(sum((p.cost for p in obj.parts.all()), Decimal("0")) + obj.labour_cost)


class MaintenanceRecordSerializer(serializers.ModelSerializer):
    equipment_info = serializers.SerializerMethodField()
    plan_title = serializers.SerializerMethodField()
    work_order_number = serializers.CharField(source="work_order.number", read_only=True, default="")

    class Meta:
        model = MaintenanceRecord
        fields = ["id", "equipment", "equipment_info", "plan", "plan_title", "work_order", "work_order_number", "done_on", "performed_by", "cost", "cycle_count", "notes"]

    def get_equipment_info(self, obj):
        return {"id": obj.equipment_id, "code": obj.equipment.code, "en": obj.equipment.name_en, "ar": obj.equipment.name_ar}

    def get_plan_title(self, obj):
        return {"en": obj.plan.title_en, "ar": obj.plan.title_ar} if obj.plan_id else None


class LicenceSerializer(ClinicScopedSerializer):
    state = serializers.SerializerMethodField()
    days_left = serializers.SerializerMethodField()
    equipment_name = serializers.SerializerMethodField()
    staff_name = serializers.SerializerMethodField()
    branch_name = serializers.SerializerMethodField()

    class Meta:
        model = Licence
        fields = [
            "id", "kind", "title_en", "title_ar", "branch", "branch_name", "equipment", "equipment_name", "staff", "staff_name",
            "reference", "authority", "issued_on", "expires_on", "last_reading_msv", "notes", "state", "days_left",
        ]
        read_only_fields = ["id"]

    def get_state(self, obj):
        return services.licence_state(obj, warn_days=self.context.get("warn_days", 60))

    def get_days_left(self, obj):
        return (obj.expires_on - timezone.localdate()).days

    def get_equipment_name(self, obj):
        return named(obj.equipment)

    def get_staff_name(self, obj):
        return named(obj.staff)

    def get_branch_name(self, obj):
        return named(obj.branch)


# ------------------------------------------------------------ sterilisation


class InstrumentPackSerializer(ClinicScopedSerializer):
    state = serializers.SerializerMethodField()
    last = serializers.SerializerMethodField()
    branch_name = serializers.SerializerMethodField()

    class Meta:
        model = InstrumentPack
        fields = ["id", "code", "name_en", "name_ar", "kind", "branch", "branch_name", "contents", "is_active", "state", "last"]
        read_only_fields = ["id"]

    def _load(self, obj):
        latest = self.context.get("latest")
        if latest is not None:
            return latest.get(obj.pk)
        return services.latest_loads(obj.clinic, [obj.pk]).get(obj.pk)

    def get_state(self, obj):
        return services.pack_state(self._load(obj))

    def get_last(self, obj):
        load = self._load(obj)
        if load is None:
            return None
        return {
            "cycle": load.cycle_id, "cycle_number": load.cycle.cycle_number, "machine": load.cycle.machine.name_en,
            "sterilised_at": local_dt(load.cycle.started_at), "expires_on": load.expires_on, "used_at": local_dt(load.used_at),
            "patient": patient_info(load.patient) if load.patient_id else None,
        }

    def get_branch_name(self, obj):
        return named(obj.branch)

    def validate_code(self, value):
        value = value.strip().upper()
        if not value:
            raise serializers.ValidationError("Give the pack a code.")
        return value


def load_out(load):
    return {
        "id": load.pk,
        "pack": {"id": load.pack_id, "code": load.pack.code, "en": load.pack.name_en, "ar": load.pack.name_ar, "kind": load.pack.kind},
        "expires_on": load.expires_on,
        "used_at": local_dt(load.used_at),
        "patient": patient_info(load.patient) if load.patient_id else None,
        "appointment": (
            {"id": load.appointment_id, "start": local_dt(load.appointment.start), "dentist": named(load.appointment.dentist)}
            if load.appointment_id else None
        ),
        "recall_contacted_at": local_dt(load.recall_contacted_at),
        "recall_note": load.recall_note,
    }


class CycleSerializer(ClinicScopedSerializer):
    machine_name = serializers.SerializerMethodField()
    operator_name = serializers.SerializerMethodField()
    pack_count = serializers.SerializerMethodField()
    used_count = serializers.SerializerMethodField()
    packs = serializers.ListField(child=serializers.CharField(), write_only=True, required=False, default=list)
    cycle_number = serializers.IntegerField(required=False, min_value=1)

    class Meta:
        model = SterilizationCycle
        fields = [
            "id", "machine", "machine_name", "branch", "cycle_number", "started_at", "program", "temperature", "pressure",
            "hold_minutes", "duration_minutes", "operator", "operator_name", "air_removal_test", "air_removal_result",
            "chemical_indicator", "bi_used", "bi_lot", "bi_result", "bi_read_at", "result", "failure_reasons", "printout",
            "notes", "pack_count", "used_count", "packs",
        ]
        read_only_fields = ["id", "result", "failure_reasons", "bi_read_at", "branch"]
        validators = []  # the cycle number is given by the view, which checks it is free

    def get_machine_name(self, obj):
        return named(obj.machine)

    def get_operator_name(self, obj):
        return named(obj.operator)

    def get_pack_count(self, obj):
        return getattr(obj, "n_packs", None) if hasattr(obj, "n_packs") else obj.loads.count()

    def get_used_count(self, obj):
        return getattr(obj, "n_used", None) if hasattr(obj, "n_used") else obj.loads.filter(used_at__isnull=False).count()

    def validate(self, attrs):
        machine = attrs.get("machine", getattr(self.instance, "machine", None))
        if machine is not None and machine.category != "autoclave":
            raise serializers.ValidationError({"machine": "Choose an autoclave."})
        if machine is not None and machine.status != "in_service":
            raise serializers.ValidationError({"machine": "This autoclave is marked out of service."})
        program = attrs.get("program", getattr(self.instance, "program", None))
        if program in SterilizationCycle.TEST_PROGRAMS and attrs.get("packs"):
            raise serializers.ValidationError({"packs": "Test cycles run empty; do not load packs."})
        return attrs


class CycleDetailSerializer(CycleSerializer):
    loads = serializers.SerializerMethodField()

    class Meta(CycleSerializer.Meta):
        fields = CycleSerializer.Meta.fields + ["loads"]

    def get_loads(self, obj):
        loads = obj.loads.select_related("pack", "patient", "appointment__dentist").order_by("pack__code")
        return [load_out(ld) for ld in loads]


class ChecklistSerializer(ClinicScopedSerializer):
    done_by_name = serializers.SerializerMethodField()

    class Meta:
        model = DailyChecklist
        fields = ["id", "branch", "date", "items", "done_by", "done_by_name", "notes"]
        read_only_fields = ["id"]

    def get_done_by_name(self, obj):
        return named(obj.done_by)

    def validate_items(self, value):
        if not isinstance(value, dict):
            raise serializers.ValidationError("Send the ticked items as an object.")
        return {k: bool(v) for k, v in value.items() if k in DailyChecklist.ITEMS}


# ------------------------------------------------------------ e-invoicing


class EInvoiceSettingsSerializer(serializers.ModelSerializer):
    client_secret = serializers.CharField(write_only=True, required=False, allow_blank=True)
    has_secret = serializers.ReadOnlyField()
    live_ready = serializers.ReadOnlyField()

    class Meta:
        model = EInvoiceSettings
        fields = [
            "is_registered", "mode", "environment", "rin", "issuer_name", "activity_code", "default_tax_rate", "exempt_subtype",
            "taxed_subtype", "person_id_threshold", "start_date", "default_item_type", "default_item_code", "governate",
            "region_city", "street", "building_number", "postal_code", "client_id", "client_secret", "has_secret",
            "signer_url", "live_ready",
        ]

    def validate_rin(self, value):
        value = "".join(ch for ch in value if ch.isdigit())
        if value and len(value) != 9:
            raise serializers.ValidationError("The RIN is 9 digits.")
        return value

    def update(self, instance, validated):
        from .eta import encrypt_secret  # noqa: PLC0415

        secret = validated.pop("client_secret", None)
        if secret is not None and secret != "":
            instance.client_secret_enc = encrypt_secret(secret)
        return super().update(instance, validated)


class EInvoiceDocumentSerializer(serializers.ModelSerializer):
    invoice_info = serializers.SerializerMethodField()
    url = serializers.SerializerMethodField()
    needs_cancel = serializers.SerializerMethodField()

    class Meta:
        model = EInvoiceDocument
        fields = [
            "id", "invoice", "invoice_info", "status", "errors", "receiver_type", "total_amount", "tax_amount", "uuid", "long_id",
            "submission_id", "simulated", "attempts", "prepared_at", "submitted_at", "validated_at", "cancelled_at",
            "cancel_reason", "url", "needs_cancel",
        ]

    def get_invoice_info(self, obj):
        inv = obj.invoice
        return {
            "id": inv.pk, "number": inv.number, "issue_date": inv.issue_date, "status": inv.status,
            "patient": patient_info(inv.patient), "branch": named(inv.branch),
        }

    def get_url(self, obj):
        conf = self.context.get("conf") or EInvoiceSettings.for_clinic(obj.clinic)
        return services.doc_url(obj, conf)

    def get_needs_cancel(self, obj):
        return obj.status == "valid" and obj.invoice.status == "void"


# ------------------------------------------------------------ booking


class BookingSettingsSerializer(serializers.ModelSerializer):
    class Meta:
        model = BookingSettings
        fields = ["enabled", "slug", "days_ahead", "min_notice_hours", "slot_minutes", "allow_dentist_choice", "message_en", "message_ar", "services", "branches"]

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        clinic_id = getattr(self.instance, "clinic_id", None)
        for name in ("services", "branches"):
            field = self.fields[name].child_relation
            field.queryset = field.queryset.filter(clinic_id=clinic_id)

    def validate_slug(self, value):
        value = (value or "").strip().lower() or None
        if value and BookingSettings.objects.filter(slug=value).exclude(pk=self.instance.pk).exists():
            raise serializers.ValidationError("Another clinic uses this address. Choose another.")
        return value

    def validate_slot_minutes(self, value):
        if value < 10 or value > 120:
            raise serializers.ValidationError("Between 10 and 120 minutes.")
        return value

    def validate(self, attrs):
        if attrs.get("enabled", self.instance.enabled) and not attrs.get("slug", self.instance.slug):
            raise serializers.ValidationError({"slug": "Choose the page address before turning booking on."})
        return attrs


class BookingRequestSerializer(serializers.ModelSerializer):
    branch_name = serializers.SerializerMethodField()
    procedure_name = serializers.SerializerMethodField()
    dentist_name = serializers.SerializerMethodField()
    patient_info = serializers.SerializerMethodField()
    known_patient = serializers.SerializerMethodField()
    decided_by_name = serializers.SerializerMethodField()
    end = serializers.ReadOnlyField()

    class Meta:
        model = BookingRequest
        fields = [
            "id", "reference", "branch", "branch_name", "procedure", "procedure_name", "dentist", "dentist_name", "dentist_chosen",
            "start", "end", "duration_minutes", "name", "phone", "note", "language", "status", "patient", "patient_info",
            "known_patient", "appointment", "decided_by_name", "decided_at", "reject_reason", "created_at",
        ]

    def get_branch_name(self, obj):
        return named(obj.branch)

    def get_procedure_name(self, obj):
        return named(obj.procedure)

    def get_dentist_name(self, obj):
        return named(obj.dentist)

    def get_patient_info(self, obj):
        return patient_info(obj.patient) if obj.patient_id else None

    def get_known_patient(self, obj):
        if obj.status != "pending":
            return None
        from erp.patients.models import Patient  # noqa: PLC0415

        tail = obj.phone.lstrip("+")[-10:]
        p = Patient.objects.filter(clinic_id=obj.clinic_id, phone__endswith=tail, is_active=True).order_by("id").first() if tail else None
        return patient_info(p) if p else None

    def get_decided_by_name(self, obj):
        u = obj.decided_by
        return (u.get_full_name() or u.username) if u else ""
