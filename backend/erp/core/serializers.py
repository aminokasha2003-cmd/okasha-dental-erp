from django.conf import settings
from django.contrib.auth.password_validation import validate_password
from django.contrib.contenttypes.models import ContentType
from rest_framework import serializers

from . import rbac
from .api import ClinicScopedSerializer
from .models import AuditEntry, Clinic, Notification, Role, StoredFile, User


class ClinicSerializer(serializers.ModelSerializer):
    class Meta:
        model = Clinic
        fields = [
            "id",
            "name_en",
            "name_ar",
            "phone",
            "email",
            "address_en",
            "address_ar",
            "currency",
            "default_language",
            "tooth_numbering",
            "tax_registration_number",
            "commercial_register",
            "tax_rate",
            "updated_at",
        ]
        read_only_fields = ["id", "updated_at"]


class RoleSerializer(serializers.ModelSerializer):
    user_count = serializers.IntegerField(source="users.count", read_only=True)

    class Meta:
        model = Role
        fields = ["id", "code", "name_en", "name_ar", "permissions", "is_system", "user_count"]
        read_only_fields = ["id", "is_system", "user_count"]

    def validate_permissions(self, value):
        try:
            return rbac.normalize_permissions(value)
        except ValueError as exc:
            raise serializers.ValidationError(str(exc)) from exc

    def validate_code(self, value):
        clinic_id = self.context["request"].user.clinic_id
        qs = Role.objects.filter(clinic_id=clinic_id, code=value)
        if self.instance is not None:
            qs = qs.exclude(pk=self.instance.pk)
        if qs.exists():
            raise serializers.ValidationError("A role with this code already exists.")
        return value

    def update(self, instance, validated_data):
        # Built-in roles keep their code so the defaults can always be found.
        if instance.is_system:
            validated_data.pop("code", None)
        return super().update(instance, validated_data)


class UserSerializer(ClinicScopedSerializer):
    roles = serializers.PrimaryKeyRelatedField(many=True, queryset=Role.objects.all(), required=False)
    password = serializers.CharField(write_only=True, required=False, style={"input_type": "password"})

    class Meta:
        model = User
        fields = [
            "id",
            "username",
            "first_name",
            "last_name",
            "email",
            "phone",
            "language",
            "roles",
            "is_active",
            "last_login",
            "date_joined",
            "password",
        ]
        read_only_fields = ["id", "last_login", "date_joined"]

    def validate_username(self, value):
        qs = User.objects.filter(username__iexact=value)
        if self.instance is not None:
            qs = qs.exclude(pk=self.instance.pk)
        if qs.exists():
            raise serializers.ValidationError("This username is taken.")
        return value

    def validate(self, attrs):
        password = attrs.get("password")
        if self.instance is None and not password:
            raise serializers.ValidationError({"password": "A password is required for a new user."})
        if password:
            candidate = self.instance or User(username=attrs.get("username", ""), email=attrs.get("email", ""))
            validate_password(password, candidate)
        request = self.context["request"]
        if self.instance is not None and self.instance.pk == request.user.pk:
            if attrs.get("is_active") is False:
                raise serializers.ValidationError({"is_active": "You cannot deactivate your own account."})
            if "roles" in attrs and not any(r.allows("users", "edit") for r in attrs["roles"]) and not request.user.is_superuser:
                raise serializers.ValidationError({"roles": "You would lose access to users and roles."})
        return attrs

    def create(self, validated_data):
        roles = validated_data.pop("roles", [])
        password = validated_data.pop("password")
        user = User(**validated_data)
        user.set_password(password)
        user.save()
        user.roles.set(roles)
        return user

    def update(self, instance, validated_data):
        roles = validated_data.pop("roles", None)
        password = validated_data.pop("password", None)
        for key, value in validated_data.items():
            setattr(instance, key, value)
        if password:
            instance.set_password(password)
        instance.save()
        if roles is not None:
            instance.roles.set(roles)
        return instance


class MeSerializer(serializers.ModelSerializer):
    clinic = ClinicSerializer(read_only=True)
    permissions = serializers.SerializerMethodField()
    roles = serializers.SerializerMethodField()

    class Meta:
        model = User
        fields = ["id", "username", "first_name", "last_name", "email", "phone", "language", "clinic", "roles", "permissions"]
        read_only_fields = ["id", "username", "clinic", "roles", "permissions"]

    def get_permissions(self, obj):
        return obj.module_permissions()

    def get_roles(self, obj):
        return [{"id": r.id, "code": r.code, "name_en": r.name_en, "name_ar": r.name_ar} for r in obj.roles.all()]


