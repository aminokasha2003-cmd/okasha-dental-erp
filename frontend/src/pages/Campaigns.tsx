import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { get, getAll, patch, post } from "../api";
import { useAuth } from "../auth";
import { useI18n, type TKey } from "../i18n";
import { KpiTile } from "../components/Charts";
import { Modal } from "../components/Crud";
import { Icon } from "../components/Icon";
import { fmtDate, money } from "../format";
import type { Branch, Procedure } from "../types";
import { errorText, personName, useCurrency } from "./BillingParts";
import { SOURCES, STAGES, waLink } from "./CrmParts";

interface Results {
  audience: number;
  sent: number;
  failed: number;
  skipped: number;
  responded: number;
  booked: number;
  appointments: number;
  revenue: string;
  collected: string;
  roi: number | null;
}
interface Campaign {
  id: number;
  name: string;
  channel: "whatsapp" | "sms";
  message_en: string;
  message_ar: string;
  filters: Filters;
  offer_date: string | null;
  status: "draft" | "sent";
  cost: string;
  sent_at: string | null;
  results: Results | null;
  author: string;
  created_at: string;
}
interface Filters {
  audience?: "patients" | "leads";
  gender?: string;
  branch?: string;
  age_min?: string;
  age_max?: string;
  birthday_month?: string;
  last_visit_before?: string;
  procedure_done?: string;
  procedure_not_done?: string;
  no_shows?: string;
  has_balance?: boolean;
  lead_stages?: string[];
  lead_source?: string;
}
interface Preview {
  audience: number;
  reachable: number;
  no_consent: number;
  arabic: number;
  english: number;
  sample: { kind: string; id: number; ar: string; en: string; phone: string; consent: boolean; language: string; body: string; balance: string }[];
}
interface Recipient {
  id: number;
  person: { kind: string; id: number; file_number: string; ar: string; en: string; patient?: number | null };
  phone: string;
  language: string;
  body: string;
  status: string;
  error: string;
  responded_at: string | null;
  booked: number;
  responded: boolean;
  already_booked?: boolean;
}

const STARTER = {
  ar: "مرحبًا {name}، وحشتنا في {clinic}! احجز كشفك الدوري ونظّف أسنانك قبل {date}. ردّ على الرسالة دي ونحجزلك في الميعاد اللي يناسبك.",
  en: "Hello {name}, we miss you at {clinic}! Book your check-up and cleaning before {date}. Reply to this message and we'll find a time that suits you.",
};

const RECIPIENT_PILL: Record<string, string> = { sent: "pill pill-ok", manual: "pill pill-outline", failed: "pill pill-warn", skipped: "pill pill-muted" };

