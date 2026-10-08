import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import { ApiError, del, get, getAll, openProtectedFile, patch, post, api } from "../api";
import { useAuth } from "../auth";
import { useI18n, type TKey } from "../i18n";
import { Field, Modal, RecordForm } from "../components/Crud";
import { ALERT_KINDS, FILE_KINDS, cleanPatient, patientFields } from "../components/patientFields";
import { formatDateTime, isoDay } from "../dates";
import type { Appointment, Patient } from "../types";
import { AlertPills, patientName, useChoices } from "./Patients";
import { AppointmentDialog } from "./Appointments";

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
const HISTORY_TEXT = ["allergies", "medications", "past_surgeries", "notes"] as const;

type AlertRow = { id: number; patient: number; kind: string; text: string; is_active: boolean };
type FileRow = { id: number; original_name: string; kind: string; description: string; size: number; created_at: string; download_url: string };

export function PatientProfile() {
  const { id } = useParams();
  const { t, lang, name } = useI18n();
  const { can } = useAuth();
  const choices = useChoices();
  const [patient, setPatient] = useState<Patient | null>(null);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState(false);
  const [booking, setBooking] = useState(false);
  const [refresh, setRefresh] = useState(0);

  const load = useCallback(() => {
    get<Patient>(`/api/patients/${id}/`)
      .then(setPatient)
      .catch((err) => setError(err instanceof ApiError && err.status === 404 ? t("noRecords") : String(err.message ?? err)));
  }, [id, t]);
  useEffect(load, [load]);

  if (error) return <p className="form-error pad">{error}</p>;
  if (!patient) return <p className="muted pad">{t("loading")}</p>;

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
  const dentist = choices.dentists.find((d) => d.id === patient.preferred_dentist);
  const branch = choices.branches.find((b) => b.id === patient.home_branch);
  const detail = (label: TKey, value: ReactNode) =>
    value ? (
      <div className="detail">
        <dt>{t(label)}</dt>
        <dd>{value}</dd>
      </div>
    ) : null;

  return (
    <div className="page">
      <div>
        <Link to="/patients" className="muted">← {t("pt.title")}</Link>
      </div>
      <section className="card patient-head">
        <div className="pad">
          <h1 className="patient-name">{patientName(patient, lang)}</h1>
          <p className="muted">
            <bdi className="num">{patient.file_number}</bdi>
            {patient.name_ar && patient.name_en && <> · <bdi>{lang === "ar" ? patient.name_en : patient.name_ar}</bdi></>}
            {patient.age !== null && <> · <bdi>{t("pt.years", { n: patient.age })}</bdi></>}
            {" · "}
            <bdi dir="ltr">{patient.phone}</bdi>
          </p>
          {!patient.is_active && <span className="pill pill-warn">{t("pt.closed")}</span>}
          <AlertPills alerts={patient.alerts} />
        </div>
        <div className="toolbar pad">
          {can("appointments", "create") && patient.is_active && (
            <button className="btn btn-primary" onClick={() => setBooking(true)}>+ {t("ap.book")}</button>
          )}
          {can("patients", "edit") && <button className="btn" onClick={() => setEditing(true)}>{t("edit")}</button>}
          {can("patients", "delete") && patient.is_active && (
            <button className="btn btn-danger" onClick={() => void setActive(false)}>{t("pt.closeFile")}</button>
          )}
          {can("patients", "edit") && !patient.is_active && (
            <button className="btn" onClick={() => void setActive(true)}>{t("pt.reopen")}</button>
          )}
        </div>
      </section>

      <div className="two-col">
        <section className="card">
          <header className="card-head"><h2>{t("pt.details")}</h2></header>
          <dl className="details pad">
            {detail("pt.gender", patient.gender && t(`pt.gender.${patient.gender}` as TKey))}
            {detail("pt.dob", patient.date_of_birth)}
            {detail("pt.phoneAlt", patient.phone_alt && <span dir="ltr">{patient.phone_alt}</span>)}
            {detail("pt.whatsapp", patient.whatsapp_opt_in ? t("yes") : t("no"))}
            {detail("pt.language", patient.language === "ar" ? "العربية" : "English")}
            {detail("email", patient.email)}
            {detail("pt.nationalId", patient.national_id)}
            {detail("pt.occupation", patient.occupation)}
            {detail("pt.referral", patient.referral_source && t(`pt.referral.${patient.referral_source}` as TKey))}
            {detail("pt.homeBranch", branch && name(branch))}
            {detail("pt.dentist", dentist && name(dentist))}
            {detail("pt.address", patient.address)}
            {detail("pt.notes", patient.notes)}
          </dl>
        </section>
        <AlertsCard patientId={patient.id} onChange={load} />
      </div>

      {can("clinical") && <MedicalHistoryCard patientId={patient.id} />}
      {can("appointments") && <VisitsCard patientId={patient.id} refresh={refresh} />}
      {can("files") && <FilesCard patientId={patient.id} />}

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
      {booking && (
        <AppointmentDialog
          initial={{ patient }}
          onClose={() => setBooking(false)}
          onSaved={() => {
            setBooking(false);
            setRefresh((n) => n + 1);
          }}
        />
      )}
    </div>
  );
}

