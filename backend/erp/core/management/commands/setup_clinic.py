import getpass

from django.core.management.base import BaseCommand, CommandError

from erp.core.models import User
from erp.core.setup import create_clinic
from erp.masterdata.catalog import load_starter_catalog


class Command(BaseCommand):
    help = "Create a clinic with its default roles, an owner account and (optionally) the starter procedure catalog."

    def add_arguments(self, parser):
        parser.add_argument("--name-en", required=True)
        parser.add_argument("--name-ar", required=True)
        parser.add_argument("--owner", required=True, help="Owner's username")
        parser.add_argument("--email", default="")
        parser.add_argument("--password", help="Owner's password (prompted if left out)")
        parser.add_argument("--language", choices=["en", "ar"], default="ar")
        parser.add_argument("--with-catalog", action="store_true", help="Load the starter procedure catalog")

    def handle(self, *args, **opts):
        if User.objects.filter(username__iexact=opts["owner"]).exists():
            raise CommandError(f"User {opts['owner']} already exists.")
        password = opts["password"] or getpass.getpass("Owner password: ")
        clinic, owner = create_clinic(
            opts["name_en"], opts["name_ar"], opts["owner"], password, opts["email"], opts["language"]
        )
        self.stdout.write(self.style.SUCCESS(f"Created clinic {clinic} (id {clinic.pk}) with owner {owner.username}."))
        if opts["with_catalog"]:
            count = load_starter_catalog(clinic)
            self.stdout.write(self.style.SUCCESS(f"Loaded {count} starter procedures (prices set to 0)."))
