import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import { ApiError, api, del, get, getAll, openProtectedFile, patch, post } from "../api";
import { useAuth } from "../auth";
import { useI18n, type TKey } from "../i18n";
import { Field, Modal, RecordForm } from "../components/Crud";
import { Icon } from "../components/Icon";
import { ALERT_KINDS, FILE_KINDS, cleanPatient, patientFields } from "../components/patientFields";
import { isoDay, timeOf } from "../dates";
import type { Appointment, Patient } from "../types";
import { patientName, useChoices } from "./Patients";
import { AppointmentDialog } from "./Appointments";
import {
  ChartCard,
  ConsentsCard,
  IMAGING_KINDS,
  ImagingCard,
  PlanCard,
  PlanProgress,
  PrescriptionsCard,
  VisitNotesCard,
  useClinical,
} from "./PatientClinical";

// Layout follows the approved patient card design (handoff in the project files).
// Clinical sections live in PatientClinical.tsx; billing and lab arrive with phases 3 and 4.

const CONDITIONS = [
  "diabetes",
  "hypertension",
  "heart_disease",
  "bleeding_disorder",
  "blood_thinners",
  "asthma",
  "epilepsy",
  "hepatitis",
  "kidney_disease",
  "pregnant",
  "smoker",
] as const;
const HISTORY_TEXT = ["allergies", "medications", "anaesthesia_reactions", "past_surgeries", "notes"] as const;
const PAST = ["completed", "no_show", "cancelled"];

type AlertRow = { id: number; patient: number; kind: string; text: string; guidance: string; is_active: boolean };
type FileRow = { id: number; original_name: string; kind: string; description: string; size: number; created_at: string; download_url: string };
type NoteRow = { id: number; text: string; author: string; created_at: string };
type History = Record<string, boolean | string>;

function locale(lang: string) {
  return lang === "ar" ? "ar-EG" : "en-GB";
}
function shortDate(iso: string, lang: string) {
  return new Date(iso).toLocaleDateString(locale(lang), { day: "numeric", month: "short", year: "numeric" });
}
function initials(p: Patient) {
  const source = p.name_en || p.name_ar;
  return source
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase();
}
function procedureLabel(a: Appointment, lang: string) {
  return (lang === "ar" ? a.procedure_name_ar : a.procedure_name_en) || a.reason;
}
function dentistLabel(a: Appointment, lang: string) {
  return lang === "ar" ? a.dentist_name_ar : a.dentist_name_en;
}

