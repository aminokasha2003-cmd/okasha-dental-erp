from datetime import date

from django.core.management.base import BaseCommand

from erp.appointments.reminders import send_reminders


class Command(BaseCommand):
    help = "Send WhatsApp reminders for tomorrow's appointments (run once a day)."

    def add_arguments(self, parser):
        parser.add_argument("--date", help="Send for this day instead of tomorrow (YYYY-MM-DD).")

    def handle(self, *args, **options):
        day = date.fromisoformat(options["date"]) if options["date"] else None
        sent, failed = send_reminders(day=day)
        self.stdout.write(f"Reminders sent: {sent}, failed: {failed}")
