"""Phase 7 demo data, run by seed_demo after the rest of the clinic exists:
leads (most patients came from an enquiry), recall rules and calls from the
recall queue, sent campaigns whose results come from the visits and invoices
already seeded, visit feedback, and the parts of the patient file that were
still thin for typical patients (medical questionnaire, prescriptions, a
signed general consent, staff notes, and X-rays, photos and documents)."""

import random
from datetime import timedelta
from decimal import Decimal

from django.contrib.contenttypes.models import ContentType
from django.core.files.base import ContentFile
from django.utils import timezone

from erp.appointments.models import Appointment
from erp.clinical.models import PatientConsent, Prescription, TreatmentPlan, VisitNote
from erp.core.models import StoredFile
from erp.patients.models import MedicalHistory, Patient, PatientNote

from . import demo_images as img
from . import services
from .models import Campaign, CampaignRecipient, Feedback, Lead, LeadActivity, RecallContact, RecallRule

SEED = 7007
SOURCE_FROM_REFERRAL = {"facebook": ["facebook", "facebook", "whatsapp"], "instagram": ["instagram"], "google": ["google", "website"],
                        "friend": ["referral", "phone"], "walk_in": ["walk_in", "phone"], "doctor": ["referral"], "other": ["other"]}
INTERESTS = [("IM01", 14), ("CO01", 10), ("OR04", 9), ("CO02", 8), ("PR01", 9), ("PV01", 12), ("OR02", 6), ("EN03", 6), ("PR06", 3)]
FREE_INTEREST = ["Price list for implants", "Gap between front teeth", "Child's first visit", "Bad breath", "Second opinion on a crown"]
LEAD_NOTES = {
    "facebook": "Commented on the implant post and sent a message.",
    "whatsapp": "Sent a WhatsApp message asking about prices.",
    "instagram": "DM after the before-and-after reel.",
    "phone": "Called the Nasr City branch.",
    "website": "Filled in the contact form on the website.",
    "google": "Found us on Google Maps, called for prices.",
    "walk_in": "Walked in to ask about the offer in the window.",
    "referral": "Referred by an existing patient.",
    "other": "Asked at the pharmacy next door about a dentist.",
}
CALL_TEXTS = [
    "Explained the steps and the price range; will think about it.",
    "Wants an evening appointment after work.",
    "Asked about paying in installments; explained the plan.",
    "No answer, sent a WhatsApp message instead.",
    "Interested; asked us to call back after payday.",
    "Comparing with another clinic; sent our offer.",
]
FEEDBACK = {
    5: ["Excellent, painless and on time.", "Dr. Karim explained everything clearly.", "ممتاز جدًا، شكرًا للدكتورة سلمى", "Very clean clinic and friendly staff.",
        "أحسن عيادة تعاملت معها", "", "", ""],
    4: ["Good, but waited 20 minutes.", "كويس جدًا بس الانتظار طويل شوية", "Happy with the result.", ""],
    3: ["The parking is hard to find.", "Price was higher than I expected.", "الموعد اتأخر"],
    2: ["Waited almost an hour.", "Felt rushed during the visit."],
    1: ["Appointment was moved twice."],
}
EXTRA_NOTES = [
    "Prefers WhatsApp to phone calls.", "Ask about the husband's appointment too.", "Insurance card copy on file.",
    "Likes Dr. Salma; book with her when possible.", "Needs a sick-leave note after each surgery.", "Pays cash only.",
    "Lives far away; book long visits to save trips.", "Sensitive gag reflex: small sensor for X-rays.",
]


def wipe(clinic):
    for model in (CampaignRecipient,):
        model.objects.filter(campaign__clinic=clinic).delete()
    for model in (LeadActivity, Lead, Campaign, RecallContact, RecallRule, Feedback):
        model.objects.filter(clinic=clinic).delete()


