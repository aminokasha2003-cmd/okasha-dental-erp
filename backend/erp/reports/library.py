"""The report library and the owner's overview.

Each report names the module rights it needs (on top of "reports: view") and
returns columns and rows. Figures are worked out the same way as the module
dashboards, so a total here matches the number on the billing, lab, stock or
payroll page for the same period.
"""

from collections import defaultdict
from datetime import datetime, timedelta
from decimal import Decimal

from django.db.models import DecimalField, F, Prefetch, Sum
from django.utils import timezone

from erp.appointments.models import Appointment
from erp.billing.models import ZERO, Invoice, Payment
from erp.clinical.models import TreatmentPlan
from erp.crm import services as crm
from erp.crm.models import Campaign, Lead
from erp.inventory.models import StockItem, StockLot, StockMovement
from erp.lab.models import LabCase
from erp.lab.views import on_time
from erp.masterdata.models import Branch, Chair, WorkingHours
from erp.patients.models import Patient
from erp.staff.models import PayrollLine

ACTIVE_PAYMENTS = Prefetch("payments", queryset=Payment.objects.filter(voided_at__isnull=True))
MONEY_FIELD = DecimalField(max_digits=18, decimal_places=5)
LINE_VALUE = F("quantity") * F("unit_cost")
CENT = Decimal("0.01")


def m(value):
    return f"{Decimal(value).quantize(CENT):.2f}"


def pct(a, b):
    return round(a * 100 / b, 1) if b else None


def col(key, en, ar, kind="text"):
    return {"key": key, "en": en, "ar": ar, "type": kind}


def bilingual(obj):
    return {"ar": obj.name_ar, "en": obj.name_en} if obj is not None else {"ar": "—", "en": "—"}


def local_date(dt):
    return timezone.localtime(dt).date()


# ------------------------------------------------------------------ reports

def daily_cash(clinic, start, end, f):
    payments = Payment.objects.filter(clinic=clinic, voided_at__isnull=True, paid_on__range=(start, end))
    if f.get("branch"):
        payments = payments.filter(branch=f["branch"])
    methods = [code for code, _ in Payment.METHODS]
    days = defaultdict(lambda: {**{k: ZERO for k in methods}, "count": 0})
    for p in payments:
        d = days[p.paid_on]
        d[p.method] += p.amount
        d["count"] += 1
    labels = dict(Payment.METHODS)
    ar = {"cash": "نقدي", "instapay": "إنستاباي", "card": "بطاقة", "wallet": "محفظة", "bank": "تحويل بنكي"}
    rows = []
    for day in sorted(days):
        d = days[day]
        rows.append({"date": day.isoformat(), **{k: m(d[k]) for k in methods}, "count": d["count"], "total": m(sum((d[k] for k in methods), ZERO))})
    cols = [col("date", "Date", "التاريخ", "date"), *[col(k, str(labels[k]), ar[k], "money") for k in methods],
            col("count", "Payments", "عدد الدفعات", "number"), col("total", "Total", "الإجمالي", "money")]
    return cols, rows


def _invoice_lines(clinic, start, end, f):
    invoices = Invoice.objects.filter(clinic=clinic, status="issued", issue_date__range=(start, end)).prefetch_related("lines__procedure", "lines__dentist")
    if f.get("branch"):
        invoices = invoices.filter(branch=f["branch"])
    return list(invoices)


def revenue_by_dentist(clinic, start, end, f):
    invoices = _invoice_lines(clinic, start, end, f)
    rows = defaultdict(lambda: {"billed": ZERO, "collected": ZERO, "procedures": 0})
    names = {}
    for inv in invoices:
        for ln in inv.lines.all():
            key = ln.dentist_id or 0
            names[key] = ln.dentist
            rows[key]["billed"] += ln.total
            rows[key]["procedures"] += ln.quantity
    payments = Payment.objects.filter(clinic=clinic, voided_at__isnull=True, paid_on__range=(start, end), invoice__status="issued").select_related("invoice").prefetch_related("invoice__lines__dentist")
    if f.get("branch"):
        payments = payments.filter(branch=f["branch"])
    for p in payments:
        lines = list(p.invoice.lines.all())
        gross = sum((ln.total for ln in lines), ZERO)
        for ln in lines:
            if gross > 0:
                key = ln.dentist_id or 0
                names.setdefault(key, ln.dentist)
                rows[key]["collected"] += p.amount * ln.total / gross
    if f.get("dentist"):
        rows = {k: v for k, v in rows.items() if str(k) == str(f["dentist"])}
    out = []
    for key, r in sorted(rows.items(), key=lambda kv: -kv[1]["billed"]):
        out.append({"dentist": bilingual(names.get(key)), "procedures": r["procedures"], "billed": m(r["billed"]), "collected": m(r["collected"])})
    cols = [col("dentist", "Dentist", "الطبيب", "name"), col("procedures", "Procedures", "الإجراءات", "number"),
            col("billed", "Billed", "المفوتر", "money"), col("collected", "Collected", "المحصّل", "money")]
    return cols, out


