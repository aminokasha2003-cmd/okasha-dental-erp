import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { ApiError, del, get, getAll, openProtectedFile, patch, post, tokens } from "../api";
import { useAuth } from "../auth";
import { useI18n, type TKey } from "../i18n";
import { Modal } from "../components/Crud";
import { Icon } from "../components/Icon";
import {
  ALL_TEETH,
  ChartLegend,
  DentalChart,
  SURFACES,
  SURFACE_STATES,
  SurfaceDiagram,
  emptyTooth,
  toothName,
  toothStatus,
} from "../components/DentalChart";
import type {
  Appointment,
  ConsentTemplate,
  Patient,
  PatientConsent,
  PlanLine,
  Prescription,
  Procedure,
  RxItem,
  Surface,
  SurfaceState,
  ToothRecord,
  TreatmentPlan,
  VisitNote,
} from "../types";
import { patientName } from "./Patients";
import { AppointmentDialog } from "./Appointments";

// Phase 2 sections of the patient file: dental chart, treatment plan, visit
// notes, prescriptions, consent forms and imaging. Layout follows the patient
// card handoff in docs/design.

type T = (key: TKey, vars?: Record<string, string | number>) => string;

function locale(lang: string) {
  return lang === "ar" ? "ar-EG" : "en-GB";
}
export function fmtDate(iso: string, lang: string) {
  return new Date(iso.length === 10 ? `${iso}T12:00:00` : iso).toLocaleDateString(locale(lang), { day: "numeric", month: "short", year: "numeric" });
}
export function money(value: string | number, lang: string) {
  return Number(value).toLocaleString(locale(lang), { maximumFractionDigits: 2 });
}
function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function errorText(err: unknown) {
  if (err instanceof ApiError) return Object.keys(err.fields).length ? Object.values(err.fields).flat().join(" ") : err.message;
  return err instanceof Error ? err.message : String(err);
}
export function lineName(line: PlanLine, lang: string) {
  return (lang === "ar" ? line.procedure_name_ar || line.procedure_name_en : line.procedure_name_en || line.procedure_name_ar) || line.procedure_code;
}
function staffLabel(n: { ar: string; en: string } | null, lang: string) {
  return n ? (lang === "ar" ? n.ar || n.en : n.en || n.ar) : "";
}
const OPEN_PLAN = ["proposed", "accepted", "in_progress"];
const OPEN_LINE = ["planned", "in_progress"];

/* ------------------------------------------------------------------ data */

export interface ClinicalData {
  chart: Record<number, ToothRecord>;
  plans: TreatmentPlan[];
  notes: VisitNote[];
  prescriptions: Prescription[];
  consents: PatientConsent[];
  loaded: boolean;
  reload: (part?: "chart" | "plans" | "notes" | "prescriptions" | "consents") => void;
}

export function useClinical(patientId: number, enabled: boolean): ClinicalData {
  const [chart, setChart] = useState<Record<number, ToothRecord>>({});
  const [plans, setPlans] = useState<TreatmentPlan[]>([]);
  const [notes, setNotes] = useState<VisitNote[]>([]);
  const [prescriptions, setPrescriptions] = useState<Prescription[]>([]);
  const [consents, setConsents] = useState<PatientConsent[]>([]);
  const [loaded, setLoaded] = useState(false);

  const reload = useCallback(
    (part?: "chart" | "plans" | "notes" | "prescriptions" | "consents") => {
      if (!enabled) return;
      const q = `?patient=${patientId}`;
      const jobs: Promise<unknown>[] = [];
      if (!part || part === "chart")
        jobs.push(get<ToothRecord[]>(`/api/clinical/chart/${q}`).then((rows) => setChart(Object.fromEntries(rows.map((r) => [r.tooth, r])))));
      if (!part || part === "plans") jobs.push(get<TreatmentPlan[]>(`/api/clinical/plans/${q}`).then(setPlans));
      if (!part || part === "notes") jobs.push(get<VisitNote[]>(`/api/clinical/visit-notes/${q}`).then(setNotes));
      if (!part || part === "prescriptions") jobs.push(get<Prescription[]>(`/api/clinical/prescriptions/${q}`).then(setPrescriptions));
      if (!part || part === "consents") jobs.push(get<PatientConsent[]>(`/api/clinical/consents/${q}`).then(setConsents));
      Promise.all(jobs)
        .catch(() => undefined)
        .finally(() => setLoaded(true));
    },
    [patientId, enabled],
  );
  useEffect(() => reload(), [reload]);
  return { chart, plans, notes, prescriptions, consents, loaded, reload };
}

function useProcedures() {
  const [rows, setRows] = useState<Procedure[]>([]);
  useEffect(() => {
    getAll<Procedure>("/api/masterdata/procedures/?is_active=true").then(setRows).catch(() => undefined);
  }, []);
  return rows;
}

/** Open plan lines per tooth, for the chart's status labels. */
function plannedByTooth(plans: TreatmentPlan[], lang: string, t: T) {
  const out: Record<number, string[]> = {};
  for (const plan of plans) {
    if (!OPEN_PLAN.includes(plan.status)) continue;
    for (const line of plan.lines) {
      if (line.tooth && OPEN_LINE.includes(line.status)) {
        (out[line.tooth] ??= []).push(t(line.status === "in_progress" ? "line.inProgressName" : "line.plannedName", { name: lineName(line, lang) }));
      }
    }
  }
  return out;
}

function Section({ id, title, aside, sub, children }: { id: string; title: string; aside?: ReactNode; sub?: string; children: ReactNode }) {
  return (
    <section id={id} className="card main-card">
      <header className="main-card-head wrap">
        <div>
          <h2>{title}</h2>
          {sub && <p className="muted small">{sub}</p>}
        </div>
        {aside}
      </header>
      {children}
    </section>
  );
}

export function SideSection({ id, title, aside, children }: { id: string; title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section id={id} className="card side-card">
      <header className="side-card-head">
        <h2>{title}</h2>
        {aside}
      </header>
      {children}
    </section>
  );
}

/* ----------------------------------------------------------- plan stat */

export function PlanProgress({ plans }: { plans: TreatmentPlan[] }) {
  const { t } = useI18n();
  const lines = plans.filter((p) => p.status !== "cancelled").flatMap((p) => p.lines.filter((l) => l.status !== "cancelled"));
  const done = lines.filter((l) => l.status === "done").length;
  return (
    <div className="pf-stat">
      <p className="overline">{t("plan.progress")}</p>
      <p className="pf-stat-value">{lines.length ? t("plan.doneOf", { done, n: lines.length }) : t("plan.none")}</p>
      {lines.length > 0 && (
        <div className="segments" aria-hidden="true">
          {lines.map((l) => (
            <span key={l.id} className={`seg seg-${l.status}`} />
          ))}
        </div>
      )}
    </div>
  );
}

/* ---------------------------------------------------------- dental chart */

export function ChartCard({ patient, data, onAddProcedure }: { patient: Patient; data: ClinicalData; onAddProcedure: (tooth: number) => void }) {
  const { t, lang } = useI18n();
  const { can } = useAuth();
  const [selected, setSelected] = useState<number | null>(null);
  const [editing, setEditing] = useState<number | null>(null);
  const planned = useMemo(() => plannedByTooth(data.plans, lang, t), [data.plans, lang, t]);
  const updated = Object.values(data.chart)
    .map((r) => r.updated_at ?? "")
    .sort()
    .pop();

  const rec = selected ? data.chart[selected] : undefined;
  const lines = selected
    ? data.plans.filter((p) => p.status !== "cancelled").flatMap((p) => p.lines.filter((l) => l.tooth === selected && l.status !== "cancelled"))
    : [];
  const lastDone = lines.filter((l) => l.status === "done" && l.completed_at).sort((a, b) => (a.completed_at! < b.completed_at! ? 1 : -1))[0];

  return (
    <Section
      id="chart"
      title={t("chart.title")}
      sub={t("chart.sub")}
      aside={updated ? <span className="muted small">{t("chart.updated", { date: fmtDate(updated, lang) })}</span> : undefined}
    >
      <DentalChart teeth={data.chart} planned={planned} selected={selected} onSelect={setSelected} />
      <ChartLegend />
      <div className="tooth-panel" aria-live="polite">
        {selected === null ? (
          <p className="muted">{t("chart.pick")}</p>
        ) : (
          <>
            <div className="tooth-panel-num mono">{selected}</div>
            <div className="tooth-panel-text">
              <p className="tooth-panel-name">{`${t("tooth.label", { n: selected })} · ${toothName(selected, t)}`}</p>
              <p className="tooth-panel-status">{toothStatus(rec, planned[selected] ?? [], t)}</p>
              <p className="tooth-panel-note">
                {rec?.note ||
                  (lastDone ? t("chart.lastDone", { name: lineName(lastDone, lang), date: fmtDate(lastDone.completed_at!, lang) }) : t("chart.noTreatment"))}
              </p>
            </div>
            <div className="toolbar">
              {can("clinical", "create") && (
                <button className="btn btn-outline-brand" onClick={() => onAddProcedure(selected)}>
                  {t("plan.addProcedure")}
                </button>
              )}
              {can("clinical", "edit") && (
                <button className="btn" onClick={() => setEditing(selected)}>
                  {t("chart.editTooth")}
                </button>
              )}
            </div>
          </>
        )}
      </div>
      {editing !== null && (
        <ToothDialog
          record={data.chart[editing] ?? emptyTooth(patient.id, editing)}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            data.reload("chart");
          }}
        />
      )}
    </Section>
  );
}

