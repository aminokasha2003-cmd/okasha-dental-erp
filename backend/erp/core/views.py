from django.http import FileResponse
from django.utils.dateparse import parse_date
from rest_framework import generics, mixins, permissions, status, viewsets
from rest_framework.decorators import action
from rest_framework.exceptions import ValidationError
from rest_framework.parsers import FormParser, JSONParser, MultiPartParser
from rest_framework.response import Response
from rest_framework.views import APIView

from . import rbac
from .api import AuditContextMixin, ClinicScopedViewSet, ModulePermission, require_clinic
from .models import AuditEntry, Notification, Role, StoredFile, User
from .serializers import (
    AuditEntrySerializer,
    ClinicSerializer,
    MeSerializer,
    NotificationSerializer,
    RoleSerializer,
    StoredFileSerializer,
    UserSerializer,
)


class MetaView(APIView):
    """Modules, actions and choice lists the front end needs to draw forms."""

    def get(self, request):
        lang = request.user.language
        return Response(
            {
                "modules": [{"code": code, "name": str(name)} for code, name in rbac.MODULES.items()],
                "actions": list(rbac.ACTIONS),
                "languages": [{"code": "en", "name": "English"}, {"code": "ar", "name": "العربية"}],
                "language": lang,
            }
        )


class MeView(AuditContextMixin, generics.RetrieveUpdateAPIView):
    serializer_class = MeSerializer
    permission_classes = [permissions.IsAuthenticated]

    def get_object(self):
        return self.request.user


class ClinicView(AuditContextMixin, generics.RetrieveUpdateAPIView):
    serializer_class = ClinicSerializer
    permission_classes = [ModulePermission]
    module = "settings"

    def get_object(self):
        return require_clinic(self.request.user)


class RoleViewSet(ClinicScopedViewSet):
    queryset = Role.objects.prefetch_related("users")
    serializer_class = RoleSerializer
    module = "users"

    def perform_destroy(self, instance):
        if instance.is_system:
            raise ValidationError("Built-in roles cannot be deleted. You can change their permissions instead.")
        if instance.users.exists():
            raise ValidationError("Remove this role from its users before deleting it.")
        instance.delete()


class UserViewSet(ClinicScopedViewSet):
    queryset = User.objects.prefetch_related("roles").order_by("first_name", "username")
    serializer_class = UserSerializer
    module = "users"

    def destroy(self, request, *args, **kwargs):
        """Users are never hard-deleted (the audit log points at them); deactivate instead."""
        user = self.get_object()
        if user.pk == request.user.pk:
            raise ValidationError("You cannot deactivate your own account.")
        user.is_active = False
        user.save(update_fields=["is_active"])
        return Response(status=status.HTTP_204_NO_CONTENT)


class AuditEntryViewSet(AuditContextMixin, viewsets.ReadOnlyModelViewSet):
    serializer_class = AuditEntrySerializer
    permission_classes = [ModulePermission]
    module = "audit"

    def get_queryset(self):
        qs = AuditEntry.objects.filter(clinic=require_clinic(self.request.user)).select_related("user", "content_type")
        params = self.request.query_params
        if params.get("record_type"):
            try:
                app_label, model = params["record_type"].lower().split(".")
            except ValueError as exc:
                raise ValidationError({"record_type": "Use app.model, for example masterdata.chair."}) from exc
            qs = qs.filter(content_type__app_label=app_label, content_type__model=model)
        if params.get("object_id"):
            qs = qs.filter(object_id=params["object_id"])
        if params.get("user"):
            qs = qs.filter(user_id=params["user"])
        if params.get("action"):
            qs = qs.filter(action=params["action"])
        if params.get("date_from") and parse_date(params["date_from"]):
            qs = qs.filter(timestamp__date__gte=parse_date(params["date_from"]))
        if params.get("date_to") and parse_date(params["date_to"]):
            qs = qs.filter(timestamp__date__lte=parse_date(params["date_to"]))
        return qs


class StoredFileViewSet(ClinicScopedViewSet):
    queryset = StoredFile.objects.select_related("attached_type", "created_by")
    serializer_class = StoredFileSerializer
    parser_classes = [MultiPartParser, FormParser, JSONParser]
    http_method_names = ["get", "post", "patch", "delete", "head", "options"]
    module = "files"
    required_actions = {"download": "view"}

    def get_queryset(self):
        qs = super().get_queryset()
        params = self.request.query_params
        if params.get("attached_model") and params.get("attached_id"):
            try:
                app_label, model = params["attached_model"].lower().split(".")
            except ValueError as exc:
                raise ValidationError({"attached_model": "Use app.model."}) from exc
            qs = qs.filter(
                attached_type__app_label=app_label, attached_type__model=model, attached_id=params["attached_id"]
            )
        if params.get("kind"):
            qs = qs.filter(kind=params["kind"])
        return qs

    @action(detail=True, methods=["get"])
    def download(self, request, pk=None):
        stored = self.get_object()
        return FileResponse(
            stored.file.open("rb"), as_attachment=False, filename=stored.original_name, content_type=stored.content_type_header
        )

    def perform_destroy(self, instance):
        instance.file.delete(save=False)
        instance.delete()


class NotificationViewSet(AuditContextMixin, mixins.ListModelMixin, viewsets.GenericViewSet):
    """The signed-in user's in-app notifications."""

    serializer_class = NotificationSerializer
    permission_classes = [permissions.IsAuthenticated]

    def get_queryset(self):
        return Notification.objects.filter(recipient_user=self.request.user, channel="in_app")

    @action(detail=True, methods=["post"])
    def read(self, request, pk=None):
        notification = self.get_queryset().filter(pk=pk).first()
        if notification is None:
            return Response(status=status.HTTP_404_NOT_FOUND)
        notification.status = "read"
        notification.save(update_fields=["status", "updated_at"])
        return Response(NotificationSerializer(notification).data)
