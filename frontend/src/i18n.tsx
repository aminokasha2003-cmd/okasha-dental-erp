import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

export type Lang = "en" | "ar";

const en = {
  appName: "Okasha Dental",
  signIn: "Sign in",
  signOut: "Sign out",
  username: "Username",
  password: "Password",
  signInFailed: "Wrong username or password.",
  loading: "Loading…",
  save: "Save",
  saved: "Saved",
  cancel: "Cancel",
  add: "Add",
  edit: "Edit",
  delete: "Delete",
  deactivate: "Deactivate",
  confirmDelete: "Delete this record? This cannot be undone.",
  yes: "Yes",
  no: "No",
  active: "Active",
  inactive: "Inactive",
  actions: "Actions",
  search: "Search",
  none: "None",
  all: "All",
  noRecords: "Nothing here yet.",
  nameEn: "Name (English)",
  nameAr: "Name (Arabic)",
  phone: "Phone",
  email: "Email",
  language: "Language",
  version1: "Version 1",
  comingLater: "Coming later",
  comingInPhase: "This module is built in phase {phase}.",
  comingInPhaseHint: "The foundation it needs is ready. Roles can already be given access to it.",
  noAccess: "Your role does not include this page.",
  // Modules
  "nav.home": "Home",
  "nav.settings": "Clinic settings",
  "nav.users": "Users and roles",
  "nav.staff": "Staff directory",
  "nav.procedures": "Procedure catalog",
  "nav.audit": "Audit log",
  "nav.patients": "Patients",
  "nav.appointments": "Appointments",
  "nav.clinical": "Clinical records",
  "nav.billing": "Billing",
  "nav.lab": "Lab",
  "nav.inventory": "Inventory",
  "nav.payroll": "Staff and payroll",
  "nav.crm": "CRM and reports",
  "group.setup": "Setup",
  // Home
  "home.title": "Set up your clinic",
  "home.intro": "Phase 0 is done when each of these is in place.",
  "home.step.clinic": "Fill in the clinic profile and tax details",
  "home.step.branch": "Add at least one branch",
  "home.step.chairs": "Add the chairs",
  "home.step.hours": "Set working hours",
  "home.step.staff": "Add the staff directory",
  "home.step.procedures": "Build the procedure catalog in both languages",
  "home.step.users": "Create user accounts with roles",
  "home.done": "Done",
  "home.todo": "To do",
  "home.open": "Open",
  // Clinic settings
  "settings.profile": "Clinic profile",
  "settings.branches": "Branches",
  "settings.rooms": "Rooms",
  "settings.chairs": "Chairs",
  "settings.hours": "Working hours",
  "settings.addressEn": "Address (English)",
  "settings.addressAr": "Address (Arabic)",
  "settings.currency": "Currency",
  "settings.defaultLanguage": "Default language",
  "settings.taxNumber": "Tax registration number",
  "settings.commercialRegister": "Commercial register",
  "settings.taxRate": "Tax rate %",
  "settings.branch": "Branch",
  "settings.room": "Room",
  "settings.order": "Order",
  "settings.day": "Day",
  "settings.opens": "Opens",
  "settings.closes": "Closes",
  "settings.closed": "Closed",
  "day.0": "Monday",
  "day.1": "Tuesday",
  "day.2": "Wednesday",
  "day.3": "Thursday",
  "day.4": "Friday",
  "day.5": "Saturday",
  "day.6": "Sunday",
  // Users and roles
  "users.users": "Users",
  "users.roles": "Roles",
  "users.firstName": "First name",
  "users.lastName": "Last name",
  "users.newPassword": "New password",
  "users.passwordHint": "Leave empty to keep the current password.",
  "users.roles.label": "Roles",
  "users.lastLogin": "Last sign-in",
  "roles.code": "Code",
  "roles.users": "Users",
  "roles.permissions": "Permissions",
  "roles.builtIn": "Built-in",
  "roles.module": "Module",
  "action.view": "View",
  "action.create": "Create",
  "action.edit": "Edit",
  "action.delete": "Delete",
  "action.approve": "Approve",
  // Staff
  "staff.type": "Type",
  "staff.type.dentist": "Dentist",
  "staff.type.assistant": "Dental assistant",
  "staff.type.technician": "Lab technician",
  "staff.type.reception": "Receptionist",
  "staff.type.accountant": "Accountant",
  "staff.type.other": "Other",
  "staff.user": "User account",
  "staff.branches": "Branches",
  "staff.commission": "Commission rule",
  "staff.commissionValue": "Commission value",
  "staff.commission.none": "No commission",
  "staff.commission.percent_collected": "Percent of amount collected",
  "staff.commission.percent_billed": "Percent of amount billed",
  "staff.commission.fixed_per_procedure": "Fixed amount per procedure",
  "staff.color": "Calendar color",
  // Procedures
  "proc.categories": "Categories",
  "proc.procedures": "Procedures",
  "proc.code": "Code",
  "proc.category": "Category",
  "proc.price": "Default price",
  "proc.duration": "Duration (min)",
  "proc.needsLab": "Needs lab",
  // Audit
  "audit.when": "When",
  "audit.who": "Who",
  "audit.what": "What",
  "audit.record": "Record",
  "audit.changes": "Changes",
  "audit.action.create": "Created",
  "audit.action.update": "Changed",
  "audit.action.delete": "Deleted",
  "audit.system": "System",
  "audit.more": "Load more",
};

