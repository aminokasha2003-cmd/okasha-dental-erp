import { useCallback, useEffect, useState, type FormEvent } from "react";
import { ApiError, get, patch } from "../api";
import { useAuth } from "../auth";
import { useI18n } from "../i18n";
import { ActiveBadge, CrudSection, Field, type FieldDef, type Option } from "../components/Crud";
import type { Clinic } from "../types";

type Named = { id: number; name_en: string; name_ar: string };
type BranchRow = Named & { phone: string; is_active: boolean };
type RoomRow = Named & { branch: number; is_active: boolean };
type ChairRow = Named & { branch: number; room: number | null; sort_order: number; is_active: boolean };
type HoursRow = { id: number; branch: number; weekday: number; is_closed: boolean; opens_at: string | null; closes_at: string | null };

const PROFILE_FIELDS: FieldDef[] = [
  { name: "name_en", label: "nameEn", required: true, dir: "ltr" },
  { name: "name_ar", label: "nameAr", required: true, dir: "rtl" },
  { name: "phone", label: "phone", dir: "ltr" },
  { name: "email", label: "email", type: "email", dir: "ltr" },
  { name: "address_en", label: "settings.addressEn", type: "textarea", dir: "ltr" },
  { name: "address_ar", label: "settings.addressAr", type: "textarea", dir: "rtl" },
  { name: "currency", label: "settings.currency", dir: "ltr" },
  { name: "default_language", label: "settings.defaultLanguage", type: "select", required: true, options: [{ value: "ar", label: "العربية" }, { value: "en", label: "English" }] },
  { name: "tax_registration_number", label: "settings.taxNumber", dir: "ltr" },
  { name: "commercial_register", label: "settings.commercialRegister", dir: "ltr" },
  { name: "tax_rate", label: "settings.taxRate", type: "number", step: "0.01", dir: "ltr" },
];

function ClinicProfile() {
  const { t } = useI18n();
  const { can, reload } = useAuth();
  const [clinic, setClinic] = useState<Clinic | null>(null);
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const [message, setMessage] = useState("");

  useEffect(() => {
    get<Clinic>("/api/clinic/").then(setClinic).catch((e) => setMessage(String(e.message ?? e)));
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!clinic) return;
    setErrors({});
    try {
      const saved = await patch<Clinic>("/api/clinic/", clinic);
      setClinic(saved);
      setMessage(t("saved"));
      void reload();
    } catch (err) {
      if (err instanceof ApiError) setErrors(err.fields);
      setMessage(err instanceof Error ? err.message : String(err));
    }
  };

  if (!clinic) return <section className="card pad">{message || t("loading")}</section>;
  const editable = can("settings", "edit");
  return (
    <section className="card">
      <header className="card-head">
        <h2>{t("settings.profile")}</h2>
      </header>
      <form onSubmit={submit} className="form-grid form-grid-2 pad">
        <fieldset disabled={!editable} className="contents">
          {PROFILE_FIELDS.map((f) => (
            <Field
              key={f.name}
              field={f}
              value={(clinic as unknown as Record<string, unknown>)[f.name]}
              errors={errors[f.name]}
              onChange={(v) => {
                setMessage("");
                setClinic({ ...clinic, [f.name]: v } as Clinic);
              }}
            />
          ))}
        </fieldset>
        {editable && (
          <div className="form-actions span-all">
            {message && <span className="muted" role="status">{message}</span>}
            <button className="btn btn-primary">{t("save")}</button>
          </div>
        )}
      </form>
    </section>
  );
}

