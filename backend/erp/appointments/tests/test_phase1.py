"""Phase 1 finish line: reception registers a patient with alerts, books them on
a chair, the clash and hours checks hold, the visit moves through the waiting
room to completion, reminders go out in the patient's language, and each role
only sees what it should."""

from datetime import datetime, time, timedelta

from django.utils import timezone

from erp.appointments.models import Appointment
from erp.core.models import Notification
from erp.core.tests.test_phase0 import Phase0Base
from erp.masterdata.models import Branch, Chair, Procedure, ProcedureCategory, StaffMember, WorkingHours
from erp.patients.models import Patient


def at(day, hour, minute=0):
    return timezone.make_aware(datetime.combine(day, time(hour, minute)))


class Phase1Base(Phase0Base):
    def setUp(self):
        super().setUp()
        c = self.clinic
        self.branch = Branch.objects.create(clinic=c, name_en="Main", name_ar="الرئيسي")
        self.chair1 = Chair.objects.create(clinic=c, branch=self.branch, name_en="Chair 1", name_ar="كرسي 1")
        self.chair2 = Chair.objects.create(clinic=c, branch=self.branch, name_en="Chair 2", name_ar="كرسي 2")
        for weekday in range(7):
            WorkingHours.objects.create(clinic=c, branch=self.branch, weekday=weekday, opens_at=time(10), closes_at=time(22))
        self.dentist_user = self.make_user("drsara", "dentist")
        self.dentist = StaffMember.objects.create(
            clinic=c, user=self.dentist_user, name_en="Dr Sara", name_ar="د. سارة", staff_type="dentist"
        )
        self.dentist2 = StaffMember.objects.create(clinic=c, name_en="Dr Omar", name_ar="د. عمر", staff_type="dentist")
        category = ProcedureCategory.objects.create(clinic=c, name_en="Endo", name_ar="علاج عصب")
        self.root_canal = Procedure.objects.create(
            clinic=c, category=category, code="RCT", name_en="Root canal", name_ar="علاج عصب", default_duration_minutes=60
        )
        self.make_user("reception", "receptionist")
        self.make_user("assist", "assistant")
        self.tomorrow = timezone.localdate() + timedelta(days=1)

    def add_patient(self, **extra):
        data = {"name_ar": "منى أحمد", "name_en": "Mona Ahmed", "phone": "010 1234-5678", **extra}
        response = self.client.post("/api/patients/", data, format="json")
        self.assertEqual(response.status_code, 201, response.content)
        return response.data

    def book(self, patient_id, start, chair=None, dentist=None, expect=201, **extra):
        data = {
            "patient": patient_id,
            "dentist": (dentist or self.dentist).id,
            "branch": self.branch.id,
            "chair": (chair or self.chair1).id,
            "start": start.isoformat(),
            **extra,
        }
        response = self.client.post("/api/appointments/", data, format="json")
        self.assertEqual(response.status_code, expect, response.content)
        return response.data


class PatientTests(Phase1Base):
    def test_reception_registers_patient_with_file_number_and_alerts(self):
        self.login("reception")
        first = self.add_patient()
        second = self.add_patient(name_ar="", name_en="Karim", phone="+20 111 222 3333")
        self.assertEqual(first["file_number"], "P-00001")
        self.assertEqual(second["file_number"], "P-00002")
        self.assertEqual(first["phone"], "01012345678")

        response = self.client.post(
            "/api/patients/alerts/", {"patient": first["id"], "kind": "allergy", "text": "Penicillin"}, format="json"
        )
        self.assertEqual(response.status_code, 201, response.content)
        patient = self.client.get(f"/api/patients/{first['id']}/").data
        self.assertEqual([a["text"] for a in patient["alerts"]], ["Penicillin"])

    def test_name_is_required_in_one_language(self):
        self.login("reception")
        response = self.client.post("/api/patients/", {"phone": "0100"}, format="json")
        self.assertEqual(response.status_code, 400)

    def test_search_by_arabic_name_variants_phone_and_file_number(self):
        self.login("reception")
        mona = self.add_patient(name_ar="أمل إبراهيم", name_en="Amal Ibrahim", phone="01001112222")
        self.add_patient(name_ar="خالد", name_en="Khaled", phone="01229998888")

        def found(term):
            return [p["id"] for p in self.client.get("/api/patients/", {"search": term}).data["results"]]

        self.assertEqual(found("امل ابراهيم"), [mona["id"]])  # typed without hamza
        self.assertEqual(found("amal"), [mona["id"]])
        self.assertEqual(found("٠١٠٠١١١٢٢٢٢"), [mona["id"]])  # Arabic digits
        self.assertEqual(found("+201001112222"), [mona["id"]])  # with country code
        self.assertEqual(found(mona["file_number"]), [mona["id"]])
        self.assertEqual(len(found("")), 2)

    def test_medical_history_is_for_clinical_staff_only(self):
        self.login("reception")
        patient = self.add_patient()
        url = f"/api/patients/{patient['id']}/medical-history/"
        self.assertEqual(self.client.get(url).status_code, 403)

        self.login("drsara")
        self.assertEqual(self.client.get(url).data, {"exists": False})
        response = self.client.put(url, {"diabetes": True, "allergies": "Penicillin"}, format="json")
        self.assertEqual(response.status_code, 200, response.content)
        self.assertTrue(self.client.get(url).data["diabetes"])

        self.login("assist")  # clinical view, no edit
        self.assertEqual(self.client.get(url).status_code, 200)
        self.assertEqual(self.client.patch(url, {"smoker": True}, format="json").status_code, 403)

    def test_deleting_a_patient_only_closes_the_file(self):
        self.login("owner")
        patient = self.add_patient()
        self.assertEqual(self.client.delete(f"/api/patients/{patient['id']}/").status_code, 204)
        self.assertFalse(Patient.objects.get(pk=patient["id"]).is_active)

    def test_patients_are_private_to_their_clinic(self):
        self.login("reception")
        patient = self.add_patient()
        self.login("other")
        self.assertEqual(self.client.get(f"/api/patients/{patient['id']}/").status_code, 404)
        self.assertEqual(self.client.get("/api/patients/").data["count"], 0)


