"""The rules of phase 8, kept out of the views so tests and the demo use them too."""

import calendar
import secrets
from datetime import datetime, time, timedelta
from decimal import Decimal

from django.db import transaction
from django.db.models import Count, Q
from django.utils import timezone
from rest_framework.exceptions import ValidationError

from erp.appointments.models import Appointment
from erp.billing.models import Invoice
from erp.inventory import services as stock
from erp.masterdata.models import Branch, StaffMember, WorkingHours
from erp.patients.models import Patient, normalize_phone

from . import eta
from .models import (
    BookingRequest,
    BookingSettings,
    ComplianceSettings,
    EInvoiceDocument,
    EInvoiceSettings,
    EtaItemCode,
    MaintenancePlan,
    MaintenanceRecord,
    PackLoad,
    SterilizationCycle,
    WorkOrder,
    WorkOrderPart,
)

ZERO = Decimal("0.00")


def add_months(day, months):
    month = day.month - 1 + months
    year = day.year + month // 12
    month = month % 12 + 1
    return day.replace(year=year, month=month, day=min(day.day, calendar.monthrange(year, month)[1]))


# ================================================================ e-invoicing


def prepare(invoice, conf=None, codes=None, now=None):
    """Create or rebuild the ETA document of one invoice and check it."""
    conf = conf or EInvoiceSettings.for_clinic(invoice.clinic)
    doc, _created = EInvoiceDocument.objects.get_or_create(clinic=invoice.clinic, invoice=invoice)
    if doc.status not in EInvoiceDocument.REBUILDABLE:
        return doc
    payload = eta.build_document(invoice, conf, codes)
    errors = eta.validate(payload, conf)
    doc.payload = payload
    doc.errors = errors
    doc.total_amount = Decimal(str(payload["totalAmount"]))
    doc.tax_amount = sum((Decimal(str(t["amount"])) for t in payload["taxTotals"]), Decimal("0"))
    doc.receiver_type = payload["receiver"]["type"]
    doc.status = "draft" if errors else "ready"
    doc.prepared_at = now or timezone.now()
    doc.save()
    return doc


def prepare_missing(clinic, conf=None):
    """Make a document for every issued invoice from the start date that has none yet."""
    conf = conf or EInvoiceSettings.for_clinic(clinic)
    if not conf.is_registered:
        return 0
    qs = Invoice.objects.filter(clinic=clinic, status="issued", eta_document__isnull=True)
    if conf.start_date:
        qs = qs.filter(issue_date__gte=conf.start_date)
    qs = qs.select_related("patient", "branch__eta_address", "clinic").prefetch_related("lines__procedure")
    codes = {c.procedure_id: c for c in EtaItemCode.objects.filter(clinic=clinic)}
    n = 0
    for invoice in qs[:500]:
        prepare(invoice, conf, codes)
        n += 1
    return n


def submit(docs, conf, now=None):
    """Send ready documents (one batch). Returns counts by outcome."""
    now = now or timezone.now()
    docs = [d for d in docs if d.status in EInvoiceDocument.SENDABLE]
    if not docs:
        return {"sent": 0, "valid": 0, "invalid": 0, "rejected": 0, "submitted": 0}
    adapter = eta.get_adapter(conf)
    result = adapter.submit([d.payload for d in docs])
    counts = {"sent": len(docs), "valid": 0, "invalid": 0, "rejected": 0, "submitted": 0}
    for d in docs:
        d.attempts += 1
        d.simulated = adapter.simulated
        d.submission_id = result.submission_id
        d.submitted_at = now
        key = d.payload.get("internalID")
        if key in result.accepted:
            row = result.accepted[key]
            d.uuid, d.long_id, d.status, d.errors = row["uuid"], row["longId"], row["status"], row["errors"]
            if d.status in ("valid", "invalid"):
                d.validated_at = now
        else:
            d.status = "rejected"
            d.errors = result.rejected.get(key, ["The Tax Authority did not accept the document."])
        counts[d.status] = counts.get(d.status, 0) + 1
        d.save()
    return counts