def revenue_by_procedure(clinic, start, end, f):
    invoices = _invoice_lines(clinic, start, end, f)
    rows = {}
    for inv in invoices:
        for ln in inv.lines.all():
            if f.get("dentist") and str(ln.dentist_id) != str(f["dentist"]):
                continue
            key = ln.procedure_id or f"x:{ln.description}"
            r = rows.setdefault(key, {
                "code": ln.procedure.code if ln.procedure else "",
                "procedure": bilingual(ln.procedure) if ln.procedure else {"ar": ln.description, "en": ln.description},
                "count": 0, "billed": ZERO, "discount": ZERO,
            })
            r["count"] += ln.quantity
            r["billed"] += ln.total
            r["discount"] += ln.discount
    out = [
        {**r, "billed": m(r["billed"]), "discount": m(r["discount"]), "average": m(r["billed"] / r["count"]) if r["count"] else "0.00"}
        for r in sorted(rows.values(), key=lambda r: -r["billed"])
    ]
    cols = [col("code", "Code", "الكود"), col("procedure", "Procedure", "الإجراء", "name"), col("count", "Count", "العدد", "number"),
            col("discount", "Discounts", "الخصومات", "money"), col("average", "Average", "المتوسط", "money"), col("billed", "Billed", "المفوتر", "money")]
    return cols, out


def revenue_by_branch(clinic, start, end, f):
    rows = defaultdict(lambda: {"invoices": 0, "billed": ZERO, "collected": ZERO, "payments": 0})
    for inv in _invoice_lines(clinic, start, end, {}):
        r = rows[inv.branch_id]
        r["invoices"] += 1
        r["billed"] += inv.total
    for p in Payment.objects.filter(clinic=clinic, voided_at__isnull=True, paid_on__range=(start, end)):
        r = rows[p.branch_id]
        r["payments"] += 1
        r["collected"] += p.amount
    branches = {b.pk: b for b in Branch.objects.filter(clinic=clinic)}
    out = [
        {"branch": bilingual(branches.get(k)), "invoices": r["invoices"], "billed": m(r["billed"]), "payments": r["payments"], "collected": m(r["collected"])}
        for k, r in sorted(rows.items(), key=lambda kv: -kv[1]["billed"])
    ]
    cols = [col("branch", "Branch", "الفرع", "name"), col("invoices", "Invoices", "الفواتير", "number"), col("billed", "Billed", "المفوتر", "money"),
            col("payments", "Payments", "الدفعات", "number"), col("collected", "Collected", "المحصّل", "money")]
    return cols, out


