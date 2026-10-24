import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { get } from "../api";
import { useAuth } from "../auth";
import { useI18n, type TKey } from "../i18n";
import { Icon } from "../components/Icon";
import { BarList, ColumnChart, KpiTile } from "../components/Charts";
import { exportPdf } from "../components/pdf";
import { useLetterhead } from "../components/print";
import { fmtDate, money } from "../format";
import { useCurrency } from "./BillingParts";
import { nm } from "./ComplianceParts";
import { Sterilisation } from "./ComplianceSteril";
import { EquipmentArea, Licences } from "./ComplianceEquipment";
import type { ComplianceDashboard, ComplianceSummary } from "./ComplianceTypes";

type Tab = "sterilisation" | "equipment" | "licences" | "dashboard";

/** Compliance: sterilisation records, equipment upkeep and licences, with the e-invoice and online booking numbers at a glance. */
export function Compliance() {
  const { t } = useI18n();
  const { can } = useAuth();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const tab = (params.get("tab") as Tab) || "sterilisation";
  const focus = params.get("focus") || "";
  const [summary, setSummary] = useState<ComplianceSummary | null>(null);
  useEffect(() => {
    get<ComplianceSummary>("/api/compliance/summary/").then(setSummary).catch(() => undefined);
  }, [tab]);
  const go = (next: Tab, f = "") => setParams(f ? { tab: next, focus: f } : { tab: next }, { replace: true });
  const stats: { label: TKey; n?: number; tone?: string; onClick: () => void; show: boolean }[] = [
    { label: "co.hero.cyclesToday", n: summary?.cycles_today, onClick: () => go("sterilisation"), show: true },
    { label: "co.hero.failed", n: summary?.failed_cycles, tone: summary?.failed_cycles ? "warn" : "", onClick: () => go("sterilisation", "fail"), show: true },
    { label: "co.hero.overdue", n: summary?.maintenance_overdue, tone: summary?.maintenance_overdue ? "warn" : "", onClick: () => go("equipment", "maintenance"), show: true },
    { label: "co.hero.down", n: summary?.equipment_down, tone: summary?.equipment_down ? "accent" : "", onClick: () => go("equipment", "orders"), show: true },
    { label: "co.hero.licences", n: summary?.licences_expiring, tone: summary?.licences_expiring ? "warn" : "", onClick: () => go("licences"), show: true },
    { label: "co.hero.einvoice", n: summary?.einvoice_pending, tone: summary?.einvoice_invalid ? "warn" : "", onClick: () => navigate("/einvoices"), show: summary?.einvoice_pending !== undefined },
    { label: "co.hero.online", n: summary?.online_waiting, tone: summary?.online_waiting ? "accent" : "", onClick: () => navigate("/online-booking"), show: summary?.online_waiting !== undefined },
  ];
  const tabs: { id: Tab; label: TKey }[] = [
    { id: "sterilisation", label: "co.tab.sterilisation" },
    { id: "equipment", label: "co.tab.equipment" },
    { id: "licences", label: "co.tab.licences" },
    { id: "dashboard", label: "co.tab.dashboard" },
  ];
  return (
    <div className="page">
      <section className="lab-hero co-hero">
        <div>
          <h1>{t("co.title")}</h1>
          <p>{t("co.heroSub")}</p>
          {summary?.einvoice_invalid ? (
            <button className="co-hero-note" onClick={() => navigate("/einvoices?status=invalid")}>
              <Icon name="alert" size={14} /> {t("co.hero.invalidN", { n: summary.einvoice_invalid })}
            </button>
          ) : null}
        </div>
        <div className="lab-hero-stats">
          {stats.filter((x) => x.show).map((x) => (
            <button key={x.label} className={`lab-hero-stat ${x.tone ?? ""}`} onClick={x.onClick}>
              <strong>{x.n ?? "…"}</strong>
              <span>{t(x.label)}</span>
            </button>
          ))}
        </div>
      </section>
      <div className="segmented tabs" role="tablist">
        {tabs.map((x) => (
          <button key={x.id} role="tab" aria-selected={tab === x.id} className={tab === x.id ? "active" : ""} onClick={() => go(x.id)}>
            {t(x.label)}
            {x.id === "equipment" && summary?.maintenance_overdue ? <span className="badge tab-count">{summary.maintenance_overdue}</span> : null}
            {x.id === "licences" && summary?.licences_expiring ? <span className="badge tab-count">{summary.licences_expiring}</span> : null}
          </button>
        ))}
      </div>
      {tab === "sterilisation" && <Sterilisation key={focus} initialFilter={focus === "fail" ? "fail" : ""} />}
      {tab === "equipment" && <EquipmentArea key={focus} initial={focus === "orders" ? "orders" : focus === "register" ? "register" : "maintenance"} />}
      {tab === "licences" && <Licences />}
      {tab === "dashboard" && can("compliance", "view") && <Dashboard />}
    </div>
  );
}

