import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { del, get, getAll, patch, post, type Page } from "../api";
import { useAuth } from "../auth";
import { useI18n, type TKey } from "../i18n";
import { BarList, ColumnChart, KpiTile } from "../components/Charts";
import { CrudSection, Modal } from "../components/Crud";
import { Icon } from "../components/Icon";
import { exportPdf } from "../components/pdf";
import { escapeHtml, printDocument, useLetterhead } from "../components/print";
import { fmtDate, locale, money } from "../format";
import type {
  AttendanceRecord,
  DayBoard,
  DayRow,
  LeaveBalanceRow,
  LeaveRequest,
  MonthSummary,
  PayoutMethod,
  PayrollLine,
  PayrollRun,
  PayrollSettings,
  Payslip,
  RosterWeek,
  SalaryAdvance,
  ShiftOut,
  ShiftTemplate,
  StaffDashboard,
  StaffProfileRow,
  StaffRef,
  StaffSummary,
} from "../types";
import { errorText, personName, useCurrency } from "./BillingParts";
import { useBranches } from "./InventoryParts";
import {
  AdvanceDialog,
  Avatar,
  DAY_PILL,
  LEAVE_PILL,
  LeaveDialog,
  LineEditor,
  PAYOUTS,
  ProfileDialog,
  RUN_PILL,
  RecordDialog,
  RosterCellDialog,
  StaffSelect,
  addDays,
  dayLabel,
  isoToday,
  mondayOf,
  monthLabel,
  shiftMonth,
  shiftText,
  thisMonth,
  useHm,
  usePayslipPrint,
  useStaffRows,
} from "./PayrollParts";

type Tab = "today" | "roster" | "attendance" | "leave" | "payroll" | "advances" | "profiles" | "dashboard";

/** Staff and payroll: who is in today, the roster, attendance, leave, advances and the monthly payroll. */
export function Payroll() {
  const { t } = useI18n();
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const tab = (params.get("tab") as Tab) || "today";
  const [summary, setSummary] = useState<StaffSummary | null>(null);
  const [version, setVersion] = useState(0);
  const [newRun, setNewRun] = useState(false);
  const bump = useCallback(() => setVersion((v) => v + 1), []);
  useEffect(() => {
    get<StaffSummary>("/api/staff/summary/").then(setSummary).catch(() => undefined);
  }, [version]);
  const go = (next: Tab, extra: Record<string, string> = {}) => setParams({ tab: next, ...extra }, { replace: true });
  const tabs: { id: Tab; label: TKey }[] = [
    { id: "today", label: "pr.tab.today" },
    { id: "roster", label: "pr.tab.roster" },
    { id: "attendance", label: "pr.tab.attendance" },
    { id: "leave", label: "pr.tab.leave" },
    { id: "payroll", label: "pr.tab.payroll" },
    { id: "advances", label: "pr.tab.advances" },
    { id: "profiles", label: "pr.tab.profiles" },
    { id: "dashboard", label: "pr.tab.dashboard" },
  ];
  const s = summary;
  const stats: { label: TKey; n?: number; tab: Tab; tone?: string }[] = [
    { label: "pr.hero.rostered", n: s?.rostered, tab: "today" },
    { label: "pr.hero.in", n: s?.in_now, tab: "today", tone: s?.in_now ? "good" : "" },
    { label: "pr.hero.late", n: s?.late, tab: "today", tone: s?.late ? "warn" : "" },
    { label: "pr.hero.absent", n: s?.absent, tab: "today", tone: s?.absent ? "warn" : "" },
    { label: "pr.hero.leave", n: s?.on_leave, tab: "leave" },
    { label: "pr.hero.pending", n: s?.pending_leave, tab: "leave", tone: s?.pending_leave ? "accent" : "" },
  ];
  return (
    <div className="page staff-page">
      <section className="lab-hero staff-hero">
        <div>
          <h1>{t("pr.title")}</h1>
          <p>{t("pr.heroSub")}</p>
        </div>
        <div className="lab-hero-stats">
          {stats.map((x) => (
            <button key={x.label} className={`lab-hero-stat ${x.tone ?? ""}`} onClick={() => go(x.tab, x.tab === "leave" ? { status: "pending" } : {})}>
              <strong>{x.n ?? "…"}</strong>
              <span>{t(x.label)}</span>
            </button>
          ))}
        </div>
        {can("staff", "create") && (
          <button className="btn btn-accent" onClick={() => { go("payroll"); setNewRun(true); }}>
            <Icon name="wallet" size={18} /> {t("pr.runPayroll")}
          </button>
        )}
      </section>
      <div className="segmented tabs inv-tabs" role="tablist">
        {tabs.map((x) => (
          <button key={x.id} role="tab" aria-selected={tab === x.id} className={tab === x.id ? "active" : ""} onClick={() => go(x.id)}>
            {t(x.label)}
            {x.id === "leave" && s?.pending_leave ? <span className="chip-count tab-count">{s.pending_leave}</span> : null}
          </button>
        ))}
      </div>
      {tab === "today" && <Today version={version} onChanged={bump} />}
      {tab === "roster" && <Roster />}
      {tab === "attendance" && <Attendance />}
      {tab === "leave" && <Leave initialStatus={params.get("status") ?? "pending"} onChanged={bump} />}
      {tab === "payroll" && <PayrollTab creating={newRun} setCreating={setNewRun} onChanged={bump} />}
      {tab === "advances" && <Advances />}
      {tab === "profiles" && <Profiles />}
      {tab === "dashboard" && <Dashboard />}
    </div>
  );
}

function BranchFilter({ value, onChange }: { value: number | ""; onChange: (v: number | "") => void }) {
  const { t, name } = useI18n();
  const branches = useBranches();
  if (branches.length < 2) return null;
  return (
    <label className="field inline">
      <span>{t("ap.branch")}</span>
      <select value={value} onChange={(e) => onChange(e.target.value ? Number(e.target.value) : "")}>
        <option value="">{t("box.allBranches")}</option>
        {branches.map((b) => <option key={b.id} value={b.id}>{name(b)}</option>)}
      </select>
    </label>
  );
}

/* ------------------------------------------------------------------ today */