def aging(clinic, start, end, f):
    today = timezone.localdate()
    invoices = Invoice.objects.filter(clinic=clinic, status="issued").select_related("patient").prefetch_related("lines", ACTIVE_PAYMENTS)
    if f.get("branch"):
        invoices = invoices.filter(branch=f["branch"])
    rows = {}
    for inv in invoices:
        bal = inv.balance
        if bal <= 0:
            continue
        age = (today - inv.issue_date).days
        bucket = "0_30" if age <= 30 else "31_60" if age <= 60 else "61_90" if age <= 90 else "90_plus"
        r = rows.setdefault(inv.patient_id, {
            "file_number": inv.patient.file_number, "patient": bilingual(inv.patient), "phone": inv.patient.phone,
            "0_30": ZERO, "31_60": ZERO, "61_90": ZERO, "90_plus": ZERO, "oldest": inv.issue_date,
        })
        r[bucket] += bal
        r["oldest"] = min(r["oldest"], inv.issue_date)
    out = []
    for r in sorted(rows.values(), key=lambda r: -(r["0_30"] + r["31_60"] + r["61_90"] + r["90_plus"])):
        total = r["0_30"] + r["31_60"] + r["61_90"] + r["90_plus"]
        out.append({**r, "oldest": r["oldest"].isoformat(), "total": m(total), **{k: m(r[k]) for k in ("0_30", "31_60", "61_90", "90_plus")}})
    cols = [col("file_number", "File", "الملف"), col("patient", "Patient", "المريض", "name"), col("phone", "Phone", "الهاتف", "phone"),
            col("oldest", "Oldest invoice", "أقدم فاتورة", "date"), col("0_30", "0-30 days", "٠-٣٠ يوم", "money"),
            col("31_60", "31-60 days", "٣١-٦٠ يوم", "money"), col("61_90", "61-90 days", "٦١-٩٠ يوم", "money"),
            col("90_plus", "Over 90 days", "أكثر من ٩٠ يوم", "money"), col("total", "Owed", "المستحق", "money")]
    return cols, out


SOURCE_LABELS = {
    "walk_in": ("Walk-in", "حضور مباشر"), "friend": ("Friend or family", "صديق أو قريب"), "facebook": ("Facebook", "فيسبوك"),
    "instagram": ("Instagram", "إنستجرام"), "google": ("Google", "جوجل"), "doctor": ("Referred by a doctor", "تحويل من طبيب"),
    "other": ("Other", "أخرى"), "": ("Not recorded", "غير مسجل"), "phone": ("Phone call", "مكالمة"), "whatsapp": ("WhatsApp", "واتساب"),
    "website": ("Website", "الموقع"), "referral": ("Referral", "ترشيح"),
}


def new_patients_by_source(clinic, start, end, f):
    patients = Patient.objects.filter(clinic=clinic, created_at__date__gte=start, created_at__date__lte=end)
    if f.get("branch"):
        patients = patients.filter(home_branch=f["branch"])
    lead_source = dict(Lead.objects.filter(clinic=clinic, patient__in=patients).values_list("patient", "source"))
    visited = set(Appointment.objects.filter(patient__in=patients, status="completed").values_list("patient", flat=True))
    billed = defaultdict(lambda: ZERO)
    for inv in Invoice.objects.filter(patient__in=patients, status="issued").prefetch_related("lines"):
        billed[inv.patient_id] += inv.total
    rows = defaultdict(lambda: {"patients": 0, "visited": 0, "billed": ZERO, "from_leads": 0})
    for p in patients:
        source = p.referral_source or ""
        r = rows[source]
        r["patients"] += 1
        r["visited"] += p.pk in visited
        r["billed"] += billed[p.pk]
        r["from_leads"] += p.pk in lead_source
    total = sum(r["patients"] for r in rows.values())
    out = [
        {"source": {"en": SOURCE_LABELS.get(k, (k, k))[0], "ar": SOURCE_LABELS.get(k, (k, k))[1]}, "patients": r["patients"],
         "share": pct(r["patients"], total), "from_leads": r["from_leads"], "visited": r["visited"], "billed": m(r["billed"])}
        for k, r in sorted(rows.items(), key=lambda kv: -kv[1]["patients"])
    ]
    cols = [col("source", "How they heard of us", "مصدر المعرفة", "name"), col("patients", "New patients", "مرضى جدد", "number"),
            col("share", "Share %", "النسبة ٪", "percent"), col("from_leads", "From leads", "من العملاء المحتملين", "number"),
            col("visited", "Came for a visit", "حضروا زيارة", "number"), col("billed", "Billed so far", "المفوتر حتى الآن", "money")]
    return cols, out


