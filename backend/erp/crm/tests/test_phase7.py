"""Phase 7 finish line: reception logs enquiries as leads and moves them along
a pipeline to a patient file and a consultation, recall rules fill a queue of
patients due back, campaigns pick an audience, respect consent and count what
they brought in, patients rate their visits, and the owner's reports respect
each role's rights and agree with the module dashboards."""

from datetime import timedelta
from decimal import Decimal

from django.utils import timezone

from erp.appointments.models import Appointment
from erp.billing.tests.test_phase3 import Phase3Base
from erp.core.models import Notification, Role
from erp.masterdata.models import Procedure

from ..models import Campaign, Lead, RecallRule
from ..services import add_months, nps


def at(day, hour):
    return timezone.make_aware(timezone.datetime.combine(day, timezone.datetime.min.time())) + timedelta(hours=hour)


class Phase7Base(Phase3Base):
    def setUp(self):
        super().setUp()
        self.login("reception")

    def post(self, url, data, expect=201):
        response = self.client.post(url, data, format="json")
        self.assertEqual(response.status_code, expect, response.content)
        return response.data

    def lead(self, expect=201, **extra):
        data = {"name_en": "Hany Fathy", "name_ar": "هاني فتحي", "phone": "01155556666", "source": "facebook",
                "interest": self.root_canal.id, "estimated_value": "4000.00", **extra}
        return self.post("/api/crm/leads/", data, expect)

    def visit(self, patient_id, start, status="completed", procedure=None):
        return Appointment.objects.create(
            clinic=self.clinic, patient_id=patient_id, dentist=self.dentist, branch=self.branch, start=start,
            status=status, procedure=procedure,
        )


class LeadTests(Phase7Base):
    def test_stage_changes_are_logged_and_lost_needs_a_reason(self):
        lead = self.lead()
        self.assertEqual(lead["stage"], "new")
        url = f"/api/crm/leads/{lead['id']}/"
        # Logging a call moves a new lead to "contacted" and sets the follow-up.
        tomorrow = str(timezone.localdate() + timedelta(days=1))
        data = self.post(url + "activities/", {"kind": "call", "text": "Asked about price", "next_follow_up": tomorrow})
        self.assertEqual(data["stage"], "contacted")
        self.assertEqual(data["next_follow_up"], tomorrow)
        self.post(url + "stage/", {"stage": "lost"}, expect=400)
        data = self.post(url + "stage/", {"stage": "lost", "lost_reason": "price"}, expect=200)
        self.assertEqual((data["stage"], data["lost_reason"], data["next_follow_up"]), ("lost", "price", None))
        data = self.post(url + "stage/", {"stage": "accepted"}, expect=200)
        self.assertEqual(data["lost_reason"], "")
        kinds = [(a["kind"], a["stage_to"]) for a in self.client.get(url + "activities/").data]
        self.assertEqual(kinds[:3], [("stage", "accepted"), ("stage", "lost"), ("stage", "contacted")])
        # Assistants cannot see leads.
        self.login("assist")
        self.assertEqual(self.client.get("/api/crm/leads/").status_code, 403)

    def test_duplicate_phone_is_caught_against_patients_and_leads(self):
        # The patient from setUp has 010 1234-5678.
        self.lead(expect=400, phone="+20 10 1234 5678")
        found = self.client.get("/api/crm/leads/duplicates/", {"phone": "٠١٠١٢٣٤٥٦٧٨"}).data
        self.assertEqual([p["id"] for p in found["patients"]], [self.patient["id"]])
        first = self.lead()
        response = self.client.post("/api/crm/leads/", {"name_en": "Again", "phone": "+201155556666"}, format="json")
        self.assertEqual(response.status_code, 400)
        self.assertIn("duplicates", response.data)
        # Reception can still save it on purpose.
        self.lead(name_en="Hany's wife", allow_duplicate=True)
        # A closed lead does not block a new enquiry from the same number.
        self.post(f"/api/crm/leads/{first['id']}/stage/", {"stage": "lost", "lost_reason": "not_ready"}, expect=200)
        Lead.objects.filter(name_en="Hany's wife").update(stage="lost", lost_reason="other")
        self.lead(name_en="Hany comes back")

    def test_convert_to_patient_and_book_a_consultation(self):
        lead = self.lead(source="referral", whatsapp_opt_in=False, language="en")
        data = self.post(f"/api/crm/leads/{lead['id']}/convert/", {"gender": "male", "date_of_birth": "1990-05-01"}, expect=200)
        patient = self.client.get(f"/api/patients/{data['patient']}/").data
        self.assertEqual((patient["name_en"], patient["phone"], patient["referral_source"]), ("Hany Fathy", "01155556666", "friend"))
        self.assertFalse(patient["whatsapp_opt_in"])
        self.assertEqual(patient["language"], "en")
        self.post(f"/api/crm/leads/{lead['id']}/convert/", {}, expect=400)  # only once
        appt = self.book(patient["id"], at(self.today + timedelta(days=2), 12), procedure=self.root_canal.id)
        data = self.post(f"/api/crm/leads/{lead['id']}/consultation/", {"appointment": appt["id"]}, expect=200)
        self.assertEqual((data["stage"], data["consultation"]), ("consultation", appt["id"]))
        # The patient file shows where they came from.
        crm = self.client.get(f"/api/crm/patients/{patient['id']}/").data
        self.assertEqual(crm["source"]["lead_source"], "referral")
        self.assertEqual(crm["leads"][0]["stage"], "consultation")

    def test_follow_ups_due_feed_the_badge(self):
        self.lead(next_follow_up=str(self.today))
        self.lead(phone="01200000000", next_follow_up=str(self.today + timedelta(days=3)))
        summary = self.client.get("/api/crm/summary/").data
        self.assertEqual((summary["open_leads"], summary["follow_ups_due"], summary["badge"]), (2, 1, 1))
        self.assertEqual(summary["pipeline_value"], "8000.00")


