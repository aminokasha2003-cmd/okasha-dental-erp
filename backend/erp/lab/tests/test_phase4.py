"""Phase 4 finish line: a dentist orders a lab case from a treatment plan line,
a technician is assigned and moves it through the stages with design files,
the dentist is told when it is ready, work can be remade, and the owner sees
cost per unit. Technicians never see patient contact details."""

from datetime import timedelta

from django.core.files.uploadedfile import SimpleUploadedFile
from django.utils import timezone

from erp.appointments.tests.test_phase1 import at
from erp.clinical.tests.test_phase2 import Phase2Base
from erp.core.models import Notification
from erp.masterdata.models import Procedure, StaffMember


class Phase4Base(Phase2Base):
    def setUp(self):
        super().setUp()
        c = self.clinic
        self.crown_proc = Procedure.objects.create(
            clinic=c, category=self.root_canal.category, code="CRZ", name_en="Zirconia crown", name_ar="تاج زركونيا",
            needs_lab=True, default_duration_minutes=60,
        )
        self.tech_user = self.make_user("tech", "lab_technician")
        self.tech = StaffMember.objects.create(
            clinic=c, user=self.tech_user, name_en="Hany", name_ar="هاني", staff_type="technician"
        )
        plan = self.plan()
        self.rct = self.line(plan["id"])
        self.crown = self.line(plan["id"], procedure=self.crown_proc.id, tooth=26, price="6000.00")
        self.due = timezone.localdate() + timedelta(days=5)

    def order(self, expect=201, **extra):
        data = {"plan_line": self.crown["id"], "shade": "A2", "due_date": str(self.due), **extra}
        response = self.client.post("/api/lab/cases/", data, format="json")
        self.assertEqual(response.status_code, expect, response.content)
        return response.data

    def move(self, case, stage, expect=200, **extra):
        response = self.client.post(f"/api/lab/cases/{case['id']}/stage/", {"stage": stage, **extra}, format="json")
        self.assertEqual(response.status_code, expect, response.content)
        return response.data


class OrderTests(Phase4Base):
    def test_dentist_orders_from_the_plan_line(self):
        orderable = self.client.get("/api/lab/cases/orderable/", {"patient": self.patient["id"]}).data
        self.assertEqual(orderable[0]["id"], self.crown["id"])  # lab procedures first
        self.assertEqual((orderable[0]["restoration"], orderable[0]["material"]), ("crown", "zirconia"))
        case = self.order(restoration="crown", material="zirconia")
        self.assertEqual(case["number"], "LAB-00001")
        self.assertEqual(case["patient"], self.patient["id"])
        self.assertEqual(case["dentist"], self.dentist.id)
        self.assertEqual(case["stage"], "received")
        self.assertEqual([e["stage"] for e in case["events"]], ["received"])
        self.assertNotIn("phone", case["patient_info"])
        # One open case per plan line.
        self.order(expect=400)
        orderable = self.client.get("/api/lab/cases/orderable/", {"patient": self.patient["id"]}).data
        self.assertTrue(next(r for r in orderable if r["id"] == self.crown["id"])["has_open_case"])

    def test_try_in_visit_must_be_the_same_patient(self):
        self.login("owner")
        other = self.add_patient(name_en="Other", name_ar="آخر", phone="01099998888")
        visit = self.book(other["id"], at(self.tomorrow, 11))
        self.login("drsara")
        self.order(expect=400, appointment=visit["id"])

    def test_reception_has_no_lab_access(self):
        self.login("reception")
        self.assertEqual(self.client.get("/api/lab/cases/").status_code, 403)


