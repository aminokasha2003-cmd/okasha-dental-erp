import { useCallback, useEffect, useState, type FormEvent } from "react";
import { get, getAll, patch, post, type Page } from "../api";
import { useAuth } from "../auth";
import { useI18n, type TKey } from "../i18n";
import { Modal, RecordForm, type FieldDef } from "../components/Crud";
import { Icon } from "../components/Icon";
import { fmtDate, money } from "../format";
import { errorText, useCurrency } from "./BillingParts";
import { useSuppliers } from "./InventoryParts";
import { Empty, Segmented, StatePill, fmtDateTime, isoToday, nm, useBranches } from "./ComplianceParts";
import type { Equipment, Licence, MaintenancePlan, MaintenanceRecord, WorkOrder } from "./ComplianceTypes";

export const CATEGORIES = ["chair", "autoclave", "compressor", "suction", "xray", "opg", "cbct", "scanner", "milling", "printer", "furnace", "ultrasonic", "curing", "other"];
type Sub = "register" | "maintenance" | "orders";

/** Equipment register, preventive maintenance and breakdown work orders. */
export function EquipmentArea({ initial }: { initial?: Sub }) {
  const { t } = useI18n();
  const [sub, setSub] = useState<Sub>(initial ?? "maintenance");
  const subs: { id: Sub; label: TKey }[] = [
    { id: "maintenance", label: "co.eq.maintenance" },
    { id: "orders", label: "co.eq.orders" },
    { id: "register", label: "co.eq.register" },
  ];
  return (
    <>
      <div className="segmented tabs co-subtabs" role="tablist">
        {subs.map((s) => (
          <button key={s.id} role="tab" aria-selected={sub === s.id} className={sub === s.id ? "active" : ""} onClick={() => setSub(s.id)}>
            {t(s.label)}
          </button>
        ))}
      </div>
      {sub === "register" && <Register />}
      {sub === "maintenance" && <Maintenance />}
      {sub === "orders" && <WorkOrders />}
    </>
  );
}

function useChairs() {
  const [rows, setRows] = useState<{ id: number; name_en: string; name_ar: string; branch: number }[]>([]);
  useEffect(() => {
    getAll<{ id: number; name_en: string; name_ar: string; branch: number }>("/api/masterdata/chairs/").then(setRows).catch(() => setRows([]));
  }, []);
  return rows;
}

export function useEquipment(version = 0) {
  const [rows, setRows] = useState<Equipment[] | null>(null);
  useEffect(() => {
    get<Equipment[]>("/api/compliance/equipment/").then(setRows).catch(() => setRows([]));
  }, [version]);
  return rows;
}