class AppointmentTests(Phase1Base):
    def test_booking_uses_procedure_duration_and_blocks_clashes(self):
        self.login("reception")
        patient = self.add_patient()
        other = self.add_patient(name_ar="خالد", phone="01229998888")
        first = self.book(patient["id"], at(self.tomorrow, 11), procedure=self.root_canal.id)
        self.assertEqual(first["duration_minutes"], 60)

        # Same chair, overlapping: refused. Same dentist on another chair: refused.
        clash = self.book(other["id"], at(self.tomorrow, 11, 30), dentist=self.dentist2, expect=400)
        self.assertIn("chair", clash)
        clash = self.book(other["id"], at(self.tomorrow, 11, 30), chair=self.chair2, expect=400)
        self.assertIn("dentist", clash)
        # Another dentist on another chair, or right after: fine.
        self.book(other["id"], at(self.tomorrow, 11, 30), chair=self.chair2, dentist=self.dentist2)
        self.book(other["id"], at(self.tomorrow, 12))

    def test_outside_working_hours_needs_explicit_override(self):
        self.login("reception")
        patient = self.add_patient()
        refused = self.book(patient["id"], at(self.tomorrow, 9), expect=400)
        self.assertEqual(refused["code"], ["outside_hours"])
        self.book(patient["id"], at(self.tomorrow, 9), allow_outside_hours=True)

    def test_visit_moves_through_waiting_room(self):
        self.login("reception")
        patient = self.add_patient()
        today = timezone.localdate()
        appointment = self.book(patient["id"], timezone.now().replace(second=0, microsecond=0), allow_outside_hours=True)
        url = f"/api/appointments/{appointment['id']}/status/"

        self.assertEqual(self.client.post(url, {"status": "completed"}, format="json").status_code, 400)
        checked_in = self.client.post(url, {"status": "arrived"}, format="json").data
        self.assertIsNotNone(checked_in["arrived_at"])
        queue = self.client.get("/api/appointments/queue/").data
        self.assertEqual([a["id"] for a in queue["waiting"]], [appointment["id"]])

        self.client.post(url, {"status": "in_chair"}, format="json")
        queue = self.client.get("/api/appointments/queue/").data
        self.assertEqual((len(queue["waiting"]), len(queue["in_chair"])), (0, 1))
        done = self.client.post(url, {"status": "completed"}, format="json").data
        self.assertEqual(done["status"], "completed")
        day = self.client.get("/api/appointments/", {"date": today.isoformat()}).data
        self.assertEqual([a["status"] for a in day], ["completed"])

    def test_cancelled_slot_can_be_rebooked_and_old_one_cannot_return(self):
        self.login("reception")
        patient = self.add_patient()
        first = self.book(patient["id"], at(self.tomorrow, 14))
        response = self.client.post(
            f"/api/appointments/{first['id']}/status/", {"status": "cancelled", "cancel_reason": "Travelling"}, format="json"
        )
        self.assertEqual(response.data["cancel_reason"], "Travelling")
        self.book(patient["id"], at(self.tomorrow, 14))
        back = self.client.post(f"/api/appointments/{first['id']}/status/", {"status": "booked"}, format="json")
        self.assertEqual(back.status_code, 400)

    def test_moving_an_appointment_checks_clashes_too(self):
        self.login("reception")
        patient = self.add_patient()
        self.book(patient["id"], at(self.tomorrow, 15))
        second = self.book(patient["id"], at(self.tomorrow, 16))
        response = self.client.patch(
            f"/api/appointments/{second['id']}/", {"start": at(self.tomorrow, 15, 15).isoformat()}, format="json"
        )
        self.assertEqual(response.status_code, 400)
        self.assertEqual(self.client.patch(f"/api/appointments/{second['id']}/", {"notes": "x"}, format="json").status_code, 200)

    def test_reminders_go_once_in_patient_language(self):
        self.login("reception")
        ar = self.add_patient()
        en = self.add_patient(name_en="John", name_ar="", phone="01111111111", language="en")
        quiet = self.add_patient(name_ar="سعاد", phone="01222222222", whatsapp_opt_in=False)
        for i, p in enumerate((ar, en, quiet)):
            self.book(p["id"], at(self.tomorrow, 17 + i))
        self.assertEqual(self.client.get("/api/appointments/reminders/").data["due"], 2)
        self.assertEqual(self.client.post("/api/appointments/send-reminders/").data, {"sent": 2, "failed": 0})
        bodies = list(Notification.objects.filter(channel="whatsapp").values_list("body", flat=True))
        self.assertTrue(any(b.startswith("مرحباً منى أحمد") for b in bodies))
        self.assertTrue(any(b.startswith("Hello John") for b in bodies))
        self.assertEqual(self.client.post("/api/appointments/send-reminders/").data["sent"], 0)

    def test_roles(self):
        self.login("reception")
        patient = self.add_patient()
        appointment = self.book(patient["id"], at(self.tomorrow, 18))
        self.login("assist")  # view only
        self.assertEqual(self.client.get("/api/appointments/", {"date": self.tomorrow.isoformat()}).status_code, 200)
        self.assertEqual(
            self.client.post(f"/api/appointments/{appointment['id']}/status/", {"status": "arrived"}, format="json").status_code, 403
        )
        self.book(patient["id"], at(self.tomorrow, 19), expect=403)
        self.login("drsara")
        me = self.client.get("/api/me/").data
        self.assertEqual(me["staff_member"]["id"], self.dentist.id)

    def test_cannot_book_with_another_clinics_chair(self):
        other_branch = Branch.objects.create(clinic=self.other_clinic, name_en="X", name_ar="س")
        other_chair = Chair.objects.create(clinic=self.other_clinic, branch=other_branch, name_en="C", name_ar="ك")
        self.login("reception")
        patient = self.add_patient()
        self.book(patient["id"], at(self.tomorrow, 12), chair=other_chair, expect=400)

    def test_send_reminders_command(self):
        from django.core.management import call_command

        patient = Patient.objects.create(clinic=self.clinic, name_ar="هدى", phone="01000000000")
        Appointment.objects.create(
            clinic=self.clinic, patient=patient, dentist=self.dentist, branch=self.branch, start=at(self.tomorrow, 12)
        )
        call_command("send_reminders")
        self.assertIsNotNone(Appointment.objects.get().reminder_sent_at)


