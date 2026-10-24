import { useCallback, useEffect, useState, type CSSProperties, type DragEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { get, getAll, patch, post } from "../api";
import { useAuth } from "../auth";
import { useI18n, type TKey } from "../i18n";
import { BarList, KpiTile } from "../components/Charts";
import { Modal } from "../components/Crud";
import { Icon } from "../components/Icon";
import { fmtDate, money } from "../format";
import type { Patient, Procedure } from "../types";
import { AppointmentDialog } from "./Appointments";
import { errorText, personName, useCurrency } from "./BillingParts";
import { Campaigns } from "./Campaigns";
import {
  ContactDialog,
  LeadForm,
  LeadView,
  LostDialog,
  OPEN_STAGES,
  SOURCES,
  STAGES,
  Stars,
  addDays,
  initials,
  interestLabel,
  leadName,
  stagePill,
  today,
  waLink,
  type Lead,
  type LeadStage,
} from "./CrmParts";

type Tab = "board" | "list" | "recalls" | "campaigns" | "feedback";
type Filter = "all" | "mine" | "due";

interface Summary {
  open_leads: number;
  new_leads_week: number;
  pipeline_value: string;
  follow_ups_due: number;
  recall_callbacks: number;
  badge: number;
  recalls_overdue: number;
  recalls_due: number;
  won_month: number;
  campaigns_month: number;
  nps: number | null;
  feedback_count: number;
  feedback_average: number | null;
}

/** Leads and recalls: the enquiry pipeline, the recall queue, campaigns and visit feedback. */
export function Crm() {
  const { t, lang } = useI18n();
  const { can } = useAuth();
  const currency = useCurrency();
  const [params, setParams] = useSearchParams();
  const tab = (params.get("tab") as Tab) || "board";
  const [summary, setSummary] = useState<Summary | null>(null);
  const [version, setVersion] = useState(0);
  const [adding, setAdding] = useState(false);
  const [viewing, setViewing] = useState<Lead | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [recallStatus, setRecallStatus] = useState("");
  useEffect(() => {
    get<Summary>("/api/crm/summary/").then(setSummary).catch(() => undefined);
  }, [version]);
  const go = (next: Tab, f?: Filter) => {
    if (f) setFilter(f);
    setParams({ tab: next }, { replace: true });
  };
  const tabs: { id: Tab; label: TKey }[] = [
    { id: "board", label: "crm.tab.board" },
    { id: "list", label: "crm.tab.list" },
    { id: "recalls", label: "crm.tab.recalls" },
    { id: "campaigns", label: "crm.tab.campaigns" },
    { id: "feedback", label: "crm.tab.feedback" },
  ];
  const stats: { label: TKey; n?: number | string; onClick: () => void; tone?: string }[] = [
    { label: "crm.hero.open", n: summary?.open_leads, onClick: () => go("board", "all") },
    { label: "crm.hero.followUps", n: summary?.follow_ups_due, onClick: () => go("board", "due"), tone: summary?.follow_ups_due ? "accent" : "" },
    { label: "crm.hero.newWeek", n: summary?.new_leads_week, onClick: () => go("list") },
    { label: "crm.hero.recalls", n: summary?.recalls_overdue, onClick: () => { setRecallStatus("overdue"); go("recalls"); }, tone: summary?.recalls_overdue ? "warn" : "" },
    { label: "crm.hero.campaigns", n: summary?.campaigns_month, onClick: () => go("campaigns") },
    { label: "crm.hero.nps", n: summary ? (summary.nps === null ? "—" : summary.nps) : undefined, onClick: () => go("feedback") },
  ];
  const changed = () => setVersion((v) => v + 1);
  return (
    <div className="page crm-page">
      <section className="lab-hero">
        <div>
          <h1>{t("crm.title")}</h1>
          <p>{summary ? t("crm.heroSub", { value: money(summary.pipeline_value, lang), cur: currency, won: summary.won_month }) : t("crm.heroSubLoading")}</p>
        </div>
        <div className="lab-hero-stats">
          {stats.map((x) => (
            <button key={x.label} className={`lab-hero-stat ${x.tone ?? ""}`} onClick={x.onClick}>
              <strong>{x.n ?? "…"}</strong>
              <span>{t(x.label)}</span>
            </button>
          ))}
        </div>
        {can("crm", "create") && (
          <button className="btn btn-accent" onClick={() => setAdding(true)}>
            <Icon name="plus" size={18} /> {t("crm.newLead")}
          </button>
        )}
      </section>
      <div className="segmented tabs" role="tablist">
        {tabs.map((x) => (
          <button key={x.id} role="tab" aria-selected={tab === x.id} className={tab === x.id ? "active" : ""} onClick={() => setParams({ tab: x.id }, { replace: true })}>
            {t(x.label)}
            {x.id === "recalls" && summary ? <span className="tab-count">{summary.recalls_overdue + summary.recalls_due}</span> : null}
          </button>
        ))}
      </div>
      {tab === "board" && <Board key={`b${version}`} filter={filter} setFilter={setFilter} onOpen={setViewing} onChanged={changed} />}
      {tab === "list" && <LeadList key={`l${version}`} onOpen={setViewing} />}
      {tab === "recalls" && <Recalls status={recallStatus} setStatus={setRecallStatus} onChanged={changed} />}
      {tab === "campaigns" && <Campaigns />}
      {tab === "feedback" && <Feedback />}
      {adding && <LeadForm onClose={() => setAdding(false)} onSaved={(l) => { setAdding(false); changed(); setViewing(l); }} />}
      {viewing && <LeadView initial={viewing} onClose={() => setViewing(null)} onChanged={changed} />}
    </div>
  );
}

/* ------------------------------------------------------------------ board */

function Board({ filter, setFilter, onOpen, onChanged }: { filter: Filter; setFilter: (f: Filter) => void; onOpen: (l: Lead) => void; onChanged: () => void }) {
  const { t, lang } = useI18n();
  const { can } = useAuth();
  const currency = useCurrency();
  const [leads, setLeads] = useState<Lead[] | null>(null);
  const [search, setSearch] = useState("");
  const [source, setSource] = useState("");
  const [dragging, setDragging] = useState<number | null>(null);
  const [over, setOver] = useState<LeadStage | null>(null);
  const [losing, setLosing] = useState<Lead | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(() => {
    const q = new URLSearchParams({ board: "1" });
    if (filter === "mine") q.set("assigned_to", "me");
    if (filter === "due") q.set("follow_up", "due");
    if (source) q.set("source", source);
    if (search.trim()) q.set("search", search.trim());
    get<Lead[]>(`/api/crm/leads/?${q}`).then(setLeads).catch(() => setLeads([]));
  }, [filter, search, source]);
  useEffect(() => {
    const timer = window.setTimeout(load, search ? 250 : 0);
    return () => window.clearTimeout(timer);
  }, [load, search]);
  const move = async (lead: Lead, stage: LeadStage, lost_reason = "", note = "") => {
    if (stage === lead.stage) return;
    if (stage === "lost" && !lost_reason) return setLosing(lead);
    setError("");
    setLeads((rows) => rows?.map((r) => (r.id === lead.id ? { ...r, stage } : r)) ?? rows);
    try {
      await post(`/api/crm/leads/${lead.id}/stage/`, { stage, lost_reason, note });
    } catch (err) {
      setError(errorText(err));
    }
    load();
    onChanged();
  };
  const editable = can("crm", "edit");
  const onDrop = (stage: LeadStage) => (e: DragEvent) => {
    e.preventDefault();
    const lead = leads?.find((x) => x.id === dragging);
    setOver(null);
    setDragging(null);
    if (lead) void move(lead, stage);
  };
  const filters: { id: Filter; label: TKey }[] = [
    { id: "all", label: "crm.filter.all" },
    { id: "mine", label: "crm.filter.mine" },
    { id: "due", label: "crm.filter.due" },
  ];
  return (
    <>
      <section className="card pad toolbar lab-bar">
        <div className="chip-row" role="group" aria-label={t("lab.show")}>
          {filters.map((f) => (
            <button key={f.id} className={`chip ${filter === f.id ? "active" : ""}`} aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>
              {t(f.label)}
            </button>
          ))}
          <select className="chip-select" aria-label={t("crm.source")} value={source} onChange={(e) => setSource(e.target.value)}>
            <option value="">{t("crm.allSources")}</option>
            {SOURCES.map((s) => <option key={s} value={s}>{t(`crm.src.${s}` as TKey)}</option>)}
          </select>
        </div>
        <label className="top-search search-field">
          <Icon name="search" />
          <input type="search" aria-label={t("search")} placeholder={t("crm.searchHint")} value={search} onChange={(e) => setSearch(e.target.value)} />
        </label>
      </section>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="lab-board crm-board">
        {STAGES.map((stage, col) => {
          const rows = (leads ?? []).filter((l) => l.stage === stage);
          const total = rows.reduce((s, l) => s + Number(l.estimated_value), 0);
          return (
            <section
              key={stage}
              className={`lab-col crm-col ${over === stage ? "drop" : ""}`}
              data-stage={stage}
              style={{ "--i": col } as CSSProperties}
              aria-label={t(`crm.stage.${stage}` as TKey)}
              onDragOver={(e) => {
                if (dragging === null) return;
                e.preventDefault();
                setOver(stage);
              }}
              onDragLeave={() => setOver((s) => (s === stage ? null : s))}
              onDrop={onDrop(stage)}
            >
              <header className="lab-col-head">
                <span className={`stage-dot ${stage === "won" ? "stage-ready" : stage === "lost" ? "" : "stage-now"}`} aria-hidden="true" />
                <h2>{t(`crm.stage.${stage}` as TKey)}</h2>
                <span className="lab-col-count">{leads === null ? "…" : rows.length}</span>
              </header>
              {rows.length > 0 && <p className="crm-col-sum muted small">{money(total, lang)} {currency}</p>}
              <div className="lab-col-body">
                {rows.length === 0 && leads !== null && <p className="muted small lab-empty">{t("crm.emptyCol")}</p>}
                {rows.map((l) => {
                  const at = OPEN_STAGES.indexOf(l.stage);
                  const next: LeadStage | undefined = at < 0 ? undefined : OPEN_STAGES[at + 1] ?? "won";
                  return (
                    <article
                      key={l.id}
                      className={`lab-card crm-card-lead ${l.follow_up_due ? "is-overdue" : ""} ${dragging === l.id ? "is-dragging" : ""}`}
                      draggable={editable}
                      onDragStart={(e) => {
                        setDragging(l.id);
                        e.dataTransfer.effectAllowed = "move";
                      }}
                      onDragEnd={() => {
                        setDragging(null);
                        setOver(null);
                      }}
                    >
                      <button className="lab-card-main" onClick={() => onOpen(l)}>
                        <span className="lab-card-top">
                          <span className={`src-chip src-${l.source}`}>{t(`crm.src.${l.source}` as TKey)}</span>
                          {l.patient_info && <span className="pan-chip">{l.patient_info.file_number}</span>}
                        </span>
                        <span className="strong block">{leadName(l, lang)}</span>
                        <span className="small block muted">{interestLabel(l, lang) || "—"}</span>
                        <span className="lab-card-meta small">
                          <span className="strong">{money(l.estimated_value, lang)} {currency}</span>
                          {l.next_follow_up && l.stage !== "won" && l.stage !== "lost" && (
                            <span className={`due due-in ${l.follow_up_due ? "late" : ""}`} title={t("crm.followUp")}>
                              <Icon name="clock" size={14} /> {l.next_follow_up === today() ? t("lab.due.today") : fmtDate(l.next_follow_up, lang)}
                            </span>
                          )}
                          {l.stage === "lost" && l.lost_reason && <span className="muted">{t(`crm.lost.${l.lost_reason}` as TKey)}</span>}
                          <span className="tech" title={l.assigned_info ? personName(l.assigned_info, lang) : ""}>
                            {l.assigned_info ? <span className="tech-avatar">{initials(personName(l.assigned_info, "en").replace(/^Dr\.?\s*/, ""))}</span> : null}
                          </span>
                        </span>
                      </button>
                      {editable && next && (
                        <button className="lab-next" onClick={() => void move(l, next)} title={t("lab.moveTo", { stage: t(`crm.stage.${next}` as TKey) })}>
                          {t(`crm.stage.${next}` as TKey)}
                          <Icon name="arrow" size={16} className="flip-rtl" />
                        </button>
                      )}
                    </article>
                  );
                })}
              </div>
            </section>
          );
        })}
      </div>
      {losing && <LostDialog onClose={() => setLosing(null)} onPick={(reason, note) => { const l = losing; setLosing(null); void move(l, "lost", reason, note); }} />}
    </>
  );
}

/* ------------------------------------------------------------------- list */

function LeadList({ onOpen }: { onOpen: (l: Lead) => void }) {
  const { t, lang } = useI18n();
  const currency = useCurrency();
  const [rows, setRows] = useState<Lead[] | null>(null);
  const [stage, setStage] = useState("");
  const [search, setSearch] = useState("");
  useEffect(() => {
    const q = new URLSearchParams();
    if (stage) q.set("stage", stage);
    if (search.trim()) q.set("search", search.trim());
    const timer = window.setTimeout(() => get<Lead[]>(`/api/crm/leads/?${q}`).then(setRows).catch(() => setRows([])), search ? 250 : 0);
    return () => window.clearTimeout(timer);
  }, [stage, search]);
  return (
    <section className="card">
      <header className="card-head toolbar">
        <div className="chip-row">
          <button className={`chip ${stage === "" ? "active" : ""}`} onClick={() => setStage("")}>{t("crm.filter.all")}</button>
          {STAGES.map((s) => (
            <button key={s} className={`chip ${stage === s ? "active" : ""}`} onClick={() => setStage(s)}>{t(`crm.stage.${s}` as TKey)}</button>
          ))}
        </div>
        <label className="top-search search-field">
          <Icon name="search" />
          <input type="search" aria-label={t("search")} placeholder={t("crm.searchHint")} value={search} onChange={(e) => setSearch(e.target.value)} />
        </label>
      </header>
      {rows === null ? (
        <p className="muted pad">{t("loading")}</p>
      ) : rows.length === 0 ? (
        <p className="muted pad">{t("noRecords")}</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{t("crm.lead")}</th>
                <th>{t("crm.source")}</th>
                <th>{t("crm.interest")}</th>
                <th className="num">{t("crm.value")}</th>
                <th>{t("crm.stage")}</th>
                <th>{t("crm.followUp")}</th>
                <th>{t("crm.assigned")}</th>
                <th>{t("crm.created")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((l) => (
                <tr key={l.id} className="row-link" onClick={() => onOpen(l)}>
                  <td>
                    <strong>{leadName(l, lang)}</strong>
                    <span className="muted small block"><bdi dir="ltr">{l.phone}</bdi></span>
                  </td>
                  <td>{t(`crm.src.${l.source}` as TKey)}</td>
                  <td>{interestLabel(l, lang) || "—"}</td>
                  <td className="num nowrap">{money(l.estimated_value, lang)} {currency}</td>
                  <td><span className={stagePill(l.stage)}>{t(`crm.stage.${l.stage}` as TKey)}</span></td>
                  <td className={`nowrap ${l.follow_up_due ? "owed" : ""}`}>{l.next_follow_up ? fmtDate(l.next_follow_up, lang) : "—"}</td>
                  <td>{l.assigned_info ? personName(l.assigned_info, lang) : "—"}</td>
                  <td className="nowrap">{fmtDate(l.created_at, lang)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/* ---------------------------------------------------------------- recalls */

interface RecallRow {
  key: string;
  patient: { id: number; file_number: string; ar: string; en: string; phone: string; whatsapp: boolean; language: string };
  rule: { id: number; ar: string; en: string; months: number };
  due_date: string;
  status: "overdue" | "due";
  days_overdue: number;
  last_visit: string | null;
  attempts: number;
  hidden: string | null;
  last_contact: { outcome: string; channel: string; note: string; at: string; snooze_until: string | null; by: string } | null;
}
interface Rule {
  id: number;
  name_en: string;
  name_ar: string;
  kind: "checkup" | "after_procedure";
  procedures: number[];
  procedure_info: { id: number; code: string; ar: string; en: string }[];
  interval_months: number;
  is_active: boolean;
}

function Recalls({ status, setStatus, onChanged }: { status: string; setStatus: (s: string) => void; onChanged: () => void }) {
  const { t, lang, name } = useI18n();
  const { can, me } = useAuth();
  const [data, setData] = useState<{ count: number; overdue: number; due: number; results: RecallRow[] } | null>(null);
  const [rules, setRules] = useState<Rule[]>([]);
  const [rule, setRule] = useState("");
  const [search, setSearch] = useState("");
  const [hidden, setHidden] = useState(false);
  const [logging, setLogging] = useState<RecallRow | null>(null);
  const [booking, setBooking] = useState<{ row: RecallRow; patient: Patient } | null>(null);
  const [editingRules, setEditingRules] = useState(false);
  const [error, setError] = useState("");
  const load = useCallback(() => {
    const q = new URLSearchParams();
    if (status) q.set("status", status);
    if (rule) q.set("rule", rule);
    if (hidden) q.set("hidden", "1");
    if (search.trim()) q.set("search", search.trim());
    get<{ count: number; overdue: number; due: number; results: RecallRow[] }>(`/api/crm/recalls/?${q}`).then(setData).catch(() => setData(null));
  }, [status, rule, hidden, search]);
  useEffect(() => {
    const timer = window.setTimeout(load, search ? 250 : 0);
    return () => window.clearTimeout(timer);
  }, [load, search]);
  useEffect(() => {
    get<Rule[]>("/api/crm/recall-rules/").then(setRules).catch(() => setRules([]));
  }, [editingRules]);
  const clinic = me?.clinic;
  const message = (r: RecallRow) => {
    const ar = r.patient.language !== "en";
    const who = ar ? r.patient.ar || r.patient.en : r.patient.en || r.patient.ar;
    const first = who.split(/\s+/)[0];
    const clinicName = (ar ? clinic?.name_ar : clinic?.name_en) ?? "";
    const what = ar ? r.rule.ar : r.rule.en;
    return ar
      ? `مرحبًا ${first}، حان موعد ${what} في ${clinicName}. ردّ على هذه الرسالة لنحجز لك موعدًا مناسبًا.`
      : `Hello ${first}, it's time for your ${what.toLowerCase()} at ${clinicName}. Reply to this message and we'll book a time that suits you.`;
  };
  const log = async (r: RecallRow, body: { outcome: string; note?: string; snooze_until?: string | null; channel: string }) => {
    await post("/api/crm/recall-contacts/", { patient: r.patient.id, rule: r.rule.id, due_date: r.due_date, note: "", ...body });
    load();
    onChanged();
  };
  const book = async (r: RecallRow) => {
    setError("");
    try {
      setBooking({ row: r, patient: await get<Patient>(`/api/patients/${r.patient.id}/`) });
    } catch (err) {
      setError(errorText(err));
    }
  };
  const statuses: { id: string; label: TKey; n?: number }[] = [
    { id: "", label: "crm.filter.all", n: data && !status ? data.count : undefined },
    { id: "overdue", label: "crm.rec.overdue" },
    { id: "due", label: "crm.rec.dueSoon" },
  ];
  return (
    <>
      <section className="card pad toolbar lab-bar">
        <div className="chip-row">
          {statuses.map((s) => (
            <button key={s.id} className={`chip ${status === s.id ? "active" : ""}`} aria-pressed={status === s.id} onClick={() => setStatus(s.id)}>
              {t(s.label)}
              {s.n !== undefined && <span className="chip-count">{s.n}</span>}
            </button>
          ))}
          <select className="chip-select" aria-label={t("crm.rule")} value={rule} onChange={(e) => setRule(e.target.value)}>
            <option value="">{t("crm.allRules")}</option>
            {rules.filter((r) => r.is_active).map((r) => <option key={r.id} value={r.id}>{name(r)}</option>)}
          </select>
          <label className="check-inline small">
            <input type="checkbox" checked={hidden} onChange={(e) => setHidden(e.target.checked)} /> {t("crm.showHidden")}
          </label>
        </div>
        <label className="top-search search-field">
          <Icon name="search" />
          <input type="search" aria-label={t("search")} placeholder={t("pt.searchHint")} value={search} onChange={(e) => setSearch(e.target.value)} />
        </label>
        {can("crm", "edit") && <button className="btn" onClick={() => setEditingRules(true)}><Icon name="list" size={18} /> {t("crm.rules")}</button>}
      </section>
      {error && <p className="form-error" role="alert">{error}</p>}
      <section className="card">
        {data === null ? (
          <p className="muted pad">{t("loading")}</p>
        ) : data.results.length === 0 ? (
          <p className="muted pad">{t("crm.recallsEmpty")}</p>
        ) : (
          <ul className="plain-list recall-queue">
            {data.results.map((r, i) => (
              <li key={r.key} style={{ "--i": i } as CSSProperties} className={r.hidden ? "is-hidden" : ""}>
                <Link to={`/patients/${r.patient.id}`} className="recall-person">
                  <span className="recall-avatar">{initials(personName(r.patient, lang))}</span>
                  <span className="grow">
                    <strong className="block">{personName(r.patient, lang)} <span className="mono small muted">{r.patient.file_number}</span></strong>
                    <span className="small muted block">
                      {personName(r.rule, lang)} · {r.last_visit ? t("dash.lastVisit", { date: fmtDate(r.last_visit, lang) }) : ""}
                    </span>
                  </span>
                </Link>
                <span className="recall-due">
                  <span className={r.status === "overdue" ? "pill pill-warn" : "pill pill-outline"}>
                    {r.status === "overdue" ? t("crm.overdueDays", { n: r.days_overdue }) : t("crm.dueOn", { date: fmtDate(r.due_date, lang) })}
                  </span>
                  {r.last_contact ? (
                    <span className="small muted block">
                      {t(`crm.out.${r.last_contact.outcome}` as TKey)} · {t("crm.attempts", { n: r.attempts })}
                      {r.last_contact.snooze_until ? ` · ${t("crm.until", { date: fmtDate(r.last_contact.snooze_until, lang) })}` : ""}
                    </span>
                  ) : (
                    <span className="small muted block">{t("crm.notContacted")}</span>
                  )}
                </span>
                <span className="recall-actions">
                  {r.patient.whatsapp ? (
                    <a className="btn btn-small wa-btn" href={waLink(r.patient.phone, message(r))} target="_blank" rel="noreferrer"
                      onClick={() => can("crm", "create") && void log(r, { outcome: "messaged", channel: "whatsapp", note: t("crm.waSent") })}>
                      WhatsApp
                    </a>
                  ) : (
                    <span className="muted small">{t("dash.noWhatsapp")}</span>
                  )}
                  <a className="btn btn-small btn-icon" href={`tel:${r.patient.phone}`} aria-label={t("crm.call")} title={t("crm.call")}><Icon name="phone" size={16} /></a>
                  {can("crm", "create") && <button className="btn btn-small" onClick={() => setLogging(r)}>{t("crm.logCall")}</button>}
                  {can("appointments", "create") && <button className="btn btn-small btn-primary" onClick={() => void book(r)}>{t("ap.book")}</button>}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
      {logging && (
        <ContactDialog
          title={`${t("crm.logCall")}: ${personName(logging.patient, lang)}`}
          onClose={() => setLogging(null)}
          onSave={async (body) => {
            await log(logging, body);
            setLogging(null);
          }}
        />
      )}
      {booking && (
        <AppointmentDialog
          initial={{ patient: booking.patient, reason: lang === "ar" ? booking.row.rule.ar : booking.row.rule.en }}
          onClose={() => setBooking(null)}
          onSaved={() => {
            const row = booking.row;
            setBooking(null);
            void log(row, { outcome: "booked", channel: "call" });
          }}
        />
      )}
      {editingRules && <RulesDialog rules={rules} onClose={() => setEditingRules(false)} onChanged={() => { load(); get<Rule[]>("/api/crm/recall-rules/").then(setRules); }} />}
    </>
  );
}

function RulesDialog({ rules, onClose, onChanged }: { rules: Rule[]; onClose: () => void; onChanged: () => void }) {
  const { t, lang, name } = useI18n();
  const [procedures, setProcedures] = useState<Procedure[]>([]);
  const [editing, setEditing] = useState<Partial<Rule> | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    getAll<Procedure>("/api/masterdata/procedures/?is_active=true").then(setProcedures).catch(() => setProcedures([]));
  }, []);
  const save = async () => {
    if (!editing) return;
    setError("");
    try {
      const body = { name_en: editing.name_en, name_ar: editing.name_ar, kind: editing.kind, interval_months: editing.interval_months, procedures: editing.procedures ?? [], is_active: editing.is_active ?? true };
      if (editing.id) await patch(`/api/crm/recall-rules/${editing.id}/`, body);
      else await post("/api/crm/recall-rules/", body);
      setEditing(null);
      onChanged();
    } catch (err) {
      setError(errorText(err));
    }
  };
  const toggle = async (r: Rule) => {
    await patch(`/api/crm/recall-rules/${r.id}/`, { is_active: !r.is_active });
    onChanged();
  };
  return (
    <Modal title={t("crm.rules")} onClose={onClose}>
      <p className="muted small">{t("crm.rulesHint")}</p>
      <ul className="plain-list rule-list">
        {rules.map((r) => (
          <li key={r.id} className={r.is_active ? "" : "muted"}>
            <span className="grow">
              <strong className="block">{name(r)}</strong>
              <span className="small muted">
                {t("crm.everyMonths", { n: r.interval_months })} · {r.kind === "checkup" ? t("crm.afterAnyVisit") : r.procedure_info.map((p) => `${p.code} ${personName(p, lang)}`).join(", ")}
              </span>
            </span>
            <button className="btn btn-small" onClick={() => setEditing(r)}>{t("edit")}</button>
            <button className="btn btn-small" onClick={() => void toggle(r)}>{r.is_active ? t("crm.switchOff") : t("crm.switchOn")}</button>
          </li>
        ))}
      </ul>
      {!editing && <div><button className="btn" onClick={() => setEditing({ kind: "after_procedure", interval_months: 3, procedures: [], name_en: "", name_ar: "" })}><Icon name="plus" size={18} /> {t("crm.addRule")}</button></div>}
      {editing && (
        <div className="subform form-grid">
          <div className="form-grid form-grid-2">
            <label className="field"><span className="field-label">{t("nameEn")}</span><input dir="ltr" value={editing.name_en ?? ""} onChange={(e) => setEditing({ ...editing, name_en: e.target.value })} /></label>
            <label className="field"><span className="field-label">{t("nameAr")}</span><input dir="rtl" value={editing.name_ar ?? ""} onChange={(e) => setEditing({ ...editing, name_ar: e.target.value })} /></label>
            <label className="field">
              <span className="field-label">{t("crm.startsAfter")}</span>
              <select value={editing.kind} onChange={(e) => setEditing({ ...editing, kind: e.target.value as Rule["kind"] })}>
                <option value="checkup">{t("crm.afterAnyVisit")}</option>
                <option value="after_procedure">{t("crm.afterProcedure")}</option>
              </select>
            </label>
            <label className="field"><span className="field-label">{t("crm.intervalMonths")}</span><input type="number" min={1} max={36} value={editing.interval_months ?? 6} onChange={(e) => setEditing({ ...editing, interval_months: Number(e.target.value) })} /></label>
          </div>
          {editing.kind === "after_procedure" && (
            <div className="checks proc-checks">
              {procedures.map((p) => (
                <label key={p.id} className="check-pill">
                  <input type="checkbox" checked={(editing.procedures ?? []).includes(p.id)}
                    onChange={(e) => setEditing({ ...editing, procedures: e.target.checked ? [...(editing.procedures ?? []), p.id] : (editing.procedures ?? []).filter((x) => x !== p.id) })} />
                  {p.code} {name(p)}
                </label>
              ))}
            </div>
          )}
          {error && <p className="form-error" role="alert">{error}</p>}
          <div className="form-actions">
            <button className="btn" onClick={() => setEditing(null)}>{t("cancel")}</button>
            <button className="btn btn-primary" onClick={() => void save()}>{t("save")}</button>
          </div>
        </div>
      )}
    </Modal>
  );
}

/* --------------------------------------------------------------- feedback */

interface FeedbackRow {
  id: number;
  patient_info: { id: number; file_number: string; ar: string; en: string };
  dentist_info: { ar: string; en: string } | null;
  visit_date: string | null;
  score: number | null;
  comment: string;
  source: string;
  token: string;
  answered_at: string | null;
  created_at: string;
}
interface VisitRow {
  id: number;
  start: string;
  patient: { id: number; file_number: string; ar: string; en: string; phone: string; language: string; whatsapp: boolean };
  dentist: { ar: string; en: string } | null;
  procedure: { ar: string; en: string } | null;
}

function Feedback() {
  const { t, lang } = useI18n();
  const { can, me } = useAuth();
  const [rows, setRows] = useState<FeedbackRow[] | null>(null);
  const [visits, setVisits] = useState<VisitRow[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [scoring, setScoring] = useState<VisitRow | null>(null);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    getAll<FeedbackRow>("/api/crm/feedback/").then(setRows).catch(() => setRows([]));
    get<VisitRow[]>("/api/crm/feedback/visits/").then(setVisits).catch(() => setVisits([]));
    get<Summary>("/api/crm/summary/").then(setSummary).catch(() => undefined);
  }, [version]);
  const answered = (rows ?? []).filter((r) => r.score);
  const dist = [5, 4, 3, 2, 1].map((n) => ({ key: String(n), label: "★".repeat(n), value: answered.filter((r) => r.score === n).length }));
  const sendLink = async (v: VisitRow) => {
    const fb = await post<FeedbackRow>("/api/crm/feedback/request-link/", { appointment: v.id });
    const url = `${window.location.origin}/feedback/${fb.token}`;
    const ar = v.patient.language !== "en";
    const first = (ar ? v.patient.ar || v.patient.en : v.patient.en || v.patient.ar).split(/\s+/)[0];
    const clinicName = (ar ? me?.clinic?.name_ar : me?.clinic?.name_en) ?? "";
    const text = ar ? `شكرًا لزيارتك ${clinicName} يا ${first}. يسعدنا تقييمك للزيارة: ${url}` : `Thank you for visiting ${clinicName}, ${first}. How did we do? ${url}`;
    window.open(waLink(v.patient.phone, text), "_blank", "noopener");
    setVersion((x) => x + 1);
  };
  return (
    <>
      <div className="kpi-grid">
        <KpiTile i={0} label={t("crm.fb.nps")} value={summary?.nps === null || summary?.nps === undefined ? "—" : String(summary.nps)} sub={t("crm.fb.npsSub")} tone={summary?.nps !== null && summary?.nps !== undefined && summary.nps >= 30 ? "good" : undefined} />
        <KpiTile i={1} label={t("crm.fb.average")} value={summary?.feedback_average ? summary.feedback_average.toFixed(2) : "—"} sub={t("crm.fb.last90")} />
        <KpiTile i={2} label={t("crm.fb.count")} value={String(summary?.feedback_count ?? "…")} sub={t("crm.fb.last90")} />
        <KpiTile i={3} label={t("crm.fb.waiting")} value={String(visits.length)} sub={t("crm.fb.waitingSub")} tone={visits.length ? "accent" : undefined} />
      </div>
      <div className="dash-grid">
        <section className="card dash-card">
          <h2>{t("crm.fb.toAsk")}</h2>
          {visits.length === 0 ? <p className="muted small">{t("crm.fb.allAsked")}</p> : (
            <ul className="plain-list fb-visits">
              {visits.slice(0, 12).map((v) => (
                <li key={v.id}>
                  <span className="grow">
                    <Link to={`/patients/${v.patient.id}`} className="strong">{personName(v.patient, lang)}</Link>
                    <span className="small muted block">{[fmtDate(v.start, lang), v.procedure ? personName(v.procedure, lang) : "", v.dentist ? personName(v.dentist, lang) : ""].filter(Boolean).join(" · ")}</span>
                  </span>
                  {can("crm", "create") && (
                    <>
                      <button className="btn btn-small" onClick={() => setScoring(v)}>{t("crm.fb.enter")}</button>
                      {v.patient.whatsapp && <button className="btn btn-small wa-btn" onClick={() => void sendLink(v)}>{t("crm.fb.sendLink")}</button>}
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className="card dash-card">
          <h2>{t("crm.fb.scores")}</h2>
          <BarList rows={dist} empty={t("noRecords")} />
        </section>
        <section className="card dash-card wide">
          <h2>{t("crm.fb.latest")}</h2>
          {rows === null ? <p className="muted">{t("loading")}</p> : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>{t("cl.patient")}</th>
                    <th>{t("crm.fb.visit")}</th>
                    <th>{t("crm.fb.score")}</th>
                    <th>{t("crm.fb.comment")}</th>
                    <th>{t("crm.source")}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.slice(0, 40).map((r) => (
                    <tr key={r.id}>
                      <td><Link to={`/patients/${r.patient_info.id}`}>{personName(r.patient_info, lang)}</Link></td>
                      <td className="nowrap">{[r.visit_date ? fmtDate(r.visit_date, lang) : "", r.dentist_info ? personName(r.dentist_info, lang) : ""].filter(Boolean).join(" · ")}</td>
                      <td className="nowrap">{r.score ? <Stars score={r.score} /> : <span className="pill pill-outline">{t("crm.fb.linkSent")}</span>}</td>
                      <td>{r.comment || "—"}</td>
                      <td>{t(r.source === "link" ? "crm.fb.byLink" : "crm.fb.byReception")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
      {scoring && <ScoreDialog visit={scoring} onClose={() => setScoring(null)} onSaved={() => { setScoring(null); setVersion((x) => x + 1); }} />}
    </>
  );
}

function ScoreDialog({ visit, onClose, onSaved }: { visit: VisitRow; onClose: () => void; onSaved: () => void }) {
  const { t, lang } = useI18n();
  const [score, setScore] = useState(0);
  const [comment, setComment] = useState("");
  const [error, setError] = useState("");
  const save = async () => {
    try {
      await post("/api/crm/feedback/", { patient: visit.patient.id, appointment: visit.id, score, comment });
      onSaved();
    } catch (err) {
      setError(errorText(err));
    }
  };
  return (
    <Modal title={`${t("crm.fb.enter")}: ${personName(visit.patient, lang)}`} onClose={onClose}>
      <div className="star-picker" role="radiogroup" aria-label={t("crm.fb.score")}>
        {[1, 2, 3, 4, 5].map((n) => (
          <button key={n} type="button" role="radio" aria-checked={score === n} className={n <= score ? "on" : ""} onClick={() => setScore(n)} aria-label={String(n)}>★</button>
        ))}
      </div>
      <label className="field">
        <span className="field-label">{t("crm.fb.comment")}</span>
        <textarea rows={3} value={comment} onChange={(e) => setComment(e.target.value)} />
      </label>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="form-actions">
        <button className="btn" onClick={onClose}>{t("cancel")}</button>
        <button className="btn btn-primary" disabled={!score} onClick={() => void save()}>{t("save")}</button>
      </div>
    </Modal>
  );
}

export { addDays };
