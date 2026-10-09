import { useEffect, useState, type FormEvent } from "react";
import { ApiError, get, post } from "../api";
import { useAuth } from "../auth";
import { useI18n, type TKey } from "../i18n";
import { Modal } from "../components/Crud";
import { Icon } from "../components/Icon";
import { escapeHtml, printDocument, useLetterhead } from "../components/print";
import { fmtDate, money } from "../format";
import type { BillableLine, BillingPatient, Invoice, PayMethod, Payment } from "../types";

// Shared billing pieces: invoice and payment dialogs, the invoice view,
// installment schedules and printed invoices and receipts.

export const METHODS: PayMethod[] = ["cash", "instapay", "card", "wallet", "bank"];
export const PAY_PILL: Record<string, string> = { unpaid: "pill pill-warn", partly_paid: "pill pill-warn", paid: "pill pill-ok", void: "pill pill-muted" };
export const INST_PILL: Record<string, string> = { paid: "pill pill-ok", overdue: "pill pill-alert", partly_paid: "pill pill-warn", due: "pill pill-outline" };

export function errorText(err: unknown) {
  if (err instanceof ApiError) return Object.keys(err.fields).length ? Object.values(err.fields).flat().join(" ") : err.message;
  return err instanceof Error ? err.message : String(err);
}
export function personName(p: { ar: string; en: string } | null | undefined, lang: string) {
  return p ? (lang === "ar" ? p.ar || p.en : p.en || p.ar) : "";
}
export function useCurrency() {
  const { me } = useAuth();
  return me?.clinic?.currency ?? "EGP";
}
function today() {
  return new Date().toLocaleDateString("en-CA");
}

/* -------------------------------------------------------------- printing */

export function usePrintBilling() {
  const { t, lang } = useI18n();
  const letterhead = useLetterhead(lang);
  const currency = useCurrency();
  const patientText = (p: BillingPatient, date: string) =>
    [escapeHtml(personName(p, lang)), escapeHtml(p.file_number), escapeHtml(fmtDate(date, lang))].join(" · ");

  const invoice = (inv: Invoice) => {
    const rows = inv.lines
      .map(
        (l) =>
          `<tr><td>${escapeHtml(l.description)}${l.tooth ? ` · ${escapeHtml(t("tooth.label", { n: l.tooth }))}` : ""}</td><td>${l.quantity}</td><td style="text-align:end">${money(l.unit_price, lang)}</td><td style="text-align:end">${Number(l.discount) ? money(l.discount, lang) : ""}</td><td style="text-align:end">${money(l.total, lang)}</td></tr>`,
      )
      .join("");
    const sum = (label: string, value: string, strong = false) =>
      `<tr><td colspan="4" style="text-align:end;border:0${strong ? ";font-weight:600" : ""}">${escapeHtml(label)}</td><td style="text-align:end;border:0${strong ? ";font-weight:600" : ""}">${value}</td></tr>`;
    printDocument({
      title: `${t("bill.invoice")} ${inv.number}`,
      lang,
      clinic: letterhead,
      patient: patientText(inv.patient_info, inv.issue_date),
      body: `<table><thead><tr><th>${t("bill.item")}</th><th>${t("bill.qty")}</th><th style="text-align:end">${t("plan.price")}</th><th style="text-align:end">${t("plan.discount")}</th><th style="text-align:end">${t("bill.amount", { cur: currency })}</th></tr></thead><tbody>${rows}</tbody><tfoot>${sum(t("bill.subtotal"), money(inv.totals.subtotal, lang))}${Number(inv.discount) ? sum(t("bill.invoiceDiscount"), `−${money(inv.discount, lang)}`) : ""}${Number(inv.totals.tax) ? sum(t("bill.tax", { rate: inv.tax_rate }), money(inv.totals.tax, lang)) : ""}${sum(t("bill.total"), money(inv.totals.total, lang), true)}${sum(t("bill.paid"), money(inv.totals.paid, lang))}${sum(t("bill.balance"), money(inv.totals.balance, lang), true)}</tfoot></table>${inv.status === "void" ? `<p><strong>${escapeHtml(t("bill.voidStamp"))}</strong> ${escapeHtml(inv.void_reason)}</p>` : ""}${inv.notes ? `<p class="body">${escapeHtml(inv.notes)}</p>` : ""}`,
      footer: "",
    });
  };

  const receipt = (p: Payment) => {
    printDocument({
      title: `${t("bill.receipt")} ${p.receipt_number}`,
      lang,
      clinic: letterhead,
      patient: patientText(p.patient_info, p.paid_on),
      body: `<table><tbody>
<tr><th>${t("bill.amount", { cur: currency })}</th><td style="font-size:20px;font-weight:600">${money(p.amount, lang)}</td></tr>
<tr><th>${t("bill.method")}</th><td>${escapeHtml(t(`pay.${p.method}` as TKey))}${p.reference ? ` · <span dir="ltr">${escapeHtml(p.reference)}</span>` : ""}</td></tr>
${p.invoice_number ? `<tr><th>${t("bill.forInvoice")}</th><td>${escapeHtml(p.invoice_number)}${p.installment_number ? ` · ${escapeHtml(t("bill.installmentN", { n: p.installment_number }))}` : ""}</td></tr>` : `<tr><th>${t("bill.forInvoice")}</th><td>${escapeHtml(t("bill.onAccount"))}</td></tr>`}
${p.notes ? `<tr><th>${t("notes")}</th><td>${escapeHtml(p.notes)}</td></tr>` : ""}
</tbody></table>`,
      footer: `<div class="sign"><span></span><div class="line">${escapeHtml(t("bill.receivedBy", { name: p.received_by }))}</div></div>`,
    });
  };
  return { invoice, receipt };
}