function Dashboard() {
  const { t, lang } = useI18n();
  const currency = useCurrency();
  const letterhead = useLetterhead(lang);
  const ref = useRef<HTMLDivElement>(null);
  const [data, setData] = useState<ComplianceDashboard | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    get<ComplianceDashboard>("/api/compliance/dashboard/").then(setData).catch(() => setData(null));
  }, []);
  const month = (iso: string) => new Date(`${iso}T12:00:00`).toLocaleDateString(lang === "ar" ? "ar-EG" : "en-GB", { month: "short" });
  const download = async () => {
    if (!ref.current || !data) return;
    setBusy(true);
    try {
      await exportPdf(ref.current, `compliance-report-${data.start}-${data.end}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <section className="card pad dash-bar">
        <p className="muted">{data ? t("co.dash.period", { from: fmtDate(data.start, lang), to: fmtDate(data.end, lang) }) : t("loading")}</p>
        <button className="btn export-btn" disabled={busy || !data} onClick={() => void download()}>
          <Icon name="download" size={18} /> {busy ? t("rep.exporting") : t("rep.exportPdf")}
        </button>
      </section>
      {data && (
        <div ref={ref} className="page report-body">
          <header className="report-head pdf-only">
            <div>
              <h1>{t("co.dash.reportTitle")}</h1>
              <p>{letterhead.name} · {fmtDate(data.start, lang)} – {fmtDate(data.end, lang)}</p>
            </div>
            <img src="/brand/logo.svg" alt="" />
          </header>
          <div className="kpi-grid">
            <KpiTile i={0} label={t("co.dash.cycles")} value={data.cycles.toLocaleString()} sub={t("co.dash.biRuns", { n: data.bi_runs })} />
            <KpiTile i={1} label={t("co.dash.passRate")} value={data.pass_rate === null ? "—" : `${data.pass_rate}%`} sub={t("co.dash.failedN", { n: data.failed })} tone={data.failed ? "warn" : "good"} />
            <KpiTile i={2} label={t("co.dash.packs")} value={data.packs.toLocaleString()} sub={t("co.dash.packsUsed", { n: data.packs_used })} />
            <KpiTile i={3} label={t("co.dash.onTime")} value={data.on_time_rate === null ? "—" : `${data.on_time_rate}%`} sub={t("co.dash.overdueN", { n: data.maintenance_overdue })} tone={data.maintenance_overdue ? "warn" : "good"} />
            <KpiTile i={4} label={t("co.dash.cost")} value={`${money(data.maintenance_cost, lang)} ${currency}`} sub={t("co.dash.servicesN", { n: data.maintenance_done })} tone="accent" />
            <KpiTile i={5} label={t("co.dash.downtime")} value={t("co.hoursN", { n: data.downtime_hours })} sub={t("co.dash.ordersN", { n: data.work_orders })} />
          </div>
          <div className="dash-grid">
            <section className="card dash-card wide">
              <h2>{t("co.dash.cyclesChart")}</h2>
              <ColumnChart points={data.months.map((m) => ({ label: month(m.month), values: [m.cycles, m.packs] }))} series={[t("co.dash.cycles"), t("co.dash.packs")]} />
            </section>
            <section className="card dash-card">
              <h2>{t("co.dash.machines")}</h2>
              <BarList rows={data.machines.map((m) => ({ key: String(m.id), label: nm(m.name, lang), value: m.cycles, note: m.failed ? t("co.dash.failedN", { n: m.failed }) : undefined }))} empty={t("noRecords")} />
            </section>
            <section className="card dash-card">
              <h2>{t("co.dash.costChart")}</h2>
              <ColumnChart points={data.months.map((m) => ({ label: month(m.month), values: [Number(m.maintenance_cost)] }))} series={[t("co.dash.cost")]} format={(n) => money(n, lang)} />
            </section>
            <section className="card dash-card">
              <h2>{t("co.dash.byCategory")}</h2>
              <BarList
                rows={data.by_category.map((r) => ({ key: r.category, label: t(`co.cat.${r.category}` as TKey), value: r.orders, note: t("co.hoursN", { n: r.downtime }) }))}
                empty={t("co.dash.noOrders")}
              />
            </section>
            <section className="card dash-card">
              <h2>{t("co.dash.downtimeChart")}</h2>
              <ColumnChart points={data.months.map((m) => ({ label: month(m.month), values: [m.downtime] }))} series={[t("co.dash.downtime")]} />
            </section>
          </div>
        </div>
      )}
    </>
  );
}
