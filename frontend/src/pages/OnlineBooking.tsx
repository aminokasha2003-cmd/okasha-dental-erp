import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { get, getAll, patch, post, type Page } from "../api";
import { useAuth } from "../auth";
import { useI18n, type TKey } from "../i18n";
import { Modal } from "../components/Crud";
import { Icon } from "../components/Icon";
import { qrSvg } from "../components/qr";
import { errorText } from "./BillingParts";
import { Empty, Segmented, StatePill, fmtDateTime, nm, useBranches } from "./ComplianceParts";
import type { BookingRequest, BookingSettings } from "./ComplianceTypes";

type Tab = "requests" | "settings";
type ReqPage = Page<BookingRequest> & { counts: Record<string, number> };

/** Requests from the public booking page, and the page's settings. */
export function OnlineBooking() {
  const { t } = useI18n();
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const tab = (params.get("tab") as Tab) || "requests";
  const [counts, setCounts] = useState<Record<string, number>>({});
  useEffect(() => {
    get<ReqPage>("/api/compliance/booking/requests/?status=pending").then((d) => setCounts(d.counts)).catch(() => undefined);
  }, []);
  return (
    <div className="page">
      <section className="lab-hero co-hero book-hero">
        <div>
          <h1>{t("ob.title")}</h1>
          <p>{t("ob.heroSub")}</p>
        </div>
        <div className="lab-hero-stats">
          <button className={`lab-hero-stat ${counts.pending ? "accent" : ""}`} onClick={() => setParams({ tab: "requests" }, { replace: true })}>
            <strong>{counts.pending ?? 0}</strong>
            <span>{t("ob.waiting")}</span>
          </button>
          <button className="lab-hero-stat" onClick={() => setParams({ tab: "requests", show: "history" }, { replace: true })}>
            <strong>{counts.confirmed ?? 0}</strong>
            <span>{t("ob.confirmedAll")}</span>
          </button>
          <button className="lab-hero-stat" onClick={() => setParams({ tab: "requests", show: "history" }, { replace: true })}>
            <strong>{(counts.rejected ?? 0) + (counts.expired ?? 0)}</strong>
            <span>{t("ob.notBooked")}</span>
          </button>
        </div>
      </section>
      <div className="segmented tabs" role="tablist">
        <button role="tab" aria-selected={tab === "requests"} className={tab === "requests" ? "active" : ""} onClick={() => setParams({ tab: "requests" }, { replace: true })}>
          {t("ob.tab.requests")}
          {counts.pending ? <span className="badge tab-count">{counts.pending}</span> : null}
        </button>
        <button role="tab" aria-selected={tab === "settings"} className={tab === "settings" ? "active" : ""} onClick={() => setParams({ tab: "settings" }, { replace: true })}>
          {t("ob.tab.settings")}
        </button>
      </div>
      {tab === "requests" && <BookingRequests history={params.get("show") === "history"} onCounts={setCounts} />}
      {tab === "settings" && <BookingSettingsForm canEdit={can("settings", "edit")} />}
    </div>
  );
}

