import { useCallback, useEffect, useState, type CSSProperties, type FormEvent } from "react";
import { del, get, getAll, patch, post } from "../api";
import { useAuth } from "../auth";
import { useI18n, type TKey } from "../i18n";
import { Modal } from "../components/Crud";
import { Icon } from "../components/Icon";
import { escapeHtml, printDocument, useLetterhead } from "../components/print";
import { fmtDate, locale, money } from "../format";
import type {
  AttendanceRecord,
  DayStatus,
  EmploymentProfile,
  LeaveKind,
  LeaveRequest,
  PayItem,
  PayItemKind,
  PayoutMethod,
  PayrollLine,
  PayType,
  Payslip,
  RunStatus,
  ShiftOut,
  ShiftTemplate,
  StaffProfileRow,
  StaffRef,
} from "../types";
import { errorText, personName, useCurrency } from "./BillingParts";
import { useBranches } from "./InventoryParts";

// Staff and payroll (phase 6): labels, formatting, dialogs and printed payslips
// shared by the payroll page, the staff member's own page and the home widget.

export const PAY_TYPES: PayType[] = ["monthly", "daily", "hourly", "commission_only"];
export const PAYOUTS: PayoutMethod[] = ["cash", "bank", "wallet", "instapay"];
export const LEAVE_KINDS: LeaveKind[] = ["annual", "sick", "casual", "unpaid", "other"];
export const ADD_KINDS: PayItemKind[] = ["bonus", "allowance", "other_addition"];
export const DEDUCT_KINDS: PayItemKind[] = ["penalty", "other_deduction"];
export const WAIVABLE = ["lateness", "absence", "unpaid_leave"] as const;

export const DAY_PILL: Record<DayStatus, string> = {
  off: "pill pill-muted",
  scheduled: "pill pill-outline",
  not_in: "pill pill-warn",
  in: "pill pill-mint",
  out: "pill pill-ok",
  missing_out: "pill pill-warn",
  absent: "pill pill-warn",
  leave: "pill pill-ready",
};
export const RUN_PILL: Record<RunStatus, string> = { draft: "pill pill-outline", approved: "pill pill-ready", paid: "pill pill-mint" };
export const LEAVE_PILL: Record<string, string> = { pending: "pill pill-ready", approved: "pill pill-mint", rejected: "pill pill-muted", cancelled: "pill pill-muted" };

export function isoToday() {
  return new Date().toLocaleDateString("en-CA");
}

export function addDays(iso: string, n: number) {
  const d = new Date(`${iso}T12:00:00`);
  d.setDate(d.getDate() + n);
  return d.toLocaleDateString("en-CA");
}

export function mondayOf(iso: string) {
  const d = new Date(`${iso}T12:00:00`);
  return addDays(iso, -((d.getDay() + 6) % 7));
}

export function thisMonth() {
  return isoToday().slice(0, 7);
}

