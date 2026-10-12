import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { Link } from "react-router-dom";
import { get, post } from "../api";
import { useAuth } from "../auth";
import { useI18n, type TKey } from "../i18n";
import { Icon } from "../components/Icon";
import { fmtDate, money } from "../format";
import type { MyStaff, Payslip } from "../types";
import { errorText, useCurrency } from "./BillingParts";
import { DAY_PILL, LEAVE_PILL, LeaveDialog, RUN_PILL, monthLabel, shiftText, useHm, usePayslipPrint } from "./PayrollParts";

/** The signed-in person's own staff record; null while loading, false when the login has no staff profile. */
export function useMyStaff() {
  const linked = Boolean(useAuth().me?.staff_member);
  const [me, setMe] = useState<MyStaff | null | false>(null);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (!linked) {
      setMe(false);
      return;
    }
    get<MyStaff>("/api/staff/me/").then(setMe).catch(() => setMe(false));
  }, [version, linked]);
  useEffect(() => {
    const timer = window.setInterval(() => setVersion((v) => v + 1), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  const reload = useCallback(() => setVersion((v) => v + 1), []);
  return { me, reload };
}

/** Clock in / clock out for the signed-in person: today's shift, one big button, time worked and a late notice. */
export function MyClock({ me, reload, compact = false }: { me: MyStaff; reload: () => void; compact?: boolean }) {
  const { t } = useI18n();
  const hm = useHm();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const d = me.today;
  const open = d.open_record;
  const clock = async () => {
    setBusy(true);
    setError("");
    try {
      await post(open ? "/api/staff/me/clock-out/" : "/api/staff/me/clock-in/", {});
      reload();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  const first = d.records[0];
  return (
    <section className={`widget my-clock ${open ? "is-in" : ""}`} style={{ "--i": 3 } as CSSProperties} aria-label={t("pr.my.clockTitle")}>
      <header className="widget-head">
        <h2 className="widget-title">{t("pr.my.clockTitle")}</h2>
        <span className={DAY_PILL[d.status]}>{t(`pr.st.${d.status}` as TKey)}</span>
      </header>
      <p className="my-shift">
        <Icon name="calendar" size={16} />{" "}
        {d.leave ? t(`pr.leave.${d.leave.kind}` as TKey) : d.shifts.length ? <span dir="ltr">{d.shifts.map(shiftText).join(" · ")}</span> : <span className="muted">{t("pr.my.noShift")}</span>}
      </p>
      {d.status !== "leave" && (
        <button className={`btn clock-btn ${open ? "out" : "in"}`} disabled={busy} onClick={() => void clock()}>
          <Icon name="clock" size={22} />
          <span>{open ? t("pr.clockOut") : t("pr.clockIn")}</span>
        </button>
      )}
      <div className="my-clock-facts">
        <span>
          <span className="small muted block">{t("pr.my.workedSoFar")}</span>
          <strong>{hm(d.worked_now)}</strong>
        </span>
        {first && (
          <span>
            <span className="small muted block">{t("pr.my.since")}</span>
            <strong dir="ltr">{first.in}</strong>
          </span>
        )}
      </div>
      {d.late_minutes > 0 && <p className="late-badge">{t("pr.my.lateNotice", { m: hm(d.late_minutes) })}</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
      {compact && (
        <Link to="/my-work" className="widget-link">
          {t("pr.my.link")} <Icon name="arrow" size={16} className="flip-rtl" />
        </Link>
      )}
    </section>
  );
}

/** Home widget: shown only when the login is linked to a staff profile. */
export function MyClockWidget() {
  const { me, reload } = useMyStaff();
  if (!me) return null;
  return <MyClock me={me} reload={reload} compact />;
}

/** "My work": a staff member's own clock, month, leave and payslips. */
export function MyWork() {
  const { t, lang } = useI18n();
  const currency = useCurrency();
  const hm = useHm();
  const slips = usePayslipPrint();
  const { me, reload } = useMyStaff();
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState("");
  if (me === null) return <p className="muted pad">{t("loading")}</p>;
  if (me === false)
    return (
      <div className="page">
        <section className="card pad empty-state">
          <Icon name="badge" size={28} />
          <p className="lead">{t("pr.my.noProfile")}</p>
        </section>
      </div>
    );
  const m = me.month;
  const b = me.leave.balance;
  const print = async (id: number) => {
    setError("");
    try {
      slips.one(await get<Payslip>(`/api/staff/me/payslips/${id}/`));
    } catch (err) {
      setError(errorText(err));
    }
  };
  const withdraw = async (id: number) => {
    try {
      await post(`/api/staff/me/leave/${id}/cancel/`, {});
      reload();
    } catch (err) {
      setError(errorText(err));
    }
  };
  return (
    <div className="page my-work">
      <header className="page-head">
        <div>
          <h1>{t("pr.my.title")}</h1>
          <p className="muted">{t("pr.my.sub")}</p>
        </div>
        <button className="btn btn-primary" onClick={() => setAsking(true)}><Icon name="plus" size={16} /> {t("pr.my.requestLeave")}</button>
      </header>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="home-widgets my-grid">
        <MyClock me={me} reload={reload} />
        <section className="widget">
          <header className="widget-head"><h2 className="widget-title">{t("pr.my.month", { month: monthLabel(m.month, lang) })}</h2></header>
          <div className="inv-tiles my-tiles">
            <div className="inv-tile"><strong>{m.present_days}</strong><span className="small">{t("pr.sum.present")}</span></div>
            <div className="inv-tile"><strong>{hm(m.worked_minutes)}</strong><span className="small">{t("pr.worked")}</span></div>
            <div className={`inv-tile ${m.late_minutes ? "warn" : ""}`}><strong>{m.late_minutes ? hm(m.late_minutes) : "—"}</strong><span className="small">{t("pr.late")}</span></div>
            <div className="inv-tile"><strong>{m.overtime_minutes ? hm(m.overtime_minutes) : "—"}</strong><span className="small">{t("pr.overtime")}</span></div>
            <div className={`inv-tile ${m.absent_days ? "warn" : ""}`}><strong>{m.absent_days}</strong><span className="small">{t("pr.sum.absent")}</span></div>
          </div>
        </section>
        <section className="widget">
          <header className="widget-head"><h2 className="widget-title">{t("pr.my.leave")}</h2></header>
          <p className="my-balance">
            <strong>{b.remaining}</strong>
            <span className="muted">{t("pr.my.leaveLeft", { n: b.entitlement })}</span>
          </p>
          <span className="leave-meter wide" style={{ "--p": `${Math.max(0, Math.min(100, (b.remaining / Math.max(b.entitlement, 1)) * 100))}%` } as CSSProperties} />
          {me.leave.requests.length === 0 ? (
            <p className="muted small">{t("pr.my.noLeave")}</p>
          ) : (
            <ul className="plain-list mini-list">
              {me.leave.requests.map((l) => (
                <li key={l.id}>
                  <span className="grow">
                    {t(`pr.leave.${l.kind}` as TKey)} · {fmtDate(l.start_date, lang)}
                    {l.end_date !== l.start_date && ` – ${fmtDate(l.end_date, lang)}`}
                  </span>
                  <span className={LEAVE_PILL[l.status]}>{t(`pr.leave.s.${l.status}` as TKey)}</span>
                  {l.status === "pending" && <button className="btn btn-small" onClick={() => void withdraw(l.id)}>{t("pr.my.withdraw")}</button>}
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className="widget">
          <header className="widget-head"><h2 className="widget-title">{t("pr.payslips")}</h2></header>
          {me.payslips.length === 0 ? (
            <p className="muted small">{t("pr.my.noPayslips")}</p>
          ) : (
            <ul className="plain-list mini-list">
              {me.payslips.map((p) => (
                <li key={p.id}>
                  <span className="grow">{monthLabel(p.period, lang)}</span>
                  <strong className="num">{money(p.net, lang)} {currency}</strong>
                  <span className={RUN_PILL[p.status]}>{t(`pr.run.${p.status}` as TKey)}</span>
                  <button className="btn btn-small" onClick={() => void print(p.id)} aria-label={t("pr.payslip")}><Icon name="file" size={16} /></button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
      {asking && <LeaveDialog self onClose={() => setAsking(false)} onSaved={() => { setAsking(false); reload(); }} />}
    </div>
  );
}
