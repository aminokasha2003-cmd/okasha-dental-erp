import { useCallback, useEffect, useState, type CSSProperties, type FormEvent, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { ApiError, get, getAll, patch, post } from "../api";
import { useAuth } from "../auth";
import { useI18n, type TKey } from "../i18n";
import { Modal, RecordForm } from "../components/Crud";
import { Icon } from "../components/Icon";
import { cleanPatient, patientFields } from "../components/patientFields";
import { fmtDate, money } from "../format";
import type { Appointment, Patient, Procedure, StaffMember } from "../types";
import { AppointmentDialog } from "./Appointments";
import { errorText, personName, useCurrency } from "./BillingParts";
import { useChoices } from "./Patients";

// Shared CRM pieces: lead form and lead view, the recall contact form, the
// campaign builder and campaign results, and the CRM section of the patient file.

export type LeadStage = "new" | "contacted" | "consultation" | "accepted" | "won" | "lost";
export const STAGES: LeadStage[] = ["new", "contacted", "consultation", "accepted", "won", "lost"];
export const OPEN_STAGES: LeadStage[] = ["new", "contacted", "consultation", "accepted"];
export const SOURCES = ["phone", "walk_in", "whatsapp", "facebook", "instagram", "website", "referral", "google", "other"];
export const LOST_REASONS = ["price", "no_answer", "other_clinic", "not_ready", "distance", "other"];
export const OUTCOMES = ["no_answer", "booked", "call_later", "declined", "messaged"];
const ACTIVITY_KINDS = ["call", "whatsapp", "sms", "visit", "note"];

type Named = { ar: string; en: string };
export interface Lead {
  id: number;
  name_ar: string;
  name_en: string;
  phone: string;
  gender: string;
  language: "ar" | "en";
  whatsapp_opt_in: boolean;
  source: string;
  referred_by: string;
  interest: number | null;
  interest_info: (Named & { id: number; code: string; price: string }) | null;
  interest_text: string;
  estimated_value: string;
  assigned_to: number | null;
  assigned_info: (Named & { id: number }) | null;
  branch: number | null;
  stage: LeadStage;
  stage_changed_at: string | null;
  lost_reason: string;
  next_follow_up: string | null;
  follow_up_due: boolean;
  notes: string;
  patient: number | null;
  patient_info: (Named & { id: number; file_number: string }) | null;
  converted_at: string | null;
  consultation: number | null;
  last_activity: { kind: string; text: string; at: string } | null;
  created_at: string;
}
interface Activity {
  id: number;
  kind: string;
  text: string;
  stage_from: string;
  stage_to: string;
  author: string;
  created_at: string;
}
interface Duplicates {
  patients: (Named & { id: number; file_number: string; phone: string })[];
  leads: (Named & { id: number; phone: string; stage: LeadStage })[];
}

export function leadName(l: { name_ar: string; name_en: string }, lang: string) {
  return (lang === "ar" ? l.name_ar || l.name_en : l.name_en || l.name_ar) || "—";
}
export function interestLabel(l: Lead, lang: string) {
  return l.interest_info ? personName(l.interest_info, lang) : l.interest_text;
}
export function today() {
  return new Date().toLocaleDateString("en-CA");
}
export function addDays(iso: string, days: number) {
  const d = new Date(`${iso}T12:00:00`);
  d.setDate(d.getDate() + days);
  return d.toLocaleDateString("en-CA");
}
/** A wa.me link: Egyptian numbers written 010... become 2010... */
export function waLink(phone: string, text: string) {
  let digits = phone.replace(/[^\d]/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  else if (digits.startsWith("0")) digits = `20${digits.slice(1)}`;
  return `https://wa.me/${digits}?text=${encodeURIComponent(text)}`;
}
export function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase();
}
export function stagePill(stage: string) {
  return stage === "won" ? "pill pill-ok" : stage === "lost" ? "pill pill-muted" : stage === "new" ? "pill pill-update" : "pill pill-outline";
}

/** Procedures and staff for the lead form. */
export function useLeadChoices() {
  const [procedures, setProcedures] = useState<Procedure[]>([]);
  const [staff, setStaff] = useState<StaffMember[]>([]);
  useEffect(() => {
    getAll<Procedure>("/api/masterdata/procedures/?is_active=true").then(setProcedures).catch(() => setProcedures([]));
    getAll<StaffMember>("/api/masterdata/staff/?is_active=true")
      .then((rows) => setStaff(rows.filter((s) => ["reception", "dentist", "other"].includes(s.staff_type))))
      .catch(() => setStaff([]));
  }, []);
  return { procedures, staff };
}

/* ------------------------------------------------------------ lead form */

export function LeadForm({ lead, onClose, onSaved }: { lead?: Lead; onClose: () => void; onSaved: (l: Lead) => void }) {
  const { t, lang, name } = useI18n();
  const { me } = useAuth();
  const { branches } = useChoices();
  const { procedures, staff } = useLeadChoices();
  const [v, setV] = useState<Record<string, unknown>>(() => ({
    name_ar: lead?.name_ar ?? "",
    name_en: lead?.name_en ?? "",
    phone: lead?.phone ?? "",
    gender: lead?.gender ?? "",
    language: lead?.language ?? "ar",
    whatsapp_opt_in: lead?.whatsapp_opt_in ?? true,
    source: lead?.source ?? "phone",
    referred_by: lead?.referred_by ?? "",
    interest: lead?.interest ?? null,
    interest_text: lead?.interest_text ?? "",
    estimated_value: lead?.estimated_value ?? "",
    assigned_to: lead?.assigned_to ?? me?.staff_member?.id ?? null,
    branch: lead?.branch ?? null,
    next_follow_up: lead?.next_follow_up ?? (lead ? "" : addDays(today(), 1)),
    notes: lead?.notes ?? "",
  }));
  const [dupes, setDupes] = useState<Duplicates | null>(null);
  const [allow, setAllow] = useState(false);
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const set = (k: string) => (value: unknown) => setV((s) => ({ ...s, [k]: value }));

  const check = useCallback(
    (phone: string) => {
      if (phone.replace(/\D/g, "").length < 8) return setDupes(null);
      get<Duplicates>(`/api/crm/leads/duplicates/?phone=${encodeURIComponent(phone)}${lead ? `&exclude=${lead.id}` : ""}`)
        .then((d) => setDupes(d.patients.length || d.leads.length ? d : null))
        .catch(() => setDupes(null));
    },
    [lead],
  );
  const pickProcedure = (id: string) => {
    const proc = procedures.find((p) => String(p.id) === id);
    setV((s) => ({ ...s, interest: id ? Number(id) : null, estimated_value: s.estimated_value && Number(s.estimated_value) > 0 ? s.estimated_value : proc?.default_price ?? "" }));
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErrors({});
    setMessage("");
    const body = { ...v, estimated_value: v.estimated_value || "0", next_follow_up: v.next_follow_up || null, allow_duplicate: allow };
    try {
      const saved = lead ? await patch<Lead>(`/api/crm/leads/${lead.id}/`, body) : await post<Lead>("/api/crm/leads/", body);
      onSaved(saved);
    } catch (err) {
      if (err instanceof ApiError) {
        const { duplicates, ...rest } = err.fields;
        setErrors(rest);
        if (duplicates) check(String(v.phone));
        setMessage(Object.keys(rest).length ? "" : err.message);
      } else setMessage(String(err));
    } finally {
      setBusy(false);
    }
  };
  const input = (k: string, label: TKey, extra: Partial<{ dir: "ltr" | "rtl"; type: string; required: boolean }> = {}) => (
    <label className="field">
      <span className="field-label">{t(label)}</span>
      <input name={k} type={extra.type ?? "text"} dir={extra.dir} required={extra.required} value={String(v[k] ?? "")} onChange={(e) => set(k)(e.target.value)} onBlur={k === "phone" ? (e) => check(e.target.value) : undefined} />
      {errors[k] && <span className="field-error">{errors[k].join(" ")}</span>}
    </label>
  );
  return (
    <Modal title={lead ? `${t("edit")}: ${leadName(lead, lang)}` : t("crm.newLead")} onClose={onClose}>
      <form className="form-grid" onSubmit={submit}>
        <div className="form-grid form-grid-2">
          {input("name_ar", "nameAr", { dir: "rtl" })}
          {input("name_en", "nameEn", { dir: "ltr" })}
          {input("phone", "pt.mobile", { dir: "ltr", required: true, type: "tel" })}
          <label className="field">
            <span className="field-label">{t("crm.source")}</span>
            <select value={String(v.source)} onChange={(e) => set("source")(e.target.value)}>
              {SOURCES.map((s) => <option key={s} value={s}>{t(`crm.src.${s}` as TKey)}</option>)}
            </select>
          </label>
        </div>
        {dupes && (
          <div className="notice crm-dupes" role="alert">
            <p className="strong">{t("crm.dupTitle")}</p>
            <ul className="plain-list">
              {dupes.patients.map((p) => (
                <li key={`p${p.id}`}>
                  <Link to={`/patients/${p.id}`}>{personName(p, lang)}</Link> <span className="mono small muted">{p.file_number}</span> · {t("crm.dupPatient")}
                </li>
              ))}
              {dupes.leads.map((l) => (
                <li key={`l${l.id}`}>
                  {personName(l, lang)} · <span className={stagePill(l.stage)}>{t(`crm.stage.${l.stage}` as TKey)}</span>
                </li>
              ))}
            </ul>
            <label className="check-inline">
              <input type="checkbox" checked={allow} onChange={(e) => setAllow(e.target.checked)} /> {t("crm.dupAnyway")}
            </label>
          </div>
        )}
        <div className="form-grid form-grid-2">
          {v.source === "referral" && input("referred_by", "crm.referredBy")}
          <label className="field">
            <span className="field-label">{t("crm.interest")}</span>
            <select value={v.interest === null ? "" : String(v.interest)} onChange={(e) => pickProcedure(e.target.value)}>
              <option value="">{t("crm.interestOther")}</option>
              {procedures.map((p) => <option key={p.id} value={p.id}>{p.code} · {name(p)}</option>)}
            </select>
          </label>
          {v.interest === null && input("interest_text", "crm.interestText")}
          {input("estimated_value", "crm.value", { type: "number", dir: "ltr" })}
          <label className="field">
            <span className="field-label">{t("crm.assigned")}</span>
            <select value={v.assigned_to === null ? "" : String(v.assigned_to)} onChange={(e) => set("assigned_to")(e.target.value ? Number(e.target.value) : null)}>
              <option value="">{t("none")}</option>
              {staff.map((s) => <option key={s.id} value={s.id}>{name(s)}</option>)}
            </select>
          </label>
          <label className="field">
            <span className="field-label">{t("pt.homeBranch")}</span>
            <select value={v.branch === null ? "" : String(v.branch)} onChange={(e) => set("ap.branch")(e.target.value ? Number(e.target.value) : null)}>
              <option value="">{t("none")}</option>
              {branches.map((b) => <option key={b.id} value={b.id}>{name(b)}</option>)}
            </select>
          </label>
          {input("next_follow_up", "crm.followUp", { type: "date" })}
          <label className="field">
            <span className="field-label">{t("pt.language")}</span>
            <select value={String(v.language)} onChange={(e) => set("language")(e.target.value)}>
              <option value="ar">العربية</option>
              <option value="en">English</option>
            </select>
          </label>
        </div>
        <label className="field-check field">
          <input type="checkbox" checked={Boolean(v.whatsapp_opt_in)} onChange={(e) => set("whatsapp_opt_in")(e.target.checked)} /> {t("pt.whatsapp")}
        </label>
        <label className="field">
          <span className="field-label">{t("notes")}</span>
          <textarea rows={3} value={String(v.notes)} onChange={(e) => set("notes")(e.target.value)} />
        </label>
        {message && <p className="form-error" role="alert">{message}</p>}
        <div className="form-actions">
          <button type="button" className="btn" onClick={onClose}>{t("cancel")}</button>
          <button type="submit" className="btn btn-primary" disabled={busy}>{t("save")}</button>
        </div>
      </form>
    </Modal>
  );
}

/* ------------------------------------------------------------ lead view */

export function LostDialog({ onClose, onPick }: { onClose: () => void; onPick: (reason: string, note: string) => void }) {
  const { t } = useI18n();
  const [reason, setReason] = useState("price");
  const [note, setNote] = useState("");
  return (
    <Modal title={t("crm.lostTitle")} onClose={onClose}>
      <div className="chip-row" role="radiogroup" aria-label={t("crm.lostReason")}>
        {LOST_REASONS.map((r) => (
          <button key={r} type="button" role="radio" aria-checked={reason === r} className={`chip ${reason === r ? "active" : ""}`} onClick={() => setReason(r)}>
            {t(`crm.lost.${r}` as TKey)}
          </button>
        ))}
      </div>
      <label className="field">
        <span className="field-label">{t("notes")}</span>
        <input value={note} onChange={(e) => setNote(e.target.value)} />
      </label>
      <div className="form-actions">
        <button className="btn" onClick={onClose}>{t("cancel")}</button>
        <button className="btn btn-primary" onClick={() => onPick(reason, note)}>{t("crm.markLost")}</button>
      </div>
    </Modal>
  );
}

export function LeadView({ initial, onClose, onChanged }: { initial: Lead; onClose: () => void; onChanged: () => void }) {
  const { t, lang } = useI18n();
  const { can, me } = useAuth();
  const currency = useCurrency();
  const choices = useChoices();
  const [lead, setLead] = useState(initial);
  const [acts, setActs] = useState<Activity[]>([]);
  const [editing, setEditing] = useState(false);
  const [losing, setLosing] = useState(false);
  const [converting, setConverting] = useState(false);
  const [booking, setBooking] = useState<Patient | null>(null);
  const [kind, setKind] = useState("call");
  const [text, setText] = useState("");
  const [follow, setFollow] = useState(lead.next_follow_up ?? "");
  const [error, setError] = useState("");
  const editable = can("crm", "edit");

  const load = useCallback(() => {
    get<Activity[]>(`/api/crm/leads/${lead.id}/activities/`).then(setActs).catch(() => setActs([]));
  }, [lead.id]);
  useEffect(load, [load]);
  const changed = (l: Lead) => {
    setLead(l);
    setFollow(l.next_follow_up ?? "");
    load();
    onChanged();
  };
  const move = async (stage: LeadStage, lost_reason = "", note = "") => {
    setError("");
    try {
      changed(await post<Lead>(`/api/crm/leads/${lead.id}/stage/`, { stage, lost_reason, note }));
    } catch (err) {
      setError(errorText(err));
    }
  };
  const logActivity = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    try {
      changed(await post<Lead>(`/api/crm/leads/${lead.id}/activities/`, { kind, text, next_follow_up: follow || null }));
      setText("");
    } catch (err) {
      setError(errorText(err));
    }
  };
  const book = async () => {
    setError("");
    try {
      let current = lead;
      if (!current.patient) {
        current = await post<Lead>(`/api/crm/leads/${lead.id}/convert/`, {});
        changed(current);
      }
      setBooking(await get<Patient>(`/api/patients/${current.patient}/`));
    } catch (err) {
      setError(errorText(err));
    }
  };
  const clinicName = (lang === "ar" ? me?.clinic?.name_ar || me?.clinic?.name_en : me?.clinic?.name_en || me?.clinic?.name_ar) ?? "";
  const phoneText = lang === "ar" ? `مرحبًا ${leadName(lead, "ar").split(" ")[0]}، معك ${clinicName} بخصوص استفسارك.` : `Hello ${leadName(lead, "en").split(" ")[0]}, this is ${clinicName} about your enquiry.`;
  const stageIndex = STAGES.indexOf(lead.stage);

  return (
    <Modal title={leadName(lead, lang)} onClose={onClose}>
      <div className="lead-view">
        <div className="lead-head">
          <span className={stagePill(lead.stage)}>{t(`crm.stage.${lead.stage}` as TKey)}</span>
          <span className="pill pill-outline">{t(`crm.src.${lead.source}` as TKey)}</span>
          {lead.lost_reason && <span className="pill pill-muted">{t(`crm.lost.${lead.lost_reason}` as TKey)}</span>}
          {lead.follow_up_due && <span className="pill pill-warn">{t("crm.followDue")}</span>}
          <span className="grow" />
          <a className="btn btn-small" href={`tel:${lead.phone}`}><Icon name="phone" size={16} /> <bdi dir="ltr">{lead.phone}</bdi></a>
          {lead.whatsapp_opt_in && <a className="btn btn-small wa-btn" href={waLink(lead.phone, phoneText)} target="_blank" rel="noreferrer">WhatsApp</a>}
        </div>
        <ol className="lead-steps" aria-label={t("crm.stage")}>
          {STAGES.filter((s) => s !== "lost").map((s, i) => (
            <li key={s} className={lead.stage === "lost" ? "" : i < stageIndex ? "done" : i === stageIndex ? "now" : ""}>
              {editable && lead.stage !== s ? (
                <button type="button" onClick={() => void move(s)}>{t(`crm.stage.${s}` as TKey)}</button>
              ) : (
                <span>{t(`crm.stage.${s}` as TKey)}</span>
              )}
            </li>
          ))}
        </ol>
        <dl className="kv lead-facts">
          <div><dt>{t("crm.interest")}</dt><dd>{interestLabel(lead, lang) || "—"}</dd></div>
          <div><dt>{t("crm.value")}</dt><dd>{money(lead.estimated_value, lang)} {currency}</dd></div>
          <div><dt>{t("crm.assigned")}</dt><dd>{lead.assigned_info ? personName(lead.assigned_info, lang) : "—"}</dd></div>
          <div><dt>{t("crm.followUp")}</dt><dd>{lead.next_follow_up ? fmtDate(lead.next_follow_up, lang) : "—"}</dd></div>
          <div><dt>{t("crm.created")}</dt><dd>{fmtDate(lead.created_at, lang)}</dd></div>
          {lead.referred_by && <div><dt>{t("crm.referredBy")}</dt><dd>{lead.referred_by}</dd></div>}
          <div>
            <dt>{t("crm.patientFile")}</dt>
            <dd>{lead.patient_info ? <Link to={`/patients/${lead.patient_info.id}`}>{lead.patient_info.file_number}</Link> : t("crm.notYet")}</dd>
          </div>
        </dl>
        {lead.notes && <p className="note">{lead.notes}</p>}
        {editable && (
          <div className="toolbar">
            {!lead.patient && can("patients", "create") && (
              <button className="btn" onClick={() => setConverting(true)}><Icon name="patients" size={18} /> {t("crm.convert")}</button>
            )}
            {can("appointments", "create") && (lead.patient || can("patients", "create")) && lead.stage !== "lost" && (
              <button className="btn btn-primary" onClick={() => void book()}><Icon name="calendar" size={18} /> {t("crm.bookConsult")}</button>
            )}
            {lead.stage !== "won" && <button className="btn" onClick={() => void move("won")}>{t("crm.markWon")}</button>}
            {lead.stage !== "lost" && <button className="btn" onClick={() => setLosing(true)}>{t("crm.markLost")}</button>}
            <button className="btn" onClick={() => setEditing(true)}>{t("edit")}</button>
          </div>
        )}
        {error && <p className="form-error" role="alert">{error}</p>}
        {editable && (
          <form className="lead-log" onSubmit={logActivity}>
            <div className="segmented" role="group" aria-label={t("crm.logKind")}>
              {ACTIVITY_KINDS.map((k) => (
                <button key={k} type="button" aria-pressed={kind === k} onClick={() => setKind(k)}>{t(`crm.act.${k}` as TKey)}</button>
              ))}
            </div>
            <textarea rows={2} placeholder={t("crm.logHint")} value={text} onChange={(e) => setText(e.target.value)} aria-label={t("crm.logHint")} />
            <div className="toolbar">
              <label className="field inline">
                <span>{t("crm.followUp")}</span>
                <input type="date" value={follow} onChange={(e) => setFollow(e.target.value)} />
              </label>
              <button className="btn btn-primary" type="submit">{t("crm.log")}</button>
            </div>
          </form>
        )}
        <h3 className="sub-head">{t("crm.history")}</h3>
        <ol className="lead-timeline">
          {acts.map((a) => (
            <li key={a.id} className={`act-${a.kind}`}>
              <span className="lead-dot" aria-hidden="true" />
              <div>
                <p className="strong">
                  {a.kind === "stage"
                    ? t("crm.movedTo", { stage: t(`crm.stage.${a.stage_to}` as TKey) })
                    : t(`crm.act.${a.kind}` as TKey)}
                </p>
                {a.text && <p>{a.text}</p>}
                <p className="muted small">{[a.author, new Date(a.created_at).toLocaleString(lang === "ar" ? "ar-EG" : "en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })].filter(Boolean).join(" · ")}</p>
              </div>
            </li>
          ))}
        </ol>
      </div>
      {editing && <LeadForm lead={lead} onClose={() => setEditing(false)} onSaved={(l) => { setEditing(false); changed(l); }} />}
      {losing && <LostDialog onClose={() => setLosing(false)} onPick={(reason, note) => { setLosing(false); void move("lost", reason, note); }} />}
      {converting && (
        <Modal title={t("crm.convertTitle")} onClose={() => setConverting(false)}>
          <p className="muted small">{t("crm.convertHint")}</p>
          <RecordForm
            fields={patientFields(t, { branches: choices.branchOptions, dentists: choices.dentistOptions })}
            initial={{
              name_ar: lead.name_ar, name_en: lead.name_en, phone: lead.phone, gender: lead.gender || null, language: lead.language,
              whatsapp_opt_in: lead.whatsapp_opt_in, home_branch: lead.branch,
              referral_source: { walk_in: "walk_in", referral: "friend", facebook: "facebook", instagram: "instagram", google: "google", website: "google" }[lead.source] ?? "other",
            }}
            isNew
            onCancel={() => setConverting(false)}
            onSubmit={async (values) => {
              const saved = await post<Lead>(`/api/crm/leads/${lead.id}/convert/`, cleanPatient(values));
              setConverting(false);
              changed(saved);
            }}
          />
        </Modal>
      )}
      {booking && (
        <AppointmentDialog
          initial={{ patient: booking, procedure: lead.interest ?? undefined, reason: t("crm.consultReason") }}
          onClose={() => setBooking(null)}
          onSaved={async (a: Appointment) => {
            setBooking(null);
            try {
              changed(await post<Lead>(`/api/crm/leads/${lead.id}/consultation/`, { appointment: a.id }));
            } catch (err) {
              setError(errorText(err));
            }
          }}
        />
      )}
    </Modal>
  );
}

/* --------------------------------------------------------- recall contact */

export function ContactDialog({ title, onClose, onSave }: { title: string; onClose: () => void; onSave: (body: { outcome: string; note: string; snooze_until: string | null; channel: string }) => Promise<void> }) {
  const { t } = useI18n();
  const [outcome, setOutcome] = useState("no_answer");
  const [channel, setChannel] = useState("call");
  const [note, setNote] = useState("");
  const [snooze, setSnooze] = useState(addDays(today(), 3));
  const [error, setError] = useState("");
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await onSave({ outcome, note, channel, snooze_until: outcome === "call_later" || outcome === "no_answer" ? snooze || null : null });
    } catch (err) {
      setError(errorText(err));
    }
  };
  return (
    <Modal title={title} onClose={onClose}>
      <form className="form-grid" onSubmit={submit}>
        <div className="segmented" role="group" aria-label={t("crm.channel")}>
          {["call", "whatsapp", "sms"].map((c) => (
            <button key={c} type="button" aria-pressed={channel === c} onClick={() => setChannel(c)}>{t(`crm.act.${c}` as TKey)}</button>
          ))}
        </div>
        <div className="chip-row" role="radiogroup" aria-label={t("crm.outcome")}>
          {OUTCOMES.filter((o) => o !== "booked").map((o) => (
            <button key={o} type="button" role="radio" aria-checked={outcome === o} className={`chip ${outcome === o ? "active" : ""}`} onClick={() => setOutcome(o)}>
              {t(`crm.out.${o}` as TKey)}
            </button>
          ))}
        </div>
        {(outcome === "call_later" || outcome === "no_answer") && (
          <label className="field">
            <span className="field-label">{outcome === "call_later" ? t("crm.callOn") : t("crm.snoozeOptional")}</span>
            <input type="date" min={addDays(today(), 1)} value={snooze} onChange={(e) => setSnooze(e.target.value)} />
          </label>
        )}
        <label className="field">
          <span className="field-label">{t("notes")}</span>
          <input value={note} onChange={(e) => setNote(e.target.value)} />
        </label>
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="form-actions">
          <button type="button" className="btn" onClick={onClose}>{t("cancel")}</button>
          <button type="submit" className="btn btn-primary">{t("save")}</button>
        </div>
      </form>
    </Modal>
  );
}

/* --------------------------------------------- CRM section of the patient file */

interface PatientCrm {
  source: { lead_source: string | null; referral_source: string };
  leads: {
    id: number; source: string; stage: LeadStage; created_at: string; converted_at: string | null; interest: Named | null; interest_text: string;
    estimated_value: string; assigned: (Named & { id: number }) | null; lost_reason: string;
    activities: { kind: string; text: string; stage_from: string; stage_to: string; at: string; by: string }[];
  }[];
  campaigns: { id: number; name: string; channel: string; status: string; sent_at: string | null; body: string; booked: number; responded: boolean }[];
  recalls: { key: string; rule: Named & { id: number; months: number }; due_date: string; status: string; days_overdue: number; attempts: number; hidden: string | null }[];
  contacts: { id: number; outcome: string; channel: string; note: string; created_at: string; author: string; snooze_until: string | null }[];
  feedback: { id: number; score: number | null; comment: string; visit_date: string | null; dentist_info: Named | null; source: string; answered_at: string | null; created_at: string }[];
}

export function Stars({ score, size = 14 }: { score: number; size?: number }) {
  return (
    <span className="stars" aria-label={`${score}/5`} style={{ fontSize: size } as CSSProperties}>
      {[1, 2, 3, 4, 5].map((n) => <span key={n} className={n <= score ? "on" : ""} aria-hidden="true">★</span>)}
    </span>
  );
}

export function PatientCrmCard({ patientId }: { patientId: number }) {
  const { t, lang } = useI18n();
  const [data, setData] = useState<PatientCrm | null>(null);
  useEffect(() => {
    get<PatientCrm>(`/api/crm/patients/${patientId}/`).then(setData).catch(() => setData(null));
  }, [patientId]);
  const src = data?.source.lead_source ? t(`crm.src.${data.source.lead_source}` as TKey) : data?.source.referral_source ? t(`pt.referral.${data.source.referral_source}` as TKey) : "—";
  const recall = data?.recalls.find((r) => !r.hidden) ?? data?.recalls[0];
  const answered = data?.feedback.filter((f) => f.score) ?? [];
  const avg = answered.length ? answered.reduce((s, f) => s + (f.score ?? 0), 0) / answered.length : null;
  const when = (iso: string) => fmtDate(iso, lang);
  return (
    <section id="crm" className="card main-card crm-card">
      <header className="main-card-head">
        <h2>{t("crm.patientSection")}</h2>
        <Link className="muted small" to="/crm">{t("crm.openCrm")}</Link>
      </header>
      {!data ? (
        <p className="muted">{t("loading")}</p>
      ) : (
        <>
          <div className="crm-facts">
            <div className="pf-stat">
              <p className="overline">{t("crm.cameFrom")}</p>
              <p className="pf-stat-value">{src}</p>
              {data.source.lead_source && data.source.referral_source && <p className="pf-stat-sub">{t("crm.heard", { how: t(`pt.referral.${data.source.referral_source}` as TKey) })}</p>}
              {data.leads[data.leads.length - 1] && <p className="pf-stat-sub">{t("crm.enquiredOn", { date: when(data.leads[data.leads.length - 1].created_at) })}</p>}
            </div>
            <div className="pf-stat">
              <p className="overline">{t("crm.recallStatus")}</p>
              <p className="pf-stat-value">{recall ? (recall.status === "overdue" ? t("crm.overdueDays", { n: recall.days_overdue }) : t("crm.dueOn", { date: when(recall.due_date) })) : t("crm.upToDate")}</p>
              {recall && <p className="pf-stat-sub">{personName(recall.rule, lang)}{recall.hidden ? ` · ${t(`crm.hidden.${recall.hidden}` as TKey)}` : ""}</p>}
            </div>
            <div className="pf-stat">
              <p className="overline">{t("crm.satisfaction")}</p>
              <p className="pf-stat-value">{avg === null ? "—" : <><Stars score={Math.round(avg)} size={16} /> {avg.toFixed(1)}</>}</p>
              <p className="pf-stat-sub">{t("crm.ratingsN", { n: answered.length })}</p>
            </div>
            <div className="pf-stat">
              <p className="overline">{t("crm.campaignsReceived")}</p>
              <p className="pf-stat-value">{data.campaigns.length}</p>
              <p className="pf-stat-sub">{t("crm.bookedAfter", { n: data.campaigns.filter((c) => c.booked > 0).length })}</p>
            </div>
          </div>
          <div className="crm-columns">
            <div>
              <h3 className="sub-head">{t("crm.leadHistory")}</h3>
              {data.leads.length === 0 ? <p className="muted small">{t("crm.noLead")}</p> : data.leads.map((l) => (
                <div key={l.id} className="crm-lead">
                  <p className="strong">
                    {(l.interest ? personName(l.interest, lang) : l.interest_text) || t("crm.enquiry")} <span className={stagePill(l.stage)}>{t(`crm.stage.${l.stage}` as TKey)}</span>
                  </p>
                  <ol className="lead-timeline compact">
                    {l.activities.slice(0, 5).map((a, i) => (
                      <li key={i}>
                        <span className="lead-dot" aria-hidden="true" />
                        <div>
                          <p className="small">{a.kind === "stage" ? t("crm.movedTo", { stage: t(`crm.stage.${a.stage_to}` as TKey) }) : a.text || t(`crm.act.${a.kind}` as TKey)}</p>
                          <p className="muted small">{[a.by, when(a.at)].filter(Boolean).join(" · ")}</p>
                        </div>
                      </li>
                    ))}
                  </ol>
                </div>
              ))}
              {data.contacts.length > 0 && (
                <>
                  <h3 className="sub-head">{t("crm.recallCalls")}</h3>
                  <ul className="plain-list mini-list">
                    {data.contacts.slice(0, 4).map((c) => (
                      <li key={c.id} className="small">
                        <span className="pill pill-outline">{t(`crm.out.${c.outcome}` as TKey)}</span> {c.note} <span className="muted">· {c.author} · {when(c.created_at)}</span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
            <div>
              <h3 className="sub-head">{t("crm.campaignsReceived")}</h3>
              {data.campaigns.length === 0 ? <p className="muted small">{t("crm.noCampaigns")}</p> : (
                <ul className="plain-list mini-list">
                  {data.campaigns.slice(0, 5).map((c, i) => (
                    <li key={i} className="small">
                      <strong>{c.name}</strong> <span className="muted">· {c.channel === "sms" ? "SMS" : "WhatsApp"}{c.sent_at ? ` · ${when(c.sent_at)}` : ""}</span>
                      {c.status === "skipped" && <span className="pill pill-muted tiny">{t("crm.rs.skipped")}</span>}
                      {c.booked > 0 && <span className="pill pill-ok tiny">{t("crm.booked")}</span>}
                    </li>
                  ))}
                </ul>
              )}
              <h3 className="sub-head">{t("crm.feedback")}</h3>
              {answered.length === 0 ? <p className="muted small">{t("crm.noFeedback")}</p> : (
                <ul className="plain-list mini-list">
                  {answered.slice(0, 4).map((f) => (
                    <li key={f.id} className="small">
                      <Stars score={f.score ?? 0} /> {f.comment && <span>“{f.comment}”</span>}
                      <span className="muted block">{[f.dentist_info ? personName(f.dentist_info, lang) : "", f.visit_date ? when(f.visit_date) : ""].filter(Boolean).join(" · ")}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </>
      )}
    </section>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="muted pad">{children}</p>;
}
