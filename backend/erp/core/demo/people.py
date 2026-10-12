"""Names, staff and fixed lists for the demo clinic."""

from datetime import date
from decimal import Decimal

DEMO_PASSWORD = "Demo-pass-2026"
OWNER_USERNAME = "amin"

# Extra roles the demo adds next to the six built-in ones.
DEMO_ROLES = {
    "lab_manager": (
        "Lab manager",
        "مدير المعمل",
        {
            "masterdata": ["view"],
            "files": ["view", "create", "edit"],
            "patients": ["view"],
            "lab": ["view", "create", "edit", "delete", "approve"],
            "inventory": ["view", "create", "edit", "approve"],
            "reports": ["view"],
        },
    ),
    "store_keeper": (
        "Store keeper",
        "أمين المخزن",
        {
            "masterdata": ["view"],
            "inventory": ["view", "create", "edit", "approve"],
        },
    ),
}

# Weekdays: Monday 0 ... Sunday 6. Friday (4) is the clinic's day off.
SAT, SUN, MON, TUE, WED, THU = 5, 6, 0, 1, 2, 3

# username, first, last, English name, Arabic name, roles, staff type, branches,
# colour, (commission rule, value), pay profile, week {weekday: (shift, branch)}
STAFF = [
    dict(
        username="karim", first="Karim", last="Mansour", en="Dr. Karim Mansour", ar="د. كريم منصور",
        roles=["dentist"], kind="dentist", branches=["nasr"], color="#7aa7e0", commission=("percent_collected", 30),
        pay=dict(pay_type="monthly", base_salary=Decimal("12000"), insured=True, insurable_wage=Decimal("6000"),
                 payout_method="bank", payout_account="CIB 1002-3344-5566", hire_date=date(2019, 3, 1)),
        week={SAT: ("evening", "nasr"), SUN: ("evening", "nasr"), MON: ("evening", "nasr"),
              WED: ("evening", "nasr"), THU: ("evening", "nasr")},
        phone="+201001234501",
    ),
    dict(
        username="salma", first="Salma", last="Fathy", en="Dr. Salma Fathy", ar="د. سلمى فتحي",
        roles=["dentist"], kind="dentist", branches=["nasr", "helio"], color="#e6a0c4", commission=("percent_collected", 25),
        pay=dict(pay_type="monthly", base_salary=Decimal("9000"), payout_method="instapay",
                 payout_account="salma.fathy@instapay", hire_date=date(2021, 9, 15)),
        week={SAT: ("morning", "helio"), MON: ("morning", "helio"), WED: ("morning", "helio"),
              SUN: ("morning", "nasr"), TUE: ("morning", "nasr")},
        phone="+201112345602",
    ),
    dict(
        username="youssef", first="Youssef", last="Hamdy", en="Dr. Youssef Hamdy", ar="د. يوسف حمدي",
        roles=["dentist"], kind="dentist", branches=["helio"], color="#8fcfa8", commission=("fixed_per_procedure", 150),
        pay=dict(pay_type="commission_only", payout_method="bank", payout_account="NBE 2233-4455", hire_date=date(2022, 1, 10)),
        week={SUN: ("evening", "helio"), MON: ("evening", "helio"), TUE: ("evening", "helio"),
              WED: ("evening", "helio"), THU: ("evening", "helio")},
        phone="+201223456703",
    ),
    dict(
        username="mariam", first="Mariam", last="Adel", en="Mariam Adel", ar="مريم عادل",
        roles=["receptionist"], kind="reception", branches=["nasr"], color="#f6c886", commission=None,
        pay=dict(pay_type="monthly", base_salary=Decimal("6500"), insured=True, insurable_wage=Decimal("4000"),
                 payout_method="wallet", payout_account="01012345678", hire_date=date(2023, 2, 1)),
        week={SAT: ("evening", "nasr"), SUN: ("evening", "nasr"), MON: ("evening", "nasr"),
              TUE: ("evening", "nasr"), WED: ("evening", "nasr")},
        phone="+201012345678",
    ),
    dict(
        username="hana", first="Hana", last="Mostafa", en="Hana Mostafa", ar="هنا مصطفى",
        roles=["receptionist"], kind="reception", branches=["helio"], color="#9fd3bf", commission=None,
        pay=dict(pay_type="daily", daily_rate=Decimal("300"), payout_method="wallet", payout_account="01198765432",
                 hire_date=date(2025, 6, 1)),
        week={SUN: ("evening", "helio"), MON: ("evening", "helio"), TUE: ("evening", "helio"),
              WED: ("evening", "helio"), THU: ("evening", "helio")},
        phone="+201198765432",
    ),
    dict(
        username="aya", first="Aya", last="Ibrahim", en="Aya Ibrahim", ar="آية إبراهيم",
        roles=["assistant"], kind="assistant", branches=["nasr"], color="#d7c3f0", commission=None,
        pay=dict(pay_type="monthly", base_salary=Decimal("5000"), payout_method="cash", hire_date=date(2024, 2, 1)),
        week={SAT: ("evening", "nasr"), SUN: ("evening", "nasr"), MON: ("evening", "nasr"),
              WED: ("evening", "nasr"), THU: ("evening", "nasr")},
        phone="+201551234509",
    ),
    dict(
        username="omar", first="Omar", last="Khaled", en="Omar Khaled", ar="عمر خالد",
        roles=["assistant"], kind="assistant", branches=["helio"], color="#c9b18f", commission=None,
        pay=dict(pay_type="hourly", hourly_rate=Decimal("45"), payout_method="cash", hire_date=None),
        week={SAT: ("morning", "helio"), MON: ("morning", "helio"), WED: ("morning", "helio"),
              SUN: ("evening", "helio"), TUE: ("evening", "helio")},
        phone="+201067891234",
    ),
    dict(
        username="ahmed", first="Ahmed", last="Samy", en="Ahmed Samy", ar="أحمد سامي",
        roles=["accountant"], kind="accountant", branches=["nasr", "helio"], color="#a0b8c8", commission=None,
        pay=dict(pay_type="monthly", base_salary=Decimal("9000"), insured=True, insurable_wage=Decimal("5500"),
                 payout_method="bank", payout_account="QNB 7788-9900", hire_date=date(2020, 11, 1)),
        week={SUN: ("morning", "nasr"), MON: ("morning", "nasr"), TUE: ("morning", "nasr"),
              WED: ("morning", "nasr"), THU: ("morning", "nasr")},
        phone="+201004567812",
    ),
    dict(
        username="hesham", first="Hesham", last="Lotfy", en="Hesham Lotfy", ar="هشام لطفي",
        roles=["lab_manager", "lab_technician"], kind="technician", branches=["nasr"], color="#f2b4a8", commission=None,
        pay=dict(pay_type="monthly", base_salary=Decimal("11000"), insured=True, insurable_wage=Decimal("6000"),
                 payout_method="bank", payout_account="CIB 5566-7788", hire_date=date(2018, 5, 1)),
        week={SAT: ("lab", "nasr"), SUN: ("lab", "nasr"), MON: ("lab", "nasr"), TUE: ("lab", "nasr"), WED: ("lab", "nasr")},
        phone="+201223344556",
    ),
    dict(
        username="tarek", first="Tarek", last="Gamal", en="Tarek Gamal", ar="طارق جمال",
        roles=["lab_technician"], kind="technician", branches=["nasr"], color="#b9c8f5", commission=None,
        pay=dict(pay_type="monthly", base_salary=Decimal("8000"), payout_method="instapay",
                 payout_account="tarek.gamal@instapay", hire_date=date(2022, 8, 1)),
        week={SUN: ("lab", "nasr"), MON: ("lab", "nasr"), TUE: ("lab", "nasr"), WED: ("lab", "nasr"), THU: ("lab", "nasr")},
        phone="+201156677889",
    ),
    dict(
        username="mostafa", first="Mostafa", last="Ragab", en="Mostafa Ragab", ar="مصطفى رجب",
        roles=["lab_technician"], kind="technician", branches=["nasr"], color="#e8d38a", commission=None,
        pay=dict(pay_type="hourly", hourly_rate=Decimal("60"), payout_method="cash", hire_date=date(2024, 10, 1)),
        week={SAT: ("lab", "nasr"), MON: ("lab", "nasr"), WED: ("lab", "nasr")},
        phone="+201509988776",
    ),
    dict(
        username="sherif", first="Sherif", last="Nabil", en="Sherif Nabil", ar="شريف نبيل",
        roles=["store_keeper"], kind="other", branches=["nasr", "helio"], color="#b5d99c", commission=None,
        pay=dict(pay_type="monthly", base_salary=Decimal("6000"), payout_method="cash", hire_date=date(2023, 7, 1)),
        week={SAT: ("morning", "nasr"), SUN: ("morning", "nasr"), MON: ("morning", "helio"),
              TUE: ("morning", "nasr"), WED: ("morning", "helio")},
        phone="+201277665544",
    ),
]

