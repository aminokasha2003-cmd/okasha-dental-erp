import time

from django.core.management.base import BaseCommand
from django.db import transaction

from erp.core.demo import people
from erp.core.demo.seed import counts, demo_clinic, is_seeded, seed, wipe


class Command(BaseCommand):
    help = (
        "Fill the clinic with a realistic demo: staff logins for every role, two branches, patients, "
        "six months of appointments, treatment, billing, lab work, stock and payroll. Runs once; "
        "use --reset to wipe the clinic's records and build the demo again."
    )

    def add_arguments(self, parser):
        parser.add_argument(
            "--reset", action="store_true",
            help="Delete this clinic's patients, visits, money, lab, stock and staff records (and the demo logins) first. "
                 "The owner's login and password are kept. Other clinics are not touched.",
        )
        parser.add_argument("--quiet", action="store_true", help="Only print the summary.")

    def handle(self, *args, **opts):
        started = time.monotonic()
        clinic, owner, created = demo_clinic()
        if created:
            self.stdout.write(f"Created the clinic {clinic} with owner {owner.username} (password {people.DEMO_PASSWORD}).")
        if not opts["reset"] and is_seeded(clinic):
            self.stdout.write(self.style.WARNING(
                f"{clinic} already has patients, so nothing was added. Run with --reset to start the demo again."
            ))
            return
        out = (lambda msg: None) if opts["quiet"] else self.stdout.write
        # One transaction: if anything goes wrong, the clinic is left as it was.
        with transaction.atomic():
            if opts["reset"]:
                out(f"Removing the records of {clinic}…")
                wipe(clinic)
            seed(clinic, owner, out)
        self.stdout.write(self.style.SUCCESS(f"Demo clinic ready in {time.monotonic() - started:.0f} seconds:"))
        for name, n in counts(clinic).items():
            self.stdout.write(f"  {name:<20} {n}")
        self.stdout.write("")
        self.stdout.write(f"Every demo login uses the password {people.DEMO_PASSWORD} (amin keeps his own):")
        for username, note in people.LOGIN_NOTES.items():
            self.stdout.write(f"  {username:<9} {note}")
