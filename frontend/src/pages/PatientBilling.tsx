import { useCallback, useEffect, useState } from "react";
import { get, getAll } from "../api";
import { useAuth } from "../auth";
import { useI18n, type TKey } from "../i18n";
import { Icon } from "../components/Icon";
import { fmtDate, money } from "../format";
import type { BillingPatient, Invoice, Patient, PatientAccount, Payment } from "../types";
import { InvoiceDialog, InvoiceView, PAY_PILL, PaymentDialog, usePrintBilling, useCurrency } from "./BillingParts";

// Billing and payments on the patient file (handoff section 5): billed to
// date, paid, balance due, a paid/billed bar, invoices and payments.

export function useAccount(patientId: number, enabled: boolean) {
  const [account, setAccount] = useState<PatientAccount | null>(null);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [payments, setPayments] = useState<Payment[]>([]);
  const reload = useCallback(() => {
    if (!enabled) return;
    get<PatientAccount>(`/api/billing/patients/${patientId}/account/`).then(setAccount).catch(() => undefined);
    getAll<Invoice>(`/api/billing/invoices/?patient=${patientId}`).then(setInvoices).catch(() => undefined);
    getAll<Payment>(`/api/billing/payments/?patient=${patientId}`).then(setPayments).catch(() => undefined);
  }, [patientId, enabled]);
  useEffect(reload, [reload]);
  return { account, invoices, payments, reload };
}

export function billingPatient(p: Patient): BillingPatient {
  return { id: p.id, ar: p.name_ar, en: p.name_en, file_number: p.file_number, phone: p.phone };
}

export function BalanceStat({ account }: { account: PatientAccount | null }) {
  const { t, lang } = useI18n();
  const currency = useCurrency();
  const balance = Number(account?.balance ?? 0);
  return (
    <div className="pf-stat">
      <p className="overline">{t("bill.balanceDue")}</p>
      <p className={`pf-stat-value ${balance > 0 ? "owed" : ""}`}>{account ? `${money(balance, lang)} ${currency}` : "…"}</p>
      {account && <p className="pf-stat-sub">{t("bill.paidOfBilled", { paid: money(account.paid, lang), billed: money(account.billed, lang) })}</p>}
    </div>
  );
}

export function BillingCard({
  patient,
  data,
  openSignal,
}: {
  patient: Patient;
  data: ReturnType<typeof useAccount>;
  openSignal: number;
}) {
  const { t, lang } = useI18n();
  const { can } = useAuth();
  const currency = useCurrency();
  const print = usePrintBilling();
  const [creating, setCreating] = useState(false);
  const [paying, setPaying] = useState(false);
  const [viewing, setViewing] = useState<Invoice | null>(null);
  const { account, invoices, payments } = data;
  const who = billingPatient(patient);

  useEffect(() => {
    if (openSignal > 0) setPaying(true);
  }, [openSignal]);

  const billed = Number(account?.billed ?? 0);
  const paid = Number(account?.paid ?? 0);
  const pct = billed > 0 ? Math.min(100, Math.round((paid / billed) * 100)) : 0;

  return (
    <section id="billing" className="card main-card">
      <header className="main-card-head wrap">
        <h2>{t("bill.title")}</h2>
        <div className="toolbar">
          {can("billing", "create") && patient.is_active && (
            <>
              <button className="btn" onClick={() => setCreating(true)}>{t("bill.newInvoice")}</button>
              <button className="btn btn-primary" onClick={() => setPaying(true)}>
                <Icon name="plus" size={18} /> {t("bill.addPayment")}
              </button>
            </>
          )}
        </div>
      </header>
      <div className="bill-summary">
        <div>
          <p className="overline">{t("bill.billedToDate")}</p>
          <p className="bill-figure">{money(billed, lang)} <span>{currency}</span></p>
        </div>
        <div>
          <p className="overline">{t("bill.paid")}</p>
          <p className="bill-figure">{money(paid, lang)} <span>{currency}</span></p>
        </div>
        <div>
          <p className="overline">{t("bill.balanceDue")}</p>
          <p className={`bill-figure ${Number(account?.balance ?? 0) > 0 ? "owed" : ""}`}>{money(account?.balance ?? 0, lang)} <span>{currency}</span></p>
        </div>
      </div>
      <div className="paid-bar" role="img" aria-label={t("bill.paidPct", { n: pct })}>
        <span style={{ width: `${pct}%` }} />
      </div>

      <div className="bill-columns">
        <div>
          <h3 className="sub-head">{t("bill.invoices")}</h3>
          {invoices.length === 0 ? (
            <p className="muted small">{t("bill.noInvoices")}</p>
          ) : (
            <ul className="plain-list bill-list">
              {invoices.map((inv) => (
                <li key={inv.id}>
                  <button className="bill-row" onClick={() => setViewing(inv)}>
                    <span className="mono small">{inv.number}</span>
                    <span className="grow muted small">{fmtDate(inv.issue_date, lang)}</span>
                    <span className="num strong">{money(inv.totals.total, lang)}</span>
                    <span className={PAY_PILL[inv.payment_status]}>{t(`bill.status.${inv.payment_status}` as TKey)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <h3 className="sub-head">{t("bill.payments")}</h3>
          {payments.length === 0 ? (
            <p className="muted small">{t("bill.noPayments")}</p>
          ) : (
            <ul className="plain-list bill-list">
              {payments.map((p) => (
                <li key={p.id} className={p.voided_at ? "is-void" : ""}>
                  <button className="bill-row" onClick={() => print.receipt(p)} title={t("bill.printReceipt")}>
                    <span className="mono small">{p.receipt_number}</span>
                    <span className="grow small">
                      {fmtDate(p.paid_on, lang)} · {t(`pay.${p.method}` as TKey)}
                      {p.invoice_number && <span className="muted"> · {p.invoice_number}</span>}
                      {p.voided_at && <span className="muted"> · {t("bill.voided")}</span>}
                    </span>
                    <span className="num strong">{money(p.amount, lang)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {creating && (
        <InvoiceDialog
          patient={who}
          onClose={() => setCreating(false)}
          onSaved={(inv) => {
            setCreating(false);
            data.reload();
            setViewing(inv);
          }}
        />
      )}
      {paying && (
        <PaymentDialog
          patient={who}
          invoices={invoices}
          onClose={() => setPaying(false)}
          onSaved={(p) => {
            setPaying(false);
            data.reload();
            print.receipt(p);
          }}
        />
      )}
      {viewing && <InvoiceView invoice={viewing} onClose={() => setViewing(null)} onChanged={() => data.reload()} />}
    </section>
  );
}