function Register() {
  const { t, lang, name } = useI18n();
  const { can } = useAuth();
  const currency = useCurrency();
  const branches = useBranches();
  const chairs = useChairs();
  const suppliers = useSuppliers();
  const [version, setVersion] = useState(0);
  const [category, setCategory] = useState("");
  const [search, setSearch] = useState("");
  const [rows, setRows] = useState<Equipment[] | null>(null);
  const [editing, setEditing] = useState<{ row: Equipment | null } | null>(null);
  const [reporting, setReporting] = useState<Equipment | null>(null);
  useEffect(() => {
    const q = new URLSearchParams();
    if (category) q.set("category", category);
    if (search.trim()) q.set("search", search.trim());
    const timer = window.setTimeout(() => get<Equipment[]>(`/api/compliance/equipment/?${q}`).then(setRows).catch(() => setRows([])), search ? 250 : 0);
    return () => window.clearTimeout(timer);
  }, [category, search, version]);
  const fields: FieldDef[] = [
    { name: "name_en", label: "nameEn", required: true, dir: "ltr" },
    { name: "name_ar", label: "nameAr", required: true, dir: "rtl" },
    { name: "category", label: "co.kindLabel", type: "select", required: true, options: CATEGORIES.map((c) => ({ value: c, label: t(`co.cat.${c}` as TKey) })) },
    { name: "code", label: "co.assetTag", dir: "ltr", hint: "co.assetTagHint" },
    { name: "branch", label: "co.branch", type: "select", options: branches.map((b) => ({ value: b.id, label: name(b) })) },
    { name: "chair", label: "co.chair", type: "select", options: chairs.map((c) => ({ value: c.id, label: name(c) })), hint: "co.chairHint" },
    { name: "manufacturer", label: "co.make", dir: "ltr" },
    { name: "model_name", label: "co.model", dir: "ltr" },
    { name: "serial_number", label: "co.serial", dir: "ltr" },
    { name: "supplier", label: "co.supplier", type: "select", options: suppliers.map((s) => ({ value: s.id, label: s.name })) },
    { name: "purchase_date", label: "co.bought", type: "date" },
    { name: "cost", label: "co.cost", type: "number", step: "0.01", dir: "ltr" },
    { name: "warranty_end", label: "co.warrantyUntil", type: "date" },
    { name: "status", label: "plan.status", type: "select", required: true, options: ["in_service", "out_of_service", "retired"].map((s) => ({ value: s, label: t(`co.eqs.${s}` as TKey) })) },
    { name: "cycles_before", label: "co.cyclesBefore", type: "number", hint: "co.cyclesBeforeHint", dir: "ltr" },
    { name: "notes", label: "notes", type: "textarea" },
  ];
  const save = async (values: Record<string, unknown>) => {
    const body = { ...values };
    for (const k of ["purchase_date", "warranty_end", "branch", "chair", "supplier"]) if (body[k] === "") body[k] = null;
    if (editing?.row) await patch(`/api/compliance/equipment/${editing.row.id}/`, body);
    else await post("/api/compliance/equipment/", body);
    setEditing(null);
    setVersion((v) => v + 1);
  };
  return (
    <section className="card">
      <header className="card-head">
        <div className="toolbar co-eq-toolbar">
          <label className="top-search search-field">
            <Icon name="search" />
            <input type="search" aria-label={t("search")} placeholder={t("co.eqSearch")} value={search} onChange={(e) => setSearch(e.target.value)} />
          </label>
          <select aria-label={t("co.kindLabel")} value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="">{t("co.allTypes")}</option>
            {CATEGORIES.map((c) => <option key={c} value={c}>{t(`co.cat.${c}` as TKey)}</option>)}
          </select>
        </div>
        {can("compliance", "edit") && <button className="btn btn-primary" onClick={() => setEditing({ row: null })}><Icon name="plus" size={18} /> {t("co.addEquipment")}</button>}
      </header>
      {rows === null ? <Empty text="loading" /> : rows.length === 0 ? <Empty text="noRecords" /> : (
        <div className="co-eq-grid">
          {rows.map((e, i) => (
            <article key={e.id} className={`card co-eq-card ${e.status !== "in_service" ? "is-down" : ""}`} style={{ animationDelay: `${Math.min(i, 12) * 30}ms` }}>
              <div className="co-eq-top">
                <span className={`co-eq-icon cat-${e.category}`} aria-hidden="true"><Icon name={e.category === "autoclave" ? "bolt" : e.category === "chair" ? "tooth" : "box"} size={18} /></span>
                <div className="grow">
                  <p className="strong">{lang === "ar" ? e.name_ar : e.name_en}</p>
                  <p className="muted small">{t(`co.cat.${e.category}` as TKey)} · <span className="mono">{e.code}</span></p>
                </div>
                <StatePill state={e.status} label={t(`co.eqs.${e.status}` as TKey)} />
              </div>
              <dl className="co-facts small">
                <div><dt>{t("co.branch")}</dt><dd>{nm(e.branch_name, lang) || "—"}{e.chair_name ? ` · ${nm(e.chair_name, lang)}` : ""}</dd></div>
                <div><dt>{t("co.model")}</dt><dd dir="ltr">{[e.manufacturer, e.model_name].filter(Boolean).join(" ") || "—"}</dd></div>
                <div><dt>{t("co.serial")}</dt><dd className="mono" dir="ltr">{e.serial_number || "—"}</dd></div>
                <div><dt>{t("co.warrantyUntil")}</dt><dd>{e.warranty_end ? <>{fmtDate(e.warranty_end, lang)} {e.warranty_active ? <span className="pill pill-ok tiny">{t("co.inWarranty")}</span> : null}</> : "—"}</dd></div>
                {e.cycle_count !== null && <div><dt>{t("co.cycles")}</dt><dd className="num">{e.cycle_count.toLocaleString()}</dd></div>}
                {Number(e.cost) > 0 && <div><dt>{t("co.cost")}</dt><dd>{money(e.cost, lang)} {currency}</dd></div>}
              </dl>
              <div className="co-eq-actions">
                {e.open_work_orders > 0 && <span className="pill pill-ready">{t("co.openOrdersN", { n: e.open_work_orders })}</span>}
                <span className="grow" />
                {can("compliance", "create") && <button className="btn btn-small" onClick={() => setReporting(e)}>{t("co.reportFault")}</button>}
                {can("compliance", "edit") && <button className="btn btn-small" onClick={() => setEditing({ row: e })}>{t("edit")}</button>}
              </div>
            </article>
          ))}
        </div>
      )}
      {editing && (
        <Modal title={editing.row ? `${t("edit")}: ${lang === "ar" ? editing.row.name_ar : editing.row.name_en}` : t("co.addEquipment")} onClose={() => setEditing(null)}>
          <RecordForm fields={fields} isNew={!editing.row} initial={editing.row ? { ...editing.row } : { category: "chair", status: "in_service", cost: "0", cycles_before: 0 }} onSubmit={save} onCancel={() => setEditing(null)} />
        </Modal>
      )}
      {reporting && <NewWorkOrder equipment={[reporting]} onClose={() => setReporting(null)} onSaved={() => { setReporting(null); setVersion((v) => v + 1); }} />}
    </section>
  );
}

