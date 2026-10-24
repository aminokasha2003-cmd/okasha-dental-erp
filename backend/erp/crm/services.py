"""CRM logic kept out of the views: duplicate phones, the recall queue,
campaign audiences, messages and results, and the feedback score."""

from collections import defaultdict
from datetime import date, timedelta
from decimal import Decimal

from django.db.models import Max, Q
from django.utils import timezone

from erp.appointments.models import Appointment
from erp.billing.models import ZERO, Invoice, Payment
from erp.core.notifications import notify
from erp.masterdata.models import Procedure
from erp.patients.models import Patient, normalize_phone

from .models import Campaign, CampaignRecipient, Feedback, Lead, RecallContact, RecallRule

ATTRIBUTION_DAYS = 30
DUE_SOON_DAYS = 30


def add_months(day, months):
    month = day.month - 1 + months
    year = day.year + month // 12
    month = month % 12 + 1
    for d in (day.day, 30, 29, 28):
        try:
            return day.replace(year=year, month=month, day=d)
        except ValueError:
            continue
    return day


def phone_key(value):
    """The last ten digits: '+201012345678', '01012345678' and '٠١٠١٢٣٤٥٦٧٨' all match."""
    digits = "".join(ch for ch in normalize_phone(value) if ch.isdigit())
    return digits[-10:] if len(digits) >= 10 else digits


def duplicates(clinic, phone, exclude_lead=None):
    key = phone_key(phone)
    if len(key) < 7:
        return {"patients": [], "leads": []}
    patients = Patient.objects.filter(clinic=clinic).filter(Q(phone__endswith=key) | Q(phone_alt__endswith=key))
    leads = Lead.objects.filter(clinic=clinic, phone__endswith=key)
    if exclude_lead is not None:
        leads = leads.exclude(pk=exclude_lead)
    return {
        "patients": [
            {"id": p.pk, "file_number": p.file_number, "ar": p.name_ar, "en": p.name_en, "phone": p.phone, "is_active": p.is_active}
            for p in patients[:5]
        ],
        "leads": [
            {"id": x.pk, "ar": x.name_ar, "en": x.name_en, "phone": x.phone, "stage": x.stage, "patient": x.patient_id}
            for x in leads[:5]
        ],
    }


# ------------------------------------------------------------------ recalls

DEFAULT_RULES = [
    # (en, ar, kind, procedure codes, months)
    ("Check-up and cleaning", "كشف دوري وتنظيف", "checkup", [], 6),
    ("Implant review", "متابعة الزرعة", "after_procedure", ["IM01"], 3),
    ("Orthodontic adjustment", "متابعة التقويم", "after_procedure", ["OR02", "OR03", "OR04"], 1),
    ("Gum care review", "متابعة علاج اللثة", "after_procedure", ["PE01", "PE02"], 3),
]


def ensure_default_rules(clinic):
    """A clinic starts with the usual recall rules; they can be edited or switched off."""
    if RecallRule.objects.filter(clinic=clinic).exists():
        return
    procs = {p.code: p for p in Procedure.objects.filter(clinic=clinic)}
    for order, (en, ar, kind, codes, months) in enumerate(DEFAULT_RULES):
        chosen = [procs[c] for c in codes if c in procs]
        if kind == "after_procedure" and not chosen:
            continue
        rule = RecallRule.objects.create(clinic=clinic, name_en=en, name_ar=ar, kind=kind, interval_months=months, sort_order=order)
        rule.procedures.set(chosen)


def _window(rule):
    """How early a booking counts as answering the recall."""
    return timedelta(days=min(30, rule.interval_months * 15))