export function BookingRequests({ history: initialHistory, onCounts }: { history?: boolean; onCounts?: (c: Record<string, number>) => void }) {
  const { t, lang } = useI18n();
  const { can } = useAuth();
  const [history, setHistory] = useState(!!initialHistory);
  const [data, setData] = useState<ReqPage | null>(null);
  const [confirming, setConfirming] = useState<BookingRequest | null>(null);
  const [rejecting, setRejecting] = useState<BookingRequest | null>(null);
  useEffect(() => setHistory(!!initialHistory), [initialHistory]);
  const load = useCallback(() => {
    get<ReqPage>(`/api/compliance/booking/requests/?status=${history ? "confirmed,rejected,expired" : "pending"}`)
      .then((d) => {
        setData(d);
        onCounts?.(d.counts);
      })
      .catch(() => setData(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [history]);
  useEffect(load, [load]);
  return (
    <section className="card">
      <header className="card-head">
        <Segmented
          value={history ? "history" : "pending"}
          onChange={(v) => setHistory(v === "history")}
          label={t("lab.show")}
          options={[
            { id: "pending", label: t("ob.waiting"), n: data?.counts.pending ?? 0 },
            { id: "history", label: t("ob.history") },
          ]}
        />
      </header>
      {data === null ? <Empty text="loading" /> : data.results.length === 0 ? <Empty text={history ? "noRecords" : "ob.none"} /> : (
        <ul className="ob-list">
          {data.results.map((r, i) => (
            <li key={r.id} className="ob-item" style={{ animationDelay: `${Math.min(i, 10) * 35}ms` }}>
              <div className="ob-when">
                <strong>{new Date(r.start).toLocaleDateString(lang === "ar" ? "ar-EG" : "en-GB", { weekday: "short", day: "numeric", month: "short" })}</strong>
                <span>{new Date(r.start).toLocaleTimeString(lang === "ar" ? "ar-EG" : "en-GB", { hour: "2-digit", minute: "2-digit" })}</span>
              </div>
              <div className="grow">
                <p className="strong">
                  {r.name} <a className="muted small" dir="ltr" href={`tel:${r.phone}`}>{r.phone}</a>
                  {r.known_patient && <span className="pill pill-outline tiny">{t("ob.knownPatient", { file: r.known_patient.file_number })}</span>}
                  {!r.known_patient && r.status === "pending" && <span className="pill pill-update tiny">{t("ob.newPatient")}</span>}
                </p>
                <p className="muted small">
                  {nm(r.procedure_name, lang) || t("ob.consultation")} · {nm(r.branch_name, lang)} · {nm(r.dentist_name, lang)}
                  {r.dentist_chosen ? ` (${t("ob.chosen")})` : ""} · {t("co.minutesN", { n: r.duration_minutes })}
                </p>
                {r.note && <p className="small ob-note">“{r.note}”</p>}
                <p className="muted tiny">
                  <span className="mono">{r.reference}</span> · {t("ob.sentAt", { when: fmtDateTime(r.created_at, lang) })} · {r.language === "ar" ? "العربية" : "English"}
                  {r.decided_at && ` · ${t("ob.decidedBy", { who: r.decided_by_name || "—", when: fmtDateTime(r.decided_at, lang) })}`}
                  {r.reject_reason && ` · ${r.reject_reason}`}
                </p>
              </div>
              <div className="ob-actions">
                <StatePill state={r.status} label={t(`ob.st.${r.status}` as TKey)} />
                {r.status === "pending" && (
                  <>
                    {can("appointments", "edit") && <button className="btn btn-small" onClick={() => setRejecting(r)}>{t("ob.reject")}</button>}
                    {can("appointments", "create") && <button className="btn btn-small btn-primary" onClick={() => setConfirming(r)}>{t("ob.confirm")}</button>}
                  </>
                )}
                {r.status === "confirmed" && r.patient && <Link className="btn btn-small" to={`/patients/${r.patient}`}>{t("ob.openPatient")}</Link>}
              </div>
            </li>
          ))}
        </ul>
      )}
      {confirming && <ConfirmDialog req={confirming} onClose={() => setConfirming(null)} onDone={() => { setConfirming(null); load(); }} />}
      {rejecting && <RejectDialog req={rejecting} onClose={() => setRejecting(null)} onDone={() => { setRejecting(null); load(); }} />}
    </section>
  );
}

function ConfirmDialog({ req, onClose, onDone }: { req: BookingRequest; onClose: () => void; onDone: () => void }) {
  const { t, lang, name } = useI18n();
  const [dentists, setDentists] = useState<{ id: number; name_en: string; name_ar: string; staff_type: string }[]>([]);
  const [dentist, setDentist] = useState(String(req.dentist ?? ""));
  const [chairs, setChairs] = useState<{ id: number; name_en: string; name_ar: string; branch: number }[]>([]);
  const [chair, setChair] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    getAll<{ id: number; name_en: string; name_ar: string; staff_type: string }>("/api/masterdata/staff/?is_active=true").then((r) => setDentists(r.filter((s) => s.staff_type === "dentist"))).catch(() => setDentists([]));
    getAll<{ id: number; name_en: string; name_ar: string; branch: number }>("/api/masterdata/chairs/").then((r) => setChairs(r.filter((c) => c.branch === req.branch))).catch(() => setChairs([]));
  }, [req.branch]);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await post(`/api/compliance/booking/requests/${req.id}/confirm/`, { dentist: dentist ? Number(dentist) : null, chair: chair ? Number(chair) : null });
      onDone();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={t("ob.confirmTitle")} onClose={onClose}>
      <form className="form-grid" onSubmit={submit}>
        <p>
          <strong>{req.name}</strong> · {fmtDateTime(req.start, lang)} · {nm(req.branch_name, lang)}
        </p>
        <p className="muted small">{req.known_patient ? t("ob.willLink", { file: req.known_patient.file_number }) : t("ob.willRegister")}</p>
        <div className="form-grid form-grid-2">
          <div className="field">
            <label htmlFor="ob-d">{t("co.dentist")}</label>
            <select id="ob-d" value={dentist} onChange={(e) => setDentist(e.target.value)}>
              {dentists.map((d) => <option key={d.id} value={d.id}>{name(d)}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="ob-c">{t("co.chair")}</label>
            <select id="ob-c" value={chair} onChange={(e) => setChair(e.target.value)}>
              <option value="">{t("ob.anyChair")}</option>
              {chairs.map((c) => <option key={c.id} value={c.id}>{name(c)}</option>)}
            </select>
          </div>
        </div>
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="form-actions">
          <button type="button" className="btn" onClick={onClose}>{t("cancel")}</button>
          <button className="btn btn-primary" disabled={busy}>{t("ob.confirmBook")}</button>
        </div>
      </form>
    </Modal>
  );
}

function RejectDialog({ req, onClose, onDone }: { req: BookingRequest; onClose: () => void; onDone: () => void }) {
  const { t } = useI18n();
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await post(`/api/compliance/booking/requests/${req.id}/reject/`, { reason });
      onDone();
    } catch (err) {
      setError(errorText(err));
    }
  };
  return (
    <Modal title={t("ob.rejectTitle")} onClose={onClose}>
      <form className="form-grid" onSubmit={submit}>
        <p className="muted small">{t("ob.rejectHint", { name: req.name })}</p>
        <div className="field">
          <label htmlFor="ob-r">{t("ob.reason")}</label>
          <input id="ob-r" value={reason} onChange={(e) => setReason(e.target.value)} />
        </div>
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="form-actions">
          <button type="button" className="btn" onClick={onClose}>{t("cancel")}</button>
          <button className="btn btn-primary">{t("ob.reject")}</button>
        </div>
      </form>
    </Modal>
  );
}