type Key = keyof typeof en;

const ar: Record<Key, string> = {
  appName: "عكاشة لطب الأسنان",
  signIn: "تسجيل الدخول",
  signOut: "تسجيل الخروج",
  username: "اسم المستخدم",
  password: "كلمة المرور",
  signInFailed: "اسم المستخدم أو كلمة المرور غير صحيحة.",
  loading: "جارٍ التحميل…",
  save: "حفظ",
  saved: "تم الحفظ",
  cancel: "إلغاء",
  add: "إضافة",
  edit: "تعديل",
  delete: "حذف",
  deactivate: "إيقاف",
  confirmDelete: "حذف هذا السجل؟ لا يمكن التراجع عن ذلك.",
  yes: "نعم",
  no: "لا",
  active: "نشط",
  inactive: "غير نشط",
  actions: "إجراءات",
  search: "بحث",
  none: "لا يوجد",
  all: "الكل",
  noRecords: "لا توجد بيانات بعد.",
  nameEn: "الاسم (إنجليزي)",
  nameAr: "الاسم (عربي)",
  phone: "الهاتف",
  email: "البريد الإلكتروني",
  language: "اللغة",
  version1: "الإصدار الأول",
  comingLater: "لاحقًا",
  comingInPhase: "تُبنى هذه الوحدة في المرحلة {phase}.",
  comingInPhaseHint: "الأساس الذي تحتاجه جاهز، ويمكن من الآن منح الأدوار صلاحية الوصول إليها.",
  noAccess: "دورك لا يتيح هذه الصفحة.",
  "nav.home": "الرئيسية",
  "nav.settings": "إعدادات العيادة",
  "nav.users": "المستخدمون والأدوار",
  "nav.staff": "دليل الموظفين",
  "nav.procedures": "قائمة الإجراءات",
  "nav.audit": "سجل التغييرات",
  "nav.patients": "المرضى",
  "nav.appointments": "المواعيد",
  "nav.clinical": "السجل السريري",
  "nav.billing": "الفواتير",
  "nav.lab": "المعمل",
  "nav.inventory": "المخزون",
  "nav.payroll": "الموظفون والرواتب",
  "nav.crm": "العملاء والتقارير",
  "group.setup": "الإعداد",
  "home.title": "إعداد العيادة",
  "home.intro": "تكتمل المرحلة صفر عندما يكتمل كل بند من هذه البنود.",
  "home.step.clinic": "أكمل بيانات العيادة والبيانات الضريبية",
  "home.step.branch": "أضف فرعًا واحدًا على الأقل",
  "home.step.chairs": "أضف الكراسي",
  "home.step.hours": "حدد مواعيد العمل",
  "home.step.staff": "أضف دليل الموظفين",
  "home.step.procedures": "أنشئ قائمة الإجراءات باللغتين",
  "home.step.users": "أنشئ حسابات المستخدمين بأدوارهم",
  "home.done": "تم",
  "home.todo": "مطلوب",
  "home.open": "فتح",
  "settings.profile": "بيانات العيادة",
  "settings.branches": "الفروع",
  "settings.rooms": "الغرف",
  "settings.chairs": "الكراسي",
  "settings.hours": "مواعيد العمل",
  "settings.addressEn": "العنوان (إنجليزي)",
  "settings.addressAr": "العنوان (عربي)",
  "settings.currency": "العملة",
  "settings.defaultLanguage": "اللغة الافتراضية",
  "settings.taxNumber": "رقم التسجيل الضريبي",
  "settings.commercialRegister": "السجل التجاري",
  "settings.taxRate": "نسبة الضريبة %",
  "settings.branch": "الفرع",
  "settings.room": "الغرفة",
  "settings.order": "الترتيب",
  "settings.day": "اليوم",
  "settings.opens": "يفتح",
  "settings.closes": "يغلق",
  "settings.closed": "مغلق",
  "day.0": "الاثنين",
  "day.1": "الثلاثاء",
  "day.2": "الأربعاء",
  "day.3": "الخميس",
  "day.4": "الجمعة",
  "day.5": "السبت",
  "day.6": "الأحد",
  "users.users": "المستخدمون",
  "users.roles": "الأدوار",
  "users.firstName": "الاسم الأول",
  "users.lastName": "اسم العائلة",
  "users.newPassword": "كلمة مرور جديدة",
  "users.passwordHint": "اتركها فارغة للإبقاء على كلمة المرور الحالية.",
  "users.roles.label": "الأدوار",
  "users.lastLogin": "آخر دخول",
  "roles.code": "الرمز",
  "roles.users": "المستخدمون",
  "roles.permissions": "الصلاحيات",
  "roles.builtIn": "أساسي",
  "roles.module": "الوحدة",
  "action.view": "عرض",
  "action.create": "إنشاء",
  "action.edit": "تعديل",
  "action.delete": "حذف",
  "action.approve": "اعتماد",
  "staff.type": "النوع",
  "staff.type.dentist": "طبيب أسنان",
  "staff.type.assistant": "مساعد طبيب",
  "staff.type.technician": "فني معمل",
  "staff.type.reception": "استقبال",
  "staff.type.accountant": "محاسب",
  "staff.type.other": "أخرى",
  "staff.user": "حساب المستخدم",
  "staff.branches": "الفروع",
  "staff.commission": "قاعدة العمولة",
  "staff.commissionValue": "قيمة العمولة",
  "staff.commission.none": "بدون عمولة",
  "staff.commission.percent_collected": "نسبة من المبلغ المحصل",
  "staff.commission.percent_billed": "نسبة من المبلغ المفوتر",
  "staff.commission.fixed_per_procedure": "مبلغ ثابت لكل إجراء",
  "staff.color": "لون التقويم",
  "proc.categories": "الفئات",
  "proc.procedures": "الإجراءات",
  "proc.code": "الرمز",
  "proc.category": "الفئة",
  "proc.price": "السعر الافتراضي",
  "proc.duration": "المدة (دقيقة)",
  "proc.needsLab": "يحتاج معمل",
  "audit.when": "الوقت",
  "audit.who": "المستخدم",
  "audit.what": "الإجراء",
  "audit.record": "السجل",
  "audit.changes": "التغييرات",
  "audit.action.create": "إنشاء",
  "audit.action.update": "تعديل",
  "audit.action.delete": "حذف",
  "audit.system": "النظام",
  "audit.more": "عرض المزيد",
};