function AlertsCard({ patientId, onChange }: { patientId: number; onChange: () => void }) {
  const { t } = useI18n();
  const { can } = useAuth();
  const [alerts, setAlerts] = useState<AlertRow[]>([]);
  const [kind, setKind] = useState("allergy");
  const [text, setText] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(() => {
    getAll<AlertRow>(`/api/patients/alerts/?patient=${patientId}`).then((rows) => setAlerts(rows.filter((a) => a.is_active)));
  }, [patientId]);
  useEffect(load, [load]);

  const add = async (e: FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;
    try {
      await post("/api/patients/alerts/", { patient: patientId, kind, text });
      setText("");
      setError("");
      load();
      onChange();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };
  const remove = async (alert: AlertRow) => {
    await patch(`/api/patients/alerts/${alert.id}/`, { is_active: false });
    load();
    onChange();
  };

  return (
    <section className="card">
      <header className="card-head"><h2>{t("pt.alerts")}</h2></header>
      <div className="pad stack">
        <p className="field-hint">{t("pt.alertsHint")}</p>
        {alerts.length === 0 && <p className="muted">{t("pt.noAlerts")}</p>}
        <ul className="plain-list">
          {alerts.map((a) => (
            <li key={a.id}>
              <span className="pill pill-alert">⚠ {a.text}</span>
              <span className="muted small">{t(`pt.alert.kind.${a.kind}` as TKey)}</span>
              {can("patients", "edit") && (
                <button className="btn btn-small btn-danger" onClick={() => void remove(a)}>{t("pt.alert.remove")}</button>
              )}
            </li>
          ))}
        </ul>
        {can("patients", "edit") && (
          <form className="inline-form" onSubmit={add}>
            <select aria-label={t("pt.alert.kind")} value={kind} onChange={(e) => setKind(e.target.value)}>
              {ALERT_KINDS.map((k) => (
                <option key={k} value={k}>{t(`pt.alert.kind.${k}` as TKey)}</option>
              ))}
            </select>
            <input name="alert_text" aria-label={t("pt.alert.text")} placeholder={t("pt.alert.text")} value={text} maxLength={200} onChange={(e) => setText(e.target.value)} />
            <button className="btn" type="submit">{t("pt.alert.add")}</button>
          </form>
        )}
        {error && <p className="field-error">{error}</p>}
      </div>
    </section>
  );
}

type History = Record<string, boolean | string>;

function MedicalHistoryCard({ patientId }: { patientId: number }) {
  const { t } = useI18n();
  const { can } = useAuth();
  const [history, setHistory] = useState<History | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const canEdit = can("clinical", "edit");

  useEffect(() => {
    get<History>(`/api/patients/${patientId}/medical-history/`).then((data) => setHistory(data.exists === false ? {} : data));
  }, [patientId]);

  if (!history) return null;
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const body = Object.fromEntries([...CONDITIONS.map((c) => [c, Boolean(history[c])]), ...HISTORY_TEXT.map((f) => [f, history[f] ?? ""])]);
      setHistory(await api<History>(`/api/patients/${patientId}/medical-history/`, { method: "PUT", body: JSON.stringify(body) }));
      setMessage(t("saved"));
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="card">
      <header className="card-head">
        <h2>{t("pt.history")}</h2>
        <span className="muted small">{t("pt.historyHint")}</span>
      </header>
      <form className="pad form-grid" onSubmit={save}>
        <fieldset className="checks history-checks" disabled={!canEdit}>
          <legend className="small muted">{t("pt.conditions")}</legend>
          {CONDITIONS.map((c) => (
            <label key={c} className="check-pill">
              <input type="checkbox" name={c} checked={Boolean(history[c])} onChange={(e) => setHistory({ ...history, [c]: e.target.checked })} />
              {t(`mh.${c}` as TKey)}
            </label>
          ))}
        </fieldset>
        <div className="form-grid form-grid-2">
          {HISTORY_TEXT.map((f) => (
            <Field
              key={f}
              field={{ name: f, label: `mh.${f}` as TKey, type: "textarea" }}
              value={history[f] ?? ""}
              onChange={(v) => canEdit && setHistory({ ...history, [f]: String(v) })}
            />
          ))}
        </div>
        {canEdit && (
          <div className="form-actions">
            {message && <span className="muted" role="status">{message}</span>}
            <button className="btn btn-primary" type="submit" disabled={busy}>{t("save")}</button>
          </div>
        )}
      </form>
    </section>
  );
}