function every(p: MaintenancePlan, t: (k: TKey, v?: Record<string, string | number>) => string) {
  const parts: string[] = [];
  if (p.every_months) parts.push(t("co.everyMonths", { n: p.every_months }));
  if (p.every_days) parts.push(t("co.everyDays", { n: p.every_days }));
  if (p.every_cycles) parts.push(t("co.everyCycles", { n: p.every_cycles }));
  return parts.join(` ${t("co.or")} `);
}

function Maintenance() {
  const { t, lang } = useI18n();
  const { can } = useAuth();
  const currency = useCurrency();
  const [filter, setFilter] = useState<"attention" | "all">("attention");
  const [rows, setRows] = useState<MaintenancePlan[] | null>(null);
  const [all, setAll] = useState<MaintenancePlan[]>([]);
  const [records, setRecords] = useState<MaintenanceRecord[]>([]);
  const [doing, setDoing] = useState<MaintenancePlan | null>(null);
  const [adding, setAdding] = useState(false);
  const equipment = useEquipment();
  const load = useCallback(() => {
    get<MaintenancePlan[]>("/api/compliance/plans/").then((r) => {
      setAll(r);
      setRows(r);
    }).catch(() => setRows([]));
    get<Page<MaintenanceRecord>>("/api/compliance/records/").then((p) => setRecords(p.results.slice(0, 12))).catch(() => setRecords([]));
  }, []);
  useEffect(load, [load]);
  const shown = (rows ?? []).filter((p) => filter === "all" || p.due.state !== "ok");
  const n = (s: string) => all.filter((p) => p.due.state === s).length;
  const planFields: FieldDef[] = [
    { name: "equipment", label: "co.equipment", type: "select", required: true, options: (equipment ?? []).map((e) => ({ value: e.id, label: `${lang === "ar" ? e.name_ar : e.name_en} (${e.code})` })) },
    { name: "title_en", label: "co.taskEn", required: true, dir: "ltr" },
    { name: "title_ar", label: "co.taskAr", required: true, dir: "rtl" },
    { name: "kind", label: "co.kindLabel", type: "select", required: true, options: ["service", "calibration", "inspection", "validation", "filter", "other"].map((k) => ({ value: k, label: t(`co.pk.${k}` as TKey) })) },
    { name: "every_months", label: "co.f.every_months", type: "number", dir: "ltr" },
    { name: "every_days", label: "co.f.every_days", type: "number", dir: "ltr" },
    { name: "every_cycles", label: "co.f.every_cycles", type: "number", dir: "ltr", hint: "co.everyCyclesHint" },
    { name: "start_on", label: "co.f.start_on", type: "date", hint: "co.startOnHint" },
    { name: "last_done_on", label: "co.lastDone", type: "date" },
    { name: "vendor", label: "co.doneBy" },
  ];
  const addPlan = async (values: Record<string, unknown>) => {
    const body = { ...values };
    for (const k of ["every_months", "every_days", "every_cycles", "last_done_on"]) if (body[k] === "" || body[k] === undefined) body[k] = null;
    await post("/api/compliance/plans/", body);
    setAdding(false);
    load();
  };
  return (
    <>
      <section className="card">
        <header className="card-head">
          <Segmented value={filter} onChange={setFilter} label={t("lab.show")} options={[
            { id: "attention", label: t("co.needsAttention"), n: n("overdue") + n("due_soon"), warn: n("overdue") > 0 },
            { id: "all", label: t("co.allPlans"), n: all.length },
          ]} />
          {can("compliance", "edit") && <button className="btn btn-primary" onClick={() => setAdding(true)}><Icon name="plus" size={18} /> {t("co.addPlan")}</button>}
        </header>
        {rows === null ? <Empty text="loading" /> : shown.length === 0 ? <Empty text="co.allUpToDate" /> : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{t("co.equipment")}</th>
                  <th>{t("co.task")}</th>
                  <th>{t("co.every")}</th>
                  <th>{t("co.lastDone")}</th>
                  <th>{t("co.nextDue")}</th>
                  <th>{t("plan.status")}</th>
                  {can("compliance", "edit") && <th className="cell-actions">{t("actions")}</th>}
                </tr>
              </thead>
              <tbody>
                {shown.map((p) => (
                  <tr key={p.id}>
                    <td>{nm(p.equipment_info, lang)} <span className="muted small">· {nm(p.equipment_info.branch, lang)}</span></td>
                    <td>{lang === "ar" ? p.title_ar : p.title_en}<span className="muted small block">{p.vendor}</span></td>
                    <td className="small">{every(p, t)}</td>
                    <td className="nowrap">{p.last_done_on ? fmtDate(p.last_done_on, lang) : "—"}</td>
                    <td className="nowrap">
                      {p.due.date ? fmtDate(p.due.date, lang) : ""}
                      {p.due.cycles_left !== null && <span className="small block muted">{p.due.cycles_left > 0 ? t("co.cyclesLeft", { n: p.due.cycles_left }) : t("co.cyclesOver", { n: -p.due.cycles_left })}</span>}
                    </td>
                    <td><StatePill state={p.due.state} label={t(`co.due.${p.due.state}` as TKey)} /></td>
                    {can("compliance", "edit") && <td className="cell-actions"><button className="btn btn-small btn-primary" onClick={() => setDoing(p)}>{t("co.markDone")}</button></td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <section className="card">
        <header className="card-head"><h2>{t("co.recentService")}</h2></header>
        {records.length === 0 ? <Empty text="noRecords" /> : (
          <ul className="plain-list inst-list pad">
            {records.map((r) => (
              <li key={r.id}>
                <span className="nowrap small">{fmtDate(r.done_on, lang)}</span>
                <span className="grow">{nm(r.equipment_info, lang)} · {r.plan_title ? nm(r.plan_title, lang) : r.work_order_number}<span className="muted small block">{r.performed_by}{r.notes ? ` · ${r.notes}` : ""}</span></span>
                <span className="num">{Number(r.cost) ? `${money(r.cost, lang)} ${currency}` : "—"}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
      {doing && <DoneDialog plan={doing} onClose={() => setDoing(null)} onSaved={() => { setDoing(null); load(); }} />}
      {adding && (
        <Modal title={t("co.addPlan")} onClose={() => setAdding(false)}>
          <RecordForm fields={planFields} isNew initial={{ kind: "service", start_on: isoToday(), equipment: equipment?.[0]?.id }} onSubmit={addPlan} onCancel={() => setAdding(false)} />
        </Modal>
      )}
    </>
  );
}

function DoneDialog({ plan, onClose, onSaved }: { plan: MaintenancePlan; onClose: () => void; onSaved: () => void }) {
  const { t, lang } = useI18n();
  const [v, setV] = useState({ done_on: isoToday(), performed_by: plan.vendor, cost: "", notes: "" });
  const [error, setError] = useState("");
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await post(`/api/compliance/plans/${plan.id}/done/`, v);
      onSaved();
    } catch (err) {
      setError(errorText(err));
    }
  };
  return (
    <Modal title={`${t("co.markDone")}: ${lang === "ar" ? plan.title_ar : plan.title_en}`} onClose={onClose}>
      <form className="form-grid" onSubmit={submit}>
        <p className="muted small">{nm(plan.equipment_info, lang)}</p>
        <div className="form-grid form-grid-2">
          <div className="field"><label htmlFor="dn-date">{t("co.date")}</label><input id="dn-date" type="date" value={v.done_on} max={isoToday()} onChange={(e) => setV((s) => ({ ...s, done_on: e.target.value }))} /></div>
          <div className="field"><label htmlFor="dn-cost">{t("co.cost")}</label><input id="dn-cost" type="number" step="0.01" dir="ltr" value={v.cost} onChange={(e) => setV((s) => ({ ...s, cost: e.target.value }))} /></div>
        </div>
        <div className="field"><label htmlFor="dn-by">{t("co.doneBy")}</label><input id="dn-by" value={v.performed_by} onChange={(e) => setV((s) => ({ ...s, performed_by: e.target.value }))} /></div>
        <div className="field"><label htmlFor="dn-notes">{t("notes")}</label><textarea id="dn-notes" rows={2} value={v.notes} onChange={(e) => setV((s) => ({ ...s, notes: e.target.value }))} /></div>
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="form-actions">
          <button type="button" className="btn" onClick={onClose}>{t("cancel")}</button>
          <button className="btn btn-primary">{t("save")}</button>
        </div>
      </form>
    </Modal>
  );
}

const PRIORITY_PILL: Record<string, string> = { low: "pill pill-muted", normal: "pill pill-outline", high: "pill pill-ready", urgent: "pill pill-warn co-pill-fail" };

function WorkOrders() {
  const { t, lang } = useI18n();
  const { can } = useAuth();
  const currency = useCurrency();
  const [open, setOpen] = useState(true);
  const [page, setPage] = useState<Page<WorkOrder> | null>(null);
  const [viewing, setViewing] = useState<WorkOrder | null>(null);
  const [adding, setAdding] = useState(false);
  const equipment = useEquipment();
  const load = useCallback(() => {
    get<Page<WorkOrder>>(`/api/compliance/work-orders/?${open ? "open=1" : "closed=1"}`).then(setPage).catch(() => setPage(null));
  }, [open]);
  useEffect(load, [load]);
  return (
    <section className="card">
      <header className="card-head">
        <Segmented value={open ? "open" : "closed"} onChange={(v) => setOpen(v === "open")} label={t("lab.show")} options={[
          { id: "open", label: t("co.wo.openList") },
          { id: "closed", label: t("co.wo.closedList") },
        ]} />
        {can("compliance", "create") && <button className="btn btn-primary" onClick={() => setAdding(true)}><Icon name="plus" size={18} /> {t("co.reportFault")}</button>}
      </header>
      {page === null ? <Empty text="loading" /> : page.results.length === 0 ? <Empty text="noRecords" /> : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{t("lab.number")}</th>
                <th>{t("co.equipment")}</th>
                <th>{t("co.problem")}</th>
                <th>{t("co.priority")}</th>
                <th>{t("co.reported")}</th>
                <th className="num">{t("co.downtime")}</th>
                <th className="num">{t("co.costCur", { cur: currency })}</th>
                <th>{t("plan.status")}</th>
              </tr>
            </thead>
            <tbody>
              {page.results.map((w) => (
                <tr key={w.id} className="row-link" onClick={() => setViewing(w)}>
                  <td className="mono small">{w.number}</td>
                  <td>{nm(w.equipment_info, lang)}<span className="muted small block">{nm(w.equipment_info.branch, lang)}</span></td>
                  <td className="co-clip">{w.issue}</td>
                  <td><span className={PRIORITY_PILL[w.priority]}>{t(`co.prio.${w.priority}` as TKey)}</span></td>
                  <td className="nowrap small">{fmtDateTime(w.reported_at, lang)}<span className="muted block">{w.reported_by_name}</span></td>
                  <td className="num">{w.takes_out_of_service ? t("co.hoursN", { n: w.downtime_hours }) : "—"}</td>
                  <td className="num">{money(w.total_cost, lang)}</td>
                  <td><StatePill state={w.status} label={t(`co.wos.${w.status}` as TKey)} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {adding && equipment && <NewWorkOrder equipment={equipment} onClose={() => setAdding(false)} onSaved={(w) => { setAdding(false); load(); setViewing(w); }} />}
      {viewing && <WorkOrderView initial={viewing} onClose={() => setViewing(null)} onChanged={load} />}
    </section>
  );
}

export function NewWorkOrder({ equipment, onClose, onSaved }: { equipment: Equipment[]; onClose: () => void; onSaved: (w: WorkOrder) => void }) {
  const { t, lang } = useI18n();
  const [v, setV] = useState({ equipment: equipment[0]?.id ?? "", issue: "", priority: "normal", takes_out_of_service: false, assigned_to: "" });
  const [error, setError] = useState("");
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      onSaved(await post<WorkOrder>("/api/compliance/work-orders/", v));
    } catch (err) {
      setError(errorText(err));
    }
  };
  return (
    <Modal title={t("co.reportFault")} onClose={onClose}>
      <form className="form-grid" onSubmit={submit}>
        <div className="field">
          <label htmlFor="wo-eq">{t("co.equipment")}</label>
          <select id="wo-eq" value={v.equipment} onChange={(e) => setV((s) => ({ ...s, equipment: Number(e.target.value) }))}>
            {equipment.map((e) => <option key={e.id} value={e.id}>{lang === "ar" ? e.name_ar : e.name_en} ({e.code})</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="wo-issue">{t("co.problem")}</label>
          <textarea id="wo-issue" rows={3} required value={v.issue} onChange={(e) => setV((s) => ({ ...s, issue: e.target.value }))} />
        </div>
        <div className="form-grid form-grid-2">
          <div className="field">
            <label htmlFor="wo-prio">{t("co.priority")}</label>
            <select id="wo-prio" value={v.priority} onChange={(e) => setV((s) => ({ ...s, priority: e.target.value }))}>
              {["low", "normal", "high", "urgent"].map((p) => <option key={p} value={p}>{t(`co.prio.${p}` as TKey)}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="wo-who">{t("co.technician")}</label>
            <input id="wo-who" value={v.assigned_to} onChange={(e) => setV((s) => ({ ...s, assigned_to: e.target.value }))} />
          </div>
        </div>
        <div className="field field-check">
          <input id="wo-down" type="checkbox" checked={v.takes_out_of_service} onChange={(e) => setV((s) => ({ ...s, takes_out_of_service: e.target.checked }))} />
          <label htmlFor="wo-down">{t("co.outOfServiceUntilFixed")}</label>
        </div>
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="form-actions">
          <button type="button" className="btn" onClick={onClose}>{t("cancel")}</button>
          <button className="btn btn-primary">{t("save")}</button>
        </div>
      </form>
    </Modal>
  );
}

function WorkOrderView({ initial, onClose, onChanged }: { initial: WorkOrder; onClose: () => void; onChanged: () => void }) {
  const { t, lang, name } = useI18n();
  const { can } = useAuth();
  const currency = useCurrency();
  const branches = useBranches();
  const [w, setW] = useState(initial);
  const [items, setItems] = useState<{ id: number; name_en: string; name_ar: string; unit_label: string }[]>([]);
  const [part, setPart] = useState({ item: "", quantity: "1", branch: String(initial.equipment_info.branch?.id ?? "") });
  const [closing, setClosing] = useState({ resolution: "", labour_cost: initial.labour_cost });
  const [error, setError] = useState("");
  const isOpen = ["open", "in_progress", "waiting_parts"].includes(w.status);
  const canParts = can("compliance", "edit") && can("inventory");
  useEffect(() => {
    if (canParts && isOpen) getAll<{ id: number; name_en: string; name_ar: string; unit_label: string }>("/api/inventory/items/?active=1").then(setItems).catch(() => setItems([]));
  }, [canParts, isOpen]);
  const run = async (fn: () => Promise<WorkOrder>) => {
    setError("");
    try {
      setW(await fn());
      onChanged();
    } catch (err) {
      setError(errorText(err));
    }
  };
  return (
    <Modal title={`${w.number} · ${nm(w.equipment_info, lang)}`} onClose={onClose}>
      <div className="co-cycle">
        <div className="invoice-head">
          <div>
            <p className="strong">{w.issue}</p>
            <p className="muted small">{fmtDateTime(w.reported_at, lang)} · {w.reported_by_name} · {w.assigned_to || t("co.unassigned")}</p>
          </div>
          <StatePill state={w.status} label={t(`co.wos.${w.status}` as TKey)} />
        </div>
        {w.takes_out_of_service && <p className="notice pad-s">{t("co.downFor", { n: w.downtime_hours })}</p>}
        {isOpen && can("compliance", "edit") && (
          <div className="chip-row">
            {(["open", "in_progress", "waiting_parts"] as const).map((s) => (
              <button key={s} className={`chip ${w.status === s ? "active" : ""}`} onClick={() => void run(() => post<WorkOrder>(`/api/compliance/work-orders/${w.id}/status/`, { status: s }))}>
                {t(`co.wos.${s}` as TKey)}
              </button>
            ))}
          </div>
        )}
        <section className="subsection">
          <h3>{t("co.parts")}</h3>
          {w.parts.length === 0 ? <p className="muted small">{t("co.noParts")}</p> : (
            <ul className="plain-list inst-list">
              {w.parts.map((p) => (
                <li key={p.id}>
                  <span className="grow">{nm(p.item_name, lang)}</span>
                  <span className="num">{Number(p.quantity)}</span>
                  <span className="num">{money(p.cost, lang)} {currency}</span>
                </li>
              ))}
            </ul>
          )}
          {isOpen && canParts && (
            <div className="toolbar co-part-row">
              <select aria-label={t("co.part")} value={part.item} onChange={(e) => setPart((s) => ({ ...s, item: e.target.value }))}>
                <option value="">{t("co.choosePart")}</option>
                {items.map((i) => <option key={i.id} value={i.id}>{lang === "ar" ? i.name_ar : i.name_en}</option>)}
              </select>
              <select aria-label={t("co.branch")} value={part.branch} onChange={(e) => setPart((s) => ({ ...s, branch: e.target.value }))}>
                {branches.map((b) => <option key={b.id} value={b.id}>{name(b)}</option>)}
              </select>
              <input aria-label={t("bill.qty")} type="number" min="0.001" step="any" dir="ltr" className="co-qty" value={part.quantity} onChange={(e) => setPart((s) => ({ ...s, quantity: e.target.value }))} />
              <button className="btn btn-small" disabled={!part.item} onClick={() => void run(() => post<WorkOrder>(`/api/compliance/work-orders/${w.id}/parts/`, part))}>{t("co.takeFromStock")}</button>
            </div>
          )}
        </section>
        <dl className="co-facts">
          <div><dt>{t("co.labour")}</dt><dd>{money(w.labour_cost, lang)} {currency}</dd></div>
          <div><dt>{t("co.parts")}</dt><dd>{money(w.parts_cost, lang)} {currency}</dd></div>
          <div><dt>{t("bill.total")}</dt><dd className="strong">{money(w.total_cost, lang)} {currency}</dd></div>
          {w.completed_at && <div><dt>{t("co.finished")}</dt><dd>{fmtDateTime(w.completed_at, lang)}</dd></div>}
        </dl>
        {w.resolution && <p className="notice pad-s">{w.resolution}</p>}
        {isOpen && can("compliance", "edit") && (
          <section className="subsection">
            <h3>{t("co.closeOrder")}</h3>
            <div className="form-grid">
              <div className="field"><label htmlFor="wo-res">{t("co.whatWasDone")}</label><textarea id="wo-res" rows={2} value={closing.resolution} onChange={(e) => setClosing((s) => ({ ...s, resolution: e.target.value }))} /></div>
              <div className="field"><label htmlFor="wo-lab">{t("co.labour")}</label><input id="wo-lab" type="number" step="0.01" dir="ltr" value={closing.labour_cost} onChange={(e) => setClosing((s) => ({ ...s, labour_cost: e.target.value }))} /></div>
              <div className="form-actions">
                <button className="btn" onClick={() => void run(() => post<WorkOrder>(`/api/compliance/work-orders/${w.id}/close/`, { ...closing, status: "cancelled" }))}>{t("co.cancelOrder")}</button>
                <button className="btn btn-primary" onClick={() => void run(() => post<WorkOrder>(`/api/compliance/work-orders/${w.id}/close/`, { ...closing, status: "done" }))}>{t("co.markFixed")}</button>
              </div>
            </div>
          </section>
        )}
        {error && <p className="form-error" role="alert">{error}</p>}
      </div>
    </Modal>
  );
}

const LICENCE_KINDS = ["xray_licence", "dosimeter", "radiation_officer", "pressure_vessel", "clinic_licence", "medical_waste", "fire_safety", "other"];

export function Licences() {
  const { t, lang, name } = useI18n();
  const { can } = useAuth();
  const branches = useBranches();
  const equipment = useEquipment();
  const [staff, setStaff] = useState<{ id: number; name_en: string; name_ar: string }[]>([]);
  const [rows, setRows] = useState<Licence[] | null>(null);
  const [editing, setEditing] = useState<{ row: Licence | null } | null>(null);
  const [renewing, setRenewing] = useState<Licence | null>(null);
  const load = useCallback(() => {
    get<Licence[]>("/api/compliance/licences/").then(setRows).catch(() => setRows([]));
  }, []);
  useEffect(load, [load]);
  useEffect(() => {
    getAll<{ id: number; name_en: string; name_ar: string }>("/api/masterdata/staff/?is_active=true").then(setStaff).catch(() => setStaff([]));
  }, []);
  const fields: FieldDef[] = [
    { name: "kind", label: "co.kindLabel", type: "select", required: true, options: LICENCE_KINDS.map((k) => ({ value: k, label: t(`co.lic.${k}` as TKey) })) },
    { name: "title_en", label: "co.titleEn", required: true, dir: "ltr" },
    { name: "title_ar", label: "co.titleAr", required: true, dir: "rtl" },
    { name: "reference", label: "co.refNo", dir: "ltr" },
    { name: "authority", label: "co.authority" },
    { name: "issued_on", label: "co.issuedOn", type: "date" },
    { name: "expires_on", label: "co.expiresOn", type: "date", required: true },
    { name: "branch", label: "co.branch", type: "select", options: branches.map((b) => ({ value: b.id, label: name(b) })) },
    { name: "equipment", label: "co.equipment", type: "select", options: (equipment ?? []).map((e) => ({ value: e.id, label: lang === "ar" ? e.name_ar : e.name_en })) },
    { name: "staff", label: "co.person", type: "select", options: staff.map((s) => ({ value: s.id, label: name(s) })) },
    { name: "last_reading_msv", label: "co.reading", type: "number", step: "0.001", dir: "ltr" },
    { name: "notes", label: "notes", type: "textarea" },
  ];
  const save = async (values: Record<string, unknown>) => {
    const body = { ...values };
    for (const k of ["branch", "equipment", "staff", "issued_on", "last_reading_msv"]) if (body[k] === "" || body[k] === undefined) body[k] = null;
    if (editing?.row) await patch(`/api/compliance/licences/${editing.row.id}/`, body);
    else await post("/api/compliance/licences/", body);
    setEditing(null);
    load();
  };
  return (
    <section className="card">
      <header className="card-head">
        <h2>{t("co.licencesTitle")}</h2>
        {can("compliance", "edit") && <button className="btn btn-primary" onClick={() => setEditing({ row: null })}><Icon name="plus" size={18} /> {t("add")}</button>}
      </header>
      {rows === null ? <Empty text="loading" /> : rows.length === 0 ? <Empty text="noRecords" /> : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{t("co.licence")}</th>
                <th>{t("co.for")}</th>
                <th>{t("co.refNo")}</th>
                <th>{t("co.expiresOn")}</th>
                <th>{t("plan.status")}</th>
                {can("compliance", "edit") && <th className="cell-actions">{t("actions")}</th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((l) => (
                <tr key={l.id}>
                  <td>{lang === "ar" ? l.title_ar : l.title_en}<span className="muted small block">{t(`co.lic.${l.kind}` as TKey)} · {l.authority}</span></td>
                  <td className="small">{[nm(l.equipment_name, lang), nm(l.staff_name, lang), nm(l.branch_name, lang)].filter(Boolean).join(" · ") || "—"}{l.last_reading_msv !== null && <span className="muted block">{t("co.readingN", { n: Number(l.last_reading_msv) })}</span>}</td>
                  <td className="mono small" dir="ltr">{l.reference || "—"}</td>
                  <td className="nowrap">{fmtDate(l.expires_on, lang)}<span className="muted small block">{l.days_left >= 0 ? t("co.daysLeft", { n: l.days_left }) : t("co.daysAgo", { n: -l.days_left })}</span></td>
                  <td><StatePill state={l.state} label={t(`co.lstate.${l.state}` as TKey)} /></td>
                  {can("compliance", "edit") && (
                    <td className="cell-actions">
                      {l.state !== "ok" && <button className="btn btn-small btn-primary" onClick={() => setRenewing(l)}>{t("co.renew")}</button>}
                      <button className="btn btn-small" onClick={() => setEditing({ row: l })}>{t("edit")}</button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing && (
        <Modal title={editing.row ? t("edit") : t("co.addLicence")} onClose={() => setEditing(null)}>
          <RecordForm fields={fields} isNew={!editing.row} initial={editing.row ? { ...editing.row } : { kind: "xray_licence" }} onSubmit={save} onCancel={() => setEditing(null)} />
        </Modal>
      )}
      {renewing && <RenewDialog licence={renewing} onClose={() => setRenewing(null)} onSaved={() => { setRenewing(null); load(); }} />}
    </section>
  );
}

function RenewDialog({ licence, onClose, onSaved }: { licence: Licence; onClose: () => void; onSaved: () => void }) {
  const { t, lang } = useI18n();
  const [v, setV] = useState({ issued_on: isoToday(), expires_on: "", reference: licence.reference, last_reading_msv: "" });
  const [error, setError] = useState("");
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await post(`/api/compliance/licences/${licence.id}/renew/`, v);
      onSaved();
    } catch (err) {
      setError(errorText(err));
    }
  };
  return (
    <Modal title={`${t("co.renew")}: ${lang === "ar" ? licence.title_ar : licence.title_en}`} onClose={onClose}>
      <form className="form-grid" onSubmit={submit}>
        <div className="form-grid form-grid-2">
          <div className="field"><label htmlFor="rn-i">{t("co.issuedOn")}</label><input id="rn-i" type="date" value={v.issued_on} onChange={(e) => setV((s) => ({ ...s, issued_on: e.target.value }))} /></div>
          <div className="field"><label htmlFor="rn-e">{t("co.expiresOn")}</label><input id="rn-e" type="date" required value={v.expires_on} onChange={(e) => setV((s) => ({ ...s, expires_on: e.target.value }))} /></div>
        </div>
        <div className="field"><label htmlFor="rn-r">{t("co.refNo")}</label><input id="rn-r" dir="ltr" value={v.reference} onChange={(e) => setV((s) => ({ ...s, reference: e.target.value }))} /></div>
        {licence.kind === "dosimeter" && <div className="field"><label htmlFor="rn-m">{t("co.reading")}</label><input id="rn-m" type="number" step="0.001" dir="ltr" value={v.last_reading_msv} onChange={(e) => setV((s) => ({ ...s, last_reading_msv: e.target.value }))} /></div>}
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="form-actions">
          <button type="button" className="btn" onClick={onClose}>{t("cancel")}</button>
          <button className="btn btn-primary">{t("save")}</button>
        </div>
      </form>
    </Modal>
  );
}
