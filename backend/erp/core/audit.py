"""Automatic audit log.

Every save or delete of a clinic record, a clinic, a role or a user writes an
AuditEntry with the old and new values. The acting user and IP come from the
request through a context variable set by AuditContextMiddleware (and by the
API views, since JWT authentication runs after middleware).
"""

import contextvars
import datetime
import decimal
import uuid

from django.contrib.contenttypes.models import ContentType
from django.db import models
from django.db.models.signals import m2m_changed, post_delete, post_save, pre_save
from django.dispatch import receiver

_context = contextvars.ContextVar("audit_context", default=None)

# Fields whose values never go into the log.
SECRET_FIELDS = {"password"}
# Fields that change on their own and would only add noise.
IGNORED_FIELDS = {"last_login", "created_at", "updated_at", "created_by", "updated_by"}


def set_context(user=None, ip=None):
    return _context.set({"user": user, "ip": ip})


def reset_context(token):
    _context.reset(token)


def current_user():
    ctx = _context.get()
    user = ctx and ctx.get("user")
    return user if user is not None and getattr(user, "is_authenticated", False) else None


def current_ip():
    ctx = _context.get()
    return ctx and ctx.get("ip")


def client_ip(request):
    forwarded = request.META.get("HTTP_X_FORWARDED_FOR")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.META.get("REMOTE_ADDR")


class AuditContextMiddleware:
    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        token = set_context(getattr(request, "user", None), client_ip(request))
        try:
            return self.get_response(request)
        finally:
            reset_context(token)


def is_audited(instance):
    from .models import AuditEntry, ClinicScopedModel, Clinic, Notification, Role, User

    if isinstance(instance, (AuditEntry, Notification)):
        return False
    return isinstance(instance, (ClinicScopedModel, Clinic, Role, User))


def _jsonable(value):
    if value is None or isinstance(value, (bool, int, float, str)):
        return value
    if isinstance(value, (decimal.Decimal, uuid.UUID)):
        return str(value)
    if isinstance(value, (datetime.date, datetime.datetime, datetime.time)):
        return value.isoformat()
    if isinstance(value, (list, tuple)):
        return [_jsonable(v) for v in value]
    if isinstance(value, dict):
        return {str(k): _jsonable(v) for k, v in value.items()}
    if hasattr(value, "name"):  # FieldFile
        return value.name
    return str(value)


def snapshot(instance):
    data = {}
    for field in instance._meta.concrete_fields:
        if field.name in IGNORED_FIELDS:
            continue
        key = field.attname if isinstance(field, models.ForeignKey) else field.name
        data[field.name] = _jsonable(getattr(instance, key))
    return data


def _clinic_id(instance):
    from .models import Clinic

    if isinstance(instance, Clinic):
        return instance.pk
    return getattr(instance, "clinic_id", None)


def write_entry(instance, action, changes):
    from .models import AuditEntry

    AuditEntry.objects.create(
        clinic_id=_clinic_id(instance),
        user=current_user(),
        action=action,
        content_type=ContentType.objects.get_for_model(instance.__class__),
        object_id=str(instance.pk),
        object_repr=str(instance)[:255],
        changes=changes,
        ip_address=current_ip(),
    )


def _diff(old, new):
    changes = {}
    for name in set(old) | set(new):
        before, after = old.get(name), new.get(name)
        if before != after:
            if name in SECRET_FIELDS:
                changes[name] = ["(hidden)", "(hidden)"]
            else:
                changes[name] = [before, after]
    return changes


@receiver(pre_save)
def _before_save(sender, instance, raw=False, **kwargs):
    if raw or not is_audited(instance):
        return
    from .models import ClinicScopedModel

    user = current_user()
    if isinstance(instance, ClinicScopedModel) and user is not None:
        if instance._state.adding and instance.created_by_id is None:
            instance.created_by = user
        instance.updated_by = user
    old = None
    if not instance._state.adding and instance.pk is not None:
        previous = sender._default_manager.filter(pk=instance.pk).first()
        if previous is not None:
            old = snapshot(previous)
    instance._audit_old = old


@receiver(post_save)
def _after_save(sender, instance, created, raw=False, **kwargs):
    if raw or not is_audited(instance):
        return
    new = snapshot(instance)
    old = getattr(instance, "_audit_old", None)
    if created or old is None:
        changes = {k: [None, v] for k, v in new.items() if v not in (None, "", [], {})}
        for name in SECRET_FIELDS & set(changes):
            changes[name] = [None, "(hidden)"]
        write_entry(instance, "create", changes)
    else:
        changes = _diff(old, new)
        if changes:
            write_entry(instance, "update", changes)
    instance._audit_old = None


@receiver(post_delete)
def _after_delete(sender, instance, **kwargs):
    if not is_audited(instance):
        return
    old = snapshot(instance)
    for name in SECRET_FIELDS & set(old):
        old[name] = "(hidden)"
    write_entry(instance, "delete", {k: [v, None] for k, v in old.items()})


@receiver(m2m_changed)
def _m2m_changed(sender, instance, action, reverse, model, pk_set, **kwargs):
    """Log role assignments (and any other many-to-many on an audited record)."""
    if reverse or action not in {"pre_add", "pre_remove", "pre_clear", "post_add", "post_remove", "post_clear"}:
        return
    if not is_audited(instance):
        return
    field = next((f for f in instance._meta.many_to_many if f.remote_field.through is sender), None)
    if field is None:
        return
    if action.startswith("pre_"):
        instance._audit_m2m_before = sorted(getattr(instance, field.name).values_list("pk", flat=True))
        return
    before = getattr(instance, "_audit_m2m_before", [])
    after = sorted(getattr(instance, field.name).values_list("pk", flat=True))
    if before != after:
        write_entry(instance, "update", {field.name: [before, after]})
