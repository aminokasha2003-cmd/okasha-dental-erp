import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ApiError, get, getAll, patch, post, type Page } from "../api";
import { useAuth } from "../auth";
import { useI18n, type TKey } from "../i18n";
import { Field, Modal } from "../components/Crud";
import { cleanPatient, patientFields, PATIENT_DEFAULTS } from "../components/patientFields";
import { addDays, formatDay, hhmm, isoDay, localIso, minutesOf, timeOf, weekdayOf } from "../dates";
import { NEXT_STATUS, type Appointment, type AppointmentStatus, type Chair, type Patient, type Procedure, type WorkingHours } from "../types";
import { AlertPills, patientName, useChoices } from "./Patients";

const SLOT = 15; // minutes per row
const SLOT_PX = 24;
const HIDDEN_ON_GRID: AppointmentStatus[] = ["cancelled", "no_show"];

function apptName(a: Appointment, lang: string) {
  return (lang === "ar" ? a.patient_name.ar || a.patient_name.en : a.patient_name.en || a.patient_name.ar) || a.patient_file_number;
}

function useChairs(branch: number | null, version = 0) {
  const [chairs, setChairs] = useState<Chair[]>([]);
  useEffect(() => {
    if (!branch) return setChairs([]);
    getAll<Chair>(`/api/masterdata/chairs/?branch=${branch}&is_active=true`).then(setChairs).catch(() => setChairs([]));
  }, [branch, version]);
  return chairs;
}

const STARTER_CHAIRS = 2;