class AuditEntrySerializer(serializers.ModelSerializer):
    user_name = serializers.SerializerMethodField()
    record_type = serializers.SerializerMethodField()

    class Meta:
        model = AuditEntry
        fields = ["id", "timestamp", "user", "user_name", "action", "record_type", "object_id", "object_repr", "changes", "ip_address"]

    def get_user_name(self, obj):
        if obj.user is None:
            return None
        return obj.user.get_full_name() or obj.user.username

    def get_record_type(self, obj):
        return f"{obj.content_type.app_label}.{obj.content_type.model}"


class StoredFileSerializer(serializers.ModelSerializer):
    attached_model = serializers.CharField(write_only=True, required=False, allow_blank=True)
    attached_to = serializers.SerializerMethodField()
    uploaded_by = serializers.SerializerMethodField()
    download_url = serializers.SerializerMethodField()

    class Meta:
        model = StoredFile
        fields = [
            "id",
            "file",
            "download_url",
            "original_name",
            "content_type_header",
            "size",
            "kind",
            "description",
            "attached_model",
            "attached_id",
            "attached_to",
            "uploaded_by",
            "created_at",
        ]
        read_only_fields = ["id", "original_name", "content_type_header", "size", "attached_to", "uploaded_by", "created_at"]
        # Patient files are never served from a public URL, only through the
        # permission-checked download endpoint.
        extra_kwargs = {"file": {"write_only": True}}

    def get_download_url(self, obj):
        return f"/api/files/{obj.pk}/download/"

    def get_attached_to(self, obj):
        if obj.attached_type_id is None:
            return None
        return {"model": f"{obj.attached_type.app_label}.{obj.attached_type.model}", "id": obj.attached_id}

    def get_uploaded_by(self, obj):
        return obj.created_by.get_full_name() or obj.created_by.username if obj.created_by else None

    def validate_file(self, value):
        limit = settings.MAX_UPLOAD_MB * 1024 * 1024
        if value.size > limit:
            raise serializers.ValidationError(f"Files must be {settings.MAX_UPLOAD_MB} MB or smaller.")
        content_type = getattr(value, "content_type", "") or "application/octet-stream"
        if content_type not in settings.ALLOWED_UPLOAD_TYPES:
            raise serializers.ValidationError(f"Files of type {content_type} are not allowed.")
        return value

    def validate(self, attrs):
        label = attrs.pop("attached_model", "") or ""
        object_id = attrs.get("attached_id", "")
        if bool(label) != bool(object_id):
            raise serializers.ValidationError("Give both attached_model and attached_id, or neither.")
        if label:
            try:
                app_label, model = label.lower().split(".")
                ctype = ContentType.objects.get(app_label=app_label, model=model)
            except (ValueError, ContentType.DoesNotExist) as exc:
                raise serializers.ValidationError({"attached_model": "Unknown record type."}) from exc
            model_class = ctype.model_class()
            clinic_id = self.context["request"].user.clinic_id
            lookup = {"pk": object_id}
            if any(f.name == "clinic" for f in model_class._meta.fields):
                lookup["clinic_id"] = clinic_id
            elif model_class is not None and model_class._meta.label == "core.Clinic":
                lookup["pk"] = clinic_id if str(clinic_id) == str(object_id) else None
            else:
                raise serializers.ValidationError({"attached_model": "Files cannot be attached to this record type."})
            if not model_class._default_manager.filter(**lookup).exists():
                raise serializers.ValidationError({"attached_id": "Record not found."})
            attrs["attached_type"] = ctype
        return attrs

    def create(self, validated_data):
        upload = validated_data["file"]
        validated_data["original_name"] = upload.name[:255]
        validated_data["content_type_header"] = getattr(upload, "content_type", "") or "application/octet-stream"
        validated_data["size"] = upload.size
        return super().create(validated_data)


class NotificationSerializer(serializers.ModelSerializer):
    class Meta:
        model = Notification
        fields = ["id", "channel", "subject", "body", "status", "created_at", "sent_at"]
        read_only_fields = fields
