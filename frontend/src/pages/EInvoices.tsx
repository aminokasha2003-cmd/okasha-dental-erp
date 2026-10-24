import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { get, patch, post, type Page } from "../api";
import { useAuth } from "../auth";
import { useI18n, type TKey } from "../i18n";
import { Modal } from "../components/Crud";
import { Icon } from "../components/Icon";
import { qrSvg } from "../components/qr";
import { fmtDate, money } from "../format";
import { errorText, useCurrency } from "./BillingParts";
import { Empty, Segmented, StatePill, fmtDateTime, nm } from "./ComplianceParts";
import type { EDocument, EInvoiceSettings, EStatus, ItemCodeRow } from "./ComplianceTypes";

type Tab = "queue" | "months" | "codes" | "settings";
type DocPage = Page<EDocument> & { counts: Record<string, number>; mode: "simulation" | "live"; registered: boolean };
const FILTERS = ["", "ready", "invalid", "draft", "submitted", "valid", "cancelled", "needs_cancel"] as const;
type Filter = (typeof FILTERS)[number];

export function etaStatusLabel(s: string, t: (k: TKey) => string) {
  return t(`eta.st.${s}` as TKey);
}

/** Tax Authority e-invoices: what is waiting, what was accepted, item codes and the connection settings. */
export function EInvoices() {
  const { t } = useI18n();
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const tab = (params.get("tab") as Tab) || "queue";
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [mode, setMode] = useState<{ mode: string; registered: boolean } | null>(null);
  const tabs: { id: Tab; label: TKey; show: boolean }[] = [
    { id: "queue", label: "eta.tab.queue", show: true },
    { id: "months", label: "eta.tab.months", show: true },
    { id: "codes", label: "eta.tab.codes", show: true },
    { id: "settings", label: "eta.tab.settings", show: true },
  ];
  const stats: { label: TKey; n: number; tone?: string; f: Filter }[] = [
    { label: "eta.hero.ready", n: counts.ready ?? 0, tone: counts.ready ? "accent" : "", f: "ready" },
    { label: "eta.hero.invalid", n: (counts.invalid ?? 0) + (counts.rejected ?? 0), tone: counts.invalid || counts.rejected ? "warn" : "", f: "invalid" },
    { label: "eta.hero.submitted", n: counts.submitted ?? 0, f: "submitted" },
    { label: "eta.hero.valid", n: counts.valid ?? 0, f: "valid" },
    { label: "eta.hero.needsCancel", n: counts.needs_cancel ?? 0, tone: counts.needs_cancel ? "warn" : "", f: "needs_cancel" },
  ];
  return (
    <div className="page">
      <section className="lab-hero co-hero eta-hero">
        <div>
          <h1>{t("eta.title")}</h1>
          <p>{t("eta.heroSub")}</p>
          {mode && (
            <span className={`co-mode ${mode.mode}`}>
              <Icon name={mode.mode === "live" ? "globe" : "shield"} size={14} />
              {!mode.registered ? t("eta.notRegistered") : mode.mode === "live" ? t("eta.modeLive") : t("eta.modeSim")}
            </span>
          )}
        </div>
        <div className="lab-hero-stats">
          {stats.map((x) => (
            <button key={x.label} className={`lab-hero-stat ${x.tone ?? ""}`} onClick={() => setParams({ tab: "queue", status: x.f }, { replace: true })}>
              <strong>{x.n}</strong>
              <span>{t(x.label)}</span>
            </button>
          ))}
        </div>
      </section>
      <div className="segmented tabs" role="tablist">
        {tabs.filter((x) => x.show).map((x) => (
          <button key={x.id} role="tab" aria-selected={tab === x.id} className={tab === x.id ? "active" : ""} onClick={() => setParams({ tab: x.id }, { replace: true })}>
            {t(x.label)}
          </button>
        ))}
      </div>
      {tab === "queue" && <EInvoiceQueue initialStatus={(params.get("status") as Filter) || ""} onCounts={(c, m) => { setCounts(c); setMode(m); }} />}
      {tab === "months" && <Months />}
      {tab === "codes" && <ItemCodes canEdit={can("einvoice", "edit")} />}
      {tab === "settings" && <SettingsForm canEdit={can("einvoice", "approve")} onSaved={() => setMode(null)} />}
    </div>
  );
}

