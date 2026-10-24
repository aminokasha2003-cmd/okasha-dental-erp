"""Give the built-in receptionist roles of existing clinics the phase 7 CRM
rights (leads, recalls, campaigns, feedback).

Only roles still on the old default for crm (none) are changed, so anything the
owner set by hand is kept. The owner already has every right, and the
accountant already had "reports: view"."""

from django.db import migrations

ACTIONS = ("view", "create", "edit", "delete", "approve")
OLD = {"receptionist": []}
NEW = {"receptionist": ["view", "create", "edit"]}


def apply(apps, schema_editor, source, target):
    Role = apps.get_model("core", "Role")
    for role in Role.objects.filter(is_system=True, code__in=target):
        permissions = dict(role.permissions or {})
        if sorted(permissions.get("crm", [])) != sorted(source[role.code]):
            continue
        if target[role.code]:
            permissions["crm"] = [a for a in ACTIONS if a in target[role.code]]
        else:
            permissions.pop("crm", None)
        role.permissions = permissions
        role.save(update_fields=["permissions", "updated_at"])


def forwards(apps, schema_editor):
    apply(apps, schema_editor, OLD, NEW)


def backwards(apps, schema_editor):
    apply(apps, schema_editor, NEW, OLD)


class Migration(migrations.Migration):
    dependencies = [
        ("core", "0001_initial"),
        ("crm", "0001_initial"),
    ]

    operations = [migrations.RunPython(forwards, backwards)]
