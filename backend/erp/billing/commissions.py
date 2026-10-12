"""What each dentist's commission rule earns over a period.

Billed = invoice lines on invoices issued in the period. Collected = payments in
the period, shared across each invoice's lines by their value. Used by the
billing commission report and by payroll (phase 6), so both always agree.
"""

from decimal import Decimal

from erp.masterdata.models import StaffMember

from .models import ZERO, InvoiceLine, Payment

CENT = Decimal("0.01")


def commission_rows(clinic, start, end):
    """{staff id: {"dentist", "billed", "collected", "procedures", "commission"}} with
    unrounded Decimals. Every active dentist has a row, earning or not."""
    rows = {}

    def row(dentist):
        if dentist.pk not in rows:
            rows[dentist.pk] = {"dentist": dentist, "billed": ZERO, "collected": ZERO, "procedures": 0}
        return rows[dentist.pk]

    lines = InvoiceLine.objects.filter(
        invoice__clinic=clinic, invoice__status="issued", invoice__issue_date__range=(start, end), dentist__isnull=False
    ).select_related("dentist")
    for line in lines:
        r = row(line.dentist)
        r["billed"] += line.total
        r["procedures"] += line.quantity

    payments = Payment.objects.filter(
        clinic=clinic, voided_at__isnull=True, paid_on__range=(start, end), invoice__isnull=False, invoice__status="issued"
    ).prefetch_related("invoice__lines__dentist")
    for payment in payments:
        inv_lines = list(payment.invoice.lines.all())
        gross = sum((ln.total for ln in inv_lines), ZERO)
        if gross <= 0:
            continue
        for ln in inv_lines:
            if ln.dentist is not None:
                row(ln.dentist)["collected"] += payment.amount * ln.total / gross

    for member in StaffMember.objects.filter(clinic=clinic, staff_type="dentist", is_active=True):
        row(member)

    for r in rows.values():
        d = r["dentist"]
        value = d.commission_value
        r["commission"] = Decimal(
            {
                "percent_collected": r["collected"] * value / 100,
                "percent_billed": r["billed"] * value / 100,
                "fixed_per_procedure": value * r["procedures"],
            }.get(d.commission_type, ZERO)
        )
    return rows


def commission_for(clinic, staff, start, end):
    """One person's commission for a period, rounded to the piastre."""
    if staff.commission_type == "none":
        return ZERO
    r = commission_rows(clinic, start, end).get(staff.pk)
    return r["commission"].quantize(CENT) if r else ZERO
