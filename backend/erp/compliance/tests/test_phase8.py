"""Phase 8 finish line: invoices become Tax Authority e-invoice documents that
are checked locally and sent through a simulation unless the clinic is fully
set up for the real API; autoclave cycles record their tests and the packs
they sterilised, so a failed cycle lists the patients to recall; equipment has
maintenance due by date or cycle count and work orders that take spare parts
from stock; and a public booking page offers real free times and turns into
appointments when reception confirms."""

from datetime import datetime, time, timedelta
from decimal import Decimal
from unittest import mock

from django.utils import timezone

from erp.appointments.models import Appointment
from erp.billing.models import Invoice
from erp.billing.tests.test_phase3 import Phase3Base
from erp.core.models import Role, User
from erp.inventory import services as stock
from erp.inventory.models import StockItem, StockMovement
from erp.masterdata.models import Procedure
from erp.patients.models import Patient

from .. import eta, services
from ..models import (
    BookingRequest,
    BookingSettings,
    EInvoiceDocument,
    EInvoiceSettings,
    Equipment,
    EtaBranchAddress,
    EtaItemCode,
    InstrumentPack,
    MaintenancePlan,
    PackLoad,
    SterilizationCycle,
)

RIN = "512345678"


def no_network(*args, **kwargs):
    raise AssertionError("A network call was made.")


class Phase8Base(Phase3Base):
    def setUp(self):
        super().setUp()
        c = self.clinic
        self.make_user("accounts", "accountant")
        self.make_user("lab1", "lab_technician")
        self.conf = EInvoiceSettings.for_clinic(c)
        for k, v in dict(is_registered=True, rin=RIN, issuer_name="Okasha Dental", governate="Cairo", region_city="Nasr City",
                         street="Abbas El Akkad", building_number="12", default_item_code=f"EG-{RIN}-GENERAL", start_date=timezone.localdate() - timedelta(days=30)).items():
            setattr(self.conf, k, v)
        self.conf.save()
        EtaBranchAddress.objects.create(clinic=c, branch=self.branch, branch_code="1", governate="Cairo", region_city="Heliopolis", street="Merghany", building_number="45")
        EtaItemCode.objects.create(clinic=c, procedure=self.root_canal, item_code=f"EG-{RIN}-RCT")

    def call(self, method, url, data=None, expect=200):
        response = getattr(self.client, method)(url, data or {}, format="json")
        self.assertEqual(response.status_code, expect, response.content)
        return response.data