def recall_queue(clinic, today=None, horizon=DUE_SOON_DAYS, include_hidden=False, patient=None):
    """Who is due or overdue for each active rule.

    For each rule the anchor is the patient's latest finished visit that the rule
    starts from; the recall is due `interval_months` later. It is answered once a
    visit is booked (or done) after the anchor, no earlier than shortly before the
    due date. Contacts made since the anchor show as attempts; a declined recall
    or one snoozed into the future is hidden unless asked for."""
    ensure_default_rules(clinic)
    today = today or timezone.localdate()
    limit = today + timedelta(days=horizon)
    candidates = []
    rules = list(RecallRule.objects.filter(clinic=clinic, is_active=True).prefetch_related("procedures"))
    for rule in rules:
        visits = Appointment.objects.filter(clinic=clinic, status="completed", patient__is_active=True)
        if patient is not None:
            visits = visits.filter(patient=patient)
        if rule.kind == "after_procedure":
            procs = [p.pk for p in rule.procedures.all()]
            if not procs:
                continue
            visits = visits.filter(
                Q(procedure__in=procs) | Q(plan_lines__procedure__in=procs, plan_lines__status="done")
            )
        for row in visits.values("patient").annotate(last=Max("start")):
            anchor = row["last"]
            due = add_months(timezone.localtime(anchor).date(), rule.interval_months)
            if due <= limit:
                candidates.append((row["patient"], rule, anchor, due))
    if not candidates:
        return []
    ids = {c[0] for c in candidates}
    later = defaultdict(list)
    for pid, start, status in Appointment.objects.filter(
        patient__in=ids, status__in=(*Appointment.ACTIVE, "completed")
    ).values_list("patient", "start", "status"):
        later[pid].append((start, status))
    contacts = defaultdict(list)
    for c in RecallContact.objects.filter(clinic=clinic, patient__in=ids).select_related("created_by").order_by("created_at"):
        contacts[(c.patient_id, c.rule_id)].append(c)
    patients = {p.pk: p for p in Patient.objects.filter(pk__in=ids)}
    last_visit = dict(
        Appointment.objects.filter(patient__in=ids, status="completed").values("patient").annotate(m=Max("start")).values_list("patient", "m")
    )
    rows = []
    for pid, rule, anchor, due in candidates:
        threshold = due - _window(rule)
        if any(start > anchor and timezone.localtime(start).date() >= threshold for start, _ in later[pid]):
            continue
        attempts = [c for c in contacts[(pid, rule.pk)] if c.created_at > anchor]
        latest = attempts[-1] if attempts else None
        hidden = None
        if latest and latest.outcome == "declined":
            hidden = "declined"
        elif latest and latest.snooze_until and latest.snooze_until > today:
            hidden = "snoozed"
        if hidden and not include_hidden:
            continue
        p = patients[pid]
        rows.append({
            "patient": p,
            "rule": rule,
            "anchor": anchor,
            "due": due,
            "status": "overdue" if due < today else "due",
            "days_overdue": (today - due).days,
            "last_visit": last_visit.get(pid),
            "attempts": attempts,
            "hidden": hidden,
        })
    rows.sort(key=lambda r: (r["due"], r["patient"].pk))
    return rows


def recall_compliance(clinic, start, end):
    """Of the recalls that fell due between start and end, how many came back
    (a visit booked or done within the window around the due date)."""
    ensure_default_rules(clinic)
    due_total = returned = 0
    rules = list(RecallRule.objects.filter(clinic=clinic, is_active=True).prefetch_related("procedures"))
    by_rule = []
    for rule in rules:
        visits = Appointment.objects.filter(clinic=clinic, status="completed")
        if rule.kind == "after_procedure":
            procs = [p.pk for p in rule.procedures.all()]
            if not procs:
                continue
            visits = visits.filter(Q(procedure__in=procs) | Q(plan_lines__procedure__in=procs, plan_lines__status="done"))
        anchors = defaultdict(list)
        for pid, start_at in visits.values_list("patient", "start").distinct():
            anchors[pid].append(start_at)
        all_visits = defaultdict(list)
        for pid, start_at in Appointment.objects.filter(
            clinic=clinic, patient__in=list(anchors), status__in=(*Appointment.ACTIVE, "completed")
        ).values_list("patient", "start"):
            all_visits[pid].append(start_at)
        n = back = 0
        for pid, starts in anchors.items():
            for anchor in starts:
                due = add_months(timezone.localtime(anchor).date(), rule.interval_months)
                if not (start <= due <= end):
                    continue
                threshold = due - _window(rule)
                # A later visit of the same kind before the recall window restarts the clock.
                if any(s2 > anchor and timezone.localtime(s2).date() < threshold for s2 in starts):
                    continue
                n += 1
                if any(s > anchor and timezone.localtime(s).date() >= threshold for s in all_visits[pid]):
                    back += 1
        due_total += n
        returned += back
        by_rule.append({"rule": rule, "due": n, "returned": back})
    return {"due": due_total, "returned": returned, "rate": round(returned * 100 / due_total, 1) if due_total else None, "by_rule": by_rule}


