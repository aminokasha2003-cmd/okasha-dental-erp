"""The demo clinic: one command fills every module, a second run adds nothing,
--reset rebuilds it without touching the owner's password or other clinics."""

import shutil
import tempfile
from io import StringIO

from django.core.management import call_command
from django.test import TestCase, override_settings
from django.utils import timezone

from erp.appointments.models import Appointment
from erp.billing.models import Invoice, Payment
from erp.core.demo.people import DEMO_PASSWORD
from erp.core.demo.seed import counts
from erp.core.models import User
from erp.core.setup import create_clinic
from erp.inventory.models import StockLot
from erp.lab.models import LabCase
from erp.patients.models import Patient
from erp.staff.models import AttendanceRecord, PayrollRun


class SeedDemoTests(TestCase):
    def setUp(self):
        # The demo writes placeholder X-rays and documents; keep them out of the real media folder.
        media = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, media, ignore_errors=True)
        override = override_settings(MEDIA_ROOT=media)
        override.enable()
        self.addCleanup(override.disable)

    def seed(self, *args):
        out = StringIO()
        call_command("seed_demo", "--quiet", *args, stdout=out)
        return out.getvalue()

    def test_seed_twice_and_reset(self):
        other, _ = create_clinic("Other Clinic", "عيادة أخرى", "other", "Other-pass-123")
        clinic, amin = create_clinic("Okasha Dental", "عكاشة", "amin", "Owner-pass-123")
        output = self.seed()
        self.assertIn("Demo clinic ready", output)
        first = counts(clinic)
        self.assertEqual(first["patients"], 92)  # 80, plus 12 lapsed patients for the recall queue
        self.assertEqual(first["branches"], 2)
        self.assertEqual(first["users"], 13)
        for key in ("appointments", "appointments today", "treatment plans", "invoices", "payments", "installments",
                    "lab cases", "stock movements", "purchase orders", "attendance records", "leave requests",
                    "leads", "campaigns", "feedback", "patient files"):
            self.assertGreater(first[key], 0, key)
        self.assertEqual(first["payroll runs"], 3)
        self.assertEqual(set(PayrollRun.objects.filter(clinic=clinic).values_list("status", flat=True)), {"paid", "draft"})
        # Every built-in role has someone, and the money adds up.
        self.assertFalse(clinic.roles.filter(users__isnull=True).exists())
        self.assertFalse(any(i.balance < 0 for i in Invoice.objects.filter(clinic=clinic).prefetch_related("lines", "payments")))
        self.assertFalse(StockLot.objects.filter(clinic=clinic, quantity__lt=0).exists())
        self.assertTrue(LabCase.objects.filter(clinic=clinic, stage="delivered").exists())
        self.assertTrue(LabCase.objects.filter(clinic=clinic, cancelled_at__isnull=True).exclude(stage="delivered").exists())
        self.assertTrue(Appointment.objects.filter(clinic=clinic, start__date=timezone.localdate(), status="in_chair").exists())
        self.assertTrue(User.objects.get(username="mariam").check_password(DEMO_PASSWORD))
        self.assertTrue(Payment.objects.filter(clinic=clinic).exclude(created_by=None).exists())

        # A second run adds nothing.
        self.assertIn("nothing was added", self.seed())
        self.assertEqual(counts(clinic), first)

        # --reset rebuilds the same clinic; the owner keeps his password, the other clinic is untouched.
        self.seed("--reset")
        again = counts(clinic)
        self.assertEqual(again["patients"], 92)
        self.assertEqual(again["users"], 13)
        self.assertEqual(again["roles"], first["roles"])
        amin.refresh_from_db()
        self.assertTrue(amin.check_password("Owner-pass-123"))
        self.assertFalse(Patient.objects.filter(clinic=other).exists())
        self.assertTrue(User.objects.filter(username="other", clinic=other).exists())
        # Today's attendance is left open for the receptionist, so signing in clocks her in.
        self.assertFalse(AttendanceRecord.objects.filter(staff__user__username="mariam", date=timezone.localdate()).exists())