def refresh_status(doc, conf):
    """Ask the ETA what became of a sent document (live mode only)."""
    if doc.status != "submitted" or not doc.uuid:
        return doc
    answer = eta.get_adapter(conf).status(doc.uuid)
    if answer and answer["status"] in ("valid", "invalid", "rejected", "cancelled"):
        doc.status = answer["status"]
        doc.errors = answer["errors"]
        doc.long_id = answer.get("longId") or doc.long_id
        doc.validated_at = timezone.now()
        doc.save()
    return doc


def cancel(doc, conf, reason):
    if doc.status == "valid":
        eta.get_adapter(conf).cancel(doc.uuid, reason)
    elif doc.status not in ("draft", "ready", "invalid", "rejected"):
        raise ValidationError({"status": "Only valid documents or ones not yet accepted can be cancelled."})
    doc.status = "cancelled"
    doc.cancelled_at = timezone.now()
    doc.cancel_reason = reason[:255]
    doc.save()
    return doc


def doc_url(doc, conf):
    if doc.status != "valid" or not doc.uuid:
        return ""
    return eta.portal_url(conf.environment, doc.uuid, doc.long_id)


def eta_brief(invoice, cache=None):
    """What the invoice screen and the printed invoice show about the ETA document."""
    try:
        doc = invoice.eta_document
    except EInvoiceDocument.DoesNotExist:
        return None
    cache = cache if cache is not None else {}
    conf = cache.get("_eta_conf")
    if conf is None:
        conf = cache["_eta_conf"] = EInvoiceSettings.for_clinic(invoice.clinic)
    return {
        "status": doc.status,
        "uuid": doc.uuid,
        "url": doc_url(doc, conf),
        "simulated": doc.simulated,
        "errors": doc.errors[:3],
    }


# ================================================================ sterilisation


def next_cycle_number(machine):
    last = SterilizationCycle.objects.filter(machine=machine).order_by("-cycle_number").values_list("cycle_number", flat=True).first()
    return (last or machine.cycles_before) + 1


def cycle_counts(clinic, machine_ids=None):
    """Total cycles per autoclave: the count before this system plus the cycles recorded here."""
    from .models import Equipment  # noqa: PLC0415

    qs = Equipment.objects.filter(clinic=clinic, category="autoclave")
    if machine_ids is not None:
        qs = qs.filter(pk__in=machine_ids)
    qs = qs.annotate(n=Count("cycles"))
    return {e.pk: e.cycles_before + e.n for e in qs}


def load_packs(cycle, packs, shelf_days=None):
    shelf = shelf_days or ComplianceSettings.for_clinic(cycle.clinic).pack_shelf_days
    expires = timezone.localtime(cycle.started_at).date() + timedelta(days=shelf)
    out = []
    for pack in packs:
        load, _created = PackLoad.objects.get_or_create(
            clinic=cycle.clinic, cycle=cycle, pack=pack, defaults={"expires_on": expires}
        )
        out.append(load)
    return out


def pack_state(load, today=None):
    """sterile, expired, used, failed or none — what the latest load of a pack means for using it."""
    today = today or timezone.localdate()
    if load is None:
        return "none"
    if load.used_at:
        return "used"
    if load.cycle.result == "fail":
        return "failed"
    if load.expires_on < today:
        return "expired"
    return "sterile"


def latest_loads(clinic, pack_ids=None):
    qs = PackLoad.objects.filter(clinic=clinic).select_related("cycle", "cycle__machine", "patient").order_by("pack_id", "-cycle__started_at", "-id")
    if pack_ids is not None:
        qs = qs.filter(pack_id__in=pack_ids)
    latest = {}
    for load in qs:
        latest.setdefault(load.pack_id, load)
    return latest


