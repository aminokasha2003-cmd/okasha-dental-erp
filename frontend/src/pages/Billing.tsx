import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { get, getAll, post } from "../api";
import { useAuth } from "../auth";
import { useI18n, type TKey } from "../i18n";
import { Icon } from "../components/Icon";
import { fmtDate, money } from "../format";
import type { Page } from "../api";
import type { Branch, Cashbox, CommissionRow, FinanceDashboard, Installment, Invoice } from "../types";
import { BarList, ColumnChart, KpiTile } from "../components/Charts";
import { exportPdf } from "../components/pdf";
import { useLetterhead } from "../components/print";
import { INST_PILL, InvoiceView, METHODS, PAY_PILL, errorText, personName, usePrintBilling, useCurrency } from "./BillingParts";

type Tab = "today" | "invoices" | "installments" | "dashboard" | "commissions";

function isoToday() {
  return new Date().toLocaleDateString("en-CA");
}

/** Billing desk: the day's cashbox, invoices, installments due, commissions. */
export function Billing() {
  const { t, lang } = useI18n();
  const { can } = useAuth();
  const currency = useCurrency();
  const [now, setNow] = useState<FinanceDashboard["now"] | null>(null);
  useEffect(() => {
    get<FinanceDashboard>("/api/billing/dashboard/").then((d) => setNow(d.now)).catch(() => undefined);
  }, []);
  const [params, setParams] = useSearchParams();
  const tabs: { id: Tab; label: TKey; show: boolean }[] = [
    { id: "today", label: "bill.tab.today", show: true },
    { id: "invoices", label: "bill.invoices", show: true },
    { id: "installments", label: "bill.installments", show: true },
    { id: "dashboard", label: "fin.tab", show: can("billing", "approve") },
    { id: "commissions", label: "bill.commissions", show: can("billing", "approve") },
  ];
  const tab = (params.get("tab") as Tab) || "today";

  return (
    <div className="page">
      <section className="lab-hero bill-hero">
        <div>
          <h1>{t("bill.title")}</h1>
          <p>{t("fin.heroSub")}</p>
        </div>
        {now && (
          <div className="lab-hero-stats">
            {[
              { label: "fin.today" as TKey, value: now.today, tab: "today" as Tab },
              { label: "fin.thisMonth" as TKey, value: now.month, tab: "dashboard" as Tab },
              { label: "fin.outstanding" as TKey, value: now.outstanding, tab: "invoices" as Tab, tone: Number(now.outstanding) > 0 ? "accent" : "" },
              { label: "fin.overdueInst" as TKey, value: now.overdue_installments, tab: "installments" as Tab, tone: now.overdue_count ? "warn" : "", sub: now.overdue_count },
            ].map((x) => (
              <button key={x.label} className={`lab-hero-stat ${x.tone ?? ""}`} onClick={() => setParams({ tab: x.tab }, { replace: true })}>
                <strong>{money(x.value, lang)}</strong>
                <span>{t(x.label)} · {currency}</span>
              </button>
            ))}
          </div>
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
      {tab === "today" && <CashboxTab />}
      {tab === "invoices" && <InvoicesTab />}
      {tab === "installments" && <InstallmentsTab />}
      {tab === "dashboard" && can("billing", "approve") && <FinanceTab />}
      {tab === "commissions" && can("billing", "approve") && <CommissionsTab />}
    </div>
  );
}

function CashboxTab() {
  const { t, lang, name } = useI18n();
  const { can } = useAuth();
  const currency = useCurrency();
  const print = usePrintBilling();
  const [day, setDay] = useState(isoToday());
  const [branches, setBranches] = useState<Branch[]>([]);
  const [branch, setBranch] = useState<number | null>(null);
  const [box, setBox] = useState<Cashbox | null>(null);
  const [counted, setCounted] = useState("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    getAll<Branch>("/api/masterdata/branches/?is_active=true")
      .then((rows) => {
        setBranches(rows);
        if (rows.length === 1) setBranch(rows[0].id);
      })
      .catch(() => undefined);
  }, []);
  const load = useCallback(() => {
    get<Cashbox>(`/api/billing/cashbox/?date=${day}${branch ? `&branch=${branch}` : ""}`)
      .then(setBox)
      .catch((err) => setError(errorText(err)));
  }, [day, branch]);
  useEffect(load, [load]);

  const close = async (e: FormEvent) => {
    e.preventDefault();
    if (!window.confirm(t("box.confirmClose"))) return;
    try {
      await post("/api/billing/cashbox/", { date: day, branch, counted_cash: counted, notes });
      setCounted("");
      setNotes("");
      load();
    } catch (err) {
      setError(errorText(err));
    }
  };

  const diff = counted === "" || !box ? null : Number(counted) - Number(box.expected_cash);
  return (
    <>
      <section className="card pad toolbar box-bar">
        <label className="field inline">
          <span>{t("note.date")}</span>
          <input type="date" value={day} max={isoToday()} onChange={(e) => setDay(e.target.value)} />
        </label>
        {branches.length > 1 && (
          <label className="field inline">
            <span>{t("ap.branch")}</span>
            <select value={branch ?? ""} onChange={(e) => setBranch(Number(e.target.value) || null)}>
              <option value="">{t("box.allBranches")}</option>
              {branches.map((b) => (
                <option key={b.id} value={b.id}>{name(b)}</option>
              ))}
            </select>
          </label>
        )}
        {box?.closing && <span className="pill pill-ok">{t("box.closedBy", { name: box.closing.closed_by })}</span>}
      </section>
      {error && <p className="form-error" role="alert">{error}</p>}
      {box && (
        <>
          <div className="method-cards">
            <div className="card method-card total">
              <p className="overline">{t("box.total")}</p>
              <p className="bill-figure">{money(box.total, lang)} <span>{currency}</span></p>
              <p className="muted small">{t("box.receipts", { n: box.payments.length })}</p>
            </div>
            {METHODS.map((m, i) => {
              const share = Number(box.total) > 0 ? (Number(box.totals[m] ?? 0) / Number(box.total)) * 100 : 0;
              return (
                <div key={m} className="card method-card" style={{ animationDelay: `${(i + 1) * 60}ms` }}>
                  <span className="method-icon" aria-hidden="true"><Icon name={m === "cash" ? "cash" : m === "card" ? "receipt" : "wallet"} size={18} /></span>
                  <p className="overline">{t(`pay.${m}` as TKey)}</p>
                  <p className="bill-figure">{money(box.totals[m] ?? 0, lang)}</p>
                  <span className="method-share" aria-label={`${Math.round(share)}%`}><i style={{ width: `${share}%` }} /></span>
                </div>
              );
            })}
          </div>
          <div className="two-col">
            <section className="card">
              <header className="card-head"><h2>{t("box.receiptsTitle")}</h2></header>
              {box.payments.length === 0 ? (
                <p className="muted pad">{t("bill.noPayments")}</p>
              ) : (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>{t("bill.receipt")}</th>
                        <th>{t("cl.patient")}</th>
                        <th>{t("bill.method")}</th>
                        <th className="num">{t("bill.amount", { cur: currency })}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {box.payments.map((p) => (
                        <tr key={p.id} className="row-link" onClick={() => print.receipt(p)} title={t("bill.printReceipt")}>
                          <td className="mono small">{p.receipt_number}</td>
                          <td>
                            <Link to={`/patients/${p.patient}`} onClick={(e) => e.stopPropagation()}>{personName(p.patient_info, lang)}</Link>
                            <p className="muted small">{[p.invoice_number, p.received_by].filter(Boolean).join(" · ")}</p>
                          </td>
                          <td>{t(`pay.${p.method}` as TKey)}</td>
                          <td className="num">{money(p.amount, lang)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {box.voided.length > 0 && <p className="muted small pad">{t("box.voidedCount", { n: box.voided.length })}</p>}
            </section>
            <section className="card pad close-card">
              <h2>{t("box.closeTitle")}</h2>
              {box.closing ? (
                <dl className="kv">
                  <div><dt>{t("box.expectedCash")}</dt><dd className="num">{money(box.closing.expected_cash, lang)}</dd></div>
                  <div><dt>{t("box.countedCash")}</dt><dd className="num">{money(box.closing.counted_cash, lang)}</dd></div>
                  <div><dt>{t("box.difference")}</dt><dd className={`num strong ${Number(box.closing.difference) !== 0 ? "owed" : ""}`}>{money(box.closing.difference, lang)}</dd></div>
                  {box.closing.notes && <div><dt>{t("notes")}</dt><dd>{box.closing.notes}</dd></div>}
                </dl>
              ) : can("billing", "create") ? (
                <form className="form-grid" onSubmit={close}>
                  <p className="muted">{t("box.closeHint")}</p>
                  <dl className="kv">
                    <div><dt>{t("box.expectedCash")}</dt><dd className="num strong">{money(box.expected_cash, lang)} {currency}</dd></div>
                  </dl>
                  <label className="field">
                    <span>{t("box.countedCash")}</span>
                    <input className="amount-input" required type="number" min="0" step="0.01" dir="ltr" value={counted} onChange={(e) => setCounted(e.target.value)} />
                  </label>
                  {diff !== null && (
                    <p className={diff === 0 ? "pill pill-ok" : "pill pill-warn"}>
                      {diff === 0 ? t("box.matches") : t(diff > 0 ? "box.over" : "box.short", { n: money(Math.abs(diff), lang) })}
                    </p>
                  )}
                  <label className="field">
                    <span>{t("notes")}</span>
                    <textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
                  </label>
                  <button className="btn btn-primary" type="submit">{t("box.close")}</button>
                </form>
              ) : (
                <p className="muted">{t("box.notClosed")}</p>
              )}
            </section>
          </div>
        </>
      )}
    </>
  );
}

function InvoicesTab() {
  const { t, lang } = useI18n();
  const [search, setSearch] = useState("");
  const [rows, setRows] = useState<Invoice[] | null>(null);
  const [viewing, setViewing] = useState<Invoice | null>(null);
  const load = useCallback(() => {
    get<Page<Invoice>>(`/api/billing/invoices/?search=${encodeURIComponent(search)}`)
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
          <input type="search" aria-label={t("search")} placeholder={t("bill.searchHint")} value={search} onChange={(e) => setSearch(e.target.value)} />
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
                <th>{t("bill.invoice")}</th>
                <th>{t("cl.patient")}</th>
                <th>{t("note.date")}</th>
                <th className="num">{t("bill.total")}</th>
                <th className="num">{t("bill.balance")}</th>
                <th>{t("plan.status")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((inv) => (
                <tr key={inv.id} className="row-link" onClick={() => setViewing(inv)}>
                  <td className="mono small">{inv.number}</td>
                  <td>{personName(inv.patient_info, lang)} <span className="muted mono small">{inv.patient_info.file_number}</span></td>
                  <td className="nowrap">{fmtDate(inv.issue_date, lang)}</td>
                  <td className="num">{money(inv.totals.total, lang)}</td>
                  <td className="num">{money(inv.totals.balance, lang)}</td>
                  <td><span className={PAY_PILL[inv.payment_status]}>{t(`bill.status.${inv.payment_status}` as TKey)}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {viewing && <InvoiceView invoice={viewing} onClose={() => setViewing(null)} onChanged={load} />}
    </section>
  );
}

function InstallmentsTab() {
  const { t, lang } = useI18n();
  const [rows, setRows] = useState<Installment[] | null>(null);
  const [viewing, setViewing] = useState<Invoice | null>(null);
  const load = useCallback(() => {
    get<Installment[]>("/api/billing/installments/").then(setRows).catch(() => setRows([]));
  }, []);
  useEffect(load, [load]);
  return (
    <section className="card">
      <header className="card-head">
        <h2>{t("inst.dueSoon")}</h2>
      </header>
      {rows === null ? (
        <p className="muted pad">{t("loading")}</p>
      ) : rows.length === 0 ? (
        <p className="muted pad">{t("inst.none")}</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{t("bill.firstDue")}</th>
                <th>{t("cl.patient")}</th>
                <th>{t("bill.invoice")}</th>
                <th className="num">{t("cl.remaining")}</th>
                <th>{t("plan.status")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((i) => (
                <tr key={i.id} className="row-link" onClick={() => void get<Invoice>(`/api/billing/invoices/${i.invoice}/`).then(setViewing)}>
                  <td className="nowrap">{fmtDate(i.due_date, lang)}</td>
                  <td>
                    {personName(i.patient_info, lang)} <span className="muted mono small">{i.patient_info.file_number}</span>
                    <p className="muted small" dir="ltr">{i.patient_info.phone}</p>
                  </td>
                  <td className="mono small">{`${i.invoice_number} · ${i.number}`}</td>
                  <td className="num">{money(i.remaining, lang)}</td>
                  <td><span className={INST_PILL[i.status]}>{t(`inst.${i.status}` as TKey)}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {viewing && <InvoiceView invoice={viewing} onClose={() => setViewing(null)} onChanged={load} />}
    </section>
  );
}

function CommissionsTab() {
  const { t, lang } = useI18n();
  const currency = useCurrency();
  const now = new Date();
  const [start, setStart] = useState(new Date(now.getFullYear(), now.getMonth(), 1).toLocaleDateString("en-CA"));
  const [end, setEnd] = useState(isoToday());
  const [rows, setRows] = useState<CommissionRow[] | null>(null);
  useEffect(() => {
    get<{ rows: CommissionRow[] }>(`/api/billing/commissions/?start=${start}&end=${end}`)
      .then((r) => setRows(r.rows))
      .catch(() => setRows([]));
  }, [start, end]);
  const ruleText = (r: CommissionRow) =>
    r.rule === "fixed_per_procedure" ? t("com.fixed", { n: money(r.value, lang) }) : r.rule === "none" ? t("com.none") : t(r.rule === "percent_billed" ? "com.billedPct" : "com.collectedPct", { n: Number(r.value) });
  return (
    <section className="card">
      <header className="card-head">
        <div className="toolbar">
          <label className="field inline">
            <span>{t("com.from")}</span>
            <input type="date" value={start} onChange={(e) => setStart(e.target.value)} />
          </label>
          <label className="field inline">
            <span>{t("com.to")}</span>
            <input type="date" value={end} onChange={(e) => setEnd(e.target.value)} />
          </label>
        </div>
        <p className="muted small">{t("com.hint")}</p>
      </header>
      {rows === null ? (
        <p className="muted pad">{t("loading")}</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{t("cl.dentist")}</th>
                <th>{t("com.rule")}</th>
                <th className="num">{t("com.procedures")}</th>
                <th className="num">{t("com.billed")}</th>
                <th className="num">{t("com.collected")}</th>
                <th className="num">{t("com.commission", { cur: currency })}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.dentist}>
                  <td>{personName(r.name, lang)}</td>
                  <td className="muted">{ruleText(r)}</td>
                  <td className="num">{r.procedures}</td>
                  <td className="num">{money(r.billed, lang)}</td>
                  <td className="num">{money(r.collected, lang)}</td>
                  <td className="num strong">{money(r.commission, lang)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function addDays(iso: string, days: number) {
  const d = new Date(`${iso}T12:00:00`);
  d.setDate(d.getDate() + days);
  return d.toLocaleDateString("en-CA");
}

function delta(cur: string, prev: string) {
  const c = Number(cur);
  const p = Number(prev);
  if (!p) return null;
  return Math.round(((c - p) / p) * 100);
}

/** Owner's money dashboard for a period, exportable as a PDF report. */
function FinanceTab() {
  const { t, lang } = useI18n();
  const currency = useCurrency();
  const letterhead = useLetterhead(lang);
  const ref = useRef<HTMLDivElement>(null);
  const [start, setStart] = useState(() => isoToday().slice(0, 8) + "01");
  const [end, setEnd] = useState(isoToday());
  const [data, setData] = useState<FinanceDashboard | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setError("");
    get<FinanceDashboard>(`/api/billing/dashboard/?start=${start}&end=${end}`).then(setData).catch((err) => setError(errorText(err)));
  }, [start, end]);
  const presets: { label: TKey; start: () => string }[] = [
    { label: "fin.thisMonth", start: () => isoToday().slice(0, 8) + "01" },
    { label: "rep.last30", start: () => addDays(isoToday(), -29) },
    { label: "rep.last90", start: () => addDays(isoToday(), -89) },
    { label: "rep.lastYear", start: () => addDays(isoToday(), -364) },
  ];
  const fmtMoney = (n: number) => money(n, lang);
  const period = (iso: string) => {
    const d = new Date(`${iso}T12:00:00`);
    const loc = lang === "ar" ? "ar-EG" : "en-GB";
    return data?.bucket === "month" ? d.toLocaleDateString(loc, { month: "short", year: "2-digit" }) : d.toLocaleDateString(loc, { day: "numeric", month: "short" });
  };
  const download = async () => {
    if (!ref.current) return;
    setBusy(true);
    try {
      await exportPdf(ref.current, `finance-report-${start}-${end}`);
    } finally {
      setBusy(false);
    }
  };
  const changeNote = (cur: string, prev: string) => {
    const d = delta(cur, prev);
    return d === null ? t("fin.noPrev") : t(d >= 0 ? "fin.up" : "fin.down", { n: Math.abs(d) });
  };
  const agingRows = data
    ? (["0_30", "31_60", "61_90", "90_plus"] as const).map((k) => ({ key: k, label: t(`fin.age.${k}` as TKey), value: Number(data.aging[k]) }))
    : [];
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
              <button key={p.label} className="chip" onClick={() => { setStart(p.start()); setEnd(isoToday()); }}>{t(p.label)}</button>
            ))}
          </div>
        </div>
        <button className="btn export-btn" disabled={busy || !data} onClick={() => void download()}>
          <Icon name="download" size={18} /> {busy ? t("rep.exporting") : t("rep.exportPdf")}
        </button>
      </section>
      {error && <p className="form-error" role="alert">{error}</p>}
      {data && (
        <div ref={ref} className="page report-body">
          <header className="report-head pdf-only">
            <div>
              <h1>{t("fin.reportTitle")}</h1>
              <p>{letterhead.name} · {fmtDate(data.start, lang)} – {fmtDate(data.end, lang)}</p>
            </div>
            <img src="/brand/logo.svg" alt="" />
          </header>
          <div className="kpi-grid">
            <KpiTile i={0} label={t("fin.collected")} value={`${money(data.collected, lang)} ${currency}`} sub={changeNote(data.collected, data.collected_prev)} tone="good" />
            <KpiTile i={1} label={t("fin.billed")} value={`${money(data.billed, lang)} ${currency}`} sub={changeNote(data.billed, data.billed_prev)} />
            <KpiTile i={2} label={t("fin.rate")} value={data.collection_rate === null ? "—" : `${data.collection_rate}%`} sub={t("fin.rateSub")} tone={data.collection_rate !== null && data.collection_rate < 60 ? "warn" : undefined} />
            <KpiTile i={3} label={t("fin.avgInvoice")} value={`${money(data.average_invoice, lang)} ${currency}`} sub={t("fin.invoicesN", { n: data.invoice_count })} />
            <KpiTile i={4} label={t("fin.discounts")} value={`${money(data.discounts, lang)} ${currency}`} sub={t("fin.paymentsN", { n: data.payment_count })} />
            <KpiTile i={5} label={t("fin.outstanding")} value={`${money(data.now.outstanding, lang)} ${currency}`} sub={t("fin.overdueSub", { n: money(data.now.overdue_installments, lang) })} tone="accent" />
          </div>
          <div className="dash-grid">
            <section className="card dash-card wide">
              <h2>{t("fin.chart.trend")}</h2>
              <ColumnChart
                points={data.trend.map((r) => ({ label: period(r.period), values: [Number(r.billed), Number(r.collected)] }))}
                series={[t("fin.billed"), t("fin.collected")]}
                format={fmtMoney}
              />
            </section>
            <section className="card dash-card">
              <h2>{t("fin.chart.methods")}</h2>
              <BarList
                rows={data.by_method.map((r) => ({ key: r.method, label: t(`pay.${r.method}` as TKey), value: Number(r.total), note: t("fin.paymentsN", { n: r.count }) }))}
                format={fmtMoney}
                empty={t("bill.noPayments")}
              />
            </section>
            <section className="card dash-card">
              <h2>{t("fin.chart.aging")}</h2>
              <BarList rows={agingRows.filter((r) => r.value > 0)} format={fmtMoney} empty={t("fin.nothingOwed")} />
            </section>
            <section className="card dash-card">
              <h2>{t("fin.chart.dentists")}</h2>
              {data.by_dentist.length === 0 ? (
                <p className="muted small">{t("noRecords")}</p>
              ) : (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>{t("ap.dentist")}</th>
                        <th className="num">{t("fin.billed")}</th>
                        <th className="num">{t("fin.collected")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.by_dentist.map((r) => (
                        <tr key={r.id}>
                          <td>{personName(r.name, lang)}</td>
                          <td className="num">{money(r.billed, lang)}</td>
                          <td className="num">{money(r.collected, lang)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
            <section className="card dash-card">
              <h2>{t("fin.chart.procedures")}</h2>
              <BarList
                rows={data.by_procedure.map((r, i) => ({ key: `${r.code}-${i}`, label: personName(r.name, lang), value: Number(r.billed), note: t("fin.timesN", { n: r.count }) }))}
                format={fmtMoney}
                empty={t("noRecords")}
              />
            </section>
            <section className="card dash-card">
              <h2>{t("fin.chart.debtors")}</h2>
              {data.top_debtors.length === 0 ? (
                <p className="muted small">{t("fin.nothingOwed")}</p>
              ) : (
                <ul className="mini-list">
                  {data.top_debtors.map((r) => (
                    <li key={r.id}>
                      <Link to={`/patients/${r.id}`}>{personName(r, lang)}</Link>
                      <span className="muted small mono">{r.file_number}</span>
                      <span className="num strong owed">{money(r.balance, lang)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <section className="card dash-card">
              <h2>{t("fin.chart.installments")}</h2>
              {data.installments_due.length === 0 ? (
                <p className="muted small">{t("fin.noInstallments")}</p>
              ) : (
                <ul className="mini-list">
                  {data.installments_due.map((r) => (
                    <li key={r.id}>
                      <Link to={`/patients/${r.patient.id}`}>{personName(r.patient, lang)}</Link>
                      <span className={`small ${r.overdue ? "owed strong" : "muted"}`}>{fmtDate(r.due_date, lang)}</span>
                      <span className="num strong">{money(r.remaining, lang)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        </div>
      )}
    </>
  );
}