export function Settings() {
  const { t, name } = useI18n();
  const [branches, setBranches] = useState<BranchRow[]>([]);
  const [rooms, setRooms] = useState<RoomRow[]>([]);
  const branchOptions: Option[] = branches.map((b) => ({ value: b.id, label: name(b) }));
  const roomOptions: Option[] = rooms.map((r) => ({ value: r.id, label: `${name(r)} (${name(branches.find((b) => b.id === r.branch))})` }));
  const branchName = (id: number | null) => name(branches.find((b) => b.id === id));
  const onBranches = useCallback((rows: BranchRow[]) => setBranches(rows), []);
  const onRooms = useCallback((rows: RoomRow[]) => setRooms(rows), []);
  const days: Option[] = [5, 6, 0, 1, 2, 3, 4].map((d) => ({ value: d, label: t(`day.${d}` as "day.0") }));
  const time = (v: string | null) => (v ? v.slice(0, 5) : "");

  return (
    <div className="page">
      <h1>{t("nav.settings")}</h1>
      <ClinicProfile />
      <CrudSection<BranchRow>
        title={t("settings.branches")}
        endpoint="/api/masterdata/branches/"
        module="settings"
        onChanged={onBranches}
        defaults={{ is_active: true }}
        columns={[
          { label: "nameEn", render: (r) => r.name_en },
          { label: "nameAr", render: (r) => <span dir="rtl">{r.name_ar}</span> },
          { label: "phone", render: (r) => <span dir="ltr">{r.phone}</span> },
          { label: "active", render: (r) => <ActiveBadge value={r.is_active} /> },
        ]}
        fields={[
          { name: "name_en", label: "nameEn", required: true, dir: "ltr" },
          { name: "name_ar", label: "nameAr", required: true, dir: "rtl" },
          { name: "phone", label: "phone", dir: "ltr" },
          { name: "address_en", label: "settings.addressEn", type: "textarea", dir: "ltr" },
          { name: "address_ar", label: "settings.addressAr", type: "textarea", dir: "rtl" },
          { name: "is_active", label: "active", type: "checkbox" },
        ]}
      />
      <CrudSection<RoomRow>
        title={t("settings.rooms")}
        endpoint="/api/masterdata/rooms/"
        module="settings"
        onChanged={onRooms}
        defaults={{ is_active: true, branch: branches[0]?.id }}
        columns={[
          { label: "nameEn", render: (r) => r.name_en },
          { label: "nameAr", render: (r) => <span dir="rtl">{r.name_ar}</span> },
          { label: "settings.branch", render: (r) => branchName(r.branch) },
          { label: "active", render: (r) => <ActiveBadge value={r.is_active} /> },
        ]}
        fields={[
          { name: "branch", label: "settings.branch", type: "select", required: true, options: branchOptions },
          { name: "name_en", label: "nameEn", required: true, dir: "ltr" },
          { name: "name_ar", label: "nameAr", required: true, dir: "rtl" },
          { name: "is_active", label: "active", type: "checkbox" },
        ]}
      />
      <CrudSection<ChairRow>
        title={t("settings.chairs")}
        endpoint="/api/masterdata/chairs/"
        module="settings"
        defaults={{ is_active: true, branch: branches[0]?.id, sort_order: 0 }}
        columns={[
          { label: "nameEn", render: (r) => r.name_en },
          { label: "nameAr", render: (r) => <span dir="rtl">{r.name_ar}</span> },
          { label: "settings.branch", render: (r) => branchName(r.branch) },
          { label: "settings.room", render: (r) => name(rooms.find((x) => x.id === r.room)) },
          { label: "active", render: (r) => <ActiveBadge value={r.is_active} /> },
        ]}
        fields={[
          { name: "branch", label: "settings.branch", type: "select", required: true, options: branchOptions },
          { name: "room", label: "settings.room", type: "select", options: roomOptions },
          { name: "name_en", label: "nameEn", required: true, dir: "ltr" },
          { name: "name_ar", label: "nameAr", required: true, dir: "rtl" },
          { name: "sort_order", label: "settings.order", type: "number" },
          { name: "is_active", label: "active", type: "checkbox" },
        ]}
      />
      <CrudSection<HoursRow>
        title={t("settings.hours")}
        endpoint="/api/masterdata/working-hours/"
        module="settings"
        defaults={{ branch: branches[0]?.id, weekday: 5, is_closed: false, opens_at: "10:00", closes_at: "22:00" }}
        prepare={(v) => (v.is_closed ? { ...v, opens_at: null, closes_at: null } : v)}
        columns={[
          { label: "settings.branch", render: (r) => branchName(r.branch) },
          { label: "settings.day", render: (r) => t(`day.${r.weekday}` as "day.0") },
          { label: "settings.opens", render: (r) => (r.is_closed ? t("settings.closed") : <span dir="ltr">{time(r.opens_at)}</span>) },
          { label: "settings.closes", render: (r) => (r.is_closed ? "" : <span dir="ltr">{time(r.closes_at)}</span>) },
        ]}
        fields={[
          { name: "branch", label: "settings.branch", type: "select", required: true, options: branchOptions },
          { name: "weekday", label: "settings.day", type: "select", required: true, options: days },
          { name: "is_closed", label: "settings.closed", type: "checkbox" },
          { name: "opens_at", label: "settings.opens", type: "time" },
          { name: "closes_at", label: "settings.closes", type: "time" },
        ]}
      />
    </div>
  );
}
