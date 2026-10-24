import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import { ApiError, get, getAll, tokens } from "../api";
import { useAuth } from "../auth";
import { useI18n, type TKey } from "../i18n";
import { BarList, ColumnChart, KpiTile } from "../components/Charts";
import { Icon, type IconName } from "../components/Icon";
import { exportPdf } from "../components/pdf";
import { useLetterhead } from "../components/print";
import { fmtDate, money } from "../format";
import type { Branch, StaffMember } from "../types";
import { errorText, useCurrency } from "./BillingParts";

type Name = { en: string; ar: string };
interface Column {
  key: string;
  en: string;
  ar: string;
  type: "text" | "name" | "money" | "number" | "percent" | "date" | "month" | "phone";
}
interface ReportData {
  key: string;
  start: string;
  end: string;
  columns: Column[];
  rows: Record<string, unknown>[];
  totals: Record<string, string | number>;
}
interface LibraryItem {
  key: string;
  module: string;
  filters: string[];
  period: boolean;
}
type Kpis = Partial<Record<
  "revenue" | "collections" | "new_patients" | "visits" | "no_show_rate" | "chair_utilisation" | "lab_turnaround" | "lab_delivered" |
  "inventory_value" | "payroll_cost" | "leads" | "lead_conversion" | "recall_compliance" | "campaign_revenue" | "campaign_roi" | "nps",
  string | number | null
>>;
interface Overview {
  start: string;
  end: string;
  previous: { start: string; end: string };
  current: Kpis;
  before: Kpis;
  trend: { bucket: string; points: { period: string; billed: string; collected: string; visits: number; new_patients: number }[] };
  breakdowns: {
    by_dentist?: { dentist: Name; billed: string; collected: string; procedures: number }[];
    by_procedure?: { code: string; procedure: Name; count: number; billed: string }[];
    by_source?: { source: Name; patients: number }[];
    funnel?: Record<string, number>;
  };
}

function isoToday() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Africa/Cairo" });
}
function addDays(iso: string, days: number) {
  const d = new Date(`${iso}T12:00:00`);
  d.setDate(d.getDate() + days);
  return d.toLocaleDateString("en-CA");
}
function monthStart(iso: string) {
  return `${iso.slice(0, 8)}01`;
}
function lastMonth() {
  const end = addDays(monthStart(isoToday()), -1);
  return { start: monthStart(end), end };
}

const ICONS: Record<string, IconName> = {
  billing: "receipt", patients: "patients", appointments: "calendar", clinical: "tooth", lab: "flask",
  inventory: "box", staff: "badge", crm: "trend",
};

/** Period picker shared by the overview and every report. */
function PeriodBar({ start, end, setPeriod, children }: { start: string; end: string; setPeriod: (s: string, e: string) => void; children?: ReactNode }) {
  const { t } = useI18n();
  const today = isoToday();
  const presets: { label: TKey; get: () => [string, string] }[] = [
    { label: "fin.thisMonth", get: () => [monthStart(today), today] },
    { label: "rep.lastMonth", get: () => { const m = lastMonth(); return [m.start, m.end]; } },
    { label: "rep.last90", get: () => [addDays(today, -89), today] },
    { label: "rep.thisYear", get: () => [`${today.slice(0, 4)}-01-01`, today] },
  ];
  return (
    <section className="card pad dash-bar">
      <div className="toolbar">
        <label className="field inline">
          <span>{t("com.from")}</span>
          <input type="date" value={start} max={end} onChange={(e) => setPeriod(e.target.value, end)} />
        </label>
        <label className="field inline">
          <span>{t("com.to")}</span>
          <input type="date" value={end} min={start} onChange={(e) => setPeriod(start, e.target.value)} />
        </label>
        <div className="chip-row">
          {presets.map((p) => {
            const [s, e] = p.get();
            return (
              <button key={p.label} className={`chip ${s === start && e === end ? "active" : ""}`} onClick={() => setPeriod(s, e)}>{t(p.label)}</button>
            );
          })}
        </div>
      </div>
      {children}
    </section>
  );
}

