"""The arithmetic of staff and payroll, kept out of the views so the day board,
the monthly summary, the staff member's own page and payroll all agree.

A "day row" is one person on one day: the shifts they were rostered for, their
attendance records, and any approved leave. From it come worked, late,
early-leave and overtime minutes and a status (off, scheduled, not_in, in,
out, missing_out, absent, leave).
"""

from calendar import monthrange
from collections import defaultdict
from datetime import date, timedelta
from decimal import ROUND_HALF_UP, Decimal

from django.db import transaction
from django.utils import timezone
from rest_framework.exceptions import ValidationError

from erp.billing.commissions import commission_rows
from erp.masterdata.models import StaffMember, WorkingHours

from .models import (
    ZERO,
    AdvanceRepayment,
    AttendanceRecord,
    LeaveRequest,
    PayrollItem,
    PayrollLine,
    PayrollSettings,
    RosterEntry,
    SalaryAdvance,
)

CENT = Decimal("0.01")
# An open record older than this is a forgotten clock-out, not someone still at work.
OPEN_LIMIT = timedelta(hours=16)


def q(value):
    return Decimal(value).quantize(CENT, rounding=ROUND_HALF_UP)


def minutes_between(a, b):
    return int((b - a).total_seconds() // 60)


def parse_month(value, field="month"):
    """'2026-10' (or a full date) to the first day of that month."""
    if not value:
        return timezone.localdate().replace(day=1)
    try:
        if len(value) == 7:
            year, month = value.split("-")
            return date(int(year), int(month), 1)
        return date.fromisoformat(value).replace(day=1)
    except (TypeError, ValueError) as exc:
        raise ValidationError({field: "Use a month like 2026-10."}) from exc


def month_end(first):
    return first.replace(day=monthrange(first.year, first.month)[1])


def add_months(first, n):
    month = first.month - 1 + n
    return date(first.year + month // 12, month % 12 + 1, 1)


def closed_weekdays(clinic):
    """Weekdays every branch is closed (Friday in most clinics). Leave does not count them."""
    rows = WorkingHours.objects.filter(clinic=clinic, branch__is_active=True).values_list("branch", "weekday", "is_closed")
    branches = {b for b, _w, _c in rows}
    closed = defaultdict(set)
    for branch, weekday, is_closed in rows:
        if is_closed:
            closed[weekday].add(branch)
    return {w for w, bs in closed.items() if branches and bs == branches}


def leave_days(start, end, closed=(), clip_start=None, clip_end=None):
    """Days of leave between two dates, inclusive, leaving out closed weekdays."""
    first = max(start, clip_start) if clip_start else start
    last = min(end, clip_end) if clip_end else end
    n, day = 0, first
    while day <= last:
        if day.weekday() not in closed:
            n += 1
        day += timedelta(days=1)
    return n


# ---------------------------------------------------------------- day rows


def is_live(record, now):
    return record.clock_out is None and record.clock_in >= now - OPEN_LIMIT


def day_row(staff_id, day, shifts, records, leave, rules, now):
    grace = timedelta(minutes=rules.late_grace_minutes)
    shifts = sorted(shifts, key=lambda e: e.start_at)
    records = sorted(records, key=lambda r: r.clock_in)
    closed = [r for r in records if r.clock_out]
    live = [r for r in records if is_live(r, now)]
    forgotten = [r for r in records if r.clock_out is None and not is_live(r, now)]
    worked = sum(r.minutes for r in closed)
    worked_now = worked + sum(max(minutes_between(r.clock_in, now), 0) for r in live)
    late = early = overtime = 0
    if shifts and records:
        late = max(minutes_between(shifts[0].start_at + grace, records[0].clock_in), 0)
    finished = closed and not live and not forgotten
    if finished:
        last_out = max(r.clock_out for r in closed)
        if shifts:
            early = max(minutes_between(last_out, shifts[-1].end_at), 0)
            overtime = max(minutes_between(shifts[-1].end_at, last_out), 0)
        else:
            overtime = max(worked - int(rules.hours_per_day * 60), 0)
    if records:
        status = "in" if live else "missing_out" if forgotten else "out"
    elif leave is not None:
        status = "leave"
    elif shifts:
        if now >= shifts[-1].end_at:
            status = "absent"
        elif now >= shifts[0].start_at + grace:
            status = "not_in"
        else:
            status = "scheduled"
    else:
        status = "off"
    return {
        "staff": staff_id,
        "date": day,
        "shifts": shifts,
        "records": records,
        "leave": leave,
        "status": status,
        "rostered_minutes": sum(e.minutes for e in shifts),
        "worked_minutes": worked,
        "worked_now": worked_now,
        "late_minutes": late,
        "early_leave_minutes": early,
        "overtime_minutes": overtime,
    }


def day_rows(clinic, start, end, staff_ids=None, branch=None, rules=None, now=None):
    """{(staff id, day): row} for every person-day with a shift, a record or leave."""
    now = now or timezone.now()
    rules = rules or PayrollSettings.for_clinic(clinic)
    entries = RosterEntry.objects.filter(clinic=clinic, date__range=(start, end))
    records = AttendanceRecord.objects.filter(clinic=clinic, date__range=(start, end))
    leaves = LeaveRequest.objects.filter(clinic=clinic, status="approved", start_date__lte=end, end_date__gte=start)
    if staff_ids is not None:
        entries, records, leaves = (x.filter(staff__in=staff_ids) for x in (entries, records, leaves))
    if branch:
        entries = entries.filter(branch=branch)
        records = records.filter(branch=branch)
    shifts, recs, leave_on = defaultdict(list), defaultdict(list), {}
    for e in entries:
        shifts[(e.staff_id, e.date)].append(e)
    for r in records:
        recs[(r.staff_id, r.date)].append(r)
    for lv in leaves:
        day = max(lv.start_date, start)
        while day <= min(lv.end_date, end):
            leave_on.setdefault((lv.staff_id, day), lv)
            day += timedelta(days=1)
    if branch:
        # People on leave show at the branches they belong to.
        members = set(StaffMember.objects.filter(clinic=clinic, branches=branch).values_list("pk", flat=True))
        leave_on = {k: v for k, v in leave_on.items() if k[0] in members}
    keys = set(shifts) | set(recs) | set(leave_on)
    return {
        key: day_row(key[0], key[1], shifts.get(key, []), recs.get(key, []), leave_on.get(key), rules, now)
        for key in keys
    }


def summarize(rows, leaves=(), closed=(), start=None, end=None):
    """Totals for one person over a period, from their day rows and approved leave."""
    out = {
        "rostered_days": 0, "present_days": 0, "days_worked": 0, "absent_days": 0, "late_days": 0,
        "rostered_minutes": 0, "worked_minutes": 0, "late_minutes": 0, "early_leave_minutes": 0,
        "overtime_minutes": 0, "missing_out": 0,
    }
    for r in rows:
        if r["shifts"]:
            out["rostered_days"] += 1
            out["rostered_minutes"] += r["rostered_minutes"]
        if r["records"]:
            out["present_days"] += 1
        if r["worked_minutes"] > 0:
            out["days_worked"] += 1
        if r["status"] == "absent":
            out["absent_days"] += 1
        if r["status"] == "missing_out":
            out["missing_out"] += 1
        if r["late_minutes"] > 0:
            out["late_days"] += 1
        for key in ("worked_minutes", "late_minutes", "early_leave_minutes", "overtime_minutes"):
            out[key] += r[key]
    by_kind = defaultdict(int)
    for lv in leaves:
        by_kind[lv.kind] += leave_days(lv.start_date, lv.end_date, closed, start, end)
    out["leave_days"] = dict(by_kind)
    return out


def group_by_staff(rows):
    grouped = defaultdict(list)
    for (staff_id, _day), row in rows.items():
        grouped[staff_id].append(row)
    return grouped


def approved_leave(clinic, start, end, staff_ids=None):
    qs = LeaveRequest.objects.filter(clinic=clinic, status="approved", start_date__lte=end, end_date__gte=start)
    if staff_ids is not None:
        qs = qs.filter(staff__in=staff_ids)
    grouped = defaultdict(list)
    for lv in qs:
        grouped[lv.staff_id].append(lv)
    return grouped


def month_summaries(clinic, first, staff_ids=None, rules=None, now=None):
    """{staff id: summary} for a month."""
    last = month_end(first)
    rows = group_by_staff(day_rows(clinic, first, last, staff_ids, rules=rules, now=now))
    leaves = approved_leave(clinic, first, last, staff_ids)
    closed = closed_weekdays(clinic)
    ids = set(rows) | set(leaves) | set(staff_ids or [])
    return {sid: summarize(rows.get(sid, []), leaves.get(sid, []), closed, first, last) for sid in ids}


# -------------------------------------------------------------------- leave


def leave_balance(clinic, staff, year, closed=None):
    closed = closed_weekdays(clinic) if closed is None else closed
    profile = getattr(staff, "employment", None)
    entitlement = profile.annual_leave_days if profile else 21
    first, last = date(year, 1, 1), date(year, 12, 31)
    used = pending = 0
    for lv in LeaveRequest.objects.filter(
        clinic=clinic, staff=staff, kind="annual", status__in=("approved", "pending"), start_date__lte=last, end_date__gte=first
    ):
        n = leave_days(lv.start_date, lv.end_date, closed, first, last)
        if lv.status == "approved":
            used += n
        else:
            pending += n
    return {"year": year, "entitlement": entitlement, "used": used, "pending": pending, "remaining": entitlement - used}


# ------------------------------------------------------------------ payroll


def eligible_staff(run):
    """Active staff with a pay profile, at the run's branch, not already on
    another run for the same month (so nobody is paid twice)."""
    qs = StaffMember.objects.filter(clinic=run.clinic, is_active=True, employment__isnull=False).select_related("employment")
    if run.branch_id:
        qs = qs.filter(branches=run.branch_id)
    elsewhere = PayrollLine.objects.filter(run__clinic=run.clinic, run__period=run.period).exclude(run=run).values("staff")
    return list(qs.exclude(pk__in=elsewhere).distinct().order_by("name_en", "id"))


def advance_installments(staff, run, period_end):
    """(advance, installment) for each advance still being repaid. Installments
    already sitting on other unpaid runs count as taken."""
    out = []
    for adv in SalaryAdvance.objects.filter(staff=staff, status="active", date__lte=period_end).prefetch_related("repayments"):
        held = sum(
            (i.amount for i in PayrollItem.objects.filter(advance=adv, line__run__status__in=("draft", "approved")).exclude(line__run=run)),
            ZERO,
        )
        left = adv.remaining - held
        if left > 0:
            out.append((adv, min(adv.monthly_installment, left)))
    return out


def commission_taken(run, staff, start, end):
    """Another payroll line that already pays this person's commission for an overlapping period."""
    return (
        PayrollLine.objects.filter(
            run__clinic=run.clinic, staff=staff, commission__gt=0, commission_start__lte=end, commission_end__gte=start
        )
        .exclude(run=run)
        .select_related("run")
        .first()
    )


def fill_line(line, run, profile, rules, summary, commissions, first, last):
    """Work out one line's figures and its automatic items. Manual items, the
    income tax, waived deductions and the note are left as they are."""
    staff = line.staff
    pay_type = profile.pay_type
    hourly = profile.hourly_equivalent(rules)
    daily = profile.daily_equivalent(rules)
    worked = summary["worked_minutes"]
    overtime = summary["overtime_minutes"]

    if pay_type == "monthly":
        base, rate = profile.base_salary, profile.base_salary
        if profile.hire_date and first < profile.hire_date <= last:
            days = monthrange(first.year, first.month)[1]
            base = base * ((last - profile.hire_date).days + 1) / days
    elif pay_type == "daily":
        rate = profile.daily_rate
        base = rate * summary["days_worked"]
    elif pay_type == "hourly":
        rate = profile.hourly_rate
        base = rate * Decimal(max(worked - overtime, 0)) / 60
    else:
        base = rate = ZERO
    line.pay_type = pay_type
    line.rate = rate
    line.base_pay = q(base)
    line.overtime_pay = q(Decimal(overtime) / 60 * hourly * profile.overtime_multiplier)

    # Commission for the run's commission month, once only.
    c_first = run.commission_period
    c_last = month_end(c_first)
    line.commission_start, line.commission_end = c_first, c_last
    line.commission_note = ""
    line.commission = ZERO
    if staff.commission_type != "none":
        row = commissions.get(staff.pk)
        amount = q(row["commission"]) if row else ZERO
        taken = commission_taken(run, staff, c_first, c_last) if amount > 0 else None
        if taken:
            line.commission_note = f"Already paid on the {taken.run.period:%Y-%m} payroll."
        else:
            line.commission = amount

    # Deductions worked out from attendance and leave.
    unpaid_days = summary["leave_days"].get("unpaid", 0)
    auto = {"lateness": ZERO, "absence": ZERO, "unpaid_leave": ZERO}
    if rules.deduct_lateness and pay_type in ("monthly", "daily"):
        auto["lateness"] = q(Decimal(summary["late_minutes"]) / 60 * hourly)
    if pay_type == "monthly":
        if rules.deduct_absence:
            auto["absence"] = q(daily * summary["absent_days"])
        auto["unpaid_leave"] = q(daily * unpaid_days)
    # Attendance deductions never take more than the base pay.
    room = line.base_pay
    for kind in ("unpaid_leave", "absence", "lateness"):
        auto[kind] = min(auto[kind], max(room, ZERO))
        room -= auto[kind]

    if profile.insured:
        wage = profile.insurable_wage or (profile.base_salary if pay_type == "monthly" else ZERO)
        line.employee_insurance = q(wage * rules.employee_insurance_rate / 100)
        line.employer_insurance = q(wage * rules.employer_insurance_rate / 100)
    else:
        line.employee_insurance = line.employer_insurance = ZERO

    line.figures = {
        **summary,
        "hourly_equivalent": str(q(hourly)),
        "daily_equivalent": str(q(daily)),
        "overtime_multiplier": str(profile.overtime_multiplier),
        "unpaid_leave_days": unpaid_days,
        "worked_out": {k: str(v) for k, v in auto.items()},
    }
    line.save()

    line.items.filter(is_manual=False).delete()
    labels = {"lateness": "Lateness", "absence": "Unexcused absence", "unpaid_leave": "Unpaid leave"}
    waived = set(line.waived or [])
    for kind, amount in auto.items():
        if amount > 0 and kind not in waived:
            PayrollItem.objects.create(line=line, kind=kind, label=labels[kind], amount=amount, is_manual=False)
    for adv, installment in advance_installments(staff, line.run, last):
        PayrollItem.objects.create(
            line=line, kind="advance", label=f"Advance of {adv.date:%Y-%m-%d}", amount=installment, is_manual=False, advance=adv
        )
    getattr(line, "_prefetched_objects_cache", {}).pop("items", None)
    line.total()
    line.save(update_fields=["gross", "total_deductions", "net", "updated_at"])
    return line


@transaction.atomic
def calculate_run(run, now=None):
    if run.status != "draft":
        raise ValidationError("Only a draft payroll can be recalculated.")
    clinic = run.clinic
    rules = PayrollSettings.for_clinic(clinic)
    first, last = run.period, month_end(run.period)
    people = eligible_staff(run)
    ids = [s.pk for s in people]
    summaries = month_summaries(clinic, first, ids, rules=rules, now=now)
    commissions = commission_rows(clinic, run.commission_period, month_end(run.commission_period))
    existing = {line.staff_id: line for line in PayrollLine.objects.filter(run=run).select_related("staff")}
    for staff in people:
        profile = staff.employment
        line = existing.pop(staff.pk, None)
        if line is None:
            line = PayrollLine(
                clinic=clinic, run=run, staff=staff, pay_type=profile.pay_type,
                payout_method=profile.payout_method, payout_account=profile.payout_account,
            )
        fill_line(line, run, profile, rules, summaries[staff.pk], commissions, first, last)
    for gone in existing.values():
        gone.delete()
    run.calculated_at = timezone.now()
    run.save(update_fields=["calculated_at", "updated_at"])
    return run


@transaction.atomic
def pay_run(run, paid_on, methods, user):
    if run.status != "approved":
        raise ValidationError("Approve the payroll before marking it paid.")
    valid = {m for m, _label in PayrollLine._meta.get_field("payout_method").choices}
    for line in run.lines.all():
        method = methods.get(str(line.pk)) or methods.get(line.pk) or line.payout_method
        if method not in valid:
            raise ValidationError({"methods": f"Unknown payout method {method}."})
        if method != line.payout_method:
            line.payout_method = method
            line.save(update_fields=["payout_method", "updated_at"])
    for item in PayrollItem.objects.filter(line__run=run, kind="advance").select_related("advance", "line"):
        AdvanceRepayment.objects.create(advance=item.advance, line=item.line, date=paid_on, amount=item.amount)
        adv = SalaryAdvance.objects.prefetch_related("repayments").get(pk=item.advance_id)
        if adv.remaining <= 0 and adv.status == "active":
            adv.status = "repaid"
            adv.save(update_fields=["status", "updated_at"])
    run.status = "paid"
    run.paid_on = paid_on
    run.paid_by = user
    run.save(update_fields=["status", "paid_on", "paid_by", "updated_at"])
    return run


def run_totals(run):
    lines = list(run.lines.prefetch_related("items"))
    keys = ("base_pay", "overtime_pay", "commission", "employee_insurance", "employer_insurance", "income_tax", "gross", "total_deductions", "net")
    totals = {k: sum((getattr(line, k) for line in lines), ZERO) for k in keys}
    totals["additions"] = sum((line.additions for line in lines), ZERO)
    totals["item_deductions"] = sum((line.item_deductions for line in lines), ZERO)
    totals["cost"] = totals["gross"] + totals["employer_insurance"]
    by_method = defaultdict(lambda: {"count": 0, "net": ZERO})
    for line in lines:
        by_method[line.payout_method]["count"] += 1
        by_method[line.payout_method]["net"] += line.net
    return {
        "people": len(lines),
        **{k: f"{v:.2f}" for k, v in totals.items()},
        "by_method": [{"method": m, "count": v["count"], "net": f"{v['net']:.2f}"} for m, v in sorted(by_method.items())],
    }
