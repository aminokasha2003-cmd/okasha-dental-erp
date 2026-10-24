"""Give the built-in roles of existing clinics the phase 8 rights.

The two modules are new, so a role "still on the old default" is one that has
no entry for them yet; a role the owner already set by hand is left alone."""

from django.db import migrations

ACTIONS = ("view", "create", "edit", "delete", "approve")
ALL = list(ACTIONS)
VCE = ["view", "create", "edit"]
NEW = {
    "owner": {"compliance": ALL, "einvoice": ALL},
    "dentist": {"compliance": VCE},
    "assistant": {"compliance": VCE},
    "lab_technician": {"compliance": ["view", "create"]},
    "accountant": {"einvoice": ALL, "compliance": ["view"]},
}


def forwards(apps, schema_editor):
    Role = apps.get_model("core", "Role")
    for role in Role.objects.filter(is_system=True, code__in=NEW):
        permissions = dict(role.permissions or {})
        changed = False
        for module, actions in NEW[role.code].items():
            if module not in permissions:
                permissions[module] = list(actions)
                changed = True
        if changed:
            role.permissions = permissions
            role.save(update_fields=["permissions", "updated_at"])


def backwards(apps, schema_editor):
    Role = apps.get_model("core", "Role")
    for role in Role.objects.filter(is_system=True, code__in=NEW):
        permissions = dict(role.permissions or {})
        for module, actions in NEW[role.code].items():
            if sorted(permissions.get(module, [])) == sorted(actions):
                permissions.pop(module)
        role.permissions = permissions
        role.save(update_fields=["permissions", "updated_at"])


class Migration(migrations.Migration):
    dependencies = [
        ("core", "0001_initial"),
        ("compliance", "0001_initial"),
    ]

    operations = [migrations.RunPython(forwards, backwards)]
