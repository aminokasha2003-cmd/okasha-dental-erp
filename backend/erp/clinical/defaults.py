"""Starter consent forms, added the first time a clinic opens its consent templates.

They are general wording for the clinic to review and adapt; they are not legal advice.
"""

from .models import ConsentTemplate

STARTER_CONSENTS = [
    (
        "General dental treatment",
        "موافقة على العلاج العام للأسنان",
        "I agree to the dental examination, X-rays and the treatment explained to me by my dentist. "
        "The dentist explained the expected benefits, the possible risks and side effects, the other options "
        "including no treatment, and the estimated cost. I had the chance to ask questions and I was answered. "
        "I told the dentist about my medical history and medicines, and I will tell the clinic of any change.",
        "أوافق على الكشف والأشعة والعلاج الذي شرحه لي الطبيب. شرح لي الطبيب الفوائد المتوقعة والمخاطر والآثار "
        "الجانبية المحتملة والبدائل الأخرى بما فيها عدم العلاج، والتكلفة التقديرية. أُتيحت لي الفرصة لطرح أسئلتي "
        "وتمت الإجابة عليها. أخبرت الطبيب بتاريخي المرضي والأدوية التي أتناولها، وسأبلغ العيادة بأي تغيير.",
    ),
    (
        "Tooth extraction",
        "موافقة على خلع الأسنان",
        "I agree to the extraction of the tooth or teeth named on this form. Possible effects include pain, "
        "swelling, bleeding, bruising, dry socket, infection, temporary or rarely lasting numbness of the lip, "
        "chin or tongue, damage to nearby teeth or fillings, and, for upper back teeth, an opening into the sinus. "
        "I will follow the after-care instructions I was given.",
        "أوافق على خلع السن أو الأسنان المذكورة في هذا النموذج. من الآثار المحتملة: الألم والتورم والنزيف والكدمات "
        "والتهاب مكان الخلع (الحويصلة الجافة) والعدوى، وتنميل مؤقت أو نادراً دائم في الشفة أو الذقن أو اللسان، "
        "وتضرر الأسنان أو الحشوات المجاورة، وفي الأسنان الخلفية العلوية حدوث اتصال بالجيب الأنفي. "
        "سألتزم بتعليمات ما بعد الخلع التي أُعطيت لي.",
    ),
    (
        "Root canal treatment",
        "موافقة على علاج العصب",
        "I agree to root canal treatment of the tooth named on this form. Root canal treatment usually saves "
        "the tooth but cannot be guaranteed. Possible effects include pain or swelling after treatment, a broken "
        "instrument left in the canal, a crack in the tooth, and the need for re-treatment, surgery or extraction. "
        "A crown is usually advised afterwards to protect the tooth.",
        "أوافق على علاج عصب السن المذكور في هذا النموذج. علاج العصب ينجح عادةً في الحفاظ على السن لكن لا يمكن "
        "ضمان النتيجة. من الآثار المحتملة: ألم أو تورم بعد العلاج، أو انكسار أداة داخل القناة، أو شرخ في السن، "
        "أو الحاجة لإعادة العلاج أو الجراحة أو الخلع. يُنصح عادةً بعمل تاج بعد العلاج لحماية السن.",
    ),
    (
        "Dental implant",
        "موافقة على زراعة الأسنان",
        "I agree to the placement of a dental implant as explained to me. Healing takes several months before the "
        "final crown. Possible effects include pain, swelling, bleeding, infection, numbness, sinus involvement, "
        "and failure of the implant to join the bone, which may need removal and replacement. Smoking and poorly "
        "controlled diabetes raise the risk. I will keep the follow-up visits and keep the area clean.",
        "أوافق على زراعة السن كما شُرح لي. يحتاج الالتئام إلى عدة أشهر قبل تركيب التاج النهائي. من الآثار المحتملة: "
        "الألم والتورم والنزيف والعدوى والتنميل وإصابة الجيب الأنفي، وعدم التحام الزرعة بالعظم مما قد يستلزم إزالتها "
        "واستبدالها. التدخين والسكري غير المنضبط يزيدان المخاطر. سألتزم بمواعيد المتابعة والعناية بنظافة المكان.",
    ),
]


def ensure_starter_consents(clinic):
    """Add the starter forms once; a clinic that has any templates (even inactive) is left alone."""
    if ConsentTemplate.objects.filter(clinic=clinic).exists():
        return 0
    ConsentTemplate.objects.bulk_create(
        ConsentTemplate(clinic=clinic, title_en=te, title_ar=ta, body_en=be, body_ar=ba) for te, ta, be, ba in STARTER_CONSENTS
    )
    return len(STARTER_CONSENTS)