class RecallTests(Phase7Base):
    def setUp(self):
        super().setUp()
        self.implant = Procedure.objects.create(clinic=self.clinic, category=self.root_canal.category, code="IM01",
                                                name_en="Implant", name_ar="زرعة")

    def test_default_rules_and_queue_maths(self):
        rules = self.client.get("/api/crm/recall-rules/").data
        self.assertEqual([(r["name_en"], r["interval_months"]) for r in rules], [("Check-up and cleaning", 6), ("Implant review", 3)])
        pid = self.patient["id"]
        last = self.today - timedelta(days=200)
        self.visit(pid, at(last, 12))
        other = self.add_patient(name_en="Implant", phone="01099999999")
        placed = self.today - timedelta(days=100)
        self.visit(other["id"], at(placed, 12), procedure=self.implant)
        queue = self.client.get("/api/crm/recalls/").data
        rows = {(r["patient"]["id"], r["rule"]["en"]): r for r in queue["results"]}
        self.assertEqual(set(rows), {(pid, "Check-up and cleaning"), (other["id"], "Implant review")})
        checkup = rows[(pid, "Check-up and cleaning")]
        self.assertEqual(checkup["due_date"], add_months(last, 6))
        self.assertEqual(checkup["status"], "overdue")
        self.assertEqual(checkup["days_overdue"], (self.today - add_months(last, 6)).days)
        self.assertEqual(rows[(other["id"], "Implant review")]["due_date"], add_months(placed, 3))

        # Call later hides the row until the day comes; the attempt is counted.
        rule = checkup["rule"]["id"]
        self.post("/api/crm/recall-contacts/", {"patient": pid, "rule": rule, "due_date": str(checkup["due_date"]), "outcome": "call_later"}, expect=400)
        self.post("/api/crm/recall-contacts/", {"patient": pid, "rule": rule, "due_date": str(checkup["due_date"]), "outcome": "call_later",
                                                "snooze_until": str(self.today + timedelta(days=3))})
        queue = self.client.get("/api/crm/recalls/").data
        self.assertNotIn(pid, [r["patient"]["id"] for r in queue["results"]])
        hidden = self.client.get("/api/crm/recalls/", {"hidden": "1"}).data
        row = next(r for r in hidden["results"] if r["patient"]["id"] == pid)
        self.assertEqual((row["hidden"], row["attempts"]), ("snoozed", 1))

        # Booking the implant patient answers the recall; switching a rule off removes its rows.
        self.book(other["id"], at(self.today + timedelta(days=5), 12))
        queue = self.client.get("/api/crm/recalls/").data
        self.assertEqual(queue["count"], 0)
        RecallRule.objects.filter(clinic=self.clinic).update(is_active=False)
        self.assertEqual(self.client.get("/api/crm/recalls/", {"hidden": "1"}).data["count"], 0)

    def test_home_widget_uses_the_queue(self):
        pid = self.patient["id"]
        self.visit(pid, at(self.today - timedelta(days=200), 12))
        data = self.client.get("/api/appointments/recalls/").data
        self.assertEqual([r["id"] for r in data["results"]], [pid])
        rule = RecallRule.objects.get(clinic=self.clinic, kind="checkup")
        self.post("/api/crm/recall-contacts/", {"patient": pid, "rule": rule.pk, "due_date": str(self.today), "outcome": "declined"})
        self.assertEqual(self.client.get("/api/appointments/recalls/").data["count"], 0)

    def test_compliance_counts_who_came_back(self):
        back = self.patient["id"]
        away = self.add_patient(name_en="Away", phone="01088888888")["id"]
        start = self.today - timedelta(days=260)
        self.visit(back, at(start, 10))
        self.visit(away, at(start, 11))
        self.visit(back, at(add_months(start, 6) + timedelta(days=3), 10))
        report = self.client.get("/api/crm/recalls/")  # noqa: F841 (creates the default rules)
        self.login("owner")
        data = self.client.get("/api/reports/recall_compliance/", {"start": str(self.today - timedelta(days=90)), "end": str(self.today)}).data
        row = data["rows"][0]
        self.assertEqual((row["due"], row["returned"], row["rate"]), (2, 1, 50.0))