class EtaDocumentTests(Phase8Base):
    def make_invoice(self, **extra):
        inv = self.invoice(**extra)
        return Invoice.objects.get(pk=inv["id"])

    def test_document_lines_totals_and_five_decimals(self):
        invoice = self.make_invoice(extra_lines=[{"description": "X-ray", "unit_price": "333.33", "quantity": 3}], discount="100.00")
        doc = eta.build_document(invoice, self.conf)
        self.assertEqual(doc["documentType"], "I")
        self.assertEqual(doc["documentTypeVersion"], "1.0")
        self.assertEqual(doc["issuer"]["id"], RIN)
        self.assertEqual(doc["issuer"]["address"]["branchID"], "1")
        self.assertEqual(doc["internalID"], invoice.number)
        self.assertTrue(doc["dateTimeIssued"].endswith("Z"))
        rct, xray = doc["invoiceLines"]
        self.assertEqual((rct["itemType"], rct["itemCode"], rct["internalCode"]), ("EGS", f"EG-{RIN}-RCT", "RCT"))
        self.assertEqual(xray["salesTotal"], 999.99)
        # The 100 invoice discount is spread over the lines by value, before tax.
        self.assertAlmostEqual(rct["discount"]["amount"] + xray["discount"]["amount"], 200 + 100, places=5)
        self.assertEqual(doc["totalSalesAmount"], 3999.99)
        self.assertEqual(doc["netAmount"], 3699.99)
        self.assertEqual(doc["totalAmount"], float(invoice.total))
        # Medical services: VAT at 0 with the exempt sub-type.
        self.assertEqual(rct["taxableItems"][0], {"taxType": "T1", "amount": 0, "subType": "V003", "rate": 0})
        # Every amount has at most five decimals.
        def decimals(value):
            text = repr(value)
            return len(text.split(".")[1]) if "." in text else 0
        for ln in doc["invoiceLines"]:
            for key in ("salesTotal", "netTotal", "total"):
                self.assertLessEqual(decimals(ln[key]), 5)
            self.assertLessEqual(decimals(ln["discount"]["amount"]), 5)
        self.assertEqual(eta.validate(doc, self.conf), [])

    def test_vat_and_rounding(self):
        invoice = self.make_invoice()
        invoice.tax_rate = Decimal("14")
        line = invoice.lines.first()
        line.unit_price, line.discount = Decimal("1000.07"), Decimal("0.01")
        line.save()
        doc = eta.build_document(invoice, self.conf)
        ln = doc["invoiceLines"][0]
        self.assertEqual(ln["netTotal"], 1000.06)
        self.assertEqual(ln["taxableItems"][0], {"taxType": "T1", "amount": 140.0084, "subType": "V009", "rate": 14})
        self.assertEqual(doc["taxTotals"], [{"taxType": "T1", "amount": 140.0084}])
        self.assertEqual(doc["totalAmount"], 1140.0684)
        self.assertEqual(eta.r5("0.123456"), Decimal("0.12346"))
        self.assertEqual(eta.validate(doc, self.conf), [])

    def test_person_receiver_needs_national_id_from_the_threshold(self):
        invoice = self.make_invoice()
        self.conf.person_id_threshold = Decimal("2000")
        doc = eta.build_document(invoice, self.conf)
        self.assertEqual(doc["receiver"]["type"], "P")
        self.assertTrue(any("national ID" in e for e in eta.validate(doc, self.conf)))
        self.conf.person_id_threshold = Decimal("50000")
        self.assertEqual(eta.validate(eta.build_document(invoice, self.conf), self.conf), [])
        Patient.objects.filter(pk=invoice.patient_id).update(national_id="29001011234567")
        invoice.patient.refresh_from_db()
        self.conf.person_id_threshold = Decimal("2000")
        doc = eta.build_document(invoice, self.conf)
        self.assertEqual(doc["receiver"]["id"], "29001011234567")
        self.assertEqual(eta.validate(doc, self.conf), [])

    def test_local_checks_explain_what_to_fix(self):
        invoice = self.make_invoice(extra_lines=[{"description": "Whitening kit", "unit_price": "500.00"}])
        self.conf.rin = "123"
        self.conf.street = ""
        self.conf.default_item_code = ""
        EtaBranchAddress.objects.all().delete()
        errors = eta.validate(eta.build_document(Invoice.objects.get(pk=invoice.pk), self.conf), self.conf)
        self.assertTrue(any("RIN" in e for e in errors))
        self.assertTrue(any("street" in e for e in errors))
        self.assertTrue(any("Whitening kit" in e and "item code" in e for e in errors))

    def test_queue_prepares_submits_in_simulation_without_network(self):
        self.invoice()
        self.login("accounts")
        with mock.patch("urllib.request.urlopen", side_effect=no_network):
            queue = self.call("get", "/api/compliance/einvoice/documents/")
            self.assertEqual(queue["count"], 1)
            self.assertEqual(queue["mode"], "simulation")
            doc = queue["results"][0]
            self.assertEqual(doc["status"], "ready")
            result = self.call("post", "/api/compliance/einvoice/documents/submit-ready/")
            self.assertEqual(result["valid"], 1)
        doc = self.call("get", f"/api/compliance/einvoice/documents/{doc['id']}/")
        self.assertEqual(doc["status"], "valid")
        self.assertEqual(len(doc["uuid"]), 26)
        self.assertTrue(doc["simulated"])
        self.assertIn(doc["uuid"], doc["url"])
        self.assertEqual(doc["payload"]["internalID"], "INV-00001")
        # The invoice shows its e-invoice status.
        inv = self.call("get", f"/api/billing/invoices/{doc['invoice']}/")
        self.assertEqual(inv["eta"]["status"], "valid")
        self.assertEqual(inv["eta"]["uuid"], doc["uuid"])

    def test_simulated_authority_marks_bad_ids_invalid_and_rebuild_fixes(self):
        Patient.objects.filter(pk=self.patient["id"]).update(national_id="29913451234567")  # month 13: not a real date
        self.invoice()
        self.login("accounts")
        doc = self.call("get", "/api/compliance/einvoice/documents/")["results"][0]
        self.call("post", f"/api/compliance/einvoice/documents/{doc['id']}/send/")
        doc = self.call("get", f"/api/compliance/einvoice/documents/{doc['id']}/")
        self.assertEqual(doc["status"], "invalid")
        self.assertIn("birth date", doc["errors"][0])
        Patient.objects.filter(pk=self.patient["id"]).update(national_id="29001011234567")
        doc = self.call("post", f"/api/compliance/einvoice/documents/{doc['id']}/rebuild/")
        self.assertEqual(doc["status"], "ready")
        doc = self.call("post", f"/api/compliance/einvoice/documents/{doc['id']}/send/")
        self.assertEqual(doc["status"], "valid")

    def test_adapter_is_simulation_unless_live_is_fully_configured(self):
        self.assertIsInstance(eta.get_adapter(self.conf), eta.SimulationAdapter)
        self.conf.mode = "live"
        self.conf.client_id = "abc"
        self.assertIsInstance(eta.get_adapter(self.conf), eta.SimulationAdapter)  # no secret, no signer
        self.conf.client_secret_enc = eta.encrypt_secret("s3cret")
        self.conf.signer_url = "https://signer.example/sign"
        self.assertIsInstance(eta.get_adapter(self.conf), eta.EtaHttpClient)
        self.assertEqual(eta.decrypt_secret(self.conf.client_secret_enc), "s3cret")
        # The real client goes to the token endpoint first; here the network is blocked.
        with mock.patch("urllib.request.urlopen", side_effect=no_network) as opened:
            with self.assertRaises(AssertionError):
                eta.get_adapter(self.conf).token()
            self.assertEqual(opened.call_args[0][0].full_url, "https://id.preprod.eta.gov.eg/connect/token")

    def test_secret_is_never_returned(self):
        self.login("accounts")
        data = self.call("patch", "/api/compliance/einvoice/settings/", {"client_id": "id-1", "client_secret": "top-secret", "mode": "live"})
        self.assertTrue(data["has_secret"])
        self.assertNotIn("client_secret", data)
        self.assertNotIn("top-secret", str(self.client.get("/api/compliance/einvoice/settings/").content))
        self.assertFalse(data["live_ready"])  # no signer yet: still simulated

    def test_voided_invoice_cancels_its_unsent_document(self):
        inv = self.invoice()
        services.prepare_missing(self.clinic)
        self.login("owner")
        self.call("post", f"/api/billing/invoices/{inv['id']}/void/", {"reason": "Wrong patient"})
        self.assertEqual(EInvoiceDocument.objects.get(invoice_id=inv["id"]).status, "cancelled")

    def test_only_einvoice_roles_see_the_queue(self):
        self.login("reception")
        self.call("get", "/api/compliance/einvoice/documents/", expect=403)
        self.login("drsara")
        self.call("get", "/api/compliance/einvoice/documents/", expect=403)
        self.login("accounts")
        self.call("get", "/api/compliance/einvoice/documents/")
        self.call("post", "/api/compliance/einvoice/item-codes/", {"generate": True})
        self.assertTrue(EtaItemCode.objects.filter(clinic=self.clinic).exists())


