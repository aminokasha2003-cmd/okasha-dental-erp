from django.core.management.base import BaseCommand, CommandError

from erp.core.models import Clinic
from erp.masterdata.catalog import load_starter_catalog


class Command(BaseCommand):
    help = "Add the starter procedure catalog (prices 0) to a clinic. Existing codes are left alone."

    def add_arguments(self, parser):
        parser.add_argument("clinic_id", type=int)

    def handle(self, *args, **opts):
        clinic = Clinic.objects.filter(pk=opts["clinic_id"]).first()
        if clinic is None:
            raise CommandError("No clinic with that id.")
        count = load_starter_catalog(clinic)
        self.stdout.write(self.style.SUCCESS(f"Added {count} procedures to {clinic}."))
