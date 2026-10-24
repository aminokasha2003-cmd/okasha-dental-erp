import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useI18n } from "../i18n";
import { AnimatedLogo } from "../components/AnimatedLogo";
import { ThemeButton } from "../components/Layout";
import { useTheme } from "../theme";
import type { PublicClinic } from "./ComplianceTypes";

// The public booking page at /book/<slug>. No login: it talks only to the
// public booking API, which shows free times and takes requests for reception.

class PublicError extends Error {
  constructor(public fields: Record<string, string>) {
    super(Object.values(fields).join(" "));
  }
}

async function publicApi<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/public/booking/${path}`, body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const fields: Record<string, string> = {};
    if (data && typeof data === "object") for (const [k, v] of Object.entries(data as Record<string, unknown>)) fields[k] = Array.isArray(v) ? v.join(" ") : String(v);
    throw new PublicError(Object.keys(fields).length ? fields : { detail: res.statusText });
  }
  return data as T;
}

const ERROR_KEYS = { start: "pb.err.taken", consent: "pb.err.consent", name: "pb.err.name", detail: "pb.err.tooMany", phone: "pb.err.phone" } as const;

function addDays(iso: string, n: number) {
  const d = new Date(`${iso}T12:00:00`);
  d.setDate(d.getDate() + n);
  return d.toLocaleDateString("en-CA");
}

/** Python weekday (Monday 0) for an ISO date. */
function pyWeekday(iso: string) {
  return (new Date(`${iso}T12:00:00`).getDay() + 6) % 7;
}

export function PublicBooking() {
  const { t, lang, setLang } = useI18n();
  const { theme, toggle } = useTheme();
  const slug = window.location.pathname.replace(/^\/book\/?/, "").split("/")[0];
  const embed = new URLSearchParams(window.location.search).get("embed") === "1";
  const [clinic, setClinic] = useState<PublicClinic | null>(null);
  const [missing, setMissing] = useState(false);
  const [branch, setBranch] = useState<number | null>(null);
  const [service, setService] = useState<number | null>(null);
  const [dentist, setDentist] = useState<number | "">("");
  const [day, setDay] = useState("");
  const [slots, setSlots] = useState<string[] | null>(null);
  const [slot, setSlot] = useState("");
  const [form, setForm] = useState({ name: "", phone: "", note: "", consent: false, website: "" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ reference: string; start: string } | null>(null);
  const ar = lang === "ar";
  const L = (n: { en: string; ar: string } | null | undefined) => (n ? (ar ? n.ar || n.en : n.en || n.ar) : "");
  const locale = ar ? "ar-EG" : "en-GB";

  useEffect(() => {
    document.title = t("pb.docTitle");
    publicApi<PublicClinic>(`${slug}/`)
      .then((c) => {
        setClinic(c);
        if (c.branches.length === 1) setBranch(c.branches[0].id);
        if (c.services.length === 1) setService(c.services[0].id);
      })
      .catch(() => setMissing(true));
  }, [slug, t]);

  const b = clinic?.branches.find((x) => x.id === branch) ?? null;
  const days = useMemo(() => {
    if (!clinic) return [];
    const n = Math.min(clinic.days_ahead, 21);
    return Array.from({ length: n + 1 }, (_, i) => addDays(clinic.today, i)).map((iso) => {
      const h = b?.hours.find((x) => x.weekday === pyWeekday(iso));
      return { iso, closed: !b || !h || h.closed };
    });
  }, [clinic, b]);
  const dentists = (clinic?.dentists ?? []).filter((d) => !branch || !d.branches.length || d.branches.includes(branch));

  useEffect(() => {
    setSlot("");
    if (!branch || !day) {
      setSlots(null);
      return;
    }
    setSlots(null);
    const q = new URLSearchParams({ branch: String(branch), date: day });
    if (service) q.set("service", String(service));
    if (dentist) q.set("dentist", String(dentist));
    publicApi<{ slots: string[] }>(`${slug}/slots/?${q}`).then((r) => setSlots(r.slots)).catch(() => setSlots([]));
  }, [slug, branch, service, dentist, day]);

  useEffect(() => {
    if (!day && days.length) {
      const first = days.find((d) => !d.closed);
      if (first) setDay(first.iso);
    }
    if (day && days.length && days.find((d) => d.iso === day)?.closed) setDay(days.find((d) => !d.closed)?.iso ?? "");
  }, [days, day]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const r = await publicApi<{ reference: string; start: string }>(`${slug}/request/`, {
        branch, service, dentist: dentist || null, start: slot, name: form.name, phone: form.phone, note: form.note, consent: form.consent, website: form.website, language: lang,
      });
      setDone({ reference: r.reference, start: r.start ?? slot });
    } catch (err) {
      if (err instanceof PublicError) {
        const key = Object.keys(err.fields).find((k) => k in ERROR_KEYS) as keyof typeof ERROR_KEYS | undefined;
        if (key === "phone" && /waiting/i.test(err.fields.phone)) setError(t("pb.err.phoneBusy"));
        else if (key === "detail" && !/many/i.test(err.fields.detail)) setError(t("pb.failed"));
        else setError(key ? t(ERROR_KEYS[key]) : t("pb.failed"));
      } else setError(t("pb.failed"));
      if (branch && day) {
        const q = new URLSearchParams({ branch: String(branch), date: day });
        if (service) q.set("service", String(service));
        if (dentist) q.set("dentist", String(dentist));
        publicApi<{ slots: string[] }>(`${slug}/slots/?${q}`).then((r) => setSlots(r.slots)).catch(() => undefined);
      }
    } finally {
      setBusy(false);
    }
  };

  const top = (
    <div className="pb-top">
      <div className="segmented" role="group" aria-label={t("language")}>
        <button type="button" aria-pressed={lang === "ar"} onClick={() => setLang("ar")} lang="ar">العربية</button>
        <button type="button" aria-pressed={lang === "en"} onClick={() => setLang("en")} lang="en">English</button>
      </div>
      {!embed && <ThemeButton theme={theme} onToggle={toggle} />}
    </div>
  );

  if (missing)
    return (
      <div className={`login-page pb-page ${embed ? "pb-embed" : ""}`}>
        {top}
        <div className="card login-card pb-card"><h1>{t("pb.unavailable")}</h1><p className="muted">{t("pb.unavailableHint")}</p></div>
      </div>
    );
  if (!clinic)
    return (
      <div className={`login-page pb-page ${embed ? "pb-embed" : ""}`}>
        <div className="card login-card pb-card"><p className="muted">{t("loading")}</p></div>
      </div>
    );

  const when = (iso: string) => new Date(iso).toLocaleString(locale, { weekday: "long", day: "numeric", month: "long", hour: "numeric", minute: "2-digit" });
  return (
    <div className={`login-page pb-page ${embed ? "pb-embed" : ""}`}>
      {top}
      <div className="card login-card pb-card">
        <header className="login-head pb-head">
          {!embed && <AnimatedLogo mode="intro" size={56} tone={theme === "dark" ? "dark" : "light"} />}
          <div>
            <h1>{L(clinic.clinic)}</h1>
            <p className="muted">{t("pb.subtitle")}</p>
          </div>
        </header>
        {L(clinic.message) && <p className="pb-message">{L(clinic.message)}</p>}
        {done ? (
          <div className="pb-done" role="status">
            <span className="pb-done-mark" aria-hidden="true">✓</span>
            <h2>{t("pb.thanks")}</h2>
            <p>{t("pb.received", { when: when(done.start) })}</p>
            <p className="muted small">{t("pb.callBack")}</p>
            <p className="pb-ref">{t("pb.reference")} <strong className="mono" dir="ltr">{done.reference}</strong></p>
            {clinic.clinic.phone && <p className="muted small">{t("pb.questions")} <a href={`tel:${clinic.clinic.phone}`} dir="ltr">{clinic.clinic.phone}</a></p>}
            <button className="btn" onClick={() => { setDone(null); setSlot(""); setForm({ name: "", phone: "", note: "", consent: false, website: "" }); }}>{t("pb.another")}</button>
          </div>
        ) : (
          <form className="pb-form" onSubmit={submit}>
            {clinic.branches.length > 1 && (
              <fieldset className="pb-step">
                <legend><span className="pb-n">1</span>{t("pb.branch")}</legend>
                <div className="pb-options">
                  {clinic.branches.map((x) => (
                    <button type="button" key={x.id} className={`pb-option ${branch === x.id ? "active" : ""}`} aria-pressed={branch === x.id} onClick={() => { setBranch(x.id); setDentist(""); }}>
                      <strong>{L(x)}</strong>
                      <span className="muted small">{L(x.address)}</span>
                    </button>
                  ))}
                </div>
              </fieldset>
            )}
            <fieldset className="pb-step">
              <legend><span className="pb-n">{clinic.branches.length > 1 ? 2 : 1}</span>{t("pb.service")}</legend>
              <div className="pb-chips">
                <button type="button" className={`chip ${service === null ? "active" : ""}`} aria-pressed={service === null} onClick={() => setService(null)}>{t("pb.checkup")}</button>
                {clinic.services.map((s) => (
                  <button type="button" key={s.id} className={`chip ${service === s.id ? "active" : ""}`} aria-pressed={service === s.id} onClick={() => setService(s.id)}>{L(s)}</button>
                ))}
              </div>
              {clinic.dentists.length > 0 && branch && (
                <div className="field pb-dentist">
                  <label htmlFor="pb-d">{t("pb.dentist")}</label>
                  <select id="pb-d" value={dentist} onChange={(e) => setDentist(e.target.value ? Number(e.target.value) : "")}>
                    <option value="">{t("pb.anyDentist")}</option>
                    {dentists.map((d) => <option key={d.id} value={d.id}>{L(d)}</option>)}
                  </select>
                </div>
              )}
            </fieldset>
            {branch && (
              <fieldset className="pb-step">
                <legend><span className="pb-n">{clinic.branches.length > 1 ? 3 : 2}</span>{t("pb.when")}</legend>
                <div className="pb-days" role="group" aria-label={t("pb.day")}>
                  {days.map((d) => {
                    const dt = new Date(`${d.iso}T12:00:00`);
                    return (
                      <button type="button" key={d.iso} disabled={d.closed} className={`pb-day ${day === d.iso ? "active" : ""}`} aria-pressed={day === d.iso} onClick={() => setDay(d.iso)}>
                        <span>{dt.toLocaleDateString(locale, { weekday: "short" })}</span>
                        <strong>{dt.toLocaleDateString(locale, { day: "numeric" })}</strong>
                        <span>{d.closed ? t("pb.closed") : dt.toLocaleDateString(locale, { month: "short" })}</span>
                      </button>
                    );
                  })}
                </div>
                {day && (
                  <div className="pb-slots" aria-live="polite">
                    {slots === null ? <p className="muted small">{t("loading")}</p> : slots.length === 0 ? <p className="muted small">{t("pb.noSlots")}</p> : slots.map((s) => (
                      <button type="button" key={s} className={`pb-slot ${slot === s ? "active" : ""}`} aria-pressed={slot === s} onClick={() => setSlot(s)}>
                        {new Date(s).toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" })}
                      </button>
                    ))}
                  </div>
                )}
              </fieldset>
            )}
            {slot && (
              <fieldset className="pb-step">
                <legend><span className="pb-n">{clinic.branches.length > 1 ? 4 : 3}</span>{t("pb.details")}</legend>
                <p className="pb-summary">{when(slot)} · {L(b)}</p>
                <div className="field"><label htmlFor="pb-name">{t("pb.name")}</label><input id="pb-name" required minLength={3} autoComplete="name" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} /></div>
                <div className="field"><label htmlFor="pb-phone">{t("pb.phone")}</label><input id="pb-phone" required type="tel" inputMode="tel" autoComplete="tel" dir="ltr" placeholder="01xxxxxxxxx" value={form.phone} onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))} /></div>
                <div className="field"><label htmlFor="pb-note">{t("pb.note")}</label><textarea id="pb-note" rows={2} maxLength={500} value={form.note} onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))} /></div>
                <div className="pb-hp" aria-hidden="true">
                  <label htmlFor="pb-website">Website</label>
                  <input id="pb-website" tabIndex={-1} autoComplete="off" value={form.website} onChange={(e) => setForm((f) => ({ ...f, website: e.target.value }))} />
                </div>
                <div className="field field-check">
                  <input id="pb-consent" type="checkbox" required checked={form.consent} onChange={(e) => setForm((f) => ({ ...f, consent: e.target.checked }))} />
                  <label htmlFor="pb-consent">{t("pb.consent")}</label>
                </div>
                {error && <p className="form-error" role="alert">{error}</p>}
                <button className="btn btn-primary btn-block" disabled={busy}>{busy ? t("pb.sending") : t("pb.send")}</button>
                <p className="muted tiny center">{t("pb.notYet")}</p>
              </fieldset>
            )}
          </form>
        )}
      </div>
    </div>
  );
}