function usePeriod() {
  const [period, setPeriodState] = useState(() => {
    try {
      const saved = JSON.parse(sessionStorage.getItem("reports.period") ?? "null");
      if (saved?.start && saved?.end) return saved as { start: string; end: string };
    } catch {
      /* ignore */
    }
    return { start: monthStart(isoToday()), end: isoToday() };
  });
  const setPeriod = (start: string, end: string) => {
    setPeriodState({ start, end });
    try {
      sessionStorage.setItem("reports.period", JSON.stringify({ start, end }));
    } catch {
      /* ignore */
    }
  };
  return { ...period, setPeriod };
}

/** Owner overview plus the library of reports. */
export function Reports() {
  const { key } = useParams();
  return key ? <ReportPage reportKey={key} /> : <OverviewPage />;
}

function OverviewPage() {
  const { t, lang } = useI18n();
  const currency = useCurrency();
  const letterhead = useLetterhead(lang);
  const { start, end, setPeriod } = usePeriod();
  const [data, setData] = useState<Overview | null>(null);
  const [library, setLibrary] = useState<LibraryItem[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    get<LibraryItem[]>("/api/reports/").then(setLibrary).catch(() => setLibrary([]));
  }, []);
  useEffect(() => {
    setError("");
    get<Overview>(`/api/reports/overview/?start=${start}&end=${end}`).then(setData).catch((err) => setError(errorText(err)));
  }, [start, end]);
  const download = async () => {
    if (!ref.current) return;
    setBusy(true);
    try {
      await exportPdf(ref.current, `overview-${start}-${end}`);
    } finally {
      setBusy(false);
    }
  };
  const cur = data?.current ?? {};
  const prev = data?.before ?? {};
  const change = (k: keyof Kpis, points = false) => {
    const c = cur[k];
    const p = prev[k];
    if (c === null || c === undefined || p === null || p === undefined) return t("fin.noPrev");
    if (points) {
      const d = Math.round((Number(c) - Number(p)) * 10) / 10;
      return t(d >= 0 ? "rep.upPts" : "rep.downPts", { n: Math.abs(d) });
    }
    if (!Number(p)) return t("fin.noPrev");
    const d = Math.round(((Number(c) - Number(p)) / Number(p)) * 100);
    return t(d >= 0 ? "fin.up" : "fin.down", { n: Math.abs(d) });
  };
  const fmtMoney = (v: unknown) => `${money(Math.round(Number(v ?? 0)), lang)} ${currency}`;
  const pct = (v: unknown) => (v === null || v === undefined ? "—" : `${v}%`);
  const tiles: { k: keyof Kpis; label: TKey; value: (v: unknown) => string; points?: boolean; tone?: "good" | "accent" | "warn"; lowerBetter?: boolean }[] = [
    { k: "revenue", label: "rep.k.revenue", value: fmtMoney },
    { k: "collections", label: "rep.k.collections", value: fmtMoney, tone: "good" },
    { k: "new_patients", label: "rep.k.newPatients", value: (v) => String(v ?? "—") },
    { k: "visits", label: "rep.k.visits", value: (v) => String(v ?? "—") },
    { k: "chair_utilisation", label: "rep.k.chair", value: pct, points: true },
    { k: "no_show_rate", label: "rep.k.noShow", value: pct, points: true, lowerBetter: true },
    { k: "lead_conversion", label: "rep.k.conversion", value: pct, points: true },
    { k: "recall_compliance", label: "rep.k.recall", value: pct, points: true },
    { k: "nps", label: "rep.k.nps", value: (v) => (v === null || v === undefined ? "—" : String(v)), points: true, tone: "accent" },
    { k: "campaign_revenue", label: "rep.k.campaigns", value: fmtMoney },
    { k: "lab_turnaround", label: "rep.k.lab", value: (v) => (v === null || v === undefined ? "—" : t("rep.days", { n: String(v) })), lowerBetter: true },
    { k: "payroll_cost", label: "rep.k.payroll", value: fmtMoney },
    { k: "inventory_value", label: "rep.k.stock", value: fmtMoney },
  ];
  const label = (iso: string) => {
    const d = new Date(`${iso}T12:00:00`);
    const loc = lang === "ar" ? "ar-EG" : "en-GB";
    return data?.trend.bucket === "month" ? d.toLocaleDateString(loc, { month: "short", year: "2-digit" }) : d.toLocaleDateString(loc, { day: "numeric", month: "short" });
  };
  const nm = (n: Name) => (lang === "ar" ? n.ar || n.en : n.en || n.ar);
  const b = data?.breakdowns;
  const hasMoney = cur.revenue !== undefined;
  return (
    <div className="page reports-page">
      <section className="lab-hero reports-hero">
        <div>
          <h1>{t("rep.title")}</h1>
          <p>{t("rep.heroSub")}</p>
        </div>
      </section>
      <PeriodBar start={start} end={end} setPeriod={setPeriod}>
        <button className="btn export-btn" disabled={busy || !data} onClick={() => void download()}>
          <Icon name="download" size={18} /> {busy ? t("rep.exporting") : t("rep.exportPdf")}
        </button>
      </PeriodBar>
      {error && <p className="form-error" role="alert">{error}</p>}
      {data && (
        <div ref={ref} className="report-body">
          <header className="report-head pdf-only">
            <div>
              <h1>{t("rep.overviewTitle")}</h1>
              <p>{letterhead.name} · {fmtDate(data.start, lang)} – {fmtDate(data.end, lang)}</p>
            </div>
            <img src="/brand/logo.svg" alt="" />
          </header>
          <p className="muted small compare-note">{t("rep.comparedWith", { start: fmtDate(data.previous.start, lang), end: fmtDate(data.previous.end, lang) })}</p>
          <div className="kpi-grid">
            {tiles.filter((x) => x.k in cur).map((x, i) => (
              <KpiTile key={x.k} i={i} label={t(x.label)} value={x.value(cur[x.k])} sub={change(x.k, x.points)} tone={x.tone} />
            ))}
          </div>
          <div className="dash-grid">
            {(hasMoney || cur.visits !== undefined) && (
              <section className="card dash-card wide">
                <h2>{hasMoney ? t("fin.chart.trend") : t("rep.visitsTrend")}</h2>
                <ColumnChart
                  points={data.trend.points.map((p) => ({ label: label(p.period), values: hasMoney ? [Number(p.billed), Number(p.collected)] : [p.visits] }))}
                  series={hasMoney ? [t("fin.billed"), t("fin.collected")] : [t("rep.k.visits")]}
                  format={hasMoney ? (n) => money(n, lang) : String}
                />
              </section>
            )}
            {b?.by_dentist && (
              <section className="card dash-card">
                <h2>{t("rep.byDentist")}</h2>
                <BarList rows={b.by_dentist.map((r, i) => ({ key: String(i), label: nm(r.dentist), value: Number(r.billed), note: t("rep.procN", { n: r.procedures }) }))} format={(n) => money(n, lang)} empty={t("noRecords")} />
              </section>
            )}
            {b?.by_procedure && (
              <section className="card dash-card">
                <h2>{t("rep.byProcedure")}</h2>
                <BarList rows={b.by_procedure.map((r, i) => ({ key: String(i), label: nm(r.procedure), value: Number(r.billed), note: `× ${r.count}` }))} format={(n) => money(n, lang)} empty={t("noRecords")} />
              </section>
            )}
            {b?.by_source && (
              <section className="card dash-card">
                <h2>{t("rep.bySource")}</h2>
                <BarList rows={b.by_source.map((r, i) => ({ key: String(i), label: nm(r.source), value: r.patients }))} empty={t("noRecords")} />
              </section>
            )}
            {b?.funnel && (
              <section className="card dash-card">
                <h2>{t("rep.funnel")}</h2>
                <BarList rows={Object.entries(b.funnel).map(([k, v]) => ({ key: k, label: t(`crm.stage.${k}` as TKey), value: v }))} empty={t("noRecords")} />
              </section>
            )}
          </div>
        </div>
      )}
      <Library items={library} />
    </div>
  );
}

