import { useCallback, useState } from "react";
import { useAuth } from "../auth";
import { useI18n } from "../i18n";
import { ActiveBadge, CrudSection, YesNo } from "../components/Crud";

type CategoryRow = { id: number; name_en: string; name_ar: string; sort_order: number };
type ProcedureRow = {
  id: number;
  code: string;
  name_en: string;
  name_ar: string;
  category: number;
  default_price: string;
  default_duration_minutes: number;
  needs_lab: boolean;
  is_active: boolean;
};

export function Procedures() {
  const { t, name, lang } = useI18n();
  const { me } = useAuth();
  const [categories, setCategories] = useState<CategoryRow[]>([]);
  const onCategories = useCallback((rows: CategoryRow[]) => setCategories(rows), []);
  const currency = me?.clinic?.currency ?? "EGP";
  const money = (v: string) => `${Number(v).toLocaleString(lang === "ar" ? "ar-EG" : "en-US")} ${currency}`;

  return (
    <div className="page">
      <h1>{t("nav.procedures")}</h1>
      <CrudSection<CategoryRow>
        title={t("proc.categories")}
        endpoint="/api/masterdata/procedure-categories/"
        module="masterdata"
        onChanged={onCategories}
        defaults={{ sort_order: categories.length + 1 }}
        columns={[
          { label: "nameEn", render: (r) => r.name_en },
          { label: "nameAr", render: (r) => <span dir="rtl">{r.name_ar}</span> },
          { label: "settings.order", render: (r) => r.sort_order },
        ]}
        fields={[
          { name: "name_en", label: "nameEn", required: true, dir: "ltr" },
          { name: "name_ar", label: "nameAr", required: true, dir: "rtl" },
          { name: "sort_order", label: "settings.order", type: "number" },
        ]}
      />
      <CrudSection<ProcedureRow>
        title={t("proc.procedures")}
        endpoint="/api/masterdata/procedures/"
        module="masterdata"
        defaults={{ category: categories[0]?.id, default_price: "0", default_duration_minutes: 30, needs_lab: false, is_active: true }}
        columns={[
          { label: "proc.code", render: (r) => <code dir="ltr">{r.code}</code> },
          { label: "nameEn", render: (r) => r.name_en },
          { label: "nameAr", render: (r) => <span dir="rtl">{r.name_ar}</span> },
          { label: "proc.category", render: (r) => name(categories.find((c) => c.id === r.category)) },
          { label: "proc.price", render: (r) => <span className="num">{money(r.default_price)}</span> },
          { label: "proc.duration", render: (r) => r.default_duration_minutes },
          { label: "proc.needsLab", render: (r) => <YesNo value={r.needs_lab} /> },
          { label: "active", render: (r) => <ActiveBadge value={r.is_active} /> },
        ]}
        fields={[
          { name: "code", label: "proc.code", required: true, dir: "ltr" },
          { name: "category", label: "proc.category", type: "select", required: true, options: categories.map((c) => ({ value: c.id, label: name(c) })) },
          { name: "name_en", label: "nameEn", required: true, dir: "ltr" },
          { name: "name_ar", label: "nameAr", required: true, dir: "rtl" },
          { name: "default_price", label: "proc.price", type: "number", step: "0.01", dir: "ltr" },
          { name: "default_duration_minutes", label: "proc.duration", type: "number", dir: "ltr" },
          { name: "needs_lab", label: "proc.needsLab", type: "checkbox" },
          { name: "is_active", label: "active", type: "checkbox" },
        ]}
      />
    </div>
  );
}