# Who sees what, for the README and the demo script.
LOGIN_NOTES = {
    "amin": "Owner: everything",
    "karim": "Dentist (Nasr City): patients, calendar, charts, plans, lab orders",
    "salma": "Dentist (both branches)",
    "youssef": "Dentist, implants (Heliopolis)",
    "mariam": "Receptionist (Nasr City): patients, appointments, billing, cashbox",
    "hana": "Receptionist (Heliopolis)",
    "aya": "Dental assistant: schedule, charts (read only), stock use",
    "omar": "Dental assistant (Heliopolis)",
    "ahmed": "Accountant: billing, finance dashboard, payroll, inventory reports",
    "hesham": "Lab manager: lab board, costs, lab dashboard, lab stock",
    "tarek": "Lab technician: lab board (on sick leave today)",
    "mostafa": "Lab technician (part time, paid by the hour)",
    "sherif": "Store keeper: stock, suppliers, purchase orders",
}

MALE = [
    ("Ahmed", "أحمد"), ("Mohamed", "محمد"), ("Mahmoud", "محمود"), ("Mostafa", "مصطفى"), ("Hassan", "حسن"),
    ("Ali", "علي"), ("Omar", "عمر"), ("Khaled", "خالد"), ("Amr", "عمرو"), ("Tamer", "تامر"), ("Sameh", "سامح"),
    ("Hany", "هاني"), ("Walid", "وليد"), ("Ibrahim", "إبراهيم"), ("Youssef", "يوسف"), ("Karim", "كريم"),
    ("Sherif", "شريف"), ("Ayman", "أيمن"), ("Islam", "إسلام"), ("Ziad", "زياد"), ("Adham", "أدهم"),
    ("Seif", "سيف"), ("Hazem", "حازم"), ("Essam", "عصام"), ("Magdy", "مجدي"), ("Ramy", "رامي"), ("Bassem", "باسم"),
]
FEMALE = [
    ("Fatma", "فاطمة"), ("Mona", "منى"), ("Nour", "نور"), ("Sara", "سارة"), ("Heba", "هبة"), ("Dina", "دينا"),
    ("Rania", "رانيا"), ("Yasmin", "ياسمين"), ("Mai", "مي"), ("Nada", "ندى"), ("Salma", "سلمى"), ("Aya", "آية"),
    ("Eman", "إيمان"), ("Marwa", "مروة"), ("Shaimaa", "شيماء"), ("Doaa", "دعاء"), ("Laila", "ليلى"),
    ("Hagar", "هاجر"), ("Malak", "ملك"), ("Farida", "فريدة"), ("Nesma", "نسمة"), ("Reem", "ريم"),
    ("Asmaa", "أسماء"), ("Amira", "أميرة"), ("Ghada", "غادة"), ("Samar", "سمر"), ("Hoda", "هدى"),
]
FAMILY = [
    ("El-Sayed", "السيد"), ("Abdel Rahman", "عبد الرحمن"), ("Hassan", "حسن"), ("Mahmoud", "محمود"),
    ("Farouk", "فاروق"), ("Soliman", "سليمان"), ("Shawky", "شوقي"), ("Ramadan", "رمضان"), ("Abdallah", "عبد الله"),
    ("Hegazy", "حجازي"), ("Mansour", "منصور"), ("Saleh", "صالح"), ("Gaber", "جابر"), ("Fawzy", "فوزي"),
    ("Naguib", "نجيب"), ("Kamel", "كامل"), ("Zaki", "زكي"), ("Helmy", "حلمي"), ("Ezzat", "عزت"), ("Osman", "عثمان"),
    ("Badawy", "بدوي"), ("Salem", "سالم"), ("Lotfy", "لطفي"), ("Abdel Aziz", "عبد العزيز"), ("Sabry", "صبري"),
    ("Morsy", "مرسي"), ("Tawfik", "توفيق"), ("Youssef", "يوسف"),
]
OCCUPATIONS = [
    "Engineer", "Teacher", "Accountant", "Student", "Pharmacist", "Homemaker", "Doctor", "Lawyer", "Driver",
    "Retired", "Sales manager", "Software developer", "Nurse", "Business owner", "Civil servant",
]
ADDRESSES = [
    "Abbas El Akkad St., Nasr City", "Makram Ebeid St., Nasr City", "10th District, Nasr City", "Zahraa Nasr City",
    "Korba, Heliopolis", "El Merghany St., Heliopolis", "Sheraton, Heliopolis", "Almaza, Heliopolis",
    "El Rehab City", "5th Settlement, New Cairo", "Ain Shams", "El Nozha St., Masr El Gedida",
]

