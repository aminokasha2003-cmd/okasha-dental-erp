"""Give the built-in roles of existing clinics the phase 5 inventory rights.

Only roles still on the old default for inventory are changed, so anything the
owner set by hand is kept."""

from django.db import migrations

ACTIONS = ("view", "create", "edit", "delete", "approve")
OLD = {
    "dentist": [],
    "receptionist": [],
    "assistant": ["view", "edit"],
    "lab_technician": ["view"],
    "accountant": [],
}
NEW = {
    "dentist": ["view"],
    "receptionist": ["view"],
    "assistant": ["view", "create"],
    "lab_technician": ["view", "create"],
    "accountant": ["view", "approve"],
}


def apply(apps, schema_editor, source, target):
    Role = apps.get_model("core", "Role")
    for role in Role.objects.filter(is_system=True, code__in=target):
        permissions = dict(role.permissions or {})
        if sorted(permissions.get("inventory", [])) != sorted(source[role.code]):
            continue
        if target[role.code]:
            permissions["inventory"] = [a for a in ACTIONS if a in target[role.code]]
        else:
            permissions.pop("inventory", None)
        role.permissions = permissions
        role.save(update_fields=["permissions", "updated_at"])


def forwards(apps, schema_editor):
    apply(apps, schema_editor, OLD, NEW)


def backwards(apps, schema_editor):
    apply(apps, schema_editor, NEW, OLD)


class Migration(migrations.Migration):
    dependencies = [
        ("core", "0001_initial"),
        ("inventory", "0001_initial"),
    ]

    operations = [migrations.RunPython(forwards, backwards)]