class PatientFileTests(Phase1Base):
    def test_staff_notes_keep_author_and_alert_guidance(self):
        self.login("reception")
        patient = self.add_patient()
        note = self.client.post("/api/patients/notes/", {"patient": patient["id"], "text": "Anxious with injections"}, format="json")
        self.assertEqual(note.status_code, 201, note.content)
        self.assertEqual(note.data["author"], "reception")
        self.assertEqual(self.client.patch(f"/api/patients/notes/{note.data['id']}/", {"text": "x"}, format="json").status_code, 405)
        self.client.post(
            "/api/patients/alerts/",
            {"patient": patient["id"], "kind": "allergy", "text": "Penicillin", "guidance": "Avoid amoxicillin"},
            format="json",
        )
        alerts = self.client.get(f"/api/patients/{patient['id']}/").data["alerts"]
        self.assertEqual(alerts[0]["guidance"], "Avoid amoxicillin")

    def test_remind_one_visit_now(self):
        self.login("reception")
        patient = self.add_patient()
        appointment = self.book(patient["id"], at(self.tomorrow + timedelta(days=3), 12))
        response = self.client.post(f"/api/appointments/{appointment['id']}/remind/")
        self.assertEqual(response.status_code, 200, response.content)
        self.assertIsNotNone(response.data["reminder_sent_at"])
        self.login("assist")
        self.assertEqual(self.client.post(f"/api/appointments/{appointment['id']}/remind/").status_code, 403)