# --------------------------------------------------------------- campaigns

def balances(clinic, patient_ids=None):
    """What each patient owes on issued invoices, less money paid on account."""
    owed = defaultdict(lambda: ZERO)
    invoices = Invoice.objects.filter(clinic=clinic, status="issued").prefetch_related("lines", "payments")
    on_account = Payment.objects.filter(clinic=clinic, invoice__isnull=True, voided_at__isnull=True)
    if patient_ids is not None:
        invoices = invoices.filter(patient__in=patient_ids)
        on_account = on_account.filter(patient__in=patient_ids)
    for inv in invoices:
        owed[inv.patient_id] += inv.balance
    for pid, amount in on_account.values_list("patient", "amount"):
        owed[pid] -= amount
    return owed


def _int(value):
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _day(value):
    try:
        return date.fromisoformat(value) if value else None
    except (TypeError, ValueError):
        return None


def audience(clinic, filters, today=None):
    """The patients (or leads) a campaign's filters select, as a list of dicts.

    Patient filters: last_visit_before (date), age_min, age_max, gender, branch,
    procedure_done, procedure_not_done (procedure IDs), has_balance (bool),
    birthday_month (bool), no_shows (at least this many). Lead filters (with
    audience "leads"): lead_stages (list), lead_source."""
    today = today or timezone.localdate()
    f = filters or {}
    if f.get("audience") == "leads":
        qs = Lead.objects.filter(clinic=clinic, patient__isnull=True)
        stages = [s for s in (f.get("lead_stages") or []) if s in dict(Lead.STAGES)]
        if stages:
            qs = qs.filter(stage__in=stages)
        if f.get("lead_source"):
            qs = qs.filter(source=f["lead_source"])
        return [
            {"kind": "lead", "obj": x, "name_ar": x.name_ar, "name_en": x.name_en, "phone": x.phone,
             "language": x.language, "consent": x.whatsapp_opt_in, "balance": ZERO, "patient_id": None}
            for x in qs.order_by("id")
        ]
    qs = Patient.objects.filter(clinic=clinic, is_active=True)
    if f.get("gender") in ("male", "female"):
        qs = qs.filter(gender=f["gender"])
    if _int(f.get("branch")):
        qs = qs.filter(home_branch=_int(f["branch"]))
    age_min, age_max = _int(f.get("age_min")), _int(f.get("age_max"))
    if age_min is not None:
        qs = qs.filter(date_of_birth__lte=add_months(today, -12 * age_min))
    if age_max is not None:
        qs = qs.filter(date_of_birth__gt=add_months(today, -12 * (age_max + 1)))
    if f.get("birthday_month"):
        qs = qs.filter(date_of_birth__month=today.month)
    before = _day(f.get("last_visit_before"))
    if before:
        qs = qs.annotate(last_done=Max("appointments__start", filter=Q(appointments__status="completed"))).filter(last_done__date__lt=before)
    for key, keep in (("procedure_done", True), ("procedure_not_done", False)):
        proc = _int(f.get(key))
        if proc:
            done = Patient.objects.filter(
                Q(treatment_plans__lines__procedure=proc, treatment_plans__lines__status="done")
                | Q(appointments__procedure=proc, appointments__status="completed"),
                clinic=clinic,
            ).values("pk")
            qs = qs.filter(pk__in=done) if keep else qs.exclude(pk__in=done)
    no_shows = _int(f.get("no_shows"))
    if no_shows:
        counts = defaultdict(int)
        for pid in Appointment.objects.filter(clinic=clinic, status="no_show").values_list("patient", flat=True):
            counts[pid] += 1
        qs = qs.filter(pk__in=[pid for pid, n in counts.items() if n >= no_shows])
    patients = list(qs.distinct().order_by("id"))
    owed = balances(clinic, [p.pk for p in patients])
    if f.get("has_balance"):
        patients = [p for p in patients if owed[p.pk] > 0]
    return [
        {"kind": "patient", "obj": p, "name_ar": p.name_ar, "name_en": p.name_en, "phone": p.phone,
         "language": p.language, "consent": p.whatsapp_opt_in, "balance": max(owed[p.pk], ZERO), "patient_id": p.pk}
        for p in patients
    ]