function Today({ version, onChanged }: { version: number; onChanged: () => void }) {
  const { t, lang } = useI18n();
  const { can } = useAuth();
  const hm = useHm();
  const [day, setDay] = useState(isoToday());
  const [branch, setBranch] = useState<number | "">("");
  const [board, setBoard] = useState<DayBoard | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<number | null>(null);
  const [other, setOther] = useState<number | "">("");
  const staffRows = useStaffRows();
  const load = useCallback(() => {
    get<DayBoard>(`/api/staff/attendance/day/?date=${day}${branch ? `&branch=${branch}` : ""}`).then(setBoard).catch((e) => setError(errorText(e)));
  }, [day, branch]);
  useEffect(load, [load, version]);
  useEffect(() => {
    if (day !== isoToday()) return;
    const timer = window.setInterval(load, 60_000);
    return () => window.clearInterval(timer);
  }, [day, load]);
  const isToday = day === isoToday();
  const clock = async (staff: number, action: "in" | "out") => {
    setBusy(staff);
    setError("");
    try {
      await post("/api/staff/attendance/clock/", { staff, action, branch: branch || undefined });
      load();
      onChanged();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  };
  const onBoard = new Set(board?.rows.map((r) => r.staff.id));
  const offBoard = (staffRows ?? []).filter((s) => !onBoard.has(s.id));
  return (
    <>
      <section className="card pad toolbar staff-bar">
        <button className="btn btn-icon" aria-label={t("pr.prevDay")} onClick={() => setDay(addDays(day, -1))}><Icon name="arrow" size={18} className="flip-ltr" /></button>
        <input type="date" value={day} onChange={(e) => setDay(e.target.value || isoToday())} aria-label={t("date")} />
        <button className="btn btn-icon" aria-label={t("pr.nextDay")} onClick={() => setDay(addDays(day, 1))}><Icon name="arrow" size={18} className="flip-rtl" /></button>
        {!isToday && <button className="btn btn-small" onClick={() => setDay(isoToday())}>{t("pr.today")}</button>}
        <BranchFilter value={branch} onChange={setBranch} />
        <span className="grow" />
        {board && <span className="muted small">{t("pr.graceNote", { n: board.grace })}</span>}
      </section>
      {error && <p className="form-error" role="alert">{error}</p>}
      {board === null ? (
        <p className="muted pad">{t("loading")}</p>
      ) : board.rows.length === 0 ? (
        <section className="card pad empty-state">
          <Icon name="calendar" size={28} />
          <p className="lead">{t("pr.today.empty")}</p>
          <p className="muted">{t("pr.today.emptyHint")}</p>
        </section>
      ) : (
        <div className="staff-board">
          {board.rows.map((r, i) => (
            <PersonCard key={r.staff.id} row={r} i={i} hm={hm} lang={lang} canClock={can("staff", "create") && isToday} busy={busy === r.staff.id} onClock={clock} />
          ))}
        </div>
      )}
      {can("staff", "create") && isToday && offBoard.length > 0 && (
        <section className="card pad toolbar staff-extra">
          <span className="muted small">{t("pr.today.notOnRoster")}</span>
          <StaffSelect value={other} onChange={setOther} rows={offBoard} />
          <button className="btn btn-small" disabled={!other || busy !== null} onClick={() => other && void clock(other, "in").then(() => setOther(""))}>{t("pr.clockIn")}</button>
        </section>
      )}
    </>
  );
}

function PersonCard({ row, i, hm, lang, canClock, busy, onClock }: { row: DayRow; i: number; hm: (m: number) => string; lang: string; canClock: boolean; busy: boolean; onClock: (staff: number, action: "in" | "out") => void }) {
  const { t } = useI18n();
  const first = row.records[0];
  const last = row.records[row.records.length - 1];
  return (
    <article className={`card staff-card st-${row.status}`} style={{ "--i": i } as CSSProperties}>
      <header className="staff-card-head">
        <Avatar staff={row.staff} />
        <div className="grow">
          <strong className="block">{personName(row.staff, lang)}</strong>
          <span className="small muted">{t(`staff.type.${row.staff.staff_type}` as TKey)}</span>
        </div>
        <span className={DAY_PILL[row.status]}>{t(`pr.st.${row.status}` as TKey)}</span>
      </header>
      <div className="staff-card-body">
        <p className="small">
          <Icon name="calendar" size={14} />{" "}
          {row.shifts.length ? row.shifts.map((s) => <span key={s.id} className="shift-time" dir="ltr">{shiftText(s)}</span>) : <span className="muted">{t("pr.noShift")}</span>}
        </p>
        {first && (
          <p className="small">
            <Icon name="clock" size={14} /> <span dir="ltr">{first.in}</span> → <span dir="ltr">{last.out ?? "…"}</span>
            <span className="muted"> · {hm(row.status === "in" ? row.worked_now : row.worked_minutes)}</span>
          </p>
        )}
        <div className="staff-badges">
          {row.late_minutes > 0 && <span className="late-badge">{row.status === "not_in" ? t("pr.lateNotIn", { m: hm(row.late_minutes) }) : t("pr.lateBy", { m: hm(row.late_minutes) })}</span>}
          {row.overtime_minutes > 0 && <span className="pill pill-mint tiny">{t("pr.otBy", { m: hm(row.overtime_minutes) })}</span>}
          {row.early_leave_minutes > 0 && <span className="pill pill-warn tiny">{t("pr.earlyBy", { m: hm(row.early_leave_minutes) })}</span>}
          {row.leave && <span className="pill pill-ready tiny">{t(`pr.leave.${row.leave.kind}` as TKey)}</span>}
        </div>
      </div>
      {canClock && row.status !== "leave" && (
        <footer className="staff-card-foot">
          {row.status === "in" ? (
            <button className="btn btn-small" disabled={busy} onClick={() => onClock(row.staff.id, "out")}>{t("pr.clockOut")}</button>
          ) : (
            <button className="btn btn-small btn-primary" disabled={busy} onClick={() => onClock(row.staff.id, "in")}>{t("pr.clockIn")}</button>
          )}
        </footer>
      )}
    </article>
  );
}

/* ----------------------------------------------------------------- roster */

function Roster() {
  const { t, lang, name } = useI18n();
  const { can } = useAuth();
  const letterhead = useLetterhead(lang);
  const hm = useHm();
  const [start, setStart] = useState(mondayOf(isoToday()));
  const [branch, setBranch] = useState<number | "">("");
  const [week, setWeek] = useState<RosterWeek | null>(null);
  const [cell, setCell] = useState<{ staff: StaffRef; day: string; shifts: ShiftOut[] } | null>(null);
  const [shifts, setShifts] = useState(false);
  const [message, setMessage] = useState("");
  const [version, setVersion] = useState(0);
  const load = useCallback(() => {
    get<RosterWeek>(`/api/staff/roster/week/?start=${start}${branch ? `&branch=${branch}` : ""}`).then(setWeek).catch(() => setWeek(null));
  }, [start, branch]);
  useEffect(load, [load, version]);
  const copy = async () => {
    setMessage("");
    try {
      const r = await post<{ created: number; skipped: number }>("/api/staff/roster/copy-week/", { start, branch: branch || undefined });
      setMessage(t("pr.roster.copied", { n: r.created, s: r.skipped }));
      load();
    } catch (err) {
      setMessage(errorText(err));
    }
  };
  const print = () => {
    if (!week) return;
    const head = week.days.map((d) => `<th>${escapeHtml(dayLabel(d, lang))}</th>`).join("");
    const rows = week.rows
      .map(
        (r) =>
          `<tr><td><strong>${escapeHtml(personName(r.staff, lang))}</strong><br><span style="font-size:11px;color:#5A6B7B">${escapeHtml(hm(r.minutes))}</span></td>${r.days
            .map((d) => `<td>${d.leave ? escapeHtml(t(`pr.leave.${d.leave}` as TKey)) : d.shifts.map((s) => `<div dir="ltr">${s.start}–${s.end}</div>`).join("") || "—"}</td>`)
            .join("")}</tr>`,
      )
      .join("");
    printDocument({
      title: t("pr.roster.printTitle"),
      lang,
      clinic: letterhead,
      patient: `${fmtDate(week.start, lang)} – ${fmtDate(week.end, lang)}`,
      body: `<table style="font-size:12px"><thead><tr><th></th>${head}</tr></thead><tbody>${rows}</tbody></table>`,
      footer: "",
    });
  };
  const today = isoToday();
  return (
    <>
      <section className="card pad toolbar staff-bar">
        <button className="btn btn-icon" aria-label={t("pr.prevWeek")} onClick={() => setStart(addDays(start, -7))}><Icon name="arrow" size={18} className="flip-ltr" /></button>
        <strong className="week-label">{week ? `${fmtDate(week.start, lang)} – ${fmtDate(week.end, lang)}` : "…"}</strong>
        <button className="btn btn-icon" aria-label={t("pr.nextWeek")} onClick={() => setStart(addDays(start, 7))}><Icon name="arrow" size={18} className="flip-rtl" /></button>
        <button className="btn btn-small" onClick={() => setStart(mondayOf(isoToday()))}>{t("pr.thisWeek")}</button>
        <BranchFilter value={branch} onChange={setBranch} />
        <span className="grow" />
        {can("staff", "create") && <button className="btn btn-small" onClick={() => void copy()}><Icon name="history" size={16} /> {t("pr.roster.copy")}</button>}
        {can("staff", "edit") && <button className="btn btn-small" onClick={() => setShifts(true)}>{t("pr.roster.shifts")}</button>}
        <button className="btn btn-small" onClick={print}><Icon name="file" size={16} /> {t("print")}</button>
      </section>
      {message && <p className="notice pad-sm" role="status">{message}</p>}
      <section className="card">
        {week === null ? (
          <p className="muted pad">{t("loading")}</p>
        ) : week.rows.length === 0 ? (
          <p className="muted pad">{t("pr.roster.noStaff")}</p>
        ) : (
          <div className="table-wrap roster-wrap">
            <table className="roster-grid">
              <thead>
                <tr>
                  <th className="roster-person">{t("pr.person")}</th>
                  {week.days.map((d) => (
                    <th key={d} className={d === today ? "is-today" : ""}>{dayLabel(d, lang)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {week.rows.map((r) => (
                  <tr key={r.staff.id}>
                    <th scope="row" className="roster-person">
                      <span className="roster-who">
                        <Avatar staff={r.staff} size={28} />
                        <span>
                          <span className="block">{personName(r.staff, lang)}</span>
                          <span className="small muted">{hm(r.minutes)}</span>
                        </span>
                      </span>
                    </th>
                    {r.days.map((d) => (
                      <td key={d.date} className={d.date === today ? "is-today" : ""}>
                        <button className="roster-cell" onClick={() => setCell({ staff: r.staff, day: d.date, shifts: d.shifts })} aria-label={`${personName(r.staff, lang)} ${dayLabel(d.date, lang)}`}>
                          {d.leave && <span className="shift-chip leave">{t(`pr.leave.${d.leave}` as TKey)}</span>}
                          {d.shifts.map((s) => (
                            <span key={s.id} className="shift-chip" style={s.color ? ({ "--chip-c": s.color } as CSSProperties) : undefined} title={s.name ? personName(s.name, lang) : ""}>
                              <span dir="ltr">{shiftText(s)}</span>
                            </span>
                          ))}
                          {!d.leave && !d.shifts.length && can("staff", "create") && <span className="roster-add" aria-hidden="true">+</span>}
                        </button>
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {cell && <RosterCellDialog {...cell} onClose={() => setCell(null)} onChanged={() => setVersion((v) => v + 1)} />}
      {shifts && (
        <Modal title={t("pr.roster.shifts")} onClose={() => { setShifts(false); setVersion((v) => v + 1); }}>
          <CrudSection<ShiftTemplate & { [k: string]: unknown }>
            title={t("pr.roster.shifts")}
            endpoint="/api/staff/shifts/"
            module="staff"
            defaults={{ start_time: "10:00", end_time: "18:00", break_minutes: 0, is_active: true, color: "#9fd3bf" }}
            columns={[
              { label: "pr.shiftName", render: (r) => <span className="shift-chip" style={r.color ? ({ "--chip-c": r.color } as CSSProperties) : undefined}>{name(r)}</span> },
              { label: "pr.hoursCol", render: (r) => <span dir="ltr">{r.start_time.slice(0, 5)}–{r.end_time.slice(0, 5)}</span> },
              { label: "pr.breakMin", render: (r) => r.break_minutes },
            ]}
            fields={[
              { name: "name_en", label: "nameEn", required: true, dir: "ltr" },
              { name: "name_ar", label: "nameAr", required: true, dir: "rtl" },
              { name: "start_time", label: "pr.starts", type: "time", required: true },
              { name: "end_time", label: "pr.ends", type: "time", required: true, hint: "pr.overnightHint" },
              { name: "break_minutes", label: "pr.breakMin", type: "number" },
              { name: "color", label: "staff.color", type: "color" },
              { name: "is_active", label: "active", type: "checkbox" },
            ]}
          />
        </Modal>
      )}
    </>
  );
}

/* ------------------------------------------------------------- attendance */

function Attendance() {
  const { t, lang } = useI18n();
  const { can } = useAuth();
  const hm = useHm();
  const staffRows = useStaffRows();
  const [from, setFrom] = useState(addDays(isoToday(), -6));
  const [to, setTo] = useState(isoToday());
  const [staff, setStaff] = useState<number | "">("");
  const [rows, setRows] = useState<DayRow[] | null>(null);
  const [editing, setEditing] = useState<{ record: AttendanceRecord | null; defaults?: { staff?: number; date?: string } } | null>(null);
  const [month, setMonth] = useState(thisMonth());
  const [summary, setSummary] = useState<{ staff: StaffRef } & MonthSummary extends infer X ? X[] | null : never>(null);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    setRows(null);
    get<{ rows: DayRow[] }>(`/api/staff/attendance/days/?from=${from}&to=${to}${staff ? `&staff=${staff}` : ""}`).then((d) => setRows(d.rows)).catch(() => setRows([]));
  }, [from, to, staff, version]);
  useEffect(() => {
    get<{ rows: ({ staff: StaffRef } & MonthSummary)[] }>(`/api/staff/attendance/summary/?month=${month}${staff ? `&staff=${staff}` : ""}`).then((d) => setSummary(d.rows)).catch(() => setSummary([]));
  }, [month, staff, version]);
  const openRecord = async (id: number) => {
    const record = await get<AttendanceRecord>(`/api/staff/attendance/${id}/`);
    setEditing({ record });
  };
  const editable = can("staff", "edit");
  return (
    <>
      <section className="card pad toolbar staff-bar">
        <label className="field inline"><span>{t("com.from")}</span><input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="field inline"><span>{t("com.to")}</span><input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} /></label>
        <label className="field inline"><span>{t("pr.person")}</span><StaffSelect value={staff} onChange={setStaff} rows={staffRows} allLabel={t("pr.everyone")} /></label>
        <span className="grow" />
        {can("staff", "create") && <button className="btn btn-primary" onClick={() => setEditing({ record: null, defaults: { staff: staff || undefined } })}><Icon name="plus" size={16} /> {t("pr.att.add")}</button>}
      </section>
      <section className="card">
        {rows === null ? (
          <p className="muted pad">{t("loading")}</p>
        ) : rows.length === 0 ? (
          <p className="muted pad">{t("noRecords")}</p>
        ) : (
          <div className="table-wrap">
            <table className="att-table">
              <thead>
                <tr>
                  <th>{t("date")}</th>
                  <th>{t("pr.person")}</th>
                  <th>{t("pr.shift")}</th>
                  <th>{t("pr.inOut")}</th>
                  <th className="num">{t("pr.worked")}</th>
                  <th className="num">{t("pr.late")}</th>
                  <th className="num">{t("pr.overtime")}</th>
                  <th>{t("plan.status")}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={`${r.staff.id}-${r.date}`}>
                    <td className="nowrap">{dayLabel(r.date, lang)}</td>
                    <td className="nowrap">{personName(r.staff, lang)}</td>
                    <td className="nowrap" dir="ltr">{r.shifts.map(shiftText).join(", ") || "—"}</td>
                    <td className="nowrap">
                      {r.records.length === 0 && editable && r.status === "absent" ? (
                        <button className="link-button" onClick={() => setEditing({ record: null, defaults: { staff: r.staff.id, date: r.date } })}>{t("pr.att.addMissing")}</button>
                      ) : (
                        r.records.map((rec) =>
                          editable ? (
                            <button key={rec.id} className="link-button rec-link" onClick={() => void openRecord(rec.id)}>
                              <span dir="ltr">{rec.in}–{rec.out ?? "…"}</span>
                              {rec.source === "manual" && <span className="pill pill-outline tiny">{t("pr.manualTag")}</span>}
                            </button>
                          ) : (
                            <span key={rec.id} dir="ltr" className="block">{rec.in}–{rec.out ?? "…"}</span>
                          ),
                        )
                      )}
                    </td>
                    <td className="num">{r.worked_minutes ? hm(r.worked_minutes) : "—"}</td>
                    <td className={`num ${r.late_minutes ? "owed" : ""}`}>{r.late_minutes ? hm(r.late_minutes) : "—"}</td>
                    <td className="num">{r.overtime_minutes ? hm(r.overtime_minutes) : "—"}</td>
                    <td><span className={DAY_PILL[r.status]}>{r.leave ? t(`pr.leave.${r.leave.kind}` as TKey) : t(`pr.st.${r.status}` as TKey)}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <section className="card">
        <header className="card-head">
          <h2>{t("pr.att.monthTitle")}</h2>
          <MonthPicker value={month} onChange={setMonth} />
        </header>
        {summary === null ? (
          <p className="muted pad">{t("loading")}</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{t("pr.person")}</th>
                  <th className="num">{t("pr.sum.rostered")}</th>
                  <th className="num">{t("pr.sum.present")}</th>
                  <th className="num">{t("pr.sum.absent")}</th>
                  <th className="num">{t("pr.late")}</th>
                  <th className="num">{t("pr.overtime")}</th>
                  <th className="num">{t("pr.worked")}</th>
                  <th className="num">{t("pr.sum.leave")}</th>
                </tr>
              </thead>
              <tbody>
                {summary.map((r) => {
                  const leave = Object.values(r.leave_days).reduce((a, b) => a + (b ?? 0), 0);
                  return (
                    <tr key={r.staff.id}>
                      <td className="nowrap">{personName(r.staff, lang)}</td>
                      <td className="num">{r.rostered_days}</td>
                      <td className="num">{r.present_days}</td>
                      <td className={`num ${r.absent_days ? "owed" : ""}`}>{r.absent_days}</td>
                      <td className={`num ${r.late_minutes ? "owed" : ""}`}>{r.late_minutes ? `${hm(r.late_minutes)} · ${t("pr.f.daysN", { n: r.late_days })}` : "—"}</td>
                      <td className="num">{r.overtime_minutes ? hm(r.overtime_minutes) : "—"}</td>
                      <td className="num">{hm(r.worked_minutes)}</td>
                      <td className="num">{leave || "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {editing && (
        <RecordDialog
          record={editing.record}
          defaults={editing.defaults}
          staffRows={staffRows}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); setVersion((v) => v + 1); }}
        />
      )}
    </>
  );
}

function MonthPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { t, lang } = useI18n();
  return (
    <div className="month-picker">
      <button className="btn btn-icon btn-small" aria-label={t("pr.prevMonth")} onClick={() => onChange(shiftMonth(value, -1))}><Icon name="arrow" size={16} className="flip-ltr" /></button>
      <strong>{monthLabel(`${value}-01`, lang)}</strong>
      <button className="btn btn-icon btn-small" aria-label={t("pr.nextMonth")} onClick={() => onChange(shiftMonth(value, 1))}><Icon name="arrow" size={16} className="flip-rtl" /></button>
    </div>
  );
}

/* ------------------------------------------------------------------ leave */

function Leave({ initialStatus, onChanged }: { initialStatus: string; onChanged: () => void }) {
  const { t, lang } = useI18n();
  const { can } = useAuth();
  const staffRows = useStaffRows();
  const [status, setStatus] = useState(initialStatus);
  const [rows, setRows] = useState<LeaveRequest[] | null>(null);
  const [balances, setBalances] = useState<LeaveBalanceRow[] | null>(null);
  const [year, setYear] = useState(new Date().getFullYear());
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState("");
  const [version, setVersion] = useState(0);
  useEffect(() => {
    get<Page<LeaveRequest>>(`/api/staff/leave/${status === "all" ? "" : `?status=${status}`}`).then((p) => setRows(p.results)).catch(() => setRows([]));
  }, [status, version]);
  useEffect(() => {
    get<{ rows: LeaveBalanceRow[] }>(`/api/staff/leave/balances/?year=${year}`).then((d) => setBalances(d.rows)).catch(() => setBalances([]));
  }, [year, version]);
  const act = async (l: LeaveRequest, action: "approve" | "reject" | "cancel") => {
    setError("");
    const note = action === "approve" ? "" : window.prompt(t("pr.leave.noteAsk")) ?? null;
    if (note === null) return;
    try {
      await post(`/api/staff/leave/${l.id}/${action}/`, { note });
      setVersion((v) => v + 1);
      onChanged();
    } catch (err) {
      setError(errorText(err));
    }
  };
  const filters = ["pending", "approved", "all"];
  return (
    <>
      <section className="card pad toolbar staff-bar">
        <div className="chip-row">
          {filters.map((f) => (
            <button key={f} className={`chip ${status === f ? "active" : ""}`} aria-pressed={status === f} onClick={() => setStatus(f)}>{t(`pr.leave.f.${f}` as TKey)}</button>
          ))}
        </div>
        <span className="grow" />
        {can("staff", "create") && <button className="btn btn-primary" onClick={() => setAdding(true)}><Icon name="plus" size={16} /> {t("pr.leave.new")}</button>}
      </section>
      {error && <p className="form-error" role="alert">{error}</p>}
      <section className="card">
        {rows === null ? (
          <p className="muted pad">{t("loading")}</p>
        ) : rows.length === 0 ? (
          <p className="muted pad">{status === "pending" ? t("pr.leave.nonePending") : t("noRecords")}</p>
        ) : (
          <ul className="plain-list leave-list">
            {rows.map((l, i) => (
              <li key={l.id} className="leave-row" style={{ "--i": i } as CSSProperties}>
                <Avatar staff={l.staff_info} size={34} />
                <div className="grow">
                  <strong className="block">{personName(l.staff_info, lang)}</strong>
                  <span className="small">
                    {t(`pr.leave.${l.kind}` as TKey)} · {fmtDate(l.start_date, lang)}
                    {l.end_date !== l.start_date && ` – ${fmtDate(l.end_date, lang)}`} · {t("pr.f.daysN", { n: l.days })}
                  </span>
                  {l.reason && <span className="small muted block">{l.reason}</span>}
                  {l.decided_by_name && <span className="small muted block">{t("pr.leave.decidedBy", { name: l.decided_by_name })}{l.decision_note ? ` · ${l.decision_note}` : ""}</span>}
                </div>
                <span className={LEAVE_PILL[l.status]}>{t(`pr.leave.s.${l.status}` as TKey)}</span>
                <div className="leave-actions">
                  {l.status === "pending" && can("staff", "approve") && (
                    <>
                      <button className="btn btn-small btn-primary" onClick={() => void act(l, "approve")}>{t("pr.leave.approve")}</button>
                      <button className="btn btn-small" onClick={() => void act(l, "reject")}>{t("pr.leave.reject")}</button>
                    </>
                  )}
                  {l.status === "approved" && can("staff", "approve") && <button className="btn btn-small" onClick={() => void act(l, "cancel")}>{t("pr.leave.cancel")}</button>}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="card">
        <header className="card-head">
          <h2>{t("pr.leave.balances")}</h2>
          <div className="month-picker">
            <button className="btn btn-icon btn-small" aria-label={t("pr.prevYear")} onClick={() => setYear(year - 1)}><Icon name="arrow" size={16} className="flip-ltr" /></button>
            <strong>{year.toLocaleString(locale(lang), { useGrouping: false })}</strong>
            <button className="btn btn-icon btn-small" aria-label={t("pr.nextYear")} onClick={() => setYear(year + 1)}><Icon name="arrow" size={16} className="flip-rtl" /></button>
          </div>
        </header>
        {balances && (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{t("pr.person")}</th>
                  <th className="num">{t("pr.leave.entitled")}</th>
                  <th className="num">{t("pr.leave.used")}</th>
                  <th className="num">{t("pr.leave.pendingCol")}</th>
                  <th className="num">{t("pr.leave.remaining")}</th>
                  <th className="num">{t("pr.leave.sick")}</th>
                  <th className="num">{t("pr.leave.casual")}</th>
                  <th className="num">{t("pr.leave.unpaid")}</th>
                </tr>
              </thead>
              <tbody>
                {balances.map((b) => (
                  <tr key={b.staff.id}>
                    <td className="nowrap">{personName(b.staff, lang)}</td>
                    <td className="num">{b.entitlement}</td>
                    <td className="num">{b.used}</td>
                    <td className="num">{b.pending || "—"}</td>
                    <td className="num">
                      <span className="leave-meter" style={{ "--p": `${Math.max(0, Math.min(100, (b.remaining / Math.max(b.entitlement, 1)) * 100))}%` } as CSSProperties}>
                        <strong className={b.remaining < 0 ? "owed" : ""}>{b.remaining}</strong>
                      </span>
                    </td>
                    <td className="num">{b.by_kind.sick || "—"}</td>
                    <td className="num">{b.by_kind.casual || "—"}</td>
                    <td className="num">{b.by_kind.unpaid || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="muted small pad">{t("pr.leave.daysHint")}</p>
      </section>
      {adding && <LeaveDialog staffRows={staffRows} onClose={() => setAdding(false)} onSaved={() => { setAdding(false); setVersion((v) => v + 1); onChanged(); }} />}
    </>
  );
}

/* ---------------------------------------------------------------- payroll */

function PayrollTab({ creating, setCreating, onChanged }: { creating: boolean; setCreating: (v: boolean) => void; onChanged: () => void }) {
  const { t, lang } = useI18n();
  const currency = useCurrency();
  const [params, setParams] = useSearchParams();
  const open = Number(params.get("run")) || null;
  const [runs, setRuns] = useState<PayrollRun[] | null>(null);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    get<Page<PayrollRun>>("/api/staff/payroll/runs/").then((p) => setRuns(p.results)).catch(() => setRuns([]));
  }, [version]);
  const show = (id: number | null) => setParams(id ? { tab: "payroll", run: String(id) } : { tab: "payroll" }, { replace: true });
  if (open) return <RunView id={open} onBack={() => { show(null); setVersion((v) => v + 1); }} onChanged={onChanged} />;
  return (
    <>
      <section className="card">
        <header className="card-head">
          <h2>{t("pr.runs")}</h2>
        </header>
        {runs === null ? (
          <p className="muted pad">{t("loading")}</p>
        ) : runs.length === 0 ? (
          <div className="pad empty-state">
            <Icon name="wallet" size={28} />
            <p className="lead">{t("pr.noRuns")}</p>
            <p className="muted">{t("pr.noRunsHint")}</p>
          </div>
        ) : (
          <div className="run-list">
            {runs.map((r, i) => (
              <button key={r.id} className="run-card" style={{ "--i": i } as CSSProperties} onClick={() => show(r.id)}>
                <span className="run-month">
                  <strong>{monthLabel(r.period, lang)}</strong>
                  <span className="small muted">{r.branch_info ? personName(r.branch_info, lang) : t("box.allBranches")} · {t("pr.peopleN", { n: r.totals.people })}</span>
                </span>
                <span className="run-figure">
                  <span className="small muted">{t("pr.net")}</span>
                  <strong>{money(r.totals.net, lang)} <small>{currency}</small></strong>
                </span>
                <span className="run-figure hide-phone">
                  <span className="small muted">{t("pr.cost")}</span>
                  <strong>{money(r.totals.cost, lang)}</strong>
                </span>
                <span className={RUN_PILL[r.status]}>{t(`pr.run.${r.status}` as TKey)}</span>
              </button>
            ))}
          </div>
        )}
      </section>
      {creating && <NewRunDialog onClose={() => setCreating(false)} onSaved={(r) => { setCreating(false); onChanged(); show(r.id); }} />}
    </>
  );
}

function NewRunDialog({ onClose, onSaved }: { onClose: () => void; onSaved: (r: PayrollRun) => void }) {
  const { t, lang, name } = useI18n();
  const branches = useBranches();
  const [month, setMonth] = useState(thisMonth());
  const [commission, setCommission] = useState(thisMonth());
  const [branch, setBranch] = useState<number | "">("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      onSaved(await post<PayrollRun>("/api/staff/payroll/runs/", { month, commission_month: commission, branch: branch || null }));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={t("pr.runPayroll")} onClose={onClose}>
      <form className="form-grid" onSubmit={save}>
        <div className="form-grid form-grid-2">
          <label className="field">
            <span className="field-label">{t("pr.month")}</span>
            <input type="month" value={month} onChange={(e) => { const prev = month; setMonth(e.target.value); if (commission === prev) setCommission(e.target.value); }} required />
          </label>
          <label className="field">
            <span className="field-label">{t("pr.commissionMonth")}</span>
            <input type="month" value={commission} onChange={(e) => setCommission(e.target.value)} required />
          </label>
        </div>
        <div className="chip-row">
          <button type="button" className={`chip ${commission === month ? "active" : ""}`} onClick={() => setCommission(month)}>{t("pr.commSame")}</button>
          <button type="button" className={`chip ${commission === shiftMonth(month, -1) ? "active" : ""}`} onClick={() => setCommission(shiftMonth(month, -1))}>{t("pr.commPrev", { month: monthLabel(`${shiftMonth(month, -1)}-01`, lang) })}</button>
        </div>
        <p className="field-hint">{t("pr.commHint")}</p>
        {branches.length > 1 && (
          <label className="field">
            <span className="field-label">{t("ap.branch")}</span>
            <select value={branch} onChange={(e) => setBranch(e.target.value ? Number(e.target.value) : "")}>
              <option value="">{t("box.allBranches")}</option>
              {branches.map((b) => <option key={b.id} value={b.id}>{name(b)}</option>)}
            </select>
          </label>
        )}
        <p className="notice pad-sm small">{t("pr.newRunHint")}</p>
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="form-actions">
          <button type="button" className="btn" onClick={onClose}>{t("cancel")}</button>
          <button className="btn btn-primary" disabled={busy}>{busy ? t("pr.calculating") : t("pr.calculate")}</button>
        </div>
      </form>
    </Modal>
  );
}

function RunView({ id, onBack, onChanged }: { id: number; onBack: () => void; onChanged: () => void }) {
  const { t, lang } = useI18n();
  const { can } = useAuth();
  const currency = useCurrency();
  const letterhead = useLetterhead(lang);
  const slips = usePayslipPrint();
  const ref = useRef<HTMLDivElement>(null);
  const [run, setRun] = useState<PayrollRun | null>(null);
  const [editing, setEditing] = useState<PayrollLine | null>(null);
  const [paying, setPaying] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    get<PayrollRun>(`/api/staff/payroll/runs/${id}/`).then(setRun).catch((e) => setError(errorText(e)));
  }, [id]);
  useEffect(load, [load]);
  const m = (v: string) => money(v, lang);
  const act = async (action: "recalculate" | "approve" | "reopen", confirmKey?: TKey) => {
    if (confirmKey && !window.confirm(t(confirmKey))) return;
    setBusy(true);
    setError("");
    try {
      setRun(await post<PayrollRun>(`/api/staff/payroll/runs/${id}/${action}/`, {}));
      onChanged();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!window.confirm(t("pr.confirmDelete"))) return;
    try {
      await del(`/api/staff/payroll/runs/${id}/`);
      onChanged();
      onBack();
    } catch (err) {
      setError(errorText(err));
    }
  };
  const slipFor = (line: PayrollLine) => get<Payslip>(`/api/staff/payroll/lines/${line.id}/payslip/`);
  const printOne = async (line: PayrollLine) => {
    try {
      slips.one(await slipFor(line));
    } catch (err) {
      setError(errorText(err));
    }
  };
  const printAll = async () => {
    if (!run?.lines) return;
    try {
      slips.many(await Promise.all(run.lines.map(slipFor)), run.period);
    } catch (err) {
      setError(errorText(err));
    }
  };
  const exportRun = async () => {
    if (!ref.current || !run) return;
    setBusy(true);
    try {
      await exportPdf(ref.current, `payroll-${run.period.slice(0, 7)}`, { landscape: true });
    } finally {
      setBusy(false);
    }
  };
  if (!run) return <p className="muted pad">{error || t("loading")}</p>;
  const lines = run.lines ?? [];
  const draft = run.status === "draft";
  const tt = run.totals;
  return (
    <>
      <section className="card pad run-head">
        <button className="btn btn-small" onClick={onBack}><Icon name="arrow" size={16} className="flip-ltr" /> {t("pr.allRuns")}</button>
        <div className="grow run-title">
          <h2>{t("pr.runTitle", { month: monthLabel(run.period, lang) })}</h2>
          <p className="small muted">
            {run.branch_info ? personName(run.branch_info, lang) : t("box.allBranches")}
            {run.commission_period.slice(0, 7) !== run.period.slice(0, 7) && ` · ${t("pr.commissionFor", { month: monthLabel(run.commission_period, lang) })}`}
            {run.approved_by_name && ` · ${t("pr.approvedBy", { name: run.approved_by_name })}`}
            {run.paid_on && ` · ${t("pr.paidOn", { date: fmtDate(run.paid_on, lang) })}`}
          </p>
        </div>
        <span className={RUN_PILL[run.status]}>{t(`pr.run.${run.status}` as TKey)}</span>
      </section>
      <section className="card pad toolbar run-actions">
        {draft && can("staff", "edit") && <button className="btn" disabled={busy} onClick={() => void act("recalculate")}><Icon name="history" size={16} /> {t("pr.recalculate")}</button>}
        {draft && can("staff", "approve") && <button className="btn btn-primary" disabled={busy || !lines.length} onClick={() => void act("approve", "pr.confirmApprove")}><Icon name="check" size={16} /> {t("pr.approve")}</button>}
        {run.status === "approved" && can("staff", "approve") && (
          <>
            <button className="btn btn-accent" disabled={busy} onClick={() => setPaying(true)}><Icon name="cash" size={16} /> {t("pr.markPaid")}</button>
            <button className="btn" disabled={busy} onClick={() => void act("reopen")}>{t("pr.reopen")}</button>
          </>
        )}
        <span className="grow" />
        <button className="btn" onClick={() => void printAll()} disabled={!lines.length}><Icon name="file" size={16} /> {t("pr.printAll")}</button>
        <button className="btn export-btn" disabled={busy || !lines.length} onClick={() => void exportRun()}><Icon name="download" size={16} /> {t("rep.exportPdf")}</button>
        {draft && can("staff", "delete") && <button className="btn btn-danger" onClick={() => void remove()}>{t("delete")}</button>}
      </section>
      {error && <p className="form-error" role="alert">{error}</p>}
      {draft && <p className="notice pad-sm small">{t("pr.draftHint")}</p>}
      <div ref={ref} className="page report-body">
        <header className="report-head pdf-only">
          <div>
            <h1>{t("pr.runTitle", { month: monthLabel(run.period, lang) })}</h1>
            <p>{letterhead.name} · {t(`pr.run.${run.status}` as TKey)}</p>
          </div>
          <img src="/brand/logo.svg" alt="" />
        </header>
        <div className="method-cards">
          <div className="card method-card total">
            <p className="overline">{t("pr.net")}</p>
            <p className="bill-figure">{m(tt.net)} <span>{currency}</span></p>
            <p className="small muted">{t("pr.peopleN", { n: tt.people })}</p>
          </div>
          <div className="card method-card"><p className="overline">{t("pr.gross")}</p><p className="bill-figure">{m(tt.gross)}</p></div>
          <div className="card method-card"><p className="overline">{t("pr.deductions")}</p><p className="bill-figure owed">{m(tt.total_deductions)}</p></div>
          <div className="card method-card"><p className="overline">{t("pr.employerIns")}</p><p className="bill-figure">{m(tt.employer_insurance)}</p></div>
          <div className="card method-card"><p className="overline">{t("pr.cost")}</p><p className="bill-figure">{m(tt.cost)}</p><p className="small muted">{t("pr.costHint")}</p></div>
        </div>
        <section className="card">
          <div className="table-wrap">
            <table className="pay-table">
              <thead>
                <tr>
                  <th>{t("pr.person")}</th>
                  <th className="num">{t("pr.base")}</th>
                  <th className="num">{t("pr.overtime")}</th>
                  <th className="num">{t("pr.commission")}</th>
                  <th className="num">{t("pr.additions")}</th>
                  <th className="num">{t("pr.deductions")}</th>
                  <th className="num">{t("pr.net")}</th>
                  <th>{t("pr.payout")}</th>
                  <th className="no-pdf" />
                </tr>
              </thead>
              <tbody>
                {lines.map((l) => (
                  <tr key={l.id} className="row-link" onClick={() => setEditing(l)}>
                    <td>
                      <span className="roster-who">
                        <Avatar staff={l.staff_info} size={28} />
                        <span>
                          <span className="block nowrap">{personName(l.staff_info, lang)}</span>
                          <span className="small muted nowrap">{t(`pr.pay.${l.pay_type}` as TKey)}</span>
                        </span>
                      </span>
                    </td>
                    <td className="num">{m(l.base_pay)}</td>
                    <td className="num">{Number(l.overtime_pay) ? m(l.overtime_pay) : "—"}</td>
                    <td className="num">{Number(l.commission) ? m(l.commission) : l.commission_note ? <span className="small owed">{t("pr.paidAlready")}</span> : "—"}</td>
                    <td className="num">{Number(l.additions) ? m(l.additions) : "—"}</td>
                    <td className="num owed">{Number(l.total_deductions) ? `−${m(l.total_deductions)}` : "—"}</td>
                    <td className="num strong">{m(l.net)}</td>
                    <td className="nowrap small">{t(`pr.payout.${l.payout_method}` as TKey)}</td>
                    <td className="cell-actions no-pdf">
                      <button className="btn btn-small" onClick={(e) => { e.stopPropagation(); void printOne(l); }} aria-label={t("pr.payslip")} title={t("pr.payslip")}>
                        <Icon name="file" size={16} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td className="strong">{t("pr.total")}</td>
                  <td className="num">{m(tt.base_pay)}</td>
                  <td className="num">{m(tt.overtime_pay)}</td>
                  <td className="num">{m(tt.commission)}</td>
                  <td className="num">{m(tt.additions)}</td>
                  <td className="num">−{m(tt.total_deductions)}</td>
                  <td className="num strong">{m(tt.net)}</td>
                  <td colSpan={2} />
                </tr>
              </tfoot>
            </table>
          </div>
        </section>
        {tt.by_method.length > 0 && (
          <section className="card pad">
            <h3 className="sub-head">{t("pr.byMethod")}</h3>
            <ul className="mini-list">
              {tt.by_method.map((b) => (
                <li key={b.method}><span>{t(`pr.payout.${b.method}` as TKey)}</span><span className="muted small">{t("pr.peopleN", { n: b.count })}</span><span className="num strong">{m(b.net)}</span></li>
              ))}
            </ul>
          </section>
        )}
      </div>
      {editing && (
        <LineEditor
          line={editing}
          editable={draft && can("staff", "edit")}
          onClose={() => setEditing(null)}
          onPrint={() => void printOne(editing)}
          onSaved={() => { setEditing(null); load(); }}
        />
      )}
      {paying && <PayDialog run={run} onClose={() => setPaying(false)} onPaid={(r) => { setPaying(false); setRun(r); onChanged(); }} />}
    </>
  );
}

function PayDialog({ run, onClose, onPaid }: { run: PayrollRun; onClose: () => void; onPaid: (r: PayrollRun) => void }) {
  const { t, lang } = useI18n();
  const currency = useCurrency();
  const [day, setDay] = useState(isoToday());
  const [methods, setMethods] = useState<Record<number, PayoutMethod>>(() => Object.fromEntries((run.lines ?? []).map((l) => [l.id, l.payout_method])));
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      onPaid(await post<PayrollRun>(`/api/staff/payroll/runs/${run.id}/pay/`, { paid_on: day, methods }));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={t("pr.markPaid")} onClose={onClose}>
      <form className="form-grid" onSubmit={save}>
        <label className="field"><span className="field-label">{t("pr.paidDate")}</span><input type="date" value={day} onChange={(e) => setDay(e.target.value)} required /></label>
        <ul className="plain-list pay-methods">
          {(run.lines ?? []).map((l) => (
            <li key={l.id}>
              <span className="grow">{personName(l.staff_info, lang)}</span>
              <span className="num strong">{money(l.net, lang)} {currency}</span>
              <select value={methods[l.id]} onChange={(e) => setMethods((s) => ({ ...s, [l.id]: e.target.value as PayoutMethod }))} aria-label={t("pr.payout")}>
                {PAYOUTS.map((p) => <option key={p} value={p}>{t(`pr.payout.${p}` as TKey)}</option>)}
              </select>
            </li>
          ))}
        </ul>
        <p className="muted small">{t("pr.payHint")}</p>
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="form-actions">
          <button type="button" className="btn" onClick={onClose}>{t("cancel")}</button>
          <button className="btn btn-primary" disabled={busy}>{t("pr.markPaid")}</button>
        </div>
      </form>
    </Modal>
  );
}

/* --------------------------------------------------------------- advances */

function Advances() {
  const { t, lang } = useI18n();
  const { can } = useAuth();
  const currency = useCurrency();
  const staffRows = useStaffRows();
  const [status, setStatus] = useState("active");
  const [rows, setRows] = useState<SalaryAdvance[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState("");
  const [version, setVersion] = useState(0);
  useEffect(() => {
    getAll<SalaryAdvance>(`/api/staff/advances/${status === "all" ? "" : `?status=${status}`}`).then(setRows).catch(() => setRows([]));
  }, [status, version]);
  const outstanding = (rows ?? []).filter((a) => a.status === "active").reduce((s, a) => s + Number(a.remaining), 0);
  const cancel = async (a: SalaryAdvance) => {
    if (!window.confirm(t("pr.adv.confirmCancel"))) return;
    try {
      await post(`/api/staff/advances/${a.id}/cancel/`, {});
      setVersion((v) => v + 1);
    } catch (err) {
      setError(errorText(err));
    }
  };
  return (
    <>
      <section className="card pad toolbar staff-bar">
        <div className="chip-row">
          {["active", "repaid", "all"].map((f) => (
            <button key={f} className={`chip ${status === f ? "active" : ""}`} aria-pressed={status === f} onClick={() => setStatus(f)}>{t(`pr.adv.f.${f}` as TKey)}</button>
          ))}
        </div>
        <span className="grow" />
        {status === "active" && rows && <span className="adv-total">{t("pr.adv.outstanding")}: <strong>{money(outstanding, lang)} {currency}</strong></span>}
        {can("staff", "create") && <button className="btn btn-primary" onClick={() => setAdding(true)}><Icon name="plus" size={16} /> {t("pr.adv.new")}</button>}
      </section>
      {error && <p className="form-error" role="alert">{error}</p>}
      <section className="card">
        {rows === null ? (
          <p className="muted pad">{t("loading")}</p>
        ) : rows.length === 0 ? (
          <p className="muted pad">{t("pr.adv.none")}</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{t("pr.person")}</th>
                  <th>{t("date")}</th>
                  <th className="num">{t("pr.adv.amountCol")}</th>
                  <th className="num">{t("pr.adv.perMonth")}</th>
                  <th>{t("pr.adv.progress")}</th>
                  <th className="num">{t("pr.adv.remaining")}</th>
                  <th>{t("plan.status")}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((a) => {
                  const pct = Number(a.amount) ? (Number(a.repaid) / Number(a.amount)) * 100 : 0;
                  return (
                    <tr key={a.id}>
                      <td className="nowrap">{personName(a.staff_info, lang)}{a.reason && <span className="small muted block">{a.reason}</span>}</td>
                      <td className="nowrap">{fmtDate(a.date, lang)}</td>
                      <td className="num">{money(a.amount, lang)}</td>
                      <td className="num">{money(a.monthly_installment, lang)}</td>
                      <td><span className="paid-bar adv-bar"><span style={{ width: `${pct}%` }} /></span><span className="small muted">{t("pr.adv.repaidN", { n: money(a.repaid, lang) })}</span></td>
                      <td className="num strong">{money(a.remaining, lang)}</td>
                      <td><span className={a.status === "active" ? "pill pill-ready" : a.status === "repaid" ? "pill pill-mint" : "pill pill-muted"}>{t(`pr.adv.s.${a.status}` as TKey)}</span></td>
                      <td className="cell-actions">{a.status === "active" && can("staff", "approve") && <button className="btn btn-small" onClick={() => void cancel(a)}>{t("pr.adv.cancel")}</button>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="muted small pad">{t("pr.adv.hint")}</p>
      </section>
      {adding && <AdvanceDialog staffRows={staffRows} onClose={() => setAdding(false)} onSaved={() => { setAdding(false); setVersion((v) => v + 1); }} />}
    </>
  );
}

/* --------------------------------------------------------------- profiles */

function Profiles() {
  const { t, lang } = useI18n();
  const { can } = useAuth();
  const currency = useCurrency();
  const [version, setVersion] = useState(0);
  const rows = useStaffRows(version);
  const [editing, setEditing] = useState<StaffProfileRow | null>(null);
  const rate = (r: StaffProfileRow) => {
    const p = r.profile;
    if (!p) return <span className="muted">{t("pr.prof.notSet")}</span>;
    const v = p.pay_type === "monthly" ? p.base_salary : p.pay_type === "daily" ? p.daily_rate : p.pay_type === "hourly" ? p.hourly_rate : null;
    return v === null ? "—" : <>{money(v, lang)} <span className="muted small">{currency}{p.pay_type === "daily" ? t("pr.perDay") : p.pay_type === "hourly" ? t("pr.perHour") : t("pr.perMonth")}</span></>;
  };
  return (
    <>
      <section className="card">
        <header className="card-head">
          <h2>{t("pr.prof.list")}</h2>
          <p className="muted small">{t("pr.prof.hint")}</p>
        </header>
        {rows === null ? (
          <p className="muted pad">{t("loading")}</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{t("pr.person")}</th>
                  <th>{t("pr.payType")}</th>
                  <th className="num">{t("pr.prof.rate")}</th>
                  <th>{t("staff.commission")}</th>
                  <th>{t("pr.prof.insuredCol")}</th>
                  <th>{t("pr.payout")}</th>
                  <th className="num">{t("pr.prof.leaveCol")}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <span className="roster-who">
                        <Avatar staff={r} size={28} />
                        <span>
                          <span className="block nowrap">{personName(r, lang)}</span>
                          <span className="small muted">{t(`staff.type.${r.staff_type}` as TKey)}</span>
                        </span>
                      </span>
                    </td>
                    <td>{r.profile ? t(`pr.pay.${r.profile.pay_type}` as TKey) : "—"}</td>
                    <td className="num nowrap">{rate(r)}</td>
                    <td className="small">{r.commission_type === "none" ? "—" : `${t(`staff.commission.${r.commission_type}` as TKey)} · ${Number(r.commission_value)}${r.commission_type.startsWith("percent") ? "%" : ""}`}</td>
                    <td>{r.profile?.insured ? <span className="pill pill-ok">{t("yes")}</span> : <span className="pill pill-muted">{t("no")}</span>}</td>
                    <td className="small">{r.profile ? t(`pr.payout.${r.profile.payout_method}` as TKey) : "—"}</td>
                    <td className="num">{r.leave.remaining}/{r.leave.entitlement}</td>
                    <td className="cell-actions">{can("staff", "edit") && <button className="btn btn-small" onClick={() => setEditing(r)}>{r.profile ? t("edit") : t("pr.prof.setUp")}</button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <SettingsCard />
      {editing && <ProfileDialog row={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); setVersion((v) => v + 1); }} />}
    </>
  );
}

function SettingsCard() {
  const { t } = useI18n();
  const { can } = useAuth();
  const [v, setV] = useState<PayrollSettings | null>(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    get<PayrollSettings>("/api/staff/settings/").then(setV).catch(() => undefined);
  }, []);
  if (!v) return null;
  const editable = can("staff", "edit");
  const set = <K extends keyof PayrollSettings>(k: K, value: PayrollSettings[K]) => { setSaved(false); setV({ ...v, [k]: value }); };
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    try {
      setV(await patch<PayrollSettings>("/api/staff/settings/", v));
      setSaved(true);
    } catch (err) {
      setError(errorText(err));
    }
  };
  const num = (k: "employee_insurance_rate" | "employer_insurance_rate" | "late_grace_minutes" | "work_days_per_month" | "hours_per_day", label: TKey, step = "1") => (
    <label className="field">
      <span className="field-label">{t(label)}</span>
      <input type="number" min="0" step={step} dir="ltr" disabled={!editable} value={v[k]} onChange={(e) => set(k, (k === "late_grace_minutes" || k === "work_days_per_month" ? Number(e.target.value) : e.target.value) as never)} />
    </label>
  );
  return (
    <section className="card pad settings-card">
      <h2>{t("pr.set.title")}</h2>
      <form className="form-grid" onSubmit={save}>
        <div className="form-grid form-grid-3">
          {num("employee_insurance_rate", "pr.set.empIns", "0.01")}
          {num("employer_insurance_rate", "pr.set.erIns", "0.01")}
          {num("late_grace_minutes", "pr.set.grace")}
          {num("work_days_per_month", "pr.set.days")}
          {num("hours_per_day", "pr.set.hours", "0.5")}
        </div>
        <div className="field field-check">
          <input id="pr-dl" type="checkbox" disabled={!editable} checked={v.deduct_lateness} onChange={(e) => set("deduct_lateness", e.target.checked)} />
          <label htmlFor="pr-dl">{t("pr.set.deductLate")}</label>
        </div>
        <div className="field field-check">
          <input id="pr-da" type="checkbox" disabled={!editable} checked={v.deduct_absence} onChange={(e) => set("deduct_absence", e.target.checked)} />
          <label htmlFor="pr-da">{t("pr.set.deductAbsence")}</label>
        </div>
        <p className="field-hint">{t("pr.set.hint")}</p>
        {error && <p className="form-error" role="alert">{error}</p>}
        {editable && (
          <div className="form-actions">
            {saved && <span className="muted small">{t("saved")}</span>}
            <button className="btn btn-primary">{t("save")}</button>
          </div>
        )}
      </form>
    </section>
  );
}

/* -------------------------------------------------------------- dashboard */

function Dashboard() {
  const { t, lang } = useI18n();
  const currency = useCurrency();
  const letterhead = useLetterhead(lang);
  const hm = useHm();
  const ref = useRef<HTMLDivElement>(null);
  const [month, setMonth] = useState(thisMonth());
  const [data, setData] = useState<StaffDashboard | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    get<StaffDashboard>(`/api/staff/dashboard/?month=${month}`).then(setData).catch(() => setData(null));
  }, [month]);
  const download = async () => {
    if (!ref.current) return;
    setBusy(true);
    try {
      await exportPdf(ref.current, `staff-report-${month}`);
    } finally {
      setBusy(false);
    }
  };
  const compact = useMemo(() => new Intl.NumberFormat(locale(lang), { notation: "compact", maximumFractionDigits: 1 }), [lang]);
  return (
    <>
      <section className="card pad dash-bar">
        <MonthPicker value={month} onChange={setMonth} />
        <button className="btn export-btn" disabled={busy || !data} onClick={() => void download()}>
          <Icon name="download" size={18} /> {busy ? t("rep.exporting") : t("rep.exportPdf")}
        </button>
      </section>
      {data && (
        <div ref={ref} className="page report-body">
          <header className="report-head pdf-only">
            <div>
              <h1>{t("pr.dash.reportTitle")}</h1>
              <p>{letterhead.name} · {monthLabel(data.month, lang)}</p>
            </div>
            <img src="/brand/logo.svg" alt="" />
          </header>
          <div className="kpi-grid">
            <KpiTile i={0} label={t("pr.dash.headcount")} value={String(data.headcount)} sub={t("pr.dash.onPayroll", { n: data.on_payroll })} />
            <KpiTile i={1} label={t("pr.dash.cost")} value={`${money(data.payroll_cost, lang)} ${currency}`} sub={data.payroll_status ? t(`pr.run.${data.payroll_status}` as TKey) : t("pr.dash.noRun")} tone="accent" />
            <KpiTile i={2} label={t("pr.dash.attendance")} value={data.attendance_rate === null ? "—" : `${data.attendance_rate.toLocaleString(locale(lang))}%`} sub={t("pr.dash.absentDays", { n: data.absent_days })} tone={data.attendance_rate !== null && data.attendance_rate < 90 ? "warn" : "good"} />
            <KpiTile i={3} label={t("pr.dash.late")} value={hm(data.late_minutes)} sub={t("pr.dash.lateDays", { n: data.late_days })} tone={data.late_minutes ? "warn" : undefined} />
            <KpiTile i={4} label={t("pr.dash.overtime")} value={hm(data.overtime_minutes)} />
            <KpiTile i={5} label={t("pr.dash.advances")} value={`${money(data.advances_outstanding, lang)} ${currency}`} sub={t("pr.dash.advancesN", { n: data.advances.length })} />
          </div>
          <div className="dash-grid">
            <section className="card dash-card wide">
              <h2>{t("pr.dash.trend")}</h2>
              <ColumnChart
                points={data.trend.map((p) => ({ label: monthLabel(p.month, lang, true), values: [Number(p.net), Number(p.cost)] }))}
                series={[t("pr.net"), t("pr.cost")]}
                format={(n) => compact.format(n)}
              />
            </section>
            <section className="card dash-card">
              <h2>{t("pr.dash.lateTop")}</h2>
              <BarList rows={data.top_late.map((r) => ({ key: String(r.staff.id), label: personName(r.staff, lang), value: r.minutes, note: t("pr.f.daysN", { n: r.days }) }))} format={(n) => hm(n)} empty={t("pr.dash.noLate")} />
            </section>
            <section className="card dash-card">
              <h2>{t("pr.dash.overtimeBy")}</h2>
              <BarList rows={data.overtime.map((r) => ({ key: String(r.staff.id), label: personName(r.staff, lang), value: r.minutes }))} format={(n) => hm(n)} empty={t("pr.dash.noOvertime")} />
            </section>
            <section className="card dash-card">
              <h2>{t("pr.dash.leave")}</h2>
              <BarList rows={data.leave_by_kind.map((r) => ({ key: r.kind, label: t(`pr.leave.${r.kind}` as TKey), value: r.days }))} format={(n) => t("pr.f.daysN", { n })} empty={t("pr.dash.noLeave")} />
            </section>
            <section className="card dash-card">
              <h2>{t("pr.dash.commission")}</h2>
              <BarList rows={data.commission.map((r) => ({ key: String(r.staff.id), label: personName(r.staff, lang), value: Number(r.amount), note: r.paid ? t("pr.run.paid") : t("pr.dash.toPay") }))} format={(n) => `${money(n, lang)} ${currency}`} empty={t("pr.dash.noCommission")} />
            </section>
            <section className="card dash-card">
              <h2>{t("pr.dash.advancesList")}</h2>
              <BarList rows={data.advances.map((r) => ({ key: String(r.id), label: personName(r.staff, lang), value: Number(r.remaining), note: t("pr.dash.perMonth", { n: money(r.installment, lang) }) }))} format={(n) => `${money(n, lang)} ${currency}`} empty={t("pr.adv.none")} />
            </section>
          </div>
        </div>
      )}
    </>
  );
}
