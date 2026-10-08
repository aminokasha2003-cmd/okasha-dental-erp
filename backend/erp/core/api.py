"""Shared API building blocks every module uses.

- ModulePermission checks the user's roles for (module, action).
- ClinicScopedViewSet limits every query to the user's clinic and stamps the
  clinic on new records.
- ClinicScopedSerializer limits related-record choices to the same clinic, so
  one clinic can never point at another clinic's data.
"""

from django.db import models
from rest_framework import permissions, serializers, viewsets
from rest_framework.exceptions import PermissionDenied

from . import audit

ACTION_MAP = {
    "list": "view",
    "retrieve": "view",
    "create": "create",
    "update": "edit",
    "partial_update": "edit",
    "destroy": "delete",
}
METHOD_MAP = {"GET": "view", "HEAD": "view", "OPTIONS": "view", "POST": "create", "PUT": "edit", "PATCH": "edit", "DELETE": "delete"}


class ModulePermission(permissions.BasePermission):
    message = "Your role does not allow this."

    def has_permission(self, request, view):
        user = request.user
        if not (user and user.is_authenticated):
            return False
        if user.clinic_id is None and not user.is_superuser:
            return False
        module = getattr(view, "module", None)
        if module is None:
            return True
        required = getattr(view, "required_actions", {}).get(getattr(view, "action", None))
        if required is None:
            required = ACTION_MAP.get(getattr(view, "action", None)) or METHOD_MAP.get(request.method, "view")
        if required == "view" and getattr(view, "view_module", None) and user.has_module_perm(view.view_module, "view"):
            return True
        return user.has_module_perm(module, required)


class AuditContextMixin:
    """JWT authentication runs inside DRF, after middleware, so set the audit user here."""

    def initial(self, request, *args, **kwargs):
        super().initial(request, *args, **kwargs)
        self._audit_token = audit.set_context(request.user, audit.client_ip(request))

    def finalize_response(self, request, response, *args, **kwargs):
        token = getattr(self, "_audit_token", None)
        if token is not None:
            audit.reset_context(token)
            self._audit_token = None
        return super().finalize_response(request, response, *args, **kwargs)


def require_clinic(user):
    if user.clinic_id is None:
        raise PermissionDenied("Your account is not linked to a clinic.")
    return user.clinic


class ClinicScopedViewSet(AuditContextMixin, viewsets.ModelViewSet):
    permission_classes = [ModulePermission]
    module = None
    required_actions = {}

    def get_queryset(self):
        return self.queryset.filter(clinic=require_clinic(self.request.user))

    def perform_create(self, serializer):
        serializer.save(clinic=require_clinic(self.request.user))


def _has_clinic_field(model):
    try:
        model._meta.get_field("clinic")
        return True
    except Exception:
        return False


class ClinicScopedSerializer(serializers.ModelSerializer):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        request = self.context.get("request")
        clinic_id = getattr(getattr(request, "user", None), "clinic_id", None)
        for field in self.fields.values():
            target = getattr(field, "child_relation", field)
            queryset = getattr(target, "queryset", None)
            if queryset is None or not isinstance(target, serializers.RelatedField):
                continue
            model = queryset.model
            if _has_clinic_field(model):
                target.queryset = queryset.filter(clinic_id=clinic_id)
            elif model._meta.label == "core.Clinic":
                target.queryset = queryset.filter(pk=clinic_id)


def bilingual_name(instance, language):
    if isinstance(instance, models.Model):
        return getattr(instance, "name_ar" if language == "ar" else "name_en", str(instance))
    return str(instance)