/* -------------------------------------------------------- new invoice */

export function InvoiceDialog({ patient, onClose, onSaved }: { patient: BillingPatient; onClose: () => void; onSaved: (inv: Invoice) => void }) {
  const { t, lang } = useI18n();
  const currency = useCurrency();
  const [lines, setLines] = useState<BillableLine[] | null>(null);
  const [chosen, setChosen] = useState<number[]>([]);
  const [extras, setExtras] = useState<{ description: string; unit_price: string }[]>([]);
  const [discount, setDiscount] = useState("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    get<BillableLine[]>(`/api/billing/invoices/billable/?patient=${patient.id}`)
      .then((rows) => {
        setLines(rows);
        // Done work is what is usually billed; planned work can be added as a deposit.
        setChosen(rows.filter((r) => r.status === "done").map((r) => r.id));
      })
      .catch((err) => {
        setLines([]);
        setError(errorText(err));
      });
  }, [patient.id]);

  const subtotal =
    (lines ?? []).filter((l) => chosen.includes(l.id)).reduce((s, l) => s + Number(l.net), 0) +
    extras.reduce((s, e) => s + (Number(e.unit_price) || 0), 0);
  const total = subtotal - (Number(discount) || 0);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const inv = await post<Invoice>("/api/billing/invoices/", {
        patient: patient.id,
        plan_lines: chosen,
        extra_lines: extras.filter((x) => x.description.trim()).map((x) => ({ description: x.description, unit_price: x.unit_price || "0" })),
        discount: discount || "0",
        notes,
      });
      onSaved(inv);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={`${t("bill.newInvoice")} · ${personName(patient, lang)}`} onClose={onClose}>
      <form className="form-grid" onSubmit={submit}>
        <fieldset className="field">
          <legend>{t("bill.fromPlan")}</legend>
          {lines === null ? (
            <p className="muted">{t("loading")}</p>
          ) : lines.length === 0 ? (
            <p className="muted small">{t("bill.nothingToBill")}</p>
          ) : (
            <div className="line-checks bill-lines">
              {lines.map((l) => (
                <label key={l.id} className="check">
                  <input type="checkbox" checked={chosen.includes(l.id)} onChange={(e) => setChosen((c) => (e.target.checked ? [...c, l.id] : c.filter((x) => x !== l.id)))} />
                  <span className="grow">
                    {(lang === "ar" ? l.procedure_name_ar || l.procedure_name_en : l.procedure_name_en || l.procedure_name_ar)}
                    {l.tooth ? ` · ${t("tooth.label", { n: l.tooth })}` : ""}
                    <span className="muted small"> · {t(`line.status.${l.status}` as TKey)} · {personName(l.dentist, lang)}</span>
                  </span>
                  <span className="num">{money(l.net, lang)}</span>
                </label>
              ))}
            </div>
          )}
        </fieldset>
        <fieldset className="field">
          <legend>{t("bill.otherItems")}</legend>
          {extras.map((x, i) => (
            <div key={i} className="extra-row">
              <input aria-label={t("bill.item")} placeholder={t("bill.itemPh")} value={x.description} onChange={(e) => setExtras((rows) => rows.map((r, j) => (j === i ? { ...r, description: e.target.value } : r)))} />
              <input aria-label={t("plan.price")} type="number" min="0" step="0.01" dir="ltr" placeholder="0" value={x.unit_price} onChange={(e) => setExtras((rows) => rows.map((r, j) => (j === i ? { ...r, unit_price: e.target.value } : r)))} />
              <button type="button" className="btn btn-small" aria-label={t("rx.remove")} onClick={() => setExtras((rows) => rows.filter((_, j) => j !== i))}>
                <Icon name="close" size={16} />
              </button>
            </div>
          ))}
          <button type="button" className="btn btn-small" onClick={() => setExtras((rows) => [...rows, { description: "", unit_price: "" }])}>
            <Icon name="plus" size={16} /> {t("bill.addItem")}
          </button>
        </fieldset>
        <div className="form-grid form-grid-2">
          <label className="field">
            <span>{t("bill.invoiceDiscount")}</span>
            <input type="number" min="0" step="0.01" dir="ltr" value={discount} onChange={(e) => setDiscount(e.target.value)} />
          </label>
          <label className="field">
            <span>{t("notes")}</span>
            <input value={notes} onChange={(e) => setNotes(e.target.value)} />
          </label>
        </div>
        <p className="bill-total">
          {t("bill.total")} <strong className="num">{money(total, lang)} {currency}</strong>
        </p>
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="form-actions">
          <button type="button" className="btn" onClick={onClose}>{t("cancel")}</button>
          <button type="submit" className="btn btn-primary" disabled={busy || total < 0 || (!chosen.length && !extras.some((x) => x.description.trim()))}>
            {t("bill.issue")}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/* ------------------------------------------------------------ payment */