def use_pack(clinic, pack, *, appointment=None, patient=None, user=None, when=None):
    """Open a sterile pack for a patient: the link that makes recalls possible."""
    when = when or timezone.now()
    if appointment is not None:
        patient = appointment.patient
    if patient is None:
        raise ValidationError({"patient": "Choose the patient or the visit the pack is opened for."})
    with transaction.atomic():
        load = (
            PackLoad.objects.select_for_update().filter(clinic=clinic, pack=pack).select_related("cycle")
            .order_by("-cycle__started_at", "-id").first()
        )
        state = pack_state(load, timezone.localtime(when).date())
        messages = {
            "none": f"Pack {pack.code} has never been sterilised here.",
            "used": f"Pack {pack.code} was already opened; sterilise it again first.",
            "failed": f"Pack {pack.code} went through a failed cycle; sterilise it again.",
            "expired": f"Pack {pack.code} expired on {load.expires_on if load else ''}; sterilise it again.",
        }
        if state != "sterile":
            raise ValidationError({"pack": messages[state]})
        load.used_at = when
        load.appointment = appointment
        load.patient = patient
        load.used_by = user
        load.save(update_fields=["used_at", "appointment", "patient", "used_by", "updated_at"])
    return load


def suspect_cycles(cycle):
    """Cycles whose loads must be recalled because of this failed cycle.

    A positive biological indicator puts in doubt everything the autoclave
    processed since its last negative indicator, up to the moment the result
    was read and the machine was stopped. Any other failure affects only its own load."""
    if cycle.bi_result != "positive":
        return SterilizationCycle.objects.filter(pk=cycle.pk)
    last_ok = (
        SterilizationCycle.objects.filter(machine=cycle.machine, bi_result="negative", started_at__lt=cycle.started_at)
        .order_by("-started_at").values_list("started_at", flat=True).first()
    )
    until = cycle.bi_read_at or timezone.now()
    qs = SterilizationCycle.objects.filter(machine=cycle.machine, started_at__lte=max(until, cycle.started_at))
    if last_ok is not None:
        qs = qs.filter(started_at__gt=last_ok)
    return qs


def suspect_loads(cycle):
    return PackLoad.objects.filter(cycle__in=suspect_cycles(cycle))


def affected_by_cycle(cycle):
    """For a failed cycle: patients whose instruments came from it (or from the same
    autoclave since its last good biological indicator), and packs still on the shelf."""
    loads = list(suspect_loads(cycle).select_related("pack", "patient", "appointment__dentist", "used_by", "cycle").order_by("used_at", "id"))
    latest = latest_loads(cycle.clinic, {ld.pack_id for ld in loads})
    return {
        "patients": [ld for ld in loads if ld.patient_id],
        # Only packs not sterilised again since.
        "shelf": [ld for ld in loads if not ld.used_at and latest.get(ld.pack_id) and latest[ld.pack_id].pk == ld.pk],
    }


def unreviewed_recalls(clinic):
    """Patients on a recall list nobody has called yet."""
    ids = set()
    for cycle in SterilizationCycle.objects.filter(clinic=clinic, result="fail"):
        ids |= set(suspect_loads(cycle).filter(patient__isnull=False, recall_contacted_at__isnull=True).values_list("patient_id", flat=True))
    return len(ids)


def patient_trace(clinic, patient):
    return list(
        PackLoad.objects.filter(clinic=clinic, patient=patient)
        .select_related("pack", "cycle", "cycle__machine", "cycle__operator", "appointment")
        .order_by("-used_at")
    )


def bi_status(clinic, today=None):
    """When the last biological indicator was run per autoclave, and whether one is due."""
    from .models import Equipment  # noqa: PLC0415

    today = today or timezone.localdate()
    every = ComplianceSettings.for_clinic(clinic).bi_every_days
    out = []
    for machine in Equipment.objects.filter(clinic=clinic, category="autoclave").exclude(status="retired"):
        last = SterilizationCycle.objects.filter(machine=machine, bi_used=True).order_by("-started_at").first()
        last_day = timezone.localtime(last.started_at).date() if last else None
        due = last_day is None or (today - last_day).days >= every
        out.append({"machine": machine, "last": last, "last_day": last_day, "due": due})
    return out


# ================================================================ maintenance