/** Campaigns tab: list, builder with live audience preview, and results. */
export function Campaigns() {
  const { t, lang } = useI18n();
  const { can } = useAuth();
  const currency = useCurrency();
  const [rows, setRows] = useState<Campaign[] | null>(null);
  const [building, setBuilding] = useState<Partial<Campaign> | null>(null);
  const [viewing, setViewing] = useState<Campaign | null>(null);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    getAll<Campaign>("/api/crm/campaigns/").then(setRows).catch(() => setRows([]));
  }, [version]);
  return (
    <>
      <section className="card">
        <header className="card-head">
          <h2>{t("crm.camp.title")}</h2>
          {can("crm", "create") && (
            <button className="btn btn-primary" onClick={() => setBuilding({ channel: "whatsapp", filters: { audience: "patients" }, message_ar: STARTER.ar, message_en: STARTER.en, name: "", cost: "0" })}>
              <Icon name="plus" size={18} /> {t("crm.camp.new")}
            </button>
          )}
        </header>
        {rows === null ? (
          <p className="muted pad">{t("loading")}</p>
        ) : rows.length === 0 ? (
          <p className="muted pad">{t("crm.camp.empty")}</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{t("crm.camp.name")}</th>
                  <th>{t("crm.camp.channel")}</th>
                  <th>{t("ap.status")}</th>
                  <th className="num">{t("crm.camp.sent")}</th>
                  <th className="num">{t("crm.camp.responded")}</th>
                  <th className="num">{t("crm.camp.booked")}</th>
                  <th className="num">{t("crm.camp.revenue")}</th>
                  <th className="num">{t("crm.camp.roi")}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => (
                  <tr key={c.id} className="row-link" onClick={() => (c.status === "sent" ? setViewing(c) : can("crm", "edit") ? setBuilding(c) : setViewing(c))}>
                    <td>
                      <strong>{c.name}</strong>
                      <span className="muted small block">{c.sent_at ? fmtDate(c.sent_at, lang) : t("crm.camp.notSent")}</span>
                    </td>
                    <td>{c.channel === "sms" ? "SMS" : "WhatsApp"}</td>
                    <td><span className={c.status === "sent" ? "pill pill-ok" : "pill pill-outline"}>{t(c.status === "sent" ? "crm.camp.statusSent" : "crm.camp.statusDraft")}</span></td>
                    <td className="num">{c.results ? c.results.sent : "—"}</td>
                    <td className="num">{c.results ? c.results.responded : "—"}</td>
                    <td className="num">{c.results ? c.results.booked : "—"}</td>
                    <td className="num nowrap">{c.results ? `${money(c.results.revenue, lang)} ${currency}` : "—"}</td>
                    <td className="num">{c.results?.roi !== null && c.results?.roi !== undefined ? `${c.results.roi}%` : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {building && <Builder initial={building} onClose={() => setBuilding(null)} onDone={(c) => { setBuilding(null); setVersion((v) => v + 1); if (c?.status === "sent") setViewing(c); }} />}
      {viewing && <CampaignResults campaign={viewing} onClose={() => setViewing(null)} onChanged={() => setVersion((v) => v + 1)} />}
    </>
  );
}

const MONTHS = Array.from({ length: 12 }, (_, i) => i + 1);

function Builder({ initial, onClose, onDone }: { initial: Partial<Campaign>; onClose: () => void; onDone: (c?: Campaign) => void }) {
  const { t, lang, name } = useI18n();
  const { can } = useAuth();
  const [c, setC] = useState<Partial<Campaign>>(initial);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [procedures, setProcedures] = useState<Procedure[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const f = c.filters ?? {};
  const leads = f.audience === "leads";
  const setF = (patchF: Partial<Filters>) => setC({ ...c, filters: { ...f, ...patchF } });
  useEffect(() => {
    getAll<Procedure>("/api/masterdata/procedures/?is_active=true").then(setProcedures).catch(() => setProcedures([]));
    if (can("masterdata")) getAll<Branch>("/api/masterdata/branches/?is_active=true").then(setBranches).catch(() => setBranches([]));
  }, [can]);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      post<Preview>("/api/crm/campaigns/preview/", { channel: c.channel, filters: c.filters, message_en: c.message_en, message_ar: c.message_ar, offer_date: c.offer_date || null })
        .then(setPreview)
        .catch(() => setPreview(null));
    }, 300);
    return () => window.clearTimeout(timer);
  }, [c.channel, c.filters, c.message_en, c.message_ar, c.offer_date]);
  const save = async (andSend: boolean) => {
    setError("");
    setBusy(true);
    try {
      const body = { name: c.name, channel: c.channel, message_en: c.message_en, message_ar: c.message_ar, filters: c.filters, offer_date: c.offer_date || null, cost: c.cost || "0" };
      const saved = c.id ? await patch<Campaign>(`/api/crm/campaigns/${c.id}/`, body) : await post<Campaign>("/api/crm/campaigns/", body);
      if (andSend) {
        const res = await post<{ campaign: Campaign }>(`/api/crm/campaigns/${saved.id}/send/`, {});
        onDone(res.campaign);
      } else onDone(saved);
    } catch (err) {
      setError(errorText(err));
      setConfirming(false);
    } finally {
      setBusy(false);
    }
  };
  const insert = (field: "message_en" | "message_ar", token: string) => setC({ ...c, [field]: `${c[field] ?? ""}${token}` });
  const tokens = ["{name}", "{clinic}", "{date}", "{balance}"];
  return (
    <Modal title={c.id ? c.name || t("crm.camp.new") : t("crm.camp.new")} onClose={onClose}>
      <div className="camp-builder">
        <div className="camp-form form-grid">
          <div className="form-grid form-grid-2">
            <label className="field">
              <span className="field-label">{t("crm.camp.name")}</span>
              <input value={c.name ?? ""} onChange={(e) => setC({ ...c, name: e.target.value })} placeholder={t("crm.camp.namePh")} />
            </label>
            <label className="field">
              <span className="field-label">{t("crm.camp.channel")}</span>
              <span className="segmented">
                {(["whatsapp", "sms"] as const).map((ch) => (
                  <button key={ch} type="button" className={c.channel === ch ? "active" : ""} onClick={() => setC({ ...c, channel: ch })}>{ch === "sms" ? "SMS" : "WhatsApp"}</button>
                ))}
              </span>
            </label>
          </div>
          <fieldset className="camp-filters">
            <legend>{t("crm.camp.audience")}</legend>
            <span className="segmented">
              <button type="button" className={!leads ? "active" : ""} onClick={() => setC({ ...c, filters: { audience: "patients" } })}>{t("crm.camp.patients")}</button>
              <button type="button" className={leads ? "active" : ""} onClick={() => setC({ ...c, filters: { audience: "leads", lead_stages: ["new", "contacted"] } })}>{t("crm.camp.leads")}</button>
            </span>
            {leads ? (
              <div className="form-grid form-grid-2">
                <div className="field">
                  <span className="field-label">{t("crm.stage")}</span>
                  <span className="checks">
                    {STAGES.filter((s) => s !== "won").map((s) => (
                      <label key={s} className="check-pill">
                        <input type="checkbox" checked={(f.lead_stages ?? []).includes(s)}
                          onChange={(e) => setF({ lead_stages: e.target.checked ? [...(f.lead_stages ?? []), s] : (f.lead_stages ?? []).filter((x) => x !== s) })} />
                        {t(`crm.stage.${s}` as TKey)}
                      </label>
                    ))}
                  </span>
                </div>
                <label className="field">
                  <span className="field-label">{t("crm.source")}</span>
                  <select value={f.lead_source ?? ""} onChange={(e) => setF({ lead_source: e.target.value })}>
                    <option value="">{t("crm.allSources")}</option>
                    {SOURCES.map((s) => <option key={s} value={s}>{t(`crm.src.${s}` as TKey)}</option>)}
                  </select>
                </label>
              </div>
            ) : (
              <div className="form-grid form-grid-3">
                <label className="field">
                  <span className="field-label">{t("pt.gender")}</span>
                  <select value={f.gender ?? ""} onChange={(e) => setF({ gender: e.target.value })}>
                    <option value="">{t("crm.any")}</option>
                    <option value="male">{t("pt.gender.male")}</option>
                    <option value="female">{t("pt.gender.female")}</option>
                  </select>
                </label>
                {branches.length > 1 && (
                  <label className="field">
                    <span className="field-label">{t("ap.branch")}</span>
                    <select value={f.branch ?? ""} onChange={(e) => setF({ branch: e.target.value })}>
                      <option value="">{t("crm.any")}</option>
                      {branches.map((b) => <option key={b.id} value={b.id}>{name(b)}</option>)}
                    </select>
                  </label>
                )}
                <label className="field">
                  <span className="field-label">{t("crm.camp.age")}</span>
                  <span className="range-pair">
                    <input type="number" min={0} max={120} placeholder={t("crm.camp.from")} value={f.age_min ?? ""} onChange={(e) => setF({ age_min: e.target.value })} />
                    <input type="number" min={0} max={120} placeholder={t("crm.camp.to")} value={f.age_max ?? ""} onChange={(e) => setF({ age_max: e.target.value })} />
                  </span>
                </label>
                <label className="field">
                  <span className="field-label">{t("crm.camp.birthday")}</span>
                  <select value={f.birthday_month ?? ""} onChange={(e) => setF({ birthday_month: e.target.value })}>
                    <option value="">{t("crm.any")}</option>
                    {MONTHS.map((m) => <option key={m} value={m}>{new Date(2026, m - 1, 1).toLocaleDateString(lang === "ar" ? "ar-EG" : "en-GB", { month: "long" })}</option>)}
                  </select>
                </label>
                <label className="field">
                  <span className="field-label">{t("crm.camp.lastVisitBefore")}</span>
                  <input type="date" value={f.last_visit_before ?? ""} onChange={(e) => setF({ last_visit_before: e.target.value })} />
                </label>
                <label className="field">
                  <span className="field-label">{t("crm.camp.had")}</span>
                  <select value={f.procedure_done ?? ""} onChange={(e) => setF({ procedure_done: e.target.value })}>
                    <option value="">{t("crm.any")}</option>
                    {procedures.map((p) => <option key={p.id} value={p.id}>{p.code} {name(p)}</option>)}
                  </select>
                </label>
                <label className="field">
                  <span className="field-label">{t("crm.camp.never")}</span>
                  <select value={f.procedure_not_done ?? ""} onChange={(e) => setF({ procedure_not_done: e.target.value })}>
                    <option value="">{t("crm.any")}</option>
                    {procedures.map((p) => <option key={p.id} value={p.id}>{p.code} {name(p)}</option>)}
                  </select>
                </label>
                <label className="field">
                  <span className="field-label">{t("crm.camp.noShows")}</span>
                  <input type="number" min={0} value={f.no_shows ?? ""} onChange={(e) => setF({ no_shows: e.target.value })} />
                </label>
                <label className="check-inline">
                  <input type="checkbox" checked={!!f.has_balance} onChange={(e) => setF({ has_balance: e.target.checked })} /> {t("crm.camp.hasBalance")}
                </label>
              </div>
            )}
          </fieldset>
          {(["message_ar", "message_en"] as const).map((field) => (
            <label key={field} className="field">
              <span className="field-label">{t(field === "message_ar" ? "crm.camp.msgAr" : "crm.camp.msgEn")}</span>
              <textarea rows={3} dir={field === "message_ar" ? "rtl" : "ltr"} value={c[field] ?? ""} onChange={(e) => setC({ ...c, [field]: e.target.value })} />
              <span className="token-row">
                {tokens.map((tk) => <button key={tk} type="button" className="chip" onClick={() => insert(field, tk)}>{tk}</button>)}
              </span>
            </label>
          ))}
          <div className="form-grid form-grid-2">
            <label className="field">
              <span className="field-label">{t("crm.camp.offerDate")}</span>
              <input type="date" value={c.offer_date ?? ""} onChange={(e) => setC({ ...c, offer_date: e.target.value })} />
              <span className="muted small">{t("crm.camp.offerHint")}</span>
            </label>
            <label className="field">
              <span className="field-label">{t("crm.camp.cost")}</span>
              <input type="number" min={0} step="0.01" value={c.cost ?? "0"} onChange={(e) => setC({ ...c, cost: e.target.value })} />
            </label>
          </div>
        </div>
        <aside className="camp-preview" aria-live="polite">
          <h3>{t("crm.camp.preview")}</h3>
          {preview ? (
            <>
              <p className="camp-reach">
                <strong>{preview.reachable}</strong> {t("crm.camp.willGet")}
                <span className="muted small block">
                  {t("crm.camp.matchCount", { n: preview.audience })}
                  {c.channel === "whatsapp" && preview.no_consent > 0 ? ` · ${t("crm.camp.noConsent", { n: preview.no_consent })}` : ""}
                </span>
                <span className="muted small block">{t("crm.camp.langSplit", { ar: preview.arabic, en: preview.english })}</span>
              </p>
              {preview.sample[0] ? (
                <div className={`bubble ${c.channel === "sms" ? "sms" : ""}`} dir={preview.sample[0].language === "ar" ? "rtl" : "ltr"}>
                  {preview.sample[0].body || <span className="muted">{t("crm.camp.noMessage")}</span>}
                  <span className="bubble-to">{personName(preview.sample[0], lang)}</span>
                </div>
              ) : (
                <p className="muted small">{t("crm.camp.nobody")}</p>
              )}
              <ul className="plain-list camp-sample">
                {preview.sample.slice(1, 7).map((s) => (
                  <li key={`${s.kind}${s.id}`} className={!s.consent && c.channel === "whatsapp" ? "muted" : ""}>
                    <span className="grow">{personName(s, lang)}</span>
                    <span className="small muted">{s.language === "ar" ? "ع" : "EN"}</span>
                    {!s.consent && c.channel === "whatsapp" && <span className="pill pill-muted">{t("crm.camp.optedOut")}</span>}
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className="muted">{t("loading")}</p>
          )}
        </aside>
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
      {confirming ? (
        <div className="form-actions confirm-row">
          <span className="grow">{t("crm.camp.confirm", { n: preview?.reachable ?? 0 })}</span>
          <button className="btn" onClick={() => setConfirming(false)}>{t("cancel")}</button>
          <button className="btn btn-primary" disabled={busy} onClick={() => void save(true)}>{t("crm.camp.sendNow")}</button>
        </div>
      ) : (
        <div className="form-actions">
          <button className="btn" onClick={onClose}>{t("cancel")}</button>
          <button className="btn" disabled={busy || !c.name} onClick={() => void save(false)}>{t("crm.camp.saveDraft")}</button>
          <button className="btn btn-primary" disabled={busy || !c.name || !preview?.reachable} onClick={() => setConfirming(true)}>{t("crm.camp.send")}</button>
        </div>
      )}
    </Modal>
  );
}

function CampaignResults({ campaign, onClose, onChanged }: { campaign: Campaign; onClose: () => void; onChanged: () => void }) {
  const { t, lang } = useI18n();
  const { can } = useAuth();
  const currency = useCurrency();
  const [rows, setRows] = useState<Recipient[] | null>(null);
  const [c, setC] = useState(campaign);
  const [show, setShow] = useState<"all" | "booked" | "responded" | "failed">("all");
  const load = () => {
    get<Recipient[]>(`/api/crm/campaigns/${campaign.id}/recipients/`).then(setRows).catch(() => setRows([]));
    get<Campaign>(`/api/crm/campaigns/${campaign.id}/`).then(setC).catch(() => undefined);
  };
  useEffect(load, [campaign.id]);
  const r = c.results;
  const toggle = async (x: Recipient) => {
    await post(`/api/crm/campaigns/${c.id}/recipients/${x.id}/responded/`, {});
    load();
    onChanged();
  };
  const shown = (rows ?? []).filter((x) => (show === "booked" ? x.booked > 0 : show === "responded" ? x.responded : show === "failed" ? x.status === "failed" || x.status === "skipped" : true));
  return (
    <Modal title={c.name} onClose={onClose}>
      <p className="muted small">
        {c.channel === "sms" ? "SMS" : "WhatsApp"} · {c.sent_at ? t("crm.camp.sentOn", { date: fmtDate(c.sent_at, lang) }) : t("crm.camp.notSent")}
        {c.author ? ` · ${c.author}` : ""} · {t("crm.camp.window")}
      </p>
      {r && (
        <div className="kpi-grid camp-kpis">
          <KpiTile i={0} label={t("crm.camp.sent")} value={String(r.sent)} sub={r.failed + r.skipped ? t("crm.camp.notDelivered", { n: r.failed + r.skipped }) : t("crm.camp.ofN", { n: r.audience })} />
          <KpiTile i={1} label={t("crm.camp.responded")} value={String(r.responded)} sub={r.sent ? `${Math.round((r.responded * 100) / r.sent)}%` : ""} />
          <KpiTile i={2} label={t("crm.camp.booked")} value={String(r.booked)} sub={t("crm.camp.appointmentsN", { n: r.appointments })} tone={r.booked ? "good" : undefined} />
          <KpiTile i={3} label={t("crm.camp.revenue")} value={`${money(r.revenue, lang)} ${currency}`} sub={r.roi !== null ? t("crm.camp.roiSub", { roi: r.roi, cost: money(c.cost, lang) }) : t("crm.camp.collectedSub", { n: money(r.collected, lang) })} tone="accent" />
        </div>
      )}
      <div className="chip-row">
        {(["all", "booked", "responded", "failed"] as const).map((s) => (
          <button key={s} className={`chip ${show === s ? "active" : ""}`} onClick={() => setShow(s)}>{t(`crm.camp.show.${s}` as TKey)}</button>
        ))}
      </div>
      {rows === null ? (
        <p className="muted">{t("loading")}</p>
      ) : (
        <div className="table-wrap camp-recipients">
          <table>
            <thead>
              <tr>
                <th>{t("crm.camp.recipient")}</th>
                <th>{t("ap.status")}</th>
                <th>{t("crm.camp.responded")}</th>
                <th>{t("crm.camp.booked")}</th>
                <th aria-label={t("crm.camp.message")} />
              </tr>
            </thead>
            <tbody>
              {shown.map((x) => {
                const pid = x.person.kind === "patient" ? x.person.id : x.person.patient;
                return (
                  <tr key={x.id}>
                    <td>
                      {pid ? <Link to={`/patients/${pid}`}>{personName(x.person, lang)}</Link> : <span>{personName(x.person, lang)}</span>}
                      <span className="muted small block"><bdi dir="ltr">{x.phone}</bdi> · {x.language === "ar" ? "عربي" : "English"}</span>
                    </td>
                    <td>
                      <span className={RECIPIENT_PILL[x.status] ?? "pill"}>{t(`crm.camp.st.${x.status}` as TKey)}</span>
                      {x.error && <span className="muted small block">{x.error}</span>}
                    </td>
                    <td>
                      <label className="check-inline small">
                        <input type="checkbox" checked={x.responded} disabled={!can("crm", "edit")} onChange={() => void toggle(x)} /> {x.responded ? t("yes") : t("no")}
                      </label>
                    </td>
                    <td>{x.booked ? <span className="pill pill-ok">{t("crm.camp.bookedN", { n: x.booked })}</span> : x.already_booked ? <span className="muted small">{t("crm.camp.alreadyBooked")}</span> : "—"}</td>
                    <td className="nowrap">
                      {c.channel === "whatsapp" && x.status !== "skipped" && (
                        <a className="btn btn-small wa-btn" href={waLink(x.phone, x.body)} target="_blank" rel="noreferrer" title={x.body}>WhatsApp</a>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  );
}