function ToothDialog({ record, onClose, onSaved }: { record: ToothRecord; onClose: () => void; onSaved: () => void }) {
  const { t } = useI18n();
  const [value, setValue] = useState<ToothRecord>({ ...record, surfaces: { ...record.surfaces } });
  const [brush, setBrush] = useState<SurfaceState>("caries");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const toggle = (key: "missing" | "crown" | "implant" | "root_canal_treated") => setValue((v) => ({ ...v, [key]: !v[key] }));
  const paint = (surface: Surface) =>
    setValue((v) => {
      const surfaces = { ...v.surfaces };
      // Painting a surface with the state it already has clears it back to sound.
      if (brush === "sound" || surfaces[surface] === brush) delete surfaces[surface];
      else surfaces[surface] = brush;
      return { ...v, surfaces };
    });

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const { patient, tooth, missing, crown, implant, root_canal_treated, surfaces, note } = value;
      await post("/api/clinical/chart/", { patient, tooth, missing, crown, implant, root_canal_treated, surfaces, note });
      onSaved();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={`${t("tooth.label", { n: record.tooth })} · ${toothName(record.tooth, t)}`} onClose={onClose}>
      <form className="form-grid" onSubmit={save}>
        <fieldset className="tooth-flags">
          <legend>{t("chart.wholeTooth")}</legend>
          {(["missing", "crown", "implant", "root_canal_treated"] as const).map((k) => (
            <label key={k} className="check-pill">
              <input type="checkbox" checked={value[k]} onChange={() => toggle(k)} />
              {t(k === "root_canal_treated" ? "tooth.rct" : (`tooth.${k}` as TKey))}
            </label>
          ))}
        </fieldset>
        <fieldset className="surface-editor">
          <legend>{t("chart.surfaces")}</legend>
          <div className="segmented" role="radiogroup" aria-label={t("chart.paintWith")}>
            {SURFACE_STATES.map((s) => (
              <button key={s} type="button" role="radio" aria-checked={brush === s} className={brush === s ? "active" : ""} onClick={() => setBrush(s)}>
                <span className={`swatch swatch-${s}`} aria-hidden="true" />
                {t(`surface.${s}` as TKey)}
              </button>
            ))}
          </div>
          <div className="surface-editor-body" dir="ltr">
            <SurfaceDiagram
              tooth={record.tooth}
              record={{ ...value, crown: false, missing: false }}
              size={168}
              onSurface={paint}
              labelFor={(s) => `${t(`surface.${s}` as TKey)}: ${t(`surface.${value.surfaces[s] ?? "sound"}` as TKey)}`}
            />
            <ul className="surface-list" dir="auto">
              {SURFACES.map((s) => (
                <li key={s}>
                  <span className="mono strong">{s}</span> {t(`surface.${s}` as TKey)}: {t(`surface.${value.surfaces[s] ?? "sound"}` as TKey)}
                </li>
              ))}
            </ul>
          </div>
          <p className="muted small">{t("chart.paintHint")}</p>
        </fieldset>
        <label className="field">
          <span>{t("chart.toothNote")}</span>
          <textarea rows={2} value={value.note} onChange={(e) => setValue((v) => ({ ...v, note: e.target.value }))} />
        </label>
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="form-actions">
          <button type="button" className="btn" onClick={onClose}>{t("cancel")}</button>
          <button type="submit" className="btn btn-primary" disabled={busy}>{t("save")}</button>
        </div>
      </form>
    </Modal>
  );
}

/* -------------------------------------------------------- treatment plan */

const PLAN_PILL: Record<string, string> = { proposed: "pill", accepted: "pill pill-ok", in_progress: "pill pill-warn", completed: "pill pill-ok", cancelled: "pill pill-muted" };
const LINE_PILL: Record<string, string> = { planned: "pill pill-outline", in_progress: "pill pill-warn", done: "pill pill-ok", cancelled: "pill pill-muted" };