class CampaignTests(Phase7Base):
    def setUp(self):
        super().setUp()
        self.p1 = self.patient
        self.p2 = self.add_patient(name_en="Laila Samir", name_ar="ليلى سمير", phone="01022223333", gender="female",
                                   date_of_birth=str(self.today.replace(year=self.today.year - 30)), whatsapp_opt_in=False)
        self.p3 = self.add_patient(name_en="Omar Adel", name_ar="عمر عادل", phone="01033334444", gender="male", language="en",
                                   date_of_birth=str(self.today.replace(year=self.today.year - 60, day=1)))
        self.visit(self.p1["id"], at(self.today - timedelta(days=300), 12))
        self.visit(self.p3["id"], at(self.today - timedelta(days=20), 12))
        self.visit(self.p2["id"], at(self.today - timedelta(days=400), 12), status="no_show")

    def preview(self, filters, channel="whatsapp", **extra):
        return self.post("/api/crm/campaigns/preview/", {"channel": channel, "filters": filters,
                                                         "message_ar": "أهلاً {name}، {clinic}", "message_en": "Hi {name} from {clinic}, you owe {balance}", **extra}, expect=200)

    def ids(self, data):
        return sorted(x["id"] for x in data["sample"])

    def test_audience_filters(self):
        self.assertEqual(self.ids(self.preview({"last_visit_before": str(self.today - timedelta(days=180))})), [self.p1["id"]])
        self.assertEqual(self.ids(self.preview({"gender": "female"})), [self.p2["id"]])
        self.assertEqual(self.ids(self.preview({"age_min": 50})), [self.p3["id"]])
        self.assertEqual(self.ids(self.preview({"age_min": 25, "age_max": 40})), [self.p2["id"]])
        self.assertEqual(self.ids(self.preview({"no_shows": 1})), [self.p2["id"]])
        self.assertEqual(self.ids(self.preview({"birthday_month": True})), sorted([self.p2["id"], self.p3["id"]]))
        self.assertEqual(self.ids(self.preview({"procedure_done": self.root_canal.id})), [self.p1["id"]])  # rct line is done
        self.assertNotIn(self.p1["id"], self.ids(self.preview({"procedure_not_done": self.root_canal.id})))
        self.login("owner")
        self.invoice()
        self.login("reception")
        owing = self.preview({"has_balance": True})
        self.assertEqual(self.ids(owing), [self.p1["id"]])
        self.assertEqual(owing["sample"][0]["balance"], "2800.00")
        lead = self.lead()
        leads = self.preview({"audience": "leads", "lead_stages": ["new"]})
        self.assertEqual(self.ids(leads), [lead["id"]])

    def test_consent_language_and_sending(self):
        data = self.preview({})
        self.assertEqual((data["audience"], data["reachable"], data["no_consent"]), (3, 2, 1))
        omar = next(x for x in data["sample"] if x["id"] == self.p3["id"])
        self.assertEqual(omar["body"], "Hi Omar from Okasha Dental, you owe 0")
        mona = next(x for x in data["sample"] if x["id"] == self.p1["id"])
        self.assertEqual(mona["body"], "أهلاً منى، عكاشة لطب الأسنان")
        campaign = self.post("/api/crm/campaigns/", {"name": "Autumn check-up", "channel": "whatsapp", "filters": {},
                                                     "message_ar": "أهلاً {name}", "message_en": "Hi {name}", "cost": "500.00"})
        sent = self.post(f"/api/crm/campaigns/{campaign['id']}/send/", {}, expect=200)
        self.assertEqual(sent["counts"], {"sent": 2, "skipped": 1})
        self.assertEqual(Notification.objects.filter(clinic=self.clinic, channel="whatsapp").count(), 2)
        self.post(f"/api/crm/campaigns/{campaign['id']}/send/", {}, expect=400)
        # SMS goes to everyone (WhatsApp consent is about WhatsApp).
        sms = self.post("/api/crm/campaigns/", {"name": "SMS", "channel": "sms", "filters": {}, "message_ar": "مرحبا"})
        self.assertEqual(self.post(f"/api/crm/campaigns/{sms['id']}/send/", {}, expect=200)["counts"], {"sent": 3})

    def test_attribution_within_thirty_days(self):
        campaign = self.post("/api/crm/campaigns/", {"name": "Whitening offer", "channel": "whatsapp", "filters": {},
                                                     "message_ar": "عرض", "cost": "1000.00"})
        self.post(f"/api/crm/campaigns/{campaign['id']}/send/", {}, expect=200)
        c = Campaign.objects.get(pk=campaign["id"])
        # Mona books and is invoiced after the message; Omar booked before it was sent.
        early = self.visit(self.p3["id"], at(self.today + timedelta(days=3), 13), status="booked")
        Appointment.objects.filter(pk=early.pk).update(created_at=c.sent_at - timedelta(days=1))
        self.book(self.p1["id"], at(self.today + timedelta(days=2), 12))
        self.login("owner")
        self.invoice()
        self.login("reception")
        late = self.visit(self.p1["id"], at(self.today + timedelta(days=40), 12), status="booked")
        Appointment.objects.filter(pk=late.pk).update(created_at=c.sent_at + timedelta(days=31))
        results = self.client.get(f"/api/crm/campaigns/{campaign['id']}/").data["results"]
        self.assertEqual((results["sent"], results["skipped"], results["booked"], results["appointments"]), (2, 1, 1, 1))
        self.assertEqual(results["revenue"], "2800.00")
        self.assertEqual(results["roi"], 180.0)
        rows = self.client.get(f"/api/crm/campaigns/{campaign['id']}/recipients/").data
        omar = next(r for r in rows if r["person"]["id"] == self.p3["id"])
        self.assertEqual((omar["booked"], omar["responded"]), (0, False))
        self.post(f"/api/crm/campaigns/{campaign['id']}/recipients/{omar['id']}/responded/", {}, expect=200)
        self.assertEqual(self.client.get(f"/api/crm/campaigns/{campaign['id']}/").data["results"]["responded"], 2)