def plan_due(plan, counts, today=None, warn_days=14):
    """When a plan is next due, by date and by cycle count, and how urgent it is."""
    today = today or timezone.localdate()
    anchor = plan.last_done_on or plan.start_on
    due_date = None
    if plan.every_months or plan.every_days:
        due_date = add_months(anchor, plan.every_months or 0) + timedelta(days=plan.every_days or 0)
    cycles_left = None
    if plan.every_cycles:
        now_cycles = counts.get(plan.equipment_id, 0)
        base = plan.last_done_cycles if plan.last_done_cycles is not None else plan.equipment.cycles_before
        cycles_left = base + plan.every_cycles - now_cycles
    overdue = (due_date is not None and due_date < today) or (cycles_left is not None and cycles_left <= 0)
    soon = (due_date is not None and due_date <= today + timedelta(days=warn_days)) or (
        cycles_left is not None and cycles_left <= max(plan.every_cycles // 10, 1)
    )
    state = "overdue" if overdue else "due_soon" if soon else "ok"
    return {"due_date": due_date, "cycles_left": cycles_left, "state": state}


def plans_with_due(clinic, today=None, qs=None):
    warn = ComplianceSettings.for_clinic(clinic).maintenance_warn_days
    plans = list((qs if qs is not None else MaintenancePlan.objects.filter(clinic=clinic, is_active=True)).select_related("equipment", "equipment__branch"))
    counts = cycle_counts(clinic, {p.equipment_id for p in plans if p.every_cycles})
    return [(p, plan_due(p, counts, today, warn)) for p in plans if p.equipment.status != "retired"]


def complete_plan(plan, *, done_on, performed_by="", cost=ZERO, notes="", work_order=None, user=None):
    counts = cycle_counts(plan.clinic, [plan.equipment_id])
    with transaction.atomic():
        record = MaintenanceRecord.objects.create(
            clinic=plan.clinic, equipment=plan.equipment, plan=plan, work_order=work_order, done_on=done_on,
            performed_by=performed_by or plan.vendor, cost=cost, cycle_count=counts.get(plan.equipment_id), notes=notes,
            created_by=user,
        )
        plan.last_done_on = done_on
        plan.last_done_cycles = counts.get(plan.equipment_id)
        plan.save(update_fields=["last_done_on", "last_done_cycles", "updated_at"])
    return record


def open_work_order(clinic, equipment, *, issue, user=None, **fields):
    with transaction.atomic():
        order = WorkOrder.objects.create(clinic=clinic, equipment=equipment, issue=issue, reported_by=user, created_by=user, **fields)
        if order.takes_out_of_service and equipment.status == "in_service":
            equipment.status = "out_of_service"
            equipment.save(update_fields=["status", "updated_at"])
    return order


def add_part(order, item, branch, quantity, user=None):
    """Take a spare part from stock for a work order, through the inventory ledger."""
    if order.status not in WorkOrder.OPEN:
        raise ValidationError({"status": "Parts can only be added to an open work order."})
    with transaction.atomic():
        movements = stock.take(order.clinic, item, branch, quantity, "use", note=f"Work order {order.number}: {order.equipment.name_en}")
        part = WorkOrderPart.objects.create(
            clinic=order.clinic, work_order=order, item=item, branch=branch, quantity=Decimal(quantity),
            cost=sum((m.value for m in movements), ZERO), created_by=user,
        )
        part.movements.set(movements)
    return part


def close_work_order(order, *, status="done", resolution="", labour_cost=None, when=None, user=None):
    if order.status not in WorkOrder.OPEN:
        raise ValidationError({"status": "This work order is already closed."})
    when = when or timezone.now()
    with transaction.atomic():
        order.status = status
        order.completed_at = when
        order.resolution = resolution or order.resolution
        if labour_cost is not None:
            order.labour_cost = labour_cost
        order.save()
        if status == "done":
            parts = sum((p.cost for p in order.parts.all()), ZERO)
            MaintenanceRecord.objects.create(
                clinic=order.clinic, equipment=order.equipment, plan=order.plan, work_order=order,
                done_on=timezone.localtime(when).date(), performed_by=order.assigned_to, cost=order.labour_cost + parts,
                notes=order.resolution, created_by=user,
            )
            if order.plan_id:
                complete_plan_dates(order.plan, timezone.localtime(when).date())
        equipment = order.equipment
        still_down = equipment.work_orders.filter(status__in=WorkOrder.OPEN, takes_out_of_service=True).exists()
        if equipment.status == "out_of_service" and not still_down:
            equipment.status = "in_service"
            equipment.save(update_fields=["status", "updated_at"])
    return order


def complete_plan_dates(plan, done_on):
    counts = cycle_counts(plan.clinic, [plan.equipment_id])
    plan.last_done_on = done_on
    plan.last_done_cycles = counts.get(plan.equipment_id)
    plan.save(update_fields=["last_done_on", "last_done_cycles", "updated_at"])


def licence_state(licence, today=None, warn_days=60):
    today = today or timezone.localdate()
    if licence.expires_on < today:
        return "expired"
    if licence.expires_on <= today + timedelta(days=warn_days):
        return "expiring"
    return "ok"


# ================================================================ website booking

RATE_PER_HOUR = 5  # booking requests one address may send in an hour
PENDING_PER_PHONE = 3


def booking_branches(conf):
    chosen = list(conf.branches.filter(is_active=True))
    return chosen or list(Branch.objects.filter(clinic=conf.clinic, is_active=True))


def booking_dentists(clinic, branch):
    qs = StaffMember.objects.filter(clinic=clinic, staff_type="dentist", is_active=True)
    return [d for d in qs.prefetch_related("branches") if not d.branches.all() or any(b.pk == branch.pk for b in d.branches.all())]


def _busy(clinic, dentist_ids, start, end, exclude_request=None):
    """Busy spans per dentist: active appointments and requests still waiting for reception."""
    busy = {d: [] for d in dentist_ids}
    for a in Appointment.objects.filter(clinic=clinic, dentist_id__in=dentist_ids, status__in=Appointment.ACTIVE, start__lt=end, end__gt=start):
        busy[a.dentist_id].append((a.start, a.end))
    pending = BookingRequest.objects.filter(clinic=clinic, dentist_id__in=dentist_ids, status="pending", start__lt=end)
    if exclude_request is not None:
        pending = pending.exclude(pk=exclude_request.pk)
    for r in pending:
        if r.end > start:
            busy[r.dentist_id].append((r.start, r.end))
    return busy


def free_slots(conf, branch, day, duration, dentist=None, now=None):
    """Start times on one day with at least one free dentist: [(start, [dentist ids])]."""
    now = now or timezone.now()
    clinic = conf.clinic
    today = timezone.localdate(now)
    if day < today or day > today + timedelta(days=conf.days_ahead):
        return []
    hours = WorkingHours.objects.filter(branch=branch, weekday=day.weekday()).first()
    if hours is None or hours.is_closed or not hours.opens_at or not hours.closes_at:
        return []
    dentists = [dentist] if dentist is not None else booking_dentists(clinic, branch)
    if not dentists:
        return []
    open_at = timezone.make_aware(datetime.combine(day, hours.opens_at))
    close_at = timezone.make_aware(datetime.combine(day, hours.closes_at))
    earliest = now + timedelta(hours=conf.min_notice_hours)
    busy = _busy(clinic, [d.pk for d in dentists], open_at, close_at)
    step = timedelta(minutes=conf.slot_minutes)
    length = timedelta(minutes=duration)
    out = []
    start = open_at
    while start + length <= close_at:
        if start >= earliest:
            end = start + length
            free = [d.pk for d in dentists if not any(a < end and b > start for a, b in busy[d.pk])]
            if free:
                out.append((start, free))
        start += step
    return out


def service_minutes(conf, procedure):
    if procedure is not None and procedure.default_duration_minutes:
        return max(procedure.default_duration_minutes, conf.slot_minutes)
    return conf.slot_minutes


def new_reference():
    return secrets.token_hex(3).upper()


def create_request(conf, *, branch, procedure, dentist, start, name, phone, note="", language="ar", consent=False, ip=None, user_agent=""):
    """A booking request from the public page. The branch row is locked so two
    visitors cannot take the same dentist's slot at the same moment."""
    clinic = conf.clinic
    now = timezone.now()
    phone = normalize_phone(phone)
    if len(phone.lstrip("+")) < 8:
        raise ValidationError({"phone": "Enter a mobile number we can call."})
    if not consent:
        raise ValidationError({"consent": "Please agree so the clinic can contact you."})
    if ip and BookingRequest.objects.filter(ip_address=ip, created_at__gte=now - timedelta(hours=1)).count() >= RATE_PER_HOUR:
        raise ValidationError({"detail": "Too many requests from this connection. Please call the clinic."})
    if BookingRequest.objects.filter(clinic=clinic, phone=phone, status="pending", start__gte=now).count() >= PENDING_PER_PHONE:
        raise ValidationError({"phone": "This number already has requests waiting. The clinic will call you."})
    duration = service_minutes(conf, procedure)
    with transaction.atomic():
        Branch.objects.select_for_update().filter(pk=branch.pk).first()
        day = timezone.localtime(start).date()
        slots = dict(free_slots(conf, branch, day, duration, dentist, now))
        if start not in slots:
            raise ValidationError({"start": "Sorry, this time was just taken. Please choose another one."})
        chosen = dentist or StaffMember.objects.get(pk=slots[start][0])
        return BookingRequest.objects.create(
            clinic=clinic, reference=new_reference(), branch=branch, procedure=procedure, dentist=chosen,
            dentist_chosen=dentist is not None, start=start, duration_minutes=duration, name=name.strip()[:150], phone=phone,
            note=(note or "").strip()[:500], language=language if language in ("ar", "en") else "ar", consent=True,
            ip_address=ip, user_agent=(user_agent or "")[:255],
        )


def is_arabic(text):
    return any("؀" <= ch <= "ۿ" for ch in text or "")


def find_or_create_patient(clinic, name, phone, branch=None, language="ar", user=None):
    phone = normalize_phone(phone)
    tail = phone.lstrip("+")[-10:]
    match = Patient.objects.filter(clinic=clinic, phone__endswith=tail, is_active=True).order_by("id").first() if tail else None
    if match:
        return match, False
    patient = Patient(
        clinic=clinic, phone=phone, language=language, home_branch=branch, referral_source="other",
        notes="Registered from an online booking request.", created_by=user,
        **({"name_ar": name} if is_arabic(name) else {"name_en": name}),
    )
    patient.save()
    return patient, True


def confirm_request(req, *, user=None, dentist=None, start=None, chair=None):
    """Turn a request into a normal appointment, finding the patient by phone or registering them."""
    if req.status != "pending":
        raise ValidationError({"status": "This request was already handled."})
    from erp.appointments.serializers import clashes  # noqa: PLC0415

    dentist = dentist or req.dentist
    start = start or req.start
    if dentist is None:
        raise ValidationError({"dentist": "Choose a dentist."})
    end = start + timedelta(minutes=req.duration_minutes)
    with transaction.atomic():
        Branch.objects.select_for_update().filter(pk=req.branch_id).first()
        found = clashes(None, chair=chair, dentist=dentist, start=start, end=end)
        if found:
            raise ValidationError(found)
        patient, _created = find_or_create_patient(req.clinic, req.name, req.phone, req.branch, req.language, user)
        appt = Appointment.objects.create(
            clinic=req.clinic, patient=patient, dentist=dentist, branch=req.branch, chair=chair, procedure=req.procedure,
            start=start, duration_minutes=req.duration_minutes, status="confirmed",
            reason=(req.procedure.name_en if req.procedure else "Online booking")[:255],
            notes=f"Booked online ({req.reference}). {req.note}".strip(), created_by=user,
        )
        req.status = "confirmed"
        req.patient = patient
        req.appointment = appt
        req.dentist = dentist
        req.start = start
        req.decided_by = user
        req.decided_at = timezone.now()
        req.save()
    return req


def reject_request(req, *, user=None, reason=""):
    if req.status != "pending":
        raise ValidationError({"status": "This request was already handled."})
    req.status = "rejected"
    req.reject_reason = reason[:255]
    req.decided_by = user
    req.decided_at = timezone.now()
    req.save()
    return req


def expire_old_requests(clinic):
    return BookingRequest.objects.filter(clinic=clinic, status="pending", start__lt=timezone.now()).update(status="expired")


def booking_conf_for_slug(slug):
    return BookingSettings.objects.select_related("clinic").filter(slug=slug, enabled=True).first()


def day_bounds(day):
    start = timezone.make_aware(datetime.combine(day, time.min))
    return start, start + timedelta(days=1)


def summary_counts(clinic, user):
    """The hero numbers on the compliance page and the sidebar badges, limited to what this user may see."""
    today = timezone.localdate()
    out = {}
    if user.has_module_perm("compliance", "view"):
        settings = ComplianceSettings.for_clinic(clinic)
        start, end = day_bounds(today)
        cycles_today = SterilizationCycle.objects.filter(clinic=clinic, started_at__gte=start, started_at__lt=end)
        out["cycles_today"] = cycles_today.count()
        out["failed_cycles"] = SterilizationCycle.objects.filter(clinic=clinic, result="fail", started_at__gte=start - timedelta(days=30)).count()
        out["failed_unreviewed"] = unreviewed_recalls(clinic)
        out["bi_pending"] = SterilizationCycle.objects.filter(clinic=clinic, bi_result="pending").count()
        due = plans_with_due(clinic, today)
        out["maintenance_overdue"] = sum(1 for _p, d in due if d["state"] == "overdue")
        out["maintenance_due_soon"] = sum(1 for _p, d in due if d["state"] == "due_soon")
        from .models import Equipment, Licence  # noqa: PLC0415

        out["equipment_down"] = Equipment.objects.filter(clinic=clinic, status="out_of_service").count()
        out["open_work_orders"] = WorkOrder.objects.filter(clinic=clinic, status__in=WorkOrder.OPEN).count()
        out["licences_expiring"] = Licence.objects.filter(clinic=clinic, expires_on__lte=today + timedelta(days=settings.licence_warn_days)).count()
    if user.has_module_perm("einvoice", "view"):
        docs = EInvoiceDocument.objects.filter(clinic=clinic)
        by = dict(docs.values_list("status").annotate(n=Count("id")))
        out["einvoice_ready"] = by.get("ready", 0)
        out["einvoice_pending"] = by.get("ready", 0) + by.get("draft", 0) + by.get("submitted", 0)
        out["einvoice_invalid"] = by.get("invalid", 0) + by.get("rejected", 0)
        out["einvoice_draft"] = by.get("draft", 0)
    if user.has_module_perm("appointments", "view"):
        out["online_waiting"] = BookingRequest.objects.filter(clinic=clinic, status="pending", start__gte=timezone.now()).count()
    return out


def month_range(year):
    return [(year, m) for m in range(1, 13)]


def einvoice_months(clinic, year):
    rows = (
        EInvoiceDocument.objects.filter(clinic=clinic, invoice__issue_date__year=year)
        .values("invoice__issue_date__month", "status")
        .annotate(n=Count("id"))
    )
    months = {m: {"month": m, "counts": {}, "total": Decimal("0"), "tax": Decimal("0")} for m in range(1, 13)}
    for r in rows:
        months[r["invoice__issue_date__month"]]["counts"][r["status"]] = r["n"]
    for d in EInvoiceDocument.objects.filter(clinic=clinic, invoice__issue_date__year=year, status="valid").values("invoice__issue_date__month", "total_amount", "tax_amount"):
        m = months[d["invoice__issue_date__month"]]
        m["total"] += d["total_amount"]
        m["tax"] += d["tax_amount"]
    return list(months.values())


def q_search(term, *fields):
    q = Q()
    for f in fields:
        q |= Q(**{f"{f}__icontains": term})
    return q