function VisitsCard({ patientId, refresh }: { patientId: number; refresh: number }) {
  const { t, lang } = useI18n();
  const [visits, setVisits] = useState<Appointment[] | null>(null);
  useEffect(() => {
    get<Appointment[]>(`/api/appointments/?patient=${patientId}`).then((rows) => setVisits([...rows].reverse()));
  }, [patientId, refresh]);
  return (
    <section className="card">
      <header className="card-head"><h2>{t("pt.visits")}</h2></header>
      {visits === null ? (
        <p className="muted pad">{t("loading")}</p>
      ) : visits.length === 0 ? (
        <p className="muted pad">{t("pt.noVisits")}</p>
      ) : (
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
              {visits.map((v) => (
                <tr key={v.id}>
                  <td className="nowrap">
                    <Link to={`/appointments?date=${isoDay(new Date(v.start))}&branch=${v.branch}`}>{formatDateTime(v.start, lang)}</Link>
                  </td>
                  <td>{lang === "ar" ? v.dentist_name_ar : v.dentist_name_en}</td>
                  <td>{(lang === "ar" ? v.procedure_name_ar : v.procedure_name_en) || v.reason}</td>
                  <td><span className={`pill status-${v.status}`}>{t(`ap.status.${v.status}` as TKey)}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function FilesCard({ patientId }: { patientId: number }) {
  const { t, lang } = useI18n();
  const { can } = useAuth();
  const [files, setFiles] = useState<FileRow[]>([]);
  const [kind, setKind] = useState("xray");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const query = `attached_model=patients.patient&attached_id=${patientId}`;

  const load = useCallback(() => {
    getAll<FileRow>(`/api/files/?${query}`).then(setFiles);
  }, [query]);
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

  return (
    <section className="card">
      <header className="card-head">
        <h2>{t("pt.files")}</h2>
        {can("files", "create") && (
          <div className="toolbar">
            <select aria-label={t("pt.fileKind")} value={kind} onChange={(e) => setKind(e.target.value)}>
              {FILE_KINDS.map((k) => (
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
      </header>
      {error && <p className="form-error" role="alert">{error}</p>}
      {files.length === 0 ? (
        <p className="muted pad">{t("noRecords")}</p>
      ) : (
        <ul className="plain-list pad">
          {files.map((f) => (
            <li key={f.id}>
              <span className="pill">{t(`file.kind.${f.kind}` as TKey)}</span>
              <button className="link-button" onClick={() => void openProtectedFile(f.download_url)}>{f.original_name}</button>
              <span className="muted small">{formatDateTime(f.created_at, lang)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
