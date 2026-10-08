"""End-to-end checks for the phase 0 finish line: an admin can log in, create
users with roles, set up the clinic, its chairs and its procedure catalog in
both languages, and see every change in the audit log."""

import shutil
import tempfile

from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import override_settings
from rest_framework.test import APITestCase

from erp.core import notifications
from erp.core.models import AuditEntry, Role, User
from erp.core.setup import create_clinic
from erp.masterdata.catalog import load_starter_catalog
from erp.masterdata.models import Branch, Procedure

PASSWORD = "Str0ng-pass-123"


class Phase0Base(APITestCase):
    def setUp(self):
        self.clinic, self.owner = create_clinic("Okasha Dental", "عكاشة لطب الأسنان", "owner", PASSWORD)
        self.other_clinic, self.other_owner = create_clinic("Other Clinic", "عيادة أخرى", "other", PASSWORD)

    def login(self, username, password=PASSWORD):
        response = self.client.post("/api/auth/token/", {"username": username, "password": password}, format="json")
        self.assertEqual(response.status_code, 200, response.content)
        self.client.credentials(HTTP_AUTHORIZATION=f"Bearer {response.data['access']}")

    def make_user(self, username, role_code, clinic=None):
        clinic = clinic or self.clinic
        user = User(username=username, clinic=clinic)
        user.set_password(PASSWORD)
        user.save()
        user.roles.add(Role.objects.get(clinic=clinic, code=role_code))
        return user


class AuthAndRolesTests(Phase0Base):
    def test_new_clinic_gets_six_default_roles(self):
        codes = set(Role.objects.filter(clinic=self.clinic).values_list("code", flat=True))
        self.assertEqual(codes, {"owner", "dentist", "receptionist", "assistant", "lab_technician", "accountant"})

    def test_login_and_me_returns_clinic_and_permissions(self):
        self.login("owner")
        response = self.client.get("/api/me/")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data["clinic"]["name_ar"], "عكاشة لطب الأسنان")
        self.assertIn("approve", response.data["permissions"]["billing"])

    def test_wrong_password_is_rejected(self):
        response = self.client.post("/api/auth/token/", {"username": "owner", "password": "nope"}, format="json")
        self.assertEqual(response.status_code, 401)

    def test_owner_creates_user_with_two_roles(self):
        self.login("owner")
        roles = Role.objects.filter(clinic=self.clinic, code__in=["dentist", "lab_technician"])
        response = self.client.post(
            "/api/users/",
            {"username": "rana", "first_name": "Rana", "password": PASSWORD, "roles": [r.pk for r in roles], "language": "ar"},
            format="json",
        )
        self.assertEqual(response.status_code, 201, response.content)
        rana = User.objects.get(username="rana")
        self.assertEqual(rana.clinic, self.clinic)
        self.assertTrue(rana.has_module_perm("clinical", "edit"))
        self.assertTrue(rana.has_module_perm("lab", "create"))
        self.assertFalse(rana.has_module_perm("billing", "view"))
        self.assertTrue(rana.check_password(PASSWORD))

    def test_owner_cannot_use_another_clinics_role(self):
        self.login("owner")
        foreign_role = Role.objects.get(clinic=self.other_clinic, code="owner")
        response = self.client.post(
            "/api/users/", {"username": "x", "password": PASSWORD, "roles": [foreign_role.pk]}, format="json"
        )
        self.assertEqual(response.status_code, 400)

    def test_receptionist_cannot_manage_users_or_edit_catalog(self):
        self.make_user("heba", "receptionist")
        self.login("heba")
        self.assertEqual(self.client.get("/api/users/").status_code, 403)
        self.assertEqual(self.client.get("/api/masterdata/procedures/").status_code, 200)
        response = self.client.post("/api/masterdata/procedure-categories/", {"name_en": "X", "name_ar": "س"}, format="json")
        self.assertEqual(response.status_code, 403)

    def test_owner_can_change_role_permissions(self):
        self.login("owner")
        role = Role.objects.get(clinic=self.clinic, code="receptionist")
        response = self.client.patch(
            f"/api/roles/{role.pk}/", {"permissions": {"patients": ["view"], "reports": ["view"]}}, format="json"
        )
        self.assertEqual(response.status_code, 200, response.content)
        role.refresh_from_db()
        self.assertEqual(role.permissions, {"patients": ["view"], "reports": ["view"]})

    def test_invalid_permissions_are_rejected(self):
        self.login("owner")
        role = Role.objects.get(clinic=self.clinic, code="receptionist")
        response = self.client.patch(f"/api/roles/{role.pk}/", {"permissions": {"patients": ["fly"]}}, format="json")
        self.assertEqual(response.status_code, 400)

    def test_built_in_role_cannot_be_deleted(self):
        self.login("owner")
        role = Role.objects.get(clinic=self.clinic, code="dentist")
        self.assertEqual(self.client.delete(f"/api/roles/{role.pk}/").status_code, 400)

    def test_owner_cannot_deactivate_self(self):
        self.login("owner")
        self.assertEqual(self.client.delete(f"/api/users/{self.owner.pk}/").status_code, 400)
        response = self.client.patch(f"/api/users/{self.owner.pk}/", {"is_active": False}, format="json")
        self.assertEqual(response.status_code, 400)

    def test_deleting_a_user_deactivates_instead(self):
        user = self.make_user("old", "assistant")
        self.login("owner")
        self.assertEqual(self.client.delete(f"/api/users/{user.pk}/").status_code, 204)
        user.refresh_from_db()
        self.assertFalse(user.is_active)


