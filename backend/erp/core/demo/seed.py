"""Build the demo clinic.

Everything is made from a fixed random seed and dated relative to today, so the
same day always gives the same clinic. Records are created in the order the
clinic would make them (exam, plan, visit, invoice, payment, lab case, stock
use), through the inventory and payroll services where those exist, so totals,
balances, stock levels and payslips all add up. The audit log is paused while
seeding so it is not flooded with thousands of "created" rows dated today.
"""

import random
from collections import defaultdict
from contextlib import contextmanager
from datetime import datetime, time, timedelta
from decimal import ROUND_HALF_UP, Decimal

from django.db import transaction
from django.db.models.signals import m2m_changed, post_delete, post_save, pre_save
from django.utils import timezone
from rest_framework.exceptions import ValidationError as ApiValidationError

from erp.appointments.models import Appointment
from erp.billing.models import CashboxClosing, DocumentCounter, Installment, Invoice, InvoiceLine, Payment
from erp.clinical.defaults import ensure_starter_consents
from erp.clinical.models import (
    ConsentTemplate,
    PatientConsent,
    Prescription,
    ToothState,
    TreatmentPlan,
    TreatmentPlanLine,
    VisitNote,
)
from erp.core import audit, rbac
from erp.core.models import AuditEntry, Clinic, Notification, Role, StoredFile, User
from erp.core.notifications import notify
from erp.core.setup import create_clinic, create_default_roles
from erp.crm import demo as crm_demo
from erp.inventory import services as stock
from erp.inventory.models import (
    ProcedureMaterial,
    PurchaseOrder,
    PurchaseOrderCounter,
    PurchaseOrderLine,
    StockItem,
    StockLot,
    StockMovement,
    Supplier,
)
from erp.lab.models import CaseCounter, LabCase, StageEvent
from erp.masterdata.catalog import load_starter_catalog
from erp.masterdata.models import Branch, Chair, Procedure, ProcedureCategory, Room, StaffMember, WorkingHours
from erp.patients.models import MedicalAlert, MedicalHistory, Patient, PatientNote
from erp.staff import services as payroll
from erp.staff.models import (
    AdvanceRepayment,
    AttendanceRecord,
    EmploymentProfile,
    LeaveRequest,
    PayrollItem,
    PayrollLine,
    PayrollRun,
    PayrollSettings,
    RosterEntry,
    SalaryAdvance,
    ShiftTemplate,
)

from . import people as P

SEED = 2026
FRIDAY = 4
CENT = Decimal("0.01")
SHIFTS = {
    "morning": ("Morning", "صباحي", time(10, 0), time(18, 0), 30, "#9fd3bf"),
    "evening": ("Evening", "مسائي", time(14, 0), time(22, 0), 30, "#b9c8f5"),
    "lab": ("Lab day", "وردية المعمل", time(9, 0), time(17, 0), 30, "#f6c886"),
}
BRANCHES = {
    "nasr": ("Nasr City", "مدينة نصر", "+20222701234", "12 Abbas El Akkad St., Nasr City, Cairo", "١٢ شارع عباس العقاد، مدينة نصر، القاهرة"),
    "helio": ("Heliopolis", "مصر الجديدة", "+20224151234", "45 El Merghany St., Heliopolis, Cairo", "٤٥ شارع الميرغني، مصر الجديدة، القاهرة"),
}
CHAIRS = {
    "nasr": [("Room A", "غرفة أ", ["Nasr City 1", "Nasr City 2"]), ("Room B", "غرفة ب", ["Nasr City 3"])],
    "helio": [("Room 1", "غرفة ١", ["Heliopolis 1", "Heliopolis 2"])],
}
AR_DIGITS = str.maketrans("0123456789", "٠١٢٣٤٥٦٧٨٩")
METHODS = [("cash", 45), ("card", 20), ("instapay", 25), ("wallet", 10)]
CANCEL_REASONS = ["Patient travelling", "Patient sick", "Exams week, asked to postpone", "Work commitment", "Clinic rescheduled"]


def money(value):
    return Decimal(value).quantize(CENT, rounding=ROUND_HALF_UP)


