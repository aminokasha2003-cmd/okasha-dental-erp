import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { Link, useNavigate } from "react-router-dom";
import { get, getAll, type Page } from "../api";
import { useAuth } from "../auth";
import { useI18n, type TKey } from "../i18n";
import { Icon, type IconName } from "../components/Icon";
import { locale, money } from "../format";
import type { Appointment, Chair, LabSummary } from "../types";
import { personName, useCurrency } from "./BillingParts";

// The home page is a set of widgets, after Amin's dashboard reference: today at a
// glance, a clock, quick buttons, the chairs timeline, who is in the chair, the
// week's takings and patients due for a check-up. Each widget shows only for
// roles that can open what it links to.

interface Step {
  key: TKey;
  to: string;
  module: string;
  done: () => Promise<boolean>;
}

interface Recall {
  id: number;
  ar: string;
  en: string;
  phone: string;
  whatsapp: boolean;
  language: string;
  last_visit: string;
  last_procedure: { ar: string; en: string } | null;
}

const count = async (path: string) => (await get<Page<unknown>>(path)).count;

function isoToday() {
  return new Date().toLocaleDateString("en-CA");
}

function useNow(stepMs = 1000) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), stepMs);
    return () => window.clearInterval(timer);
  }, [stepMs]);
  return now;
}