def appointments_report(clinic, start, end, f):
    qs = Appointment.objects.filter(clinic=clinic, start__date__gte=start, start__date__lte=end).select_related("dentist")
    if f.get("branch"):
        qs = qs.filter(branch=f["branch"])
    if f.get("dentist"):
        qs = qs.filter(dentist=f["dentist"])
    rows = defaultdict(lambda: defaultdict(int))
    names = {}
    for a in qs:
        names[a.dentist_id] = a.dentist
        r = rows[a.dentist_id]
        r["total"] += 1
        r[a.status] += 1
    out = []
    for k, r in sorted(rows.items(), key=lambda kv: -kv[1]["total"]):
        upcoming = r["booked"] + r["confirmed"] + r["arrived"] + r["in_chair"]
        out.append({
            "dentist": bilingual(names[k]), "total": r["total"], "completed": r["completed"], "upcoming": upcoming,
            "cancelled": r["cancelled"], "no_show": r["no_show"], "no_show_rate": pct(r["no_show"], r["completed"] + r["no_show"]),
        })
    cols = [col("dentist", "Dentist", "الطبيب", "name"), col("total", "Booked", "المحجوز", "number"), col("completed", "Completed", "تمت", "number"),
            col("upcoming", "Still to come", "قادمة", "number"), col("cancelled", "Cancelled", "ملغاة", "number"),
            col("no_show", "No-shows", "لم يحضر", "number"), col("no_show_rate", "No-show rate %", "نسبة الغياب ٪", "percent")]
    return cols, out


def plan_acceptance(clinic, start, end, f):
    plans = TreatmentPlan.objects.filter(clinic=clinic, created_at__date__gte=start, created_at__date__lte=end).select_related("dentist").prefetch_related("lines")
    if f.get("dentist"):
        plans = plans.filter(dentist=f["dentist"])
    rows = defaultdict(lambda: {"plans": 0, "accepted": 0, "proposed": 0, "cancelled": 0, "value": ZERO, "accepted_value": ZERO})
    names = {}
    for plan in plans:
        names[plan.dentist_id] = plan.dentist
        r = rows[plan.dentist_id]
        value = sum((ln.net for ln in plan.lines.all() if ln.status != "cancelled"), ZERO)
        r["plans"] += 1
        r["value"] += value
        if plan.status in ("accepted", "in_progress", "completed"):
            r["accepted"] += 1
            r["accepted_value"] += value
        elif plan.status == "proposed":
            r["proposed"] += 1
        else:
            r["cancelled"] += 1
    out = [
        {"dentist": bilingual(names[k]), "plans": r["plans"], "accepted": r["accepted"], "proposed": r["proposed"], "cancelled": r["cancelled"],
         "rate": pct(r["accepted"], r["plans"]), "value": m(r["value"]), "accepted_value": m(r["accepted_value"])}
        for k, r in sorted(rows.items(), key=lambda kv: -kv[1]["plans"])
    ]
    cols = [col("dentist", "Dentist", "الطبيب", "name"), col("plans", "Plans", "الخطط", "number"), col("accepted", "Accepted", "مقبولة", "number"),
            col("proposed", "Waiting", "بانتظار الرد", "number"), col("cancelled", "Declined", "مرفوضة", "number"),
            col("rate", "Acceptance %", "نسبة القبول ٪", "percent"), col("value", "Value proposed", "قيمة المقترح", "money"),
            col("accepted_value", "Value accepted", "قيمة المقبول", "money")]
    return cols, out


def _lab_days(case):
    ready = next((e.created_at for e in case.events.all() if e.stage in ("ready", "delivered")), None)
    return (local_date(ready) - local_date(case.created_at)).days if ready else None


def lab_turnaround(clinic, start, end, f):
    cases = LabCase.objects.filter(clinic=clinic).prefetch_related("events")
    labels = dict(LabCase.RESTORATIONS)
    ar = {"crown": "تاج", "bridge": "جسر", "veneer": "قشرة", "inlay_onlay": "حشوة ترصيع", "implant_crown": "تاج على زرعة",
          "post_core": "وتد ودعامة", "denture_full": "طقم كامل", "denture_partial": "طقم جزئي", "night_guard": "واقي ليلي",
          "temporary": "مؤقت", "other": "أخرى"}
    rows = defaultdict(lambda: {"created": 0, "delivered": 0, "units": 0, "days": [], "remakes": 0, "cases": []})
    for c in cases:
        r = rows[c.restoration]
        if start <= local_date(c.created_at) <= end:
            r["created"] += 1
            r["remakes"] += bool(c.remake_of_id)
        if c.delivered_at and start <= local_date(c.delivered_at) <= end:
            r["delivered"] += 1
            r["units"] += c.units
            r["cases"].append(c)
            d = _lab_days(c)
            if d is not None:
                r["days"].append(d)
    out = [
        {"restoration": {"en": str(labels.get(k, k)), "ar": ar.get(k, str(labels.get(k, k)))}, "created": r["created"], "delivered": r["delivered"],
         "units": r["units"], "avg_days": round(sum(r["days"]) / len(r["days"]), 1) if r["days"] else None,
         "on_time": on_time(r["cases"]), "remakes": r["remakes"]}
        for k, r in sorted(rows.items(), key=lambda kv: -kv[1]["delivered"]) if r["created"] or r["delivered"]
    ]
    cols = [col("restoration", "Work", "نوع العمل", "name"), col("created", "Ordered", "طُلبت", "number"), col("delivered", "Delivered", "سُلّمت", "number"),
            col("units", "Units", "الوحدات", "number"), col("avg_days", "Average days", "متوسط الأيام", "number"),
            col("on_time", "On time %", "في الموعد ٪", "percent"), col("remakes", "Remakes", "إعادات", "number")]
    return cols, out