class TechnicianTests(Phase4Base):
    def test_technician_works_the_case_and_dentist_is_told_when_ready(self):
        case = self.order()
        self.login("tech")
        listed = self.client.get("/api/lab/cases/", {"open": 1}).data["results"]
        self.assertEqual(len(listed), 1)
        self.assertNotIn("phone", listed[0]["patient_info"])
        self.assertEqual(self.client.get(f"/api/patients/{self.patient['id']}/").status_code, 403)
        claimed = self.client.patch(f"/api/lab/cases/{case['id']}/", {"technician": self.tech.id, "material_cost": "450.00", "labour_cost": "300.00"}, format="json")
        self.assertEqual(claimed.status_code, 200, claimed.content)
        self.assertEqual(self.client.get("/api/lab/cases/", {"technician": "me"}).data["count"], 1)

        upload = self.client.post(
            "/api/files/",
            {"file": SimpleUploadedFile("crown26.stl", b"solid crown", content_type="model/stl"), "kind": "scan",
             "attached_model": "lab.labcase", "attached_id": case["id"]},
            format="multipart",
        )
        self.assertEqual(upload.status_code, 201, upload.content)
        files = self.client.get("/api/files/", {"attached_model": "lab.labcase", "attached_id": case["id"]}).data
        self.assertEqual(files["count"], 1)

        for stage in ("design", "milling", "finishing"):
            self.move(case, stage)
        ready = self.move(case, "ready", note="Checked contacts")
        self.assertEqual([e["stage"] for e in ready["events"]], ["received", "design", "milling", "finishing", "ready"])
        note = Notification.objects.get(recipient_user=self.dentist_user)
        self.assertIn("LAB-00001", note.body)
        summary = self.client.get("/api/lab/summary/").data
        self.assertEqual(summary["by_stage"]["ready"], 1)
        self.assertEqual(summary["mine"], 1)

        self.login("drsara")
        self.assertEqual(self.client.get("/api/lab/summary/").data["attention"], 1)
        delivered = self.move(case, "delivered")
        self.assertFalse(delivered["is_open"])
        self.move(case, "ready", expect=400)

    def test_stage_can_step_back_but_not_stay(self):
        case = self.order()
        self.move(case, "milling")
        self.move(case, "design", note="Margin redo")
        self.move(case, "design", expect=400)


class RemakeAndCostTests(Phase4Base):
    def test_remake_and_cost_per_unit(self):
        case = self.order(units=1, material_cost="400.00", labour_cost="200.00")
        self.move(case, "ready")
        self.login("owner")
        remake = self.client.post(
            f"/api/lab/cases/{case['id']}/remake/",
            {"reason": "shade", "charged_to": "lab", "due_date": str(self.due + timedelta(days=3)), "note": "Too bright"},
            format="json",
        )
        self.assertEqual(remake.status_code, 201, remake.content)
        self.assertEqual(remake.data["remake_of_number"], "LAB-00001")
        self.assertEqual(remake.data["number"], "LAB-00002")
        first = self.client.get(f"/api/lab/cases/{case['id']}/").data
        self.assertIsNotNone(first["cancelled_at"])
        self.assertEqual(first["remake_numbers"], ["LAB-00002"])
        # Only one remake in the lab at a time.
        again = self.client.post(f"/api/lab/cases/{case['id']}/remake/", {"reason": "fit", "charged_to": "lab", "due_date": str(self.due)}, format="json")
        self.assertEqual(again.status_code, 400)

        second = remake.data
        self.client.patch(f"/api/lab/cases/{second['id']}/", {"material_cost": "500.00", "labour_cost": "100.00", "units": 2}, format="json")
        self.move(second, "ready")
        self.move(second, "delivered")
        report = self.client.get("/api/lab/costs/").data
        row = report["rows"][0]
        self.assertEqual((row["restoration"], row["material"]), ("crown", "zirconia"))
        self.assertEqual((row["cases"], row["units"], row["cost"], row["cost_per_unit"]), (1, 2, "600.00", "300.00"))
        self.assertEqual((row["remakes"], row["scrap_cost"]), (1, "600.00"))
        self.assertEqual(report["remake_rate"], 100.0)

        self.login("tech")
        self.assertEqual(self.client.get("/api/lab/costs/").status_code, 403)

    def test_cancel_needs_a_reason_and_delete_rights(self):
        case = self.order()
        self.login("tech")
        self.assertEqual(self.client.post(f"/api/lab/cases/{case['id']}/cancel/", {"reason": "x"}, format="json").status_code, 403)
        self.login("owner")
        self.assertEqual(self.client.post(f"/api/lab/cases/{case['id']}/cancel/", {}, format="json").status_code, 400)
        done = self.client.post(f"/api/lab/cases/{case['id']}/cancel/", {"reason": "Plan changed"}, format="json")
        self.assertEqual(done.status_code, 200)
        self.assertEqual(self.client.patch(f"/api/lab/cases/{case['id']}/", {"shade": "A3"}, format="json").status_code, 400)
        # The plan line is free for a new order.
        self.login("drsara")
        self.order()