class SterilisationTests(Phase8Base):
    def setUp(self):
        super().setUp()
        c = self.clinic
        self.autoclave = Equipment.objects.create(clinic=c, name_en="Autoclave A", name_ar="أوتوكلاف أ", category="autoclave", branch=self.branch, cycles_before=100)
        self.packs = [InstrumentPack.objects.create(clinic=c, code=f"CS-{i}", name_en=f"Cassette {i}", name_ar=f"كاسيت {i}") for i in range(1, 4)]
        self.login("assist")

    def cycle(self, expect=201, **extra):
        data = {"machine": self.autoclave.id, "program": "134_wrapped", "temperature": "134.5", "pressure": "2.1",
                "hold_minutes": 5, "duration_minutes": 45, "chemical_indicator": "pass", "packs": ["cs-1", "CS-2"], **extra}
        return self.call("post", "/api/compliance/cycles/", data, expect)

    def test_cycle_numbers_results_and_packs(self):
        first = self.cycle()
        self.assertEqual(first["cycle_number"], 101)
        self.assertEqual(first["result"], "pass")
        detail = self.call("get", f"/api/compliance/cycles/{first['id']}/")
        self.assertEqual([ld["pack"]["code"] for ld in detail["loads"]], ["CS-1", "CS-2"])
        low = self.cycle(temperature="128.0", packs=["CS-3"])
        self.assertEqual(low["cycle_number"], 102)
        self.assertEqual(low["result"], "fail")
        self.assertIn("below 134", low["failure_reasons"][0])
        self.cycle(program="bowie_dick", packs=["CS-3"], expect=400)  # test cycles run empty
        packs = {p["code"]: p["state"] for p in self.call("get", "/api/compliance/packs/")}
        self.assertEqual(packs, {"CS-1": "sterile", "CS-2": "sterile", "CS-3": "failed"})

    def test_pack_expiry_and_use(self):
        cyc = self.cycle()
        load = PackLoad.objects.get(cycle_id=cyc["id"], pack=self.packs[0])
        self.assertEqual(load.expires_on, timezone.localdate() + timedelta(days=30))
        self.call("post", f"/api/compliance/packs/{self.packs[0].id}/use/", {"patient": self.patient["id"]})
        response = self.client.post(f"/api/compliance/packs/{self.packs[0].id}/use/", {"patient": self.patient["id"]}, format="json")
        self.assertEqual(response.status_code, 400)
        self.assertIn("already opened", str(response.data))
        PackLoad.objects.filter(cycle_id=cyc["id"], pack=self.packs[1]).update(expires_on=timezone.localdate() - timedelta(days=1))
        response = self.client.post(f"/api/compliance/packs/{self.packs[1].id}/use/", {"patient": self.patient["id"]}, format="json")
        self.assertEqual(response.status_code, 400)
        self.assertIn("expired", str(response.data))
        states = {p["code"]: p["state"] for p in self.call("get", "/api/compliance/packs/")}
        self.assertEqual(states["CS-1"], "used")
        self.assertEqual(states["CS-2"], "expired")
        self.assertEqual(states["CS-3"], "none")

    def test_failed_biological_indicator_lists_patients_to_recall(self):
        cyc = self.cycle(bi_used=True, bi_lot="BI-77", packs=["CS-1", "CS-2", "CS-3"])
        self.assertEqual(cyc["bi_result"], "pending")
        self.assertEqual(cyc["result"], "pass")
        appt = Appointment.objects.create(
            clinic=self.clinic, patient_id=self.patient["id"], dentist=self.dentist, branch=self.branch,
            start=timezone.now(), duration_minutes=30, status="in_chair",
        )
        other = Patient.objects.create(clinic=self.clinic, name_en="Hany", phone="01100000000")
        self.call("post", f"/api/compliance/packs/{self.packs[0].id}/use/", {"appointment": appt.id})
        self.call("post", f"/api/compliance/packs/{self.packs[1].id}/use/", {"patient": other.id})
        # Two days later the indicator grew: the cycle fails after the fact.
        cyc = self.call("post", f"/api/compliance/cycles/{cyc['id']}/bi/", {"result": "positive"})
        self.assertEqual(cyc["result"], "fail")
        affected = self.call("get", f"/api/compliance/cycles/{cyc['id']}/affected/")
        self.assertEqual({p["patient"]["id"] for p in affected["patients"]}, {self.patient["id"], other.id})
        self.assertEqual([s["pack"]["code"] for s in affected["shelf"]], ["CS-3"])
        self.assertEqual(affected["patients"][0]["appointment"]["dentist"]["en"], "Dr Sara")
        # From the patient: which cycle sterilised their instruments.
        trace = self.call("get", f"/api/compliance/trace/patient/{self.patient['id']}/")
        self.assertEqual(trace[0]["cycle"]["number"], cyc["cycle_number"])
        self.assertEqual(trace[0]["cycle"]["result"], "fail")
        summary = self.call("get", "/api/compliance/summary/")
        self.assertEqual(summary["failed_unreviewed"], 2)
        load = affected["patients"][0]["id"]
        self.call("post", f"/api/compliance/cycles/{cyc['id']}/recall/", {"load": load, "note": "Called, booked a check"})
        self.assertEqual(self.call("get", "/api/compliance/summary/")["failed_unreviewed"], 1)

    def test_positive_bi_recalls_every_load_since_the_last_negative_bi(self):
        now = timezone.now()
        at = lambda hours: (now - timedelta(hours=hours)).isoformat()  # noqa: E731
        p1, p2, p3 = (Patient.objects.create(clinic=self.clinic, name_en=n, phone=f"0110000000{i}") for i, n in enumerate(["Old", "Mid", "New"]))
        before = self.cycle(started_at=at(60), packs=["CS-1"])
        good = self.cycle(started_at=at(50), bi_used=True, bi_lot="BI-1", packs=[])
        self.call("post", f"/api/compliance/cycles/{good['id']}/bi/", {"result": "negative"})
        middle = self.cycle(started_at=at(40), packs=["CS-2"])
        bad = self.cycle(started_at=at(30), bi_used=True, bi_lot="BI-2", packs=["CS-3"])
        for pack, patient in ((self.packs[0], p1), (self.packs[1], p2), (self.packs[2], p3)):
            self.call("post", f"/api/compliance/packs/{pack.id}/use/", {"patient": patient.id})
        self.call("post", f"/api/compliance/cycles/{bad['id']}/bi/", {"result": "positive"})
        affected = self.call("get", f"/api/compliance/cycles/{bad['id']}/affected/")
        self.assertEqual({p["patient"]["id"] for p in affected["patients"]}, {p2.id, p3.id})
        self.assertEqual({p["cycle_number"] for p in affected["patients"]}, {middle["cycle_number"], bad["cycle_number"]})
        self.assertNotIn(before["cycle_number"], {p["cycle_number"] for p in affected["patients"]})
        self.assertEqual(self.call("get", "/api/compliance/summary/")["failed_unreviewed"], 2)

    def test_reception_cannot_record_cycles(self):
        self.login("reception")
        self.call("get", "/api/compliance/cycles/", expect=403)
        self.login("drsara")
        self.cycle()