# kind, text, guidance, medical history flags
ALERTS = [
    ("allergy", "Allergic to penicillin", "Use clindamycin or azithromycin instead.", {"allergies": "Penicillin (rash)"}),
    ("condition", "Type 2 diabetes", "Check blood sugar before surgery; book morning visits.", {"diabetes": True}),
    ("medication", "Takes warfarin (blood thinner)", "INR within 24 hours before any extraction or surgery.",
     {"blood_thinners": True, "heart_disease": True, "medications": "Warfarin 5 mg daily"}),
    ("medication", "Takes aspirin 81 mg daily", "Expect more bleeding; use local haemostatic measures.",
     {"blood_thinners": True, "medications": "Aspirin 81 mg"}),
    ("condition", "High blood pressure", "Measure blood pressure first; limit adrenaline.",
     {"hypertension": True, "medications": "Amlodipine 5 mg"}),
    ("allergy", "Latex allergy", "Nitrile gloves and a latex-free rubber dam only.", {"allergies": "Latex"}),
    ("condition", "Asthma", "Keep the inhaler at hand; avoid ibuprofen.", {"asthma": True, "medications": "Ventolin inhaler"}),
    ("condition", "Hepatitis C (treated)", "Standard precautions.", {"hepatitis": True}),
]
PREGNANT_ALERT = ("condition", "Pregnant (second trimester)", "No X-rays unless urgent; no NSAIDs.", {"pregnant": True})

