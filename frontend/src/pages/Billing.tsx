import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { get, getAll, post } from "../api";
import { useAuth } from "../auth";
import { useI18n, type TKey } from "../i18n";
import { Icon } from "../components/Icon";
import { fmtDate, money } from "../format";
import type { Page } from "../api";
import type { Branch, Cashbox, CommissionRow, Installment, Invoice } from "../types";
import { INST_PILL, InvoiceView, METHODS, PAY_PILL, errorText, personName, usePrintBilling, useCurrency } from "./BillingParts";

type Tab = "today" | "invoices" | "installments" | "commissions";

function isoToday() {
  return new Date().toLocaleDateString("en-CA");
}

/** Billing desk: the day's cashbox, invoices, installments due, commissions. */
export function Billing() {
  const { t } = useI18n();
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const tabs: { id: Tab; label: TKey; show: boolean }[] = [
    { id: "today", label: "bill.tab.today", show: true },
    { id: "invoices", label: "bill.invoices", show: true },
    { id: "installments", label: "bill.installments", show: true },
    { id: "commissions", label: "bill.commissions", show: can("billing", "approve") },
  ];
  const tab = (params.get("tab") as Tab) || "today";

  return (
    <div className="page">
      <div className="page-head">
        <h1>{t("bill.title")}</h1>
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
      {tab === "today" && <CashboxTab />}
      {tab === "invoices" && <InvoicesTab />}
      {tab === "installments" && <InstallmentsTab />}
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
            {METHODS.map((m) => (
              <div key={m} className="card method-card">
                <p className="overline">{t(`pay.${m}` as TKey)}</p>
                <p className="bill-figure">{money(box.totals[m] ?? 0, lang)}</p>
              </div>
            ))}
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
