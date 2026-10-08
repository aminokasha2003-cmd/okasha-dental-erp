import os

from django.core.management.base import BaseCommand

from erp.core.models import Clinic, User
from erp.core.setup import create_clinic
from erp.masterdata.catalog import load_starter_catalog


class Command(BaseCommand):
    help = (
        "Create the first clinic and owner from environment variables, once. "
        "Used on hosting platforms without a shell. Does nothing if a clinic already exists."
    )

    def handle(self, *args, **opts):
        username = os.environ.get("INITIAL_OWNER_USERNAME")
        password = os.environ.get("INITIAL_OWNER_PASSWORD")
        if Clinic.objects.exists():
            self.stdout.write("A clinic already exists; nothing to do.")
            return
        if not (username and password):
            self.stdout.write("INITIAL_OWNER_USERNAME/PASSWORD not set; skipping first-clinic setup.")
            return
        if User.objects.filter(username__iexact=username).exists():
            self.stdout.write(f"User {username} already exists; skipping.")
            return
        clinic, owner = create_clinic(
            os.environ.get("INITIAL_CLINIC_NAME_EN", "Okasha Dental Clinic"),
            os.environ.get("INITIAL_CLINIC_NAME_AR", "عيادة عكاشة لطب الأسنان"),
            username,
            password,
            language=os.environ.get("INITIAL_LANGUAGE", "ar"),
        )
        count = load_starter_catalog(clinic)
        self.stdout.write(self.style.SUCCESS(f"Created {clinic} with owner {owner.username} and {count} starter procedures."))