export function PatientProfile() {
  const { id } = useParams();
  const { t, lang } = useI18n();
  const { can } = useAuth();
  const choices = useChoices();
  const [patient, setPatient] = useState<Patient | null>(null);
  const [visits, setVisits] = useState<Appointment[]>([]);
  const [fileCount, setFileCount] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState(false);
  const [dialog, setDialog] = useState<{ appointment?: Appointment } | null>(null);
  const [addFor, setAddFor] = useState<number | "any" | null>(null);
  const [noteSignal, setNoteSignal] = useState(0);
  const [filesVersion, setFilesVersion] = useState(0);
  const clinicalOn = can("clinical");
  const clinical = useClinical(Number(id), clinicalOn);
  const addHandled = useCallback(() => setAddFor(null), []);

  const load = useCallback(() => {
    get<Patient>(`/api/patients/${id}/`)
      .then(setPatient)
      .catch((err) => setError(err instanceof ApiError && err.status === 404 ? t("noRecords") : String(err.message ?? err)));
  }, [id, t]);
  const loadVisits = useCallback(() => {
    if (can("appointments")) get<Appointment[]>(`/api/appointments/?patient=${id}`).then(setVisits).catch(() => setVisits([]));
  }, [id, can]);
  useEffect(load, [load]);
  useEffect(loadVisits, [loadVisits]);

  if (error) return <p className="form-error pad">{error}</p>;
  if (!patient) return <p className="muted pad">{t("loading")}</p>;

  const now = Date.now();
  const past = visits.filter((v) => PAST.includes(v.status) || new Date(v.start).getTime() < now).reverse();
  const upcoming = visits.filter((v) => !PAST.includes(v.status) && new Date(v.start).getTime() >= now);
  const lastVisit = past.find((v) => v.status === "completed");
  const next = upcoming[0];
  const missed = past.filter((v) => v.status === "no_show").length;

  const save = async (values: Record<string, unknown>) => {
    setPatient(await patch<Patient>(`/api/patients/${patient.id}/`, cleanPatient(values)));
    setEditing(false);
  };
  const setActive = async (active: boolean) => {
    if (!active && !window.confirm(t("pt.confirmClose"))) return;
    if (active) setPatient(await patch<Patient>(`/api/patients/${patient.id}/`, { is_active: true }));
    else {
      await del(`/api/patients/${patient.id}/`);
      load();
    }
  };
  const otherName = lang === "ar" ? patient.name_en : patient.name_ar;
  const sections: { id: string; label: TKey; show: boolean }[] = [
    { id: "chart", label: "chart.title", show: clinicalOn },
    { id: "plan", label: "plan.title", show: clinicalOn },
    { id: "visits", label: "pt.visitHistory", show: can("appointments") },
    { id: "clinical-notes", label: "note.title", show: clinicalOn },
    { id: "imaging", label: "img.title", show: can("files") },
    { id: "medical", label: can("clinical") ? "pt.history" : "pt.alerts", show: true },
    { id: "prescriptions", label: "rx.title", show: clinicalOn },
    { id: "consents", label: "consent.title", show: clinicalOn },
    { id: "personal", label: "pt.personal", show: true },
    { id: "files", label: "pt.files", show: can("files") },
    { id: "notes", label: "pt.staffNotes", show: true },
  ];

  return (
    <div className="page patient-file">
      <nav className="breadcrumb" aria-label="Breadcrumb">
        <Link to="/patients">{t("pt.title")}</Link>
        <span aria-hidden="true">/</span>
        <span>{patientName(patient, lang)}</span>
      </nav>

      <section className="card pf-summary">
        <div className="pf-head">
          <div className="pf-avatar" aria-hidden="true">{initials(patient)}</div>
          <div className="pf-identity">
            <h1 className="pf-name">
              {patientName(patient, lang)}
              {otherName && <bdi className="pf-name-other">{otherName}</bdi>}
            </h1>
            <p className="pf-meta">
              <span className="id-chip mono">{patient.file_number}</span>
              {patient.gender && <span>{t(`pt.gender.${patient.gender}` as TKey)}</span>}
              {patient.age !== null && <span>{t("pt.years", { n: patient.age })}</span>}
              <bdi dir="ltr">{patient.phone}</bdi>
              <span>{t("pt.since", { date: new Date(patient.created_at).toLocaleDateString(locale(lang), { month: "short", year: "numeric" }) })}</span>
              {!patient.is_active && <span className="pill pill-warn">{t("pt.closed")}</span>}
            </p>
            {patient.alerts.length > 0 && (
              <p className="pf-alerts">
                {patient.alerts.map((a) => (
                  <span key={a.id} className="pill pill-alert" title={a.guidance}>{a.text}</span>
                ))}
              </p>
            )}
          </div>
          <div className="pf-actions">
            {can("clinical", "create") && patient.is_active && (
              <button
                className="btn btn-primary"
                onClick={() => {
                  setNoteSignal((n) => n + 1);
                  document.getElementById("clinical-notes")?.scrollIntoView({ behavior: "smooth", block: "start" });
                }}
              >
                <Icon name="plus" size={18} /> {t("pt.newNote")}
              </button>
            )}
            {can("appointments", "create") && patient.is_active && (
              <button className={can("clinical", "create") ? "btn" : "btn btn-primary"} onClick={() => setDialog({})}>
                <Icon name="plus" size={18} /> {t("ap.book")}
              </button>
            )}
            {can("patients", "edit") && <button className="btn" onClick={() => setEditing(true)}>{t("edit")}</button>}
            {can("patients", "delete") && patient.is_active && (
              <button className="btn btn-danger" onClick={() => void setActive(false)}>{t("pt.closeFile")}</button>
            )}
            {can("patients", "edit") && !patient.is_active && (
              <button className="btn" onClick={() => void setActive(true)}>{t("pt.reopen")}</button>
            )}
            <button className="btn btn-icon" aria-label={t("pt.print")} title={t("pt.print")} onClick={() => window.print()}>
              <Icon name="file" size={18} />
            </button>
          </div>
        </div>
        <div className="pf-stats">
          <Stat label="pt.lastVisit" value={lastVisit ? shortDate(lastVisit.start, lang) : t("pt.noneYet")} sub={lastVisit ? procedureLabel(lastVisit, lang) : ""} />
          <Stat
            label="pt.nextVisit"
            value={next ? `${new Date(next.start).toLocaleDateString(locale(lang), { weekday: "short", day: "numeric", month: "short" })}, ${timeOf(next.start)}` : t("pt.notBooked")}
            sub={next ? procedureLabel(next, lang) : ""}
          />
          {clinicalOn && <PlanProgress plans={clinical.plans} />}
          <Stat label="pt.visitCount" value={String(past.filter((v) => v.status === "completed").length)} sub={t("pt.visitCountSub", { done: past.filter((v) => v.status === "completed").length, missed })} />
          {can("files") && <Stat label="pt.filesCount" value={fileCount === null ? "…" : String(fileCount)} sub={t("pt.filesSub")} />}
        </div>
      </section>

      <nav className="card section-nav" aria-label={t("pt.details")}>
        {sections
          .filter((s) => s.show)
          .map((s) => (
            <a key={s.id} href={`#${s.id}`} onClick={(e) => {
              e.preventDefault();
              document.getElementById(s.id)?.scrollIntoView({ behavior: "smooth", block: "start" });
            }}>
              {t(s.label)}
            </a>
          ))}
      </nav>

      {clinicalOn && (
        <ChartCard
          patient={patient}
          data={clinical}
          onAddProcedure={(tooth) => {
            setAddFor(tooth);
            document.getElementById("plan")?.scrollIntoView({ behavior: "smooth", block: "start" });
          }}
        />
      )}

      <div className="pf-columns">
        <div className="pf-main">
          {clinicalOn && <PlanCard patient={patient} data={clinical} addFor={addFor} onAddHandled={addHandled} onVisitsChanged={loadVisits} />}
          {can("appointments") && <VisitHistory past={past} upcoming={upcoming.slice(1)} onOpen={(a) => setDialog({ appointment: a })} />}
          {clinicalOn && <VisitNotesCard patient={patient} data={clinical} visits={visits} openSignal={noteSignal} />}
          {can("files") && <ImagingCard patient={patient} onChanged={() => setFilesVersion((v) => v + 1)} />}
        </div>
        <div className="pf-side">
          <MedicalCard patient={patient} onChange={load} />
          {can("appointments") && next && <NextAppointment appointment={next} onReschedule={() => setDialog({ appointment: next })} onChanged={loadVisits} />}
          {clinicalOn && <PrescriptionsCard patient={patient} data={clinical} />}
          {clinicalOn && <ConsentsCard patient={patient} data={clinical} />}
          <PersonalCard patient={patient} branchName={choices.branches.find((b) => b.id === patient.home_branch)} dentistName={choices.dentists.find((d) => d.id === patient.preferred_dentist)} onEdit={can("patients", "edit") ? () => setEditing(true) : undefined} />
          {can("files") && <FilesCard key={filesVersion} patientId={patient.id} onCount={setFileCount} />}
          <NotesCard patient={patient} />
        </div>
      </div>

      {editing && (
        <Modal title={`${t("edit")}: ${patientName(patient, lang)}`} onClose={() => setEditing(false)}>
          <RecordForm
            fields={patientFields(t, { branches: choices.branchOptions, dentists: choices.dentistOptions })}
            initial={{ ...patient }}
            isNew={false}
            onSubmit={save}
            onCancel={() => setEditing(false)}
          />
        </Modal>
      )}
      {dialog && (
        <AppointmentDialog
          initial={dialog.appointment ? { appointment: dialog.appointment } : { patient }}
          onClose={() => setDialog(null)}
          onSaved={() => {
            setDialog(null);
            loadVisits();
          }}
        />
      )}
    </div>
  );
}