export function PlanCard({
  patient,
  data,
  addFor,
  onAddHandled,
  onVisitsChanged,
}: {
  patient: Patient;
  data: ClinicalData;
  addFor: number | "any" | null;
  onAddHandled: () => void;
  onVisitsChanged: () => void;
}) {
  const { t, lang } = useI18n();
  const { can, me } = useAuth();
  const procedures = useProcedures();
  const [adding, setAdding] = useState<{ tooth: number | null; plan?: number } | null>(null);
  const [newPlan, setNewPlan] = useState(false);
  const [booking, setBooking] = useState<PlanLine | null>(null);
  const [showClosed, setShowClosed] = useState(false);
  const [error, setError] = useState("");
  const currency = me?.clinic?.currency ?? "EGP";

  useEffect(() => {
    if (addFor !== null) {
      setAdding({ tooth: addFor === "any" ? null : addFor });
      onAddHandled();
    }
  }, [addFor, onAddHandled]);

  const run = async (job: () => Promise<unknown>, part: "plans" | "all" = "plans") => {
    setError("");
    try {
      await job();
      data.reload(part === "all" ? undefined : part);
    } catch (err) {
      setError(errorText(err));
    }
  };
  const setPlanStatus = (plan: TreatmentPlan, status: string) => {
    if (status === "cancelled" && !window.confirm(t("plan.confirmCancel"))) return;
    void run(() => post(`/api/clinical/plans/${plan.id}/status/`, { status }));
  };
  const setLineStatus = (line: PlanLine, status: string) => void run(() => patch(`/api/clinical/plan-lines/${line.id}/`, { status }), "all");
  const removeLine = (line: PlanLine) => {
    if (!window.confirm(t("confirmDelete"))) return;
    void run(() => del(`/api/clinical/plan-lines/${line.id}/`));
  };

  const open = data.plans.filter((p) => OPEN_PLAN.includes(p.status));
  const closed = data.plans.filter((p) => !OPEN_PLAN.includes(p.status));
  const shown = showClosed ? data.plans : open;

  return (
    <Section
      id="plan"
      title={t("plan.title")}
      aside={
        <div className="toolbar">
          {can("clinical", "create") && (
            <>
              <button className="btn" onClick={() => setNewPlan(true)}>{t("plan.new")}</button>
              <button className="btn btn-primary" onClick={() => setAdding({ tooth: null })}>
                <Icon name="plus" size={18} /> {t("plan.addProcedure")}
              </button>
            </>
          )}
        </div>
      }
    >
      {error && <p className="form-error" role="alert">{error}</p>}
      {data.plans.length === 0 && <p className="muted">{t("plan.empty")}</p>}
      {shown.map((plan) => (
        <div key={plan.id} className={`plan-block ${plan.status === "cancelled" ? "is-cancelled" : ""}`}>
          <div className="plan-head">
            <div>
              <p className="plan-title">
                {plan.title || t("plan.defaultTitle")} <span className={PLAN_PILL[plan.status]}>{t(`plan.status.${plan.status}` as TKey)}</span>
              </p>
              <p className="muted small">
                {[staffLabel(plan.dentist_name, lang), fmtDate(plan.created_at, lang), plan.accepted_at ? t("plan.agreedOn", { date: fmtDate(plan.accepted_at, lang) }) : ""]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
              {plan.notes && <p className="small">{plan.notes}</p>}
            </div>
            {can("clinical", "edit") && (
              <div className="toolbar">
                {plan.status === "proposed" && (
                  <button className="btn btn-small btn-primary" onClick={() => setPlanStatus(plan, "accepted")}>{t("plan.accept")}</button>
                )}
                {OPEN_PLAN.includes(plan.status) && can("clinical", "create") && (
                  <button className="btn btn-small" onClick={() => setAdding({ tooth: null, plan: plan.id })}>{t("plan.addLine")}</button>
                )}
                {OPEN_PLAN.includes(plan.status) && (
                  <button className="btn btn-small" onClick={() => setPlanStatus(plan, "cancelled")}>{t("plan.cancel")}</button>
                )}
                {plan.status === "cancelled" && (
                  <button className="btn btn-small" onClick={() => setPlanStatus(plan, "proposed")}>{t("plan.reopen")}</button>
                )}
              </div>
            )}
          </div>
          {plan.lines.length === 0 ? (
            <p className="muted small">{t("plan.noLines")}</p>
          ) : (
            <div className="table-wrap">
              <table className="plan-table">
                <thead>
                  <tr>
                    <th>{t("plan.tooth")}</th>
                    <th>{t("plan.procedure")}</th>
                    <th>{t("plan.status")}</th>
                    <th>{t("plan.date")}</th>
                    <th className="num">{t("plan.fee", { cur: currency })}</th>
                    <th aria-label={t("actions")} />
                  </tr>
                </thead>
                <tbody>
                  {plan.lines.map((line) => (
                    <tr key={line.id} className={line.status === "cancelled" ? "is-cancelled" : ""}>
                      <td className="mono">{line.tooth ?? "—"}</td>
                      <td>
                        {lineName(line, lang)}
                        {line.surfaces && <span className="muted"> · {line.surfaces}</span>}
                        {line.needs_lab && <span className="pill pill-outline tiny">{t("plan.lab")}</span>}
                        {line.notes && <p className="muted small">{line.notes}</p>}
                      </td>
                      <td>
                        {can("clinical", "edit") && plan.status !== "cancelled" ? (
                          <select
                            className={`status-select ${LINE_PILL[line.status]}`}
                            aria-label={`${t("plan.status")}: ${lineName(line, lang)}`}
                            value={line.status}
                            onChange={(e) => setLineStatus(line, e.target.value)}
                          >
                            {["planned", "in_progress", "done", "cancelled"].map((s) => (
                              <option key={s} value={s}>{t(`line.status.${s}` as TKey)}</option>
                            ))}
                          </select>
                        ) : (
                          <span className={LINE_PILL[line.status]}>{t(`line.status.${line.status}` as TKey)}</span>
                        )}
                      </td>
                      <td className="muted nowrap">
                        {line.status === "done" && line.completed_at
                          ? fmtDate(line.completed_at, lang)
                          : line.appointment_start
                            ? t("plan.booked", { date: fmtDate(line.appointment_start, lang) })
                            : line.status !== "cancelled" && (
                                <>
                                  {t("plan.notScheduled")}
                                  {can("appointments", "create") && patient.is_active && OPEN_PLAN.includes(plan.status) && (
                                    <button className="link-button" onClick={() => setBooking(line)}>{t("plan.book")}</button>
                                  )}
                                </>
                              )}
                      </td>
                      <td className="num">
                        {money(line.net, lang)}
                        {Number(line.discount) > 0 && <p className="muted small">{t("plan.discountOf", { n: money(line.discount, lang) })}</p>}
                      </td>
                      <td className="cell-actions">
                        {can("clinical", "delete") && OPEN_LINE.includes(line.status) && line.status === "planned" && (
                          <button className="btn btn-small" aria-label={`${t("delete")}: ${lineName(line, lang)}`} onClick={() => removeLine(line)}>
                            {t("delete")}
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={4}>{t("plan.doneAndProgress")}</td>
                    <td className="num">{money(Number(plan.totals.done) + Number(plan.totals.in_progress), lang)}</td>
                    <td />
                  </tr>
                  <tr>
                    <td colSpan={4}>{t("plan.plannedTotal")}</td>
                    <td className="num">{money(plan.totals.planned, lang)}</td>
                    <td />
                  </tr>
                  <tr className="strong">
                    <td colSpan={4}>{t("plan.total")}</td>
                    <td className="num">{money(plan.totals.total, lang)}</td>
                    <td />
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </div>
      ))}
      {closed.length > 0 && (
        <button className="link-button" onClick={() => setShowClosed((s) => !s)}>
          {showClosed ? t("plan.hideClosed") : t("plan.showClosed", { n: closed.length })}
        </button>
      )}

      {adding && (
        <LineDialog
          patient={patient}
          plans={open}
          procedures={procedures}
          tooth={adding.tooth}
          planId={adding.plan}
          onClose={() => setAdding(null)}
          onSaved={() => {
            setAdding(null);
            data.reload("plans");
          }}
        />
      )}
      {newPlan && (
        <PlanDialog
          patient={patient}
          onClose={() => setNewPlan(false)}
          onSaved={() => {
            setNewPlan(false);
            data.reload("plans");
          }}
        />
      )}
      {booking && (
        <AppointmentDialog
          initial={{ patient, procedure: booking.procedure, reason: [lineName(booking, lang), booking.tooth ? t("tooth.label", { n: booking.tooth }) : ""].filter(Boolean).join(", ") }}
          onClose={() => setBooking(null)}
          onSaved={(a: Appointment) => {
            const line = booking;
            setBooking(null);
            onVisitsChanged();
            void run(() => patch(`/api/clinical/plan-lines/${line.id}/`, { appointment: a.id }));
          }}
        />
      )}
    </Section>
  );
}

function DentistField({ value, onChange, error }: { value: number | null; onChange: (v: number | null) => void; error?: string[] }) {
  const { t, name } = useI18n();
  const [dentists, setDentists] = useState<{ id: number; name_en: string; name_ar: string }[]>([]);
  useEffect(() => {
    getAll<{ id: number; name_en: string; name_ar: string }>("/api/masterdata/staff/?staff_type=dentist&is_active=true")
      .then(setDentists)
      .catch(() => undefined);
  }, []);
  return (
    <label className="field">
      <span>{t("ap.dentist")}</span>
      <select value={value ?? ""} onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)} required>
        <option value="">—</option>
        {dentists.map((d) => (
          <option key={d.id} value={d.id}>{name(d)}</option>
        ))}
      </select>
      {error && <span className="field-error">{error.join(" ")}</span>}
    </label>
  );
}

/** Dentists add records under their own name; anyone else picks the dentist. */
function useNeedsDentist() {
  const { me } = useAuth();
  return me?.staff_member?.staff_type !== "dentist";
}

function PlanDialog({ patient, onClose, onSaved }: { patient: Patient; onClose: () => void; onSaved: (plan: TreatmentPlan) => void }) {
  const { t } = useI18n();
  const needsDentist = useNeedsDentist();
  const [title, setTitle] = useState("");
  const [notes, setNotes] = useState("");
  const [dentist, setDentist] = useState<number | null>(patient.preferred_dentist);
  const [error, setError] = useState("");
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      onSaved(await post<TreatmentPlan>("/api/clinical/plans/", { patient: patient.id, title, notes, ...(needsDentist ? { dentist } : {}) }));
    } catch (err) {
      setError(errorText(err));
    }
  };
  return (
    <Modal title={t("plan.new")} onClose={onClose}>
      <form className="form-grid" onSubmit={submit}>
        <label className="field">
          <span>{t("plan.planTitle")}</span>
          <input value={title} placeholder={t("plan.defaultTitle")} onChange={(e) => setTitle(e.target.value)} />
        </label>
        {needsDentist && <DentistField value={dentist} onChange={setDentist} />}
        <label className="field">
          <span>{t("notes")}</span>
          <textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
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

function LineDialog({
  patient,
  plans,
  procedures,
  tooth,
  planId,
  onClose,
  onSaved,
}: {
  patient: Patient;
  plans: TreatmentPlan[];
  procedures: Procedure[];
  tooth: number | null;
  planId?: number;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t, name } = useI18n();
  const needsDentist = useNeedsDentist();
  const [plan, setPlan] = useState<number | "new">(planId ?? plans[0]?.id ?? "new");
  const [planPicked, setPlanPicked] = useState(false);
  // The plan list can arrive after the dialog opens; add to it rather than starting another plan.
  useEffect(() => {
    if (!planPicked && plan === "new" && plans[0]) setPlan(plans[0].id);
  }, [plans, plan, planPicked]);
  const [dentist, setDentist] = useState<number | null>(patient.preferred_dentist);
  const [procedure, setProcedure] = useState<number | null>(null);
  const [toothNo, setToothNo] = useState<number | null>(tooth);
  const [surfaces, setSurfaces] = useState<string[]>([]);
  const [price, setPrice] = useState("");
  const [discount, setDiscount] = useState("");
  const [notes, setNotes] = useState("");
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  const pickProcedure = (id: number | null) => {
    setProcedure(id);
    const proc = procedures.find((p) => p.id === id);
    if (proc) setPrice(String(Number(proc.default_price)));
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErrors({});
    setMessage("");
    try {
      let planIdToUse = plan;
      if (planIdToUse === "new") {
        const created = await post<TreatmentPlan>("/api/clinical/plans/", { patient: patient.id, title: "", ...(needsDentist ? { dentist } : {}) });
        planIdToUse = created.id;
        setPlan(created.id);
      }
      await post("/api/clinical/plan-lines/", {
        plan: planIdToUse,
        procedure,
        tooth: toothNo,
        surfaces: surfaces.join(""),
        ...(price !== "" ? { price } : {}),
        ...(discount !== "" ? { discount } : {}),
        notes,
      });
      onSaved();
    } catch (err) {
      if (err instanceof ApiError) {
        setErrors(err.fields);
        setMessage(errorText(err));
      } else setMessage(String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={t("plan.addProcedure")} onClose={onClose}>
      <form className="form-grid form-grid-2" onSubmit={submit}>
        {plans.length > 0 && (
          <label className="field span-all">
            <span>{t("plan.title")}</span>
            <select
              value={plan}
              onChange={(e) => {
                setPlanPicked(true);
                setPlan(e.target.value === "new" ? "new" : Number(e.target.value));
              }}
            >
              {plans.map((p) => (
                <option key={p.id} value={p.id}>{`${p.title || t("plan.defaultTitle")} (${t(`plan.status.${p.status}` as TKey)})`}</option>
              ))}
              <option value="new">{t("plan.startNew")}</option>
            </select>
          </label>
        )}
        {plan === "new" && needsDentist && (
          <div className="span-all">
            <DentistField value={dentist} onChange={setDentist} error={errors.dentist} />
          </div>
        )}
        <label className="field span-all">
          <span>{t("plan.procedure")}</span>
          <select required value={procedure ?? ""} onChange={(e) => pickProcedure(e.target.value ? Number(e.target.value) : null)}>
            <option value="">—</option>
            {procedures.map((p) => (
              <option key={p.id} value={p.id}>{`${p.code} · ${name(p)}`}</option>
            ))}
          </select>
          {errors.procedure && <span className="field-error">{errors.procedure.join(" ")}</span>}
        </label>
        <label className="field">
          <span>{t("plan.tooth")}</span>
          <select value={toothNo ?? ""} onChange={(e) => setToothNo(e.target.value ? Number(e.target.value) : null)}>
            <option value="">{t("plan.wholeMouth")}</option>
            {[...ALL_TEETH].sort((a, b) => a - b).map((n) => (
              <option key={n} value={n}>{`${n} · ${toothName(n, t)}`}</option>
            ))}
          </select>
        </label>
        <fieldset className="field">
          <legend>{t("chart.surfaces")}</legend>
          <div className="surface-checks">
            {SURFACES.map((s) => (
              <label key={s} className="check-pill" title={t(`surface.${s}` as TKey)}>
                <input
                  type="checkbox"
                  aria-label={t(`surface.${s}` as TKey)}
                  checked={surfaces.includes(s)}
                  disabled={!toothNo}
                  onChange={(e) => setSurfaces((cur) => (e.target.checked ? [...cur, s] : cur.filter((x) => x !== s)))}
                />
                {s}
              </label>
            ))}
          </div>
        </fieldset>
        <label className="field">
          <span>{t("plan.price")}</span>
          <input type="number" min="0" step="0.01" dir="ltr" value={price} onChange={(e) => setPrice(e.target.value)} />
          {errors.price && <span className="field-error">{errors.price.join(" ")}</span>}
        </label>
        <label className="field">
          <span>{t("plan.discount")}</span>
          <input type="number" min="0" step="0.01" dir="ltr" value={discount} onChange={(e) => setDiscount(e.target.value)} />
          {errors.discount && <span className="field-error">{errors.discount.join(" ")}</span>}
        </label>
        <label className="field span-all">
          <span>{t("notes")}</span>
          <input value={notes} onChange={(e) => setNotes(e.target.value)} />
        </label>
        {message && <p className="form-error span-all" role="alert">{message}</p>}
        <div className="form-actions span-all">
          <button type="button" className="btn" onClick={onClose}>{t("cancel")}</button>
          <button type="submit" className="btn btn-primary" disabled={busy}>{t("save")}</button>
        </div>
      </form>
    </Modal>
  );
}

/* ----------------------------------------------------------- visit notes */

export function VisitNotesCard({
  patient,
  data,
  visits,
  openSignal,
}: {
  patient: Patient;
  data: ClinicalData;
  visits: Appointment[];
  openSignal: number;
}) {
  const { t, lang } = useI18n();
  const { can } = useAuth();
  const [editing, setEditing] = useState<{ note: VisitNote | null } | null>(null);
  const [error, setError] = useState("");
  const lineById = useMemo(() => new Map(data.plans.flatMap((p) => p.lines).map((l) => [l.id, l])), [data.plans]);

  useEffect(() => {
    if (openSignal > 0) setEditing({ note: null });
  }, [openSignal]);

  const sign = async (note: VisitNote) => {
    if (!window.confirm(t("note.confirmSign"))) return;
    try {
      await post(`/api/clinical/visit-notes/${note.id}/sign/`, {});
      data.reload("notes");
    } catch (err) {
      setError(errorText(err));
    }
  };

  return (
    <Section
      id="clinical-notes"
      title={t("note.title")}
      aside={
        can("clinical", "create") && patient.is_active ? (
          <button className="btn btn-primary" onClick={() => setEditing({ note: null })}>
            <Icon name="plus" size={18} /> {t("note.new")}
          </button>
        ) : undefined
      }
    >
      {error && <p className="form-error" role="alert">{error}</p>}
      {data.notes.length === 0 ? (
        <p className="muted">{t("note.empty")}</p>
      ) : (
        <ol className="timeline">
          {data.notes.map((note, i) => (
            <li key={note.id} className={i === 0 ? "latest" : ""}>
              <span className="timeline-dot" aria-hidden="true" />
              <p className="timeline-date mono">{fmtDate(note.visit_date, lang)}</p>
              <div className="timeline-body">
                <p className="timeline-title">
                  {note.work_done.split("\n")[0] || note.findings.split("\n")[0] || note.complaint || t("note.title")}
                  {note.signed_at ? (
                    <span className="pill pill-ok">{t("note.signed")}</span>
                  ) : (
                    <span className="pill pill-warn">{t("note.draft")}</span>
                  )}
                </p>
                <dl className="note-fields">
                  {(["complaint", "findings", "work_done", "next_step"] as const)
                    .filter((k) => note[k])
                    .map((k) => (
                      <div key={k}>
                        <dt>{t(`note.${k}` as TKey)}</dt>
                        <dd>{note[k]}</dd>
                      </div>
                    ))}
                </dl>
                {note.lines.length > 0 && (
                  <p className="note-lines">
                    {note.lines.map((id) => {
                      const line = lineById.get(id);
                      return line ? (
                        <span key={id} className="pill pill-outline">
                          {lineName(line, lang)}
                          {line.tooth ? ` · ${line.tooth}` : ""}
                        </span>
                      ) : null;
                    })}
                  </p>
                )}
                <p className="timeline-who">
                  {[staffLabel(note.dentist_name, lang), note.signed_at ? t("note.signedBy", { name: note.signed_by_name, date: fmtDate(note.signed_at, lang) }) : ""]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
                {!note.signed_at && (
                  <div className="toolbar">
                    {can("clinical", "edit") && (
                      <button className="btn btn-small" onClick={() => setEditing({ note })}>{t("edit")}</button>
                    )}
                    {can("clinical", "approve") && (
                      <button className="btn btn-small btn-primary" onClick={() => void sign(note)}>{t("note.sign")}</button>
                    )}
                  </div>
                )}
              </div>
            </li>
          ))}
        </ol>
      )}
      {editing && (
        <NoteDialog
          patient={patient}
          note={editing.note}
          plans={data.plans}
          visits={visits}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            data.reload("notes");
            data.reload("plans");
          }}
        />
      )}
    </Section>
  );
}

function NoteDialog({
  patient,
  note,
  plans,
  visits,
  onClose,
  onSaved,
}: {
  patient: Patient;
  note: VisitNote | null;
  plans: TreatmentPlan[];
  visits: Appointment[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t, lang } = useI18n();
  const { can } = useAuth();
  const needsDentist = useNeedsDentist();
  const todayIso = today();
  const todaysVisit = visits.find((v) => v.start.slice(0, 10) === todayIso && v.status !== "cancelled");
  const [values, setValues] = useState({
    visit_date: note?.visit_date ?? todayIso,
    appointment: note?.appointment ?? todaysVisit?.id ?? null,
    complaint: note?.complaint ?? "",
    findings: note?.findings ?? "",
    work_done: note?.work_done ?? "",
    next_step: note?.next_step ?? "",
  });
  const [dentist, setDentist] = useState<number | null>(note?.dentist ?? todaysVisit?.dentist ?? patient.preferred_dentist);
  const [completed, setCompleted] = useState<number[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const openLines = plans.filter((p) => OPEN_PLAN.includes(p.status)).flatMap((p) => p.lines.filter((l) => OPEN_LINE.includes(l.status)));
  const set = (k: keyof typeof values, v: string | number | null) => setValues((s) => ({ ...s, [k]: v }));

  const submit = async (andSign: boolean) => {
    setBusy(true);
    setError("");
    try {
      const body = { ...values, patient: patient.id, completed_lines: completed, ...(needsDentist && !note ? { dentist } : {}) };
      const saved = note ? await patch<VisitNote>(`/api/clinical/visit-notes/${note.id}/`, body) : await post<VisitNote>("/api/clinical/visit-notes/", body);
      if (andSign) await post(`/api/clinical/visit-notes/${saved.id}/sign/`, {});
      onSaved();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const area = (k: "complaint" | "findings" | "work_done" | "next_step") => (
    <label className="field span-all">
      <span>{t(`note.${k}` as TKey)}</span>
      <textarea rows={k === "work_done" || k === "findings" ? 3 : 2} value={values[k]} onChange={(e) => set(k, e.target.value)} />
    </label>
  );

  return (
    <Modal title={note ? t("note.edit") : t("note.new")} onClose={onClose}>
      <form
        className="form-grid form-grid-2"
        onSubmit={(e) => {
          e.preventDefault();
          void submit(false);
        }}
      >
        <label className="field">
          <span>{t("note.date")}</span>
          <input type="date" required value={values.visit_date} onChange={(e) => set("visit_date", e.target.value)} />
        </label>
        <label className="field">
          <span>{t("note.appointment")}</span>
          <select value={values.appointment ?? ""} onChange={(e) => set("appointment", e.target.value ? Number(e.target.value) : null)}>
            <option value="">—</option>
            {visits
              .filter((v) => v.status !== "cancelled")
              .map((v) => (
                <option key={v.id} value={v.id}>
                  {`${fmtDate(v.start, lang)} · ${(lang === "ar" ? v.procedure_name_ar : v.procedure_name_en) || v.reason || ""}`}
                </option>
              ))}
          </select>
        </label>
        {needsDentist && !note && (
          <div className="span-all">
            <DentistField value={dentist} onChange={setDentist} />
          </div>
        )}
        {area("complaint")}
        {area("findings")}
        {area("work_done")}
        {openLines.length > 0 && (
          <fieldset className="field span-all">
            <legend>{t("note.completedToday")}</legend>
            <div className="line-checks">
              {openLines.map((l) => (
                <label key={l.id} className="check">
                  <input
                    type="checkbox"
                    checked={completed.includes(l.id)}
                    onChange={(e) => setCompleted((c) => (e.target.checked ? [...c, l.id] : c.filter((x) => x !== l.id)))}
                  />
                  <span>
                    {lineName(l, lang)}
                    {l.tooth ? ` · ${t("tooth.label", { n: l.tooth })}` : ""}
                    {l.surfaces ? ` (${l.surfaces})` : ""}
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
        )}
        {area("next_step")}
        {error && <p className="form-error span-all" role="alert">{error}</p>}
        <div className="form-actions span-all">
          <button type="button" className="btn" onClick={onClose}>{t("cancel")}</button>
          <button type="submit" className="btn" disabled={busy}>{t("note.saveDraft")}</button>
          {can("clinical", "approve") && (
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void submit(true)}>
              {t("note.saveSign")}
            </button>
          )}
        </div>
      </form>
    </Modal>
  );
}

/* ---------------------------------------------------------------- print */

function escapeHtml(text: string) {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** Open a printable page in a new window: clinic letterhead, patient line, body. */
function printDocument({ title, lang, clinic, patient, body, footer }: { title: string; lang: string; clinic: { name: string; address: string; phone: string }; patient: string; body: string; footer: string }) {
  const win = window.open("", "_blank");
  if (!win) return;
  const dir = lang === "ar" ? "rtl" : "ltr";
  win.document.write(`<!doctype html><html lang="${lang}" dir="${dir}"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;600&family=IBM+Plex+Sans+Arabic:wght@400;600&family=Outfit:wght@600&display=swap" rel="stylesheet">
<style>
body{font-family:"IBM Plex Sans","IBM Plex Sans Arabic",system-ui,sans-serif;color:#16242F;margin:32px;font-size:14px;line-height:1.55}
header{display:flex;justify-content:space-between;align-items:center;border-bottom:2px solid #446681;padding-bottom:12px;margin-bottom:18px;gap:16px}
header img{height:56px}.clinic{text-align:end;font-size:12px;color:#3A4B5A}.clinic strong{font-family:Outfit,"IBM Plex Sans Arabic",sans-serif;font-size:18px;color:#16242F;display:block}
h1{font-family:Outfit,"IBM Plex Sans Arabic",sans-serif;font-size:22px;margin:0 0 8px}.patient{color:#3A4B5A;margin:0 0 18px}
table{width:100%;border-collapse:collapse}th,td{text-align:start;padding:8px;border-bottom:1px solid #DCE4EB;vertical-align:top}th{font-size:12px;color:#5A6B7B}
.rx{font-family:Outfit,serif;font-size:28px;color:#446681}.body{white-space:pre-wrap}.sign{margin-top:36px;display:flex;justify-content:space-between;gap:24px;align-items:flex-end}
.sign img{max-height:110px;display:block}.line{border-top:1px solid #16242F;min-width:220px;padding-top:4px;font-size:12px;color:#3A4B5A}
@media print{body{margin:12mm}}
</style></head><body>
<header><img src="${window.location.origin}/brand/logo.svg" alt=""><div class="clinic"><strong>${escapeHtml(clinic.name)}</strong>${escapeHtml(clinic.address)}<br><span dir="ltr">${escapeHtml(clinic.phone)}</span></div></header>
<h1>${escapeHtml(title)}</h1><p class="patient">${patient}</p>${body}${footer}
<script>window.onload=function(){setTimeout(function(){window.print()},300)}</script></body></html>`);
  win.document.close();
}

function useLetterhead(lang: string) {
  const { me } = useAuth();
  const c = me?.clinic;
  return {
    name: (lang === "ar" ? c?.name_ar || c?.name_en : c?.name_en || c?.name_ar) ?? "",
    address: (lang === "ar" ? c?.address_ar || c?.address_en : c?.address_en || c?.address_ar) ?? "",
    phone: c?.phone ?? "",
  };
}

function patientLine(patient: Patient, lang: string, t: T, date: string) {
  return [escapeHtml(patientName(patient, lang)), escapeHtml(patient.file_number), patient.age !== null ? escapeHtml(t("pt.years", { n: patient.age })) : "", escapeHtml(fmtDate(date, lang))]
    .filter(Boolean)
    .join(" · ");
}

/* ---------------------------------------------------------- prescriptions */

const COMMON_DRUGS = [
  "Amoxicillin 500 mg",
  "Amoxicillin + Clavulanic acid 1 g",
  "Metronidazole 500 mg",
  "Clindamycin 300 mg",
  "Azithromycin 500 mg",
  "Ibuprofen 400 mg",
  "Ibuprofen 600 mg",
  "Paracetamol 500 mg",
  "Diclofenac potassium 50 mg",
  "Ketoprofen 100 mg",
  "Chlorhexidine 0.12% mouthwash",
  "Benzocaine oral gel",
];
const FREQUENCIES: Record<string, string[]> = {
  en: ["Every 8 hours", "Every 12 hours", "Once a day", "Every 6 hours", "When needed for pain", "Rinse twice a day"],
  ar: ["كل ٨ ساعات", "كل ١٢ ساعة", "مرة يوميًا", "كل ٦ ساعات", "عند اللزوم للألم", "مضمضة مرتين يوميًا"],
};
const blankItem = (): RxItem => ({ drug: "", dose: "", frequency: "", duration: "", notes: "" });

export function PrescriptionsCard({ patient, data }: { patient: Patient; data: ClinicalData }) {
  const { t, lang } = useI18n();
  const { can } = useAuth();
  const letterhead = useLetterhead(lang);
  const [adding, setAdding] = useState(false);

  const print = (rx: Prescription) => {
    const rows = rx.items
      .map((i) => `<tr><td><strong dir="ltr">${escapeHtml(i.drug)}</strong>${i.notes ? `<br><small>${escapeHtml(i.notes)}</small>` : ""}</td><td>${escapeHtml(i.dose)}</td><td>${escapeHtml(i.frequency)}</td><td>${escapeHtml(i.duration)}</td></tr>`)
      .join("");
    printDocument({
      title: t("rx.one"),
      lang,
      clinic: letterhead,
      patient: patientLine(patient, lang, t, rx.created_at),
      body: `<p class="rx">℞</p><table><thead><tr><th>${t("rx.drug")}</th><th>${t("rx.dose")}</th><th>${t("rx.frequency")}</th><th>${t("rx.duration")}</th></tr></thead><tbody>${rows}</tbody></table>${rx.notes ? `<p class="body">${escapeHtml(rx.notes)}</p>` : ""}`,
      footer: `<div class="sign"><span></span><div class="line">${escapeHtml(staffLabel(rx.dentist_name, lang))}</div></div>`,
    });
  };

  return (
    <SideSection
      id="prescriptions"
      title={t("rx.title")}
      aside={
        can("clinical", "create") && patient.is_active ? (
          <button className="btn btn-small" onClick={() => setAdding(true)}>
            <Icon name="plus" size={16} /> {t("rx.new")}
          </button>
        ) : undefined
      }
    >
      {data.prescriptions.length === 0 ? (
        <p className="muted small">{t("rx.empty")}</p>
      ) : (
        <ul className="plain-list rx-list">
          {data.prescriptions.map((rx) => (
            <li key={rx.id}>
              <div className="grow">
                <p className="strong" dir="auto">{rx.items.map((i) => i.drug).join(", ")}</p>
                <p className="muted small">{[fmtDate(rx.created_at, lang), staffLabel(rx.dentist_name, lang)].filter(Boolean).join(" · ")}</p>
              </div>
              <button className="btn btn-small" onClick={() => print(rx)}>{t("print")}</button>
            </li>
          ))}
        </ul>
      )}
      {adding && (
        <RxDialog
          patient={patient}
          onClose={() => setAdding(false)}
          onSaved={(rx) => {
            setAdding(false);
            data.reload("prescriptions");
            print(rx);
          }}
        />
      )}
    </SideSection>
  );
}

function RxDialog({ patient, onClose, onSaved }: { patient: Patient; onClose: () => void; onSaved: (rx: Prescription) => void }) {
  const { t, lang } = useI18n();
  const needsDentist = useNeedsDentist();
  const [items, setItems] = useState<RxItem[]>([blankItem()]);
  const [notes, setNotes] = useState("");
  const [dentist, setDentist] = useState<number | null>(patient.preferred_dentist);
  const [error, setError] = useState("");
  const update = (i: number, key: keyof RxItem, value: string) => setItems((rows) => rows.map((r, j) => (j === i ? { ...r, [key]: value } : r)));
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const filled = items.filter((i) => i.drug.trim());
      onSaved(await post<Prescription>("/api/clinical/prescriptions/", { patient: patient.id, items: filled, notes, ...(needsDentist ? { dentist } : {}) }));
    } catch (err) {
      setError(errorText(err));
    }
  };
  return (
    <Modal title={t("rx.new")} onClose={onClose}>
      <form className="form-grid" onSubmit={submit}>
        {patient.alerts.length > 0 && (
          <p className="alert-pills">
            {patient.alerts.map((a) => (
              <span key={a.id} className="pill pill-alert">{a.text}</span>
            ))}
          </p>
        )}
        {needsDentist && <DentistField value={dentist} onChange={setDentist} />}
        <datalist id="rx-drugs">{COMMON_DRUGS.map((d) => <option key={d} value={d} />)}</datalist>
        <datalist id="rx-freq">{FREQUENCIES[lang].map((d) => <option key={d} value={d} />)}</datalist>
        {items.map((item, i) => (
          <fieldset key={i} className="rx-item">
            <legend>{t("rx.medicine", { n: i + 1 })}</legend>
            <label className="field rx-drug">
              <span>{t("rx.drug")}</span>
              <input list="rx-drugs" dir="ltr" required={i === 0} value={item.drug} onChange={(e) => update(i, "drug", e.target.value)} />
            </label>
            <label className="field">
              <span>{t("rx.dose")}</span>
              <input value={item.dose} placeholder={t("rx.dosePh")} onChange={(e) => update(i, "dose", e.target.value)} />
            </label>
            <label className="field">
              <span>{t("rx.frequency")}</span>
              <input list="rx-freq" value={item.frequency} onChange={(e) => update(i, "frequency", e.target.value)} />
            </label>
            <label className="field">
              <span>{t("rx.duration")}</span>
              <input value={item.duration} placeholder={t("rx.durationPh")} onChange={(e) => update(i, "duration", e.target.value)} />
            </label>
            <label className="field rx-drug">
              <span>{t("rx.instructions")}</span>
              <input value={item.notes} onChange={(e) => update(i, "notes", e.target.value)} />
            </label>
            {items.length > 1 && (
              <button type="button" className="link-button" onClick={() => setItems((rows) => rows.filter((_, j) => j !== i))}>{t("rx.remove")}</button>
            )}
          </fieldset>
        ))}
        <button type="button" className="btn" onClick={() => setItems((rows) => [...rows, blankItem()])}>
          <Icon name="plus" size={16} /> {t("rx.addMedicine")}
        </button>
        <label className="field">
          <span>{t("notes")}</span>
          <textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </label>
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="form-actions">
          <button type="button" className="btn" onClick={onClose}>{t("cancel")}</button>
          <button type="submit" className="btn btn-primary">{t("rx.saveprint")}</button>
        </div>
      </form>
    </Modal>
  );
}

/* --------------------------------------------------------------- consent */

export function ConsentsCard({ patient, data }: { patient: Patient; data: ClinicalData }) {
  const { t, lang } = useI18n();
  const { can } = useAuth();
  const [adding, setAdding] = useState(false);
  const [signing, setSigning] = useState<PatientConsent | null>(null);
  const [error, setError] = useState("");
  const letterhead = useLetterhead(lang);

  const print = (c: PatientConsent) => {
    const footer = c.signed_at
      ? `<div class="sign"><div><img src="${c.signature}" alt=""><div class="line">${escapeHtml(c.signer_name)}${c.signer_relation ? ` (${escapeHtml(c.signer_relation)})` : ""}</div></div><div class="line">${escapeHtml(fmtDate(c.signed_at, c.language))}</div></div>`
      : `<div class="sign"><div class="line">${escapeHtml(t("consent.signature"))}</div><div class="line">${escapeHtml(t("note.date"))}</div></div>`;
    printDocument({
      title: c.title,
      lang: c.language,
      clinic: { ...letterhead },
      patient: patientLine(patient, c.language, t, c.signed_at ?? c.created_at),
      body: `<div class="body">${escapeHtml(c.body)}</div>`,
      footer,
    });
  };
  const remove = async (c: PatientConsent) => {
    if (!window.confirm(t("confirmDelete"))) return;
    try {
      await del(`/api/clinical/consents/${c.id}/`);
      data.reload("consents");
    } catch (err) {
      setError(errorText(err));
    }
  };

  return (
    <SideSection
      id="consents"
      title={t("consent.title")}
      aside={
        can("clinical", "create") && patient.is_active ? (
          <button className="btn btn-small" onClick={() => setAdding(true)}>
            <Icon name="plus" size={16} /> {t("consent.new")}
          </button>
        ) : undefined
      }
    >
      {error && <p className="form-error" role="alert">{error}</p>}
      {data.consents.length === 0 ? (
        <p className="muted small">{t("consent.empty")}</p>
      ) : (
        <ul className="plain-list rx-list">
          {data.consents.map((c) => (
            <li key={c.id}>
              <div className="grow">
                <p className="strong" dir="auto">{c.title}</p>
                <p className="small">
                  {c.signed_at ? (
                    <span className="pill pill-ok">{t("consent.signedOn", { date: fmtDate(c.signed_at, lang) })}</span>
                  ) : (
                    <span className="pill pill-warn">{t("consent.waiting")}</span>
                  )}
                </p>
              </div>
              <div className="toolbar">
                {!c.signed_at && can("clinical", "edit") && (
                  <button className="btn btn-small btn-primary" onClick={() => setSigning(c)}>{t("consent.sign")}</button>
                )}
                <button className="btn btn-small" onClick={() => print(c)}>{t("print")}</button>
                {!c.signed_at && can("clinical", "delete") && (
                  <button className="btn btn-small" onClick={() => void remove(c)}>{t("delete")}</button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {adding && (
        <ConsentDialog
          patient={patient}
          lines={data.plans.filter((p) => OPEN_PLAN.includes(p.status)).flatMap((p) => p.lines.filter((l) => OPEN_LINE.includes(l.status)))}
          onClose={() => setAdding(false)}
          onSaved={(c) => {
            setAdding(false);
            data.reload("consents");
            if (can("clinical", "edit")) setSigning(c);
          }}
        />
      )}
      {signing && (
        <SignDialog
          patient={patient}
          consent={signing}
          onClose={() => setSigning(null)}
          onSigned={() => {
            setSigning(null);
            data.reload("consents");
          }}
        />
      )}
    </SideSection>
  );
}

function ConsentDialog({ patient, lines, onClose, onSaved }: { patient: Patient; lines: PlanLine[]; onClose: () => void; onSaved: (c: PatientConsent) => void }) {
  const { t, lang } = useI18n();
  const [templates, setTemplates] = useState<ConsentTemplate[]>([]);
  const [template, setTemplate] = useState<number | null>(null);
  const [language, setLanguage] = useState<"ar" | "en">(patient.language ?? "ar");
  const [line, setLine] = useState<number | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    getAll<ConsentTemplate>("/api/clinical/consent-templates/?is_active=true")
      .then((rows) => {
        setTemplates(rows);
        setTemplate((cur) => cur ?? rows[0]?.id ?? null);
      })
      .catch((err) => setError(errorText(err)));
  }, []);
  const chosen = templates.find((x) => x.id === template);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      onSaved(await post<PatientConsent>("/api/clinical/consents/", { patient: patient.id, template, language, plan_line: line }));
    } catch (err) {
      setError(errorText(err));
    }
  };
  return (
    <Modal title={t("consent.new")} onClose={onClose}>
      <form className="form-grid form-grid-2" onSubmit={submit}>
        <label className="field span-all">
          <span>{t("consent.form")}</span>
          <select required value={template ?? ""} onChange={(e) => setTemplate(Number(e.target.value) || null)}>
            {templates.map((x) => (
              <option key={x.id} value={x.id}>{lang === "ar" ? x.title_ar || x.title_en : x.title_en || x.title_ar}</option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>{t("consent.language")}</span>
          <select value={language} onChange={(e) => setLanguage(e.target.value as "ar" | "en")}>
            <option value="ar">العربية</option>
            <option value="en">English</option>
          </select>
        </label>
        <label className="field">
          <span>{t("consent.forProcedure")}</span>
          <select value={line ?? ""} onChange={(e) => setLine(Number(e.target.value) || null)}>
            <option value="">—</option>
            {lines.map((l) => (
              <option key={l.id} value={l.id}>{`${lineName(l, lang)}${l.tooth ? ` · ${l.tooth}` : ""}`}</option>
            ))}
          </select>
        </label>
        {chosen && (
          <div className="consent-preview span-all" dir={language === "ar" ? "rtl" : "ltr"} lang={language}>
            {language === "ar" ? chosen.body_ar || chosen.body_en : chosen.body_en || chosen.body_ar}
          </div>
        )}
        {error && <p className="form-error span-all" role="alert">{error}</p>}
        <div className="form-actions span-all">
          <button type="button" className="btn" onClick={onClose}>{t("cancel")}</button>
          <button type="submit" className="btn btn-primary" disabled={!template}>{t("consent.continue")}</button>
        </div>
      </form>
    </Modal>
  );
}

function SignDialog({ patient, consent, onClose, onSigned }: { patient: Patient; consent: PatientConsent; onClose: () => void; onSigned: () => void }) {
  const { t } = useI18n();
  const [signer, setSigner] = useState(patientName(patient, consent.language));
  const [relation, setRelation] = useState("");
  const [signature, setSignature] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!signature) {
      setError(t("consent.signFirst"));
      return;
    }
    setBusy(true);
    try {
      await post(`/api/clinical/consents/${consent.id}/sign/`, { signer_name: signer, signer_relation: relation, signature });
      onSigned();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={consent.title} onClose={onClose}>
      <form className="form-grid" onSubmit={submit}>
        <div className="consent-preview" dir={consent.language === "ar" ? "rtl" : "ltr"} lang={consent.language}>
          {consent.body}
        </div>
        <div className="form-grid form-grid-2">
          <label className="field">
            <span>{t("consent.signer")}</span>
            <input required value={signer} onChange={(e) => setSigner(e.target.value)} />
          </label>
          <label className="field">
            <span>{t("consent.relation")}</span>
            <input value={relation} placeholder={t("consent.relationPh")} onChange={(e) => setRelation(e.target.value)} />
          </label>
        </div>
        <SignaturePad onChange={setSignature} />
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="form-actions">
          <button type="button" className="btn" onClick={onClose}>{t("cancel")}</button>
          <button type="submit" className="btn btn-primary" disabled={busy}>{t("consent.sign")}</button>
        </div>
      </form>
    </Modal>
  );
}

export function SignaturePad({ onChange }: { onChange: (dataUrl: string) => void }) {
  const { t } = useI18n();
  const canvas = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const [empty, setEmpty] = useState(true);

  const reset = useCallback(() => {
    const c = canvas.current;
    if (!c) return;
    const ratio = window.devicePixelRatio || 1;
    c.width = c.offsetWidth * ratio;
    c.height = c.offsetHeight * ratio;
    const ctx = c.getContext("2d")!;
    ctx.scale(ratio, ratio);
    ctx.fillStyle = "#FFFFFF";
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.lineWidth = 2.4;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "#16242F";
    setEmpty(true);
    onChange("");
  }, [onChange]);
  useEffect(reset, [reset]);

  const point = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return [e.clientX - rect.left, e.clientY - rect.top] as const;
  };
  return (
    <div className="signature">
      <div className="signature-head">
        <span>{t("consent.signHere")}</span>
        <button type="button" className="link-button" onClick={reset}>{t("consent.clear")}</button>
      </div>
      <canvas
        ref={canvas}
        className="signature-pad"
        aria-label={t("consent.signHere")}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          drawing.current = true;
          const ctx = e.currentTarget.getContext("2d")!;
          const [x, y] = point(e);
          ctx.beginPath();
          ctx.moveTo(x, y);
          ctx.lineTo(x + 0.1, y + 0.1);
          ctx.stroke();
        }}
        onPointerMove={(e) => {
          if (!drawing.current) return;
          const ctx = e.currentTarget.getContext("2d")!;
          const [x, y] = point(e);
          ctx.lineTo(x, y);
          ctx.stroke();
        }}
        onPointerUp={(e) => {
          if (!drawing.current) return;
          drawing.current = false;
          setEmpty(false);
          onChange(e.currentTarget.toDataURL("image/png"));
        }}
      />
      {empty && <p className="muted small">{t("consent.signHint")}</p>}
    </div>
  );
}

/* --------------------------------------------------------------- imaging */

export const IMAGING_KINDS = ["xray", "photo", "scan"];
type FileRow = { id: number; original_name: string; kind: string; description: string; content_type_header: string; created_at: string; download_url: string };

async function blobUrl(path: string) {
  const res = await fetch(path, { headers: tokens.access ? { Authorization: `Bearer ${tokens.access}` } : {} });
  if (!res.ok) throw new ApiError(res.status, res.statusText);
  return URL.createObjectURL(await res.blob());
}

export function ImagingCard({ patient, onChanged }: { patient: Patient; onChanged: () => void }) {
  const { t, lang } = useI18n();
  const { can } = useAuth();
  const [files, setFiles] = useState<FileRow[]>([]);
  const [thumbs, setThumbs] = useState<Record<number, string>>({});
  const [kind, setKind] = useState("xray");
  const [filter, setFilter] = useState("all");
  const [viewing, setViewing] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const thumbsRef = useRef(thumbs);
  thumbsRef.current = thumbs;

  const load = useCallback(() => {
    getAll<FileRow>(`/api/files/?attached_model=patients.patient&attached_id=${patient.id}`)
      .then((rows) => setFiles(rows.filter((f) => IMAGING_KINDS.includes(f.kind))))
      .catch((err) => setError(errorText(err)));
  }, [patient.id]);
  useEffect(load, [load]);
  useEffect(() => {
    for (const f of files) {
      if (f.content_type_header.startsWith("image/") && !thumbsRef.current[f.id]) {
        blobUrl(f.download_url)
          .then((url) => setThumbs((m) => ({ ...m, [f.id]: url })))
          .catch(() => undefined);
      }
    }
  }, [files]);
  useEffect(() => () => Object.values(thumbsRef.current).forEach((u) => URL.revokeObjectURL(u)), []);

  const upload = async (list: FileList) => {
    setBusy(true);
    setError("");
    try {
      for (const file of Array.from(list)) {
        const form = new FormData();
        form.append("file", file);
        form.append("kind", kind);
        form.append("attached_model", "patients.patient");
        form.append("attached_id", String(patient.id));
        await post("/api/files/", form);
      }
      load();
      onChanged();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const shown = files.filter((f) => filter === "all" || f.kind === filter);
  const images = shown.filter((f) => thumbs[f.id]);

  return (
    <Section
      id="imaging"
      title={t("img.title")}
      aside={
        can("files", "create") ? (
          <div className="inline-form">
            <select aria-label={t("pt.fileKind")} value={kind} onChange={(e) => setKind(e.target.value)}>
              {IMAGING_KINDS.map((k) => (
                <option key={k} value={k}>{t(`file.kind.${k}` as TKey)}</option>
              ))}
            </select>
            <label className={`btn btn-primary ${busy ? "disabled" : ""}`}>
              <Icon name="plus" size={18} /> {busy ? t("img.uploading") : t("img.upload")}
              <input
                type="file"
                hidden
                multiple
                disabled={busy}
                accept="image/*,.stl,.ply,.obj,.dcm,.pdf"
                onChange={(e) => {
                  if (e.target.files?.length) void upload(e.target.files);
                  e.target.value = "";
                }}
              />
            </label>
          </div>
        ) : undefined
      }
    >
      <div className="segmented" role="tablist" aria-label={t("img.filter")}>
        {["all", ...IMAGING_KINDS].map((k) => (
          <button key={k} role="tab" aria-selected={filter === k} className={filter === k ? "active" : ""} onClick={() => setFilter(k)}>
            {k === "all" ? t("img.all", { n: files.length }) : t(`file.kind.${k}` as TKey)}
          </button>
        ))}
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
      {shown.length === 0 ? (
        <p className="muted">{t("img.empty")}</p>
      ) : (
        <ul className="image-grid">
          {shown.map((f) => (
            <li key={f.id}>
              <button
                className="image-tile"
                onClick={() => (thumbs[f.id] ? setViewing(f.id) : void openProtectedFile(f.download_url))}
                aria-label={`${t(`file.kind.${f.kind}` as TKey)}: ${f.description || f.original_name}`}
              >
                {thumbs[f.id] ? (
                  <img src={thumbs[f.id]} alt="" className={f.kind === "xray" ? "is-xray" : ""} />
                ) : (
                  <span className={`file-tile kind-${f.kind}`}>{f.original_name.split(".").pop()?.toUpperCase()}</span>
                )}
                <span className="image-meta">
                  <span className="file-name">{f.description || f.original_name}</span>
                  <span className="muted small">{`${t(`file.kind.${f.kind}` as TKey)} · ${fmtDate(f.created_at, lang)}`}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {viewing !== null && (
        <ImageViewer
          files={images}
          urls={thumbs}
          start={Math.max(0, images.findIndex((f) => f.id === viewing))}
          onClose={() => setViewing(null)}
        />
      )}
    </Section>
  );
}

function ImageViewer({ files, urls, start, onClose }: { files: FileRow[]; urls: Record<number, string>; start: number; onClose: () => void }) {
  const { t, lang } = useI18n();
  const [index, setIndex] = useState(start);
  const [zoom, setZoom] = useState(1);
  const [brightness, setBrightness] = useState(100);
  const [contrast, setContrast] = useState(100);
  const [invert, setInvert] = useState(false);
  const file = files[index];
  const go = (step: number) => {
    setIndex((i) => (i + step + files.length) % files.length);
    setZoom(1);
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight") go(lang === "ar" ? -1 : 1);
      if (e.key === "ArrowLeft") go(lang === "ar" ? 1 : -1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  if (!file) return null;
  return (
    <Modal title={file.description || file.original_name} onClose={onClose}>
      <div className="viewer">
        <div className="viewer-stage">
          <img
            src={urls[file.id]}
            alt={file.description || file.original_name}
            style={{ transform: `scale(${zoom})`, filter: `brightness(${brightness}%) contrast(${contrast}%) ${invert ? "invert(1)" : ""}` }}
          />
        </div>
        <div className="viewer-tools">
          <button className="btn btn-small" onClick={() => setZoom((z) => Math.max(0.5, z - 0.25))} aria-label={t("img.zoomOut")}>−</button>
          <span className="mono small">{Math.round(zoom * 100)}%</span>
          <button className="btn btn-small" onClick={() => setZoom((z) => Math.min(4, z + 0.25))} aria-label={t("img.zoomIn")}>+</button>
          <label className="viewer-slider">
            {t("img.brightness")}
            <input type="range" min="40" max="200" value={brightness} onChange={(e) => setBrightness(Number(e.target.value))} />
          </label>
          <label className="viewer-slider">
            {t("img.contrast")}
            <input type="range" min="40" max="250" value={contrast} onChange={(e) => setContrast(Number(e.target.value))} />
          </label>
          <label className="check-pill">
            <input type="checkbox" checked={invert} onChange={(e) => setInvert(e.target.checked)} />
            {t("img.invert")}
          </label>
          <button
            className="btn btn-small"
            onClick={() => {
              setZoom(1);
              setBrightness(100);
              setContrast(100);
              setInvert(false);
            }}
          >
            {t("img.reset")}
          </button>
        </div>
        <div className="form-actions">
          {files.length > 1 && (
            <>
              <button className="btn" onClick={() => go(-1)}>{t("img.previous")}</button>
              <span className="muted small">{t("img.position", { i: index + 1, n: files.length })}</span>
              <button className="btn" onClick={() => go(1)}>{t("img.next")}</button>
            </>
          )}
          <button className="btn btn-primary" onClick={onClose}>{t("close")}</button>
        </div>
      </div>
    </Modal>
  );
}