export function shiftMonth(month: string, n: number) {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(y, m - 1 + n, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export function monthLabel(iso: string, lang: string, short = false) {
  const [y, m] = iso.split("-").map(Number);
  return new Date(y, m - 1, 15).toLocaleDateString(locale(lang), { month: short ? "short" : "long", year: short ? "2-digit" : "numeric" });
}

export function dayLabel(iso: string, lang: string) {
  return new Date(`${iso}T12:00:00`).toLocaleDateString(locale(lang), { weekday: "short", day: "numeric", month: "short" });
}

/** "2h 05m" style durations, in the reader's language. */
export function useHm() {
  const { t, lang } = useI18n();
  return useCallback(
    (minutes: number) => {
      const m = Math.max(0, Math.round(minutes));
      const h = Math.floor(m / 60);
      const rest = m % 60;
      const n = (x: number) => x.toLocaleString(locale(lang));
      if (!h) return t("pr.mins", { n: n(rest) });
      return rest ? t("pr.hm", { h: n(h), m: n(rest) }) : t("pr.hours", { n: n(h) });
    },
    [t, lang],
  );
}

export function initials(p: { ar: string; en: string }, lang: string) {
  return personName(p, lang)
    .replace(/^(د\.|Dr\.?)\s*/i, "")
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase();
}

export function Avatar({ staff, size = 36 }: { staff: StaffRef; size?: number }) {
  const { lang } = useI18n();
  return (
    <span className="staff-avatar" style={{ width: size, height: size, ...(staff.color ? { background: staff.color } : {}) }} aria-hidden="true">
      {initials(staff, lang)}
    </span>
  );
}

export function shiftText(s: ShiftOut) {
  return `${s.start}–${s.end}`;
}

/** Everyone in the staff directory with their pay profile and leave balance. */
export function useStaffRows(version = 0, all = false) {
  const [rows, setRows] = useState<StaffProfileRow[] | null>(null);
  useEffect(() => {
    get<StaffProfileRow[]>(`/api/staff/profiles/${all ? "?all=1" : ""}`).then(setRows).catch(() => setRows([]));
  }, [version, all]);
  return rows;
}

export function useShiftTemplates(version = 0) {
  const [rows, setRows] = useState<ShiftTemplate[]>([]);
  useEffect(() => {
    getAll<ShiftTemplate>("/api/staff/shifts/").then(setRows).catch(() => setRows([]));
  }, [version]);
  return rows;
}

export function StaffSelect({ value, onChange, rows, required, allLabel }: { value: number | ""; onChange: (v: number | "") => void; rows: StaffProfileRow[] | null; required?: boolean; allLabel?: string }) {
  const { lang } = useI18n();
  return (
    <select value={value} required={required} onChange={(e) => onChange(e.target.value ? Number(e.target.value) : "")}>
      <option value="">{allLabel ?? "—"}</option>
      {(rows ?? []).map((s) => (
        <option key={s.id} value={s.id}>{personName(s, lang)}</option>
      ))}
    </select>
  );
}

/* ------------------------------------------------------------- roster cell */

export function RosterCellDialog({ staff, day, shifts, onClose, onChanged }: { staff: StaffRef; day: string; shifts: ShiftOut[]; onClose: () => void; onChanged: () => void }) {
  const { t, lang, name } = useI18n();
  const { can } = useAuth();
  const templates = useShiftTemplates();
  const branches = useBranches();
  const [mode, setMode] = useState<"template" | "custom">("template");
  const [template, setTemplate] = useState<number | null>(null);
  const [start, setStart] = useState("10:00");
  const [end, setEnd] = useState("18:00");
  const [brk, setBrk] = useState("0");
  const [branch, setBranch] = useState<number | "">("");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const active = templates.filter((x) => x.is_active);
  useEffect(() => {
    if (!active.length) setMode("custom");
  }, [active.length]);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const body: Record<string, unknown> = { staff: staff.id, date: day, note };
      if (mode === "template") {
        if (!template) throw new Error(t("pr.roster.pickShift"));
        body.template = template;
      } else Object.assign(body, { start_time: start, end_time: end, break_minutes: Number(brk) || 0 });
      if (branch) body.branch = branch;
      await post("/api/staff/roster/", body);
      onChanged();
      onClose();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  const remove = async (s: ShiftOut) => {
    try {
      await del(`/api/staff/roster/${s.id}/`);
      onChanged();
      onClose();
    } catch (err) {
      setError(errorText(err));
    }
  };
  return (
    <Modal title={`${personName(staff, lang)} · ${dayLabel(day, lang)}`} onClose={onClose}>
      {shifts.length > 0 && (
        <ul className="plain-list roster-existing">
          {shifts.map((s) => (
            <li key={s.id}>
              <span className="shift-chip" style={s.color ? { "--chip-c": s.color } as CSSProperties : undefined}>
                {s.name ? personName(s.name, lang) : t("pr.roster.custom")} · <span dir="ltr">{shiftText(s)}</span>
              </span>
              <span className="grow" />
              {can("staff", "delete") && (
                <button className="btn btn-small" onClick={() => void remove(s)}>{t("pr.roster.remove")}</button>
              )}
            </li>
          ))}
        </ul>
      )}
      {can("staff", "create") && (
        <form className="form-grid" onSubmit={save}>
          <div className="segmented" role="group">
            <button type="button" aria-pressed={mode === "template"} onClick={() => setMode("template")} disabled={!active.length}>{t("pr.roster.fromShift")}</button>
            <button type="button" aria-pressed={mode === "custom"} onClick={() => setMode("custom")}>{t("pr.roster.customHours")}</button>
          </div>
          {mode === "template" ? (
            <div className="choice-row">
              {active.map((x) => (
                <button type="button" key={x.id} className={`choice shift-choice ${template === x.id ? "active" : ""}`} style={x.color ? { "--chip-c": x.color } as CSSProperties : undefined} onClick={() => setTemplate(x.id)}>
                  {name(x)} · <span dir="ltr">{x.start_time.slice(0, 5)}–{x.end_time.slice(0, 5)}</span>
                </button>
              ))}
            </div>
          ) : (
            <div className="form-grid form-grid-3">
              <label className="field"><span className="field-label">{t("pr.starts")}</span><input type="time" value={start} onChange={(e) => setStart(e.target.value)} required /></label>
              <label className="field"><span className="field-label">{t("pr.ends")}</span><input type="time" value={end} onChange={(e) => setEnd(e.target.value)} required /></label>
              <label className="field"><span className="field-label">{t("pr.breakMin")}</span><input type="number" min="0" value={brk} onChange={(e) => setBrk(e.target.value)} /></label>
            </div>
          )}
          <div className="form-grid form-grid-2">
            {branches.length > 1 && (
              <label className="field">
                <span className="field-label">{t("ap.branch")}</span>
                <select value={branch} onChange={(e) => setBranch(e.target.value ? Number(e.target.value) : "")}>
                  <option value="">{t("pr.roster.shiftBranch")}</option>
                  {branches.map((b) => <option key={b.id} value={b.id}>{name(b)}</option>)}
                </select>
              </label>
            )}
            <label className="field"><span className="field-label">{t("notes")}</span><input value={note} onChange={(e) => setNote(e.target.value)} /></label>
          </div>
          {error && <p className="form-error" role="alert">{error}</p>}
          <div className="form-actions">
            <button type="button" className="btn" onClick={onClose}>{t("cancel")}</button>
            <button className="btn btn-primary" disabled={busy}>{t("pr.roster.assign")}</button>
          </div>
        </form>
      )}
    </Modal>
  );
}

/* ---------------------------------------------------------- attendance edit */

export function RecordDialog({ record, staffRows, defaults, onClose, onSaved }: { record: AttendanceRecord | null; staffRows: StaffProfileRow[] | null; defaults?: { staff?: number; date?: string }; onClose: () => void; onSaved: () => void }) {
  const { t, lang } = useI18n();
  const [staff, setStaff] = useState<number | "">(record?.staff ?? defaults?.staff ?? "");
  const [day, setDay] = useState(record?.date ?? defaults?.date ?? isoToday());
  const [inTime, setIn] = useState(record?.in_local ?? "10:00");
  const [outTime, setOut] = useState(record?.out_local ?? "");
  const [note, setNote] = useState(record?.note ?? "");
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const body = { staff, date: day, in_time: inTime, out_time: outTime || null, note, reason };
      if (record) await patch(`/api/staff/attendance/${record.id}/`, body);
      else await post("/api/staff/attendance/", body);
      onSaved();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    const why = window.prompt(t("pr.att.deleteWhy"));
    if (!why?.trim()) return;
    try {
      await del(`/api/staff/attendance/${record!.id}/?reason=${encodeURIComponent(why.trim())}`);
      onSaved();
    } catch (err) {
      setError(errorText(err));
    }
  };
  return (
    <Modal title={record ? `${t("pr.att.edit")} · ${personName(record.staff_info, lang)}` : t("pr.att.add")} onClose={onClose}>
      <form className="form-grid" onSubmit={save}>
        <div className="form-grid form-grid-2">
          <label className="field">
            <span className="field-label">{t("pr.person")}</span>
            <StaffSelect value={staff} onChange={setStaff} rows={staffRows} required />
          </label>
          <label className="field"><span className="field-label">{t("date")}</span><input type="date" value={day} max={isoToday()} onChange={(e) => setDay(e.target.value)} required /></label>
          <label className="field"><span className="field-label">{t("pr.clockedIn")}</span><input type="time" value={inTime} onChange={(e) => setIn(e.target.value)} required /></label>
          <label className="field"><span className="field-label">{t("pr.clockedOut")}</span><input type="time" value={outTime} onChange={(e) => setOut(e.target.value)} /></label>
        </div>
        <p className="field-hint">{t("pr.att.nightHint")}</p>
        <label className="field"><span className="field-label">{t("notes")}</span><input value={note} onChange={(e) => setNote(e.target.value)} /></label>
        <label className="field">
          <span className="field-label">{t("pr.att.reason")}</span>
          <input value={reason} onChange={(e) => setReason(e.target.value)} required placeholder={t("pr.att.reasonHint")} />
        </label>
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="form-actions">
          {record && <button type="button" className="btn btn-danger" onClick={() => void remove()}>{t("delete")}</button>}
          <span className="grow" />
          <button type="button" className="btn" onClick={onClose}>{t("cancel")}</button>
          <button className="btn btn-primary" disabled={busy}>{t("save")}</button>
        </div>
      </form>
    </Modal>
  );
}

/* ------------------------------------------------------------------- leave */

export function LeaveDialog({ staffRows, self = false, onClose, onSaved }: { staffRows?: StaffProfileRow[] | null; self?: boolean; onClose: () => void; onSaved: (l: LeaveRequest) => void }) {
  const { t } = useI18n();
  const [staff, setStaff] = useState<number | "">("");
  const [kind, setKind] = useState<LeaveKind>("annual");
  const [start, setStart] = useState(isoToday());
  const [end, setEnd] = useState(isoToday());
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const body = { kind, start_date: start, end_date: end, reason };
      const saved = self ? await post<LeaveRequest>("/api/staff/me/leave/", body) : await post<LeaveRequest>("/api/staff/leave/", { ...body, staff });
      onSaved(saved);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={t("pr.leave.new")} onClose={onClose}>
      <form className="form-grid" onSubmit={save}>
        {!self && (
          <label className="field">
            <span className="field-label">{t("pr.person")}</span>
            <StaffSelect value={staff} onChange={setStaff} rows={staffRows ?? null} required />
          </label>
        )}
        <fieldset className="choice-field">
          <legend>{t("pr.leave.kind")}</legend>
          <div className="choice-row">
            {LEAVE_KINDS.map((k) => (
              <button type="button" key={k} className={`choice ${kind === k ? "active" : ""}`} onClick={() => setKind(k)}>{t(`pr.leave.${k}` as TKey)}</button>
            ))}
          </div>
        </fieldset>
        <div className="form-grid form-grid-2">
          <label className="field"><span className="field-label">{t("com.from")}</span><input type="date" value={start} onChange={(e) => { setStart(e.target.value); if (e.target.value > end) setEnd(e.target.value); }} required /></label>
          <label className="field"><span className="field-label">{t("com.to")}</span><input type="date" value={end} min={start} onChange={(e) => setEnd(e.target.value)} required /></label>
        </div>
        <label className="field"><span className="field-label">{t("pr.leave.reason")}</span><input value={reason} onChange={(e) => setReason(e.target.value)} /></label>
        {kind === "unpaid" && <p className="notice pad-sm small">{t("pr.leave.unpaidHint")}</p>}
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="form-actions">
          <button type="button" className="btn" onClick={onClose}>{t("cancel")}</button>
          <button className="btn btn-primary" disabled={busy}>{self ? t("pr.leave.send") : t("save")}</button>
        </div>
      </form>
    </Modal>
  );
}

