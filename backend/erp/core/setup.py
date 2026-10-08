"""Creating a new clinic with its default roles and owner account."""

from django.db import transaction

from . import rbac
from .models import Clinic, Role, User


def create_default_roles(clinic):
    roles = {}
    for code, (name_en, name_ar, permissions) in rbac.DEFAULT_ROLES.items():
        role, _ = Role.objects.get_or_create(
            clinic=clinic,
            code=code,
            defaults={
                "name_en": name_en,
                "name_ar": name_ar,
                "permissions": rbac.normalize_permissions(permissions),
                "is_system": True,
            },
        )
        roles[code] = role
    return roles


@transaction.atomic
def create_clinic(name_en, name_ar, owner_username, owner_password, owner_email="", language="ar"):
    clinic = Clinic.objects.create(name_en=name_en, name_ar=name_ar, default_language=language)
    roles = create_default_roles(clinic)
    owner = User(username=owner_username, email=owner_email, clinic=clinic, language=language)
    owner.set_password(owner_password)
    owner.save()
    owner.roles.add(roles["owner"])
    return clinic, owner