function Stat({ label, value, sub }: { label: TKey; value: string; sub: string }) {
  const { t } = useI18n();
  return (
    <div className="pf-stat">
      <p className="overline">{t(label)}</p>
      <p className="pf-stat-value">{value}</p>
      {sub && <p className="pf-stat-sub">{sub}</p>}
    </div>
  );
}

function SideCard({ id, title, aside, children, className = "" }: { id?: string; title: string; aside?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section id={id} className={`card side-card ${className}`}>
      <header className="side-card-head">
        <h2>{title}</h2>
        {aside}
      </header>
      {children}
    </section>
  );
}

function VisitHistory({ past, upcoming, onOpen }: { past: Appointment[]; upcoming: Appointment[]; onOpen: (a: Appointment) => void }) {
  const { t, lang } = useI18n();
  const { can } = useAuth();
  return (
    <>
      <section id="visits" className="card main-card">
        <header className="main-card-head">
          <h2>{t("pt.visitHistory")}</h2>
          <span className="muted small">{t("pt.visitsN", { n: past.length })}</span>
        </header>
        {past.length === 0 ? (
          <p className="muted">{t("pt.noVisits")}</p>
        ) : (
          <ol className="timeline">
            {past.map((v, i) => (
              <li key={v.id} className={i === 0 ? "latest" : ""}>
                <span className="timeline-dot" aria-hidden="true" />
                <time className="mono timeline-date" dateTime={v.start}>
                  {new Date(v.start).toLocaleDateString(locale(lang), { day: "2-digit", month: "short", year: "numeric" })}
                </time>
                <div className="timeline-body">
                  <p className="timeline-title">
                    {procedureLabel(v, lang) || t("ap.status.completed")}
                    {v.status !== "completed" && <span className={`pill status-${v.status}`}>{t(`ap.status.${v.status}` as TKey)}</span>}
                  </p>
                  {(v.notes || v.cancel_reason) && <p className="timeline-note">{v.notes || v.cancel_reason}</p>}
                  <p className="timeline-who">{dentistLabel(v, lang)}</p>
                </div>
              </li>
            ))}
          </ol>
        )}
      </section>
      {upcoming.length > 0 && (
        <section className="card main-card">
          <header className="main-card-head">
            <h2>{t("pt.upcoming")}</h2>
          </header>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{t("ap.date")}</th>
                  <th>{t("ap.dentist")}</th>
                  <th>{t("ap.procedure")}</th>
                  <th>{t("ap.status")}</th>
                </tr>
              </thead>
              <tbody>
                {upcoming.map((v) => (
                  <tr key={v.id}>
                    <td className="nowrap">
                      {can("appointments", "edit") && ["booked", "confirmed"].includes(v.status) ? (
                        <button className="link-button" onClick={() => onOpen(v)}>
                          {shortDate(v.start, lang)}, {timeOf(v.start)}
                        </button>
                      ) : (
                        <Link to={`/appointments?date=${isoDay(new Date(v.start))}&branch=${v.branch}`}>{shortDate(v.start, lang)}, {timeOf(v.start)}</Link>
                      )}
                    </td>
                    <td>{dentistLabel(v, lang)}</td>
                    <td>{procedureLabel(v, lang)}</td>
                    <td><span className={`pill status-${v.status}`}>{t(`ap.status.${v.status}` as TKey)}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </>
  );
}

function MedicalCard({ patient, onChange }: { patient: Patient; onChange: () => void }) {
  const { t, lang } = useI18n();
  const { can } = useAuth();
  const [alerts, setAlerts] = useState<AlertRow[]>([]);
  const [history, setHistory] = useState<History | null>(null);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState(false);
  const clinical = can("clinical");

  const loadAlerts = useCallback(() => {
    getAll<AlertRow>(`/api/patients/alerts/?patient=${patient.id}`).then((rows) => setAlerts(rows.filter((a) => a.is_active)));
  }, [patient.id]);
  useEffect(loadAlerts, [loadAlerts]);
  useEffect(() => {
    if (clinical) get<History>(`/api/patients/${patient.id}/medical-history/`).then((data) => setHistory(data.exists === false ? {} : data));
  }, [patient.id, clinical]);

  const removeAlert = async (alert: AlertRow) => {
    await patch(`/api/patients/alerts/${alert.id}/`, { is_active: false });
    loadAlerts();
    onChange();
  };
  const rows: [string, string][] = [];
  if (history) {
    for (const c of CONDITIONS) if (history[c]) rows.push([t(`mh.${c}` as TKey), t("yes")]);
    for (const f of HISTORY_TEXT) if (history[f]) rows.push([t(`mh.${f}` as TKey), String(history[f])]);
  }

  return (
    <SideCard
      id="medical"
      title={clinical ? t("pt.history") : t("pt.alerts")}
      aside={history && typeof history.updated_at === "string" ? <span className="muted small">{t("pt.reviewed", { date: shortDate(history.updated_at, lang) })}</span> : undefined}
    >
      <div className="stack">
        {alerts.length === 0 && <p className="muted small">{t("pt.noAlerts")}</p>}
        {alerts.map((a) => (
          <div key={a.id} className="alert-box">
            <span className="alert-dot" aria-hidden="true" />
            <div className="grow">
              <p className="alert-title">
                {t(`pt.alert.kind.${a.kind}` as TKey)}: {a.text}
              </p>
              {a.guidance && <p className="alert-guidance">{a.guidance}</p>}
            </div>
            {can("patients", "edit") && (
              <button className="icon-x" aria-label={`${t("pt.alert.remove")}: ${a.text}`} onClick={() => void removeAlert(a)}>×</button>
            )}
          </div>
        ))}
        {can("patients", "edit") &&
          (adding ? (
            <AlertForm
              patientId={patient.id}
              onDone={() => {
                setAdding(false);
                loadAlerts();
                onChange();
              }}
              onCancel={() => setAdding(false)}
            />
          ) : (
            <button className="btn btn-small" onClick={() => setAdding(true)}>+ {t("pt.alert.add")}</button>
          ))}
        {clinical && history && (
          <>
            {rows.length === 0 ? (
              <p className="muted small">{Object.keys(history).length ? t("pt.noConditions") : t("pt.noHistory")}</p>
            ) : (
              <dl className="kv">
                {rows.map(([k, v]) => (
                  <div key={k}>
                    <dt>{k}</dt>
                    <dd>{v}</dd>
                  </div>
                ))}
              </dl>
            )}
            {can("clinical", "edit") && (
              <button className="btn btn-block" onClick={() => setEditing(true)}>{t("pt.updateHistory")}</button>
            )}
          </>
        )}
      </div>
      {editing && history && (
        <HistoryDialog
          patientId={patient.id}
          history={history}
          onClose={() => setEditing(false)}
          onSaved={(h) => {
            setHistory(h);
            setEditing(false);
          }}
        />
      )}
    </SideCard>
  );
}

function AlertForm({ patientId, onDone, onCancel }: { patientId: number; onDone: () => void; onCancel: () => void }) {
  const { t } = useI18n();
  const [values, setValues] = useState<Record<string, unknown>>({ kind: "allergy", text: "", guidance: "" });
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await post("/api/patients/alerts/", { patient: patientId, ...values });
      onDone();
    } catch (err) {
      if (err instanceof ApiError) setErrors(err.fields);
    }
  };
  return (
    <form className="subform form-grid" onSubmit={submit}>
      <Field field={{ name: "kind", label: "pt.alert.kind", type: "select", required: true, options: ALERT_KINDS.map((k) => ({ value: k, label: t(`pt.alert.kind.${k}` as TKey) })) }} value={values.kind} onChange={(v) => setValues((s) => ({ ...s, kind: v }))} />
      <Field field={{ name: "alert_text", label: "pt.alert.text", required: true }} value={values.text} errors={errors.text} onChange={(v) => setValues((s) => ({ ...s, text: v }))} />
      <Field field={{ name: "guidance", label: "pt.alert.guidance" }} value={values.guidance} onChange={(v) => setValues((s) => ({ ...s, guidance: v }))} />
      <div className="form-actions">
        <button type="button" className="btn btn-small" onClick={onCancel}>{t("cancel")}</button>
        <button type="submit" className="btn btn-small btn-primary">{t("pt.alert.add")}</button>
      </div>
    </form>
  );
}

function HistoryDialog({ patientId, history, onClose, onSaved }: { patientId: number; history: History; onClose: () => void; onSaved: (h: History) => void }) {
  const { t } = useI18n();
  const [values, setValues] = useState<History>(history);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const body = Object.fromEntries([...CONDITIONS.map((c) => [c, Boolean(values[c])]), ...HISTORY_TEXT.map((f) => [f, values[f] ?? ""])]);
      onSaved(await api<History>(`/api/patients/${patientId}/medical-history/`, { method: "PUT", body: JSON.stringify(body) }));
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };
  return (
    <Modal title={t("pt.history")} onClose={onClose}>
      <form className="form-grid" onSubmit={save}>
        <fieldset className="checks history-checks">
          <legend className="small muted">{t("pt.conditions")}</legend>
          {CONDITIONS.map((c) => (
            <label key={c} className="check-pill">
              <input type="checkbox" name={c} checked={Boolean(values[c])} onChange={(e) => setValues({ ...values, [c]: e.target.checked })} />
              {t(`mh.${c}` as TKey)}
            </label>
          ))}
        </fieldset>
        <div className="form-grid form-grid-2">
          {HISTORY_TEXT.map((f) => (
            <Field key={f} field={{ name: f, label: `mh.${f}` as TKey, type: "textarea" }} value={values[f] ?? ""} onChange={(v) => setValues({ ...values, [f]: String(v) })} />
          ))}
        </div>
        {message && <p className="form-error" role="alert">{message}</p>}
        <div className="form-actions">
          <button type="button" className="btn" onClick={onClose}>{t("cancel")}</button>
          <button type="submit" className="btn btn-primary" disabled={busy}>{t("save")}</button>
        </div>
      </form>
    </Modal>
  );
}

function NextAppointment({ appointment: a, onReschedule, onChanged }: { appointment: Appointment; onReschedule: () => void; onChanged: () => void }) {
  const { t, lang } = useI18n();
  const { can } = useAuth();
  const [message, setMessage] = useState("");
  const remind = async () => {
    try {
      await post(`/api/appointments/${a.id}/remind/`, {});
      setMessage("");
      onChanged();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    }
  };
  const editable = can("appointments", "edit") && ["booked", "confirmed"].includes(a.status);
  return (
    <section className="card next-card" aria-labelledby="next-title">
      <p className="overline">{t("pt.nextVisit")}</p>
      <h2 id="next-title">{new Date(a.start).toLocaleDateString(locale(lang), { weekday: "long", day: "numeric", month: "long" })}</h2>
      <p className="next-when">
        {timeOf(a.start)}, {t("ap.minutes", { n: a.duration_minutes })}
      </p>
      <p className="next-what">
        {[procedureLabel(a, lang), t("ap.withDentist", { name: dentistLabel(a, lang) })].filter(Boolean).join(", ")}
      </p>
      {a.reminder_sent_at && <p className="next-note">{t("ap.reminderSentAt", { time: shortDate(a.reminder_sent_at, lang) })}</p>}
      {editable && (
        <div className="next-actions">
          <button className="btn btn-light" onClick={() => void remind()}>{t("ap.remindNow")}</button>
          <button className="btn btn-ghost-light" onClick={onReschedule}>{t("ap.reschedule")}</button>
        </div>
      )}
      {message && <p className="next-note" role="status">{message}</p>}
    </section>
  );
}

function PersonalCard({
  patient: p,
  branchName,
  dentistName,
  onEdit,
}: {
  patient: Patient;
  branchName?: { name_en: string; name_ar: string };
  dentistName?: { name_en: string; name_ar: string };
  onEdit?: () => void;
}) {
  const { t, lang, name } = useI18n();
  const rows: [TKey, ReactNode][] = [
    ["pt.dob", p.date_of_birth && new Date(`${p.date_of_birth}T12:00:00`).toLocaleDateString(locale(lang), { day: "numeric", month: "short", year: "numeric" })],
    ["pt.mobile", <bdi dir="ltr">{p.phone}</bdi>],
    ["pt.phoneAlt", p.phone_alt && <bdi dir="ltr">{p.phone_alt}</bdi>],
    ["pt.whatsapp", p.whatsapp_opt_in ? t("pt.sameNumber") : t("pt.noMessages")],
    ["pt.language", p.language === "ar" ? "العربية" : "English"],
    ["email", p.email],
    ["pt.nationalId", p.national_id && <bdi className="mono">{p.national_id}</bdi>],
    ["pt.address", p.address],
    ["pt.occupation", p.occupation],
    ["pt.referral", p.referral_source && t(`pt.referral.${p.referral_source}` as TKey)],
    ["pt.homeBranch", branchName && name(branchName)],
    ["pt.dentist", dentistName && name(dentistName)],
    [
      "pt.emergency",
      (p.emergency_contact_name || p.emergency_contact_phone) && (
        <>
          {p.emergency_contact_name}
          {p.emergency_contact_phone && (
            <>
              <br />
              <bdi dir="ltr">{p.emergency_contact_phone}</bdi>
            </>
          )}
        </>
      ),
    ],
    ["pt.insurance", p.insurance],
    ["pt.notes", p.notes],
  ];
  return (
    <SideCard id="personal" title={t("pt.personal")} aside={onEdit && <button className="link-button" onClick={onEdit}>{t("edit")}</button>}>
      <dl className="kv">
        {rows
          .filter(([, v]) => v)
          .map(([k, v]) => (
            <div key={k}>
              <dt>{t(k)}</dt>
              <dd>{v}</dd>
            </div>
          ))}
      </dl>
    </SideCard>
  );
}

function FilesCard({ patientId, onCount }: { patientId: number; onCount: (n: number) => void }) {
  const { t, lang } = useI18n();
  const { can } = useAuth();
  const [files, setFiles] = useState<FileRow[]>([]);
  const [kind, setKind] = useState("document");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const query = `attached_model=patients.patient&attached_id=${patientId}`;

  const load = useCallback(() => {
    getAll<FileRow>(`/api/files/?${query}`).then((rows) => {
      setFiles(rows);
      onCount(rows.length);
    });
  }, [query, onCount]);
  useEffect(load, [load]);

  const upload = async (file: File) => {
    const form = new FormData();
    form.append("file", file);
    form.append("kind", kind);
    form.append("attached_model", "patients.patient");
    form.append("attached_id", String(patientId));
    setBusy(true);
    try {
      await post("/api/files/", form);
      setError("");
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  // X-rays, photos and scans show in the imaging section.
  const documents = files.filter((f) => !IMAGING_KINDS.includes(f.kind));
  return (
    <SideCard id="files" title={t("pt.files")}>
      {can("files", "create") && (
        <div className="inline-form">
          <select aria-label={t("pt.fileKind")} value={kind} onChange={(e) => setKind(e.target.value)}>
            {FILE_KINDS.filter((k) => !IMAGING_KINDS.includes(k)).map((k) => (
              <option key={k} value={k}>{t(`file.kind.${k}` as TKey)}</option>
            ))}
          </select>
          <label className={`btn ${busy ? "disabled" : ""}`}>
            {t("pt.upload")}
            <input
              type="file"
              hidden
              disabled={busy}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void upload(file);
                e.target.value = "";
              }}
            />
          </label>
        </div>
      )}
      {error && <p className="field-error" role="alert">{error}</p>}
      {documents.length === 0 ? (
        <p className="muted small">{t("noRecords")}</p>
      ) : (
        <ul className="file-grid">
          {documents.map((f) => (
            <li key={f.id}>
              <button className="file-tile-button" onClick={() => void openProtectedFile(f.download_url)}>
                <span className={`file-tile kind-${f.kind}`}>{t(`file.kind.${f.kind}` as TKey)}</span>
                <span className="file-name">{f.description || f.original_name}</span>
                <span className="muted small">{shortDate(f.created_at, lang)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </SideCard>
  );
}

function NotesCard({ patient }: { patient: Patient }) {
  const { t, lang } = useI18n();
  const { can } = useAuth();
  const [notes, setNotes] = useState<NoteRow[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    getAll<NoteRow>(`/api/patients/notes/?patient=${patient.id}`).then(setNotes).catch(() => setNotes([]));
  }, [patient.id]);
  useEffect(load, [load]);
  const add = async (e: FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;
    setBusy(true);
    try {
      await post("/api/patients/notes/", { patient: patient.id, text });
      setText("");
      load();
    } finally {
      setBusy(false);
    }
  };
  return (
    <SideCard id="notes" title={t("pt.staffNotes")}>
      <div className="stack">
        {notes.length === 0 && <p className="muted small">{t("pt.noNotes")}</p>}
        {notes.map((n) => (
          <div key={n.id} className="note">
            <p>{n.text}</p>
            <p className="muted small">
              {n.author} · {shortDate(n.created_at, lang)}
            </p>
          </div>
        ))}
        {can("patients", "create") && (
          <form className="stack" onSubmit={add}>
            <label htmlFor="new-note" className="small strong">{t("pt.addNote")}</label>
            <textarea id="new-note" name="note" rows={3} placeholder={t("pt.notePlaceholder")} value={text} onChange={(e) => setText(e.target.value)} />
            <div>
              <button className="btn" type="submit" disabled={busy}>{t("pt.saveNote")}</button>
            </div>
          </form>
        )}
      </div>
    </SideCard>
  );
}
