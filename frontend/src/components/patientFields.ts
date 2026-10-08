import type { FieldDef, Option } from "./Crud";
import type { TKey } from "../i18n";

export const REFERRALS = ["walk_in", "friend", "facebook", "instagram", "google", "doctor", "other"];
export const ALERT_KINDS = ["allergy", "condition", "medication", "other"];
export const FILE_KINDS = ["xray", "photo", "scan", "consent", "document", "other"];

export const PATIENT_DEFAULTS = { language: "ar", whatsapp_opt_in: true, is_active: true };

/** The patient form. `short` is the quick version used when booking a new patient. */
export function patientFields(
  t: (key: TKey) => string,
  { branches = [], dentists = [], short = false }: { branches?: Option[]; dentists?: Option[]; short?: boolean } = {},
): FieldDef[] {
  const main: FieldDef[] = [
    { name: "name_ar", label: "nameAr", dir: "rtl" },
    { name: "name_en", label: "nameEn", dir: "ltr" },
    { name: "phone", label: "pt.mobile", required: true, dir: "ltr" },
    {
      name: "gender",
      label: "pt.gender",
      type: "select",
      options: ["female", "male"].map((v) => ({ value: v, label: t(`pt.gender.${v}` as TKey) })),
    },
    { name: "date_of_birth", label: "pt.dob", type: "date" },
  ];
  if (short) return main;
  return [
    ...main,
    { name: "phone_alt", label: "pt.phoneAlt", dir: "ltr" },
    { name: "whatsapp_opt_in", label: "pt.whatsapp", type: "checkbox" },
    {
      name: "language",
      label: "pt.language",
      type: "select",
      required: true,
      options: [
        { value: "ar", label: "العربية" },
        { value: "en", label: "English" },
      ],
    },
    { name: "email", label: "email", type: "email", dir: "ltr" },
    { name: "national_id", label: "pt.nationalId", dir: "ltr" },
    { name: "occupation", label: "pt.occupation" },
    {
      name: "referral_source",
      label: "pt.referral",
      type: "select",
      options: REFERRALS.map((v) => ({ value: v, label: t(`pt.referral.${v}` as TKey) })),
    },
    { name: "home_branch", label: "pt.homeBranch", type: "select", options: branches },
    { name: "preferred_dentist", label: "pt.dentist", type: "select", options: dentists },
    { name: "address", label: "pt.address", type: "textarea" },
    { name: "notes", label: "pt.notes", type: "textarea" },
  ];
}

/** Empty selects come back as null; the API wants "" for optional text choices. */
export function cleanPatient(values: Record<string, unknown>) {
  return {
    ...values,
    gender: values.gender ?? "",
    referral_source: values.referral_source ?? "",
    date_of_birth: values.date_of_birth || null,
  };
}