class MaintenanceTests(Phase8Base):
    def setUp(self):
        super().setUp()
        c = self.clinic
        self.today = timezone.localdate()
        self.autoclave = Equipment.objects.create(clinic=c, name_en="Autoclave A", name_ar="أ", category="autoclave", branch=self.branch, cycles_before=950)
        self.compressor = Equipment.objects.create(clinic=c, name_en="Compressor", name_ar="كمبروسر", category="compressor", branch=self.branch, chair=self.chair1)
        self.login("owner")

    def test_due_by_date(self):
        plan = MaintenancePlan.objects.create(clinic=self.clinic, equipment=self.compressor, title_en="Oil", title_ar="زيت", every_months=6,
                                              start_on=self.today - timedelta(days=200))
        rows = self.call("get", "/api/compliance/plans/")
        self.assertEqual(rows[0]["due"]["state"], "overdue")
        self.call("post", f"/api/compliance/plans/{plan.id}/done/", {"performed_by": "Atlas Co", "cost": "450"})
        row = self.call("get", "/api/compliance/plans/")[0]
        self.assertEqual(row["due"]["state"], "ok")
        self.assertEqual(row["due"]["date"], services.add_months(self.today, 6))
        plan.refresh_from_db()
        plan.last_done_on = self.today - timedelta(days=175)
        plan.save()
        self.assertEqual(self.call("get", "/api/compliance/plans/")[0]["due"]["state"], "due_soon")

    def test_due_by_cycle_count(self):
        MaintenancePlan.objects.create(clinic=self.clinic, equipment=self.autoclave, title_en="Service", title_ar="صيانة", every_months=6, every_cycles=1000,
                                       start_on=self.today, last_done_cycles=0)
        row = self.call("get", "/api/compliance/plans/")[0]
        self.assertEqual(row["due"]["cycles_left"], 50)
        self.assertEqual(row["due"]["state"], "due_soon")
        start = timezone.now() - timedelta(days=1)
        for n in range(50):
            SterilizationCycle.objects.create(clinic=self.clinic, machine=self.autoclave, cycle_number=951 + n, started_at=start + timedelta(minutes=n))
        row = self.call("get", "/api/compliance/plans/")[0]
        self.assertEqual(row["due"]["cycles_left"], 0)
        self.assertEqual(row["due"]["state"], "overdue")
        self.assertEqual(self.call("get", "/api/compliance/summary/")["maintenance_overdue"], 1)
        equipment = {e["id"]: e for e in self.call("get", "/api/compliance/equipment/")}
        self.assertEqual(equipment[self.autoclave.id]["cycle_count"], 1000)

    def test_work_order_takes_parts_from_stock_and_tracks_downtime(self):
        item = StockItem.objects.create(clinic=self.clinic, name_en="Compressor filter", name_ar="فلتر", unit="piece", last_cost=Decimal("120"))
        lot = stock.lot_for(self.clinic, item, self.branch)
        stock.move(lot, "receive", 5, unit_cost=Decimal("120"))
        self.login("assist")
        order = self.call("post", "/api/compliance/work-orders/", {"equipment": self.compressor.id, "issue": "Loud noise, no pressure", "priority": "high", "takes_out_of_service": True}, 201)
        self.assertEqual(order["number"], "WO-00001")
        self.compressor.refresh_from_db()
        self.assertEqual(self.compressor.status, "out_of_service")
        down = self.call("get", "/api/compliance/chairs-down/")
        self.assertEqual(down[0]["chair"], self.chair1.id)
        order = self.call("post", f"/api/compliance/work-orders/{order['id']}/parts/", {"item": item.id, "quantity": 2})
        self.assertEqual(order["parts_cost"], "240.00")
        lot.refresh_from_db()
        self.assertEqual(lot.quantity, Decimal("3"))
        movement = StockMovement.objects.get(kind="use", item=item)
        self.assertIn("WO-00001", movement.note)
        response = self.client.post(f"/api/compliance/work-orders/{order['id']}/parts/", {"item": item.id, "quantity": 9}, format="json")
        self.assertEqual(response.status_code, 400)
        order = self.call("post", f"/api/compliance/work-orders/{order['id']}/close/", {"resolution": "Replaced filters", "labour_cost": "300"})
        self.assertEqual(order["status"], "done")
        self.assertEqual(order["total_cost"], "540.00")
        self.compressor.refresh_from_db()
        self.assertEqual(self.compressor.status, "in_service")
        records = self.call("get", "/api/compliance/records/")["results"]
        self.assertEqual(records[0]["cost"], "540.00")

    def test_licences_expiring(self):
        self.call("post", "/api/compliance/licences/", {"kind": "xray_licence", "title_en": "X-ray licence", "title_ar": "ترخيص الأشعة",
                                                      "expires_on": str(self.today + timedelta(days=25))}, 201)
        rows = self.call("get", "/api/compliance/licences/")
        self.assertEqual(rows[0]["state"], "expiring")
        self.assertEqual(self.call("get", "/api/compliance/summary/")["licences_expiring"], 1)
        self.call("post", f"/api/compliance/licences/{rows[0]['id']}/renew/", {"expires_on": str(self.today + timedelta(days=400))})
        self.assertEqual(self.call("get", "/api/compliance/licences/")[0]["state"], "ok")
        self.login("reception")
        self.call("get", "/api/compliance/licences/", expect=403)


