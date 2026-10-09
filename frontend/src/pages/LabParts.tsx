import { useCallback, useEffect, useMemo, useState, type CSSProperties, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { get, getAll, openProtectedFile, patch, post } from "../api";
import { useAuth } from "../auth";
import { useI18n, type TKey } from "../i18n";
import { Modal } from "../components/Crud";
import { Icon } from "../components/Icon";
import { escapeHtml, printDocument, useLetterhead } from "../components/print";
import { fmtDate, locale, money } from "../format";
import type { Appointment, LabCase, LabStage, OrderableLine, StaffMember } from "../types";
import { errorText, personName } from "./BillingParts";

// Lab cases (phase 4). Stages follow the patient card design: scan received,
// CAD design, milling, sintering and glaze, ready for try-in, then delivered.

export const STAGES: LabStage[] = ["received", "design", "milling", "finishing", "ready", "delivered"];
export const OPEN_STAGES: LabStage[] = ["received", "design", "milling", "finishing", "ready"];
export const RESTORATIONS = ["crown", "bridge", "veneer", "inlay_onlay", "implant_crown", "post_core", "denture_full", "denture_partial", "night_guard", "temporary", "other"];
export const MATERIALS = ["zirconia", "emax", "pfm", "metal", "pmma", "composite", "acrylic", "other"];
const REMAKE_REASONS = ["fit", "shade", "fracture", "design", "patient", "other"];
const SHADES = ["BL1", "BL2", "BL3", "BL4", "A1", "A2", "A3", "A3.5", "A4", "B1", "B2", "B3", "B4", "C1", "C2", "C3", "C4", "D2", "D3", "D4"];

type FileRow = { id: number; original_name: string; kind: string; size: number; created_at: string; download_url: string; uploaded_by: string | null };

function isoToday() {
  return new Date().toLocaleDateString("en-CA");
}

export function addDays(iso: string, days: number) {
  const d = new Date(`${iso}T12:00:00`);
  d.setDate(d.getDate() + days);
  return d.toLocaleDateString("en-CA");
}

/** "Zirconia crown, tooth 26" in either language. */
export function useCaseTitle() {
  const { t, lang } = useI18n();
  return useCallback(
    (c: Pick<LabCase, "restoration" | "material" | "teeth" | "procedure">) => {
      const restoration = t(`lab.rest.${c.restoration}` as TKey);
      const material = c.material === "other" ? "" : t(`lab.mat.${c.material}` as TKey);
      const what = material ? t("lab.what", { material, restoration: lang === "en" ? restoration.toLowerCase() : restoration }) : restoration;
      const where = c.teeth ? t("lab.teeth", { n: c.teeth }) : c.procedure.tooth ? t("lab.tooth", { n: c.procedure.tooth }) : "";
      return where ? `${what}${lang === "ar" ? "، " : ", "}${where}` : what;
    },
    [t, lang],
  );
}

export function stagePill(c: LabCase) {
  if (c.cancelled_at) return "pill pill-muted";
  if (c.stage === "delivered") return "pill pill-ok";
  if (c.stage === "ready") return "pill pill-ready";
  return c.overdue ? "pill pill-warn" : "pill pill-outline";
}

export function stageLabel(c: LabCase, t: (k: TKey) => string) {
  return c.cancelled_at ? t("lab.cancelled") : t(`lab.stage.${c.stage}` as TKey);
}

/** The stage list from the design: done stages with their date, the current one marked "now". */
export function StageList({ c, compact = false }: { c: LabCase; compact?: boolean }) {
  const { t, lang } = useI18n();
  const current = STAGES.indexOf(c.stage);
  const when = (stage: LabStage) => {
    const e = [...c.events].reverse().find((x) => x.stage === stage);
    return e ? new Date(e.created_at).toLocaleDateString(locale(lang), { day: "2-digit", month: "short" }) : "";
  };
  return (
    <ol className={`stage-list ${compact ? "compact" : ""}`}>
      {OPEN_STAGES.map((s, i) => {
        const state = i < current || c.stage === "delivered" ? "done" : i === current && !c.cancelled_at ? "now" : "todo";
        return (
          <li key={s} className={`stage-${state}`} style={{ "--i": i } as CSSProperties}>
            <span className="stage-dot" aria-hidden="true" />
            <span className="grow">{t(`lab.stage.${s}` as TKey)}</span>
            <span className="stage-when">{state === "now" ? t("lab.now") : state === "done" ? when(s) : ""}</span>
            <span className="sr-only">{t(`lab.state.${state}` as TKey)}</span>
          </li>
        );
      })}
    </ol>
  );
}

function useTechnicians() {
  const [rows, setRows] = useState<StaffMember[]>([]);
  useEffect(() => {
    getAll<StaffMember>("/api/masterdata/staff/?is_active=true")
      .then((all) => setRows(all.filter((s) => s.staff_type === "technician" || s.staff_type === "dentist").sort((a, b) => (a.staff_type === "technician" ? -1 : 1) - (b.staff_type === "technician" ? -1 : 1))))
      .catch(() => undefined);
  }, []);
  return rows;
}

function usePrintCase() {
  const { t, lang } = useI18n();
  const letterhead = useLetterhead(lang);
  const title = useCaseTitle();
  return (c: LabCase) => {
    const row = (label: string, value: string) => (value ? `<tr><th>${escapeHtml(label)}</th><td>${escapeHtml(value)}</td></tr>` : "");
    printDocument({
      title: `${t("lab.ticket")} ${c.number}`,
      lang,
      clinic: letterhead,
      patient: `${personName(c.patient_info, lang)} · ${c.patient_info.file_number}`,
      body: `<h1>${escapeHtml(title(c))}</h1><table>
        ${row(t("lab.number"), c.number)}
        ${row(t("lab.restoration"), t(`lab.rest.${c.restoration}` as TKey))}
        ${row(t("lab.material"), t(`lab.mat.${c.material}` as TKey))}
        ${row(t("lab.shade"), c.shade)}
        ${row(t("lab.units"), String(c.units))}
        ${row(t("lab.due"), fmtDate(c.due_date, lang))}
        ${row(t("lab.tryIn"), c.appointment_start ? new Date(c.appointment_start).toLocaleString(locale(lang), { dateStyle: "medium", timeStyle: "short" }) : "")}
        ${row(t("lab.orderedBy"), personName(c.dentist_name, lang))}
        ${row(t("lab.technician"), c.technician_name ? personName(c.technician_name, lang) : "")}
        ${c.remake_of_number ? row(t("lab.remakeOf"), `${c.remake_of_number} · ${t(`lab.reason.${c.remake_reason}` as TKey)}`) : ""}
      </table>${c.instructions ? `<h3>${escapeHtml(t("lab.instructions"))}</h3><p class="body">${escapeHtml(c.instructions)}</p>` : ""}`,
      footer: "",
    });
  };
}

/* ---------------------------------------------------------- new case */

export function NewCaseDialog({ patientId, onClose, onSaved }: { patientId: number; onClose: () => void; onSaved: (c: LabCase) => void }) {
  const { t, lang } = useI18n();
  const { can } = useAuth();
  const technicians = useTechnicians();
  const [lines, setLines] = useState<OrderableLine[] | null>(null);
  const [visits, setVisits] = useState<Appointment[]>([]);
  const [lineId, setLineId] = useState<number | null>(null);
  const [form, setForm] = useState({ restoration: "crown", material: "zirconia", shade: "", teeth: "", units: 1, due_date: addDays(isoToday(), 5), technician: "", appointment: "", instructions: "" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));

  useEffect(() => {
    get<OrderableLine[]>(`/api/lab/cases/orderable/?patient=${patientId}`)
      .then((rows) => {
        setLines(rows);
        const first = rows.find((r) => !r.has_open_case);
        if (first) pick(first);
      })
      .catch(() => setLines([]));
    if (can("appointments"))
      get<Appointment[]>(`/api/appointments/?patient=${patientId}`)
        .then((rows) => setVisits(rows.filter((a) => ["booked", "confirmed"].includes(a.status) && new Date(a.start).getTime() > Date.now())))
        .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [patientId]);

  const pick = (line: OrderableLine) => {
    setLineId(line.id);
    const future = line.appointment_start && new Date(line.appointment_start).getTime() > Date.now();
    set({
      restoration: line.restoration,
      material: line.material,
      appointment: future && line.appointment ? String(line.appointment) : "",
      // Ready two days before the try-in visit when there is one.
      ...(future && line.appointment_start ? { due_date: addDays(new Date(line.appointment_start).toLocaleDateString("en-CA"), -2) } : {}),
    });
  };

  const visit = visits.find((v) => String(v.id) === form.appointment);
  const late = visit && form.due_date > new Date(visit.start).toLocaleDateString("en-CA");

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!lineId) return;
    setBusy(true);
    setError("");
    try {
      onSaved(
        await post<LabCase>("/api/lab/cases/", {
          plan_line: lineId,
          ...form,
          technician: form.technician ? Number(form.technician) : null,
          appointment: form.appointment ? Number(form.appointment) : null,
        }),
      );
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={t("lab.newOrder")} onClose={onClose}>
      <form className="form-grid" onSubmit={submit}>
        <fieldset className="field">
          <legend>{t("lab.forLine")}</legend>
          {lines === null ? (
            <p className="muted">{t("loading")}</p>
          ) : lines.length === 0 ? (
            <p className="muted small">{t("lab.noLines")}</p>
          ) : (
            <div className="line-checks lab-lines">
              {lines.map((l) => (
                <label key={l.id} className={`check ${l.has_open_case ? "is-disabled" : ""}`}>
                  <input type="radio" name="line" checked={lineId === l.id} disabled={l.has_open_case} onChange={() => pick(l)} />
                  <span className="grow">
                    {lang === "ar" ? l.procedure_name_ar || l.procedure_name_en : l.procedure_name_en || l.procedure_name_ar}
                    {l.tooth ? ` · ${t("tooth.label", { n: l.tooth })}` : ""}
                    <span className="muted small"> · {t(`line.status.${l.status}` as TKey)}</span>
                  </span>
                  {l.has_open_case ? <span className="pill pill-muted">{t("lab.inLab")}</span> : l.needs_lab ? <span className="pill pill-outline">{t("lab.labWork")}</span> : null}
                </label>
              ))}
            </div>
          )}
        </fieldset>
        <div className="form-grid form-grid-2">
          <label className="field">
            <span>{t("lab.restoration")}</span>
            <select value={form.restoration} onChange={(e) => set({ restoration: e.target.value })}>
              {RESTORATIONS.map((r) => <option key={r} value={r}>{t(`lab.rest.${r}` as TKey)}</option>)}
            </select>
          </label>
          <label className="field">
            <span>{t("lab.material")}</span>
            <select value={form.material} onChange={(e) => set({ material: e.target.value })}>
              {MATERIALS.map((m) => <option key={m} value={m}>{t(`lab.mat.${m}` as TKey)}</option>)}
            </select>
          </label>
          <label className="field">
            <span>{t("lab.shade")}</span>
            <input list="lab-shades" dir="ltr" value={form.shade} placeholder="A2" onChange={(e) => set({ shade: e.target.value })} />
            <datalist id="lab-shades">{SHADES.map((s) => <option key={s} value={s} />)}</datalist>
          </label>
          <label className="field">
            <span>{t("lab.units")}</span>
            <input type="number" min="1" max="32" value={form.units} onChange={(e) => set({ units: Math.max(1, Number(e.target.value) || 1) })} />
          </label>
          <label className="field">
            <span>{t("lab.teethField")}</span>
            <input dir="ltr" value={form.teeth} placeholder={t("lab.teethPh")} onChange={(e) => set({ teeth: e.target.value })} />
          </label>
          <label className="field">
            <span>{t("lab.due")}</span>
            <input type="date" required min={isoToday()} value={form.due_date} onChange={(e) => set({ due_date: e.target.value })} />
          </label>
          <label className="field">
            <span>{t("lab.technician")}</span>
            <select value={form.technician} onChange={(e) => set({ technician: e.target.value })}>
              <option value="">{t("lab.unassigned")}</option>
              {technicians.map((s) => <option key={s.id} value={s.id}>{personName({ ar: s.name_ar, en: s.name_en }, lang)}</option>)}
            </select>
          </label>
          {visits.length > 0 && (
            <label className="field">
              <span>{t("lab.tryIn")}</span>
              <select value={form.appointment} onChange={(e) => set({ appointment: e.target.value })}>
                <option value="">{t("lab.noVisit")}</option>
                {visits.map((v) => (
                  <option key={v.id} value={v.id}>{new Date(v.start).toLocaleString(locale(lang), { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</option>
                ))}
              </select>
            </label>
          )}
        </div>
        {late && <p className="pill pill-warn">{t("lab.lateWarning")}</p>}
        <label className="field">
          <span>{t("lab.instructions")}</span>
          <textarea rows={3} value={form.instructions} placeholder={t("lab.instructionsPh")} onChange={(e) => set({ instructions: e.target.value })} />
        </label>
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="form-actions">
          <button type="button" className="btn" onClick={onClose}>{t("cancel")}</button>
          <button type="submit" className="btn btn-primary" disabled={busy || !lineId}>{t("lab.send")}</button>
        </div>
      </form>
    </Modal>
  );
}

/* --------------------------------------------------------- case view */

export function CaseView({ initial, onClose, onChanged }: { initial: LabCase; onClose: () => void; onChanged: () => void }) {
  const { t, lang } = useI18n();
  const { can } = useAuth();
  const title = useCaseTitle();
  const print = usePrintCase();
  const technicians = useTechnicians();
  const [c, setC] = useState(initial);
  const [files, setFiles] = useState<FileRow[]>([]);
  const [note, setNote] = useState("");
  const [costs, setCosts] = useState({ material_cost: initial.material_cost, labour_cost: initial.labour_cost, units: initial.units });
  const [remaking, setRemaking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const editable = can("lab", "edit") && !c.cancelled_at;
  const filesQuery = `attached_model=lab.labcase&attached_id=${c.id}`;

  const loadFiles = useCallback(() => {
    if (can("files")) getAll<FileRow>(`/api/files/?${filesQuery}`).then(setFiles).catch(() => undefined);
  }, [filesQuery, can]);
  useEffect(loadFiles, [loadFiles]);

  const run = async (fn: () => Promise<LabCase>) => {
    setBusy(true);
    setError("");
    try {
      const next = await fn();
      setC(next);
      setCosts({ material_cost: next.material_cost, labour_cost: next.labour_cost, units: next.units });
      onChanged();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  const move = (stage: LabStage) =>
    run(async () => {
      const next = await post<LabCase>(`/api/lab/cases/${c.id}/stage/`, { stage, note });
      setNote("");
      return next;
    });
  const update = (body: Record<string, unknown>) => run(() => patch<LabCase>(`/api/lab/cases/${c.id}/`, body));
  const cancel = () => {
    const reason = window.prompt(t("lab.cancelReason"));
    if (reason) void run(() => post<LabCase>(`/api/lab/cases/${c.id}/cancel/`, { reason }));
  };
  const upload = async (list: FileList) => {
    setBusy(true);
    try {
      for (const file of Array.from(list)) {
        const form = new FormData();
        form.append("file", file);
        form.append("kind", "scan");
        form.append("attached_model", "lab.labcase");
        form.append("attached_id", String(c.id));
        await post("/api/files/", form);
      }
      loadFiles();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const index = STAGES.indexOf(c.stage);
  const nextStage = c.is_open ? STAGES[index + 1] : undefined;
  const total = Number(costs.material_cost || 0) + Number(costs.labour_cost || 0);
  const perUnit = costs.units ? total / costs.units : total;
  const costsChanged = costs.material_cost !== c.material_cost || costs.labour_cost !== c.labour_cost || costs.units !== c.units;

  return (
    <Modal title={`${c.number} · ${title(c)}`} onClose={onClose}>
      <div className="case-view">
        <div className="invoice-head">
          <div>
            <p className="strong">
              {can("patients") ? <Link to={`/patients/${c.patient}`}>{personName(c.patient_info, lang)}</Link> : personName(c.patient_info, lang)}{" "}
              <span className="muted mono small">{c.patient_info.file_number}</span>
            </p>
            <p className="muted small">
              {t("lab.orderedOn", { name: personName(c.dentist_name, lang), date: fmtDate(c.created_at.slice(0, 10), lang) })}
            </p>
          </div>
          <span className={stagePill(c)}>{stageLabel(c, t)}</span>
        </div>
        {c.remake_of_number && (
          <p className="notice pad-sm">{t("lab.isRemake", { n: c.remake_of_number, reason: t(`lab.reason.${c.remake_reason}` as TKey) })}{c.remake_note ? ` · ${c.remake_note}` : ""}</p>
        )}
        {c.cancelled_at && <p className="notice pad-sm">{t("lab.cancelledBecause", { reason: c.cancel_reason })}</p>}
        {c.overdue && <p className="pill pill-warn">{t("lab.overdueBy", { date: fmtDate(c.due_date, lang) })}</p>}

        <div className="case-grid">
          <section className="case-stages">
            <h3 className="sub-head">{t("lab.progress")}</h3>
            <StageList c={c} />
            {editable && c.is_open && (
              <div className="stage-move">
                <input aria-label={t("lab.stageNote")} placeholder={t("lab.stageNote")} value={note} onChange={(e) => setNote(e.target.value)} />
                <div className="toolbar">
                  {nextStage && (
                    <button className="btn btn-primary" disabled={busy} onClick={() => void move(nextStage)}>
                      {t("lab.moveTo", { stage: t(`lab.stage.${nextStage}` as TKey) })} <Icon name="arrow" size={18} className="flip-rtl" />
                    </button>
                  )}
                  {index > 0 && (
                    <button className="btn" disabled={busy} onClick={() => void move(STAGES[index - 1])}>{t("lab.stepBack")}</button>
                  )}
                </div>
              </div>
            )}
            {c.events.some((e) => e.note || e.by) && (
              <details className="stage-log">
                <summary>{t("lab.history")}</summary>
                <ul className="plain-list">
                  {c.events.map((e) => (
                    <li key={e.id} className="small">
                      <span className="muted nowrap">{new Date(e.created_at).toLocaleString(locale(lang), { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</span>
                      <span className="strong">{t(`lab.stage.${e.stage}` as TKey)}</span>
                      {e.by && <span className="muted">{e.by}</span>}
                      {e.note && <span>· {e.note}</span>}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </section>

          <section>
            <h3 className="sub-head">{t("lab.details")}</h3>
            <dl className="kv">
              <div><dt>{t("lab.shade")}</dt><dd className="mono">{c.shade || "—"}</dd></div>
              <div><dt>{t("lab.units")}</dt><dd>{c.units}</dd></div>
              <div><dt>{t("lab.due")}</dt><dd>{fmtDate(c.due_date, lang)}</dd></div>
              {c.appointment_start && <div><dt>{t("lab.tryIn")}</dt><dd>{new Date(c.appointment_start).toLocaleString(locale(lang), { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</dd></div>}
              <div>
                <dt>{t("lab.technician")}</dt>
                <dd>
                  {editable ? (
                    <select aria-label={t("lab.technician")} value={c.technician ?? ""} onChange={(e) => void update({ technician: e.target.value ? Number(e.target.value) : null })}>
                      <option value="">{t("lab.unassigned")}</option>
                      {technicians.map((s) => <option key={s.id} value={s.id}>{personName({ ar: s.name_ar, en: s.name_en }, lang)}</option>)}
                    </select>
                  ) : c.technician_name ? personName(c.technician_name, lang) : t("lab.unassigned")}
                </dd>
              </div>
            </dl>
            {c.instructions && (
              <>
                <h3 className="sub-head">{t("lab.instructions")}</h3>
                <p className="instructions">{c.instructions}</p>
              </>
            )}
          </section>
        </div>

        {can("files") && (
          <section className="subsection">
            <div className="sub-row">
              <h3 className="sub-head">{t("lab.files")}</h3>
              {can("files", "create") && !c.cancelled_at && (
                <label className={`btn btn-small ${busy ? "disabled" : ""}`}>
                  <Icon name="upload" size={16} /> {t("lab.addFile")}
                  <input type="file" multiple hidden accept=".stl,.ply,.obj,.zip,.pdf,image/*" onChange={(e) => e.target.files && void upload(e.target.files)} />
                </label>
              )}
            </div>
            {files.length === 0 ? (
              <p className="muted small">{t("lab.noFiles")}</p>
            ) : (
              <ul className="plain-list inst-list">
                {files.map((f) => (
                  <li key={f.id}>
                    <Icon name="file" size={16} />
                    <button className="link-button grow" onClick={() => void openProtectedFile(f.download_url)}>{f.original_name}</button>
                    <span className="muted small">{`${Math.max(1, Math.round(f.size / 1024))} KB · ${fmtDate(f.created_at.slice(0, 10), lang)}`}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}

        <section className="subsection">
          <h3 className="sub-head">{t("lab.cost")}</h3>
          {can("lab", "edit") ? (
            <div className="cost-row">
              <label className="field">
                <span>{t("lab.materialCost")}</span>
                <input type="number" min="0" step="0.01" dir="ltr" value={costs.material_cost} onChange={(e) => setCosts((x) => ({ ...x, material_cost: e.target.value }))} />
              </label>
              <label className="field">
                <span>{t("lab.labourCost")}</span>
                <input type="number" min="0" step="0.01" dir="ltr" value={costs.labour_cost} onChange={(e) => setCosts((x) => ({ ...x, labour_cost: e.target.value }))} />
              </label>
              <label className="field">
                <span>{t("lab.units")}</span>
                <input type="number" min="1" max="32" value={costs.units} onChange={(e) => setCosts((x) => ({ ...x, units: Math.max(1, Number(e.target.value) || 1) }))} />
              </label>
              <div className="cost-total">
                <span className="muted small">{t("lab.perUnit")}</span>
                <strong className="num">{money(perUnit, lang)}</strong>
                <span className="muted small">{t("lab.ofTotal", { n: money(total, lang) })}</span>
              </div>
              {costsChanged && !c.cancelled_at && (
                <button className="btn btn-small" disabled={busy} onClick={() => void update(costs)}>{t("save")}</button>
              )}
            </div>
          ) : (
            <p>{t("lab.costLine", { total: money(c.cost_total, lang), unit: money(c.cost_per_unit, lang) })}</p>
          )}
        </section>

        {c.remake_numbers.length > 0 && <p className="muted small">{t("lab.remadeAs", { n: c.remake_numbers.join(", ") })}</p>}
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="form-actions">
          {c.is_open && can("lab", "delete") && <button className="btn" onClick={cancel}>{t("lab.cancel")}</button>}
          {!c.cancelled_at && ["ready", "delivered"].includes(c.stage) && can("lab", "create") && (
            <button className="btn" onClick={() => setRemaking(true)}>{t("lab.remake")}</button>
          )}
          <button className="btn" onClick={() => print(c)}>{t("lab.printTicket")}</button>
          {c.stage === "ready" && editable && (
            <button className="btn btn-primary" disabled={busy} onClick={() => void move("delivered")}>{t("lab.markDelivered")}</button>
          )}
        </div>
      </div>
      {remaking && (
        <RemakeDialog
          c={c}
          onClose={() => setRemaking(false)}
          onSaved={(next) => {
            setRemaking(false);
            setC(next);
            setCosts({ material_cost: next.material_cost, labour_cost: next.labour_cost, units: next.units });
            onChanged();
          }}
        />
      )}
    </Modal>
  );
}

function RemakeDialog({ c, onClose, onSaved }: { c: LabCase; onClose: () => void; onSaved: (c: LabCase) => void }) {
  const { t } = useI18n();
  const [reason, setReason] = useState("fit");
  const [charged, setCharged] = useState("lab");
  const [due, setDue] = useState(addDays(isoToday(), 4));
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      onSaved(await post<LabCase>(`/api/lab/cases/${c.id}/remake/`, { reason, charged_to: charged, due_date: due, note }));
    } catch (err) {
      setError(errorText(err));
    }
  };
  return (
    <Modal title={t("lab.remakeTitle", { n: c.number })} onClose={onClose}>
      <form className="form-grid" onSubmit={submit}>
        <p className="muted">{t("lab.remakeIntro")}</p>
        <div className="form-grid form-grid-2">
          <label className="field">
            <span>{t("lab.remakeReason")}</span>
            <select value={reason} onChange={(e) => setReason(e.target.value)}>
              {REMAKE_REASONS.map((r) => <option key={r} value={r}>{t(`lab.reason.${r}` as TKey)}</option>)}
            </select>
          </label>
          <label className="field">
            <span>{t("lab.chargedTo")}</span>
            <select value={charged} onChange={(e) => setCharged(e.target.value)}>
              <option value="lab">{t("lab.charged.lab")}</option>
              <option value="clinic">{t("lab.charged.clinic")}</option>
            </select>
          </label>
          <label className="field">
            <span>{t("lab.due")}</span>
            <input type="date" required min={isoToday()} value={due} onChange={(e) => setDue(e.target.value)} />
          </label>
          <label className="field">
            <span>{t("notes")}</span>
            <input value={note} onChange={(e) => setNote(e.target.value)} />
          </label>
        </div>
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="form-actions">
          <button type="button" className="btn" onClick={onClose}>{t("cancel")}</button>
          <button type="submit" className="btn btn-primary">{t("lab.startRemake")}</button>
        </div>
      </form>
    </Modal>
  );
}

/* ------------------------------------------------- patient file card */

export function LabCard({ patientId, active }: { patientId: number; active: boolean }) {
  const { t, lang } = useI18n();
  const { can } = useAuth();
  const title = useCaseTitle();
  const [cases, setCases] = useState<LabCase[] | null>(null);
  const [ordering, setOrdering] = useState(false);
  const [viewing, setViewing] = useState<LabCase | null>(null);
  const load = useCallback(() => {
    getAll<LabCase>(`/api/lab/cases/?patient=${patientId}`).then(setCases).catch(() => setCases([]));
  }, [patientId]);
  useEffect(load, [load]);
  const open = useMemo(() => (cases ?? []).filter((c) => c.is_open), [cases]);
  const closed = useMemo(() => (cases ?? []).filter((c) => !c.is_open).sort((a, b) => b.created_at.localeCompare(a.created_at)), [cases]);

  return (
    <section id="lab" className="card side-card">
      <header className="side-card-head">
        <h2>{t("lab.orders")}</h2>
        <span className="muted small">{t("lab.inHouse")}</span>
      </header>
      {cases === null ? (
        <p className="muted small">{t("loading")}</p>
      ) : cases.length === 0 ? (
        <p className="muted small">{t("lab.none")}</p>
      ) : null}
      {open.map((c) => (
        <button key={c.id} className="lab-order" onClick={() => setViewing(c)}>
          <span className="lab-order-head">
            <span>
              <span className="strong block">{title(c)}</span>
              <span className="small ink-2">
                {[c.shade && t("lab.shadeOf", { s: c.shade }), t("lab.dueOn", { date: fmtDate(c.due_date, lang) })].filter(Boolean).join(" · ")}
              </span>
            </span>
            <span className="mono small muted">{c.number}</span>
          </span>
          <StageList c={c} />
        </button>
      ))}
      {closed.map((c) => (
        <button key={c.id} className="lab-done" onClick={() => setViewing(c)}>
          <span className="grow">
            <span className="block">{title(c)}</span>
            <span className="small muted">
              {c.number} · {c.delivered_at ? t("lab.deliveredOn", { date: fmtDate(c.delivered_at.slice(0, 10), lang) }) : stageLabel(c, t)}
            </span>
          </span>
          <span className={stagePill(c)}>{stageLabel(c, t)}</span>
        </button>
      ))}
      {can("lab", "create") && active && (
        <button className="btn add-line" onClick={() => setOrdering(true)}>
          <Icon name="plus" size={16} /> {t("lab.newOrder")}
        </button>
      )}
      {ordering && (
        <NewCaseDialog
          patientId={patientId}
          onClose={() => setOrdering(false)}
          onSaved={(c) => {
            setOrdering(false);
            load();
            setViewing(c);
          }}
        />
      )}
      {viewing && <CaseView initial={viewing} onClose={() => setViewing(null)} onChanged={load} />}
    </section>
  );
}
