import { useCallback, useEffect, useState, type CSSProperties, type DragEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { get, getAll, post } from "../api";
import { useAuth } from "../auth";
import { useI18n, type TKey } from "../i18n";
import { Icon } from "../components/Icon";
import { fmtDate, money } from "../format";
import type { Page } from "../api";
import type { LabCase, LabCostReport, LabStage, LabSummary } from "../types";
import { errorText, personName, useCurrency } from "./BillingParts";
import { CaseView, OPEN_STAGES, STAGES, stageLabel, stagePill, useCaseTitle } from "./LabParts";

type Tab = "board" | "finished" | "costs";
type Filter = "all" | "mine" | "unassigned" | "overdue";

function isoToday() {
  return new Date().toLocaleDateString("en-CA");
}

/** The lab: a board of open cases by stage, finished work, and cost per unit. */
export function Lab() {
  const { t } = useI18n();
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const tab = (params.get("tab") as Tab) || "board";
  const tabs: { id: Tab; label: TKey; show: boolean }[] = [
    { id: "board", label: "lab.tab.board", show: true },
    { id: "finished", label: "lab.tab.finished", show: true },
    { id: "costs", label: "lab.tab.costs", show: can("lab", "approve") },
  ];
  return (
    <div className="page">
      <div className="page-head">
        <h1>{t("lab.title")}</h1>
      </div>
      <div className="segmented tabs" role="tablist">
        {tabs
          .filter((x) => x.show)
          .map((x) => (
            <button key={x.id} role="tab" aria-selected={tab === x.id} className={tab === x.id ? "active" : ""} onClick={() => setParams({ tab: x.id }, { replace: true })}>
              {t(x.label)}
            </button>
          ))}
      </div>
      {tab === "board" && <Board />}
      {tab === "finished" && <Finished />}
      {tab === "costs" && can("lab", "approve") && <Costs />}
    </div>
  );
}

function Board() {
  const { t, lang } = useI18n();
  const { can } = useAuth();
  const title = useCaseTitle();
  const [filter, setFilter] = useState<Filter>(() => (sessionStorage.getItem("erp.lab.filter") as Filter) || "all");
  const [search, setSearch] = useState("");
  const [cases, setCases] = useState<LabCase[] | null>(null);
  const [summary, setSummary] = useState<LabSummary | null>(null);
  const [viewing, setViewing] = useState<LabCase | null>(null);
  const [dragging, setDragging] = useState<number | null>(null);
  const [over, setOver] = useState<LabStage | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(() => {
    const q = new URLSearchParams({ open: "1" });
    if (filter === "mine") q.set("technician", "me");
    if (filter === "unassigned") q.set("technician", "none");
    if (filter === "overdue") q.set("overdue", "1");
    if (search.trim()) q.set("search", search.trim());
    getAll<LabCase>(`/api/lab/cases/?${q}`).then(setCases).catch(() => setCases([]));
    get<LabSummary>("/api/lab/summary/").then(setSummary).catch(() => undefined);
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
  ];

  return (
    <>
      <section className="card pad toolbar lab-bar">
        <div className="chip-row" role="group" aria-label={t("lab.show")}>
          {filters.map((f) => (
            <button key={f.id} className={`chip ${filter === f.id ? "active" : ""} ${f.id === "overdue" && f.n ? "warn" : ""}`} aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>
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
                      className={`lab-card ${c.overdue ? "is-overdue" : ""} ${dragging === c.id ? "is-dragging" : ""}`}
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
                          {c.remake_of_number && <span className="pill pill-warn tiny">{t("lab.remakeTag")}</span>}
                        </span>
                        <span className="strong block">{title(c)}</span>
                        <span className="small block">
                          {personName(c.patient_info, lang)} <span className="muted mono">{c.patient_info.file_number}</span>
                        </span>
                        <span className="lab-card-meta small">
                          {c.shade && <span className="shade-chip mono">{c.shade}</span>}
                          <span className={c.overdue ? "due overdue" : "due"}>
                            <Icon name="calendar" size={14} /> {fmtDate(c.due_date, lang)}
                          </span>
                          <span className="tech" title={c.technician_name ? personName(c.technician_name, lang) : t("lab.unassigned")}>
                            {c.technician_name ? personName(c.technician_name, lang) : <span className="muted">{t("lab.unassigned")}</span>}
                          </span>
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
      {viewing && <CaseView initial={viewing} onClose={() => setViewing(null)} onChanged={load} />}
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