class BookingTests(Phase8Base):
    def setUp(self):
        super().setUp()
        c = self.clinic
        self.booking = BookingSettings.for_clinic(c)
        self.booking.enabled = True
        self.booking.slug = "okasha"
        self.booking.min_notice_hours = 0
        self.booking.save()
        self.booking.services.add(self.root_canal)
        self.cleaning = Procedure.objects.create(clinic=c, category=self.root_canal.category, code="CLN", name_en="Cleaning", name_ar="تنظيف", default_duration_minutes=30)
        self.booking.services.add(self.cleaning)
        self.dentist.branches.add(self.branch)
        self.dentist2.is_active = False
        self.dentist2.save()
        self.day = timezone.localdate() + timedelta(days=2)
        self.client.credentials()

    def at(self, hh, mm=0):
        return timezone.make_aware(datetime.combine(self.day, time(hh, mm)))

    def slots(self, **extra):
        params = {"branch": self.branch.id, "service": self.cleaning.id, "date": str(self.day), **extra}
        return self.call("get", "/api/public/booking/okasha/slots/", params)["slots"]

    def request(self, start, expect=201, **extra):
        data = {"branch": self.branch.id, "service": self.cleaning.id, "start": start.isoformat(), "name": "Laila Hassan",
                "phone": "0122 333 4444", "consent": True, **extra}
        return self.call("post", "/api/public/booking/okasha/request/", data, expect)

    def test_public_page_shows_only_bookable_things(self):
        info = self.call("get", "/api/public/booking/okasha/")
        self.assertEqual({s["en"] for s in info["services"]}, {"Root canal", "Cleaning"})
        self.assertEqual([d["en"] for d in info["dentists"]], ["Dr Sara"])
        self.assertNotIn("patients", str(info).lower())
        self.booking.enabled = False
        self.booking.save()
        self.call("get", "/api/public/booking/okasha/", expect=404)

    def test_slots_follow_hours_and_appointments(self):
        slots = self.slots()
        self.assertEqual(slots[0][11:16], "10:00")
        self.assertEqual(slots[-1][11:16], "21:30")
        Appointment.objects.create(clinic=self.clinic, patient_id=self.patient["id"], dentist=self.dentist, branch=self.branch, start=self.at(11), duration_minutes=60)
        times = [s[11:16] for s in self.slots()]
        self.assertNotIn("11:00", times)
        self.assertNotIn("11:30", times)
        self.assertIn("12:00", times)
        # A one-hour root canal cannot start at 10:30 (it would run into 11:00).
        long_times = [s[11:16] for s in self.slots(service=self.root_canal.id)]
        self.assertIn("10:00", long_times)
        self.assertNotIn("10:30", long_times)
        self.assertEqual(self.slots(date=str(timezone.localdate() + timedelta(days=60))), [])

    def test_double_booking_is_prevented(self):
        made = self.request(self.at(12))
        self.assertEqual(len(made["reference"]), 6)
        self.assertNotIn("12:00", [s[11:16] for s in self.slots()])
        response = self.client.post("/api/public/booking/okasha/request/", {
            "branch": self.branch.id, "service": self.cleaning.id, "start": self.at(12).isoformat(), "name": "Other person",
            "phone": "01099998888", "consent": True}, format="json")
        self.assertEqual(response.status_code, 400)
        self.assertIn("just taken", str(response.data))

    def test_spam_guards(self):
        before = BookingRequest.objects.count()
        self.request(self.at(13), website="http://spam.example")  # honeypot: looks fine, saves nothing
        self.assertEqual(BookingRequest.objects.count(), before)
        self.request(self.at(13), consent=False, expect=400)
        for hour in (14, 15, 16):
            self.request(self.at(hour), phone=f"0100000{hour}00")
        self.request(self.at(17), phone="01000001700")
        self.request(self.at(18), phone="01000001800")
        response = self.client.post("/api/public/booking/okasha/request/", {
            "branch": self.branch.id, "service": self.cleaning.id, "start": self.at(19).isoformat(), "name": "Bot", "phone": "01000001900", "consent": True}, format="json")
        self.assertEqual(response.status_code, 400)
        self.assertIn("Too many", str(response.data))

    def test_confirmation_creates_patient_and_appointment(self):
        made = self.request(self.at(12), name="ليلى حسن", note="Sensitive tooth")
        req = BookingRequest.objects.get(reference=made["reference"])
        self.login("reception")
        listed = self.call("get", "/api/compliance/booking/requests/", {"status": "pending"})
        self.assertEqual(listed["count"], 1)
        self.assertEqual(self.call("get", "/api/compliance/summary/")["online_waiting"], 1)
        done = self.call("post", f"/api/compliance/booking/requests/{req.id}/confirm/")
        self.assertEqual(done["status"], "confirmed")
        appt = Appointment.objects.get(pk=done["appointment"])
        self.assertEqual((appt.dentist_id, appt.start, appt.status), (self.dentist.id, self.at(12), "confirmed"))
        patient = Patient.objects.get(pk=done["patient"])
        self.assertEqual((patient.name_ar, patient.phone), ("ليلى حسن", "01223334444"))
        # The same phone again finds the same patient.
        again = self.request(self.at(15), name="Laila")
        req2 = BookingRequest.objects.get(reference=again["reference"])
        self.assertEqual(self.call("get", f"/api/compliance/booking/requests/{req2.id}/")["known_patient"]["id"], patient.id)
        done = self.call("post", f"/api/compliance/booking/requests/{req2.id}/confirm/")
        self.assertEqual(done["patient"], patient.id)
        self.call("post", f"/api/compliance/booking/requests/{req2.id}/reject/", {"reason": "x"}, expect=400)

    def test_permissions(self):
        self.login("assist")
        self.call("get", "/api/compliance/booking/requests/")  # assistants see appointments
        self.call("patch", "/api/compliance/booking/settings/", {"days_ahead": 10}, expect=403)
        made = self.request(self.at(12))
        self.login("assist")
        req = BookingRequest.objects.get(reference=made["reference"])
        self.call("post", f"/api/compliance/booking/requests/{req.id}/confirm/", expect=403)
        self.login("accounts")
        self.call("get", "/api/compliance/booking/requests/", expect=403)
        self.login("owner")
        data = self.call("patch", "/api/compliance/booking/settings/", {"days_ahead": 10})
        self.assertTrue(data["link"].endswith("/book/okasha"))