STAFF_NOTES = [
    "Prefers evening appointments after 6 pm.",
    "Pays by InstaPay; send the receipt on WhatsApp.",
    "Anxious patient: book longer slots and explain each step.",
    "Comes with her mother; call the mother's number to confirm.",
    "Asked for a quote for whitening after the current plan.",
    "Works in the Gulf; in Cairo until the end of the month.",
    "Referred by Dr. Hany (orthodontist).",
    "Hard of hearing; speak clearly and face him.",
]

SUPPLIERS = [
    ("Cairo Dental Supplies", "Mahmoud Fekry", "+20225761234", "+201001112233", "Net 30 days"),
    ("Nile Dental Trading", "Rasha Kamal", "+20224187766", "+201112223344", "Cash on delivery"),
    ("Delta Implant Systems", "Eng. Hatem Sobhy", "+20226334455", "+201223334455", "50% with order, 50% on delivery"),
    ("Pharaoh Lab Materials", "Ahmed Wahba", "+20223998877", "+201554445566", "Net 15 days"),
    ("El Nasr Medical Store", "Hamdy Saad", "+20222605544", "+201015556677", "Cash"),
]

# code, English, Arabic, category, unit, cost, reorder level, reorder qty, tracks lots, supplier index, extra
ITEMS = [
    ("GLV-M", "Nitrile gloves, medium (box of 100)", "جوانتي نيتريل مقاس متوسط (علبة ١٠٠)", "consumable", "box", 180, 10, 30, False, 4, {}),
    ("GLV-S", "Nitrile gloves, small (box of 100)", "جوانتي نيتريل مقاس صغير (علبة ١٠٠)", "consumable", "box", 180, 6, 20, False, 4, {}),
    ("MSK", "Surgical masks (box of 50)", "كمامات جراحية (علبة ٥٠)", "consumable", "box", 95, 5, 20, False, 4, {}),
    ("SAL", "Saliva ejectors (pack of 100)", "شفاطات لعاب (عبوة ١٠٠)", "consumable", "pack", 120, 4, 12, False, 0, {}),
    ("BIB", "Patient bibs (pack of 125)", "مرايل مرضى (عبوة ١٢٥)", "consumable", "pack", 160, 3, 10, False, 0, {}),
    ("LID", "Lidocaine 2% with adrenaline (cartridge)", "ليدوكايين ٢٪ مع أدرينالين (كارتريدج)", "medicine", "cartridge", 14, 100, 300, True, 1, {}),
    ("ART", "Articaine 4% (cartridge)", "أرتيكايين ٤٪ (كارتريدج)", "medicine", "cartridge", 22, 60, 200, True, 1, {}),
    ("AMX", "Amoxicillin 500 mg (pack of 16)", "أموكسيسيلين ٥٠٠ مجم (علبة ١٦)", "medicine", "pack", 45, 10, 30, True, 1, {}),
    ("CMP-A2", "Composite syringe, shade A2", "حشو كومبوزيت درجة A2", "material", "syringe", 420, 6, 15, False, 0, {}),
    ("CMP-A3", "Composite syringe, shade A3", "حشو كومبوزيت درجة A3", "material", "syringe", 420, 6, 15, False, 0, {}),
    ("BND", "Universal bonding agent (5 ml)", "مادة لاصقة يونيفرسال (٥ مل)", "material", "bottle", 1350, 2, 4, False, 0, {}),
    ("ETC", "Etching gel 37% (syringe)", "جل حمض ٣٧٪ (سرنجة)", "material", "syringe", 85, 5, 15, False, 0, {}),
    ("GIC", "Glass ionomer restorative (powder + liquid)", "حشو أيونومر زجاجي (بودرة وسائل)", "material", "pack", 950, 2, 4, False, 0, {}),
    ("GP", "Gutta-percha points (box)", "أقماع جوتا بيركا (علبة)", "material", "box", 150, 8, 20, False, 0, {}),
    ("FIL", "Rotary NiTi files (pack of 6)", "فايلات روتاري نيكل تيتانيوم (عبوة ٦)", "instrument", "pack", 1100, 6, 12, False, 0, {}),
    ("NAO", "Sodium hypochlorite 5.25% (1 L)", "هيبوكلوريت الصوديوم ٥٫٢٥٪ (لتر)", "material", "bottle", 75, 3, 6, False, 4, {}),
    ("TMP", "Temporary filling material", "حشو مؤقت", "material", "pack", 230, 2, 5, False, 0, {}),
    ("ALG", "Alginate impression material (500 g)", "مادة طبعة ألجينات (٥٠٠ جم)", "material", "pack", 260, 3, 8, False, 0, {}),
    ("PVS", "Silicone impression putty + light body", "مادة طبعة سيليكون", "material", "pack", 1650, 2, 4, False, 0, {}),
    ("CRD", "Retraction cord #00", "خيط إبعاد اللثة ٠٠", "material", "piece", 320, 2, 4, False, 0, {}),
    ("SUT", "Silk sutures 3-0 (box of 12)", "خيوط جراحية حرير 3-0 (علبة ١٢)", "consumable", "box", 480, 2, 5, False, 2, {}),
    ("CHX", "Chlorhexidine 0.12% mouthwash", "غسول كلورهيكسيدين ٠٫١٢٪", "medicine", "bottle", 38, 10, 30, True, 1, {}),
    ("ZRD", "Zirconia disc 98 mm x 14 mm", "قرص زيركونيا ٩٨ × ١٤ مم", "lab_material", "disc", 3800, 3, 6, False, 3, {}),
    ("EMX", "Lithium disilicate block (e.max CAD)", "بلوك ليثيوم داي سيليكات", "lab_material", "block", 650, 10, 25, False, 3, {}),
    ("PMM", "PMMA disc for temporaries", "قرص PMMA للتركيبات المؤقتة", "lab_material", "disc", 1900, 2, 4, False, 3, {}),
    ("ACR", "Heat-cure denture acrylic (1 kg)", "أكريليك أطقم حراري (١ كجم)", "lab_material", "pack", 1250, 2, 4, False, 3, {}),
    ("BGR", "Bone graft granules 0.5 g", "حبيبات تطعيم عظم ٠٫٥ جم", "implant", "piece", 2600, 3, 6, True, 2, {}),
    ("HAB", "Healing abutment 4.5 x 4 mm", "دعامة التئام ٤٫٥ × ٤ مم", "implant", "piece", 450, 6, 15, False, 2, {}),
    ("IMP-4010", "Implant 4.0 x 10 mm", "غرسة ٤٫٠ × ١٠ مم", "implant", "piece", 5200, 3, 8, True, 2,
     {"brand": "Delta Implants", "system": "Tapered Pro", "diameter": "4.0", "length": "10"}),
    ("IMP-4511", "Implant 4.5 x 11.5 mm", "غرسة ٤٫٥ × ١١٫٥ مم", "implant", "piece", 5200, 3, 8, True, 2,
     {"brand": "Delta Implants", "system": "Tapered Pro", "diameter": "4.5", "length": "11.5"}),
    ("IMP-3510", "Implant 3.5 x 10 mm", "غرسة ٣٫٥ × ١٠ مم", "implant", "piece", 5200, 2, 6, True, 2,
     {"brand": "Delta Implants", "system": "Tapered Pro", "diameter": "3.5", "length": "10"}),
    ("XRS", "X-ray sensor sleeves (box of 500)", "أغطية حساس الأشعة (علبة ٥٠٠)", "consumable", "box", 340, 1, 3, False, 4, {}),
    ("PPR", "A4 paper (ream)", "ورق A4 (رزمة)", "office", "pack", 210, 4, 10, False, 4, {}),
]