def stock_report(clinic, start, end, f):
    moves = StockMovement.objects.filter(clinic=clinic, created_at__date__gte=start, created_at__date__lte=end)
    lots = StockLot.objects.filter(clinic=clinic, quantity__gt=0)
    if f.get("branch"):
        moves, lots = moves.filter(branch=f["branch"]), lots.filter(branch=f["branch"])
    rows = defaultdict(lambda: {"received": ZERO, "used": ZERO, "wasted": ZERO, "other": ZERO, "on_hand": ZERO, "value": ZERO})
    for r in moves.values("item", "kind").annotate(q=Sum("quantity")):
        key = {"receive": "received", "use": "used", "waste": "wasted"}.get(r["kind"], "other")
        rows[r["item"]][key] += r["q"]
    for r in lots.values("item").annotate(q=Sum("quantity"), v=Sum(LINE_VALUE, output_field=MONEY_FIELD)):
        rows[r["item"]]["on_hand"] += r["q"]
        rows[r["item"]]["value"] += r["v"]
    items = {i.pk: i for i in StockItem.objects.filter(clinic=clinic, pk__in=list(rows))}

    def q(v):
        v = Decimal(v).normalize()
        return f"{v:f}"
    out = [
        {"code": items[k].code, "item": bilingual(items[k]), "unit": items[k].unit, "received": q(r["received"]), "used": q(-r["used"]),
         "wasted": q(-r["wasted"]), "adjusted": q(r["other"]), "on_hand": q(r["on_hand"]), "value": m(r["value"])}
        for k, r in sorted(rows.items(), key=lambda kv: -kv[1]["value"]) if k in items
    ]
    cols = [col("code", "Code", "الكود"), col("item", "Item", "الصنف", "name"), col("unit", "Unit", "الوحدة"),
            col("received", "Received", "وارد", "number"), col("used", "Used", "مستخدم", "number"), col("wasted", "Wasted", "هالك", "number"),
            col("adjusted", "Adjusted / moved", "تسويات وتحويلات", "number"), col("on_hand", "On hand", "الرصيد", "number"),
            col("value", "Stock value", "قيمة المخزون", "money")]
    return cols, out


def payroll_summary(clinic, start, end, f):
    first = start.replace(day=1)
    lines = PayrollLine.objects.filter(run__clinic=clinic, run__period__gte=first, run__period__lte=end).select_related("run", "staff")
    if f.get("branch"):
        lines = lines.filter(run__branch=f["branch"])
    rows = defaultdict(lambda: {"people": set(), "gross": ZERO, "deductions": ZERO, "net": ZERO, "employer": ZERO, "commission": ZERO, "status": set()})
    for ln in lines:
        r = rows[ln.run.period]
        r["people"].add(ln.staff_id)
        r["gross"] += ln.gross
        r["deductions"] += ln.total_deductions
        r["net"] += ln.net
        r["employer"] += ln.employer_insurance
        r["commission"] += ln.commission
        r["status"].add(ln.run.status)
    status_ar = {"paid": "مدفوع", "approved": "معتمد", "draft": "مسودة"}
    out = []
    for period, r in sorted(rows.items()):
        st = "paid" if r["status"] == {"paid"} else "approved" if r["status"] <= {"approved", "paid"} else "draft"
        out.append({"month": period.isoformat(), "people": len(r["people"]), "commission": m(r["commission"]), "gross": m(r["gross"]),
                    "deductions": m(r["deductions"]), "net": m(r["net"]), "employer": m(r["employer"]), "cost": m(r["gross"] + r["employer"]),
                    "status": {"en": st.capitalize(), "ar": status_ar[st]}})
    cols = [col("month", "Month", "الشهر", "month"), col("people", "People", "الأفراد", "number"), col("commission", "Commission", "العمولة", "money"),
            col("gross", "Gross", "الإجمالي", "money"), col("deductions", "Deductions", "الاستقطاعات", "money"), col("net", "Net pay", "الصافي", "money"),
            col("employer", "Employer insurance", "تأمينات صاحب العمل", "money"), col("cost", "Cost to clinic", "التكلفة على العيادة", "money"),
            col("status", "Status", "الحالة", "name")]
    return cols, out