export function Home() {
  const { can } = useAuth();
  const [today, setToday] = useState<Appointment[] | null>(null);
  const [queue, setQueue] = useState<{ waiting: Appointment[]; in_chair: Appointment[] } | null>(null);
  const [takings, setTakings] = useState<{ date: string; total: string }[] | null>(null);

  useEffect(() => {
    const load = () => {
      if (can("appointments")) {
        get<Appointment[]>(`/api/appointments/?date=${isoToday()}`).then(setToday).catch(() => setToday([]));
        get<{ waiting: Appointment[]; in_chair: Appointment[] }>("/api/appointments/queue/").then(setQueue).catch(() => undefined);
      }
      if (can("billing")) get<{ date: string; total: string }[]>("/api/billing/daily/?days=7").then(setTakings).catch(() => undefined);
    };
    load();
    const timer = window.setInterval(load, 60_000);
    return () => window.clearInterval(timer);
  }, [can]);

  return (
    <div className="page home">
      <div className="home-top">
        <TodayCard today={today} queue={queue} takings={takings} />
        <ClockCard />
        <QuickAccess />
      </div>
      {can("appointments") && <ChairTimeline rows={today} />}
      <div className="home-widgets">
        {can("appointments") && <InChairs queue={queue} />}
        {can("billing") && <WeekTakings days={takings} />}
        {can("lab") && <LabWidget />}
        {can("appointments") && can("patients") && <Recalls />}
        <SetupWidget />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ today */

function TodayCard({
  today,
  queue,
  takings,
}: {
  today: Appointment[] | null;
  queue: { waiting: Appointment[]; in_chair: Appointment[] } | null;
  takings: { date: string; total: string }[] | null;
}) {
  const { t, lang } = useI18n();
  const { me, can } = useAuth();
  const now = useNow(60_000);
  const loc = locale(lang);
  const visits = (today ?? []).filter((a) => !["cancelled"].includes(a.status));
  const seen = visits.filter((a) => a.status === "completed").length;
  const collected = takings?.[takings.length - 1]?.total;
  const [lab, setLab] = useState<LabSummary | null>(null);
  const labOnly = can("lab") && !can("appointments");
  useEffect(() => {
    if (labOnly) get<LabSummary>("/api/lab/summary/").then(setLab).catch(() => undefined);
  }, [labOnly]);
  const hour = now.getHours();
  const greet: TKey = hour < 12 ? "greet.morning" : hour < 17 ? "greet.afternoon" : "greet.evening";
  return (
    <section className="widget today-card" style={{ "--i": 0 } as CSSProperties}>
      <p className="today-greet">{t(greet, { name: me?.first_name || me?.username || "" })}</p>
      <div className="today-date">
        <span className="today-day">{now.toLocaleDateString(loc, { day: "2-digit" })}</span>
        <span className="today-rest">
          <strong>{now.toLocaleDateString(loc, { weekday: "long" })}</strong>
          <span>{now.toLocaleDateString(loc, { month: "long", year: "numeric" })}</span>
        </span>
      </div>
      <div className="today-stats">
        {can("appointments") && (
          <div>
            <p className="today-figure">
              {today === null ? "…" : seen}
              <small>/{visits.length}</small>
            </p>
            <p className="today-label">{t("dash.seen")}</p>
          </div>
        )}
        {can("billing") && (
          <div>
            <p className="today-figure">{collected === undefined ? "…" : compact(Number(collected), lang)}</p>
            <p className="today-label">{t("dash.collected")}</p>
          </div>
        )}
        {can("appointments") && (
          <div>
            <p className={`today-figure ${queue?.waiting.length ? "accent" : ""}`}>{queue ? queue.waiting.length : "…"}</p>
            <p className="today-label">{t("dash.waiting")}</p>
          </div>
        )}
        {labOnly && (
          <>
            <div>
              <p className="today-figure">{lab ? lab.mine : "…"}</p>
              <p className="today-label">{t("dash.myCases")}</p>
            </div>
            <div>
              <p className={`today-figure ${lab?.due_today ? "accent" : ""}`}>{lab ? lab.due_today : "…"}</p>
              <p className="today-label">{t("dash.dueToday")}</p>
            </div>
          </>
        )}
      </div>
      {can("appointments", "create") && (
        <div className="today-actions">
          <Link className="btn btn-accent" to="/appointments?book=1">
            <Icon name="plus" size={18} /> {t("dash.book")}
          </Link>
          {can("patients", "create") && (
            <Link className="btn btn-ghost-light" to="/patients?new=1">
              {t("dash.newPatient")}
            </Link>
          )}
        </div>
      )}
    </section>
  );
}

function compact(n: number, lang: string) {
  return new Intl.NumberFormat(locale(lang), { notation: n >= 10_000 ? "compact" : "standard", maximumFractionDigits: 1 }).format(n);
}

/* ------------------------------------------------------------ clock */

function ClockCard() {
  const { t, lang } = useI18n();
  const now = useNow(1000);
  const loc = locale(lang);
  const s = now.getSeconds();
  const m = now.getMinutes() + s / 60;
  const h = (now.getHours() % 12) + m / 60;
  const time = now.toLocaleTimeString(loc, { hour: "numeric", minute: "2-digit" });
  const [main, suffix] = splitPeriod(time);
  return (
    <section className="widget clock-card" style={{ "--i": 1 } as CSSProperties} aria-label={t("dash.clock")}>
      <div className="clock-face" role="img" aria-label={now.toLocaleTimeString(loc)}>
        <svg viewBox="0 0 200 200" aria-hidden="true">
          {Array.from({ length: 60 }, (_, i) => {
            const angle = (i * 6 * Math.PI) / 180;
            const long = i % 5 === 0;
            const r1 = long ? 82 : 86;
            return (
              <line
                key={i}
                className={`tick ${long ? "tick-hour" : ""} ${i <= s ? "tick-on" : ""}`}
                x1={100 + r1 * Math.sin(angle)}
                y1={100 - r1 * Math.cos(angle)}
                x2={100 + 92 * Math.sin(angle)}
                y2={100 - 92 * Math.cos(angle)}
              />
            );
          })}
          <line className="hand hand-hour" x1="100" y1="100" x2="100" y2="58" transform={`rotate(${h * 30} 100 100)`} />
          <line className="hand hand-minute" x1="100" y1="100" x2="100" y2="38" transform={`rotate(${m * 6} 100 100)`} />
          <line className="hand hand-second" x1="100" y1="112" x2="100" y2="30" transform={`rotate(${s * 6} 100 100)`} />
          <circle className="hand-hub" cx="100" cy="100" r="4" />
        </svg>
      </div>
      <p className="clock-digital">
        <span className="clock-time">{main}</span>
        {suffix && <span className="clock-period">{suffix}</span>}
      </p>
      <p className="clock-zone">{t("dash.cairo")}</p>
    </section>
  );
}

/** "8:34 PM" → ["8:34", "PM"]; Arabic "٨:٣٤ م" → ["٨:٣٤", "م"]. */
function splitPeriod(time: string): [string, string] {
  const match = time.match(/^([\d٠-٩:.]+)\s*(.*)$/);
  return match ? [match[1], match[2]] : [time, ""];
}

/* ----------------------------------------------------- quick access */

const QUICK: { to: string; label: TKey; icon: IconName; module: string; action?: string }[] = [
  { to: "/patients", label: "nav.patients", icon: "patients", module: "patients" },
  { to: "/patients?new=1", label: "dash.newPatient", icon: "plus", module: "patients", action: "create" },
  { to: "/appointments", label: "dash.calendar", icon: "calendar", module: "appointments" },
  { to: "/billing", label: "dash.cashbox", icon: "cash", module: "billing" },
  { to: "/clinical", label: "nav.clinical", icon: "tooth", module: "clinical" },
  { to: "/lab", label: "lab.tab.board", icon: "flask", module: "lab" },
  { to: "/billing?tab=installments", label: "bill.installments", icon: "wallet", module: "billing" },
  { to: "/procedures", label: "nav.procedures", icon: "list", module: "masterdata" },
];

function QuickAccess() {
  const { t } = useI18n();
  const { can } = useAuth();
  const items = QUICK.filter((q) => can(q.module, q.action)).slice(0, 6);
  return (
    <section className="widget quick-card" style={{ "--i": 2 } as CSSProperties}>
      <h2 className="widget-title">{t("dash.quick")}</h2>
      <div className="quick-grid">
        {items.map((q, i) => (
          <Link key={q.to} to={q.to} className="quick-tile" style={{ "--i": i } as CSSProperties}>
            <span className="quick-icon">
              <Icon name={q.icon} size={22} />
            </span>
            <span>{t(q.label)}</span>
          </Link>
        ))}
      </div>
    </section>
  );
}

/* --------------------------------------------------- chair timeline */

function ChairTimeline({ rows }: { rows: Appointment[] | null }) {
  const { t, lang, name } = useI18n();
  const navigate = useNavigate();
  const now = useNow(60_000);
  const [chairs, setChairs] = useState<Chair[]>([]);
  useEffect(() => {
    getAll<Chair>("/api/masterdata/chairs/?is_active=true").then(setChairs).catch(() => undefined);
  }, []);
  const visits = (rows ?? []).filter((a) => a.status !== "cancelled");
  const hours = useMemo(() => {
    let first = 10;
    let last = 21;
    for (const a of visits) {
      first = Math.min(first, new Date(a.start).getHours());
      last = Math.max(last, Math.ceil((new Date(a.end).getTime() - new Date(new Date(a.end).toDateString()).getTime()) / 3_600_000));
    }
    return { first, last: Math.min(24, Math.max(last, first + 4)) };
  }, [visits]);
  const span = (hours.last - hours.first) * 60;
  const pos = (iso: string) => {
    const d = new Date(iso);
    return ((d.getHours() - hours.first) * 60 + d.getMinutes()) / span;
  };
  const lanes = chairs.length ? chairs : [];
  const unassigned = visits.filter((a) => !a.chair || !chairs.some((c) => c.id === a.chair));
  const nowPos = ((now.getHours() - hours.first) * 60 + now.getMinutes()) / span;
  const loc = locale(lang);
  const ticks = Array.from({ length: hours.last - hours.first + 1 }, (_, i) => hours.first + i);

  return (
    <section className="widget timeline-card" style={{ "--i": 3 } as CSSProperties}>
      <header className="widget-head">
        <h2 className="widget-title">{t("dash.today")}</h2>
        <Link to="/appointments" className="widget-link">
          {t("dash.openCalendar")} <Icon name="arrow" size={16} className="flip-rtl" />
        </Link>
      </header>
      {rows !== null && visits.length === 0 ? (
        <p className="muted">{t("dash.noVisits")}</p>
      ) : (
        <div className="timeline-scroll">
          <div className="timeline" style={{ "--hours": hours.last - hours.first } as CSSProperties}>
            <div className="tl-hours" aria-hidden="true">
              <span />
              <div className="tl-track">
                {ticks.map((h) => (
                  <span key={h} style={{ insetInlineStart: `${((h - hours.first) * 60 * 100) / span}%` }}>
                    {new Date(2000, 0, 1, h).toLocaleTimeString(loc, { hour: "numeric" })}
                  </span>
                ))}
              </div>
            </div>
            {[...lanes.map((c) => ({ key: String(c.id), label: name(c), items: visits.filter((a) => a.chair === c.id) })), ...(unassigned.length ? [{ key: "none", label: t("dash.noChair"), items: unassigned }] : [])].map((lane) => (
              <div key={lane.key} className="tl-row">
                <span className="tl-label">{lane.label}</span>
                <div className="tl-track">
                  {lane.items.map((a, i) => (
                    <button
                      key={a.id}
                      className={`tl-visit st-${a.status}`}
                      style={{ insetInlineStart: `${pos(a.start) * 100}%`, width: `calc(${(a.duration_minutes / span) * 100}% - 4px)`, "--i": i } as CSSProperties}
                      title={`${personName(a.patient_name, lang)} · ${new Date(a.start).toLocaleTimeString(loc, { hour: "numeric", minute: "2-digit" })}`}
                      onClick={() => navigate(`/patients/${a.patient}`)}
                    >
                      <strong>{personName(a.patient_name, lang)}</strong>
                      <span>{(lang === "ar" ? a.procedure_name_ar || a.procedure_name_en : a.procedure_name_en || a.procedure_name_ar) || a.reason}</span>
                    </button>
                  ))}
                </div>
              </div>
            ))}
            {nowPos > 0 && nowPos < 1 && (
              <div className="tl-now-wrap" aria-hidden="true">
                <span />
                <div className="tl-track">
                  <div className="tl-now" style={{ insetInlineStart: `${nowPos * 100}%` }}>
                    <span>{now.toLocaleTimeString(loc, { hour: "numeric", minute: "2-digit" })}</span>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
      <ul className="tl-legend">
        {(["booked", "arrived", "in_chair", "completed", "no_show"] as const).map((s) => (
          <li key={s}>
            <span className={`tl-dot st-${s}`} /> {t(`ap.status.${s}` as TKey)}
          </li>
        ))}
      </ul>
    </section>
  );
}

/* ----------------------------------------------------- in the chairs */

function InChairs({ queue }: { queue: { waiting: Appointment[]; in_chair: Appointment[] } | null }) {
  const { t, lang } = useI18n();
  const now = useNow(60_000);
  const initials = (n: { ar: string; en: string }) =>
    personName(n, lang)
      .split(/\s+/)
      .slice(0, 2)
      .map((w) => w[0])
      .join("")
      .toUpperCase();
  return (
    <section className="widget chairs-card">
      <p className="live-label">
        <span className="live-dot" aria-hidden="true" /> {t("dash.inChairs")}
      </p>
      {queue === null ? (
        <p className="muted">{t("loading")}</p>
      ) : queue.in_chair.length === 0 ? (
        <p className="muted">{t("dash.chairsFree")}</p>
      ) : (
        <ul className="plain-list chair-list">
          {queue.in_chair.map((a, i) => {
            const left = Math.round((new Date(a.end).getTime() - now.getTime()) / 60_000);
            return (
              <li key={a.id} style={{ "--i": i } as CSSProperties}>
                <Link to={`/patients/${a.patient}`} className="chair-person">
                  <span className={`chair-avatar tone-${i % 3}`}>{initials(a.patient_name)}</span>
                  <span className="grow">
                    <strong className="block">{personName(a.patient_name, lang)}</strong>
                    <span className="small ink-2 block">
                      {[(lang === "ar" ? a.procedure_name_ar : a.procedure_name_en) || a.reason, lang === "ar" ? a.dentist_name_ar : a.dentist_name_en].filter(Boolean).join(" · ")}
                    </span>
                    <span className="small strong block chair-left">
                      {left > 0 ? t("dash.minLeft", { n: left }) : t("dash.overTime")}
                      {a.patient_alerts.length > 0 && <span className="alert-text"> · {a.patient_alerts.join(", ")}</span>}
                    </span>
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
      <div className="waiting-row">
        <span className="muted">{t("dash.waitingRoom")}</span>
        <span className="strong">{queue && queue.waiting.length ? queue.waiting.map((a) => personName(a.patient_name, lang).split(" ")[0]).join(" · ") : "—"}</span>
      </div>
    </section>
  );
}

/* ---------------------------------------------------- week takings */

function WeekTakings({ days }: { days: { date: string; total: string }[] | null }) {
  const { t, lang } = useI18n();
  const currency = useCurrency();
  const max = Math.max(1, ...(days ?? []).map((d) => Number(d.total)));
  const sum = (days ?? []).reduce((acc, d) => acc + Number(d.total), 0);
  return (
    <section className="widget week-card">
      <header className="widget-head">
        <h2 className="widget-title">{t("dash.week")}</h2>
        <span className="muted small">{t("dash.weekTotal", { n: money(sum, lang), cur: currency })}</span>
      </header>
      <div className="tooth-bars" role="img" aria-label={t("dash.weekTotal", { n: money(sum, lang), cur: currency })}>
        {(days ?? []).map((d, i) => {
          const value = Number(d.total);
          const isToday = i === (days?.length ?? 0) - 1;
          const day = new Date(`${d.date}T12:00:00`);
          return (
            <div key={d.date} className={`tooth-bar ${isToday ? "is-today" : ""}`} style={{ "--h": `${Math.max(8, (value / max) * 100)}%`, "--i": i } as CSSProperties}>
              <span className="tooth-value">{value ? compact(value, lang) : "–"}</span>
              <span className="tooth-crown" />
              <span className="tooth-roots" aria-hidden="true">
                <i />
                <i />
              </span>
              <span className="tooth-day">{day.toLocaleDateString(locale(lang), { weekday: "short" })}</span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

/* -------------------------------------------------------------- lab */

function LabWidget() {
  const { t } = useI18n();
  const [s, setS] = useState<LabSummary | null>(null);
  useEffect(() => {
    get<LabSummary>("/api/lab/summary/").then(setS).catch(() => undefined);
  }, []);
  const items: { label: TKey; n: number | undefined; to: string; tone?: string }[] = [
    { label: "lab.stage.ready", n: s?.by_stage.ready, to: "/lab", tone: "ready" },
    { label: "lab.filter.overdue", n: s?.overdue, to: "/lab", tone: s?.overdue ? "warn" : "" },
    { label: "dash.dueToday", n: s?.due_today, to: "/lab" },
    { label: "lab.filter.unassigned", n: s?.unassigned, to: "/lab" },
  ];
  return (
    <section className="widget lab-widget">
      <header className="widget-head">
        <h2 className="widget-title">{t("lab.title")}</h2>
        <Link to="/lab" className="widget-link">
          {t("lab.tab.board")} <Icon name="arrow" size={16} className="flip-rtl" />
        </Link>
      </header>
      <div className="lab-stats">
        {items.map((x) => (
          <Link key={x.label} to={x.to} className={`lab-stat ${x.tone ?? ""}`}>
            <span className="lab-stat-n">{x.n ?? "…"}</span>
            <span className="small">{t(x.label)}</span>
          </Link>
        ))}
      </div>
      <p className="muted small">{t("dash.labOpen", { n: s?.open ?? "…" })}</p>
    </section>
  );
}

/* ---------------------------------------------------------- recalls */

function waLink(phone: string, text: string) {
  let digits = phone.replace(/[^\d]/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  else if (digits.startsWith("0")) digits = `20${digits.slice(1)}`;
  return `https://wa.me/${digits}?text=${encodeURIComponent(text)}`;
}

function Recalls() {
  const { t, lang } = useI18n();
  const { me } = useAuth();
  const [data, setData] = useState<{ count: number; results: Recall[] } | null>(null);
  useEffect(() => {
    get<{ count: number; results: Recall[] }>("/api/appointments/recalls/").then(setData).catch(() => undefined);
  }, []);
  const clinic = me?.clinic;
  const message = (r: Recall) => {
    const nameIn = r.language === "ar" ? r.ar || r.en : r.en || r.ar;
    const clinicName = (r.language === "ar" ? clinic?.name_ar || clinic?.name_en : clinic?.name_en || clinic?.name_ar) ?? "";
    return r.language === "ar"
      ? `مرحبًا ${nameIn}، حان موعد الكشف الدوري في ${clinicName}. ردّ على هذه الرسالة لنحجز لك موعدًا.`
      : `Hello ${nameIn}, it's time for your check-up at ${clinicName}. Reply to this message and we'll book you in.`;
  };
  return (
    <section className="widget recall-card">
      <header className="widget-head">
        <h2 className="widget-title">{t("dash.recalls")}</h2>
        <span className="widget-count">{data ? data.count : "…"}</span>
      </header>
      {data && data.results.length === 0 && <p className="muted">{t("dash.noRecalls")}</p>}
      <ul className="plain-list recall-list">
        {(data?.results ?? []).slice(0, 5).map((r, i) => (
          <li key={r.id} style={{ "--i": i } as CSSProperties}>
            <Link to={`/patients/${r.id}`} className="recall-person">
              <span className="recall-avatar">{personName(r, lang).split(/\s+/).slice(0, 2).map((w) => w[0]).join("").toUpperCase()}</span>
              <span className="grow">
                <strong className="block">{personName(r, lang)}</strong>
                <span className="small muted block">
                  {[r.last_procedure ? personName(r.last_procedure, lang) : "", t("dash.lastVisit", { date: new Date(r.last_visit).toLocaleDateString(locale(lang), { month: "long", year: "numeric" }) })].filter(Boolean).join(" · ")}
                </span>
              </span>
            </Link>
            {r.whatsapp && r.phone ? (
              <a className="btn btn-small wa-btn" href={waLink(r.phone, message(r))} target="_blank" rel="noreferrer">
                WhatsApp
              </a>
            ) : (
              <span className="muted small">{t("dash.noWhatsapp")}</span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

/* ------------------------------------------------------------ setup */

function SetupWidget() {
  const { t } = useI18n();
  const { me, can } = useAuth();
  const [status, setStatus] = useState<Record<string, boolean | undefined>>({});
  const steps = useMemo<Step[]>(
    () => [
      { key: "home.step.clinic", to: "/settings", module: "settings", done: async () => Boolean(me?.clinic?.phone && me?.clinic?.tax_registration_number) },
      { key: "home.step.branch", to: "/settings", module: "settings", done: async () => (await count("/api/masterdata/branches/")) > 0 },
      { key: "home.step.chairs", to: "/settings", module: "settings", done: async () => (await count("/api/masterdata/chairs/")) > 0 },
      { key: "home.step.hours", to: "/settings", module: "settings", done: async () => (await count("/api/masterdata/working-hours/")) > 0 },
      { key: "home.step.staff", to: "/staff", module: "masterdata", done: async () => (await count("/api/masterdata/staff/")) > 0 },
      { key: "home.step.procedures", to: "/procedures", module: "masterdata", done: async () => (await count("/api/masterdata/procedures/")) > 0 },
      { key: "home.step.users", to: "/users", module: "users", done: async () => (await count("/api/users/")) > 1 },
    ],
    [me],
  );
  const mine = steps.filter((s) => can(s.module, "edit"));
  useEffect(() => {
    for (const step of mine) {
      step
        .done()
        .then((done) => setStatus((s) => ({ ...s, [step.key]: done })))
        .catch(() => undefined);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [steps]);
  const open = mine.filter((s) => status[s.key] === false);
  // Only shown while something is still missing.
  if (open.length === 0) return null;
  return (
    <section className="widget setup-card">
      <header className="widget-head">
        <h2 className="widget-title">{t("home.title")}</h2>
        <span className="widget-count">{open.length}</span>
      </header>
      <ul className="plain-list">
        {open.map((s) => (
          <li key={s.key}>
            <Icon name="circle" size={16} />
            <span className="grow">{t(s.key)}</span>
            <Link to={s.to} className="btn btn-small">{t("home.open")}</Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