class ClinicSetupTests(Phase0Base):
    def test_full_setup_in_both_languages_is_audited(self):
        self.login("owner")
        r = self.client.patch("/api/clinic/", {"phone": "02 1234 5678", "tax_registration_number": "123-456-789"}, format="json")
        self.assertEqual(r.status_code, 200, r.content)

        r = self.client.post("/api/masterdata/branches/", {"name_en": "Main branch", "name_ar": "الفرع الرئيسي"}, format="json")
        self.assertEqual(r.status_code, 201, r.content)
        branch_id = r.data["id"]

        r = self.client.post(
            "/api/masterdata/chairs/", {"branch": branch_id, "name_en": "Chair 1", "name_ar": "كرسي 1"}, format="json"
        )
        self.assertEqual(r.status_code, 201, r.content)
        chair_id = r.data["id"]

        r = self.client.post(
            "/api/masterdata/working-hours/",
            {"branch": branch_id, "weekday": 5, "opens_at": "10:00", "closes_at": "22:00"},
            format="json",
        )
        self.assertEqual(r.status_code, 201, r.content)

        r = self.client.post("/api/masterdata/procedure-categories/", {"name_en": "Endodontics", "name_ar": "علاج الجذور"}, format="json")
        category_id = r.data["id"]
        r = self.client.post(
            "/api/masterdata/procedures/",
            {
                "code": "EN03",
                "name_en": "Root canal treatment, molar",
                "name_ar": "علاج عصب، ضرس",
                "category": category_id,
                "default_price": "3800.00",
                "default_duration_minutes": 90,
                "needs_lab": False,
            },
            format="json",
        )
        self.assertEqual(r.status_code, 201, r.content)
        procedure_id = r.data["id"]

        r = self.client.patch(f"/api/masterdata/procedures/{procedure_id}/", {"default_price": "4000.00"}, format="json")
        self.assertEqual(r.status_code, 200)

        # Every step is in the audit log, with who did it and old/new values.
        r = self.client.get("/api/audit/", {"record_type": "masterdata.procedure", "object_id": procedure_id})
        self.assertEqual(r.status_code, 200)
        entries = r.data["results"]
        self.assertEqual([e["action"] for e in entries], ["update", "create"])
        self.assertEqual(entries[0]["changes"]["default_price"], ["3800.00", "4000.00"])
        self.assertEqual(entries[0]["user"], self.owner.pk)

        chair_log = AuditEntry.objects.get(content_type__model="chair", object_id=str(chair_id))
        self.assertEqual(chair_log.changes["name_ar"], [None, "كرسي 1"])
        clinic_log = AuditEntry.objects.filter(content_type__model="clinic", action="update").first()
        self.assertEqual(clinic_log.changes["phone"], ["", "02 1234 5678"])
        self.assertEqual(clinic_log.user, self.owner)

        procedure = Procedure.objects.get(pk=procedure_id)
        self.assertEqual(procedure.created_by, self.owner)
        self.assertEqual(procedure.clinic, self.clinic)

    def test_role_assignment_is_audited(self):
        user = self.make_user("sara", "assistant")
        self.login("owner")
        dentist = Role.objects.get(clinic=self.clinic, code="dentist")
        self.client.patch(f"/api/users/{user.pk}/", {"roles": [dentist.pk]}, format="json")
        entry = AuditEntry.objects.filter(content_type__model="user", object_id=str(user.pk), changes__has_key="roles").order_by("id").last()
        self.assertEqual(entry.changes["roles"][1], [dentist.pk])

    def test_passwords_never_appear_in_audit_log(self):
        self.login("owner")
        self.client.post("/api/users/", {"username": "new", "password": PASSWORD}, format="json")
        for entry in AuditEntry.objects.filter(content_type__model="user"):
            if "password" in entry.changes:
                self.assertNotIn(PASSWORD, str(entry.changes))
                self.assertEqual(entry.changes["password"][1], "(hidden)")

    def test_clinics_cannot_see_or_reference_each_others_data(self):
        theirs = Branch.objects.create(clinic=self.other_clinic, name_en="Theirs", name_ar="فرعهم")
        self.login("owner")
        r = self.client.get("/api/masterdata/branches/")
        self.assertEqual(r.data["count"], 0)
        self.assertEqual(self.client.get(f"/api/masterdata/branches/{theirs.pk}/").status_code, 404)
        r = self.client.post("/api/masterdata/chairs/", {"branch": theirs.pk, "name_en": "C", "name_ar": "ك"}, format="json")
        self.assertEqual(r.status_code, 400)
        r = self.client.get("/api/audit/")
        self.assertTrue(all(e["object_repr"] != "Theirs" for e in r.data["results"]))

    def test_room_must_be_in_chairs_branch(self):
        self.login("owner")
        a = self.client.post("/api/masterdata/branches/", {"name_en": "A", "name_ar": "أ"}, format="json").data["id"]
        b = self.client.post("/api/masterdata/branches/", {"name_en": "B", "name_ar": "ب"}, format="json").data["id"]
        room = self.client.post("/api/masterdata/rooms/", {"branch": b, "name_en": "R", "name_ar": "غ"}, format="json").data["id"]
        r = self.client.post("/api/masterdata/chairs/", {"branch": a, "room": room, "name_en": "C", "name_ar": "ك"}, format="json")
        self.assertEqual(r.status_code, 400)

    def test_duplicate_procedure_code_rejected(self):
        load_starter_catalog(self.clinic)
        self.login("owner")
        category = Procedure.objects.filter(clinic=self.clinic).first().category_id
        r = self.client.post(
            "/api/masterdata/procedures/",
            {"code": "dx01", "name_en": "Dup", "name_ar": "مكرر", "category": category},
            format="json",
        )
        self.assertEqual(r.status_code, 400)

    def test_starter_catalog_is_bilingual_and_idempotent(self):
        first = load_starter_catalog(self.clinic)
        second = load_starter_catalog(self.clinic)
        self.assertGreater(first, 30)
        self.assertEqual(second, 0)
        self.assertFalse(Procedure.objects.filter(clinic=self.clinic, name_ar="").exists())
        self.assertTrue(Procedure.objects.filter(clinic=self.clinic, code="PR01", needs_lab=True).exists())

    def test_staff_commission_percent_validated(self):
        self.login("owner")
        r = self.client.post(
            "/api/masterdata/staff/",
            {"name_en": "Dr. Rana", "name_ar": "د. رنا", "staff_type": "dentist", "commission_type": "percent_collected", "commission_value": "150"},
            format="json",
        )
        self.assertEqual(r.status_code, 400)