STAGE_AR = {"new": "جديد", "contacted": "تم التواصل", "consultation": "حجز استشارة", "accepted": "قبل العلاج", "won": "تم الكسب", "lost": "مفقود"}


def lead_funnel(clinic, start, end, f):
    leads = Lead.objects.filter(clinic=clinic, created_at__date__gte=start, created_at__date__lte=end)
    order = [s for s, _ in Lead.STAGES][:5]
    rows = defaultdict(lambda: {**{s: 0 for s in order}, "lost": 0, "leads": 0, "value": ZERO})
    for x in leads:
        r = rows[x.source]
        r["leads"] += 1
        if x.stage == "lost":
            r["lost"] += 1
        else:
            for s in order[: order.index(x.stage) + 1]:
                r[s] += 1
        if x.stage == "won":
            r["value"] += x.estimated_value
    out = [
        {"source": {"en": SOURCE_LABELS.get(k, (k, k))[0], "ar": SOURCE_LABELS.get(k, (k, k))[1]}, "leads": r["leads"], "contacted": r["contacted"],
         "consultation": r["consultation"], "accepted": r["accepted"], "won": r["won"], "lost": r["lost"],
         "conversion": pct(r["won"], r["leads"]), "value": m(r["value"])}
        for k, r in sorted(rows.items(), key=lambda kv: -kv[1]["leads"])
    ]
    cols = [col("source", "Source", "المصدر", "name"), col("leads", "Leads", "العملاء المحتملون", "number"),
            col("contacted", "Contacted", "تم التواصل", "number"), col("consultation", "Consultation", "استشارة", "number"),
            col("accepted", "Accepted", "قبلوا العلاج", "number"), col("won", "Won", "تم الكسب", "number"), col("lost", "Lost", "مفقودون", "number"),
            col("conversion", "Conversion %", "نسبة التحويل ٪", "percent"), col("value", "Won value", "قيمة المكسوب", "money")]
    return cols, out


def recall_report(clinic, start, end, f):
    data = crm.recall_compliance(clinic, start, min(end, timezone.localdate()))
    out = [
        {"rule": {"en": r["rule"].name_en, "ar": r["rule"].name_ar}, "months": r["rule"].interval_months, "due": r["due"],
         "returned": r["returned"], "missed": r["due"] - r["returned"], "rate": pct(r["returned"], r["due"])}
        for r in data["by_rule"]
    ]
    cols = [col("rule", "Recall", "الاستدعاء", "name"), col("months", "Every (months)", "كل (شهور)", "number"), col("due", "Fell due", "استحقت", "number"),
            col("returned", "Came back", "عادوا", "number"), col("missed", "Not yet back", "لم يعودوا", "number"),
            col("rate", "Compliance %", "نسبة الالتزام ٪", "percent")]
    return cols, out


def campaign_report(clinic, start, end, f):
    out = []
    for c in Campaign.objects.filter(clinic=clinic, status="sent", sent_at__date__gte=start, sent_at__date__lte=end).order_by("-sent_at"):
        r = crm.campaign_results(c)
        out.append({
            "name": c.name, "sent_at": local_date(c.sent_at).isoformat(), "channel": {"en": c.get_channel_display(), "ar": "واتساب" if c.channel == "whatsapp" else "رسالة نصية"},
            "audience": r["audience"], "sent": r["sent"], "failed": r["failed"], "responded": r["responded"], "booked": r["booked"],
            "revenue": r["revenue"], "cost": m(c.cost), "roi": r["roi"],
        })
    cols = [col("name", "Campaign", "الحملة"), col("sent_at", "Sent", "تاريخ الإرسال", "date"), col("channel", "Channel", "القناة", "name"),
            col("audience", "Audience", "الجمهور", "number"), col("sent", "Sent", "أُرسلت", "number"), col("failed", "Failed", "فشلت", "number"),
            col("responded", "Responded", "ردّوا", "number"), col("booked", "Booked", "حجزوا", "number"),
            col("revenue", "Revenue (30 days)", "الإيراد (٣٠ يوم)", "money"), col("cost", "Cost", "التكلفة", "money"), col("roi", "ROI %", "العائد ٪", "percent")]
    return cols, out