/* ---------------------------------------------------------------- advances */

export function AdvanceDialog({ staffRows, onClose, onSaved }: { staffRows: StaffProfileRow[] | null; onClose: () => void; onSaved: () => void }) {
  const { t, lang } = useI18n();
  const currency = useCurrency();
  const [staff, setStaff] = useState<number | "">("");
  const [day, setDay] = useState(isoToday());
  const [amount, setAmount] = useState("");
  const [installment, setInstallment] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const months = Number(amount) > 0 && Number(installment) > 0 ? Math.ceil(Number(amount) / Number(installment)) : 0;
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await post("/api/staff/advances/", { staff, date: day, amount, monthly_installment: installment, reason });
      onSaved();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={t("pr.adv.new")} onClose={onClose}>
      <form className="form-grid" onSubmit={save}>
        <div className="form-grid form-grid-2">
          <label className="field">
            <span className="field-label">{t("pr.person")}</span>
            <StaffSelect value={staff} onChange={setStaff} rows={staffRows} required />
          </label>
          <label className="field"><span className="field-label">{t("date")}</span><input type="date" value={day} onChange={(e) => setDay(e.target.value)} required /></label>
          <label className="field"><span className="field-label">{t("pr.adv.amount", { cur: currency })}</span><input className="amount-input" type="number" min="1" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} required dir="ltr" /></label>
          <label className="field"><span className="field-label">{t("pr.adv.installment", { cur: currency })}</span><input type="number" min="1" step="0.01" value={installment} onChange={(e) => setInstallment(e.target.value)} required dir="ltr" /></label>
        </div>
        {months > 0 && <p className="bill-total"><span>{t("pr.adv.months")}</span><strong>{months.toLocaleString(locale(lang))}</strong></p>}
        <label className="field"><span className="field-label">{t("pr.leave.reason")}</span><input value={reason} onChange={(e) => setReason(e.target.value)} /></label>
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="form-actions">
          <button type="button" className="btn" onClick={onClose}>{t("cancel")}</button>
          <button className="btn btn-primary" disabled={busy}>{t("save")}</button>
        </div>
      </form>
    </Modal>
  );
}