# What procedures use from stock (procedure code -> [(item code, quantity)]).
MATERIALS = {
    "PV01": [("GLV-M", "0.02"), ("SAL", "0.02"), ("BIB", "0.01")],
    "RS01": [("LID", "1"), ("CMP-A2", "0.15"), ("BND", "0.02"), ("ETC", "0.1"), ("GLV-M", "0.02")],
    "RS02": [("LID", "1"), ("CMP-A3", "0.25"), ("BND", "0.03"), ("ETC", "0.15"), ("GLV-M", "0.02")],
    "RS03": [("ART", "1"), ("CMP-A3", "0.35"), ("BND", "0.04"), ("ETC", "0.2"), ("GLV-M", "0.02")],
    "RS04": [("GIC", "0.05"), ("GLV-M", "0.02")],
    "EN02": [("ART", "1"), ("FIL", "0.5"), ("GP", "0.25"), ("NAO", "0.05"), ("TMP", "0.05")],
    "EN03": [("ART", "2"), ("FIL", "1"), ("GP", "0.35"), ("NAO", "0.08"), ("TMP", "0.05")],
    "OS01": [("LID", "2"), ("GLV-M", "0.02")],
    "OS02": [("ART", "2"), ("SUT", "0.1"), ("GLV-M", "0.02")],
    "OS03": [("ART", "2"), ("SUT", "0.1"), ("GLV-M", "0.02")],
    "IM01": [("ART", "2"), ("SUT", "0.1"), ("HAB", "1")],
    "PR01": [("PVS", "0.1"), ("CRD", "0.1")],
    "PR03": [("PVS", "0.1"), ("CRD", "0.1")],
    "IM02": [("PVS", "0.1")],
}

# Starting prices in EGP (only filled where the clinic has not set a price).
PRICES = {
    "DX01": 300, "DX02": 150, "DX03": 450, "DX04": 1200, "PV01": 600, "PV02": 300, "PV03": 250,
    "RS01": 800, "RS02": 1000, "RS03": 1250, "RS04": 600, "RS05": 250,
    "EN01": 2000, "EN02": 2500, "EN03": 3200, "EN04": 3800, "EN05": 900, "PE01": 900, "PE02": 1500,
    "PR01": 5500, "PR02": 3500, "PR03": 6500, "PR04": 4500, "PR05": 1500, "PR06": 9000, "PR07": 6500, "PR08": 600,
    "OS01": 600, "OS02": 1500, "OS03": 2500, "IM01": 18000, "IM02": 7000, "IM03": 5000, "IM04": 15000,
    "OR01": 800, "OR02": 35000, "OR03": 400, "OR04": 60000, "OR05": 2500, "CO01": 4500, "CO02": 7000,
}