# key -> (function, needed rights, filters it accepts, has a period)
REPORTS = {
    "daily_cash": (daily_cash, [("billing", "view")], ["branch"], True),
    "revenue_dentist": (revenue_by_dentist, [("billing", "view")], ["branch", "dentist"], True),
    "revenue_procedure": (revenue_by_procedure, [("billing", "view")], ["branch", "dentist"], True),
    "revenue_branch": (revenue_by_branch, [("billing", "view")], [], True),
    "aging": (aging, [("billing", "view")], ["branch"], False),
    "new_patients": (new_patients_by_source, [("patients", "view")], ["branch"], True),
    "appointments": (appointments_report, [("appointments", "view")], ["branch", "dentist"], True),
    "plan_acceptance": (plan_acceptance, [("clinical", "view")], ["dentist"], True),
    "lab_turnaround": (lab_turnaround, [("lab", "view")], [], True),
    "stock": (stock_report, [("inventory", "approve")], ["branch"], True),
    "payroll": (payroll_summary, [("staff", "view")], ["branch"], True),
    "lead_funnel": (lead_funnel, [("crm", "view")], [], True),
    "recall_compliance": (recall_report, [("crm", "view")], [], True),
    "campaigns": (campaign_report, [("crm", "view")], [], True),
}


def allowed(user, key):
    return user.has_module_perm("reports", "view") and all(user.has_module_perm(mod, act) for mod, act in REPORTS[key][1])


# ----------------------------------------------------------------- overview

def chair_utilisation(clinic, start, end):
    """Booked chair time over open chair time, on days the branch was open."""
    end = min(end, timezone.localdate())
    if end < start:
        return None
    hours = defaultdict(dict)
    for wh in WorkingHours.objects.filter(clinic=clinic):
        if not wh.is_closed and wh.opens_at and wh.closes_at:
            hours[wh.branch_id][wh.weekday] = (datetime.combine(start, wh.closes_at) - datetime.combine(start, wh.opens_at)).seconds // 60
    chairs = defaultdict(int)
    for branch_id in Chair.objects.filter(clinic=clinic, is_active=True).values_list("branch", flat=True):
        chairs[branch_id] += 1
    available = 0
    day = start
    while day <= end:
        for branch_id, n in chairs.items():
            available += hours[branch_id].get(day.weekday(), 0) * n
        day += timedelta(days=1)
    used = Appointment.objects.filter(
        clinic=clinic, chair__isnull=False, start__date__gte=start, start__date__lte=end
    ).exclude(status__in=("cancelled", "no_show")).aggregate(n=Sum("duration_minutes"))["n"] or 0
    return pct(used, available)