class FeedbackTests(Phase7Base):
    def test_reception_and_link_feedback_make_the_nps(self):
        self.assertEqual(nps([5, 5, 4, 2]), 25)
        done = self.visit(self.patient["id"], at(self.today - timedelta(days=1), 12))
        later = self.visit(self.patient["id"], at(self.today + timedelta(days=1), 12), status="booked")
        self.post("/api/crm/feedback/", {"patient": self.patient["id"], "appointment": later.pk, "score": 5}, expect=400)
        self.post("/api/crm/feedback/", {"patient": self.patient["id"], "appointment": done.pk, "score": 6}, expect=400)
        self.post("/api/crm/feedback/", {"patient": self.patient["id"], "appointment": done.pk, "score": 5, "comment": "Lovely"})
        other = self.visit(self.patient["id"], at(self.today - timedelta(days=2), 12))
        link = self.post("/api/crm/feedback/request-link/", {"appointment": other.pk})
        self.client.credentials()  # the patient is not signed in
        page = self.client.get(f"/api/crm/public/feedback/{link['token']}/").data
        self.assertEqual((page["name"]["en"], page["answered"]), ("Mona", False))
        self.post(f"/api/crm/public/feedback/{link['token']}/", {"score": 2, "comment": "Long wait"}, expect=200)
        self.post(f"/api/crm/public/feedback/{link['token']}/", {"score": 5}, expect=400)
        self.login("reception")
        summary = self.client.get("/api/crm/summary/").data
        self.assertEqual((summary["feedback_count"], summary["nps"]), (2, 0))