function Library({ items }: { items: LibraryItem[] }) {
  const { t } = useI18n();
  if (!items.length) return null;
  const groups = Array.from(new Set(items.map((i) => i.module)));
  return (
    <section className="card pad report-library">
      <h2>{t("rep.library")}</h2>
      <div className="report-groups">
        {groups.map((g) => (
          <div key={g} className="report-group">
            <h3><Icon name={ICONS[g] ?? "chart"} size={18} /> {t(`rep.group.${g}` as TKey)}</h3>
            <ul className="plain-list">
              {items.filter((i) => i.module === g).map((i) => (
                <li key={i.key}>
                  <Link to={`/reports/${i.key}`} className="report-link">
                    <span className="strong block">{t(`rep.r.${i.key}` as TKey)}</span>
                    <span className="small muted">{t(`rep.d.${i.key}` as TKey)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}

function ReportPage({ reportKey }: { reportKey: string }) {
  const { t, lang, name } = useI18n();
  const { can } = useAuth();
  const currency = useCurrency();
  const letterhead = useLetterhead(lang);
  const { start, end, setPeriod } = usePeriod();
  const [info, setInfo] = useState<LibraryItem | null>(null);
  const [data, setData] = useState<ReportData | null>(null);
  const [error, setError] = useState("");
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [branches, setBranches] = useState<Branch[]>([]);
  const [dentists, setDentists] = useState<StaffMember[]>([]);
  const [busy, setBusy] = useState("");
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    get<LibraryItem[]>("/api/reports/").then((rows) => setInfo(rows.find((r) => r.key === reportKey) ?? null)).catch(() => setInfo(null));
    if (can("masterdata")) {
      getAll<Branch>("/api/masterdata/branches/?is_active=true").then(setBranches).catch(() => undefined);
      getAll<StaffMember>("/api/masterdata/staff/?staff_type=dentist&is_active=true").then(setDentists).catch(() => undefined);
    }
  }, [reportKey, can]);
  const query = () => {
    const q = new URLSearchParams({ start, end });
    Object.entries(filters).forEach(([k, v]) => v && q.set(k, v));
    return q;
  };
  useEffect(() => {
    setError("");
    get<ReportData>(`/api/reports/${reportKey}/?${query()}`).then(setData).catch((err) => {
      setData(null);
      setError(err instanceof ApiError && err.status === 403 ? t("rep.noAccess") : errorText(err));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reportKey, start, end, filters]);
  const title = t(`rep.r.${reportKey}` as TKey);
  const csv = async () => {
    setBusy("csv");
    try {
      const q = query();
      q.set("export", "csv");
      const res = await fetch(`/api/reports/${reportKey}/?${q}`, { headers: tokens.access ? { Authorization: `Bearer ${tokens.access}` } : {} });
      if (!res.ok) throw new ApiError(res.status, res.statusText);
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement("a");
      a.href = url;
      a.download = `${reportKey}-${start}-${end}.csv`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy("");
    }
  };
  const pdf = async () => {
    if (!ref.current) return;
    setBusy("pdf");
    try {
      await exportPdf(ref.current, `${reportKey}-${start}-${end}`, { landscape: (data?.columns.length ?? 0) > 6 });
    } finally {
      setBusy("");
    }
  };
  const cell = (c: Column, v: unknown): ReactNode => {
    if (v === null || v === undefined || v === "") return "—";
    switch (c.type) {
      case "name":
        return typeof v === "object" ? ((lang === "ar" ? (v as Name).ar : (v as Name).en) || (v as Name).en) : String(v);
      case "money":
        return money(Number(v), lang);
      case "number":
        return typeof v === "number" ? v.toLocaleString(lang === "ar" ? "ar-EG" : "en-GB") : String(v);
      case "percent":
        return `${v}%`;
      case "date":
        return fmtDate(String(v), lang);
      case "month":
        return new Date(`${String(v).slice(0, 7)}-01T12:00:00`).toLocaleDateString(lang === "ar" ? "ar-EG" : "en-GB", { month: "long", year: "numeric" });
      case "phone":
        return <bdi dir="ltr">{String(v)}</bdi>;
      default:
        return String(v);
    }
  };
  const sortValue = (c: Column, v: unknown) => (c.type === "money" || c.type === "number" || c.type === "percent" ? Number(v ?? 0) : c.type === "name" && v && typeof v === "object" ? (v as Name)[lang === "ar" ? "ar" : "en"] : String(v ?? ""));
  const rows = data ? [...data.rows] : [];
  if (data && sort) {
    const c = data.columns.find((x) => x.key === sort.key);
    if (c) rows.sort((a, b) => {
      const x = sortValue(c, a[c.key]);
      const y = sortValue(c, b[c.key]);
      return (x < y ? -1 : x > y ? 1 : 0) * sort.dir;
    });
  }
  const hasMoney = data?.columns.some((c) => c.type === "money");
  return (
    <div className="page reports-page">
      <nav className="crumbs small">
        <Link to="/reports">{t("rep.title")}</Link> <span aria-hidden="true">/</span> <span>{title}</span>
      </nav>
      <header className="page-head">
        <div>
          <h1>{title}</h1>
          <p className="muted">{t(`rep.d.${reportKey}` as TKey)}</p>
        </div>
      </header>
      <PeriodBar start={start} end={end} setPeriod={setPeriod}>
        <span className="report-actions">
          {info?.filters.includes("branch") && branches.length > 1 && (
            <select aria-label={t("ap.branch")} value={filters.branch ?? ""} onChange={(e) => setFilters({ ...filters, branch: e.target.value })}>
              <option value="">{t("rep.allBranches")}</option>
              {branches.map((b) => <option key={b.id} value={b.id}>{name(b)}</option>)}
            </select>
          )}
          {info?.filters.includes("dentist") && dentists.length > 0 && (
            <select aria-label={t("ap.dentist")} value={filters.dentist ?? ""} onChange={(e) => setFilters({ ...filters, dentist: e.target.value })}>
              <option value="">{t("rep.allDentists")}</option>
              {dentists.map((d) => <option key={d.id} value={d.id}>{name(d)}</option>)}
            </select>
          )}
          <button className="btn" disabled={!!busy || !data} onClick={() => void csv()}>
            <Icon name="download" size={18} /> CSV
          </button>
          <button className="btn" disabled={!!busy || !data} onClick={() => void pdf()}>
            <Icon name="file" size={18} /> {busy === "pdf" ? t("rep.exporting") : "PDF"}
          </button>
        </span>
      </PeriodBar>
      {info && !info.period && <p className="muted small">{t("rep.asOfToday")}</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
      {data && (
        <section ref={ref} className="card report-body report-table">
          <header className="report-head pdf-only">
            <div>
              <h1>{title}</h1>
              <p>{letterhead.name} · {fmtDate(data.start, lang)} – {fmtDate(data.end, lang)}{hasMoney ? ` · ${currency}` : ""}</p>
            </div>
            <img src="/brand/logo.svg" alt="" />
          </header>
          {rows.length === 0 ? (
            <p className="muted pad">{t("rep.empty")}</p>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    {data.columns.map((c) => {
                      const numeric = c.type === "money" || c.type === "number" || c.type === "percent";
                      const active = sort?.key === c.key;
                      return (
                        <th key={c.key} className={numeric ? "num" : ""} aria-sort={active ? (sort!.dir === 1 ? "ascending" : "descending") : undefined}>
                          <button className="th-sort" onClick={() => setSort(active ? { key: c.key, dir: sort!.dir === 1 ? -1 : 1 } : { key: c.key, dir: numeric ? -1 : 1 })}>
                            {lang === "ar" ? c.ar : c.en}
                            {active && <span aria-hidden="true">{sort!.dir === 1 ? " ▲" : " ▼"}</span>}
                          </button>
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={i}>
                      {data.columns.map((c) => (
                        <td key={c.key} className={c.type === "money" || c.type === "number" || c.type === "percent" ? "num nowrap" : c.type === "date" ? "nowrap" : ""}>
                          {cell(c, r[c.key])}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
                {Object.keys(data.totals).length > 0 && (
                  <tfoot>
                    <tr>
                      {data.columns.map((c, i) => (
                        <td key={c.key} className={c.key in data.totals ? "num nowrap strong" : "strong"}>
                          {c.key in data.totals ? cell(c, data.totals[c.key]) : i === 0 ? t("rep.total") : ""}
                        </td>
                      ))}
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
          )}
          <p className="muted small pad">{t("rep.rowsN", { n: rows.length })}</p>
        </section>
      )}
    </div>
  );
}