def kpis(user, clinic, start, end):
    can = user.has_module_perm
    out = {}
    if can("billing", "view"):
        billed = sum((i.total for i in Invoice.objects.filter(clinic=clinic, status="issued", issue_date__range=(start, end)).prefetch_related("lines")), ZERO)
        collected = Payment.objects.filter(clinic=clinic, voided_at__isnull=True, paid_on__range=(start, end)).aggregate(s=Sum("amount"))["s"] or ZERO
        out["revenue"] = m(billed)
        out["collections"] = m(collected)
    if can("patients", "view"):
        out["new_patients"] = Patient.objects.filter(clinic=clinic, created_at__date__gte=start, created_at__date__lte=end).count()
    if can("appointments", "view"):
        appts = Appointment.objects.filter(clinic=clinic, start__date__gte=start, start__date__lte=end)
        done = appts.filter(status="completed").count()
        missed = appts.filter(status="no_show").count()
        out["visits"] = done
        out["no_show_rate"] = pct(missed, done + missed)
        out["chair_utilisation"] = chair_utilisation(clinic, start, end)
    if can("lab", "view"):
        delivered = [c for c in LabCase.objects.filter(clinic=clinic, delivered_at__isnull=False).prefetch_related("events")
                     if start <= local_date(c.delivered_at) <= end]
        days = [d for d in (_lab_days(c) for c in delivered) if d is not None]
        out["lab_turnaround"] = round(sum(days) / len(days), 1) if days else None
        out["lab_delivered"] = len(delivered)
    if can("inventory", "approve"):
        out["inventory_value"] = m(StockLot.objects.filter(clinic=clinic, quantity__gt=0).aggregate(v=Sum(LINE_VALUE, output_field=MONEY_FIELD))["v"] or ZERO)
    if can("staff", "view"):
        cost = ZERO
        for ln in PayrollLine.objects.filter(run__clinic=clinic, run__period__gte=start.replace(day=1), run__period__lte=end):
            cost += ln.gross + ln.employer_insurance
        out["payroll_cost"] = m(cost)
    if can("crm", "view"):
        funnel = crm.lead_funnel(clinic, start, end)
        out["leads"] = funnel["leads"]
        out["lead_conversion"] = funnel["conversion"]
        out["recall_compliance"] = crm.recall_compliance(clinic, start, min(end, timezone.localdate()))["rate"]
        revenue = cost = ZERO
        for c in Campaign.objects.filter(clinic=clinic, status="sent", sent_at__date__gte=start, sent_at__date__lte=end):
            revenue += Decimal(crm.campaign_results(c)["revenue"])
            cost += c.cost
        out["campaign_revenue"] = m(revenue)
        out["campaign_roi"] = round(float((revenue - cost) / cost * 100), 1) if cost > 0 else None
        out["nps"] = crm.feedback_summary(clinic, start, end)["nps"]
    return out


def trend(user, clinic, start, end):
    """Billed and collected (or visits) per day, week or month of the period."""
    span = (end - start).days + 1
    if span <= 45:
        def bucket(d):
            return d
    elif span <= 190:
        def bucket(d):
            return d - timedelta(days=d.weekday())
    else:
        def bucket(d):
            return d.replace(day=1)
    points = {}
    cursor = start
    while cursor <= end:
        points.setdefault(bucket(cursor), {"billed": ZERO, "collected": ZERO, "visits": 0, "new_patients": 0})
        cursor += timedelta(days=1)
    if user.has_module_perm("billing", "view"):
        for inv in Invoice.objects.filter(clinic=clinic, status="issued", issue_date__range=(start, end)).prefetch_related("lines"):
            points[bucket(inv.issue_date)]["billed"] += inv.total
        for paid_on, amount in Payment.objects.filter(clinic=clinic, voided_at__isnull=True, paid_on__range=(start, end)).values_list("paid_on", "amount"):
            points[bucket(paid_on)]["collected"] += amount
    if user.has_module_perm("appointments", "view"):
        for s in Appointment.objects.filter(clinic=clinic, status="completed", start__date__gte=start, start__date__lte=end).values_list("start", flat=True):
            points[bucket(local_date(s))]["visits"] += 1
    if user.has_module_perm("patients", "view"):
        for s in Patient.objects.filter(clinic=clinic, created_at__date__gte=start, created_at__date__lte=end).values_list("created_at", flat=True):
            points[bucket(local_date(s))]["new_patients"] += 1
    return {
        "bucket": "day" if span <= 45 else "week" if span <= 190 else "month",
        "points": [{"period": k.isoformat(), "billed": m(v["billed"]), "collected": m(v["collected"]), "visits": v["visits"], "new_patients": v["new_patients"]}
                   for k, v in sorted(points.items())],
    }


def breakdowns(user, clinic, start, end):
    out = {}
    if user.has_module_perm("billing", "view"):
        _, rows = revenue_by_dentist(clinic, start, end, {})
        out["by_dentist"] = rows[:8]
        _, rows = revenue_by_procedure(clinic, start, end, {})
        out["by_procedure"] = rows[:8]
    if user.has_module_perm("patients", "view"):
        _, rows = new_patients_by_source(clinic, start, end, {})
        out["by_source"] = rows
    if user.has_module_perm("crm", "view"):
        out["funnel"] = crm.lead_funnel(clinic, start, end)["stages"]
    return out