def counts(clinic):
    return {
        "leads": Lead.objects.filter(clinic=clinic).count(),
        "campaigns": Campaign.objects.filter(clinic=clinic).count(),
        "feedback": Feedback.objects.filter(clinic=clinic, score__isnull=False).count(),
        "patient files": StoredFile.objects.filter(clinic=clinic).count(),
    }


class CrmSeeder:
    def __init__(self, seeder):
        self.s = seeder
        self.clinic = seeder.clinic
        self.rng = random.Random(SEED)
        self.now = seeder.now
        self.today = seeder.today
        self.patients = list(Patient.objects.filter(clinic=self.clinic).order_by("id"))
        self.reception = [seeder.staff["mariam"], seeder.staff["hana"]]
        self.pending_dates = []  # (model, pk, created_at)

    def when(self, day, hour=None):
        hour = hour if hour is not None else self.rng.randint(11, 20)
        dt = timezone.make_aware(timezone.datetime.combine(day, timezone.datetime.min.time())) + timedelta(hours=hour, minutes=self.rng.randint(0, 59))
        return min(dt, self.now - timedelta(minutes=self.rng.randint(5, 90)))

    def date(self, obj, at):
        self.pending_dates.append((type(obj), obj.pk, at))

    def run(self):
        self.lapsed_patients()
        self.patient_file()
        self.leads()
        self.recalls()
        self.campaigns()
        self.feedback()
        for model, pk, at in self.pending_dates:
            model.objects.filter(pk=pk).update(created_at=at)

    # --------------------------------------------------------- lapsed patients
    def lapsed_patients(self, n=12):
        """Patients last seen seven months to a year ago, so the recall queue has people to call."""
        from erp.core.demo import people as P  # noqa: PLC0415

        r = self.rng
        s = self.s
        names = [(g, f, fam) for g, pool in (("male", P.MALE), ("female", P.FEMALE)) for f in pool for fam in P.FAMILY]
        r.shuffle(names)
        taken = {(p.name_en) for p in self.patients}
        phones = {p.phone for p in self.patients}
        made = []
        for gender, (fe, fa), (le, la) in names:
            if len(made) == n:
                break
            if f"{fe} {le}" in taken or fe == le:
                continue
            taken.add(f"{fe} {le}")
            while True:
                phone = f"+201{r.choice('0125')}{r.randint(10**7, 10**8 - 1)}"
                if phone not in phones:
                    phones.add(phone)
                    break
            age = r.choice([r.randint(9, 14), r.randint(25, 45), r.randint(30, 60), r.randint(46, 70)])
            home = "nasr" if r.random() < 0.6 else "helio"
            p = Patient.objects.create(
                clinic=self.clinic, name_en=f"{fe} {le}", name_ar=f"{fa} {la}", gender=gender,
                date_of_birth=self.today - timedelta(days=age * 365 + r.randint(0, 364)), phone=phone,
                whatsapp_opt_in=r.random() < 0.9, language="en" if r.random() < 0.1 else "ar", address=r.choice(P.ADDRESSES),
                occupation="Student" if age < 23 else r.choice(P.OCCUPATIONS), home_branch=s.branch[home],
                referral_source=r.choice(["friend", "facebook", "google", "walk_in"]),
            )
            p.age, p.plans = age, []
            s.episode(p, self.today - timedelta(days=r.randint(200, 330)), "checkup" if r.random() < 0.6 else "fillings")
            made.append(p)
        everyone = s.patients
        s.patients = made
        s.charts()
        s.patients = everyone + made
        s.backdate()
        self.patients = list(Patient.objects.filter(clinic=self.clinic).order_by("id"))

    # ------------------------------------------------------------ patient file
    def patient_file(self):
        r = self.rng
        c = self.clinic
        dentists = {d.pk: d for d in (self.s.staff[u] for u in ("karim", "salma", "youssef"))}
        users = {self.s.staff[u].pk: self.s.user[u] for u in ("karim", "salma", "youssef")}
        visits = {}
        for a in Appointment.objects.filter(clinic=c, status="completed").select_related("procedure").order_by("start"):
            visits.setdefault(a.patient_id, []).append(a)
        has_history = set(MedicalHistory.objects.filter(clinic=c).values_list("patient", flat=True))
        has_rx = set(Prescription.objects.filter(clinic=c).values_list("patient", flat=True))
        has_consent = set(PatientConsent.objects.filter(clinic=c, template__title_en="General dental treatment").values_list("patient", flat=True))
        has_note = set(PatientNote.objects.filter(clinic=c).values_list("patient", flat=True))
        general = self.s.consent.get("General dental treatment")
        ctype = ContentType.objects.get_for_model(Patient)
        panos = [img.panoramic(k) for k in range(4)]
        periapicals = [img.periapical(k) for k in range(3)]
        photos = [img.intraoral(k) for k in range(2)]
        for p in self.patients:
            done = visits.get(p.pk, [])
            if p.pk not in has_history:
                smoker = p.gender == "male" and r.random() < 0.25
                MedicalHistory.objects.create(
                    clinic=c, patient=p, smoker=smoker, created_by=self.s.user["karim"],
                    allergies=r.choice(["", "", "", "", "Dust (seasonal)", "Sulfa drugs"]),
                    medications=r.choice(["", "", "", "Vitamin D", "Thyroxine 50 mcg", "Omeprazole 20 mg"]),
                    past_surgeries=r.choice(["", "", "", "Appendectomy (2015)", "Tonsillectomy as a child", "Caesarean section" if p.gender == "female" else ""]),
                    notes=r.choice(["No relevant medical history.", "Fit and well.", "No illnesses reported.", ""]),
                )
            if not done:
                continue
            first, last = done[0], done[-1]
            dentist = dentists.get(last.dentist_id) or dentists[next(iter(dentists))]
            if general and p.pk not in has_consent:
                ar = p.language == "ar"
                consent = PatientConsent.objects.create(
                    clinic=c, patient=p, template=general, language=p.language, title=general.title_ar if ar else general.title_en,
                    body=general.body_ar if ar else general.body_en, signer_name=p.name_ar if ar else p.name_en,
                    signature=img.signature_data_url(p.pk), signed_at=first.start, created_by=self.s.receptionist[self.s.branch_code[first.branch_id]],
                )
                self.date(consent, first.start)
            if p.pk not in has_rx and r.random() < 0.75:
                note = VisitNote.objects.filter(patient=p, appointment=last).first()
                code = last.procedure.code if last.procedure else ""
                items = [{"drug": "Chlorhexidine 0.12% mouthwash", "dose": "15 ml", "frequency": "twice a day", "duration": "10 days", "notes": "30 minutes after brushing"},
                         {"drug": "Sensodyne Repair toothpaste", "dose": "pea-sized", "frequency": "twice a day", "duration": "1 month", "notes": ""}] \
                    if code.startswith(("PV", "PE", "DX")) else \
                    [{"drug": "Ibuprofen 400 mg", "dose": "1 tablet", "frequency": "every 8 hours as needed", "duration": "3 days", "notes": "After meals"}]
                rx = Prescription.objects.create(clinic=c, patient=p, dentist=dentist, visit_note=note, items=items,
                                                 notes="Avoid very hot or cold drinks for 24 hours." if code.startswith("RS") else "",
                                                 created_by=users.get(dentist.pk))
                self.date(rx, last.start + timedelta(minutes=40))
            if p.pk not in has_note and r.random() < 0.4:
                n = PatientNote.objects.create(clinic=c, patient=p, text=r.choice(EXTRA_NOTES), created_by=self.s.receptionist[self.s.branch_code[first.branch_id]])
                self.date(n, first.start - timedelta(minutes=20))
            # Imaging and documents.
            files = []
            if r.random() < 0.85:
                files.append(("xray", f"opg-{p.file_number}.png", "image/png", r.choice(panos), "Panoramic X-ray (OPG), first visit", first.start))
            codes = {a.procedure.code for a in done if a.procedure}
            lines = {ln.procedure.code for plan in TreatmentPlan.objects.filter(patient=p).prefetch_related("lines__procedure") for ln in plan.lines.all()}
            if (codes | lines) & {"EN01", "EN02", "EN03", "EN04", "IM01", "IM02", "OS02", "OS03", "PR01"}:
                tooth = r.choice([16, 26, 36, 46, 37, 47, 14, 25])
                files.append(("xray", f"pa-{tooth}-{p.file_number}.png", "image/png", r.choice(periapicals), f"Periapical X-ray, tooth {tooth}", last.start))
            if (codes | lines) & {"CO01", "CO02", "OR02", "OR04", "PR03"} or r.random() < 0.25:
                files.append(("photo", f"smile-{p.file_number}.png", "image/png", r.choice(photos), "Intra-oral photo (front view)", first.start))
            if r.random() < 0.55:
                kind, title, lines_ = self.document(p, first, dentist)
                files.append((kind, f"{title.lower().replace(' ', '-')}-{p.file_number}.pdf", "application/pdf",
                              img.pdf(title, lines_), title, first.start - timedelta(days=r.randint(0, 3))))
            for kind, name, ctype_header, data, description, at in files:
                stored = StoredFile(clinic=c, original_name=name, content_type_header=ctype_header, size=len(data), kind=kind,
                                    description=description, attached_type=ctype, attached_id=str(p.pk),
                                    created_by=users.get(dentist.pk) if kind != "document" else self.s.receptionist[self.s.branch_code[first.branch_id]])
                stored.file.save(name, ContentFile(data), save=False)
                stored.save()
                self.date(stored, min(at, self.now))

    def document(self, p, first, dentist):
        r = self.rng
        day = timezone.localtime(first.start).strftime("%d/%m/%Y")
        head = [f"**Patient: {p.name_en} ({p.file_number})", f"Date: {day}", ""]
        choice = r.choice(["referral", "insurance", "blood", "consent_scan"])
        if choice == "referral":
            return "document", "Referral letter", head + [
                "Dear colleague,", "", f"Thank you for seeing {p.name_en.split()[0]}. Please assess and treat as needed.",
                "Recent panoramic X-ray attached. Medical history reviewed, no contraindications.", "",
                f"With thanks, {dentist.name_en}"]
        if choice == "insurance":
            return "document", "Insurance approval", head + [
                f"Insurer: {p.insurance or 'Company medical plan'}", f"Member number: {r.randint(100000, 999999)}",
                "Approved: examination, X-rays, fillings and scaling.", "Patient share: 20% of the clinic price list.",
                "Valid for 90 days from the date above."]
        if choice == "blood":
            return "document", "Blood test results", head + [
                "Lab: Al Borg Laboratories (copy brought by the patient)", "",
                f"HbA1c: {r.choice(['5.4', '5.9', '6.8', '7.2'])} %", f"INR: {r.choice(['1.0', '1.1', '2.4'])}",
                f"Haemoglobin: {r.choice(['12.8', '13.5', '14.6'])} g/dL", "Platelets: normal range"]
        return "consent", "Signed consent (scan)", head + [
            "General dental treatment consent, signed on paper at reception.", "",
            "I agree to the dental examination, X-rays and the treatment explained to me.", "",
            f"Signed: {p.name_en}", "Witness: reception"]

    # ------------------------------------------------------------------ leads
    def leads(self):
        r = self.rng
        c = self.clinic
        procs = self.s.proc
        firsts = {}
        for a in Appointment.objects.filter(clinic=c).select_related("procedure").order_by("start"):
            firsts.setdefault(a.patient_id, a)
        plans = {}
        for plan in TreatmentPlan.objects.filter(clinic=c).prefetch_related("lines").order_by("created_at"):
            plans.setdefault(plan.patient_id, []).append(plan)
        upcoming_first = {pid for pid, a in firsts.items() if a.start > self.now}
        # Most patients started as an enquiry; the newest ones are still "consultation booked".
        for p in self.patients:
            first = firsts.get(p.pk)
            if first is None or (r.random() < 0.3 and p.pk not in upcoming_first):
                continue
            source = r.choice(SOURCE_FROM_REFERRAL.get(p.referral_source or "other", ["phone"]))
            proc = first.procedure
            p_plans = plans.get(p.pk, [])
            value = sum((ln.net for pl in p_plans for ln in pl.lines.all()), Decimal("0")) or (proc.default_price if proc else Decimal("500"))
            accepted = any(pl.status in ("accepted", "in_progress", "completed") for pl in p_plans)
            if p.pk in upcoming_first:
                stage = "consultation"
            elif accepted and any(pl.status in ("in_progress", "completed") for pl in p_plans):
                stage = "won"
            elif accepted:
                stage = "accepted"
            else:
                stage = r.choice(["won", "consultation", "lost"]) if p_plans else "won"
            created = p.created_at - timedelta(days=r.randint(1, 9), hours=r.randint(0, 6))
            lead = Lead.objects.create(
                clinic=c, name_ar=p.name_ar, name_en=p.name_en, phone=p.phone, gender=p.gender, language=p.language,
                whatsapp_opt_in=p.whatsapp_opt_in, source=source, interest=proc, estimated_value=value.quantize(Decimal("1")),
                assigned_to=r.choice(self.reception), branch=p.home_branch, stage=stage, patient=p, converted_at=p.created_at,
                consultation=first, lost_reason="price" if stage == "lost" else "", notes=LEAD_NOTES[source],
                referred_by=r.choice(["Mrs. Hoda (patient)", "Eng. Tarek (patient)", "Dr. Hany, orthodontist"]) if source == "referral" else "",
                next_follow_up=timezone.localtime(first.start).date() if stage in ("consultation", "accepted") and first.start > self.now else None,
            )
            self.timeline(lead, created, [("contacted", 0.2), ("consultation", 0.6)] + ([(stage, 3)] if stage in ("accepted", "won", "lost") else []),
                          visit_at=first.start)
        # Patients already on file who asked about a further treatment this month:
        # some have accepted the quote, some have started (won).
        regulars = [p for p in self.patients if p.pk in firsts and p.pk not in upcoming_first and firsts[p.pk].start < self.now - timedelta(days=90)]
        for i, p in enumerate(r.sample(regulars, min(8, len(regulars)))):
            stage = "accepted" if i % 2 == 0 else "won"
            code = ["CO01", "IM01", "OR04", "PR01", "CO02", "IM01", "PR06", "CO01"][i]
            proc = procs.get(code)
            lead = Lead.objects.create(
                clinic=c, name_ar=p.name_ar, name_en=p.name_en, phone=p.phone, gender=p.gender, language=p.language,
                whatsapp_opt_in=p.whatsapp_opt_in, source=r.choice(["whatsapp", "phone", "walk_in", "facebook"]), interest=proc,
                estimated_value=(proc.default_price if proc else Decimal("2500")) * (2 if code == "IM01" else 1),
                assigned_to=r.choice(self.reception), branch=p.home_branch, stage=stage, patient=p, converted_at=p.created_at,
                notes="Existing patient asking about a further treatment.",
                next_follow_up=self.today + timedelta(days=r.randint(0, 4)) if stage == "accepted" else None,
            )
            created = self.when(self.today - timedelta(days=min(self.today.day - 1, 6) + r.randint(4, 12)))
            last = min(self.today.day - 1, 6) + 2
            steps = [("contacted", 0.2), ("consultation", 1.5), ("accepted", 3)] + ([("won", (self.today - timezone.localtime(created).date()).days - r.randint(0, last - 2))] if stage == "won" else [])
            self.timeline(lead, created, steps)
        # Enquiries still in progress, and some that were lost.
        used = {p.phone for p in self.patients}
        from erp.core.demo import people as P  # noqa: PLC0415
        names = [(g, f, fam) for g, pool in (("male", P.MALE), ("female", P.FEMALE)) for f in pool for fam in P.FAMILY]
        r.shuffle(names)
        plan = (["new"] * 9 + ["contacted"] * 13 + ["lost"] * 11 + ["won"] * 0)
        names_iter = iter(names[200:])
        for i, stage in enumerate(plan):
            gender, (fe, fa), (le, la) = next(names_iter)
            while True:
                phone = f"+201{r.choice('0125')}{r.randint(10**7, 10**8 - 1)}"
                if phone not in used:
                    used.add(phone)
                    break
            source = r.choices(["facebook", "whatsapp", "instagram", "phone", "website", "google", "walk_in", "referral"], [30, 20, 15, 15, 8, 7, 3, 2])[0]
            code = r.choices([cd for cd, _ in INTERESTS], [wt for _, wt in INTERESTS])[0]
            proc = procs.get(code)
            age_days = r.randint(0, 6) if stage == "new" else r.randint(2, 40) if stage == "contacted" else r.randint(20, 175)
            created = self.when(self.today - timedelta(days=age_days))
            follow = None
            if stage == "new":
                follow = self.today if i % 3 == 0 else self.today + timedelta(days=r.randint(1, 3))
            elif stage == "contacted":
                follow = self.today - timedelta(days=r.randint(1, 3)) if i % 4 == 0 else self.today if i % 4 == 1 else self.today + timedelta(days=r.randint(2, 12))
            lead = Lead.objects.create(
                clinic=c, name_ar=f"{fa} {la}", name_en=f"{fe} {le}", phone=phone, gender=gender, language="en" if r.random() < 0.1 else "ar",
                source=source, interest=proc if r.random() < 0.85 else None, interest_text="" if proc else r.choice(FREE_INTEREST),
                estimated_value=(proc.default_price if proc else Decimal("1500")) * (r.choice([1, 1, 2, 3]) if proc and proc.default_price < 5000 else 1),
                assigned_to=r.choice(self.reception), branch=self.s.branch["nasr" if r.random() < 0.6 else "helio"], stage=stage,
                lost_reason=r.choice(["price", "price", "no_answer", "other_clinic", "not_ready", "distance"]) if stage == "lost" else "",
                next_follow_up=follow, notes=LEAD_NOTES[source], whatsapp_opt_in=r.random() < 0.95,
            )
            if lead.interest is None and not lead.interest_text:
                lead.interest_text = r.choice(FREE_INTEREST)
                lead.save(update_fields=["interest_text"])
            steps = {"new": [], "contacted": [("contacted", 0.3)], "lost": [("contacted", 0.3), ("lost", 6)]}[stage]
            self.timeline(lead, created, steps)

    def timeline(self, lead, created, steps, visit_at=None):
        """Backdate the lead and write its activity: the enquiry, calls and stage moves."""
        r = self.rng
        Lead.objects.filter(pk=lead.pk).update(created_at=created, stage_changed_at=created)
        user = lead.assigned_to.user if lead.assigned_to else None
        act = LeadActivity.objects.create(clinic=self.clinic, lead=lead, kind="note", text=lead.notes, created_by=user)
        self.date(act, created)
        prev, last_at = "new", created
        for stage, days in steps:
            at = min(created + timedelta(days=days, hours=r.randint(1, 5)), self.now - timedelta(minutes=30))
            if stage == "consultation" and visit_at is not None:
                at = min(max(at, created + timedelta(hours=2)), visit_at - timedelta(hours=2), self.now - timedelta(minutes=30))
            if stage == "contacted":
                call = LeadActivity.objects.create(clinic=self.clinic, lead=lead, kind=r.choice(["call", "call", "whatsapp"]),
                                                   text=r.choice(CALL_TEXTS), created_by=user)
                self.date(call, at - timedelta(minutes=2))
            if stage == "lost":
                call = LeadActivity.objects.create(clinic=self.clinic, lead=lead, kind="call", text="Called again: " + lead.get_lost_reason_display().lower() + ".", created_by=user)
                self.date(call, at - timedelta(minutes=3))
            mv = LeadActivity.objects.create(clinic=self.clinic, lead=lead, kind="stage", stage_from=prev, stage_to=stage, created_by=user)
            self.date(mv, at)
            prev, last_at = stage, at
        Lead.objects.filter(pk=lead.pk).update(stage_changed_at=max(last_at, created))

    # ---------------------------------------------------------------- recalls
    def recalls(self):
        r = self.rng
        services.ensure_default_rules(self.clinic)
        rows = services.recall_queue(self.clinic)
        users = [m.user for m in self.reception]
        for i, row in enumerate(rows):
            if row["status"] != "overdue" or r.random() < 0.45:
                continue
            outcome = r.choice(["no_answer", "no_answer", "messaged", "call_later"])
            snooze = None
            if outcome == "call_later":
                snooze = self.today + timedelta(days=r.choice([1, 2, 5]))
                if i % 5 == 0:
                    snooze = None
                    outcome = "no_answer"
            at = self.when(self.today - timedelta(days=r.randint(1, 8)))
            contact = RecallContact.objects.create(
                clinic=self.clinic, patient=row["patient"], rule=row["rule"], due_date=row["due"], outcome=outcome,
                channel="whatsapp" if outcome == "messaged" else "call", snooze_until=snooze,
                note={"no_answer": "Phone switched off.", "messaged": "Sent the check-up message on WhatsApp.",
                      "call_later": "At work, call again later."}[outcome], created_by=r.choice(users),
            )
            self.date(contact, at)
        # Callbacks due today for the badge.
        for row in [x for x in rows if x["status"] == "overdue"][:2]:
            contact = RecallContact.objects.create(
                clinic=self.clinic, patient=row["patient"], rule=row["rule"], due_date=row["due"], outcome="call_later",
                channel="call", snooze_until=self.today + timedelta(days=1), note="Travelling, back tomorrow.", created_by=users[0],
            )
            self.date(contact, self.when(self.today - timedelta(days=3)))

    # -------------------------------------------------------------- campaigns
    def campaigns(self):
        r = self.rng
        owner = self.s.owner
        plans = [
            ("Summer whitening offer", "whatsapp", 150, {"age_min": 20, "age_max": 45}, "1500.00",
             "Hello {name}, enjoy 20% off in-office whitening at {clinic} until {date}. Reply to book.",
             "أهلاً {name}، خصم ٢٠٪ على تبييض الأسنان في {clinic} حتى {date}. رد على الرسالة للحجز."),
            ("Back-to-school check-up for children", "whatsapp", 55, {"age_max": 15}, "300.00",
             "Hello {name}! School is starting: book a check-up and fluoride at {clinic} before {date}.",
             "أهلاً {name}! المدارس بدأت: احجز كشف وفلورايد في {clinic} قبل {date}."),
            ("Balance reminder", "sms", 40, {"has_balance": True}, "120.00",
             "Dear {name}, a friendly reminder that {balance} EGP is outstanding at {clinic}. Thank you.",
             "عزيزي {name}، نذكرك بمبلغ {balance} جنيه مستحق لـ{clinic}. شكرًا لك."),
            ("Implant open day", "whatsapp", 21, {"procedure_not_done": "IM01", "age_min": 40}, "800.00",
             "Hello {name}, {clinic} holds a free implant consultation day on {date}. Reply YES to reserve.",
             "أهلاً {name}، {clinic} تنظم يوم استشارات مجانية للزراعة يوم {date}. رد بـ نعم للحجز."),
            ("Birthday greetings", "whatsapp", 6, {"birthday_month": True}, "0.00",
             "Happy birthday {name}! A free cleaning is waiting for you at {clinic} this month.",
             "كل سنة وأنت طيب يا {name}! تنظيف مجاني في انتظارك في {clinic} هذا الشهر."),
        ]
        for name, channel, days_ago, filters, cost, en, ar in plans:
            sent = self.when(self.today - timedelta(days=days_ago), 13)
            if filters.get("procedure_not_done") == "IM01":
                filters["procedure_not_done"] = self.s.proc["IM01"].pk
            campaign = Campaign.objects.create(
                clinic=self.clinic, name=name, channel=channel, message_en=en, message_ar=ar, filters=filters, cost=Decimal(cost),
                offer_date=timezone.localtime(sent).date() + timedelta(days=14), status="sent", sent_at=sent, created_by=owner,
            )
            self.date(campaign, sent - timedelta(hours=2))
            people = services.audience(self.clinic, filters, today=timezone.localtime(sent).date())
            next_dates = services.next_visit_dates([x["patient_id"] for x in people if x["patient_id"]])
            rows = []
            for x in people:
                lang, body = services.message_for(campaign, x, next_dates)
                status = "skipped" if channel == "whatsapp" and not x["consent"] else ("failed" if r.random() < 0.03 else "sent")
                rows.append(CampaignRecipient(
                    campaign=campaign, patient=x["obj"], phone=x["phone"], language=lang, body=body, status=status,
                    error="Number not on WhatsApp" if status == "failed" else "", sent_at=sent if status == "sent" else None,
                    responded_at=sent + timedelta(hours=r.randint(1, 30)) if status == "sent" and r.random() < 0.14 else None,
                ))
            CampaignRecipient.objects.bulk_create(rows)
        # A draft for the leads still being worked.
        draft = Campaign.objects.create(
            clinic=self.clinic, name="Winter aligner offer for open enquiries", channel="whatsapp", status="draft",
            filters={"audience": "leads", "lead_stages": ["new", "contacted"]}, cost=Decimal("0"), created_by=owner,
            message_en="Hello {name}, clear aligners at {clinic} now come with a free retainer until {date}.",
            message_ar="أهلاً {name}، التقويم الشفاف في {clinic} الآن مع مثبت مجاني حتى {date}.",
            offer_date=self.today + timedelta(days=30),
        )
        self.date(draft, self.now - timedelta(hours=5))

    # --------------------------------------------------------------- feedback
    def feedback(self):
        r = self.rng
        since = self.now - timedelta(days=120)
        appts = list(Appointment.objects.filter(clinic=self.clinic, status="completed", start__gte=since).select_related("dentist", "patient").order_by("start"))
        users = [m.user for m in self.reception]
        for a in appts:
            if r.random() > 0.5:
                continue
            score = r.choices([5, 4, 3, 2, 1], [62, 24, 8, 4, 2])[0]
            source = "link" if r.random() < 0.3 else "reception"
            answered = min(a.start + timedelta(hours=r.randint(2, 30)), self.now - timedelta(minutes=10))
            fb = Feedback.objects.create(
                clinic=self.clinic, patient=a.patient, appointment=a, dentist=a.dentist, score=score, comment=r.choice(FEEDBACK[score]),
                source=source, answered_at=answered, created_by=r.choice(users),
            )
            self.date(fb, a.start + timedelta(hours=1))
        # Links sent after the last few visits, not answered yet.
        recent = [a for a in appts if a.start > self.now - timedelta(days=3) and not Feedback.objects.filter(appointment=a).exists()][:4]
        for a in recent:
            fb = Feedback.objects.create(clinic=self.clinic, patient=a.patient, appointment=a, dentist=a.dentist, source="link", created_by=users[0])
            self.date(fb, a.start + timedelta(hours=1))


def seed(seeder):
    CrmSeeder(seeder).run()
