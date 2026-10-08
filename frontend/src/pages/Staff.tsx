import { useEffect, useState } from "react";
import { getAll } from "../api";
import { useAuth } from "../auth";
import { useI18n, type TKey } from "../i18n";
import { ActiveBadge, CrudSection, type Option } from "../components/Crud";

type StaffRow = {
  id: number;
  user: number | null;
  name_en: string;
  name_ar: string;
  staff_type: string;
  phone: string;
  branches: number[];
  commission_type: string;
  commission_value: string;
  color: string;
  is_active: boolean;
};

const TYPES = ["dentist", "assistant", "technician", "reception", "accountant", "other"];
const COMMISSIONS = ["none", "percent_collected", "percent_billed", "fixed_per_procedure"];

export function Staff() {
  const { t, name } = useI18n();
  const { can } = useAuth();
  const [branches, setBranches] = useState<Option[]>([]);
  const [users, setUsers] = useState<Option[]>([]);

  useEffect(() => {
    if (can("settings")) {
      getAll<{ id: number; name_en: string; name_ar: string }>("/api/masterdata/branches/").then((rows) => setBranches(rows.map((b) => ({ value: b.id, label: name(b) }))));
    }
    if (can("users")) {
      getAll<{ id: number; username: string; first_name: string; last_name: string }>("/api/users/").then((rows) =>
        setUsers(rows.map((u) => ({ value: u.id, label: [u.first_name, u.last_name].filter(Boolean).join(" ") || u.username }))),
      );
    }
  }, [can, name]);

  const typeLabel = (v: string) => t(`staff.type.${v}` as TKey);
  const commissionLabel = (r: StaffRow) =>
    r.commission_type === "none" ? t("staff.commission.none") : `${t(`staff.commission.${r.commission_type}` as TKey)}: ${Number(r.commission_value)}${r.commission_type.startsWith("percent") ? "%" : ""}`;

  return (
    <div className="page">
      <h1>{t("nav.staff")}</h1>
      <CrudSection<StaffRow>
        title={t("nav.staff")}
        endpoint="/api/masterdata/staff/"
        module="masterdata"
        defaults={{ staff_type: "dentist", commission_type: "none", commission_value: "0", is_active: true, branches: [] }}
        columns={[
          { label: "nameEn", render: (r) => r.name_en },
          { label: "nameAr", render: (r) => <span dir="rtl">{r.name_ar}</span> },
          { label: "staff.type", render: (r) => typeLabel(r.staff_type) },
          { label: "phone", render: (r) => <span dir="ltr">{r.phone}</span> },
          { label: "staff.commission", render: commissionLabel },
          { label: "active", render: (r) => <ActiveBadge value={r.is_active} /> },
        ]}
        fields={[
          { name: "name_en", label: "nameEn", required: true, dir: "ltr" },
          { name: "name_ar", label: "nameAr", required: true, dir: "rtl" },
          { name: "staff_type", label: "staff.type", type: "select", required: true, options: TYPES.map((v) => ({ value: v, label: typeLabel(v) })) },
          { name: "phone", label: "phone", dir: "ltr" },
          { name: "user", label: "staff.user", type: "select", options: users },
          { name: "branches", label: "staff.branches", type: "multiselect", options: branches },
          { name: "commission_type", label: "staff.commission", type: "select", required: true, options: COMMISSIONS.map((v) => ({ value: v, label: t(`staff.commission.${v}` as TKey) })) },
          { name: "commission_value", label: "staff.commissionValue", type: "number", step: "0.01", dir: "ltr" },
          { name: "color", label: "staff.color", type: "color" },
          { name: "is_active", label: "active", type: "checkbox" },
        ]}
        prepare={(v) => ({ ...v, color: v.color || "" })}
      />
    </div>
  );
}