def next_visit_dates(patient_ids):
    out = {}
    for pid, start in Appointment.objects.filter(
        patient__in=patient_ids, status__in=("booked", "confirmed"), start__gte=timezone.now()
    ).order_by("start").values_list("patient", "start"):
        out.setdefault(pid, timezone.localtime(start).date())
    return out


def render(template, *, name, clinic_name, day, balance, language):
    """Fill {name}, {clinic}, {date} and {balance}. Unknown braces are left as typed."""
    values = {
        "name": name,
        "clinic": clinic_name,
        "date": day.strftime("%d/%m/%Y") if day else "",
        "balance": f"{balance:,.0f}" if balance else "0",
    }
    out = template or ""
    for key, value in values.items():
        out = out.replace("{" + key + "}", value)
    return out.strip()


def message_for(campaign, person, next_dates=None):
    lang = "en" if person["language"] == "en" and campaign.message_en.strip() else "ar"
    if lang == "ar" and not campaign.message_ar.strip():
        lang = "en"
    template = campaign.message_en if lang == "en" else campaign.message_ar
    name = (person["name_en"] or person["name_ar"]) if lang == "en" else (person["name_ar"] or person["name_en"])
    clinic = campaign.clinic
    day = (next_dates or {}).get(person["patient_id"]) or campaign.offer_date
    return lang, render(
        template, name=name.split()[0] if name else "", clinic_name=clinic.name_en if lang == "en" else clinic.name_ar,
        day=day, balance=person["balance"], language=lang,
    )


def send_campaign(campaign, user=None):
    """Send to everyone the filters select. People without WhatsApp consent are
    skipped for a WhatsApp campaign. Returns the counts."""
    people = audience(campaign.clinic, campaign.filters)
    next_dates = next_visit_dates([p["patient_id"] for p in people if p["patient_id"]])
    now = timezone.now()
    counts = defaultdict(int)
    for person in people:
        lang, body = message_for(campaign, person, next_dates)
        r = CampaignRecipient(
            campaign=campaign, phone=person["phone"], language=lang, body=body,
            patient=person["obj"] if person["kind"] == "patient" else None,
            lead=person["obj"] if person["kind"] == "lead" else None,
        )
        if campaign.channel == "whatsapp" and not person["consent"]:
            r.status = "skipped"
        else:
            n = notify(campaign.clinic, campaign.channel, body, phone=person["phone"], subject=campaign.name[:200])
            r.notification = n
            r.status = "sent" if n.status == "sent" else "failed"
            r.error = n.error[:255]
            r.sent_at = n.sent_at
        r.save()
        counts[r.status] += 1
    campaign.status = "sent"
    campaign.sent_at = now
    campaign.updated_by = user
    campaign.save(update_fields=["status", "sent_at", "updated_by", "updated_at"])
    return dict(counts)