const dictionaries: Record<Lang, Record<Key, string>> = { en, ar };

const MODULE_NAMES: Record<string, Record<Lang, string>> = {
  settings: { en: "Clinic settings", ar: "إعدادات العيادة" },
  users: { en: "Users and roles", ar: "المستخدمون والأدوار" },
  masterdata: { en: "Master data", ar: "البيانات الأساسية" },
  audit: { en: "Audit log", ar: "سجل التغييرات" },
  files: { en: "Files", ar: "الملفات" },
  patients: { en: "Patients", ar: "المرضى" },
  appointments: { en: "Appointments", ar: "المواعيد" },
  clinical: { en: "Clinical records", ar: "السجل السريري" },
  billing: { en: "Billing", ar: "الفواتير" },
  lab: { en: "Lab", ar: "المعمل" },
  inventory: { en: "Inventory and purchasing", ar: "المخزون والمشتريات" },
  staff: { en: "Staff and payroll", ar: "الموظفون والرواتب" },
  crm: { en: "CRM", ar: "إدارة العملاء" },
  reports: { en: "Reports", ar: "التقارير" },
};

export type TKey = Key;

interface I18n {
  lang: Lang;
  setLang: (lang: Lang) => void;
  t: (key: Key, vars?: Record<string, string | number>) => string;
  name: (record: { name_en?: string; name_ar?: string } | null | undefined) => string;
  moduleName: (code: string) => string;
}

const I18nContext = createContext<I18n | null>(null);
const LANG_KEY = "erp.lang";

function initialLang(): Lang {
  try {
    const saved = window.localStorage.getItem(LANG_KEY);
    if (saved === "en" || saved === "ar") return saved;
  } catch {
    /* storage blocked */
  }
  return "ar";
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(initialLang);

  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dir = lang === "ar" ? "rtl" : "ltr";
    try {
      window.localStorage.setItem(LANG_KEY, lang);
    } catch {
      /* storage blocked */
    }
  }, [lang]);

  const t = useCallback(
    (key: Key, vars?: Record<string, string | number>) => {
      let text = dictionaries[lang][key] ?? en[key] ?? key;
      if (vars) for (const [k, v] of Object.entries(vars)) text = text.replace(`{${k}}`, String(v));
      return text;
    },
    [lang],
  );

  const value = useMemo<I18n>(
    () => ({
      lang,
      setLang: setLangState,
      t,
      name: (record) => (record ? (lang === "ar" ? record.name_ar || record.name_en : record.name_en || record.name_ar) ?? "" : ""),
      moduleName: (code) => MODULE_NAMES[code]?.[lang] ?? code,
    }),
    [lang, t],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useI18n must be used inside I18nProvider");
  return ctx;
}