/* ---------------------------------------------------------------- profiles */

const PROFILE_DEFAULTS: EmploymentProfile = {
  pay_type: "monthly",
  base_salary: "0",
  daily_rate: "0",
  hourly_rate: "0",
  overtime_multiplier: "1.35",
  hire_date: null,
  national_id: "",
  payout_method: "cash",
  payout_account: "",
  insured: false,
  insurable_wage: "0",
  annual_leave_days: 21,
  notes: "",
};

export function ProfileDialog({ row, onClose, onSaved }: { row: StaffProfileRow; onClose: () => void; onSaved: () => void }) {
  const { t, lang } = useI18n();
  const currency = useCurrency();
  const [v, setV] = useState<EmploymentProfile>({ ...PROFILE_DEFAULTS, ...(row.profile ?? {}) });
  const [error, setError] = useState("");
  const [fields, setFields] = useState<Record<string, string[]>>({});
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof EmploymentProfile>(k: K, value: EmploymentProfile[K]) => setV((s) => ({ ...s, [k]: value }));
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    setFields({});
    try {
      await patch(`/api/staff/profiles/${row.id}/`, { ...v, hire_date: v.hire_date || null });
      onSaved();
    } catch (err) {
      setError(errorText(err));
      const f = (err as { fields?: Record<string, string[]> }).fields;
      if (f) setFields(f);
    } finally {
      setBusy(false);
    }
  };
  const num = (k: "base_salary" | "daily_rate" | "hourly_rate" | "insurable_wage" | "overtime_multiplier", label: string, step = "0.01") => (
    <label className="field">
      <span className="field-label">{label}</span>
      <input type="number" min="0" step={step} dir="ltr" value={v[k]} onChange={(e) => set(k, e.target.value)} />
      {fields[k] && <span className="field-error">{fields[k].join(" ")}</span>}
    </label>
  );
  return (
    <Modal title={`${t("pr.prof.title")} · ${personName(row, lang)}`} onClose={onClose}>
      <form className="form-grid" onSubmit={save}>
        <fieldset className="choice-field">
          <legend>{t("pr.payType")}</legend>
          <div className="choice-row">
            {PAY_TYPES.map((p) => (
              <button type="button" key={p} className={`choice ${v.pay_type === p ? "active" : ""}`} onClick={() => set("pay_type", p)}>{t(`pr.pay.${p}` as TKey)}</button>
            ))}
          </div>
        </fieldset>
        <div className="form-grid form-grid-3">
          {v.pay_type === "monthly" && num("base_salary", t("pr.prof.salary", { cur: currency }))}
          {v.pay_type === "daily" && num("daily_rate", t("pr.prof.daily", { cur: currency }))}
          {v.pay_type === "hourly" && num("hourly_rate", t("pr.prof.hourly", { cur: currency }))}
          {v.pay_type !== "commission_only" && num("overtime_multiplier", t("pr.prof.otMultiplier"))}
          <label className="field"><span className="field-label">{t("pr.prof.hireDate")}</span><input type="date" value={v.hire_date ?? ""} onChange={(e) => set("hire_date", e.target.value || null)} /></label>
        </div>
        {v.pay_type === "commission_only" && <p className="notice pad-sm small">{t("pr.prof.commissionHint")}</p>}
        {row.commission_type !== "none" && v.pay_type !== "commission_only" && <p className="muted small">{t("pr.prof.alsoCommission")}</p>}
        <div className="form-grid form-grid-2">
          <label className="field">
            <span className="field-label">{t("pr.prof.nationalId")}</span>
            <input dir="ltr" inputMode="numeric" maxLength={14} value={v.national_id} onChange={(e) => set("national_id", e.target.value.replace(/\D/g, ""))} />
            {fields.national_id && <span className="field-error">{fields.national_id.join(" ")}</span>}
          </label>
          <label className="field"><span className="field-label">{t("pr.prof.leaveDays")}</span><input type="number" min="0" max="60" value={v.annual_leave_days} onChange={(e) => set("annual_leave_days", Number(e.target.value))} /></label>
        </div>
        <fieldset className="choice-field">
          <legend>{t("pr.payout")}</legend>
          <div className="method-picker">
            {PAYOUTS.map((m) => (
              <button type="button" key={m} className={`method ${v.payout_method === m ? "active" : ""}`} onClick={() => set("payout_method", m)}>{t(`pr.payout.${m}` as TKey)}</button>
            ))}
          </div>
        </fieldset>
        {v.payout_method !== "cash" && (
          <label className="field"><span className="field-label">{t("pr.prof.account")}</span><input dir="ltr" value={v.payout_account} onChange={(e) => set("payout_account", e.target.value)} /></label>
        )}
        <div className="field field-check">
          <input id="pr-insured" type="checkbox" checked={v.insured} onChange={(e) => set("insured", e.target.checked)} />
          <label htmlFor="pr-insured">{t("pr.prof.insured")}</label>
        </div>
        {v.insured && (
          <div className="form-grid form-grid-2">
            {num("insurable_wage", t("pr.prof.insurableWage", { cur: currency }))}
            <p className="field-hint">{t("pr.prof.insurableHint")}</p>
          </div>
        )}
        <label className="field"><span className="field-label">{t("notes")}</span><textarea rows={2} value={v.notes} onChange={(e) => set("notes", e.target.value)} /></label>
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="form-actions">
          <button type="button" className="btn" onClick={onClose}>{t("cancel")}</button>
          <button className="btn btn-primary" disabled={busy}>{t("save")}</button>
        </div>
      </form>
    </Modal>
  );
}

