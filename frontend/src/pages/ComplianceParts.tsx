import { useEffect, useState } from "react";
import { get, getAll, type Page } from "../api";
import { useI18n, type TKey } from "../i18n";
import { Icon } from "../components/Icon";
import { locale } from "../format";
import type { Named, PatientInfo } from "./ComplianceTypes";

// Small pieces shared by the compliance, e-invoice and online booking screens.

export function nm(n: Named | { en: string; ar: string } | null | undefined, lang: string) {
  return n ? (lang === "ar" ? n.ar || n.en : n.en || n.ar) : "";
}

export function fmtDateTime(iso: string | null | undefined, lang: string) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(locale(lang), { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

export function fmtTime(iso: string, lang: string) {
  return new Date(iso).toLocaleTimeString(locale(lang), { hour: "2-digit", minute: "2-digit" });
}

export function isoToday() {
  return new Date().toLocaleDateString("en-CA");
}

export function addDaysIso(iso: string, days: number) {
  const d = new Date(`${iso}T12:00:00`);
  d.setDate(d.getDate() + days);
  return d.toLocaleDateString("en-CA");
}

/** Pill classes per state; red stays for medical alerts, so problems use amber. */
export const STATE_PILL: Record<string, string> = {
  pass: "pill pill-ok",
  fail: "pill pill-warn co-pill-fail",
  ok: "pill pill-ok",
  due_soon: "pill pill-ready",
  overdue: "pill pill-warn co-pill-fail",
  expiring: "pill pill-ready",
  expired: "pill pill-warn co-pill-fail",
  sterile: "pill pill-ok",
  used: "pill pill-outline",
  failed: "pill pill-warn co-pill-fail",
  none: "pill pill-muted",
  in_service: "pill pill-ok",
  out_of_service: "pill pill-warn co-pill-fail",
  retired: "pill pill-muted",
  open: "pill pill-ready",
  in_progress: "pill pill-update",
  waiting_parts: "pill pill-warn",
  done: "pill pill-ok",
  cancelled: "pill pill-muted",
  draft: "pill pill-warn",
  ready: "pill pill-ready",
  submitted: "pill pill-update",
  valid: "pill pill-ok",
  invalid: "pill pill-warn co-pill-fail",
  rejected: "pill pill-warn co-pill-fail",
  pending: "pill pill-ready",
  confirmed: "pill pill-ok",
  negative: "pill pill-ok",
  positive: "pill pill-warn co-pill-fail",
};

export function StatePill({ state, label }: { state: string; label: string }) {
  return <span className={STATE_PILL[state] ?? "pill"}>{label}</span>;
}

export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: { id: T; label: string; n?: number; warn?: boolean }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="chip-row" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.id} className={`chip ${value === o.id ? "active" : ""} ${o.warn && o.n ? "warn" : ""}`} aria-pressed={value === o.id} onClick={() => onChange(o.id)}>
          {o.label}
          {o.n !== undefined && <span className="chip-count">{o.n}</span>}
        </button>
      ))}
    </div>
  );
}

export interface BranchRow {
  id: number;
  name_en: string;
  name_ar: string;
  is_active: boolean;
}

export function useBranches() {
  const [rows, setRows] = useState<BranchRow[]>([]);
  useEffect(() => {
    getAll<BranchRow>("/api/masterdata/branches/").then((r) => setRows(r.filter((b) => b.is_active))).catch(() => setRows([]));
  }, []);
  return rows;
}

/** Find a patient by name, phone or file number. */
export function PatientPicker({ value, onChange }: { value: PatientInfo | null; onChange: (p: PatientInfo | null) => void }) {
  const { t, lang } = useI18n();
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<PatientInfo[]>([]);
  useEffect(() => {
    if (q.trim().length < 2) {
      setRows([]);
      return;
    }
    const timer = window.setTimeout(() => {
      get<Page<{ id: number; name_ar: string; name_en: string; file_number: string; phone: string }>>(`/api/patients/?search=${encodeURIComponent(q.trim())}`)
        .then((p) => setRows(p.results.slice(0, 8).map((x) => ({ id: x.id, ar: x.name_ar, en: x.name_en, file_number: x.file_number, phone: x.phone }))))
        .catch(() => setRows([]));
    }, 250);
    return () => window.clearTimeout(timer);
  }, [q]);
  if (value)
    return (
      <div className="co-picked">
        <span>
          <strong>{nm(value, lang)}</strong> <span className="muted mono small">{value.file_number}</span>
        </span>
        <button type="button" className="btn btn-small" onClick={() => onChange(null)}>
          {t("co.change")}
        </button>
      </div>
    );
  return (
    <div className="co-picker">
      <label className="top-search search-field">
        <Icon name="search" />
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("pt.searchHint")} aria-label={t("co.findPatient")} />
      </label>
      {rows.length > 0 && (
        <ul className="co-picker-list" role="listbox">
          {rows.map((p) => (
            <li key={p.id}>
              <button type="button" onClick={() => onChange(p)}>
                <strong>{nm(p, lang)}</strong> <span className="muted mono small">{p.file_number}</span> <span className="muted small" dir="ltr">{p.phone}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function Empty({ text }: { text: TKey }) {
  const { t } = useI18n();
  return <p className="muted pad">{t(text)}</p>;
}
