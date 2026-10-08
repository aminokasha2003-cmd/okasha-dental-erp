"""Phase 2 finish line: a dentist charts the mouth, builds a treatment plan
from the procedure catalog, books and completes its lines through signed visit
notes, writes prescriptions and has the patient sign consent forms, while
reception stays out of clinical records."""

from datetime import timedelta

from erp.appointments.tests.test_phase1 import Phase1Base, at


class Phase2Base(Phase1Base):
    def setUp(self):
        super().setUp()
        self.login("owner")
        self.patient = self.add_patient()
        self.login("drsara")

    def plan(self, **extra):
        response = self.client.post(
            "/api/clinical/plans/",
            {"patient": self.patient["id"], "dentist": self.dentist.id, "title": "Upper right", **extra},
            format="json",
        )
        self.assertEqual(response.status_code, 201, response.content)
        return response.data

    def line(self, plan_id, expect=201, **extra):
        data = {"plan": plan_id, "procedure": self.root_canal.id, "tooth": 16, "price": "1500.00", **extra}
        response = self.client.post("/api/clinical/plan-lines/", data, format="json")
        self.assertEqual(response.status_code, expect, response.content)
        return response.data


class ChartTests(Phase2Base):
    def test_tooth_record_is_saved_and_replaced(self):
        url = "/api/clinical/chart/"
        data = {"patient": self.patient["id"], "tooth": 26, "surfaces": {"O": "caries", "M": "sound"}}
        self.assertEqual(self.client.post(url, data, format="json").status_code, 200)
        data = {"patient": self.patient["id"], "tooth": 26, "surfaces": {"O": "filling"}, "root_canal_treated": True}
        response = self.client.post(url, data, format="json")
        self.assertEqual(response.data["surfaces"], {"O": "filling"})
        chart = self.client.get(url, {"patient": self.patient["id"]}).data
        self.assertEqual(len(chart), 1)
        self.assertTrue(chart[0]["root_canal_treated"])

    def test_bad_teeth_and_surfaces_are_refused(self):
        url = "/api/clinical/chart/"
        for bad in ({"tooth": 19}, {"tooth": 11, "surfaces": {"X": "caries"}}, {"tooth": 11, "surfaces": {"O": "gold"}}):
            response = self.client.post(url, {"patient": self.patient["id"], **bad}, format="json")
            self.assertEqual(response.status_code, 400, bad)


class PlanTests(Phase2Base):
    def test_plan_follows_its_lines_through_visit_notes(self):
        plan = self.plan()
        first = self.line(plan["id"], surfaces="odx", discount="100")
        self.assertEqual(first["surfaces"], "DO")
        self.assertEqual(first["net"], "1400.00")
        second = self.line(plan["id"], tooth=17)
        plan = self.client.get(f"/api/clinical/plans/{plan['id']}/").data
        self.assertEqual(plan["status"], "proposed")
        self.assertEqual(plan["totals"]["total"], "2900.00")

        accept = self.client.post(f"/api/clinical/plans/{plan['id']}/status/", {"status": "accepted"}, format="json")
        self.assertEqual(accept.data["status"], "accepted")

        note = self.client.post(
            "/api/clinical/visit-notes/",
            {"patient": self.patient["id"], "dentist": self.dentist.id, "work_done": "RCT 16", "completed_lines": [first["id"]]},
            format="json",
        )
        self.assertEqual(note.status_code, 201, note.content)
        plan = self.client.get(f"/api/clinical/plans/{plan['id']}/").data
        self.assertEqual(plan["status"], "in_progress")
        self.assertEqual(plan["totals"]["done"], "1400.00")

        self.client.patch(f"/api/clinical/plan-lines/{second['id']}/", {"status": "done"}, format="json")
        self.assertEqual(self.client.get(f"/api/clinical/plans/{plan['id']}/").data["status"], "completed")
        self.line(plan["id"], expect=400)  # closed plans take no new lines

    def test_price_defaults_to_catalog_and_discount_is_capped(self):
        self.root_canal.default_price = 2000
        self.root_canal.save()
        plan = self.plan()
        response = self.client.post(
            "/api/clinical/plan-lines/", {"plan": plan["id"], "procedure": self.root_canal.id, "tooth": 36}, format="json"
        )
        self.assertEqual(response.data["price"], "2000.00")
        self.line(plan["id"], discount="5000", expect=400)

    def test_started_work_cannot_be_deleted(self):
        plan = self.plan()
        line = self.line(plan["id"], status="done")
        self.login("owner")  # dentists have no delete right by default
        self.assertEqual(self.client.delete(f"/api/clinical/plan-lines/{line['id']}/").status_code, 400)
        self.assertEqual(self.client.delete(f"/api/clinical/plans/{plan['id']}/").status_code, 400)

    def test_line_links_to_appointment_of_same_patient_only(self):
        self.login("owner")
        stranger = self.add_patient(name_en="Someone", phone="01099999999")
        visit = self.book(stranger["id"], at(self.tomorrow, 11))
        self.login("drsara")
        plan = self.plan()
        self.line(plan["id"], appointment=visit["id"], expect=400)
        mine = self.book(self.patient["id"], at(self.tomorrow + timedelta(days=1), 11))
        line = self.line(plan["id"], appointment=mine["id"])
        self.assertIsNotNone(line["appointment_start"])