export function PaymentDialog({
  patient,
  invoices,
  invoiceId,
  installmentId,
  onClose,
  onSaved,
}: {
  patient: BillingPatient;
  invoices: Invoice[];
  invoiceId?: number;
  installmentId?: number;
  onClose: () => void;
  onSaved: (p: Payment) => void;
}) {
  const { t, lang } = useI18n();
  const currency = useCurrency();
  const open = invoices.filter((i) => i.status === "issued" && Number(i.totals.balance) > 0);
  const [invoice, setInvoice] = useState<number | null>(invoiceId ?? open[0]?.id ?? null);
  const inv = open.find((i) => i.id === invoice);
  const unpaid = inv?.installments.filter((i) => Number(i.remaining) > 0) ?? [];
  const [installment, setInstallment] = useState<number | null>(installmentId ?? null);
  const inst = unpaid.find((i) => i.id === installment);
  const [amount, setAmount] = useState(() => {
    const start = open.find((i) => i.id === (invoiceId ?? open[0]?.id));
    const startInst = start?.installments.find((i) => i.id === installmentId);
    return startInst ? startInst.remaining : start ? start.totals.balance : "";
  });
  const [method, setMethod] = useState<PayMethod>("cash");
  const [reference, setReference] = useState("");
  const [notes, setNotes] = useState("");
  const [paidOn, setPaidOn] = useState(today());
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const pickInvoice = (id: number | null) => {
    setInvoice(id);
    setInstallment(null);
    const chosen = open.find((i) => i.id === id);
    setAmount(chosen ? chosen.totals.balance : "");
  };
  const pickInstallment = (id: number | null) => {
    setInstallment(id);
    const chosen = unpaid.find((i) => i.id === id);
    setAmount(chosen ? chosen.remaining : inv?.totals.balance ?? "");
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      onSaved(
        await post<Payment>("/api/billing/payments/", { patient: patient.id, invoice, installment, amount, method, reference, notes, paid_on: paidOn }),
      );
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={`${t("bill.receive")} · ${personName(patient, lang)}`} onClose={onClose}>
      <form className="form-grid" onSubmit={submit}>
        <label className="field">
          <span>{t("bill.forInvoice")}</span>
          <select value={invoice ?? ""} onChange={(e) => pickInvoice(Number(e.target.value) || null)}>
            {open.map((i) => (
              <option key={i.id} value={i.id}>{`${i.number} · ${t("bill.balanceOf", { n: money(i.totals.balance, lang) })}`}</option>
            ))}
            <option value="">{t("bill.onAccount")}</option>
          </select>
        </label>
        {unpaid.length > 0 && (
          <label className="field">
            <span>{t("bill.installment")}</span>
            <select value={installment ?? ""} onChange={(e) => pickInstallment(Number(e.target.value) || null)}>
              <option value="">{t("bill.anyAmount")}</option>
              {unpaid.map((i) => (
                <option key={i.id} value={i.id}>{`${t("bill.installmentN", { n: i.number })} · ${fmtDate(i.due_date, lang)} · ${money(i.remaining, lang)}`}</option>
              ))}
            </select>
          </label>
        )}
        <div className="field">
          <span className="field-label">{t("bill.method")}</span>
          <div className="method-picker" role="radiogroup" aria-label={t("bill.method")}>
            {METHODS.map((m) => (
              <button key={m} type="button" role="radio" aria-checked={method === m} className={`method ${method === m ? "active" : ""}`} onClick={() => setMethod(m)}>
                <Icon name={m === "cash" ? "cash" : m === "card" ? "receipt" : "wallet"} size={18} />
                {t(`pay.${m}` as TKey)}
              </button>
            ))}
          </div>
        </div>
        <div className="form-grid form-grid-2">
          <label className="field">
            <span>{t("bill.amount", { cur: currency })}</span>
            <input className="amount-input" required type="number" min="0.01" step="0.01" dir="ltr" value={amount} onChange={(e) => setAmount(e.target.value)} max={inst ? inst.remaining : inv ? inv.totals.balance : undefined} />
          </label>
          <label className="field">
            <span>{t("note.date")}</span>
            <input type="date" required value={paidOn} onChange={(e) => setPaidOn(e.target.value)} />
          </label>
          {method !== "cash" && (
            <label className="field">
              <span>{t("bill.reference")}</span>
              <input dir="ltr" value={reference} placeholder={t("bill.referencePh")} onChange={(e) => setReference(e.target.value)} />
            </label>
          )}
          <label className="field">
            <span>{t("notes")}</span>
            <input value={notes} onChange={(e) => setNotes(e.target.value)} />
          </label>
        </div>
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="form-actions">
          <button type="button" className="btn" onClick={onClose}>{t("cancel")}</button>
          <button type="submit" className="btn btn-primary" disabled={busy}>{t("bill.saveReceipt")}</button>
        </div>
      </form>
    </Modal>
  );
}