def campaign_results(campaign):
    """Sent, failed, responded and what came back within 30 days of sending:
    appointments booked and invoices issued to the people messaged who booked.
    People who already had a visit booked when it went out are not counted."""
    recipients = list(campaign.recipients.select_related("lead"))
    sent_at = campaign.sent_at
    out = {
        "audience": len(recipients),
        "sent": sum(1 for r in recipients if r.status == "sent"),
        "failed": sum(1 for r in recipients if r.status == "failed"),
        "skipped": sum(1 for r in recipients if r.status == "skipped"),
        "responded": 0, "booked": 0, "appointments": 0, "revenue": ZERO, "collected": ZERO,
        "per_recipient": {},
    }
    if not sent_at:
        out["revenue"] = "0.00"
        out["collected"] = "0.00"
        out["roi"] = None
        return out
    end = sent_at + timedelta(days=ATTRIBUTION_DAYS)
    by_patient = {}
    for r in recipients:
        pid = r.patient_id or (r.lead.patient_id if r.lead_id else None)
        if pid and r.status in ("sent", "manual", "failed"):
            by_patient.setdefault(pid, []).append(r)
    # Someone who already had a visit booked when the message went out was coming anyway.
    already = set(
        Appointment.objects.filter(patient__in=list(by_patient), created_at__lt=sent_at, start__gte=sent_at)
        .exclude(status="cancelled").values_list("patient", flat=True)
    )
    by_patient = {pid: rows for pid, rows in by_patient.items() if pid not in already}
    appts = defaultdict(list)
    for a in Appointment.objects.filter(
        patient__in=list(by_patient), created_at__gte=sent_at, created_at__lt=end
    ).exclude(status="cancelled").values("patient", "id"):
        appts[a["patient"]].append(a["id"])
    revenue = defaultdict(lambda: ZERO)
    for inv in Invoice.objects.filter(
        patient__in=list(by_patient), status="issued", issue_date__gte=timezone.localtime(sent_at).date(), issue_date__lte=timezone.localtime(end).date()
    ).prefetch_related("lines"):
        revenue[inv.patient_id] += inv.total
    collected = defaultdict(lambda: ZERO)
    for pid, amount in Payment.objects.filter(
        patient__in=list(by_patient), voided_at__isnull=True,
        paid_on__gte=timezone.localtime(sent_at).date(), paid_on__lte=timezone.localtime(end).date(),
    ).values_list("patient", "amount"):
        collected[pid] += amount
    for r in recipients:
        pid = r.patient_id or (r.lead.patient_id if r.lead_id else None)
        booked = len(appts.get(pid, [])) if pid in by_patient else 0
        r.already_booked = pid in already
        responded = bool(r.responded_at) or booked > 0
        out["responded"] += responded
        out["booked"] += booked > 0
        out["appointments"] += booked
        out["per_recipient"][r.pk] = {"booked": booked, "responded": responded, "already_booked": r.already_booked}
    out["revenue"] = sum((revenue[p] for p in by_patient if appts.get(p)), ZERO)
    out["collected"] = sum((collected[p] for p in by_patient if appts.get(p)), ZERO)
    cost = campaign.cost or ZERO
    out["roi"] = round(float((out["revenue"] - cost) / cost * 100), 1) if cost > 0 else None
    out["revenue"] = f"{out['revenue']:.2f}"
    out["collected"] = f"{out['collected']:.2f}"
    return out


# ---------------------------------------------------------------- feedback

def nps(scores):
    """NPS-style figure from 1-5 scores: share of 5s minus share of 1-3s."""
    scores = [s for s in scores if s]
    if not scores:
        return None
    promoters = sum(1 for s in scores if s == 5)
    detractors = sum(1 for s in scores if s <= 3)
    return round((promoters - detractors) * 100 / len(scores))


def feedback_summary(clinic, start=None, end=None):
    qs = Feedback.objects.filter(clinic=clinic, score__isnull=False)
    if start:
        qs = qs.filter(answered_at__date__gte=start)
    if end:
        qs = qs.filter(answered_at__date__lte=end)
    scores = list(qs.values_list("score", flat=True))
    return {
        "count": len(scores),
        "average": round(sum(scores) / len(scores), 2) if scores else None,
        "nps": nps(scores),
        "by_score": {str(n): scores.count(n) for n in range(1, 6)},
    }


def lead_funnel(clinic, start, end):
    leads = list(Lead.objects.filter(clinic=clinic, created_at__date__gte=start, created_at__date__lte=end))
    order = [s for s, _ in Lead.STAGES]
    reached = {s: 0 for s in order}
    for x in leads:
        if x.stage == "lost":
            reached["lost"] += 1
            continue
        for s in order[: order.index(x.stage) + 1]:
            reached[s] += 1
    sources = defaultdict(lambda: {"leads": 0, "won": 0, "value": Decimal("0")})
    for x in leads:
        s = sources[x.source]
        s["leads"] += 1
        if x.stage == "won":
            s["won"] += 1
            s["value"] += x.estimated_value
    won = sum(1 for x in leads if x.stage == "won")
    closed = sum(1 for x in leads if x.stage in ("won", "lost"))
    return {
        "leads": len(leads),
        "won": won,
        "lost": reached["lost"],
        "conversion": round(won * 100 / len(leads), 1) if leads else None,
        "win_rate": round(won * 100 / closed, 1) if closed else None,
        "stages": reached,
        "sources": dict(sources),
    }