def aware(day, minutes):
    return timezone.make_aware(datetime.combine(day, time(minutes // 60, minutes % 60)))


def minutes_of(t):
    return t.hour * 60 + t.minute


@contextmanager
def audit_paused():
    handlers = [
        (pre_save, audit._before_save),
        (post_save, audit._after_save),
        (post_delete, audit._after_delete),
        (m2m_changed, audit._m2m_changed),
    ]
    for signal, handler in handlers:
        signal.disconnect(handler)
    try:
        yield
    finally:
        for signal, handler in handlers:
            signal.connect(handler)


# --------------------------------------------------------------------- clinic


def demo_clinic(owner_password=None):
    """The clinic to seed: the owner's, else the first one, else a new one."""
    owner = User.objects.filter(username__iexact=P.OWNER_USERNAME).first()
    if owner is not None and owner.clinic_id:
        return owner.clinic, owner, False
    clinic = Clinic.objects.order_by("id").first()
    if clinic is None:
        clinic, owner = create_clinic(
            "Okasha Dental Clinic", "عيادة عكاشة لطب الأسنان", P.OWNER_USERNAME, owner_password or P.DEMO_PASSWORD
        )
        return clinic, owner, True
    if owner is None:
        owner = User(username=P.OWNER_USERNAME, clinic=clinic, first_name="Amin", last_name="Okasha")
        owner.set_password(owner_password or P.DEMO_PASSWORD)
        owner.save()
        owner.roles.add(create_default_roles(clinic)["owner"])
        return clinic, owner, True
    return clinic, owner, False


def is_seeded(clinic):
    return Patient.objects.filter(clinic=clinic).exists()


@transaction.atomic
def wipe(clinic):
    """Remove every business record of this clinic, the demo logins and the demo
    roles. The clinic, its built-in roles and every other login (the owner's
    included, password untouched) stay. Other clinics are not touched."""
    c = clinic
    with audit_paused():
        crm_demo.wipe(c)
        AdvanceRepayment.objects.filter(advance__clinic=c).delete()
        PayrollItem.objects.filter(line__clinic=c).delete()
        for model in (PayrollLine, PayrollRun, SalaryAdvance, LeaveRequest, AttendanceRecord, RosterEntry,
                      ShiftTemplate, EmploymentProfile, PayrollSettings):
            model.objects.filter(clinic=c).delete()
        StockMovement.objects.filter(clinic=c).delete()
        StockLot.objects.filter(clinic=c).delete()
        PurchaseOrderLine.objects.filter(order__clinic=c).delete()
        for model in (PurchaseOrder, ProcedureMaterial, StockItem, Supplier):
            model.objects.filter(clinic=c).delete()
        PurchaseOrderCounter.objects.filter(clinic=c).delete()
        StageEvent.objects.filter(clinic=c).delete()
        LabCase.objects.filter(clinic=c).update(remake_of=None)
        LabCase.objects.filter(clinic=c).delete()
        CaseCounter.objects.filter(clinic=c).delete()
        Payment.objects.filter(clinic=c).delete()
        Installment.objects.filter(invoice__clinic=c).delete()
        InvoiceLine.objects.filter(invoice__clinic=c).delete()
        for model in (Invoice, CashboxClosing):
            model.objects.filter(clinic=c).delete()
        DocumentCounter.objects.filter(clinic=c).delete()
        for model in (PatientConsent, Prescription, VisitNote, TreatmentPlanLine, TreatmentPlan, ToothState,
                      ConsentTemplate, Appointment, PatientNote, MedicalAlert, MedicalHistory, Patient, Notification):
            model.objects.filter(clinic=c).delete()
        for stored in StoredFile.objects.filter(clinic=c):
            stored.file.delete(save=False)
            stored.delete()
        AuditEntry.objects.filter(clinic=c).delete()
        for model in (StaffMember, WorkingHours, Chair, Room, Branch, Procedure, ProcedureCategory):
            model.objects.filter(clinic=c).delete()
        usernames = [s["username"] for s in P.STAFF]
        User.objects.filter(clinic=c, username__in=usernames).delete()
        Role.objects.filter(clinic=c, code__in=list(P.DEMO_ROLES)).delete()


# ----------------------------------------------------------------- calendar


class Calendar:
    """Keeps dentists and chairs from being double-booked."""

    def __init__(self, seeder):
        self.s = seeder
        self.dentist = defaultdict(list)
        self.chair = defaultdict(list)

    @staticmethod
    def free(spans, a, b):
        return all(b <= x or a >= y for x, y in spans)

    def try_day(self, code, day, minutes, rng):
        plan = self.s.week_of[code].get(day.weekday())
        if plan is None or day.weekday() == FRIDAY:
            return None
        shift, branch = plan
        _en, _ar, start, end, _brk, _col = SHIFTS[shift]
        first, last = minutes_of(start), minutes_of(end) - minutes
        options = list(range(first, last + 1, 15))
        if day == self.s.today:
            # Today's visits gather around the moment the home page is looked at.
            center = minutes_of(timezone.localtime(self.s.center).time()) + 60
            options.sort(key=lambda m: abs(m + minutes / 2 - center) + rng.random() * 40)
        else:
            rng.shuffle(options)
            options.sort(key=lambda m: rng.random() + (0.6 if m > first + 300 else 0))
        for a in options:
            b = a + minutes
            if not self.free(self.dentist[(code, day)], a, b):
                continue
            for chair in self.s.chairs[branch]:
                if self.free(self.chair[(chair.pk, day)], a, b):
                    self.dentist[(code, day)].append((a, b))
                    self.chair[(chair.pk, day)].append((a, b))
                    return day, self.s.branch[branch], chair, aware(day, a)
        return None

    def book(self, code, day, minutes, rng, days=14):
        for k in range(days + 1):
            slot = self.try_day(code, day + timedelta(days=k), minutes, rng)
            if slot:
                return slot
        return None


# --------------------------------------------------------------- templates

POSTERIOR = [14, 15, 16, 17, 24, 25, 26, 27, 34, 35, 36, 37, 44, 45, 46, 47]
MOLARS = [16, 17, 26, 27, 36, 37, 46, 47]
PREMOLARS = [14, 15, 24, 25, 34, 35, 44, 45]
WISDOM = [18, 28, 38, 48]
LAB = {
    # code: (restoration, material, material cost per unit, labour per unit)
    "PR01": ("crown", "zirconia", 420, 380),
    "PR02": ("crown", "pfm", 300, 400),
    "PR03": ("crown", "emax", 650, 450),
    "PR04": ("bridge", "zirconia", 420, 380),
    "PR06": ("denture_full", "acrylic", 650, 900),
    "PR07": ("denture_partial", "acrylic", 550, 750),
    "IM02": ("implant_crown", "zirconia", 480, 420),
    "CO02": ("veneer", "emax", 650, 500),
}
COMPLAINTS = {
    "checkup": "Wants a check-up and cleaning",
    "fillings": "Sensitivity to cold drinks",
    "rct_crown": "Severe pain in a back tooth, worse at night",
    "extraction": "Broken tooth, wants it out",
    "implant": "Missing tooth, asks about an implant",
    "bridge": "Gap after an old extraction",
    "veneers": "Unhappy with the shape and colour of the front teeth",
    "whitening": "Wants whiter teeth before a wedding",
    "denture": "Old denture is loose",
    "ortho": "Crowded front teeth",
    "perio": "Bleeding gums when brushing",
    "kids": "Child has a toothache",
    "crown": "Wants a crown on a root-treated tooth",
    "implant_crown": "Implant healed, ready for the crown",
}


def build_template(name, rng):
    """[(procedure code, [teeth] or [None], kind, gap in days, surfaces)] for one plan.
    kind: same (done at the exam visit), single, two (two visits), lab (prep, then fit)."""
    if name == "checkup":
        return [("PV01", [None], "same", 0, "")]
    if name == "fillings":
        out = []
        for i, tooth in enumerate(rng.sample(POSTERIOR, rng.randint(1, 3))):
            surfaces = rng.choice(["O", "MO", "DO", "MOD", "B"])
            code = {1: "RS01", 2: "RS02"}.get(len(surfaces), "RS03")
            out.append((code, [tooth], "single", rng.randint(3, 9) if i == 0 else 7, surfaces))
        return out
    if name == "rct_crown":
        tooth = rng.choice(MOLARS + PREMOLARS)
        rct = "EN03" if tooth in MOLARS else "EN02"
        crown = rng.choice(["PR01", "PR01", "PR03", "PR02"])
        out = [(rct, [tooth], "two", rng.randint(1, 4), "")]
        if rng.random() < 0.5:
            out.append(("PR05", [tooth], "single", rng.randint(5, 9), ""))
        out.append((crown, [tooth], "lab", rng.randint(5, 10), ""))
        return out
    if name == "extraction":
        if rng.random() < 0.5:
            return [("OS03", [rng.choice(WISDOM)], "single", rng.randint(2, 7), "")]
        return [(rng.choice(["OS01", "OS02"]), [rng.choice(POSTERIOR)], "single", rng.randint(0, 5) or 3, "")]
    if name == "implant":
        tooth = rng.choice([36, 46, 26, 16, 35, 45])
        out = []
        if rng.random() < 0.35:
            out.append(("IM03", [tooth], "single", rng.randint(5, 10), ""))
        out.append(("IM01", [tooth], "single", rng.randint(7, 14), ""))
        out.append(("IM02", [tooth], "lab", rng.randint(60, 75), ""))
        return out
    if name == "bridge":
        group = rng.choice([[44, 45, 46], [34, 35, 36], [14, 15, 16], [24, 25, 26]])
        return [("EN03" if group[-1] in MOLARS else "EN02", [group[-1]], "two", rng.randint(3, 7), ""),
                ("PR04", group, "lab", rng.randint(6, 10), "")]
    if name == "veneers":
        return [("CO01", [None], "single", rng.randint(3, 7), ""), ("CO02", [12, 11, 21, 22], "lab", rng.randint(7, 14), "")]
    if name == "whitening":
        return [("PV01", [None], "same", 0, ""), ("CO01", [None], "single", rng.randint(4, 10), "")]
    if name == "denture":
        return [("OS01", [rng.choice(POSTERIOR)], "single", rng.randint(3, 6), ""),
                (rng.choice(["PR06", "PR07"]), [None], "lab", rng.randint(14, 21), "")]
    if name == "ortho":
        out = [("OR01", [None], "same", 0, ""), ("OR02", [None], "single", rng.randint(7, 14), "")]
        out += [("OR03", [None], "single", rng.randint(28, 35), "") for _ in range(5)]
        return out
    if name == "perio":
        return [("PE01", [None], "single", rng.randint(3, 7), "Upper jaw"), ("PE01", [None], "single", 7, "Lower jaw")]
    if name == "crown":
        return [(rng.choice(["PR01", "PR03", "PR01"]), [rng.choice(MOLARS + PREMOLARS)], "lab", rng.randint(1, 3), "")]
    if name == "implant_crown":
        return [("IM02", [rng.choice([36, 46, 26, 16])], "lab", rng.randint(1, 3), "")]
    if name == "kids":
        return [("PV02", [None], "same", 0, ""), ("EN05", [rng.choice([36, 46])], "single", rng.randint(3, 7), "")]
    raise ValueError(name)


def pick_template(age, rng):
    if age < 13:
        return rng.choice(["checkup", "kids"])
    options = [("checkup", 16), ("fillings", 22), ("rct_crown", 24), ("extraction", 8), ("whitening", 4)]
    if age >= 25:
        options.append(("implant", 11))
    if age >= 35:
        options.append(("bridge", 6))
    if 18 <= age <= 50:
        options.append(("veneers", 5))
    if age >= 58:
        options.append(("denture", 6))
    if 12 <= age <= 35:
        options.append(("ortho", 5))
    if age >= 30:
        options.append(("perio", 5))
    names, weights = zip(*options)
    return rng.choices(names, weights)[0]


DENTISTS_FOR = {"implant": ["youssef"], "implant_crown": ["youssef"], "crown": ["karim", "salma", "karim"], "ortho": ["salma"], "kids": ["salma"], "veneers": ["karim", "salma"],
                "bridge": ["karim", "youssef"], "denture": ["karim", "youssef"]}


# -------------------------------------------------------------------- seeder


class Seeder:
    def __init__(self, clinic, owner, out=print):
        self.clinic = clinic
        self.owner = owner
        self.out = out
        self.rng = random.Random(SEED)
        self.now = timezone.now()
        self.today = timezone.localdate()
        local = timezone.localtime(self.now)
        # Today's schedule is laid out around this moment, kept inside opening hours
        # so the home page shows people waiting and in the chair at any hour (outside
        # opening hours it is laid out as if it were 5:30 pm).
        minute = local.hour * 60 + local.minute
        self.center = aware(self.today, minute if 11 * 60 + 20 <= minute <= 20 * 60 + 30 else 17 * 60 + 30)
        self.horizon = self.today + timedelta(days=21)
        self.stamps = defaultdict(list)
        self.cal = Calendar(self)

    # small helpers -----------------------------------------------------
    def stamp(self, obj, when):
        obj.created_at = min(when, self.now)
        self.stamps[type(obj)].append(obj)

    def cap(self, when):
        return min(when, self.now)

    def method(self):
        names, weights = zip(*METHODS)
        return self.rng.choices(names, weights)[0]

    def reference(self, method):
        r = self.rng
        return {
            "card": f"POS-{r.randint(100000, 999999)}",
            "instapay": f"IPN{r.randint(10**9, 10**10 - 1)}",
            "wallet": f"VF-010{r.randint(10**7, 10**8 - 1)}",
            "bank": f"TRX-{r.randint(10**5, 10**6 - 1)}",
        }.get(method, "")

    # setup -------------------------------------------------------------
    def setup(self):
        c = self.clinic
        for field, value in (("phone", "+20222701234"), ("email", "info@okasha-dental.example"),
                             ("address_en", BRANCHES["nasr"][3]), ("address_ar", BRANCHES["nasr"][4]),
                             ("tax_registration_number", "512-345-678"), ("commercial_register", "Cairo 145236")):
            if not getattr(c, field):
                setattr(c, field, value)
        c.save()
        self.branch, self.chairs = {}, {}
        for code, (en, ar, phone, addr_en, addr_ar) in BRANCHES.items():
            branch, _ = Branch.objects.get_or_create(
                clinic=c, name_en=en, defaults={"name_ar": ar, "phone": phone, "address_en": addr_en, "address_ar": addr_ar}
            )
            self.branch[code] = branch
            self.chairs[code] = []
            order = 0
            for room_en, room_ar, chairs in CHAIRS[code]:
                room, _ = Room.objects.get_or_create(clinic=c, branch=branch, name_en=room_en, defaults={"name_ar": room_ar})
                for name in chairs:
                    order += 1
                    ar_name = f"{ar} {str(order).translate(AR_DIGITS)}"
                    chair, _ = Chair.objects.get_or_create(
                        clinic=c, branch=branch, name_en=name, defaults={"name_ar": ar_name, "room": room, "sort_order": order}
                    )
                    self.chairs[code].append(chair)
            for weekday in range(7):
                closed = weekday == FRIDAY
                WorkingHours.objects.get_or_create(
                    clinic=c, branch=branch, weekday=weekday,
                    defaults={"is_closed": closed, "opens_at": None if closed else time(10 if code == "nasr" else 12, 0),
                              "closes_at": None if closed else time(22, 0)},
                )
        load_starter_catalog(c)
        self.proc = {p.code: p for p in Procedure.objects.filter(clinic=c)}
        for code, price in P.PRICES.items():
            proc = self.proc.get(code)
            if proc and proc.default_price == 0:
                proc.default_price = Decimal(price)
                proc.save(update_fields=["default_price", "updated_at"])
        ensure_starter_consents(c)
        self.consent = {t.title_en: t for t in ConsentTemplate.objects.filter(clinic=c)}

        roles = create_default_roles(c)
        for code, (en, ar, perms) in P.DEMO_ROLES.items():
            roles[code], _ = Role.objects.get_or_create(
                clinic=c, code=code, defaults={"name_en": en, "name_ar": ar, "permissions": rbac.normalize_permissions(perms)}
            )
        if not self.owner.first_name:
            self.owner.first_name, self.owner.last_name = "Amin", "Okasha"
            self.owner.save(update_fields=["first_name", "last_name"])

        PayrollSettings.for_clinic(c)
        self.shift = {}
        for code, (en, ar, start, end, brk, color) in SHIFTS.items():
            self.shift[code], _ = ShiftTemplate.objects.get_or_create(
                clinic=c, name_en=en, defaults={"name_ar": ar, "start_time": start, "end_time": end, "break_minutes": brk, "color": color}
            )

        self.staff, self.user, self.week_of = {}, {}, {}
        first_of_window = (self.today.replace(day=1) - timedelta(days=40)).replace(day=1)
        for s in P.STAFF:
            user = User.objects.filter(username=s["username"]).first()
            if user is not None and user.clinic_id != c.pk:
                raise RuntimeError(f"The username {s['username']} belongs to another clinic.")
            if user is None:
                user = User(username=s["username"], clinic=c, first_name=s["first"], last_name=s["last"],
                            email=f"{s['username']}@okasha-dental.example", phone=s["phone"],
                            language="en" if s["username"] in ("ahmed", "youssef") else "ar")
                user.set_password(P.DEMO_PASSWORD)
                user.save()
            user.roles.set([roles[r] for r in s["roles"]])
            member, _ = StaffMember.objects.get_or_create(
                clinic=c, user=user,
                defaults={"name_en": s["en"], "name_ar": s["ar"], "staff_type": s["kind"], "phone": s["phone"], "color": s["color"],
                          "commission_type": s["commission"][0] if s["commission"] else "none",
                          "commission_value": Decimal(s["commission"][1]) if s["commission"] else 0},
            )
            member.branches.set([self.branch[b] for b in s["branches"]])
            pay = dict(s["pay"])
            if pay.get("hire_date") is None:
                pay["hire_date"] = first_of_window + timedelta(days=9)  # joined two months ago: a part-month first payslip
            EmploymentProfile.objects.get_or_create(
                clinic=c, staff=member,
                defaults={**pay, "national_id": f"2{self.rng.randint(80, 99)}0{self.rng.randint(1, 9)}{self.rng.randint(10, 28)}01{self.rng.randint(10000, 99999)}"[:14]},
            )
            self.staff[s["username"]] = member
            self.user[s["username"]] = user
            self.week_of[s["username"]] = s["week"]
        self.receptionist = {"nasr": self.user["mariam"], "helio": self.user["hana"]}
        self.branch_code = {b.pk: code for code, b in self.branch.items()}

    # patients ----------------------------------------------------------
    def make_patients(self):
        r = self.rng
        c = self.clinic
        names = [(g, f, fam) for g, pool in (("male", P.MALE), ("female", P.FEMALE)) for f in pool for fam in P.FAMILY]
        r.shuffle(names)
        phones = set()
        self.patients = []
        alerts = list(P.ALERTS) * 2
        r.shuffle(alerts)
        for i in range(80):
            gender, (first_en, first_ar), (fam_en, fam_ar) = names[i]
            if first_en == fam_en:
                fam_en, fam_ar = P.FAMILY[(P.FAMILY.index((fam_en, fam_ar)) + 1) % len(P.FAMILY)]
            age = r.choice([r.randint(6, 12), r.randint(13, 24), r.randint(25, 45), r.randint(25, 45), r.randint(46, 64), r.randint(60, 78)])
            dob = self.today - timedelta(days=age * 365 + r.randint(0, 364))
            while True:
                phone = f"+201{r.choice('0125')}{r.randint(10**7, 10**8 - 1)}"
                if phone not in phones:
                    phones.add(phone)
                    break
            home = "nasr" if r.random() < 0.6 else "helio"
            nid = ""
            if age >= 18 and r.random() < 0.6:
                nid = f"{2 if dob.year < 2000 else 3}{dob:%y%m%d}{r.choice(['01', '21', '88'])}{r.randint(1000, 9999)}{r.randint(1, 9)}"
            p = Patient(
                clinic=c, name_en=f"{first_en} {fam_en}", name_ar=f"{first_ar} {fam_ar}", gender=gender, date_of_birth=dob,
                phone=phone, phone_alt=f"+20{r.choice(['10', '11', '12'])}{r.randint(10**7, 10**8 - 1)}" if r.random() < 0.2 else "",
                whatsapp_opt_in=r.random() < 0.9, language="en" if r.random() < 0.12 else "ar",
                email=f"{first_en.lower()}.{fam_en.split()[-1].lower().replace('-', '')}{i}@example.com" if age >= 18 and r.random() < 0.4 else "",
                national_id=nid, address=r.choice(P.ADDRESSES), occupation="Student" if age < 23 else r.choice(P.OCCUPATIONS),
                referral_source=r.choices(["walk_in", "friend", "facebook", "instagram", "google", "doctor"], [15, 30, 20, 15, 15, 5])[0],
                home_branch=self.branch[home],
                emergency_contact_name=f"{r.choice(P.MALE + P.FEMALE)[0]} {fam_en}" if r.random() < 0.5 else "",
                insurance=r.choice(["", "", "", "", "Company medical plan", "Engineers Syndicate"]),
            )
            if p.emergency_contact_name:
                p.emergency_contact_phone = f"+2010{r.randint(10**7, 10**8 - 1)}"
            p.save()
            p.age = age
            self.patients.append(p)
            # Medical history and alerts.
            if r.random() < 0.45 or i < 18:
                flags = {"smoker": gender == "male" and age > 20 and r.random() < 0.35}
                if i < 16:
                    kind, text, guidance, extra = alerts[i]
                    if i == 3 and gender == "female" and 20 <= age <= 40:
                        kind, text, guidance, extra = P.PREGNANT_ALERT
                    MedicalAlert.objects.create(clinic=c, patient=p, kind=kind, text=text, guidance=guidance, created_by=self.user["karim"])
                    flags.update(extra)
                    p.alert = text
                MedicalHistory.objects.create(clinic=c, patient=p, created_by=self.user["karim"], **flags)
            if r.random() < 0.12:
                PatientNote.objects.create(clinic=c, patient=p, text=r.choice(P.STAFF_NOTES), created_by=self.receptionist[home])

    # visits ------------------------------------------------------------
    def status_for(self, start, minutes, allow_miss):
        r = self.rng
        end = start + timedelta(minutes=minutes)
        day = timezone.localtime(start).date()
        if day < self.today:
            if allow_miss:
                roll = r.random()
                if roll < 0.05:
                    return "no_show"
                if roll < 0.10:
                    return "cancelled"
            return "completed"
        if day == self.today:
            if end <= self.center:
                return "completed"
            if start <= self.center:
                return "in_chair"
            if start <= self.center + timedelta(minutes=50):
                return "arrived"
            return "confirmed"
        if allow_miss and r.random() < 0.04:
            return "cancelled"
        return "confirmed" if (day - self.today).days <= 2 or r.random() < 0.3 else "booked"

    def visit(self, patient, dentist, day, minutes, proc, reason, allow_miss=True, days=14):
        """Book a visit on or after `day`. A missed past visit is rebooked a few days
        later. Returns (appointment, outcome): done, in_chair, waiting, booked, or (None, None)."""
        r = self.rng
        while True:
            if day > self.horizon:
                return None, None
            slot = self.cal.book(dentist, day, minutes, r, days)
            if slot is None:
                return None, None
            day, branch, chair, start = slot
            if day > self.horizon:
                return None, None
            status = self.status_for(start, minutes, allow_miss and day != self.today)
            end = start + timedelta(minutes=minutes)
            appt = Appointment(
                clinic=self.clinic, patient=patient, dentist=self.staff[dentist], branch=branch, chair=chair,
                procedure=self.proc[proc] if proc else None, start=start, duration_minutes=minutes, status=status,
                reason=reason, created_by=self.receptionist[self.branch_code[branch.pk]],
            )
            if status in ("arrived", "in_chair", "completed"):
                appt.arrived_at = self.cap(start - timedelta(minutes=r.randint(0, 15)))
            if status in ("in_chair", "completed"):
                appt.seated_at = self.cap(start + timedelta(minutes=r.randint(0, 8)))
            if status == "completed":
                appt.completed_at = self.cap(end + timedelta(minutes=r.randint(-5, 5)))
            if status == "cancelled":
                appt.cancel_reason = r.choice(CANCEL_REASONS)
            if status in ("confirmed", "booked") and (day - self.today).days <= 1:
                appt.reminder_sent_at = self.now - timedelta(hours=r.randint(1, 20))
            appt.save()
            self.stamp(appt, start - timedelta(days=r.randint(1, 12), hours=r.randint(0, 8)))
            if status in ("no_show", "cancelled"):
                if day > self.today:
                    return None, None
                day = day + timedelta(days=r.randint(2, 7))
                continue
            outcome = {"completed": "done", "in_chair": "in_chair", "arrived": "waiting"}.get(status, "booked")
            return appt, outcome

    # one course of treatment ------------------------------------------
    def episode(self, patient, start_day, template, dentist=None, days=14):
        r = self.rng
        dentist = dentist or r.choice(DENTISTS_FOR.get(template, ["karim", "salma", "youssef", "karim"]))
        exam, outcome = self.visit(patient, dentist, start_day, 30, "DX01", COMPLAINTS[template], days=days)
        if exam is None or outcome in ("booked", "waiting"):
            return exam
        when = exam.start
        groups = build_template(template, r)
        plan = TreatmentPlan(
            clinic=self.clinic, patient=patient, dentist=self.staff[dentist], status="proposed",
            title={"checkup": "Check-up and cleaning", "fillings": "Fillings", "rct_crown": "Root canal and crown",
                   "extraction": "Extraction", "implant": "Implant", "bridge": "Bridge", "veneers": "Veneers and whitening",
                   "whitening": "Cleaning and whitening", "denture": "Denture", "ortho": "Orthodontic treatment",
                   "perio": "Gum treatment", "kids": "Child treatment", "crown": "Crown",
                   "implant_crown": "Crown on implant"}[template],
            created_by=self.user[dentist],
        )
        plan.save()
        self.stamp(plan, when)
        lines, order = [], 0
        for code, teeth, kind, gap, surfaces in groups:
            group = []
            for tooth in teeth:
                order += 1
                proc = self.proc[code]
                price = proc.default_price
                discount = money(price * Decimal("0.1") / 50) * 50 if r.random() < 0.08 else Decimal("0")
                line = TreatmentPlanLine(
                    clinic=self.clinic, plan=plan, procedure=proc, tooth=tooth, surfaces=surfaces if code.startswith("RS") else "",
                    price=price, discount=discount, sort_order=order, notes=surfaces if code == "PE01" else "",
                    created_by=self.user[dentist],
                )
                line.save()
                self.stamp(line, when)
                group.append(line)
            lines.append((code, group, kind, gap))
        patient.plans.append(plan)
        if outcome == "in_chair":
            return exam

        # The exam is over: what did the patient decide?
        fate = r.random()
        recent = (self.today - timezone.localtime(when).date()).days <= 40
        extras = [("DX01", 1)] + ([("DX03", 1)] if template in ("implant", "rct_crown", "bridge", "ortho", "extraction") and r.random() < 0.7 else [])
        same = [ln for code, group, kind, gap in lines if kind == "same" for ln in group]
        if (recent and fate < 0.15) or fate < 0.03:
            # Still thinking it over: only the exam is billed.
            self.complete_visit(patient, exam, dentist, [], extras, template)
            return exam
        if fate > 0.96:
            plan.status = "cancelled"
            plan.notes = "Patient decided not to go ahead for now."
            plan.save(update_fields=["status", "notes", "updated_at"])
            TreatmentPlanLine.objects.filter(plan=plan).update(status="cancelled")
            self.complete_visit(patient, exam, dentist, [], extras, template)
            return exam
        plan.status, plan.accepted_at = "accepted", when
        plan.save(update_fields=["status", "accepted_at", "updated_at"])
        self.complete_visit(patient, exam, dentist, same, extras, template)

        day = timezone.localtime(when).date()
        for code, group, kind, gap in lines:
            if kind == "same":
                continue
            minutes = max(self.proc[code].default_duration_minutes, 20)
            reason = self.proc[code].name_en + (f" {group[0].tooth}" if group[0].tooth else "")
            appt, outcome = self.visit(patient, dentist, day + timedelta(days=gap), minutes, code, reason)
            if appt is None:
                break
            for ln in group:
                ln.appointment = appt
                ln.save(update_fields=["appointment", "updated_at"])
            day = timezone.localtime(appt.start).date()
            if outcome != "done":
                if outcome == "in_chair":
                    self.set_lines(group, "in_progress")
                break
            if kind == "single":
                self.complete_visit(patient, appt, dentist, group, [], template)
                continue
            # Two-visit work: the first visit starts it.
            self.set_lines(group, "in_progress")
            self.complete_visit(patient, appt, dentist, [], [], template, started=group)
            case = self.open_lab_case(patient, dentist, group, appt) if kind == "lab" else None
            second_gap = r.randint(8, 12) if kind == "lab" else r.randint(4, 9)
            appt2, outcome2 = self.visit(patient, dentist, day + timedelta(days=second_gap), minutes if kind == "two" else 30, code, reason + (" fit" if kind == "lab" else " (second visit)"))
            if case is not None:
                self.progress_lab_case(case, appt2, outcome2)
            if appt2 is None:
                break
            for ln in group:
                ln.appointment = appt2
                ln.save(update_fields=["appointment", "updated_at"])
            day = timezone.localtime(appt2.start).date()
            if outcome2 != "done":
                break
            self.complete_visit(patient, appt2, dentist, group, [], template)
        self.refresh_plan(plan)
        return exam

    def set_lines(self, group, status, when=None):
        for ln in group:
            ln.status = status
            ln.completed_at = when if status == "done" else None
            ln.save(update_fields=["status", "completed_at", "updated_at"])

    def refresh_plan(self, plan):
        statuses = [s for s in TreatmentPlanLine.objects.filter(plan=plan).values_list("status", flat=True) if s != "cancelled"]
        if plan.status in ("proposed", "cancelled") or not statuses:
            return
        if all(s == "done" for s in statuses):
            plan.status = "completed"
        elif any(s in ("done", "in_progress") for s in statuses):
            plan.status = "in_progress"
        else:
            plan.status = "accepted"
        plan.save(update_fields=["status", "updated_at"])

    # what happens at a finished visit ----------------------------------
    def complete_visit(self, patient, appt, dentist, done, extras, template, started=()):
        r = self.rng
        end = appt.completed_at or appt.start + timedelta(minutes=appt.duration_minutes)
        day = timezone.localtime(appt.start).date()
        if done:
            self.set_lines(done, "done", end)
            for ln in done:
                self.use_materials(ln, appt, end)
        worked = list(done) + list(started)
        self.visit_note(patient, appt, dentist, worked, template, day, end, bool(extras))
        codes = {ln.procedure.code for ln in worked}
        if codes & {"OS01", "OS02", "OS03", "IM01", "IM03", "EN02", "EN03"} and r.random() < 0.75:
            self.prescribe(patient, dentist, codes, end)
        for ln in worked:
            title = {"OS": "Tooth extraction", "IM": "Dental implant", "EN": "Root canal treatment"}.get(ln.procedure.code[:2])
            if title in self.consent and ln.procedure.code != "IM02":
                self.consent_for(patient, ln, title, appt.start - timedelta(minutes=10))
        self.bill(patient, appt, dentist, done, extras, end)

    def visit_note(self, patient, appt, dentist, lines, template, day, end, is_exam):
        r = self.rng
        teeth = ", ".join(str(ln.tooth) for ln in lines if ln.tooth)
        names = ", ".join(sorted({ln.procedure.name_en for ln in lines}))
        if is_exam:
            complaint = COMPLAINTS[template]
            findings = {
                "checkup": "Moderate calculus, mild gingivitis, no caries detected.",
                "fillings": "Caries on posterior teeth; see the chart.",
                "rct_crown": "Deep caries reaching the pulp, tender to percussion. Irreversible pulpitis.",
                "extraction": "Tooth broken down below the gum, not restorable.",
                "implant": "Healed extraction site, good bone width on the X-ray.",
                "bridge": "Missing tooth with sound neighbours; abutment needs RCT.",
                "veneers": "Discoloured and uneven upper front teeth, healthy gums.",
                "whitening": "Shade A3, healthy teeth and gums.",
                "denture": "Worn denture, poor retention.",
                "ortho": "Class I crowding, upper and lower.",
                "perio": "Generalised bleeding on probing, pockets 4-5 mm.",
                "kids": "Deep caries on the first permanent molar.",
                "crown": "Root-treated tooth, weak walls; needs full coverage.",
                "implant_crown": "Implant integrated, healthy gum around the healing abutment.",
            }[template]
            work = "Full examination and charting; X-ray taken and reviewed. Plan and costs explained." + (f" {names} done today." if names else "")
            nxt = "Start the treatment plan." if template != "checkup" else "Recall in six months."
        else:
            complaint = ""
            findings = f"Teeth {teeth}." if teeth else ""
            work = f"{names}{' on ' + teeth if teeth else ''}. Local anaesthesia as needed; post-op instructions given."
            nxt = r.choice(["Review in one week.", "Next step of the plan.", "Call if pain persists.", "Recall in six months."])
        signed = r.random() < 0.85 or (self.today - day).days > 4
        note = VisitNote(
            clinic=self.clinic, patient=patient, appointment=appt, dentist=self.staff[dentist], visit_date=day,
            complaint=complaint, findings=findings, work_done=work, next_step=nxt, created_by=self.user[dentist],
            signed_at=self.cap(end + timedelta(minutes=15)) if signed else None, signed_by=self.user[dentist] if signed else None,
        )
        note.save()
        if lines:
            note.lines.set(lines)
        self.stamp(note, end)

    def prescribe(self, patient, dentist, codes, when):
        allergic = "penicillin" in getattr(patient, "alert", "").lower()
        thinner = "warfarin" in getattr(patient, "alert", "").lower() or "aspirin" in getattr(patient, "alert", "").lower()
        items = []
        if codes & {"OS01", "OS02", "OS03", "IM01", "IM03"}:
            items.append(
                {"drug": "Clindamycin 300 mg", "dose": "1 capsule", "frequency": "every 8 hours", "duration": "5 days", "notes": ""}
                if allergic else
                {"drug": "Amoxicillin + clavulanic acid 1 g", "dose": "1 tablet", "frequency": "every 12 hours", "duration": "5 days", "notes": "After meals"}
            )
            items.append({"drug": "Chlorhexidine 0.12% mouthwash", "dose": "15 ml", "frequency": "twice a day", "duration": "7 days", "notes": "Start the day after"})
        items.append(
            {"drug": "Paracetamol 500 mg", "dose": "2 tablets", "frequency": "every 6 hours as needed", "duration": "3 days", "notes": ""}
            if thinner else
            {"drug": "Ibuprofen 400 mg", "dose": "1 tablet", "frequency": "every 8 hours as needed", "duration": "3 days", "notes": "After meals"}
        )
        rx = Prescription(clinic=self.clinic, patient=patient, dentist=self.staff[dentist], items=items,
                          notes="Cold compresses for the first day. Soft food." if "OS" in "".join(codes) else "",
                          created_by=self.user[dentist])
        rx.save()
        self.stamp(rx, when)

    def consent_for(self, patient, line, title, when):
        if PatientConsent.objects.filter(plan_line=line).exists():
            return
        tpl = self.consent[title]
        ar = patient.language == "ar"
        consent = PatientConsent(
            clinic=self.clinic, patient=patient, template=tpl, plan_line=line, language=patient.language,
            title=tpl.title_ar if ar else tpl.title_en, body=tpl.body_ar if ar else tpl.body_en,
            signer_name=patient.name_ar if ar else patient.name_en, signed_at=self.cap(when),
            created_by=self.receptionist[self.branch_code[patient.home_branch_id]],
        )
        consent.save()
        self.stamp(consent, when)

    # billing -------------------------------------------------------------
    def bill(self, patient, appt, dentist, done, extras, when):
        if not done and not extras:
            return
        r = self.rng
        day = timezone.localtime(appt.start).date()
        branch_code = self.branch_code[appt.branch_id]
        cashier = self.receptionist[branch_code]
        invoice = Invoice(clinic=self.clinic, patient=patient, branch=appt.branch, issue_date=day,
                          tax_rate=self.clinic.tax_rate, created_by=cashier)
        invoice.save()
        self.stamp(invoice, when)
        member = self.staff[dentist]
        for code, qty in extras:
            proc = self.proc[code]
            InvoiceLine.objects.create(invoice=invoice, procedure=proc, dentist=member, quantity=qty, unit_price=proc.default_price,
                                       description=proc.name_ar if patient.language == "ar" else proc.name_en)
        for ln in done:
            InvoiceLine.objects.create(
                invoice=invoice, plan_line=ln, procedure=ln.procedure, dentist=member, tooth=ln.tooth, unit_price=ln.price,
                discount=ln.discount, description=ln.procedure.name_ar if patient.language == "ar" else ln.procedure.name_en,
            )
        total = invoice.subtotal
        if total >= 2000 and r.random() < 0.1:
            invoice.discount = Decimal(r.choice([100, 200, 250, 500]))
            invoice.notes = r.choice(["Family discount", "Returning patient", "Engineers Syndicate discount"])
            invoice.save(update_fields=["discount", "notes", "updated_at"])
        total = invoice.total
        self.pay_invoice(invoice, total, day, when, cashier)

    def pay(self, invoice, amount, day, cashier, installment=None, method=None):
        if amount <= 0 or day > self.today:
            return None
        method = method or self.method()
        payment = Payment(
            clinic=self.clinic, patient=invoice.patient, invoice=invoice, installment=installment, branch=invoice.branch,
            paid_on=day, amount=money(amount), method=method, reference=self.reference(method), created_by=cashier,
        )
        payment.save()
        hour = self.rng.randint(11 * 60, 21 * 60)
        self.stamp(payment, aware(day, hour) if day < self.today else self.now)
        return payment

    def pay_invoice(self, invoice, total, day, when, cashier):
        r = self.rng
        roll = r.random()
        if total >= 12000 and roll < 0.75:
            down = (total * Decimal("0.3") / 100).quantize(Decimal("1")) * 100
            self.pay(invoice, down, day, cashier, method=r.choice(["card", "instapay", "cash"]))
            count = r.choice([3, 4, 6])
            rest = total - down
            share = (rest / count).quantize(Decimal("1"))
            for i in range(count):
                due = payroll.add_months(day.replace(day=1), i + 1).replace(day=min(day.day, 28))
                amount = share if i < count - 1 else rest - share * (count - 1)
                inst = Installment.objects.create(invoice=invoice, number=i + 1, due_date=due, amount=amount)
                if due <= self.today:
                    late = r.random()
                    if late < 0.7:
                        self.pay(invoice, amount, min(due + timedelta(days=r.randint(0, 4)), self.today), cashier, inst)
                    elif late < 0.82:
                        self.pay(invoice, (amount / 2).quantize(Decimal("1")), due, cashier, inst)
            return
        if roll < 0.72:
            if total >= 3000 and r.random() < 0.15:
                part = (total * Decimal("0.6") / 50).quantize(Decimal("1")) * 50
                self.pay(invoice, part, day, cashier, method="cash")
                self.pay(invoice, total - part, day, cashier, method="card")
            else:
                self.pay(invoice, total, day, cashier)
        elif roll < 0.88:
            part = (total / 2 / 50).quantize(Decimal("1")) * 50
            self.pay(invoice, part, day, cashier)
            if r.random() < 0.6:
                self.pay(invoice, total - part, day + timedelta(days=r.randint(5, 25)), cashier)
        else:
            if (self.today - day).days > 30 and r.random() < 0.5:
                self.pay(invoice, total, day + timedelta(days=r.randint(7, 25)), cashier)

    # lab -----------------------------------------------------------------
    def open_lab_case(self, patient, dentist, group, appt):
        r = self.rng
        code = group[0].procedure.code
        if code not in LAB:
            return None
        restoration, material, mat_cost, lab_cost = LAB[code]
        units = len(group)
        teeth = [ln.tooth for ln in group if ln.tooth]
        start = appt.start + timedelta(minutes=appt.duration_minutes)
        case = LabCase(
            clinic=self.clinic, patient=patient, plan_line=group[0], dentist=self.staff[dentist],
            restoration=restoration, material=material, units=units,
            teeth=(f"{teeth[0]}-{teeth[-1]}" if len(teeth) > 2 else ", ".join(map(str, teeth))) if teeth else "",
            shade=r.choice(["A1", "A2", "A2", "A3", "B1", "BL2"]) if material != "acrylic" else "A3",
            instructions=r.choice(["", "Light contacts please.", "Match the shade photo.", "Natural texture, no heavy glaze."]),
            due_date=timezone.localtime(start).date() + timedelta(days=9), shade_guide="vita_classic",
            margin=r.choice(["chamfer", "shoulder"]) if restoration in ("crown", "bridge") else "",
            contacts="normal", occlusion="light" if restoration != "veneer" else "",
            pontic="modified_ridge_lap" if restoration == "bridge" else "",
            implant_system="Delta Implants Tapered Pro" if restoration == "implant_crown" else "",
            implant_platform="RP 4.5" if restoration == "implant_crown" else "",
            abutment="ti_base" if restoration == "implant_crown" else "",
            retention="screw" if restoration == "implant_crown" else "",
            enclosures=["scan", "bite", "photos"] if material != "acrylic" else ["impression_upper", "impression_lower", "bite"],
            created_by=self.user[dentist],
        )
        case.save()
        case.unit_costs = (mat_cost, lab_cost)
        case.start = start
        self.stamp(case, start)
        ev = StageEvent(clinic=self.clinic, case=case, stage="received")
        ev.save()
        self.stamp(ev, start + timedelta(hours=1))
        self.lab_cases.append(case)
        return case

    def progress_lab_case(self, case, fit, outcome):
        r = self.rng
        tech = r.choice(["tarek", "tarek", "mostafa", "hesham"])
        start = case.start
        if fit is not None:
            case.due_date = timezone.localtime(fit.start).date() - timedelta(days=1)
            case.appointment = fit
        due_at = aware(case.due_date, 15 * 60)
        stages = ["design", "milling", "finishing", "qc", "ready"]
        span = max((due_at - start).total_seconds(), 3600 * 24)
        if outcome == "done":
            reached = len(stages)
        else:
            frac = (self.now - start).total_seconds() / span
            reached = max(0, min(len(stages), int(frac * len(stages) + r.random() * 0.6)))
        late = outcome == "done" and r.random() < 0.15
        for i, stage in enumerate(stages[:reached]):
            when = start + timedelta(seconds=span * (i + 1) / len(stages) * (0.92 if not late else 1.05))
            if stage == "ready" and late:
                when = due_at + timedelta(hours=20)
            ev = StageEvent(clinic=self.clinic, case=case, stage=stage, created_by=self.user[tech])
            ev.save()
            self.stamp(ev, when)
        case.stage = stages[reached - 1] if reached else "received"
        if reached or r.random() < 0.5:
            case.technician = self.staff[tech]
        if outcome == "done":
            delivered = fit.completed_at or fit.start
            case.stage = "delivered"
            case.delivered_at = delivered
            ev = StageEvent(clinic=self.clinic, case=case, stage="delivered", created_by=self.user["karim"])
            ev.save()
            self.stamp(ev, delivered)
        if reached >= 2:
            mat, lab = case.unit_costs
            case.material_cost = Decimal(mat * case.units if case.restoration not in ("denture_full", "denture_partial") else mat)
            case.labour_cost = Decimal(lab * case.units if case.restoration not in ("denture_full", "denture_partial") else lab)
        case.save()
        if case.stage == "delivered":
            self.lab_material_use(case, delivered)

    def lab_tweaks(self):
        """Make sure the board shows every situation: rush, on hold, overdue,
        outsourced, a remake of delivered work and a remake of work that failed try-in."""
        r = self.rng
        c = self.clinic
        open_cases = [x for x in LabCase.objects.filter(clinic=c, cancelled_at__isnull=True).exclude(stage="delivered").order_by("id")]
        not_ready = [x for x in open_cases if x.stage not in ("ready",)]
        for case in not_ready[:2]:
            case.due_date = self.today - timedelta(days=1 + not_ready.index(case))
            case.save(update_fields=["due_date", "updated_at"])
        for case in not_ready[2:5]:
            case.priority = "rush"
            case.save(update_fields=["priority", "updated_at"])
        if len(not_ready) > 5:
            case = not_ready[5]
            case.on_hold, case.hold_reason = True, "Waiting for a new shade photo from the dentist"
            case.save(update_fields=["on_hold", "hold_reason", "updated_at"])
        if len(not_ready) > 6:
            case = not_ready[6]
            case.outsourced_to, case.outsource_tracking = "Alpha Ceramics Lab", f"AC-{r.randint(1000, 9999)}"
            case.save(update_fields=["outsourced_to", "outsource_tracking", "updated_at"])
        # Finished work waiting for the try-in, and new orders nobody has picked up yet.
        order = LabCase.STAGE_ORDER
        ahead = sorted((x for x in open_cases if x.due_date >= self.today and not x.on_hold and x.stage in ("milling", "finishing", "qc")),
                       key=lambda x: -order.index(x.stage))
        for case in ahead[:3]:
            case.stage = "ready"
            case.save(update_fields=["stage", "updated_at"])
            ev = StageEvent(clinic=c, case=case, stage="ready", created_by=case.technician.user if case.technician else None)
            ev.save()
            self.stamp(ev, self.now - timedelta(hours=r.randint(2, 20)))
        for case in [x for x in open_cases if x.stage == "received"][:2]:
            case.technician = None
            case.save(update_fields=["technician", "updated_at"])
        for i, case in enumerate(open_cases):
            case.pan_number = f"P-{i + 1:02d}"
            case.save(update_fields=["pan_number", "updated_at"])
        # A remake of delivered work (shade), charged to the lab.
        delivered = list(LabCase.objects.filter(clinic=c, stage="delivered", delivered_at__gte=self.now - timedelta(days=60)).order_by("id"))
        if delivered:
            original = delivered[len(delivered) // 2]
            self.remake(original, "shade", "lab", "Shade too light under clinic light.", original.delivered_at + timedelta(days=2), deliver=True)
        ready = [x for x in open_cases if x.stage == "ready"]
        if ready:
            original = ready[0]
            original.cancelled_at = self.now - timedelta(hours=5)
            original.cancel_reason = "Remade (Poor fit)"
            original.save(update_fields=["cancelled_at", "cancel_reason", "updated_at"])
            self.remake(original, "fit", "clinic", "Open margin on the distal at try-in.", self.now - timedelta(hours=5), deliver=False)

    def remake(self, original, reason, charged_to, note, when, deliver):
        copy = LabCase.objects.get(pk=original.pk)
        copy.pk = None
        copy.id = None
        copy.number = ""
        copy._state.adding = True
        copy.remake_of = original
        copy.remake_reason, copy.remake_note, copy.remake_charged_to = reason, note, charged_to
        copy.priority = "rush"
        copy.stage = "received"
        copy.delivered_at = None
        copy.cancelled_at = None
        copy.cancel_reason = ""
        copy.on_hold = False
        copy.material_cost = copy.labour_cost = Decimal("0")
        copy.due_date = timezone.localtime(when).date() + timedelta(days=5)
        copy.save()
        self.stamp(copy, when)
        ev = StageEvent(clinic=self.clinic, case=copy, stage="received", note=note)
        ev.save()
        self.stamp(ev, when)
        if deliver and when + timedelta(days=6) < self.now:
            for i, stage in enumerate(["design", "milling", "finishing", "qc", "ready", "delivered"]):
                ev = StageEvent(clinic=self.clinic, case=copy, stage=stage, created_by=self.user["hesham"])
                ev.save()
                self.stamp(ev, when + timedelta(hours=18 * (i + 1)))
            copy.stage = "delivered"
            copy.delivered_at = when + timedelta(hours=18 * 6)
            copy.material_cost, copy.labour_cost = original.material_cost, original.labour_cost
            copy.technician = self.staff["hesham"]
            copy.save()
        elif not deliver:
            copy.technician = self.staff["hesham"]
            copy.save(update_fields=["technician", "updated_at"])

    # inventory -----------------------------------------------------------
    def stock_catalogue(self):
        c = self.clinic
        self.suppliers = []
        for name, contact, phone, whatsapp, terms in P.SUPPLIERS:
            sup, _ = Supplier.objects.get_or_create(
                clinic=c, name=name, defaults={"contact_person": contact, "phone": phone, "whatsapp": whatsapp,
                                               "payment_terms": terms, "address": "Cairo"}
            )
            self.suppliers.append(sup)
        self.items = {}
        for code, en, ar, cat, unit, cost, level, qty, lots, sup, extra in P.ITEMS:
            item, _ = StockItem.objects.get_or_create(
                clinic=c, code=code,
                defaults={"name_en": en, "name_ar": ar, "category": cat, "unit": unit, "last_cost": Decimal(cost),
                          "reorder_level": Decimal(level), "reorder_quantity": Decimal(qty), "tracks_lots": lots,
                          "preferred_supplier": self.suppliers[sup], **{k: Decimal(v) if k in ("diameter", "length") else v for k, v in extra.items()}},
            )
            self.items[code] = item
        for proc_code, rows in P.MATERIALS.items():
            for item_code, qty in rows:
                ProcedureMaterial.objects.get_or_create(
                    clinic=c, procedure=self.proc[proc_code], item=self.items[item_code], defaults={"quantity": Decimal(qty)}
                )
        self.materials = defaultdict(list)
        for pm in ProcedureMaterial.objects.filter(clinic=c).select_related("item", "procedure"):
            self.materials[pm.procedure.code].append(pm)

    def purchase(self, supplier, branch, rows, when, status="received", expected=None, note=""):
        """A purchase order; received ones go through the stock services like the receive button."""
        po = PurchaseOrder(clinic=self.clinic, supplier=supplier, branch=branch, status="draft", notes=note,
                           expected_date=expected or (timezone.localtime(when).date() + timedelta(days=5)),
                           created_by=self.user["sherif"])
        po.save()
        self.stamp(po, when)
        lines = []
        for code, qty, lot, expiry, _received in rows:
            item = self.items[code]
            lines.append(PurchaseOrderLine.objects.create(order=po, item=item, quantity_ordered=Decimal(qty), unit_cost=item.last_cost))
        if status == "draft":
            return po
        po.status, po.ordered_at = "ordered", when
        if status == "cancelled":
            po.status, po.cancelled_at, po.cancel_reason = "cancelled", when + timedelta(days=2), "Supplier raised the price; ordered elsewhere."
        po.save()
        if status in ("received", "partially_received"):
            arrived = when + timedelta(days=self.rng.randint(2, 6))
            for line, (code, qty, lot, expiry, received) in zip(lines, rows):
                take = Decimal(received if received is not None else qty)
                if take <= 0:
                    continue
                stock_lot = stock.lot_for(self.clinic, line.item, branch, lot, expiry, unit_cost=line.unit_cost,
                                          supplier=supplier, po_line=line)
                if stock_lot.received_at and stock_lot.received_at > arrived:
                    StockLot.objects.filter(pk=stock_lot.pk).update(received_at=arrived)
                m = stock.move(stock_lot, "receive", take, unit_cost=line.unit_cost, note=f"Received on {po.number}", purchase_order_line=line)
                self.stamp(m, arrived)
                line.quantity_received += take
                line.save(update_fields=["quantity_received"])
            done = all(ln.remaining == 0 for ln in lines)
            po.status = "received" if done else "partially_received"
            po.received_at = arrived if done else None
            po.save()
        return po

    def opening_stock(self):
        t = self.today
        s = self.suppliers
        old = self.now - timedelta(days=215)
        mid = self.now - timedelta(days=105)
        consumables = [("GLV-M", 40, "", None, None), ("GLV-S", 12, "", None, None), ("MSK", 20, "", None, None),
                       ("SAL", 10, "", None, None), ("BIB", 8, "", None, None), ("XRS", 2, "", None, None), ("PPR", 10, "", None, None),
                       ("NAO", 8, "", None, None)]
        for code, when in (("nasr", old), ("helio", old + timedelta(days=1))):
            self.purchase(s[4], self.branch[code], consumables, when, note="Opening stock")
            self.purchase(s[0], self.branch[code], [
                ("CMP-A2", 20, "", None, None), ("CMP-A3", 20, "", None, None), ("BND", 4, "", None, None), ("ETC", 20, "", None, None),
                ("GIC", 3, "", None, None), ("GP", 20, "", None, None), ("FIL", 30, "", None, None), ("TMP", 4, "", None, None),
                ("ALG", 6, "", None, None), ("PVS", 5, "", None, None), ("CRD", 3, "", None, None),
            ], when + timedelta(hours=3))
            self.purchase(s[1], self.branch[code], [
                ("LID", 400, f"LD{t:%y}{'A' if code == 'nasr' else 'B'}01", t + timedelta(days=330), None),
                ("ART", 300, f"AR{t:%y}{'A' if code == 'nasr' else 'B'}07", t + timedelta(days=410), None),
                ("AMX", 6, "AMX-2403" if code == "nasr" else "AMX-2404", t - timedelta(days=10) if code == "nasr" else t + timedelta(days=150), None),
                ("CHX", 20, f"CHX-{code[:1].upper()}21", t + timedelta(days=260), None),
            ], when + timedelta(hours=5))
        self.purchase(s[2], self.branch["helio"], [
            ("IMP-4010", 8, "DT4010-2291", t + timedelta(days=1100), None), ("IMP-4511", 8, "DT4511-2288", t + timedelta(days=1150), None),
            ("IMP-3510", 4, "DT3510-2301", t + timedelta(days=1200), None), ("HAB", 20, "", None, None),
            ("BGR", 6, "BG-7731", t + timedelta(days=75), None), ("SUT", 4, "", None, None),
        ], old + timedelta(days=2))
        self.purchase(s[2], self.branch["nasr"], [("SUT", 3, "", None, None)], old + timedelta(days=2, hours=4))
        self.purchase(s[3], self.branch["nasr"], [
            ("ZRD", 6, "", None, None), ("EMX", 40, "", None, None), ("ACR", 3, "", None, None),
        ], old + timedelta(days=3))
        # A mid-period top-up.
        self.purchase(s[2], self.branch["helio"], [
            ("IMP-4010", 6, "DT4010-2410", t + timedelta(days=1300), None), ("IMP-4511", 6, "DT4511-2412", t + timedelta(days=1300), None),
            ("HAB", 10, "", None, None),
        ], mid)
        self.purchase(s[0], self.branch["nasr"], [("CMP-A2", 10, "", None, None), ("CMP-A3", 10, "", None, None), ("FIL", 12, "", None, None)], mid + timedelta(days=1))
        self.purchase(s[3], self.branch["nasr"], [("ZRD", 4, "", None, None), ("EMX", 20, "", None, None)], mid + timedelta(days=2))

    def use_materials(self, line, appt, when):
        """Stock used by a finished procedure, taken first-expiry-first-out."""
        code = line.procedure.code
        branch = appt.branch
        links = {"patient": line.plan.patient, "plan_line": line, "appointment": appt}
        moved = []
        try:
            with transaction.atomic():
                for pm in self.materials.get(code, []):
                    moved += stock.take(self.clinic, pm.item, branch, pm.quantity, "use", **links)
                if code == "IM01":
                    item = self.items[self.rng.choice(["IMP-4010", "IMP-4511", "IMP-4010", "IMP-3510"])]
                    moved += stock.take(self.clinic, item, branch, 1, "use", note=f"Implant at {line.tooth}", **links)
                if code == "IM03":
                    moved += stock.take(self.clinic, self.items["BGR"], branch, 1, "use", **links)
        except ApiValidationError:
            return
        for m in moved:
            self.stamp(m, when)

    def lab_material_use(self, case, when):
        item, per_unit = {"zirconia": ("ZRD", "0.07"), "emax": ("EMX", "1"), "acrylic": ("ACR", "0.3")}.get(case.material, (None, None))
        if not item:
            return
        try:
            with transaction.atomic():
                moved = stock.take(self.clinic, self.items[item], self.branch["nasr"], Decimal(per_unit) * case.units, "use",
                                   patient=case.patient, plan_line=case.plan_line, lab_case=case, note=f"Used for {case.number}")
        except ApiValidationError:
            return
        for m in moved:
            self.stamp(m, when - timedelta(days=4))

    def recent_stock(self):
        s, t, now = self.suppliers, self.today, self.now
        nasr, helio = self.branch["nasr"], self.branch["helio"]
        # Short-dated batches bought cheap: they show on the expiry alerts.
        self.purchase(s[1], nasr, [
            ("LID", 100, f"LD{t:%y}SD", t + timedelta(days=22), None), ("CHX", 12, "CHX-SD9", t + timedelta(days=40), None),
        ], now - timedelta(days=12), note="Short-dated batch at a discount")
        self.purchase(s[1], helio, [("ART", 80, f"AR{t:%y}SD", t + timedelta(days=55), None)], now - timedelta(days=9))
        # Partly delivered implant order, an open order, a draft and a cancelled one.
        self.purchase(s[2], helio, [
            ("IMP-4010", 6, "DT4010-2507", t + timedelta(days=1400), 4), ("IMP-4511", 6, "DT4511-2508", t + timedelta(days=1400), 2),
            ("HAB", 10, "", None, 10),
        ], now - timedelta(days=6), status="partially_received", note="Rest promised next week")
        self.purchase(s[3], nasr, [("PMM", 3, "", None, None), ("ZRD", 3, "", None, None), ("EMX", 20, "", None, None)],
                      now - timedelta(days=3), status="ordered", expected=t + timedelta(days=4))
        self.purchase(s[4], nasr, [("GLV-S", 20, "", None, None), ("MSK", 10, "", None, None), ("PPR", 10, "", None, None)],
                      now - timedelta(days=1), status="ordered", expected=t + timedelta(days=2))
        self.purchase(s[0], helio, [("CMP-A2", 8, "", None, None), ("ETC", 10, "", None, None), ("GP", 10, "", None, None)],
                      now - timedelta(hours=6), status="draft", note="Check prices with Rasha before sending")
        self.purchase(s[0], nasr, [("BND", 4, "", None, None)], now - timedelta(days=20), status="cancelled")
        # A transfer, an expired batch thrown away, and a stock count.
        try:
            for m in stock.transfer(self.clinic, self.items["GLV-M"], nasr, helio, 5, note="Heliopolis ran short"):
                self.stamp(m, now - timedelta(days=30))
            expired = StockLot.objects.get(clinic=self.clinic, item=self.items["AMX"], branch=nasr, lot_number="AMX-2403")
            self.stamp(stock.move(expired, "waste", 2, note="Expired, given to the pharmacy for disposal"), now - timedelta(days=8))
            lot = StockLot.objects.filter(clinic=self.clinic, item=self.items["CMP-A2"], branch=nasr).first()
            if lot and lot.quantity > 1:
                self.stamp(stock.move(lot, "adjust", -1, note="Monthly count: one syringe dried out"), now - timedelta(days=11))
        except ApiValidationError:
            pass
        # A few items end up at or under their reorder level.
        for code in ("GLV-S", "ETC", "HAB", "CRD", "BGR"):
            item = self.items[code]
            on_hand = sum((x.quantity for x in StockLot.objects.filter(item=item)), Decimal("0"))
            if on_hand > 0:
                item.reorder_level = max(on_hand + Decimal(self.rng.randint(0, 3)), item.reorder_level)
                item.reorder_quantity = max(item.reorder_quantity, item.reorder_level * 2)
                item.save(update_fields=["reorder_level", "reorder_quantity", "updated_at"])

    # cashbox ---------------------------------------------------------------
    def closings(self):
        r = self.rng
        day = self.today - timedelta(days=1)
        closed = 0
        while closed < 10:
            if day.weekday() != FRIDAY:
                for code, branch in self.branch.items():
                    payments = Payment.objects.filter(clinic=self.clinic, paid_on=day, branch=branch, voided_at__isnull=True)
                    totals = {}
                    for p in payments:
                        totals[p.method] = totals.get(p.method, Decimal("0")) + p.amount
                    cash = totals.get("cash", Decimal("0"))
                    counted = cash + (Decimal(r.choice([-50, -20, 20])) if r.random() < 0.2 and cash > 100 else 0)
                    closing = CashboxClosing(
                        clinic=self.clinic, branch=branch, date=day, totals={k: f"{v:.2f}" for k, v in totals.items()},
                        payment_count=payments.count(), expected_cash=cash, counted_cash=counted,
                        notes="" if counted == cash else "Difference noted; checked the receipts.",
                        created_by=self.receptionist[code],
                    )
                    closing.save()
                    self.stamp(closing, aware(day, 22 * 60 + 15))
                closed += 1
            day -= timedelta(days=1)

    # staff -----------------------------------------------------------------
    def staff_time(self):
        r = self.rng
        c = self.clinic
        first = payroll.add_months(self.today.replace(day=1), -2)
        last_roster = self.today + timedelta(days=13)
        # Leave first, so attendance skips those days.
        def leave(user, kind, start, end, status, reason, note="", decided_by="ahmed"):
            lv = LeaveRequest(clinic=c, staff=self.staff[user], kind=kind, start_date=start, end_date=end, reason=reason,
                              status=status, created_by=self.user[user])
            if status in ("approved", "rejected"):
                lv.decided_by = self.user[decided_by]
                lv.decided_at = self.cap(aware(start, 12 * 60) - timedelta(days=3))
                lv.decision_note = note
            lv.save()
            self.stamp(lv, aware(start, 11 * 60) - timedelta(days=5))
            return lv

        def next_workday(user, day):
            while day.weekday() not in self.week_of[user]:
                day += timedelta(days=1)
            return day

        d = next_workday("salma", first + timedelta(days=10))
        leave("salma", "annual", d, d + timedelta(days=1), "approved", "Family wedding in Alexandria", "Enjoy")
        d = next_workday("aya", first + timedelta(days=36))
        leave("aya", "sick", d, d, "approved", "Flu", "Get well soon")
        d = next_workday("sherif", first + timedelta(days=20))
        leave("sherif", "unpaid", d, d + timedelta(days=1), "approved", "Personal matter")
        leave("tarek", "sick", self.today, self.today, "approved", "Fever, has a doctor's note", "Get well soon", decided_by="hesham")
        d = next_workday("mostafa", self.today - timedelta(days=12))
        leave("mostafa", "annual", d, d + timedelta(days=2), "rejected", "Trip with friends", "The lab is short-staffed that week", decided_by="hesham")
        leave("karim", "annual", self.today + timedelta(days=16), self.today + timedelta(days=18), "pending", "Dental conference in Dubai")
        leave("hana", "casual", next_workday("hana", self.today + timedelta(days=5)), next_workday("hana", self.today + timedelta(days=5)), "pending", "University exam")
        leave("omar", "annual", self.today + timedelta(days=24), self.today + timedelta(days=26), "pending", "Umrah")
        on_leave = {(lv.staff_id, day) for lv in LeaveRequest.objects.filter(clinic=c, status="approved")
                    for day in (lv.start_date + timedelta(days=i) for i in range((lv.end_date - lv.start_date).days + 1))}

        roster, records = [], []
        day = first
        absent_days = {("aya", first + timedelta(days=17)), ("omar", self.today - timedelta(days=6)), ("mariam", first + timedelta(days=44))}
        forgot = ("omar", self.today - timedelta(days=3))
        while day <= last_roster:
            for user, week in self.week_of.items():
                member = self.staff[user]
                plan = week.get(day.weekday())
                hire = member.employment.hire_date
                if plan is None or day.weekday() == FRIDAY or (hire and day < hire):
                    continue
                shift_code, branch_code = plan
                tpl = self.shift[shift_code]
                roster.append(RosterEntry(clinic=c, staff=member, date=day, template=tpl, start_time=tpl.start_time,
                                          end_time=tpl.end_time, break_minutes=tpl.break_minutes, branch=self.branch[branch_code],
                                          created_by=self.user["ahmed"]))
                if day > self.today or (member.pk, day) in on_leave or (user, day) in absent_days:
                    continue
                start, end = minutes_of(tpl.start_time), minutes_of(tpl.end_time)
                if day == self.today:
                    if user == "mariam" or aware(day, start) > self.center:
                        continue  # not in yet; signing in will clock them in
                late_chance = 0.22 if user in ("mariam", "omar") else 0.06
                cin = start + (r.randint(17, 48) if r.random() < late_chance else r.randint(-12, 9))
                record = AttendanceRecord(clinic=c, staff=member, date=day, clock_in=aware(day, cin), branch=self.branch[branch_code],
                                          source="auto" if r.random() < 0.5 else "self")
                if day < self.today and (user, day) != forgot:
                    extra = r.randint(25, 95) if (member.staff_type == "dentist" and r.random() < 0.3) or r.random() < 0.05 else r.randint(-8, 10)
                    if r.random() < 0.03:
                        extra = -r.randint(30, 60)  # left early
                    record.clock_out = aware(day, end + extra)
                if (user, day) == forgot:
                    record.note = "Forgot to clock out"
                records.append(record)
            day += timedelta(days=1)
        RosterEntry.objects.bulk_create(roster, batch_size=500)
        AttendanceRecord.objects.bulk_create(records, batch_size=500)
        # A record a manager fixed from the paper sheet.
        fixed = AttendanceRecord.objects.filter(clinic=c, staff=self.staff["hana"], date__lt=self.today).order_by("-date").first()
        if fixed:
            fixed.source, fixed.edit_reason = "manual", "Clock-in screen was down; time taken from the paper sheet"
            fixed.save(update_fields=["source", "edit_reason", "updated_at"])

        # Advances: one being repaid, one repaid long ago.
        aya = SalaryAdvance(clinic=c, staff=self.staff["aya"], date=first + timedelta(days=8), amount=Decimal("3000"),
                            monthly_installment=Decimal("500"), reason="School fees", created_by=self.owner)
        aya.save()
        old = SalaryAdvance(clinic=c, staff=self.staff["mariam"], date=first - timedelta(days=120), amount=Decimal("1000"),
                            monthly_installment=Decimal("500"), reason="Medical bill", status="repaid", created_by=self.owner)
        old.save()
        AdvanceRepayment.objects.create(advance=old, date=first - timedelta(days=90), amount=Decimal("500"))
        AdvanceRepayment.objects.create(advance=old, date=first - timedelta(days=60), amount=Decimal("500"))

        # Payroll: the last two months paid, this month a draft.
        for months_back in (2, 1, 0):
            period = payroll.add_months(self.today.replace(day=1), -months_back)
            run, _ = PayrollRun.objects.get_or_create(clinic=c, period=period, branch=None, defaults={"commission_period": period})
            payroll.calculate_run(run, now=self.now)
            if months_back == 0:
                run.notes = "Draft: recalculate on the last day of the month."
                run.save(update_fields=["notes", "updated_at"])
                break
            if months_back == 1:
                line = PayrollLine.objects.filter(run=run, staff=self.staff["aya"]).first()
                if line:
                    PayrollItem.objects.create(line=line, kind="bonus", label="Eid bonus", amount=Decimal("500"))
                    line.total()
                    line.save(update_fields=["gross", "total_deductions", "net", "updated_at"])
                line = PayrollLine.objects.filter(run=run, staff=self.staff["karim"]).first()
                if line:
                    line.income_tax = (line.gross * Decimal("0.08")).quantize(CENT)
                    line.total()
                    line.save()
            paid_on = min(payroll.add_months(period, 1) + timedelta(days=1), self.today)
            run.status, run.approved_by, run.approved_at = "approved", self.owner, aware(paid_on, 11 * 60) - timedelta(days=1)
            run.save()
            payroll.pay_run(run, paid_on, {}, self.owner)

    # the whole clinic ------------------------------------------------------
    def run(self):
        r = self.rng
        self.out("Setting up branches, chairs, roles and staff…")
        self.setup()
        self.lab_cases = []
        self.out("Adding suppliers, stock items and opening stock…")
        self.stock_catalogue()
        self.opening_stock()
        self.out("Adding patients…")
        self.make_patients()
        for p in self.patients:
            p.plans = []
        self.out("Booking six months of visits, plans, invoices, payments and lab work…")
        pts = list(self.patients)
        recall, future, regular = pts[:6], pts[6:18], pts[18:]
        for p in recall:
            self.episode(p, self.today - timedelta(days=r.randint(200, 215)), "checkup")
        for p in regular:
            n = r.choices([2, 3, 4], [35, 40, 25])[0]
            for start in sorted(self.today - timedelta(days=r.randint(2, 205)) for _ in range(n)):
                self.episode(p, start, pick_template(p.age, r))
        for p in future:
            self.episode(p, self.today + timedelta(days=r.randint(1, 18)), pick_template(p.age, r))
        # Work in the lab right now: crowns, implant crowns, veneers and dentures
        # prepared over the last two weeks.
        adults = [p for p in regular if p.age >= 25]
        for i, p in enumerate(r.sample(adults, 20)):
            template = ["crown", "crown", "implant_crown", "crown", "veneers", "denture", "bridge", "crown"][i % 8]
            if template == "denture" and p.age < 50:
                template = "crown"
            self.episode(p, self.today - timedelta(days=r.randint(2, 12)), template)
        # Six-month check-ups already booked for the coming weeks.
        for p in regular:
            plans = [pl for pl in p.plans if pl.status == "completed"]
            if plans and r.random() < 0.45:
                self.visit(p, plans[0].dentist.user.username, self.today + timedelta(days=r.randint(1, 20)), 30, "PV01",
                           "Six-month check-up and cleaning", allow_miss=False)
        # Fill today's chairs.
        tries = 0
        while Appointment.objects.filter(clinic=self.clinic, start__date=self.today).exclude(status="cancelled").count() < 16 and tries < 60:
            tries += 1
            p = r.choice(regular)
            if Appointment.objects.filter(patient=p, start__date=self.today).exists():
                continue
            working = [u for u in ("karim", "salma", "youssef") if self.today.weekday() in self.week_of[u]] or ["karim"]
            self.episode(p, self.today, r.choice(["checkup", "fillings", "extraction", "checkup"]), dentist=working[tries % len(working)], days=0)
        self.out("Finishing lab cases, charts and stock…")
        self.lab_tweaks()
        self.charts()
        self.recent_stock()
        self.closings()
        self.out("Rostering staff, recording attendance and leave, running payroll…")
        self.staff_time()
        self.notifications()
        self.backdate()
        self.out("Adding leads, recalls, campaigns, feedback and patient X-rays and documents…")
        crm_demo.seed(self)

    def charts(self):
        r = self.rng
        rows = []
        for p in self.patients:
            teeth = {}

            def tooth(n):
                return teeth.setdefault(n, {"missing": False, "crown": False, "implant": False, "rct": False, "surfaces": {}})
            if p.age >= 18:
                for n in r.sample(WISDOM, r.randint(0, 3)):
                    tooth(n)["missing"] = True
                for n in r.sample(POSTERIOR, r.randint(0, 3)):
                    tooth(n)["surfaces"][r.choice("OMD")] = "filling"
            for plan in p.plans:
                for ln in plan.lines.all().select_related("procedure"):
                    if not ln.tooth:
                        continue
                    t = tooth(ln.tooth)
                    code, done = ln.procedure.code, ln.status == "done"
                    if code.startswith("RS"):
                        for s in ln.surfaces or "O":
                            t["surfaces"][s] = "filling" if done else "caries"
                    elif code.startswith("EN"):
                        t["rct"] = t["rct"] or done or ln.status == "in_progress"
                        if not done:
                            t["surfaces"]["O"] = "caries"
                    elif code in ("PR01", "PR02", "PR03", "PR04", "CO02"):
                        t["crown"] = t["crown"] or done
                    elif code.startswith("OS"):
                        t["missing"] = t["missing"] or done
                    elif code == "IM01":
                        t["implant"] = t["implant"] or done
                        t["missing"] = not done
                    elif code == "IM02":
                        t["crown"] = done
            for n, t in teeth.items():
                rows.append(ToothState(
                    clinic=self.clinic, patient=p, tooth=n, missing=t["missing"] and not t["implant"], crown=t["crown"],
                    implant=t["implant"], root_canal_treated=t["rct"], surfaces={} if t["missing"] else t["surfaces"],
                ))
        ToothState.objects.bulk_create(rows, batch_size=500)

    def notifications(self):
        for case in LabCase.objects.filter(clinic=self.clinic, stage="ready", cancelled_at__isnull=True).select_related("dentist__user", "patient")[:6]:
            if case.dentist.user_id:
                notify(self.clinic, "in_app", f"{case.number} is ready for try-in: {case.get_restoration_display()} for {case.patient.name_en}.",
                       user=case.dentist.user, subject="Lab case ready")
        notify(self.clinic, "in_app", "Mostafa Ragab's leave request was rejected: the lab is short-staffed that week.",
               user=self.user["mostafa"], subject="Leave request")
        notify(self.clinic, "in_app", "Your leave request for the conference is waiting for approval.",
               user=self.user["karim"], subject="Leave request")

    def backdate(self):
        for model, objs in self.stamps.items():
            model.objects.bulk_update(objs, ["created_at"], batch_size=500)
        # Patients registered a little before their first visit.
        for p in self.patients:
            first = Appointment.objects.filter(patient=p).order_by("start").values_list("created_at", flat=True).first()
            when = (first or self.now) - timedelta(days=self.rng.randint(0, 2), hours=self.rng.randint(0, 5))
            Patient.objects.filter(pk=p.pk).update(created_at=min(when, self.now))
        for model in (MedicalAlert, MedicalHistory, PatientNote):
            for obj in model.objects.filter(clinic=self.clinic).select_related("patient"):
                patient_created = Patient.objects.filter(pk=obj.patient_id).values_list("created_at", flat=True).first()
                model.objects.filter(pk=obj.pk).update(created_at=patient_created + timedelta(minutes=10))


def counts(clinic):
    c = clinic
    return {
        "users": User.objects.filter(clinic=c).count(),
        "roles": Role.objects.filter(clinic=c).count(),
        "branches": Branch.objects.filter(clinic=c).count(),
        "chairs": Chair.objects.filter(clinic=c).count(),
        "staff": StaffMember.objects.filter(clinic=c).count(),
        "patients": Patient.objects.filter(clinic=c).count(),
        "medical alerts": MedicalAlert.objects.filter(clinic=c).count(),
        "appointments": Appointment.objects.filter(clinic=c).count(),
        "appointments today": Appointment.objects.filter(clinic=c, start__date=timezone.localdate()).count(),
        "treatment plans": TreatmentPlan.objects.filter(clinic=c).count(),
        "plan lines": TreatmentPlanLine.objects.filter(clinic=c).count(),
        "visit notes": VisitNote.objects.filter(clinic=c).count(),
        "prescriptions": Prescription.objects.filter(clinic=c).count(),
        "consents": PatientConsent.objects.filter(clinic=c).count(),
        "charted teeth": ToothState.objects.filter(clinic=c).count(),
        "invoices": Invoice.objects.filter(clinic=c).count(),
        "payments": Payment.objects.filter(clinic=c).count(),
        "installments": Installment.objects.filter(invoice__clinic=c).count(),
        "cashbox closings": CashboxClosing.objects.filter(clinic=c).count(),
        "lab cases": LabCase.objects.filter(clinic=c).count(),
        "suppliers": Supplier.objects.filter(clinic=c).count(),
        "stock items": StockItem.objects.filter(clinic=c).count(),
        "stock lots": StockLot.objects.filter(clinic=c).count(),
        "stock movements": StockMovement.objects.filter(clinic=c).count(),
        "purchase orders": PurchaseOrder.objects.filter(clinic=c).count(),
        "roster shifts": RosterEntry.objects.filter(clinic=c).count(),
        "attendance records": AttendanceRecord.objects.filter(clinic=c).count(),
        "leave requests": LeaveRequest.objects.filter(clinic=c).count(),
        "payroll runs": PayrollRun.objects.filter(clinic=c).count(),
        **crm_demo.counts(c),
    }


def seed(clinic, owner, out=print):
    with audit_paused(), transaction.atomic():
        Seeder(clinic, owner, out).run()