/* ------------------------------------------------------- invoice view */

export function InvoiceView({ invoice, onClose, onChanged }: { invoice: Invoice; onClose: () => void; onChanged: (inv?: Invoice) => void }) {
  const { t, lang } = useI18n();
  const { can } = useAuth();
  const currency = useCurrency();
  const print = usePrintBilling();
  const [current, setCurrent] = useState(invoice);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [paying, setPaying] = useState<{ installment?: number } | null>(null);
  const [splitting, setSplitting] = useState(false);
  const [error, setError] = useState("");

  const reload = async () => {
    const [inv, pays] = await Promise.all([get<Invoice>(`/api/billing/invoices/${invoice.id}/`), get<{ results: Payment[] }>(`/api/billing/payments/?invoice=${invoice.id}`)]);
    setCurrent(inv);
    setPayments(pays.results);
    onChanged(inv);
  };
  useEffect(() => {
    get<{ results: Payment[] }>(`/api/billing/payments/?invoice=${invoice.id}`).then((r) => setPayments(r.results)).catch(() => undefined);
  }, [invoice.id]);

  const voidIt = async (kind: "invoice" | "payment", id: number) => {
    const reason = window.prompt(t("bill.voidReason"));
    if (!reason) return;
    try {
      await post(`/api/billing/${kind === "invoice" ? "invoices" : "payments"}/${id}/void/`, { reason });
      await reload();
    } catch (err) {
      setError(errorText(err));
    }
  };

  const inv = current;
  const open = inv.status === "issued" && Number(inv.totals.balance) > 0;
  return (
    <Modal title={`${t("bill.invoice")} ${inv.number}`} onClose={onClose}>
      <div className="invoice-view">
        <div className="invoice-head">
          <div>
            <p className="strong">{personName(inv.patient_info, lang)} <span className="muted mono small">{inv.patient_info.file_number}</span></p>
            <p className="muted small">{fmtDate(inv.issue_date, lang)}</p>
          </div>
          <span className={PAY_PILL[inv.payment_status]}>{t(`bill.status.${inv.payment_status}` as TKey)}</span>
        </div>
        <div className="table-wrap">
          <table className="plan-table">
            <thead>
              <tr>
                <th>{t("bill.item")}</th>
                <th className="num">{t("bill.amount", { cur: currency })}</th>
              </tr>
            </thead>
            <tbody>
              {inv.lines.map((l) => (
                <tr key={l.id}>
                  <td>
                    {l.description}
                    {l.tooth ? <span className="muted"> · {t("tooth.label", { n: l.tooth })}</span> : null}
                    {l.quantity > 1 && <span className="muted"> × {l.quantity}</span>}
                    {l.dentist_name && <p className="muted small">{personName(l.dentist_name, lang)}</p>}
                  </td>
                  <td className="num">
                    {money(l.total, lang)}
                    {Number(l.discount) > 0 && <p className="muted small">{t("plan.discountOf", { n: money(l.discount, lang) })}</p>}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              {Number(inv.discount) > 0 && (
                <tr><td>{t("bill.invoiceDiscount")}</td><td className="num">−{money(inv.discount, lang)}</td></tr>
              )}
              {Number(inv.totals.tax) > 0 && (
                <tr><td>{t("bill.tax", { rate: inv.tax_rate })}</td><td className="num">{money(inv.totals.tax, lang)}</td></tr>
              )}
              <tr className="strong"><td>{t("bill.total")}</td><td className="num">{money(inv.totals.total, lang)}</td></tr>
              <tr><td>{t("bill.paid")}</td><td className="num">{money(inv.totals.paid, lang)}</td></tr>
              <tr className="strong"><td>{t("bill.balance")}</td><td className="num">{money(inv.totals.balance, lang)}</td></tr>
            </tfoot>
          </table>
        </div>
        {inv.status === "void" && <p className="notice">{t("bill.voidedBecause", { reason: inv.void_reason })}</p>}

        {inv.installments.length > 0 && (
          <section className="subsection">
            <h3>{t("bill.installments")}</h3>
            <ul className="plain-list inst-list">
              {inv.installments.map((i) => (
                <li key={i.id}>
                  <span className="mono">{i.number}</span>
                  <span className="grow">{fmtDate(i.due_date, lang)}</span>
                  <span className="num">{money(i.amount, lang)}</span>
                  <span className={INST_PILL[i.status]}>{t(`inst.${i.status}` as TKey)}</span>
                  {Number(i.remaining) > 0 && inv.status === "issued" && can("billing", "create") && (
                    <button className="btn btn-small" onClick={() => setPaying({ installment: i.id })}>{t("bill.pay")}</button>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}

        <section className="subsection">
          <h3>{t("bill.payments")}</h3>
          {payments.length === 0 ? (
            <p className="muted small">{t("bill.noPayments")}</p>
          ) : (
            <ul className="plain-list inst-list">
              {payments.map((p) => (
                <li key={p.id} className={p.voided_at ? "is-void" : ""}>
                  <span className="mono small">{p.receipt_number}</span>
                  <span className="grow">{`${fmtDate(p.paid_on, lang)} · ${t(`pay.${p.method}` as TKey)}`}{p.voided_at && <span className="muted"> · {t("bill.voided")}</span>}</span>
                  <span className="num">{money(p.amount, lang)}</span>
                  <button className="btn btn-small" onClick={() => print.receipt(p)}>{t("print")}</button>
                  {!p.voided_at && can("billing", "delete") && (
                    <button className="btn btn-small" onClick={() => void voidIt("payment", p.id)}>{t("bill.void")}</button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="form-actions">
          {inv.status === "issued" && Number(inv.totals.paid) === 0 && can("billing", "delete") && (
            <button className="btn" onClick={() => void voidIt("invoice", inv.id)}>{t("bill.voidInvoice")}</button>
          )}
          {open && can("billing", "edit") && <button className="btn" onClick={() => setSplitting(true)}>{t("bill.splitInstallments")}</button>}
          <button className="btn" onClick={() => print.invoice(inv)}>{t("print")}</button>
          {open && can("billing", "create") && (
            <button className="btn btn-primary" onClick={() => setPaying({})}>{t("bill.receive")}</button>
          )}
        </div>
      </div>
      {paying && (
        <PaymentDialog
          patient={inv.patient_info}
          invoices={[inv]}
          invoiceId={inv.id}
          installmentId={paying.installment}
          onClose={() => setPaying(null)}
          onSaved={(p) => {
            setPaying(null);
            void reload();
            print.receipt(p);
          }}
        />
      )}
      {splitting && (
        <InstallmentDialog
          invoice={inv}
          onClose={() => setSplitting(false)}
          onSaved={() => {
            setSplitting(false);
            void reload();
          }}
        />
      )}
    </Modal>
  );
}

function InstallmentDialog({ invoice, onClose, onSaved }: { invoice: Invoice; onClose: () => void; onSaved: () => void }) {
  const { t, lang } = useI18n();
  const [count, setCount] = useState(3);
  const [every, setEvery] = useState(1);
  const [first, setFirst] = useState(today());
  const [error, setError] = useState("");
  const balance = Number(invoice.totals.balance);
  const share = Math.floor(balance / count);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await post(`/api/billing/invoices/${invoice.id}/installments/`, { count, every_months: every, first_due: first });
      onSaved();
    } catch (err) {
      setError(errorText(err));
    }
  };
  return (
    <Modal title={t("bill.splitInstallments")} onClose={onClose}>
      <form className="form-grid" onSubmit={submit}>
        <p>{t("bill.splitIntro", { n: money(balance, lang) })}</p>
        <div className="form-grid form-grid-3">
          <label className="field">
            <span>{t("bill.count")}</span>
            <input type="number" min="1" max="36" value={count} onChange={(e) => setCount(Math.max(1, Number(e.target.value) || 1))} />
          </label>
          <label className="field">
            <span>{t("bill.everyMonths")}</span>
            <input type="number" min="1" max="12" value={every} onChange={(e) => setEvery(Math.max(1, Number(e.target.value) || 1))} />
          </label>
          <label className="field">
            <span>{t("bill.firstDue")}</span>
            <input type="date" value={first} onChange={(e) => setFirst(e.target.value)} />
          </label>
        </div>
        <p className="muted">{t("bill.splitPreview", { count, n: money(share, lang), last: money(balance - share * (count - 1), lang) })}</p>
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="form-actions">
          <button type="button" className="btn" onClick={onClose}>{t("cancel")}</button>
          <button type="submit" className="btn btn-primary">{t("save")}</button>
        </div>
      </form>
    </Modal>
  );
}