function BookingSettingsForm({ canEdit }: { canEdit: boolean }) {
  const { t, name } = useI18n();
  const branches = useBranches();
  const [procedures, setProcedures] = useState<{ id: number; name_en: string; name_ar: string; code: string; default_duration_minutes: number }[]>([]);
  const [v, setV] = useState<BookingSettings | null>(null);
  const [msg, setMsg] = useState("");
  const [error, setError] = useState("");
  const [copied, setCopied] = useState("");
  useEffect(() => {
    get<BookingSettings>("/api/compliance/booking/settings/").then(setV).catch((err) => setError(errorText(err)));
    getAll<{ id: number; name_en: string; name_ar: string; code: string; default_duration_minutes: number }>("/api/masterdata/procedures/?is_active=true").then(setProcedures).catch(() => setProcedures([]));
  }, []);
  const qr = useMemo(() => (v?.link ? qrSvg(v.link, 168) : ""), [v?.link]);
  if (!v) return <section className="card">{error ? <p className="form-error pad">{error}</p> : <Empty text="loading" />}</section>;
  const set = <K extends keyof BookingSettings>(k: K, value: BookingSettings[K]) => setV((s) => (s ? { ...s, [k]: value } : s));
  const toggle = (k: "services" | "branches", id: number) => set(k, v[k].includes(id) ? v[k].filter((x) => x !== id) : [...v[k], id]);
  const embed = v.link ? `<iframe src="${v.link}?embed=1" title="Book an appointment" style="width:100%;max-width:520px;height:760px;border:0;border-radius:16px" loading="lazy"></iframe>` : "";
  const copy = async (text: string, what: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(what);
      window.setTimeout(() => setCopied(""), 1600);
    } catch {
      setCopied("");
    }
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setMsg("");
    setError("");
    try {
      const { link: _link, ...body } = v;
      setV(await patch<BookingSettings>("/api/compliance/booking/settings/", { ...body, slug: body.slug || null }));
      setMsg(t("saved"));
    } catch (err) {
      setError(errorText(err));
    }
  };
  const num = (k: "days_ahead" | "min_notice_hours" | "slot_minutes", label: TKey, hint: TKey) => (
    <div className="field">
      <label htmlFor={`ob-${k}`}>{t(label)}</label>
      <input id={`ob-${k}`} type="number" min={k === "slot_minutes" ? 10 : 0} dir="ltr" disabled={!canEdit} value={v[k]} onChange={(e) => set(k, Number(e.target.value))} />
      <small className="field-hint">{t(hint)}</small>
    </div>
  );
  return (
    <div className="ob-settings">
      <form className="co-settings" onSubmit={submit}>
        <section className="card pad">
          <div className="field field-check ob-switch">
            <input id="ob-on" type="checkbox" disabled={!canEdit} checked={v.enabled} onChange={(e) => set("enabled", e.target.checked)} />
            <label htmlFor="ob-on"><strong>{t("ob.set.enabled")}</strong><span className="muted small block">{t("ob.set.enabledHint")}</span></label>
          </div>
          <div className="form-grid form-grid-2">
            <div className="field">
              <label htmlFor="ob-slug">{t("ob.set.slug")}</label>
              <div className="ob-slug" dir="ltr"><span className="muted">/book/</span><input id="ob-slug" disabled={!canEdit} value={v.slug ?? ""} onChange={(e) => set("slug", e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-"))} /></div>
              <small className="field-hint">{t("ob.set.slugHint")}</small>
            </div>
            {num("days_ahead", "ob.set.daysAhead", "ob.set.daysAheadHint")}
            {num("min_notice_hours", "ob.set.notice", "ob.set.noticeHint")}
            {num("slot_minutes", "ob.set.slot", "ob.set.slotHint")}
          </div>
          <div className="field field-check ob-gap">
            <input id="ob-dc" type="checkbox" disabled={!canEdit} checked={v.allow_dentist_choice} onChange={(e) => set("allow_dentist_choice", e.target.checked)} />
            <label htmlFor="ob-dc">{t("ob.set.dentistChoice")}</label>
          </div>
          <div className="form-grid form-grid-2">
            <div className="field"><label htmlFor="ob-men">{t("ob.set.msgEn")}</label><textarea id="ob-men" dir="ltr" rows={2} disabled={!canEdit} value={v.message_en} onChange={(e) => set("message_en", e.target.value)} /></div>
            <div className="field"><label htmlFor="ob-mar">{t("ob.set.msgAr")}</label><textarea id="ob-mar" dir="rtl" rows={2} disabled={!canEdit} value={v.message_ar} onChange={(e) => set("message_ar", e.target.value)} /></div>
          </div>
        </section>
        <section className="card pad">
          <h2>{t("ob.set.branches")}</h2>
          <p className="muted small">{t("ob.set.branchesHint")}</p>
          <div className="ob-checks">
            {branches.map((b) => (
              <label key={b.id} className={`chip ${v.branches.includes(b.id) ? "active" : ""}`}>
                <input type="checkbox" className="sr-only" disabled={!canEdit} checked={v.branches.includes(b.id)} onChange={() => toggle("branches", b.id)} />
                {name(b)}
              </label>
            ))}
          </div>
          <h2>{t("ob.set.services")}</h2>
          <p className="muted small">{t("ob.set.servicesHint")}</p>
          <div className="ob-checks">
            {procedures.map((p) => (
              <label key={p.id} className={`chip ${v.services.includes(p.id) ? "active" : ""}`}>
                <input type="checkbox" className="sr-only" disabled={!canEdit} checked={v.services.includes(p.id)} onChange={() => toggle("services", p.id)} />
                {name(p)} <span className="muted tiny">{t("co.minutesN", { n: Math.max(p.default_duration_minutes || 0, v.slot_minutes) })}</span>
              </label>
            ))}
          </div>
        </section>
        {error && <p className="form-error" role="alert">{error}</p>}
        {msg && <p className="notice pad-s" role="status">{msg}</p>}
        {canEdit && <div className="form-actions"><button className="btn btn-primary">{t("save")}</button></div>}
      </form>
      <aside className="card pad ob-share">
        <h2>{t("ob.set.share")}</h2>
        {!v.link ? <p className="muted small">{t("ob.set.noLink")}</p> : (
          <>
            {!v.enabled && <p className="notice pad-s">{t("ob.set.offNote")}</p>}
            <div className="ob-qr" dangerouslySetInnerHTML={{ __html: qr }} />
            <p className="mono small ob-link" dir="ltr">{v.link}</p>
            <div className="toolbar">
              <button type="button" className="btn btn-small" onClick={() => void copy(v.link, "link")}><Icon name="copy" size={16} /> {copied === "link" ? t("ob.copied") : t("ob.copyLink")}</button>
              <a className="btn btn-small" href={v.link} target="_blank" rel="noreferrer"><Icon name="globe" size={16} /> {t("ob.openPage")}</a>
              <button type="button" className="btn btn-small" onClick={() => { const w = window.open("", "_blank"); if (w) { w.document.write(`<title>QR</title><body style="margin:0;display:grid;place-items:center;height:100vh;font-family:sans-serif">${qrSvg(v.link, 420)}<p>${v.link}</p></body>`); w.document.close(); w.print(); } }}>{t("ob.printQr")}</button>
            </div>
            <h3>{t("ob.set.embed")}</h3>
            <p className="muted small">{t("ob.set.embedHint")}</p>
            <pre className="co-json ob-embed" dir="ltr">{embed}</pre>
            <button type="button" className="btn btn-small" onClick={() => void copy(embed, "embed")}><Icon name="copy" size={16} /> {copied === "embed" ? t("ob.copied") : t("ob.copyCode")}</button>
          </>
        )}
      </aside>
    </div>
  );
}
