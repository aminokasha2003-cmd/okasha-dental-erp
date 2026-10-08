"""A starter procedure catalog a new clinic can load and then edit.

Prices are left at 0 on purpose: each clinic sets its own.
(code, English, Arabic, minutes, needs lab)
"""

from django.db import transaction

from .models import Procedure, ProcedureCategory

STARTER_CATALOG = [
    ("Diagnosis", "التشخيص", [
        ("DX01", "Examination and consultation", "كشف واستشارة", 20, False),
        ("DX02", "Periapical X-ray", "أشعة صغيرة (بيري أبيكال)", 10, False),
        ("DX03", "Panoramic X-ray (OPG)", "أشعة بانوراما", 15, False),
        ("DX04", "CBCT scan", "أشعة مقطعية (CBCT)", 20, False),
    ]),
    ("Preventive", "الوقاية", [
        ("PV01", "Scaling and polishing", "تنظيف الجير وتلميع", 45, False),
        ("PV02", "Fluoride application", "تطبيق الفلورايد", 15, False),
        ("PV03", "Fissure sealant (per tooth)", "سد الشقوق (للسن)", 20, False),
    ]),
    ("Restorative", "الحشوات", [
        ("RS01", "Composite filling, one surface", "حشو تجميلي، سطح واحد", 30, False),
        ("RS02", "Composite filling, two surfaces", "حشو تجميلي، سطحان", 40, False),
        ("RS03", "Composite filling, three or more surfaces", "حشو تجميلي، ثلاثة أسطح أو أكثر", 50, False),
        ("RS04", "Glass ionomer filling", "حشو أيونومر زجاجي", 30, False),
        ("RS05", "Temporary filling", "حشو مؤقت", 15, False),
    ]),
    ("Endodontics", "علاج الجذور", [
        ("EN01", "Root canal treatment, anterior tooth", "علاج عصب، سن أمامي", 60, False),
        ("EN02", "Root canal treatment, premolar", "علاج عصب، ضاحك", 75, False),
        ("EN03", "Root canal treatment, molar", "علاج عصب، ضرس", 90, False),
        ("EN04", "Root canal retreatment", "إعادة علاج عصب", 90, False),
        ("EN05", "Pulpotomy (child)", "بتر لب (أطفال)", 30, False),
    ]),
    ("Periodontics", "علاج اللثة", [
        ("PE01", "Deep scaling and root planing (per quadrant)", "تنظيف عميق وكحت الجذور (للربع)", 45, False),
        ("PE02", "Gingivectomy", "قص اللثة", 45, False),
    ]),
    ("Prosthodontics", "التركيبات", [
        ("PR01", "Zirconia crown", "تاج زيركونيا", 60, True),
        ("PR02", "Porcelain-fused-to-metal crown", "تاج بورسلين على معدن", 60, True),
        ("PR03", "E.max crown", "تاج إي ماكس", 60, True),
        ("PR04", "Bridge unit", "وحدة جسر", 45, True),
        ("PR05", "Post and core", "وتد ودعامة", 45, False),
        ("PR06", "Complete denture (per arch)", "طقم كامل (للفك)", 45, True),
        ("PR07", "Partial denture", "طقم جزئي", 45, True),
        ("PR08", "Temporary crown", "تاج مؤقت", 30, True),
    ]),
    ("Oral surgery", "جراحة الفم", [
        ("OS01", "Simple extraction", "خلع بسيط", 30, False),
        ("OS02", "Surgical extraction", "خلع جراحي", 45, False),
        ("OS03", "Wisdom tooth extraction", "خلع ضرس العقل", 60, False),
    ]),
    ("Implants", "زراعة الأسنان", [
        ("IM01", "Implant fixture placement", "زرع غرسة", 90, False),
        ("IM02", "Crown on implant", "تاج على الزرعة", 45, True),
        ("IM03", "Bone graft", "تطعيم عظم", 60, False),
        ("IM04", "Sinus lift", "رفع الجيب الأنفي", 90, False),
    ]),
    ("Orthodontics", "تقويم الأسنان", [
        ("OR01", "Orthodontic consultation and records", "استشارة تقويم وسجلات", 45, False),
        ("OR02", "Fixed braces, full case", "تقويم ثابت، حالة كاملة", 90, False),
        ("OR03", "Orthodontic adjustment visit", "زيارة متابعة تقويم", 20, False),
        ("OR04", "Clear aligners, full case", "تقويم شفاف، حالة كاملة", 45, True),
        ("OR05", "Retainer", "مثبت", 20, True),
    ]),
    ("Cosmetic", "التجميل", [
        ("CO01", "In-office whitening", "تبييض في العيادة", 60, False),
        ("CO02", "Veneer (per tooth)", "قشرة (للسن)", 60, True),
    ]),
]


@transaction.atomic
def load_starter_catalog(clinic):
    """Add any starter categories and procedures the clinic does not have yet."""
    created = 0
    for order, (cat_en, cat_ar, procedures) in enumerate(STARTER_CATALOG, start=1):
        category, _ = ProcedureCategory.objects.get_or_create(
            clinic=clinic, name_en=cat_en, defaults={"name_ar": cat_ar, "sort_order": order}
        )
        for code, name_en, name_ar, minutes, needs_lab in procedures:
            _, was_created = Procedure.objects.get_or_create(
                clinic=clinic,
                code=code,
                defaults={
                    "name_en": name_en,
                    "name_ar": name_ar,
                    "category": category,
                    "default_duration_minutes": minutes,
                    "needs_lab": needs_lab,
                },
            )
            created += was_created
    return created
