import { useCallback, useEffect, useRef, useState, type CSSProperties, type DragEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { get, getAll, post } from "../api";
import { useAuth } from "../auth";
import { useI18n, type TKey } from "../i18n";
import { Icon } from "../components/Icon";
import { fmtDate, money } from "../format";
import type { Page } from "../api";
import type { LabCase, LabCostReport, LabDashboard, LabStage, LabSummary } from "../types";
import { BarList, ColumnChart, KpiTile } from "../components/Charts";
import { exportPdf } from "../components/pdf";
import { useLetterhead } from "../components/print";
import { errorText, personName, useCurrency } from "./BillingParts";
import { CaseView, NewCaseDialog, OPEN_STAGES, STAGES, stageLabel, stagePill, useCaseTitle } from "./LabParts";

type Tab = "board" | "finished" | "dashboard" | "costs";
type Filter = "all" | "mine" | "unassigned" | "overdue" | "rush" | "on_hold";

function isoToday() {
  return new Date().toLocaleDateString("en-CA");
}

/** The lab: a board of open cases by stage, finished work, and cost per unit. */
export function Lab() {
  const { t } = useI18n();
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const tab = (params.get("tab") as Tab) || "board";
  const [summary, setSummary] = useState<LabSummary | null>(null);
  const [ordering, setOrdering] = useState(false);
  const [viewing, setViewing] = useState<LabCase | null>(null);
  const [version, setVersion] = useState(0);
  const [filter, setFilter] = useState<Filter>(() => (sessionStorage.getItem("erp.lab.filter") as Filter) || "all");
  useEffect(() => {
    get<LabSummary>("/api/lab/summary/").then(setSummary).catch(() => undefined);
  }, [version]);
  const tabs: { id: Tab; label: TKey; show: boolean }[] = [
    { id: "board", label: "lab.tab.board", show: true },
    { id: "finished", label: "lab.tab.finished", show: true },
    { id: "dashboard", label: "lab.tab.dashboard", show: true },
    { id: "costs", label: "lab.tab.costs", show: can("lab", "approve") },
  ];
  const show = (f: Filter) => {
    setFilter(f);
    setParams({ tab: "board" }, { replace: true });
  };
  const stats: { label: TKey; n?: number; f: Filter; tone?: string }[] = [
    { label: "lab.hero.open", n: summary?.open, f: "all" },
    { label: "dash.dueToday", n: summary?.due_today, f: "all", tone: summary?.due_today ? "accent" : "" },
    { label: "lab.hero.tomorrow", n: summary?.due_tomorrow, f: "all" },
    { label: "lab.filter.overdue", n: summary?.overdue, f: "overdue", tone: summary?.overdue ? "warn" : "" },
    { label: "lab.priority.rush", n: summary?.rush, f: "rush", tone: summary?.rush ? "accent" : "" },
    { label: "lab.filter.onHold", n: summary?.on_hold, f: "on_hold", tone: summary?.on_hold ? "warn" : "" },
  ];
  return (
    <div className="page">
      <section className="lab-hero">
        <div>
          <h1>{t("lab.title")}</h1>
          <p>{t("lab.heroSub")}</p>
        </div>
        <div className="lab-hero-stats">
          {stats.map((x) => (
            <button key={x.label} className={`lab-hero-stat ${x.tone ?? ""}`} onClick={() => show(x.f)}>
              <strong>{x.n ?? "…"}</strong>
              <span>{t(x.label)}</span>
            </button>
          ))}
        </div>
        {can("lab", "create") && (
          <button className="btn btn-accent" onClick={() => setOrdering(true)}>
            <Icon name="plus" size={18} /> {t("lab.newOrder")}
          </button>
        )}
      </section>
      <div className="segmented tabs" role="tablist">
        {tabs
          .filter((x) => x.show)
          .map((x) => (
            <button key={x.id} role="tab" aria-selected={tab === x.id} className={tab === x.id ? "active" : ""} onClick={() => setParams({ tab: x.id }, { replace: true })}>
              {t(x.label)}
            </button>
          ))}
      </div>
      {tab === "board" && <Board key={version} summary={summary} filter={filter} setFilter={setFilter} onChanged={() => setVersion((v) => v + 1)} />}
      {tab === "finished" && <Finished />}
      {tab === "dashboard" && <Dashboard />}
      {tab === "costs" && can("lab", "approve") && <Costs />}
      {ordering && (
        <NewCaseDialog
          onClose={() => setOrdering(false)}
          onSaved={(c) => {
            setOrdering(false);
            setVersion((v) => v + 1);
            setViewing(c);
          }}
        />
      )}
      {viewing && <CaseView initial={viewing} onClose={() => setViewing(null)} onChanged={() => setVersion((v) => v + 1)} />}
    </div>
  );
}

function initialsOf(n: { ar: string; en: string }, lang: string) {
  return personName(n, lang)
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase();
}

/** "Due today", "in 3 days", "2 days late". */
function dueIn(due: string, t: (k: TKey, v?: Record<string, string | number>) => string) {
  const days = Math.round((new Date(`${due}T12:00:00`).getTime() - new Date(`${isoToday()}T12:00:00`).getTime()) / 86_400_000);
  if (days === 0) return { text: t("lab.due.today"), cls: "today" };
  if (days === 1) return { text: t("lab.due.tomorrow"), cls: "" };
  if (days > 1) return { text: t("lab.due.inDays", { n: days }), cls: "" };
  return { text: t("lab.due.late", { n: -days }), cls: "late" };
}

function Board({ summary, filter, setFilter, onChanged }: { summary: LabSummary | null; filter: Filter; setFilter: (f: Filter) => void; onChanged: () => void }) {
  const { t, lang } = useI18n();
  const { can } = useAuth();
  const title = useCaseTitle();
  const [search, setSearch] = useState("");
  const [cases, setCases] = useState<LabCase[] | null>(null);
  const [viewing, setViewing] = useState<LabCase | null>(null);
  const [dragging, setDragging] = useState<number | null>(null);
  const [over, setOver] = useState<LabStage | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(() => {
    const q = new URLSearchParams({ open: "1" });
    if (filter === "mine") q.set("technician", "me");
    if (filter === "unassigned") q.set("technician", "none");
    if (filter === "overdue") q.set("overdue", "1");
    if (filter === "rush") q.set("rush", "1");
    if (filter === "on_hold") q.set("on_hold", "1");
    if (search.trim()) q.set("search", search.trim());
    getAll<LabCase>(`/api/lab/cases/?${q}`).then(setCases).catch(() => setCases([]));
  }, [filter, search]);
  useEffect(() => {
    const timer = window.setTimeout(load, search ? 250 : 0);
    return () => window.clearTimeout(timer);
  }, [load, search]);
  useEffect(() => {
    try {
      sessionStorage.setItem("erp.lab.filter", filter);
    } catch {
      /* storage blocked */
    }
  }, [filter]);

  const move = async (c: LabCase, stage: LabStage) => {
    if (stage === c.stage) return;
    setError("");
    // Show the move at once; the server answer replaces it.
    setCases((rows) => rows?.map((r) => (r.id === c.id ? { ...r, stage } : r)) ?? rows);
    try {
      await post(`/api/lab/cases/${c.id}/stage/`, { stage });
    } catch (err) {
      setError(errorText(err));
    }
    load();
    onChanged();
  };
  const editable = can("lab", "edit");
  const onDrop = (stage: LabStage) => (e: DragEvent) => {
    e.preventDefault();
    const c = cases?.find((x) => x.id === dragging);
    setOver(null);
    setDragging(null);
    if (c) void move(c, stage);
  };

  const filters: { id: Filter; label: TKey; n?: number }[] = [
    { id: "all", label: "lab.filter.all", n: summary?.open },
    { id: "mine", label: "lab.filter.mine", n: summary?.mine },
    { id: "unassigned", label: "lab.filter.unassigned", n: summary?.unassigned },
    { id: "overdue", label: "lab.filter.overdue", n: summary?.overdue },
    { id: "rush", label: "lab.priority.rush", n: summary?.rush },
    { id: "on_hold", label: "lab.filter.onHold", n: summary?.on_hold },
  ];

  return (
    <>
      <section className="card pad toolbar lab-bar">
        <div className="chip-row" role="group" aria-label={t("lab.show")}>
          {filters.map((f) => (
            <button key={f.id} className={`chip ${filter === f.id ? "active" : ""} ${(f.id === "overdue" || f.id === "on_hold") && f.n ? "warn" : ""}`} aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>
              {t(f.label)}
              {f.n !== undefined && <span className="chip-count">{f.n}</span>}
            </button>
          ))}
        </div>
        <label className="top-search search-field">
          <Icon name="search" />
          <input type="search" aria-label={t("search")} placeholder={t("lab.searchHint")} value={search} onChange={(e) => setSearch(e.target.value)} />
        </label>
      </section>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="lab-board">
        {OPEN_STAGES.map((stage, col) => {
          const rows = (cases ?? []).filter((c) => c.stage === stage);
          return (
            <section
              key={stage}
              className={`lab-col ${over === stage ? "drop" : ""}`}
              data-stage={stage}
              style={{ "--i": col } as CSSProperties}
              aria-label={t(`lab.stage.${stage}` as TKey)}
              onDragOver={(e) => {
                if (dragging === null) return;
                e.preventDefault();
                setOver(stage);
              }}
              onDragLeave={() => setOver((s) => (s === stage ? null : s))}
              onDrop={onDrop(stage)}
            >
              <header className="lab-col-head">
                <span className={`stage-dot stage-${stage === "ready" ? "ready" : "now"}`} aria-hidden="true" />
                <h2>{t(`lab.stage.${stage}` as TKey)}</h2>
                <span className="lab-col-count">{cases === null ? "…" : rows.length}</span>
              </header>
              <div className="lab-col-body">
                {rows.length === 0 && cases !== null && <p className="muted small lab-empty">{t("lab.emptyCol")}</p>}
                {rows.map((c) => {
                  const next = STAGES[STAGES.indexOf(c.stage) + 1];
                  return (
                    <article
                      key={c.id}
                      className={`lab-card ${c.overdue ? "is-overdue" : ""} ${c.priority === "rush" ? "is-rush" : ""} ${c.on_hold ? "is-held" : ""} ${dragging === c.id ? "is-dragging" : ""}`}
                      draggable={editable}
                      onDragStart={(e) => {
                        setDragging(c.id);
                        e.dataTransfer.effectAllowed = "move";
                      }}
                      onDragEnd={() => {
                        setDragging(null);
                        setOver(null);
                      }}
                    >
                      <button className="lab-card-main" onClick={() => setViewing(c)}>
                        <span className="lab-card-top">
                          <span className="mono small muted">{c.number}</span>
                          <span className="lab-card-badges">
                            {c.priority === "rush" && <span className="rush-badge"><Icon name="bolt" size={11} />{t("lab.priority.rush")}</span>}
                            {c.remake_of_number && <span className="pill pill-warn tiny">{t("lab.remakeTag")}</span>}
                            {c.pan_number && <span className="pan-chip">{c.pan_number}</span>}
                          </span>
                        </span>
                        <span className="strong block">{title(c)}</span>
                        <span className="small block">
                          {personName(c.patient_info, lang)} <span className="muted mono">{c.patient_info.file_number}</span>
                        </span>
                        {c.on_hold && <span className="hold-badge"><Icon name="clock" size={12} /> {c.hold_reason}</span>}
                        <span className="lab-card-meta small">
                          {c.shade && <span className="shade-chip mono">{c.shade}</span>}
                          {(() => {
                            const d = dueIn(c.due_date, t);
                            return (
                              <span className={`due due-in ${d.cls}`} title={fmtDate(c.due_date, lang)}>
                                <Icon name="calendar" size={14} /> {d.text}
                              </span>
                            );
                          })()}
                          <span className="tech" title={c.technician_name ? personName(c.technician_name, lang) : t("lab.unassigned")}>
                            {c.technician_name ? <span className="tech-avatar">{initialsOf(c.technician_name, lang)}</span> : <span className="muted">{t("lab.unassigned")}</span>}
                          </span>
                        </span>
                        <span className="lab-progress" aria-hidden="true">
                          {OPEN_STAGES.map((st, k) => <i key={st} className={k <= OPEN_STAGES.indexOf(c.stage) ? "on" : ""} />)}
                        </span>
                      </button>
                      {editable && next && (
                        <button className="lab-next" onClick={() => void move(c, next)} title={t("lab.moveTo", { stage: t(`lab.stage.${next}` as TKey) })}>
                          {next === "delivered" ? t("lab.markDelivered") : t(`lab.stage.${next}` as TKey)}
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
      {viewing && <CaseView initial={viewing} onClose={() => setViewing(null)} onChanged={() => { load(); onChanged(); }} />}
    </>
  );
}

function Finished() {
  const { t, lang } = useI18n();
  const title = useCaseTitle();
  const [search, setSearch] = useState("");
  const [rows, setRows] = useState<LabCase[] | null>(null);
  const [viewing, setViewing] = useState<LabCase | null>(null);
  const load = useCallback(() => {
    get<Page<LabCase>>(`/api/lab/cases/?closed=1&search=${encodeURIComponent(search)}`)
      .then((p) => setRows(p.results))
      .catch(() => setRows([]));
  }, [search]);
  useEffect(() => {
    const timer = window.setTimeout(load, 250);
    return () => window.clearTimeout(timer);
  }, [load]);
  return (
    <section className="card">
      <header className="card-head">
        <label className="top-search search-field">
          <Icon name="search" />
          <input type="search" aria-label={t("search")} placeholder={t("lab.searchHint")} value={search} onChange={(e) => setSearch(e.target.value)} />
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
                <th>{t("lab.number")}</th>
                <th>{t("cl.patient")}</th>
                <th>{t("lab.work")}</th>
                <th>{t("lab.technician")}</th>
                <th>{t("lab.closed")}</th>
                <th className="num">{t("lab.perUnit")}</th>
                <th>{t("plan.status")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.id} className="row-link" onClick={() => setViewing(c)}>
                  <td className="mono small">{c.number}</td>
                  <td>{personName(c.patient_info, lang)} <span className="muted mono small">{c.patient_info.file_number}</span></td>
                  <td>
                    {title(c)}
                    {c.remake_of_number && <span className="muted small"> · {t("lab.remakeOfShort", { n: c.remake_of_number })}</span>}
                  </td>
                  <td>{c.technician_name ? personName(c.technician_name, lang) : "—"}</td>
                  <td className="nowrap">{fmtDate((c.delivered_at ?? c.cancelled_at ?? c.created_at).slice(0, 10), lang)}</td>
                  <td className="num">{money(c.cost_per_unit, lang)}</td>
                  <td><span className={stagePill(c)}>{stageLabel(c, t)}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {viewing && <CaseView initial={viewing} onClose={() => setViewing(null)} onChanged={load} />}
    </section>
  );
}

function Dashboard() {
  const { t, lang } = useI18n();
  const currency = useCurrency();
  const letterhead = useLetterhead(lang);
  const ref = useRef<HTMLDivElement>(null);
  const [start, setStart] = useState(addDaysIso(isoToday(), -89));
  const [end, setEnd] = useState(isoToday());
  const [data, setData] = useState<LabDashboard | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    get<LabDashboard>(`/api/lab/dashboard/?start=${start}&end=${end}`).then(setData).catch(() => setData(null));
  }, [start, end]);
  const presets: { label: TKey; days: number }[] = [
    { label: "rep.last30", days: 29 },
    { label: "rep.last90", days: 89 },
    { label: "rep.lastYear", days: 364 },
  ];
  const shortWeek = (iso: string) => new Date(`${iso}T12:00:00`).toLocaleDateString(lang === "ar" ? "ar-EG" : "en-GB", { day: "numeric", month: "short" });
  const download = async () => {
    if (!ref.current) return;
    setBusy(true);
    try {
      await exportPdf(ref.current, `lab-report-${start}-${end}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <section className="card pad dash-bar">
        <div className="toolbar">
          <label className="field inline">
            <span>{t("com.from")}</span>
            <input type="date" value={start} max={end} onChange={(e) => setStart(e.target.value)} />
          </label>
          <label className="field inline">
            <span>{t("com.to")}</span>
            <input type="date" value={end} min={start} onChange={(e) => setEnd(e.target.value)} />
          </label>
          <div className="chip-row">
            {presets.map((p) => (
              <button key={p.label} className="chip" onClick={() => { setStart(addDaysIso(isoToday(), -p.days)); setEnd(isoToday()); }}>{t(p.label)}</button>
            ))}
          </div>
        </div>
        <button className="btn export-btn" disabled={busy || !data} onClick={() => void download()}>
          <Icon name="download" size={18} /> {busy ? t("rep.exporting") : t("rep.exportPdf")}
        </button>
      </section>
      {data && (
        <div ref={ref} className="page report-body">
          <header className="report-head pdf-only">
            <div>
              <h1>{t("lab.reportTitle")}</h1>
              <p>{letterhead.name} · {fmtDate(data.start, lang)} – {fmtDate(data.end, lang)}</p>
            </div>
            <img src="/brand/logo.svg" alt="" />
          </header>
          <div className="kpi-grid">
            <KpiTile i={0} label={t("lab.kpi.created")} value={String(data.created)} sub={t("lab.kpi.outsourced", { n: data.outsourced })} />
            <KpiTile i={1} label={t("lab.kpi.delivered")} value={String(data.delivered)} sub={t("lab.kpi.units", { n: data.units })} tone="good" />
            <KpiTile i={2} label={t("lab.kpi.turnaround")} value={data.avg_days === null ? "—" : t("lab.kpi.days", { n: data.avg_days })} sub={t("lab.kpi.turnaroundSub")} />
            <KpiTile i={3} label={t("lab.onTime")} value={data.on_time === null ? "—" : `${data.on_time}%`} tone={data.on_time !== null && data.on_time < 85 ? "warn" : "good"} />
            <KpiTile i={4} label={t("lab.remakeRate")} value={`${data.remake_rate}%`} sub={t("lab.kpi.remakeSplit", { lab: data.remakes_lab, clinic: data.remakes_clinic })} tone={data.remake_rate > 5 ? "warn" : undefined} />
            {data.costs && <KpiTile i={5} label={t("lab.kpi.costPerUnit")} value={`${money(data.costs.per_unit, lang)} ${currency}`} sub={t("lab.kpi.totalCost", { n: money(data.costs.total, lang), cur: currency })} tone="accent" />}
          </div>
          <div className="dash-grid">
            <section className="card dash-card wide">
              <h2>{t("lab.chart.flow")}</h2>
              <ColumnChart points={data.weeks.map((w) => ({ label: shortWeek(w.week), values: [w.in, w.out] }))} series={[t("lab.chart.in"), t("lab.chart.out")]} />
            </section>
            <section className="card dash-card">
              <h2>{t("lab.chart.turnaround")}</h2>
              <BarList
                rows={data.turnaround.map((r) => ({ key: r.restoration, label: t(`lab.rest.${r.restoration}` as TKey), value: r.avg_days, note: t("lab.kpi.casesN", { n: r.cases }) }))}
                format={(n) => t("lab.kpi.days", { n })}
                empty={t("lab.noDelivered")}
              />
            </section>
            <section className="card dash-card">
              <h2>{t("lab.chart.mix")}</h2>
              <BarList rows={data.by_restoration.map((r) => ({ key: r.restoration, label: t(`lab.rest.${r.restoration}` as TKey), value: r.count }))} empty={t("noRecords")} />
            </section>
            <section className="card dash-card">
              <h2>{t("lab.chart.remakes")}</h2>
              <BarList rows={data.remake_reasons.map((r) => ({ key: r.reason, label: t(`lab.reason.${r.reason}` as TKey), value: r.count }))} empty={t("lab.chart.noRemakes")} />
            </section>
            <section className="card dash-card">
              <h2>{t("lab.chart.technicians")}</h2>
              {data.technicians.length === 0 ? (
                <p className="muted small">{t("noRecords")}</p>
              ) : (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>{t("lab.technician")}</th>
                        <th className="num">{t("lab.kpi.openCol")}</th>
                        <th className="num">{t("lab.delivered")}</th>
                        <th className="num">{t("lab.units")}</th>
                        <th className="num">{t("lab.kpi.avgDays")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.technicians.map((r) => (
                        <tr key={r.id}>
                          <td>{personName(r.name, lang)}</td>
                          <td className="num">{r.open}</td>
                          <td className="num">{r.delivered}</td>
                          <td className="num">{r.units}</td>
                          <td className="num">{r.avg_days ?? "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
            {data.costs && (
              <section className="card dash-card">
                <h2>{t("lab.chart.costMaterial")}</h2>
                <BarList
                  rows={data.costs.by_material.map((r) => ({ key: r.material, label: t(`lab.mat.${r.material}` as TKey), value: Number(r.cost), note: t("lab.kpi.perUnitNote", { n: money(r.per_unit, lang) }) }))}
                  format={(n) => `${money(n, lang)} ${currency}`}
                  empty={t("lab.noDelivered")}
                />
              </section>
            )}
          </div>
        </div>
      )}
    </>
  );
}

function addDaysIso(iso: string, days: number) {
  const d = new Date(`${iso}T12:00:00`);
  d.setDate(d.getDate() + days);
  return d.toLocaleDateString("en-CA");
}

function Costs() {
  const { t, lang } = useI18n();
  const currency = useCurrency();
  const now = new Date();
  const [start, setStart] = useState(new Date(now.getFullYear(), now.getMonth(), 1).toLocaleDateString("en-CA"));
  const [end, setEnd] = useState(isoToday());
  const [report, setReport] = useState<LabCostReport | null>(null);
  useEffect(() => {
    get<LabCostReport>(`/api/lab/costs/?start=${start}&end=${end}`).then(setReport).catch(() => setReport(null));
  }, [start, end]);
  return (
    <>
      <section className="card pad toolbar">
        <label className="field inline">
          <span>{t("com.from")}</span>
          <input type="date" value={start} onChange={(e) => setStart(e.target.value)} />
        </label>
        <label className="field inline">
          <span>{t("com.to")}</span>
          <input type="date" value={end} onChange={(e) => setEnd(e.target.value)} />
        </label>
      </section>
      {report && (
        <>
          <div className="method-cards">
            <div className="card method-card total">
              <p className="overline">{t("lab.delivered")}</p>
              <p className="bill-figure">{report.delivered}</p>
            </div>
            <div className="card method-card">
              <p className="overline">{t("lab.onTime")}</p>
              <p className="bill-figure">{report.on_time === null ? "—" : `${report.on_time}%`}</p>
            </div>
            <div className="card method-card">
              <p className="overline">{t("lab.remakeRate")}</p>
              <p className={`bill-figure ${report.remake_rate > 5 ? "owed" : ""}`}>{report.remake_rate}%</p>
              <p className="muted small">{t("lab.remakesN", { n: report.remakes })}</p>
            </div>
          </div>
          <section className="card">
            <header className="card-head">
              <h2>{t("lab.costPerUnit")}</h2>
              <p className="muted small">{t("lab.costHint")}</p>
            </header>
            {report.rows.length === 0 ? (
              <p className="muted pad">{t("lab.noDelivered")}</p>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>{t("lab.restoration")}</th>
                      <th>{t("lab.material")}</th>
                      <th className="num">{t("lab.casesCol")}</th>
                      <th className="num">{t("lab.units")}</th>
                      <th className="num">{t("lab.totalCost", { cur: currency })}</th>
                      <th className="num">{t("lab.perUnit")}</th>
                      <th className="num">{t("lab.remakes")}</th>
                      <th className="num">{t("lab.scrap")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.rows.map((r) => (
                      <tr key={`${r.restoration}-${r.material}`}>
                        <td>{t(`lab.rest.${r.restoration}` as TKey)}</td>
                        <td>{t(`lab.mat.${r.material}` as TKey)}</td>
                        <td className="num">{r.cases}</td>
                        <td className="num">{r.units}</td>
                        <td className="num">{money(r.cost, lang)}</td>
                        <td className="num strong">{money(r.cost_per_unit, lang)}</td>
                        <td className="num">{r.remakes}</td>
                        <td className={`num ${Number(r.scrap_cost) > 0 ? "owed" : ""}`}>{money(r.scrap_cost, lang)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </>
  );
}
