from rest_framework import serializers

from erp.core.api import ClinicScopedSerializer

from .models import Branch, Chair, Procedure, ProcedureCategory, Room, StaffMember, WorkingHours


class BranchSerializer(ClinicScopedSerializer):
    class Meta:
        model = Branch
        fields = ["id", "name_en", "name_ar", "phone", "address_en", "address_ar", "is_active"]


class RoomSerializer(ClinicScopedSerializer):
    class Meta:
        model = Room
        fields = ["id", "branch", "name_en", "name_ar", "is_active"]


class ChairSerializer(ClinicScopedSerializer):
    class Meta:
        model = Chair
        fields = ["id", "branch", "room", "name_en", "name_ar", "is_active", "sort_order"]

    def validate(self, attrs):
        branch = attrs.get("branch", getattr(self.instance, "branch", None))
        room = attrs.get("room", getattr(self.instance, "room", None))
        if room is not None and branch is not None and room.branch_id != branch.pk:
            raise serializers.ValidationError({"room": "This room is in a different branch."})
        return attrs


class WorkingHoursSerializer(ClinicScopedSerializer):
    class Meta:
        model = WorkingHours
        fields = ["id", "branch", "weekday", "is_closed", "opens_at", "closes_at"]
        validators = []  # uniqueness is checked below with a clearer message

    def validate(self, attrs):
        branch = attrs.get("branch", getattr(self.instance, "branch", None))
        weekday = attrs.get("weekday", getattr(self.instance, "weekday", None))
        qs = WorkingHours.objects.filter(branch=branch, weekday=weekday)
        if self.instance is not None:
            qs = qs.exclude(pk=self.instance.pk)
        if qs.exists():
            raise serializers.ValidationError("This branch already has hours for that day.")
        is_closed = attrs.get("is_closed", getattr(self.instance, "is_closed", False))
        opens = attrs.get("opens_at", getattr(self.instance, "opens_at", None))
        closes = attrs.get("closes_at", getattr(self.instance, "closes_at", None))
        if not is_closed:
            if opens is None or closes is None:
                raise serializers.ValidationError("Give opening and closing times, or mark the day closed.")
            if closes <= opens:
                raise serializers.ValidationError({"closes_at": "Closing time must be after opening time."})
        return attrs


class StaffMemberSerializer(ClinicScopedSerializer):
    class Meta:
        model = StaffMember
        fields = [
            "id",
            "user",
            "name_en",
            "name_ar",
            "staff_type",
            "phone",
            "branches",
            "commission_type",
            "commission_value",
            "color",
            "is_active",
        ]

    def validate(self, attrs):
        kind = attrs.get("commission_type", getattr(self.instance, "commission_type", "none"))
        value = attrs.get("commission_value", getattr(self.instance, "commission_value", 0))
        if kind.startswith("percent") and not (0 <= value <= 100):
            raise serializers.ValidationError({"commission_value": "A percentage must be between 0 and 100."})
        if value < 0:
            raise serializers.ValidationError({"commission_value": "Commission cannot be negative."})
        return attrs


class ProcedureCategorySerializer(ClinicScopedSerializer):
    class Meta:
        model = ProcedureCategory
        fields = ["id", "name_en", "name_ar", "sort_order"]


class ProcedureSerializer(ClinicScopedSerializer):
    class Meta:
        model = Procedure
        fields = [
            "id",
            "code",
            "name_en",
            "name_ar",
            "category",
            "default_price",
            "default_duration_minutes",
            "needs_lab",
            "is_active",
        ]

    def validate_code(self, value):
        clinic_id = self.context["request"].user.clinic_id
        qs = Procedure.objects.filter(clinic_id=clinic_id, code__iexact=value)
        if self.instance is not None:
            qs = qs.exclude(pk=self.instance.pk)
        if qs.exists():
            raise serializers.ValidationError("A procedure with this code already exists.")
        return value

    def validate_default_price(self, value):
        if value < 0:
            raise serializers.ValidationError("Price cannot be negative.")
        return value