/* ------------------------------------------------------------- line editor */

export function LineEditor({ line, editable, onClose, onSaved, onPrint }: { line: PayrollLine; editable: boolean; onClose: () => void; onSaved: (l: PayrollLine) => void; onPrint: () => void }) {
  const { t, lang } = useI18n();
  const currency = useCurrency();
  const hm = useHm();
  const [items, setItems] = useState<PayItem[]>(line.items.filter((i) => i.is_manual).map((i) => ({ kind: i.kind, label: i.label, amount: i.amount })));
  const [tax, setTax] = useState(line.income_tax);
  const [method, setMethod] = useState<PayoutMethod>(line.payout_method);
  const [note, setNote] = useState(line.note);
  const [waived, setWaived] = useState<string[]>(line.waived);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const f = line.figures;
  const m = (v: string | number) => money(v, lang);
  const auto = line.items.filter((i) => !i.is_manual);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const body: Record<string, unknown> = { items: items.filter((i) => Number(i.amount) > 0), income_tax: tax || "0", payout_method: method, note };
      if (waived.join() !== line.waived.join()) body.waived = waived;
      onSaved(await patch<PayrollLine>(`/api/staff/payroll/lines/${line.id}/`, body));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  const setItem = (i: number, patchItem: Partial<PayItem>) => setItems((rows) => rows.map((r, k) => (k === i ? { ...r, ...patchItem } : r)));
  const facts: [string, string][] = [
    [t("pr.f.rate"), line.pay_type === "commission_only" ? "—" : `${m(line.rate)} ${currency}`],
    [t("pr.f.daysWorked"), String(f.days_worked ?? 0)],
    [t("pr.f.hoursWorked"), hm(f.worked_minutes ?? 0)],
    [t("pr.f.late"), f.late_minutes ? `${hm(f.late_minutes)} · ${t("pr.f.daysN", { n: f.late_days })}` : "—"],
    [t("pr.f.overtime"), f.overtime_minutes ? hm(f.overtime_minutes) : "—"],
    [t("pr.f.absent"), String(f.absent_days ?? 0)],
    [t("pr.f.unpaid"), String(f.unpaid_leave_days ?? 0)],
    [t("pr.f.hourly"), `${m(f.hourly_equivalent ?? 0)} ${currency}`],
  ];
  return (
    <Modal title={`${personName(line.staff_info, lang)} · ${monthLabel(line.period, lang)}`} onClose={onClose}>
      <div className="line-editor">
        <dl className="pr-facts">
          {facts.map(([k, val]) => (
            <div key={k}><dt>{k}</dt><dd>{val}</dd></div>
          ))}
        </dl>
        <section className="pr-sums">
          <div><span>{t("pr.base")}</span><strong>{m(line.base_pay)}</strong></div>
          <div><span>{t("pr.overtimePay")}</span><strong>{m(line.overtime_pay)}</strong></div>
          <div><span>{t("pr.commission")}</span><strong>{m(line.commission)}</strong></div>
          {line.commission_note && <p className="small owed span-all">{t("pr.commissionTaken")}</p>}
          {line.commission_start && Number(line.commission) > 0 && line.commission_start.slice(0, 7) !== line.period.slice(0, 7) && (
            <p className="small muted span-all">{t("pr.commissionFor", { month: monthLabel(line.commission_start, lang) })}</p>
          )}
        </section>
        <h3 className="sub-head">{t("pr.workedOut")}</h3>
        <ul className="plain-list pr-auto">
          {WAIVABLE.map((k) => {
            const amount = f.worked_out?.[k] ?? "0";
            if (!Number(amount)) return null;
            const off = waived.includes(k);
            return (
              <li key={k} className={off ? "is-waived" : ""}>
                <span className="grow">{t(`pr.item.${k}` as TKey)}</span>
                <span className="num">−{m(amount)}</span>
                {editable && (
                  <button type="button" className="btn btn-small" onClick={() => setWaived((w) => (off ? w.filter((x) => x !== k) : [...w, k]))}>
                    {off ? t("pr.restore") : t("pr.waive")}
                  </button>
                )}
              </li>
            );
          })}
          {auto.filter((i) => i.kind === "advance").map((i) => (
            <li key={i.id}><span className="grow">{t("pr.item.advance")}</span><span className="num">−{m(i.amount)}</span></li>
          ))}
          {Number(line.employee_insurance) > 0 && (
            <li><span className="grow">{t("pr.insurance")}</span><span className="num">−{m(line.employee_insurance)}</span></li>
          )}
          {!WAIVABLE.some((k) => Number(f.worked_out?.[k] ?? 0)) && !auto.length && !Number(line.employee_insurance) && <li className="muted small">{t("pr.noAuto")}</li>}
        </ul>
        <form className="form-grid" onSubmit={save}>
          <h3 className="sub-head">{t("pr.manual")}</h3>
          {items.map((it, i) => (
            <div key={i} className="pr-item-row">
              <select value={it.kind} disabled={!editable} onChange={(e) => setItem(i, { kind: e.target.value as PayItemKind })} aria-label={t("pr.kind")}>
                <optgroup label={t("pr.additions")}>{ADD_KINDS.map((k) => <option key={k} value={k}>{t(`pr.item.${k}` as TKey)}</option>)}</optgroup>
                <optgroup label={t("pr.deductions")}>{DEDUCT_KINDS.map((k) => <option key={k} value={k}>{t(`pr.item.${k}` as TKey)}</option>)}</optgroup>
              </select>
              <input value={it.label} disabled={!editable} placeholder={t("pr.itemLabel")} onChange={(e) => setItem(i, { label: e.target.value })} aria-label={t("pr.itemLabel")} />
              <input type="number" min="0" step="0.01" dir="ltr" disabled={!editable} value={it.amount} onChange={(e) => setItem(i, { amount: e.target.value })} aria-label={t("bill.amount", { cur: currency })} />
              {editable && (
                <button type="button" className="btn btn-icon btn-small" aria-label={t("pr.roster.remove")} onClick={() => setItems((rows) => rows.filter((_, k) => k !== i))}>
                  <Icon name="close" size={16} />
                </button>
              )}
            </div>
          ))}
          {editable && (
            <div className="toolbar">
              <button type="button" className="btn btn-small" onClick={() => setItems((r) => [...r, { kind: "bonus", label: "", amount: "" }])}>+ {t("pr.addAddition")}</button>
              <button type="button" className="btn btn-small" onClick={() => setItems((r) => [...r, { kind: "penalty", label: "", amount: "" }])}>+ {t("pr.addDeduction")}</button>
            </div>
          )}
          <div className="form-grid form-grid-2">
            <label className="field">
              <span className="field-label">{t("pr.incomeTax", { cur: currency })}</span>
              <input type="number" min="0" step="0.01" dir="ltr" disabled={!editable} value={tax} onChange={(e) => setTax(e.target.value)} />
              <span className="field-hint">{t("pr.taxHint")}</span>
            </label>
            <label className="field">
              <span className="field-label">{t("pr.payout")}</span>
              <select value={method} disabled={!editable} onChange={(e) => setMethod(e.target.value as PayoutMethod)}>
                {PAYOUTS.map((p) => <option key={p} value={p}>{t(`pr.payout.${p}` as TKey)}</option>)}
              </select>
            </label>
          </div>
          <label className="field"><span className="field-label">{t("notes")}</span><input value={note} disabled={!editable} onChange={(e) => setNote(e.target.value)} /></label>
          <p className="bill-total"><span>{t("pr.net")}</span><strong>{m(line.net)} <small>{currency}</small></strong></p>
          {Number(line.employer_insurance) > 0 && <p className="muted small">{t("pr.employerNote", { n: m(line.employer_insurance), cur: currency })}</p>}
          {error && <p className="form-error" role="alert">{error}</p>}
          <div className="form-actions">
            <button type="button" className="btn" onClick={onPrint}><Icon name="file" size={16} /> {t("pr.payslip")}</button>
            <span className="grow" />
            <button type="button" className="btn" onClick={onClose}>{t("close")}</button>
            {editable && <button className="btn btn-primary" disabled={busy}>{t("save")}</button>}
          </div>
        </form>
      </div>
    </Modal>
  );
}