class RoleMigrationTests(Phase8Base):
    def test_defaults_and_migration_only_touch_untouched_roles(self):
        import importlib  # noqa: PLC0415

        from django.apps import apps  # noqa: PLC0415

        accountant = Role.objects.get(clinic=self.clinic, code="accountant")
        self.assertIn("approve", accountant.permissions["einvoice"])
        assistant = Role.objects.get(clinic=self.clinic, code="assistant")
        self.assertEqual(assistant.permissions["compliance"], ["view", "create", "edit"])
        self.assertNotIn("compliance", Role.objects.get(clinic=self.clinic, code="receptionist").permissions)
        # An old clinic: the dentist role has no compliance entry, the assistant was set by hand.
        dentist = Role.objects.get(clinic=self.clinic, code="dentist")
        dentist.permissions.pop("compliance")
        dentist.save()
        assistant.permissions["compliance"] = ["view"]
        assistant.save()
        migration = importlib.import_module("erp.compliance.migrations.0002_role_permissions")
        migration.forwards(apps, None)
        dentist.refresh_from_db()
        assistant.refresh_from_db()
        self.assertEqual(dentist.permissions["compliance"], ["view", "create", "edit"])
        self.assertEqual(assistant.permissions["compliance"], ["view"])
        self.assertTrue(User.objects.get(username="owner").has_module_perm("einvoice", "approve"))
