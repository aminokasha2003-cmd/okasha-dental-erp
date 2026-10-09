"""Modules, actions and the default roles.

Permissions are stored per role as {module: [actions]}. The owner can change
them from the app, so these defaults are only what a new clinic starts with.
"""

from django.utils.translation import gettext_lazy as _

ACTIONS = ("view", "create", "edit", "delete", "approve")

# Every module the sidebar can show, including the ones built in later phases,
# so roles can be prepared before a module ships.
MODULES = {
    "settings": _("Clinic settings"),
    "users": _("Users and roles"),
    "masterdata": _("Master data"),
    "audit": _("Audit log"),
    "files": _("Files"),
    "patients": _("Patients"),
    "appointments": _("Appointments"),
    "clinical": _("Clinical records"),
    "billing": _("Billing"),
    "lab": _("Lab"),
    "inventory": _("Inventory and purchasing"),
    "staff": _("Staff and payroll"),
    "crm": _("CRM"),
    "reports": _("Reports"),
}

ALL = list(ACTIONS)
VCE = ["view", "create", "edit"]

# Role code -> (English name, Arabic name, permissions). Mirrors the roles
# table in the development structure document.
DEFAULT_ROLES = {
    "owner": (
        "Owner or admin",
        "المالك أو المدير",
        {module: ALL for module in MODULES},
    ),
    "dentist": (
        "Dentist",
        "طبيب أسنان",
        {
            "masterdata": ["view"],
            "files": VCE,
            "patients": VCE,
            "appointments": VCE,
            "clinical": ["view", "create", "edit", "approve"],
            "lab": VCE,
            "inventory": ["view"],
        },
    ),
    "receptionist": (
        "Receptionist",
        "موظف استقبال",
        {
            "masterdata": ["view"],
            "files": ["view", "create"],
            "patients": VCE,
            "appointments": ALL[:4],
            "billing": VCE,
            "inventory": ["view"],
        },
    ),
    "assistant": (
        "Dental assistant",
        "مساعد طبيب أسنان",
        {
            "masterdata": ["view"],
            "files": ["view", "create"],
            "patients": ["view"],
            "appointments": ["view"],
            "clinical": ["view"],
            "inventory": ["view", "create"],
        },
    ),
    "lab_technician": (
        "Lab technician",
        "فني معمل",
        {
            "masterdata": ["view"],
            "files": VCE,
            "lab": VCE,
            "inventory": ["view", "create"],
        },
    ),
    "accountant": (
        "Accountant",
        "محاسب",
        {
            "masterdata": ["view"],
            "billing": ALL,
            "inventory": ["view", "approve"],
            "staff": ["view", "edit"],
            "reports": ["view"],
        },
    ),
}


def normalize_permissions(permissions):
    """Validate a {module: [actions]} mapping and return a clean copy."""
    if not isinstance(permissions, dict):
        raise ValueError("Permissions must be an object of module to actions.")
    clean = {}
    for module, actions in permissions.items():
        if module not in MODULES:
            raise ValueError(f"Unknown module: {module}")
        if not isinstance(actions, (list, tuple)):
            raise ValueError(f"Actions for {module} must be a list.")
        unknown = set(actions) - set(ACTIONS)
        if unknown:
            raise ValueError(f"Unknown actions for {module}: {', '.join(sorted(unknown))}")
        if actions:
            clean[module] = [a for a in ACTIONS if a in actions]
    return clean