function thisMonth() {
  return new Date().toLocaleDateString("en-CA").slice(0, 7);
}

export function EInvoiceQueue({ initialStatus, onCounts }: { initialStatus: Filter; onCounts?: (c: Record<string, number>, m: { mode: string; registered: boolean }) => void }) {
  const { t, lang } = useI18n();
  const { can } = useAuth();
  const currency = useCurrency();
  const [status, setStatus] = useState<Filter>(initialStatus);
  const [month, setMonth] = useState("");
  const [search, setSearch] = useState("");
  const [pageNo, setPageNo] = useState(1);
  const [data, setData] = useState<DocPage | null>(null);
  const [viewing, setViewing] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  useEffect(() => setStatus(initialStatus), [initialStatus]);
  const load = useCallback(() => {
    const q = new URLSearchParams({ page: String(pageNo) });
    if (status) q.set("status", status === "invalid" ? "invalid,rejected" : status);
    if (month) q.set("month", month);
    if (search.trim()) q.set("search", search.trim());
    get<DocPage>(`/api/compliance/einvoice/documents/?${q}`)
      .then((d) => {
        setData(d);
        onCounts?.(d.counts, { mode: d.mode, registered: d.registered });
      })
      .catch(() => setData(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, month, search, pageNo]);
  useEffect(() => {
    const timer = window.setTimeout(load, search ? 250 : 0);
    return () => window.clearTimeout(timer);
  }, [load, search]);
  const submitReady = async () => {
    setBusy(true);
    setNote("");
    try {
      const r = await post<Record<string, number>>("/api/compliance/einvoice/documents/submit-ready/", {});
      setNote(t("eta.sentResult", { sent: r.sent ?? 0, valid: r.valid ?? 0, invalid: (r.invalid ?? 0) + (r.rejected ?? 0) }));
      load();
    } catch (err) {
      setNote(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  const c = data?.counts ?? {};
  const n = (f: Filter) => (f === "" ? Object.entries(c).filter(([k]) => k !== "needs_cancel").reduce((a, [, v]) => a + v, 0) : f === "invalid" ? (c.invalid ?? 0) + (c.rejected ?? 0) : c[f] ?? 0);
  const pages = data ? Math.max(1, Math.ceil(data.count / 25)) : 1;
  return (
    <section className="card">
      <header className="card-head co-queue-head">
        <Segmented
          value={status}
          onChange={(v) => { setStatus(v); setPageNo(1); }}
          label={t("lab.show")}
          options={FILTERS.filter((f) => ["", "ready", "invalid", "valid"].includes(f) || n(f) > 0 || f === status).map((f) => ({ id: f, label: f ? etaStatusLabel(f, t) : t("eta.all"), n: n(f), warn: f === "invalid" || f === "needs_cancel" }))}
        />
        {can("einvoice", "approve") && (
          <button className="btn btn-primary" disabled={busy || !c.ready} onClick={() => void submitReady()}>
            <Icon name="upload" size={18} /> {busy ? t("eta.sending") : t("eta.submitReady", { n: Math.min(c.ready ?? 0, 100) })}
          </button>
        )}
      </header>
      <div className="toolbar pad-s">
        <label className="top-search search-field">
          <Icon name="search" />
          <input type="search" aria-label={t("search")} placeholder={t("eta.searchHint")} value={search} onChange={(e) => { setSearch(e.target.value); setPageNo(1); }} />
        </label>
        <label className="field inline">
          <span>{t("eta.month")}</span>
          <input type="month" value={month} max={thisMonth()} onChange={(e) => { setMonth(e.target.value); setPageNo(1); }} />
        </label>
        {month && <button className="btn btn-small" onClick={() => setMonth("")}>{t("eta.anyMonth")}</button>}
      </div>
      {data?.mode === "simulation" && data.registered && <p className="notice pad-s co-sim-note"><Icon name="shield" size={16} /> {t("eta.simNote")}</p>}
      {note && <p className="notice pad-s" role="status">{note}</p>}
      {data === null ? <Empty text="loading" /> : data.results.length === 0 ? <Empty text={data.registered ? "noRecords" : "eta.registerFirst"} /> : (
        <>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{t("bill.invoice")}</th>
                  <th>{t("co.date")}</th>
                  <th>{t("eta.receiver")}</th>
                  <th className="num">{t("bill.amount", { cur: currency })}</th>
                  <th>{t("plan.status")}</th>
                  <th>{t("eta.uuid")}</th>
                </tr>
              </thead>
              <tbody>
                {data.results.map((d) => (
                  <tr key={d.id} className="row-link" onClick={() => setViewing(d.id)}>
                    <td className="mono small">{d.invoice_info.number}{d.invoice_info.status === "void" && <span className="pill pill-muted tiny">{t("eta.void")}</span>}</td>
                    <td className="nowrap">{fmtDate(d.invoice_info.issue_date, lang)}</td>
                    <td>{nm(d.invoice_info.patient, lang)}<span className="muted small block">{d.receiver_type === "B" ? t("eta.business") : t("eta.person")} · {nm(d.invoice_info.branch, lang)}</span></td>
                    <td className="num">{money(d.total_amount, lang)}</td>
                    <td>
                      <StatePill state={d.status} label={etaStatusLabel(d.status, t)} />
                      {d.needs_cancel && <span className="pill pill-warn tiny">{t("eta.st.needs_cancel")}</span>}
                      {d.errors.length > 0 && <span className="muted small block co-clip">{d.errors[0]}</span>}
                    </td>
                    <td className="mono small co-uuid" dir="ltr">{d.uuid || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {pages > 1 && (
            <div className="pager">
              <button className="btn btn-small" disabled={pageNo <= 1} onClick={() => setPageNo((p) => p - 1)}>{t("co.prev")}</button>
              <span className="muted small">{t("co.pageOf", { n: pageNo, total: pages })}</span>
              <button className="btn btn-small" disabled={pageNo >= pages} onClick={() => setPageNo((p) => p + 1)}>{t("co.next")}</button>
            </div>
          )}
        </>
      )}
      {viewing !== null && <DocView id={viewing} onClose={() => setViewing(null)} onChanged={load} />}
    </section>
  );
}

function DocView({ id, onClose, onChanged }: { id: number; onClose: () => void; onChanged: () => void }) {
  const { t, lang } = useI18n();
  const { can } = useAuth();
  const currency = useCurrency();
  const [d, setD] = useState<EDocument | null>(null);
  const [error, setError] = useState("");
  const [reason, setReason] = useState("");
  const [showJson, setShowJson] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    get<EDocument>(`/api/compliance/einvoice/documents/${id}/`).then(setD).catch((err) => setError(errorText(err)));
  }, [id]);
  const run = async (path: string, body: unknown = {}) => {
    setError("");
    setBusy(true);
    try {
      await post(`/api/compliance/einvoice/documents/${id}/${path}/`, body);
      setD(await get<EDocument>(`/api/compliance/einvoice/documents/${id}/`));
      onChanged();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  const qr = useMemo(() => (d?.url ? qrSvg(d.url, 132) : ""), [d?.url]);
  if (!d) return <Modal title={t("eta.document")} onClose={onClose}>{error ? <p className="form-error">{error}</p> : <Empty text="loading" />}</Modal>;
  return (
    <Modal title={`${t("eta.document")} · ${d.invoice_info.number}`} onClose={onClose}>
      <div className="co-cycle">
        <div className="invoice-head">
          <div>
            <p className="strong">{nm(d.invoice_info.patient, lang)} <span className="muted small mono">{d.invoice_info.patient.file_number}</span></p>
            <p className="muted small">{fmtDate(d.invoice_info.issue_date, lang)} · {nm(d.invoice_info.branch, lang)} · {d.receiver_type === "B" ? t("eta.business") : t("eta.person")}</p>
          </div>
          <StatePill state={d.status} label={etaStatusLabel(d.status, t)} />
        </div>
        {d.errors.length > 0 && (
          <div className="co-warnbox">
            <p className="strong">{t("eta.fixThese")}</p>
            <ul>{d.errors.map((e) => <li key={e}>{e}</li>)}</ul>
          </div>
        )}
        <div className="eta-doc-body">
          <dl className="co-facts">
            <div><dt>{t("bill.total")}</dt><dd className="strong">{money(d.total_amount, lang)} {currency}</dd></div>
            <div><dt>{t("eta.vat")}</dt><dd>{money(d.tax_amount, lang)} {currency}</dd></div>
            <div><dt>{t("eta.uuid")}</dt><dd className="mono small co-uuid" dir="ltr">{d.uuid || "—"}</dd></div>
            {d.submission_id && <div><dt>{t("eta.submission")}</dt><dd className="mono small" dir="ltr">{d.submission_id}</dd></div>}
            <div><dt>{t("eta.prepared")}</dt><dd>{fmtDateTime(d.prepared_at, lang)}</dd></div>
            {d.submitted_at && <div><dt>{t("eta.submittedAt")}</dt><dd>{fmtDateTime(d.submitted_at, lang)}</dd></div>}
            {d.validated_at && <div><dt>{t("eta.validatedAt")}</dt><dd>{fmtDateTime(d.validated_at, lang)}</dd></div>}
            {d.cancelled_at && <div><dt>{t("eta.cancelledAt")}</dt><dd>{fmtDateTime(d.cancelled_at, lang)} · {d.cancel_reason}</dd></div>}
            <div><dt>{t("eta.attempts")}</dt><dd>{d.attempts}</dd></div>
          </dl>
          {qr && (
            <figure className="eta-qr">
              <span dangerouslySetInnerHTML={{ __html: qr }} />
              <figcaption className="small">
                {d.simulated ? <span className="pill pill-muted tiny">{t("eta.simulated")}</span> : null}
                <a href={d.url} target="_blank" rel="noreferrer">{t("eta.openPortal")}</a>
              </figcaption>
            </figure>
          )}
        </div>
        {d.needs_cancel && <p className="notice pad-s">{t("eta.needsCancelHint")}</p>}
        <div className="form-actions co-doc-actions">
          <button className="btn btn-small" onClick={() => setShowJson((v) => !v)}>{showJson ? t("eta.hideJson") : t("eta.showJson")}</button>
          <span className="grow" />
          {["draft", "ready", "invalid", "rejected"].includes(d.status) && can("einvoice", "edit") && <button className="btn" disabled={busy} onClick={() => void run("rebuild")}>{t("eta.rebuild")}</button>}
          {d.status === "submitted" && <button className="btn" disabled={busy} onClick={() => void run("refresh")}>{t("eta.refresh")}</button>}
          {d.status === "ready" && can("einvoice", "approve") && <button className="btn btn-primary" disabled={busy} onClick={() => void run("send")}>{t("eta.send")}</button>}
        </div>
        {d.status === "valid" && can("einvoice", "approve") && (
          <section className="subsection">
            <h3>{t("eta.cancelTitle")}</h3>
            <p className="muted small">{t("eta.cancelHint")}</p>
            <div className="toolbar">
              <input aria-label={t("eta.cancelReason")} placeholder={t("eta.cancelReason")} value={reason} onChange={(e) => setReason(e.target.value)} className="grow" />
              <button className="btn" disabled={busy || !reason.trim()} onClick={() => void run("cancel", { reason })}>{t("eta.cancelDoc")}</button>
            </div>
          </section>
        )}
        {showJson && <pre className="co-json" dir="ltr">{JSON.stringify(d.payload ?? {}, null, 2)}</pre>}
        {error && <p className="form-error" role="alert">{error}</p>}
      </div>
    </Modal>
  );
}

function Months() {
  const { t, lang } = useI18n();
  const currency = useCurrency();
  const [year, setYear] = useState(new Date().getFullYear());
  const [rows, setRows] = useState<{ month: number; counts: Partial<Record<EStatus, number>>; total: string; tax: string }[] | null>(null);
  useEffect(() => {
    get<{ months: { month: number; counts: Partial<Record<EStatus, number>>; total: string; tax: string }[] }>(`/api/compliance/einvoice/documents/months/?year=${year}`)
      .then((r) => setRows(r.months))
      .catch(() => setRows([]));
  }, [year]);
  const monthName = (m: number) => new Date(year, m - 1, 15).toLocaleDateString(lang === "ar" ? "ar-EG" : "en-GB", { month: "long" });
  const cols: EStatus[] = ["valid", "ready", "invalid", "submitted", "draft", "cancelled"];
  const shown = (rows ?? []).filter((r) => Object.keys(r.counts).length);
  return (
    <section className="card">
      <header className="card-head">
        <h2>{t("eta.monthsTitle")}</h2>
        <div className="toolbar">
          <button className="btn btn-small" onClick={() => setYear((y) => y - 1)} aria-label={t("co.prev")}>‹</button>
          <strong className="num">{year}</strong>
          <button className="btn btn-small" disabled={year >= new Date().getFullYear()} onClick={() => setYear((y) => y + 1)} aria-label={t("co.next")}>›</button>
        </div>
      </header>
      {rows === null ? <Empty text="loading" /> : shown.length === 0 ? <Empty text="noRecords" /> : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{t("eta.month")}</th>
                {cols.map((c) => <th key={c} className="num">{etaStatusLabel(c, t)}</th>)}
                <th className="num">{t("eta.acceptedTotal", { cur: currency })}</th>
                <th className="num">{t("eta.vat")}</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.month}>
                  <td>{monthName(r.month)}</td>
                  {cols.map((c) => <td key={c} className={`num ${c === "invalid" && r.counts[c] ? "warn-text" : ""}`}>{r.counts[c] ?? "—"}</td>)}
                  <td className="num strong">{money(r.total, lang)}</td>
                  <td className="num">{money(r.tax, lang)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function ItemCodes({ canEdit }: { canEdit: boolean }) {
  const { t, lang } = useI18n();
  const [rows, setRows] = useState<ItemCodeRow[] | null>(null);
  const [changed, setChanged] = useState<Record<number, ItemCodeRow>>({});
  const [missingOnly, setMissingOnly] = useState(false);
  const [note, setNote] = useState("");
  const load = useCallback(() => {
    get<ItemCodeRow[]>("/api/compliance/einvoice/item-codes/").then((r) => { setRows(r); setChanged({}); }).catch(() => setRows([]));
  }, []);
  useEffect(load, [load]);
  const edit = (r: ItemCodeRow, k: keyof ItemCodeRow, v: string) => {
    const next = { ...r, ...(changed[r.procedure] ?? {}), [k]: v };
    setChanged((c) => ({ ...c, [r.procedure]: next }));
  };
  const save = async () => {
    setNote("");
    try {
      await post("/api/compliance/einvoice/item-codes/", { rows: Object.values(changed) });
      setNote(t("saved"));
      load();
    } catch (err) {
      setNote(errorText(err));
    }
  };
  const generate = async () => {
    setNote("");
    try {
      const r = await post<{ created: number }>("/api/compliance/einvoice/item-codes/", { generate: true });
      setNote(t("eta.generated", { n: r.created }));
      load();
    } catch (err) {
      setNote(errorText(err));
    }
  };
  const list = (rows ?? []).filter((r) => !missingOnly || !(changed[r.procedure] ?? r).item_code);
  const missing = (rows ?? []).filter((r) => !r.item_code).length;
  return (
    <section className="card">
      <header className="card-head">
        <div>
          <h2>{t("eta.codesTitle")}</h2>
          <p className="muted small">{t("eta.codesHint")}</p>
        </div>
        <div className="toolbar">
          <Segmented value={missingOnly ? "missing" : "all"} onChange={(v) => setMissingOnly(v === "missing")} label={t("lab.show")} options={[{ id: "all", label: t("eta.all"), n: rows?.length ?? 0 }, { id: "missing", label: t("eta.noCode"), n: missing, warn: true }]} />
          {canEdit && missing > 0 && <button className="btn" onClick={() => void generate()}>{t("eta.generate")}</button>}
          {canEdit && <button className="btn btn-primary" disabled={!Object.keys(changed).length} onClick={() => void save()}>{t("save")}</button>}
        </div>
      </header>
      {note && <p className="notice pad-s" role="status">{note}</p>}
      {rows === null ? <Empty text="loading" /> : list.length === 0 ? <Empty text="noRecords" /> : (
        <div className="table-wrap">
          <table className="co-codes">
            <thead>
              <tr>
                <th>{t("eta.procedure")}</th>
                <th>{t("eta.codeType")}</th>
                <th>{t("eta.itemCode")}</th>
                <th>{t("eta.unit")}</th>
              </tr>
            </thead>
            <tbody>
              {list.map((r0) => {
                const r = changed[r0.procedure] ?? r0;
                return (
                  <tr key={r.procedure} className={r.active ? "" : "muted"}>
                    <td>{nm(r.name, lang)}<span className="muted small block"><span className="mono">{r.code}</span> · {nm(r.category, lang)}</span></td>
                    <td>
                      <select aria-label={t("eta.codeType")} disabled={!canEdit} value={r.item_type || "EGS"} onChange={(e) => edit(r0, "item_type", e.target.value)}>
                        <option value="EGS">EGS</option>
                        <option value="GS1">GS1</option>
                      </select>
                    </td>
                    <td><input aria-label={t("eta.itemCode")} dir="ltr" className="mono" disabled={!canEdit} value={r.item_code} placeholder="EG-000000000-…" onChange={(e) => edit(r0, "item_code", e.target.value)} /></td>
                    <td><input aria-label={t("eta.unit")} dir="ltr" className="co-qty" disabled={!canEdit} value={r.unit_type} onChange={(e) => edit(r0, "unit_type", e.target.value)} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function SettingsForm({ canEdit, onSaved }: { canEdit: boolean; onSaved: () => void }) {
  const { t, lang } = useI18n();
  const [v, setV] = useState<EInvoiceSettings | null>(null);
  const [secret, setSecret] = useState("");
  const [msg, setMsg] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    get<EInvoiceSettings>("/api/compliance/einvoice/settings/").then(setV).catch((err) => setError(errorText(err)));
  }, []);
  if (!v) return <section className="card">{error ? <p className="form-error pad">{error}</p> : <Empty text="loading" />}</section>;
  const set = <K extends keyof EInvoiceSettings>(k: K, value: EInvoiceSettings[K]) => setV((s) => (s ? { ...s, [k]: value } : s));
  const setBranch = (i: number, k: string, value: string) => setV((s) => (s ? { ...s, branches: s.branches.map((b, j) => (j === i ? { ...b, [k]: value } : b)) } : s));
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    setMsg("");
    try {
      const body: Record<string, unknown> = { ...v };
      delete body.has_secret;
      delete body.live_ready;
      if (secret) body.client_secret = secret;
      else delete body.client_secret;
      if (!body.start_date) body.start_date = null;
      const saved = await patch<EInvoiceSettings>("/api/compliance/einvoice/settings/", body);
      setV(saved);
      setSecret("");
      setMsg(t("saved"));
      onSaved();
    } catch (err) {
      setError(errorText(err));
    }
  };
  const text = (k: keyof EInvoiceSettings, label: TKey, opts: { ltr?: boolean; hint?: TKey; type?: string } = {}) => (
    <div className="field">
      <label htmlFor={`eta-${k}`}>{t(label)}</label>
      <input id={`eta-${k}`} type={opts.type ?? "text"} dir={opts.ltr ? "ltr" : undefined} disabled={!canEdit} value={String(v[k] ?? "")} onChange={(e) => set(k, e.target.value as never)} />
      {opts.hint && <small className="field-hint">{t(opts.hint)}</small>}
    </div>
  );
  return (
    <form className="co-settings" onSubmit={submit}>
      <section className="card pad">
        <h2>{t("eta.set.registration")}</h2>
        <div className="field field-check">
          <input id="eta-reg" type="checkbox" disabled={!canEdit} checked={v.is_registered} onChange={(e) => set("is_registered", e.target.checked)} />
          <label htmlFor="eta-reg">{t("eta.set.registered")}</label>
        </div>
        <div className="form-grid form-grid-2">
          {text("rin", "eta.set.rin", { ltr: true, hint: "eta.set.rinHint" })}
          {text("issuer_name", "eta.set.issuerName")}
          {text("activity_code", "eta.set.activity", { ltr: true, hint: "eta.set.activityHint" })}
          {text("start_date", "eta.set.startDate", { type: "date", hint: "eta.set.startHint" })}
        </div>
      </section>
      <section className="card pad">
        <h2>{t("eta.set.tax")}</h2>
        <div className="form-grid form-grid-2">
          {text("default_tax_rate", "eta.set.rate", { ltr: true, hint: "eta.set.rateHint" })}
          {text("person_id_threshold", "eta.set.threshold", { ltr: true, hint: "eta.set.thresholdHint" })}
          {text("exempt_subtype", "eta.set.exempt", { ltr: true })}
          {text("taxed_subtype", "eta.set.taxed", { ltr: true })}
          {text("default_item_type", "eta.set.defType", { ltr: true })}
          {text("default_item_code", "eta.set.defCode", { ltr: true, hint: "eta.set.defCodeHint" })}
        </div>
      </section>
      <section className="card pad">
        <h2>{t("eta.set.address")}</h2>
        <p className="muted small">{t("eta.set.addressHint")}</p>
        <div className="form-grid form-grid-2">
          {text("governate", "eta.set.governate")}
          {text("region_city", "eta.set.city")}
          {text("street", "eta.set.street")}
          {text("building_number", "eta.set.building", { ltr: true })}
          {text("postal_code", "eta.set.postal", { ltr: true })}
        </div>
        <div className="table-wrap">
          <table className="co-branch-addr">
            <thead>
              <tr>
                <th>{t("co.branch")}</th>
                <th>{t("eta.set.branchCode")}</th>
                <th>{t("eta.set.governate")}</th>
                <th>{t("eta.set.city")}</th>
                <th>{t("eta.set.street")}</th>
                <th>{t("eta.set.building")}</th>
              </tr>
            </thead>
            <tbody>
              {v.branches.map((b, i) => (
                <tr key={b.branch}>
                  <td>{nm(b.branch_name, lang)}</td>
                  {(["branch_code", "governate", "region_city", "street", "building_number"] as const).map((k) => (
                    <td key={k}><input aria-label={t(k === "branch_code" ? "eta.set.branchCode" : "eta.set.street")} disabled={!canEdit} dir={k === "branch_code" || k === "building_number" ? "ltr" : undefined} value={b[k]} onChange={(e) => setBranch(i, k, e.target.value)} /></td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section className="card pad">
        <h2>{t("eta.set.connection")}</h2>
        <div className="form-grid form-grid-2">
          <div className="field">
            <label htmlFor="eta-mode">{t("eta.set.mode")}</label>
            <select id="eta-mode" disabled={!canEdit} value={v.mode} onChange={(e) => set("mode", e.target.value as EInvoiceSettings["mode"])}>
              <option value="simulation">{t("eta.set.modeSim")}</option>
              <option value="live">{t("eta.set.modeLive")}</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="eta-env">{t("eta.set.env")}</label>
            <select id="eta-env" disabled={!canEdit} value={v.environment} onChange={(e) => set("environment", e.target.value as EInvoiceSettings["environment"])}>
              <option value="preprod">{t("eta.set.preprod")}</option>
              <option value="prod">{t("eta.set.prod")}</option>
            </select>
          </div>
          {text("client_id", "eta.set.clientId", { ltr: true })}
          <div className="field">
            <label htmlFor="eta-secret">{t("eta.set.secret")}</label>
            <input id="eta-secret" type="password" autoComplete="new-password" dir="ltr" disabled={!canEdit} value={secret} placeholder={v.has_secret ? t("eta.set.secretSaved") : ""} onChange={(e) => setSecret(e.target.value)} />
            <small className="field-hint">{t("eta.set.secretHint")}</small>
          </div>
          {text("signer_url", "eta.set.signer", { ltr: true, hint: "eta.set.signerHint" })}
        </div>
        <p className={`notice pad-s ${v.live_ready ? "" : "co-sim-note"}`}>
          <Icon name={v.live_ready ? "globe" : "shield"} size={16} /> {v.live_ready ? t("eta.set.liveReady") : t("eta.set.simOnly")}
        </p>
      </section>
      {error && <p className="form-error" role="alert">{error}</p>}
      {msg && <p className="notice pad-s" role="status">{msg}</p>}
      {canEdit && (
        <div className="form-actions">
          <button className="btn btn-primary">{t("save")}</button>
        </div>
      )}
    </form>
  );
}