class FileTests(Phase0Base):
    def setUp(self):
        super().setUp()
        self.media = tempfile.mkdtemp()
        self.override = override_settings(MEDIA_ROOT=self.media)
        self.override.enable()

    def tearDown(self):
        self.override.disable()
        shutil.rmtree(self.media, ignore_errors=True)
        super().tearDown()

    def test_upload_attach_and_download(self):
        self.login("owner")
        branch = self.client.post("/api/masterdata/branches/", {"name_en": "Main", "name_ar": "رئيسي"}, format="json").data["id"]
        upload = SimpleUploadedFile("xray.png", b"\x89PNG fake", content_type="image/png")
        r = self.client.post(
            "/api/files/",
            {"file": upload, "kind": "xray", "attached_model": "masterdata.branch", "attached_id": branch},
            format="multipart",
        )
        self.assertEqual(r.status_code, 201, r.content)
        self.assertNotIn("file", r.data)  # never exposed as a public URL
        file_id = r.data["id"]
        r = self.client.get("/api/files/", {"attached_model": "masterdata.branch", "attached_id": branch})
        self.assertEqual(r.data["count"], 1)
        r = self.client.get(f"/api/files/{file_id}/download/")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(b"".join(r.streaming_content), b"\x89PNG fake")

    def test_rejects_disallowed_type_and_foreign_record(self):
        self.login("owner")
        bad = SimpleUploadedFile("run.exe", b"MZ", content_type="application/x-msdownload")
        self.assertEqual(self.client.post("/api/files/", {"file": bad}, format="multipart").status_code, 400)
        theirs = Branch.objects.create(clinic=self.other_clinic, name_en="T", name_ar="ت")
        ok = SimpleUploadedFile("a.pdf", b"%PDF", content_type="application/pdf")
        r = self.client.post(
            "/api/files/", {"file": ok, "attached_model": "masterdata.branch", "attached_id": theirs.pk}, format="multipart"
        )
        self.assertEqual(r.status_code, 400)

    def test_other_clinic_cannot_download(self):
        self.login("owner")
        r = self.client.post(
            "/api/files/", {"file": SimpleUploadedFile("a.pdf", b"%PDF", content_type="application/pdf")}, format="multipart"
        )
        file_id = r.data["id"]
        self.login("other")
        self.assertEqual(self.client.get(f"/api/files/{file_id}/download/").status_code, 404)


class NotificationTests(Phase0Base):
    def test_in_app_and_whatsapp_through_one_service(self):
        n = notifications.notify(self.clinic, "in_app", "Lab case ready", user=self.owner)
        self.assertEqual(n.status, "sent")
        w = notifications.notify(self.clinic, "whatsapp", "Reminder: your appointment is tomorrow", phone="+201001234567")
        self.assertEqual(w.status, "sent")
        missing = notifications.notify(self.clinic, "sms", "No phone")
        self.assertEqual(missing.status, "failed")
        self.login("owner")
        r = self.client.get("/api/notifications/")
        self.assertEqual(r.data["count"], 1)
        r = self.client.post(f"/api/notifications/{n.pk}/read/")
        self.assertEqual(r.data["status"], "read")