class ReportTests(Phase7Base):
    def test_report_permissions_follow_module_rights(self):
        # Reception has no "reports" right at all.
        self.assertEqual(self.client.get("/api/reports/").status_code, 403)
        self.make_user("accounts", "accountant")
        self.login("accounts")
        keys = [r["key"] for r in self.client.get("/api/reports/").data]
        self.assertIn("daily_cash", keys)
        self.assertIn("stock", keys)  # accountants approve stock reports
        self.assertNotIn("lead_funnel", keys)  # no CRM right
        self.assertEqual(self.client.get("/api/reports/lead_funnel/").status_code, 403)
        self.assertEqual(self.client.get("/api/reports/appointments/").status_code, 403)
        overview = self.client.get("/api/reports/overview/").data
        self.assertIn("revenue", overview["current"])
        self.assertNotIn("visits", overview["current"])
        # A receptionist given "reports" sees only the reports of her modules.
        role = Role.objects.get(clinic=self.clinic, code="receptionist")
        role.permissions = {**role.permissions, "reports": ["view"]}
        role.save()
        self.login("reception")
        keys = {r["key"] for r in self.client.get("/api/reports/").data}
        self.assertTrue({"daily_cash", "appointments", "lead_funnel", "new_patients"} <= keys)
        self.assertFalse({"payroll", "stock", "lab_turnaround", "plan_acceptance"} & keys)
        self.assertEqual(self.client.get("/api/reports/payroll/").status_code, 403)

    def test_totals_match_the_module_dashboards(self):
        self.login("owner")
        inv = self.invoice(extra_lines=[{"description": "X-ray", "unit_price": "300.00"}])
        self.client.post("/api/billing/payments/", {"patient": self.patient["id"], "invoice": inv["id"], "amount": "1000.00", "method": "cash"}, format="json")
        self.client.post("/api/billing/payments/", {"patient": self.patient["id"], "invoice": inv["id"], "amount": "500.00", "method": "card"}, format="json")
        params = {"start": str(self.today.replace(day=1)), "end": str(self.today)}
        finance = self.client.get("/api/billing/dashboard/", params).data
        cash = self.client.get("/api/reports/daily_cash/", params).data
        self.assertEqual(cash["totals"]["total"], finance["collected"])
        self.assertEqual(cash["totals"]["cash"], "1000.00")
        dentist = self.client.get("/api/reports/revenue_dentist/", params).data
        sara = next(r for r in dentist["rows"] if r["dentist"]["en"] == "Dr Sara")
        self.assertEqual((sara["billed"], sara["collected"]), (finance["by_dentist"][0]["billed"], finance["by_dentist"][0]["collected"]))
        self.assertEqual(dentist["totals"]["billed"], finance["billed"])  # lines without a dentist show as their own row
        branch = self.client.get("/api/reports/revenue_branch/", params).data
        self.assertEqual(branch["totals"]["billed"], finance["billed"])
        aging = self.client.get("/api/reports/aging/").data
        self.assertEqual(aging["totals"]["total"], finance["now"]["outstanding"])
        overview = self.client.get("/api/reports/overview/", params).data
        self.assertEqual((overview["current"]["revenue"], overview["current"]["collections"]), (finance["billed"], finance["collected"]))
        self.assertEqual(overview["current"]["new_patients"], 1)
        # CSV export with a total row.
        response = self.client.get("/api/reports/daily_cash/", {**params, "export": "csv"})
        self.assertEqual(response["Content-Type"], "text/csv; charset=utf-8")
        text = response.content.decode("utf-8-sig")
        self.assertIn("1500.00", text.splitlines()[-1])
        self.assertEqual(Decimal(cash["totals"]["total"]), Decimal("1500.00"))


class AttachmentTests(Phase7Base):
    """Opening a patient attachment whose file is gone from storage used to be a server error."""

    def test_missing_file_is_a_clear_404(self):
        import os  # noqa: PLC0415
        import shutil  # noqa: PLC0415
        import tempfile  # noqa: PLC0415

        from django.core.files.uploadedfile import SimpleUploadedFile  # noqa: PLC0415
        from django.test import override_settings  # noqa: PLC0415

        from erp.core.models import StoredFile  # noqa: PLC0415

        media = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, media, ignore_errors=True)
        with override_settings(MEDIA_ROOT=media):
            self.login("owner")
            upload = SimpleUploadedFile("أشعة بانوراما.png", b"\x89PNG fake", content_type="image/png")
            r = self.client.post("/api/files/", {"file": upload, "kind": "xray", "attached_model": "patients.patient",
                                                 "attached_id": self.patient["id"]}, format="multipart")
            self.assertEqual(r.status_code, 201, r.content)
            self.assertEqual(self.client.get(f"/api/files/{r.data['id']}/download/").status_code, 200)
            os.remove(StoredFile.objects.get(pk=r.data["id"]).file.path)
            missing = self.client.get(f"/api/files/{r.data['id']}/download/")
            self.assertEqual(missing.status_code, 404)
            self.assertIn("missing", missing.data["detail"])