/** What still has to be set up before the calendar is useful, with a one-click starting setup. */
function SetupChecklist({
  branch,
  chairs,
  hours,
  dentists,
  onDone,
}: {
  branch: number | null;
  chairs: number;
  hours: number;
  dentists: number;
  onDone: () => void;
}) {
  const { t } = useI18n();
  const { me, can, reload: reloadMe } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const items: { done: boolean; label: TKey; to: string; module: string }[] = [
    { done: Boolean(branch), label: "setup.branch", to: "/settings", module: "settings" },
    { done: chairs > 0, label: "setup.chairs", to: "/settings", module: "settings" },
    { done: hours > 0, label: "setup.hours", to: "/settings", module: "settings" },
    { done: dentists > 0, label: "setup.dentists", to: "/staff", module: "masterdata" },
  ];
  if (items.every((i) => i.done)) return null;
  const canQuick = can("settings", "create") && can("masterdata", "create");

  const quickSetup = async () => {
    setBusy(true);
    setError("");
    try {
      let branchId = branch;
      if (!branchId) branchId = (await post<{ id: number }>("/api/masterdata/branches/", { name_en: "Main branch", name_ar: "الفرع الرئيسي", is_active: true })).id;
      if (chairs === 0) {
        for (let i = 1; i <= STARTER_CHAIRS; i++)
          await post("/api/masterdata/chairs/", { branch: branchId, name_en: `Chair ${i}`, name_ar: `كرسي ${i}`, sort_order: i, is_active: true });
      }
      if (hours === 0) {
        // Saturday to Thursday 10:00 to 22:00, Friday closed (weekday 4). Editable in clinic settings.
        for (let day = 0; day < 7; day++)
          await post("/api/masterdata/working-hours/", day === 4 ? { branch: branchId, weekday: day, is_closed: true } : { branch: branchId, weekday: day, is_closed: false, opens_at: "10:00", closes_at: "22:00" });
      }
      if (dentists === 0 && me) {
        const full = [me.first_name, me.last_name].filter(Boolean).join(" ") || me.username;
        await post("/api/masterdata/staff/", {
          name_en: `Dr. ${full}`,
          name_ar: `د. ${full}`,
          staff_type: "dentist",
          user: me.staff_member ? null : me.id,
          branches: [branchId],
          commission_type: "none",
          commission_value: "0",
          is_active: true,
        });
      }
      await reloadMe();
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card setup-card">
      <header className="card-head">
        <div>
          <h2>{t("setup.title")}</h2>
          <p className="muted small">{t("setup.intro")}</p>
        </div>
        {canQuick && (
          <button className="btn btn-primary" disabled={busy} onClick={() => void quickSetup()}>
            {t("setup.quick")}
          </button>
        )}
      </header>
      <ul className="checklist">
        {items.map((i) => (
          <li key={i.label}>
            <span className={`pill ${i.done ? "pill-ok" : "pill-warn"}`}>{i.done ? t("home.done") : t("home.todo")}</span>
            <span className="grow">{t(i.label)}</span>
            {!i.done && can(i.module) && (
              <Link className="btn btn-small" to={i.to}>{t("home.open")}</Link>
            )}
          </li>
        ))}
      </ul>
      {canQuick && <p className="muted small pad">{t("setup.quickHint")}</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
    </section>
  );
}

export function Appointments() {
  const { t, lang, name } = useI18n();
  const { me, can } = useAuth();
  const [params, setParams] = useSearchParams();
  const { branches, dentists, loaded, reload: reloadChoices } = useChoices();
  const [setupVersion, setSetupVersion] = useState(0);
  const day = params.get("date") || isoDay(new Date());
  const branch = Number(params.get("branch")) || branches[0]?.id || null;
  const ownDentist = me?.staff_member?.staff_type === "dentist" ? String(me.staff_member.id) : "";
  const dentistFilter = params.get("dentist") ?? ownDentist;
  const chairs = useChairs(branch, setupVersion);
  const [hours, setHours] = useState<WorkingHours[]>([]);
  const [rows, setRows] = useState<Appointment[] | null>(null);
  const [queue, setQueue] = useState<{ waiting: Appointment[]; in_chair: Appointment[] }>({ waiting: [], in_chair: [] });
  const [dueReminders, setDueReminders] = useState(0);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [dialog, setDialog] = useState<DialogInitial | null>(null);
  const [selected, setSelected] = useState<Appointment | null>(null);
  const isToday = day === isoDay(new Date());

  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };

  useEffect(() => {
    if (!branch) return;
    getAll<WorkingHours>(`/api/masterdata/working-hours/?branch=${branch}`).then(setHours).catch(() => setHours([]));
  }, [branch, setupVersion]);

  const load = useCallback(async () => {
    if (!branch) return;
    try {
      const q = new URLSearchParams({ date: day, branch: String(branch) });
      setRows(await get<Appointment[]>(`/api/appointments/?${q}`));
      setQueue(await get(`/api/appointments/queue/?branch=${branch}`));
      if (can("appointments", "edit")) setDueReminders((await get<{ due: number }>("/api/appointments/reminders/")).due);
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [branch, day, can]);
  useEffect(() => {
    void load();
    // Keep the waiting room current when several people use the calendar.
    const timer = window.setInterval(() => void load(), 60_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const todays = hours.find((h) => h.weekday === weekdayOf(day));
  const visible = (rows ?? []).filter((a) => !dentistFilter || String(a.dentist) === dentistFilter);
  const onGrid = visible.filter((a) => !HIDDEN_ON_GRID.includes(a.status));
  const offGrid = visible.filter((a) => HIDDEN_ON_GRID.includes(a.status));

  // Day range: the branch's hours, stretched to fit any visit booked outside them.
  let open = todays && !todays.is_closed && todays.opens_at ? minutesOf(todays.opens_at) : 9 * 60;
  let close = todays && !todays.is_closed && todays.closes_at ? minutesOf(todays.closes_at) : 21 * 60;
  for (const a of onGrid) {
    open = Math.min(open, minutesOf(new Date(a.start)));
    close = Math.max(close, minutesOf(new Date(a.start)) + a.duration_minutes);
  }
  open = Math.floor(open / 60) * 60;
  close = Math.min(24 * 60, Math.ceil(close / 60) * 60);
  const slots = Array.from({ length: (close - open) / SLOT }, (_, i) => open + i * SLOT);
  const columns: { id: number | null; label: string }[] = chairs.map((c) => ({ id: c.id, label: name(c) }));
  // Visits without a chair get their own column; with no chairs set up it is the only one, so booking still works.
  if (chairs.length === 0 || onGrid.some((a) => a.chair === null)) columns.push({ id: null, label: t("ap.noChair") });

  const sendReminders = async () => {
    const result = await post<{ sent: number; failed: number }>("/api/appointments/send-reminders/", {});
    setNotice(t("ap.remindersSent", result));
    void load();
  };

  const canBook = can("appointments", "create");

  if (!loaded) return <p className="muted pad">{t("loading")}</p>;
  const checklist = (
    <SetupChecklist
      branch={branch}
      chairs={chairs.length}
      hours={hours.length}
      dentists={dentists.length}
      onDone={() => {
        reloadChoices();
        setSetupVersion((v) => v + 1);
      }}
    />
  );

  return (
    <div className="page">
      <div className="page-head">
        <h1>{t("nav.appointments")}</h1>
        {canBook && branch && (
          <button className="btn btn-primary" onClick={() => setDialog({ day, branch: branch ?? undefined, dentist: dentistFilter ? Number(dentistFilter) : undefined })}>
            + {t("ap.new")}
          </button>
        )}
      </div>
      {checklist}
      {branch && (
      <section className="card">
        <div className="card-head calendar-bar">
          <div className="toolbar">
            <button className="btn btn-small" aria-label={t("ap.prev")} onClick={() => setParam("date", addDays(day, -1))}>
              {lang === "ar" ? "→" : "←"}
            </button>
            <button className="btn btn-small" disabled={isToday} onClick={() => setParam("date", "")}>{t("ap.today")}</button>
            <button className="btn btn-small" aria-label={t("ap.next")} onClick={() => setParam("date", addDays(day, 1))}>
              {lang === "ar" ? "←" : "→"}
            </button>
            <input type="date" aria-label={t("ap.date")} value={day} onChange={(e) => setParam("date", e.target.value)} />
          </div>
          <strong className="calendar-day">{formatDay(day, lang)}</strong>
          <div className="toolbar">
            {branches.length > 1 && (
              <select aria-label={t("ap.branch")} value={branch ?? ""} onChange={(e) => setParam("branch", e.target.value)}>
                {branches.map((b) => (
                  <option key={b.id} value={b.id}>{name(b)}</option>
                ))}
              </select>
            )}
            <select aria-label={t("ap.dentist")} value={dentistFilter} onChange={(e) => setParam("dentist", e.target.value || (ownDentist ? "" : ""))}>
              <option value="">{t("ap.allDentists")}</option>
              {dentists.map((d) => (
                <option key={d.id} value={d.id}>{name(d)}</option>
              ))}
            </select>
            {can("appointments", "edit") && dueReminders > 0 && (
              <button className="btn btn-small" onClick={() => void sendReminders()}>{t("ap.reminders", { n: dueReminders })}</button>
            )}
          </div>
        </div>
        {notice && <p className="notice pad" role="status">{notice}</p>}
        {error && <p className="form-error" role="alert">{error}</p>}
        {todays?.is_closed && <p className="notice pad">{t("ap.closedDay")}</p>}
        {(

          <div className="calendar-layout">
            <div className="calendar-scroll">
              <div className="calendar" style={{ gridTemplateColumns: `56px repeat(${columns.length}, minmax(150px, 1fr))` }}>
                <div className="cal-corner" />
                {columns.map((c) => (
                  <div key={String(c.id)} className="cal-col-head">{c.label}</div>
                ))}
                <div className="cal-times">
                  {slots.map((m) => (
                    <div key={m} className="cal-time" style={{ height: SLOT_PX }}>{m % 60 === 0 ? hhmm(m) : ""}</div>
                  ))}
                </div>
                {columns.map((c) => (
                  <div key={String(c.id)} className="cal-col" style={{ height: slots.length * SLOT_PX }}>
                    {slots.map((m) => (
                      <button
                        key={m}
                        className={`cal-slot ${m % 60 === 0 ? "hour" : ""}`}
                        style={{ height: SLOT_PX }}
                        aria-label={`${c.label} ${hhmm(m)}`}
                        disabled={!canBook}
                        onClick={() => setDialog({ day, time: hhmm(m), branch: branch ?? undefined, chair: c.id ?? undefined, dentist: dentistFilter ? Number(dentistFilter) : undefined })}
                      />
                    ))}
                    {onGrid
                      .filter((a) => a.chair === c.id)
                      .map((a) => {
                        const top = ((minutesOf(new Date(a.start)) - open) / SLOT) * SLOT_PX;
                        const height = Math.max((a.duration_minutes / SLOT) * SLOT_PX - 2, 20);
                        return (
                          <button
                            key={a.id}
                            className={`cal-appt status-${a.status}`}
                            style={{ top, height, borderInlineStartColor: a.dentist_color || undefined }}
                            onClick={() => setSelected(a)}
                          >
                            <span className="cal-appt-time">{timeOf(a.start)}</span>{" "}
                            <strong>{apptName(a, lang)}</strong>
                            {a.patient_alerts.length > 0 && <span className="cal-alert" title={a.patient_alerts.join(", ")}> ⚠</span>}
                            <span className="cal-appt-sub">
                              {lang === "ar" ? a.dentist_name_ar : a.dentist_name_en}
                              {(a.procedure_name_en || a.reason) && ` · ${(lang === "ar" ? a.procedure_name_ar : a.procedure_name_en) || a.reason}`}
                            </span>
                            <span className="cal-appt-status">{t(`ap.status.${a.status}` as TKey)}</span>
                          </button>
                        );
                      })}
                  </div>
                ))}
              </div>
            </div>
            <aside className="queue">
              <h2>{t("ap.queue")}</h2>
              <QueueList title={t("ap.waiting")} rows={queue.waiting} stamp="arrived_at" next="in_chair" onSelect={setSelected} onChanged={load} />
              <QueueList title={t("ap.inChair")} rows={queue.in_chair} stamp="seated_at" next="completed" onSelect={setSelected} onChanged={load} />
              {offGrid.length > 0 && (
                <>
                  <h3>{t("ap.status.cancelled")} / {t("ap.status.no_show")}</h3>
                  <ul className="plain-list">
                    {offGrid.map((a) => (
                      <li key={a.id}>
                        <button className="link-button" onClick={() => setSelected(a)}>{timeOf(a.start)} {apptName(a, lang)}</button>
                        <span className="pill">{t(`ap.status.${a.status}` as TKey)}</span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </aside>
          </div>
        )}
      </section>
      )}
      {dialog && (
        <AppointmentDialog
          initial={dialog}
          onClose={() => setDialog(null)}
          onSaved={(a) => {
            setDialog(null);
            const savedDay = isoDay(new Date(a.start));
            if (savedDay !== day) setParam("date", savedDay);
            void load();
          }}
        />
      )}
      {selected && (
        <AppointmentDetail
          appointment={selected}
          onClose={() => setSelected(null)}
          onEdit={(a) => {
            setSelected(null);
            setDialog({ appointment: a });
          }}
          onChanged={(a) => {
            setSelected(a);
            void load();
          }}
        />
      )}
    </div>
  );
}

function QueueList({
  title,
  rows,
  stamp,
  next,
  onSelect,
  onChanged,
}: {
  title: string;
  rows: Appointment[];
  stamp: "arrived_at" | "seated_at";
  next: AppointmentStatus;
  onSelect: (a: Appointment) => void;
  onChanged: () => void;
}) {
  const { t, lang } = useI18n();
  const { can } = useAuth();
  return (
    <div className="queue-group">
      <h3>
        {title} <span className="muted">({rows.length})</span>
      </h3>
      {rows.length === 0 ? (
        <p className="muted small">{t("ap.queueEmpty")}</p>
      ) : (
        <ul className="plain-list">
          {rows.map((a) => (
            <li key={a.id} className="queue-item">
              <button className="link-button" onClick={() => onSelect(a)}>{apptName(a, lang)}</button>
              {a.patient_alerts.length > 0 && <span className="cal-alert" title={a.patient_alerts.join(", ")}>⚠</span>}
              <span className="muted small">{a[stamp] ? t("ap.since", { time: timeOf(a[stamp]!) }) : ""}</span>
              {can("appointments", "edit") && (
                <button
                  className="btn btn-small"
                  onClick={async () => {
                    await post(`/api/appointments/${a.id}/status/`, { status: next });
                    onChanged();
                  }}
                >
                  {t(`ap.do.${next}` as TKey)}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function AppointmentDetail({
  appointment: a,
  onClose,
  onEdit,
  onChanged,
}: {
  appointment: Appointment;
  onClose: () => void;
  onEdit: (a: Appointment) => void;
  onChanged: (a: Appointment) => void;
}) {
  const { t, lang } = useI18n();
  const { can } = useAuth();
  const [error, setError] = useState("");
  const move = async (status: AppointmentStatus) => {
    let cancel_reason = "";
    if (status === "cancelled") {
      const answer = window.prompt(t("ap.cancelReason"));
      if (answer === null) return;
      cancel_reason = answer;
    }
    try {
      onChanged(await post<Appointment>(`/api/appointments/${a.id}/status/`, { status, cancel_reason }));
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };
  // A visit cannot be a no-show before its time.
  const steps = NEXT_STATUS[a.status].filter((s) => s !== "no_show" || new Date(a.start) <= new Date());
  return (
    <Modal title={apptName(a, lang)} onClose={onClose}>
      <div className="stack">
        <p>
          <span className={`pill status-${a.status}`}>{t(`ap.status.${a.status}` as TKey)}</span>{" "}
          <span className="muted">
            {formatDay(isoDay(new Date(a.start)), lang)} · {timeOf(a.start)}–{timeOf(a.end)}
          </span>
        </p>
        <AlertPills alerts={a.patient_alerts} />
        <dl className="details">
          <div className="detail"><dt>{t("pt.fileNo")}</dt><dd className="num">{a.patient_file_number}</dd></div>
          <div className="detail"><dt>{t("pt.mobile")}</dt><dd dir="ltr">{a.patient_phone}</dd></div>
          <div className="detail"><dt>{t("ap.dentist")}</dt><dd>{lang === "ar" ? a.dentist_name_ar : a.dentist_name_en}</dd></div>
          {a.procedure && <div className="detail"><dt>{t("ap.procedure")}</dt><dd>{lang === "ar" ? a.procedure_name_ar : a.procedure_name_en}</dd></div>}
          {a.reason && <div className="detail"><dt>{t("ap.reason")}</dt><dd>{a.reason}</dd></div>}
          {a.notes && <div className="detail"><dt>{t("ap.notes")}</dt><dd>{a.notes}</dd></div>}
          {a.cancel_reason && <div className="detail"><dt>{t("ap.cancelReason")}</dt><dd>{a.cancel_reason}</dd></div>}
          {a.reminder_sent_at && <div className="detail"><dt>{t("ap.reminded")}</dt><dd>{timeOf(a.reminder_sent_at)}</dd></div>}
        </dl>
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="form-actions">
          {can("patients") && <Link className="btn" to={`/patients/${a.patient}`}>{t("ap.openPatient")}</Link>}
          {can("appointments", "edit") && ["booked", "confirmed"].includes(a.status) && (
            <button className="btn" onClick={() => onEdit(a)}>{t("edit")}</button>
          )}
          {can("appointments", "edit") &&
            steps.map((s) => (
              <button key={s} className={`btn ${s === steps[0] ? "btn-primary" : ""} ${s === "cancelled" ? "btn-danger" : ""}`} onClick={() => void move(s)}>
                {t(`ap.do.${s}` as TKey)}
              </button>
            ))}
        </div>
      </div>
    </Modal>
  );
}

export interface DialogInitial {
  appointment?: Appointment;
  patient?: Patient;
  day?: string;
  time?: string;
  branch?: number;
  chair?: number;
  dentist?: number;
}

/** Book a new appointment, or move an existing one. */
export function AppointmentDialog({
  initial,
  onClose,
  onSaved,
}: {
  initial: DialogInitial;
  onClose: () => void;
  onSaved: (a: Appointment) => void;
}) {
  const { t, lang, name } = useI18n();
  const { me } = useAuth();
  const { branches, dentists, loaded: dentistsLoaded } = useChoices();
  const existing = initial.appointment;
  const [patient, setPatient] = useState<{ id: number; label: string; alerts: string[] } | null>(
    existing
      ? { id: existing.patient, label: apptName(existing, lang), alerts: existing.patient_alerts }
      : initial.patient
        ? { id: initial.patient.id, label: patientName(initial.patient, lang), alerts: initial.patient.alerts.map((a) => a.text) }
        : null,
  );
  const ownDentist = me?.staff_member?.staff_type === "dentist" ? me.staff_member.id : undefined;
  const [values, setValues] = useState<Record<string, unknown>>(() => ({
    branch: existing?.branch ?? initial.branch ?? initial.patient?.home_branch ?? null,
    dentist: existing?.dentist ?? initial.dentist ?? initial.patient?.preferred_dentist ?? ownDentist ?? null,
    chair: existing?.chair ?? initial.chair ?? null,
    procedure: existing?.procedure ?? null,
    day: existing ? isoDay(new Date(existing.start)) : initial.day ?? isoDay(new Date()),
    time: existing ? timeOf(existing.start) : initial.time ?? "",
    duration_minutes: existing?.duration_minutes ?? 30,
    reason: existing?.reason ?? "",
    notes: existing?.notes ?? "",
  }));
  const [procedures, setProcedures] = useState<Procedure[]>([]);
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const [message, setMessage] = useState("");
  const [outsideHours, setOutsideHours] = useState(false);
  const [busy, setBusy] = useState(false);
  const branchId = Number(values.branch) || branches[0]?.id || null;
  const chairs = useChairs(branchId);

  useEffect(() => {
    getAll<Procedure>("/api/masterdata/procedures/?is_active=true").then(setProcedures).catch(() => undefined);
  }, []);
  useEffect(() => {
    if (!values.branch && branches[0]) setValues((v) => ({ ...v, branch: branches[0].id }));
  }, [branches, values.branch]);
  // With a single dentist (or a single chair) there is nothing to choose, so pick it.
  useEffect(() => {
    const options = dentists.filter((d) => !d.branches.length || !branchId || d.branches.includes(branchId));
    if (!values.dentist && options.length === 1) setValues((v) => ({ ...v, dentist: options[0].id }));
  }, [dentists, branchId, values.dentist]);
  useEffect(() => {
    if (!values.chair && !existing && chairs.length === 1) setValues((v) => ({ ...v, chair: chairs[0].id }));
  }, [chairs, values.chair, existing]);

  const set = (key: string, value: unknown) => {
    setValues((v) => {
      const next = { ...v, [key]: value };
      if (key === "procedure") {
        const proc = procedures.find((p) => p.id === Number(value));
        if (proc?.default_duration_minutes) next.duration_minutes = proc.default_duration_minutes;
      }
      if (key === "branch") next.chair = null;
      return next;
    });
    setOutsideHours(false);
  };

  const submit = async (e: FormEvent | null, allowOutside = false) => {
    e?.preventDefault();
    if (!patient) {
      setErrors({ patient: [t("ap.findPatient")] });
      return;
    }
    setBusy(true);
    setErrors({});
    setMessage("");
    const body = {
      patient: patient.id,
      branch: branchId,
      dentist: values.dentist,
      chair: values.chair || null,
      procedure: values.procedure || null,
      start: localIso(String(values.day), String(values.time)),
      duration_minutes: Number(values.duration_minutes),
      reason: values.reason,
      notes: values.notes,
      allow_outside_hours: allowOutside,
    };
    try {
      const saved = existing ? await patch<Appointment>(`/api/appointments/${existing.id}/`, body) : await post<Appointment>("/api/appointments/", body);
      onSaved(saved);
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.fields.code?.includes("outside_hours")) {
          setOutsideHours(true);
          setMessage(err.fields.start?.join(" ") ?? t("ap.outsideHours"));
        } else {
          setErrors(err.fields);
          const known = ["patient", "dentist", "chair", "branch", "start", "duration_minutes", "procedure"];
          setMessage(Object.keys(err.fields).some((f) => known.includes(f)) ? Object.values(err.fields).flat().join(" ") : err.message);
        }
      } else setMessage(String(err));
    } finally {
      setBusy(false);
    }
  };

  const opt = (rows: { id: number; name_en: string; name_ar: string }[]) => rows.map((r) => ({ value: r.id, label: name(r) }));
  const branchDentists = dentists.filter((d) => !d.branches.length || !branchId || d.branches.includes(branchId));
  const missing = !branchId ? t("ap.noBranches") : branchDentists.length === 0 && dentistsLoaded ? t("ap.noDentists") : "";

  return (
    <Modal title={existing ? `${t("edit")}: ${apptName(existing, lang)}` : t("ap.new")} onClose={onClose}>
      {!existing && <PatientPicker value={patient} onChange={setPatient} error={errors.patient} />}
      {patient && patient.alerts.length > 0 && <AlertPills alerts={patient.alerts} />}
      {missing && <p className="notice pad" role="alert">{missing}</p>}
      <form className="form-grid form-grid-2" onSubmit={(e) => void submit(e)}>
        {branches.length > 1 && (
          <Field field={{ name: "branch", label: "ap.branch", type: "select", required: true, options: opt(branches) }} value={values.branch} onChange={(v) => set("branch", v)} errors={errors.branch} />
        )}
        <Field field={{ name: "dentist", label: "ap.dentist", type: "select", required: true, options: opt(branchDentists) }} value={values.dentist} onChange={(v) => set("dentist", v)} errors={errors.dentist} />
        <Field field={{ name: "chair", label: "ap.chair", type: "select", options: opt(chairs) }} value={values.chair} onChange={(v) => set("chair", v)} errors={errors.chair} />
        <Field
          field={{ name: "procedure", label: "ap.procedure", type: "select", options: procedures.map((p) => ({ value: p.id, label: `${p.code} · ${name(p)}` })) }}
          value={values.procedure}
          onChange={(v) => set("procedure", v)}
          errors={errors.procedure}
        />
        <Field field={{ name: "day", label: "ap.date", type: "date", required: true }} value={values.day} onChange={(v) => set("day", v)} />
        <Field field={{ name: "time", label: "ap.time", type: "time", required: true, step: "300" }} value={values.time} onChange={(v) => set("time", v)} errors={errors.start} />
        <Field field={{ name: "duration_minutes", label: "ap.duration", type: "number", required: true, step: "5" }} value={values.duration_minutes} onChange={(v) => set("duration_minutes", v)} errors={errors.duration_minutes} />
        <Field field={{ name: "reason", label: "ap.reason" }} value={values.reason} onChange={(v) => set("reason", v)} />
        <div className="span-all">
          <Field field={{ name: "notes", label: "ap.notes", type: "textarea" }} value={values.notes} onChange={(v) => set("notes", v)} />
        </div>
        {message && <p className="form-error span-all" role="alert">{message}</p>}
        <div className="form-actions span-all">
          <button type="button" className="btn" onClick={onClose}>{t("cancel")}</button>
          {outsideHours && (
            <button type="button" className="btn" disabled={busy} onClick={() => void submit(null, true)}>{t("ap.bookAnyway")}</button>
          )}
          <button type="submit" className="btn btn-primary" disabled={busy || Boolean(missing)}>{t("save")}</button>
        </div>
      </form>
    </Modal>
  );
}

function PatientPicker({
  value,
  onChange,
  error,
}: {
  value: { id: number; label: string; alerts: string[] } | null;
  onChange: (p: { id: number; label: string; alerts: string[] } | null) => void;
  error?: string[];
}) {
  const { t, lang } = useI18n();
  const { can } = useAuth();
  const [search, setSearch] = useState("");
  const [results, setResults] = useState<Patient[]>([]);
  const [adding, setAdding] = useState(false);
  const [newPatient, setNewPatient] = useState<Record<string, unknown>>({ ...PATIENT_DEFAULTS });
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const fields = useMemo(() => patientFields(t, { short: true }), [t]);
  const choose = (p: Patient) => onChange({ id: p.id, label: `${patientName(p, lang)} · ${p.file_number}`, alerts: p.alerts.map((a) => a.text) });

  useEffect(() => {
    if (!search.trim()) return setResults([]);
    const timer = window.setTimeout(() => {
      get<Page<Patient>>(`/api/patients/?is_active=true&search=${encodeURIComponent(search)}`).then((page) => setResults(page.results.slice(0, 8)));
    }, 250);
    return () => window.clearTimeout(timer);
  }, [search]);

  if (value) {
    return (
      <div className="picked">
        <span className="muted">{t("ap.patient")}:</span> <strong>{value.label}</strong>
        <button type="button" className="btn btn-small" onClick={() => onChange(null)}>{t("ap.change")}</button>
      </div>
    );
  }
  if (adding) {
    const create = async () => {
      try {
        choose(await post<Patient>("/api/patients/", cleanPatient(newPatient)));
        setAdding(false);
      } catch (err) {
        if (err instanceof ApiError) setErrors(err.fields);
      }
    };
    return (
      <fieldset className="subform form-grid form-grid-2">
        <legend>{t("pt.new")}</legend>
        {fields.map((f) => (
          <Field key={f.name} field={f} value={newPatient[f.name]} errors={errors[f.name]} onChange={(v) => setNewPatient((s) => ({ ...s, [f.name]: v }))} />
        ))}
        <div className="form-actions span-all">
          <button type="button" className="btn" onClick={() => setAdding(false)}>{t("cancel")}</button>
          <button type="button" className="btn btn-primary" onClick={() => void create()}>{t("save")}</button>
        </div>
      </fieldset>
    );
  }
  return (
    <div className="field">
      <label htmlFor="patient-search">{t("ap.patient")}</label>
      <div className="inline-form">
        <input id="patient-search" type="search" autoFocus placeholder={t("pt.searchHint")} value={search} onChange={(e) => setSearch(e.target.value)} />
        {can("patients", "create") && (
          <button type="button" className="btn" onClick={() => setAdding(true)}>+ {t("pt.new")}</button>
        )}
      </div>
      {results.length > 0 && (
        <ul className="picker-results">
          {results.map((p) => (
            <li key={p.id}>
              <button type="button" onClick={() => choose(p)}>
                <strong>{patientName(p, lang)}</strong> <span className="muted num">{p.file_number}</span>{" "}
                <span className="muted" dir="ltr">{p.phone}</span>
                {p.alerts.length > 0 && <span className="cal-alert"> ⚠</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
      {error && <p className="field-error">{error.join(" ")}</p>}
    </div>
  );
}
