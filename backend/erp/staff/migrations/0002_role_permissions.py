"""Give the built-in roles of existing clinics the phase 6 staff and payroll rights.

Only roles still on the old default for staff are changed, so anything the
owner set by hand is kept. The owner already has every right."""

from django.db import migrations

ACTIONS = ("view", "create", "edit", "delete", "approve")
OLD = {"accountant": ["view", "edit"]}
NEW = {"accountant": ["view", "create", "edit", "approve"]}


def apply(apps, schema_editor, source, target):
    Role = apps.get_model("core", "Role")
    for role in Role.objects.filter(is_system=True, code__in=target):
        permissions = dict(role.permissions or {})
        if sorted(permissions.get("staff", [])) != sorted(source[role.code]):
            continue
        if target[role.code]:
            permissions["staff"] = [a for a in ACTIONS if a in target[role.code]]
        else:
            permissions.pop("staff", None)
        role.permissions = permissions
        role.save(update_fields=["permissions", "updated_at"])


def forwards(apps, schema_editor):
    apply(apps, schema_editor, OLD, NEW)


def backwards(apps, schema_editor):
    apply(apps, schema_editor, NEW, OLD)


class Migration(migrations.Migration):
    dependencies = [
        ("core", "0001_initial"),
        ("staff", "0001_initial"),
    ]

    operations = [migrations.RunPython(forwards, backwards)]