class NoteTests(Phase2Base):
    def test_signed_note_is_locked(self):
        note = self.client.post(
            "/api/clinical/visit-notes/", {"patient": self.patient["id"], "findings": "Deep caries 26"}, format="json"
        ).data
        signed = self.client.post(f"/api/clinical/visit-notes/{note['id']}/sign/")
        self.assertEqual(signed.status_code, 200, signed.content)
        self.assertTrue(signed.data["signed_by_name"])
        url = f"/api/clinical/visit-notes/{note['id']}/"
        self.assertEqual(self.client.patch(url, {"findings": "x"}, format="json").status_code, 400)
        self.login("owner")
        self.assertEqual(self.client.delete(url).status_code, 400)

    def test_assistant_reads_but_cannot_sign(self):
        note = self.client.post("/api/clinical/visit-notes/", {"patient": self.patient["id"], "findings": "ok"}, format="json").data
        self.login("assist")
        self.assertEqual(self.client.get("/api/clinical/visit-notes/", {"patient": self.patient["id"]}).status_code, 200)
        self.assertEqual(self.client.post(f"/api/clinical/visit-notes/{note['id']}/sign/").status_code, 403)

    def test_reception_is_kept_out_of_clinical_records(self):
        self.login("reception")
        for path in ("chart", "plans", "visit-notes", "prescriptions", "consents"):
            self.assertEqual(self.client.get(f"/api/clinical/{path}/").status_code, 403, path)

    def test_other_clinic_cannot_see_records(self):
        self.plan()
        self.login("other")
        self.assertEqual(self.client.get("/api/clinical/plans/").data, [])


class PrescriptionAndConsentTests(Phase2Base):
    def test_prescription_needs_named_medicines(self):
        url = "/api/clinical/prescriptions/"
        self.assertEqual(self.client.post(url, {"patient": self.patient["id"], "items": []}, format="json").status_code, 400)
        response = self.client.post(
            url,
            {"patient": self.patient["id"], "dentist": self.dentist.id, "items": [{"drug": "Amoxicillin 500mg", "dose": "1 cap", "frequency": "every 8h", "duration": "5 days"}]},
            format="json",
        )
        self.assertEqual(response.status_code, 201, response.content)
        self.assertEqual(response.data["items"][0]["notes"], "")

    def test_consent_from_template_is_signed_once(self):
        templates = self.client.get("/api/clinical/consent-templates/").data["results"]
        self.assertEqual(len(templates), 4)
        consent = self.client.post(
            "/api/clinical/consents/", {"patient": self.patient["id"], "template": templates[0]["id"], "language": "ar"}, format="json"
        )
        self.assertEqual(consent.status_code, 201, consent.content)
        self.assertEqual(consent.data["title"], templates[0]["title_ar"])
        url = f"/api/clinical/consents/{consent.data['id']}/sign/"
        self.assertEqual(self.client.post(url, {"signer_name": "Mona", "signature": "nope"}, format="json").status_code, 400)
        signature = "data:image/png;base64,iVBORw0KGgo="
        self.assertEqual(self.client.post(url, {"signer_name": "Mona", "signature": signature}, format="json").status_code, 200)
        self.assertEqual(self.client.post(url, {"signer_name": "Mona", "signature": signature}, format="json").status_code, 400)
        self.login("owner")
        self.assertEqual(self.client.delete(f"/api/clinical/consents/{consent.data['id']}/").status_code, 400)