/* ---------------------------------------------------------------- payslips */

/** Printed payslips (قسيمة راتب) on the clinic letterhead, one per page. */
export function usePayslipPrint() {
  const { t, lang } = useI18n();
  const letterhead = useLetterhead(lang);
  const currency = useCurrency();
  const hm = useHm();
  const m = (v: string | number) => money(v, lang);

  const slipBody = (p: Payslip) => {
    const l = p.line;
    const f = l.figures;
    const earn: [string, string][] = [[t("pr.base"), l.base_pay]];
    if (Number(l.overtime_pay)) earn.push([`${t("pr.overtimePay")} (${hm(f.overtime_minutes)})`, l.overtime_pay]);
    if (Number(l.commission)) earn.push([t("pr.commission"), l.commission]);
    for (const i of l.items.filter((x) => x.direction === "add")) earn.push([i.label || t(`pr.item.${i.kind}` as TKey), i.amount]);
    const ded: [string, string][] = [];
    for (const i of l.items.filter((x) => x.direction === "deduct")) {
      const label = i.is_manual ? i.label || t(`pr.item.${i.kind}` as TKey) : t(`pr.item.${i.kind}` as TKey);
      const extra = i.kind === "lateness" ? ` (${hm(f.late_minutes)})` : i.kind === "absence" ? ` (${t("pr.f.daysN", { n: f.absent_days })})` : i.kind === "unpaid_leave" ? ` (${t("pr.f.daysN", { n: f.unpaid_leave_days })})` : "";
      ded.push([label + extra, i.amount]);
    }
    if (Number(l.employee_insurance)) ded.push([t("pr.insurance"), l.employee_insurance]);
    if (Number(l.income_tax)) ded.push([t("pr.incomeTaxShort"), l.income_tax]);
    const rows = (list: [string, string][]) =>
      list.map(([k, v]) => `<tr><td>${escapeHtml(k)}</td><td style="text-align:end">${m(v)}</td></tr>`).join("") || `<tr><td colspan="2" style="color:#5A6B7B">—</td></tr>`;
    const facts = [
      [t("pr.f.daysWorked"), String(f.days_worked ?? 0)],
      [t("pr.f.hoursWorked"), hm(f.worked_minutes ?? 0)],
      [t("pr.f.absent"), String(f.absent_days ?? 0)],
      [t("pr.f.late"), f.late_minutes ? hm(f.late_minutes) : "—"],
    ];
    return `<div class="slip">
<table style="margin-bottom:14px"><tbody><tr>${facts.map(([k, v]) => `<td><div style="font-size:11px;color:#5A6B7B">${escapeHtml(k)}</div><strong>${escapeHtml(v)}</strong></td>`).join("")}</tr></tbody></table>
<div style="display:grid;grid-template-columns:1fr 1fr;gap:18px">
<table><thead><tr><th>${escapeHtml(t("pr.earnings"))}</th><th style="text-align:end">${escapeHtml(currency)}</th></tr></thead><tbody>${rows(earn)}</tbody><tfoot><tr><td><strong>${escapeHtml(t("pr.gross"))}</strong></td><td style="text-align:end"><strong>${m(l.gross)}</strong></td></tr></tfoot></table>
<table><thead><tr><th>${escapeHtml(t("pr.deductions"))}</th><th style="text-align:end">${escapeHtml(currency)}</th></tr></thead><tbody>${rows(ded)}</tbody><tfoot><tr><td><strong>${escapeHtml(t("pr.totalDeductions"))}</strong></td><td style="text-align:end"><strong>${m(l.total_deductions)}</strong></td></tr></tfoot></table>
</div>
<p style="margin:18px 0 6px;padding:12px 16px;border-radius:10px;background:#E6EDF3;display:flex;justify-content:space-between;font-size:18px"><span>${escapeHtml(t("pr.net"))}</span><strong>${m(l.net)} ${escapeHtml(currency)}</strong></p>
<p style="font-size:12px;color:#3A4B5A;margin:4px 0">${escapeHtml(t("pr.payout"))}: ${escapeHtml(t(`pr.payout.${l.payout_method}` as TKey))}${l.payout_account ? ` · <span dir="ltr">${escapeHtml(l.payout_account)}</span>` : ""}${p.run.paid_on ? ` · ${escapeHtml(t("pr.paidOn", { date: fmtDate(p.run.paid_on, lang) }))}` : ""}</p>
${Number(l.employer_insurance) ? `<p style="font-size:12px;color:#5A6B7B;margin:4px 0">${escapeHtml(t("pr.employerNote", { n: m(l.employer_insurance), cur: currency }))}</p>` : ""}
${Number(p.advances_remaining) ? `<p style="font-size:12px;color:#5A6B7B;margin:4px 0">${escapeHtml(t("pr.advLeft", { n: m(p.advances_remaining), cur: currency }))}</p>` : ""}
${l.note ? `<p class="body">${escapeHtml(l.note)}</p>` : ""}
<div class="sign"><div class="line">${escapeHtml(t("pr.signEmployee"))}</div><div class="line">${escapeHtml(t("pr.signAccountant"))}</div></div>
</div>`;
  };
  const who = (p: Payslip) =>
    [escapeHtml(personName(p.staff, lang)), escapeHtml(t(`staff.type.${p.staff.staff_type}` as TKey)), p.staff.national_id ? `<span dir="ltr">${escapeHtml(p.staff.national_id)}</span>` : "", escapeHtml(monthLabel(p.run.period, lang))]
      .filter(Boolean)
      .join(" · ");

  const one = (p: Payslip) =>
    printDocument({ title: `${t("pr.payslip")} · ${monthLabel(p.run.period, lang)}`, lang, clinic: letterhead, patient: who(p), body: slipBody(p), footer: "" });

  const many = (slips: Payslip[], period: string) => {
    if (!slips.length) return;
    const body = slips
      .map((p, i) => `<section style="${i ? "page-break-before:always;break-before:page;padding-top:8px" : ""}"><h2 style="font-size:17px;margin:0 0 4px">${who(p)}</h2>${slipBody(p)}</section>`)
      .join("");
    printDocument({ title: `${t("pr.payslips")} · ${monthLabel(period, lang)}`, lang, clinic: letterhead, patient: t("pr.peopleN", { n: slips.length }), body, footer: "" });
  };
  return { one, many };
}
