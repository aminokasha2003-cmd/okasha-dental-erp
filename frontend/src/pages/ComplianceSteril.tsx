import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { get, getAll, patch, post, type Page } from "../api";
import { useAuth } from "../auth";
import { useI18n, type TKey } from "../i18n";
import { Modal } from "../components/Crud";
import { Icon } from "../components/Icon";
import { fmtDate } from "../format";
import { errorText } from "./BillingParts";
import { Empty, PatientPicker, Segmented, StatePill, addDaysIso, fmtDateTime, isoToday, nm, useBranches } from "./ComplianceParts";
import type { Checklist, Cycle, Equipment, Load, Pack, PackState, PatientInfo, TraceRow } from "./ComplianceTypes";

type Sub = "cycles" | "packs" | "trace" | "checklist";
const PROGRAMS = ["134_wrapped", "134_unwrapped", "121_wrapped", "prion", "bowie_dick", "helix", "vacuum"];
const TEST_PROGRAMS = ["bowie_dick", "helix", "vacuum"];
const CHECK_ITEMS = ["surfaces", "waterlines", "suction", "ultrasonic", "waste", "autoclave_clean"];

/** Sterilisation: autoclave cycles, instrument packs, traceability and the daily checklist. */
export function Sterilisation({ initialFilter }: { initialFilter?: "fail" | "" }) {
  const { t } = useI18n();
  const [sub, setSub] = useState<Sub>("cycles");
  const subs: { id: Sub; label: string }[] = [
    { id: "cycles", label: t("co.ster.cycles") },
    { id: "packs", label: t("co.ster.packs") },
    { id: "trace", label: t("co.ster.trace") },
    { id: "checklist", label: t("co.ster.checklist") },
  ];
  return (
    <>
      <div className="segmented tabs co-subtabs" role="tablist">
        {subs.map((s) => (
          <button key={s.id} role="tab" aria-selected={sub === s.id} className={sub === s.id ? "active" : ""} onClick={() => setSub(s.id)}>
            {s.label}
          </button>
        ))}
      </div>
      {sub === "cycles" && <Cycles initialFilter={initialFilter} />}
      {sub === "packs" && <Packs />}
      {sub === "trace" && <Trace />}
      {sub === "checklist" && <DailyChecklist />}
    </>
  );
}

export function useAutoclaves() {
  const [rows, setRows] = useState<Equipment[]>([]);
  useEffect(() => {
    get<Equipment[]>("/api/compliance/equipment/?category=autoclave").then(setRows).catch(() => setRows([]));
  }, []);
  return rows;
}

function testMark(result: string, t: (k: TKey) => string) {
  if (!result) return <span className="muted">—</span>;
  return <span className={`co-test ${result}`}>{result === "pass" || result === "negative" ? "✓" : result === "pending" ? "…" : "✗"}<span className="sr-only">{t(`co.res.${result}` as TKey)}</span></span>;
}

function Cycles({ initialFilter }: { initialFilter?: "fail" | "" }) {
  const { t, lang } = useI18n();
  const { can } = useAuth();
  const machines = useAutoclaves();
  const [filter, setFilter] = useState<"all" | "fail" | "bi">(initialFilter === "fail" ? "fail" : "all");
  const [machine, setMachine] = useState("");
  const [from, setFrom] = useState(addDaysIso(isoToday(), -13));
  const [to, setTo] = useState(isoToday());
  const [page, setPage] = useState<Page<Cycle> | null>(null);
  const [pageNo, setPageNo] = useState(1);
  const [viewing, setViewing] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);
  const load = useCallback(() => {
    const q = new URLSearchParams({ page: String(pageNo) });
    if (filter === "fail") q.set("result", "fail");
    if (filter === "bi") q.set("bi", "1");
    if (machine) q.set("machine", machine);
    if (filter === "all") {
      q.set("date_from", from);
      q.set("date_to", to);
    }
    get<Page<Cycle>>(`/api/compliance/cycles/?${q}`).then(setPage).catch(() => setPage(null));
  }, [filter, machine, from, to, pageNo]);
  useEffect(load, [load]);
  return (
    <section className="card">
      <header className="card-head">
        <Segmented
          value={filter}
          onChange={(v) => { setFilter(v); setPageNo(1); }}
          label={t("lab.show")}
          options={[
            { id: "all", label: t("co.ster.byDate") },
            { id: "fail", label: t("co.ster.failedOnly") },
            { id: "bi", label: t("co.ster.biOnly") },
          ]}
        />
        <div className="toolbar">
          <label className="field inline">
            <span>{t("co.machine")}</span>
            <select value={machine} onChange={(e) => setMachine(e.target.value)}>
              <option value="">{t("all")}</option>
              {machines.map((m) => <option key={m.id} value={m.id}>{lang === "ar" ? m.name_ar : m.name_en}</option>)}
            </select>
          </label>
          {filter === "all" && (
            <>
              <label className="field inline"><span>{t("com.from")}</span><input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} /></label>
              <label className="field inline"><span>{t("com.to")}</span><input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} /></label>
            </>
          )}
          {can("compliance", "create") && (
            <button className="btn btn-primary" onClick={() => setAdding(true)}>
              <Icon name="plus" size={18} /> {t("co.ster.record")}
            </button>
          )}
        </div>
      </header>
      {page === null ? (
        <Empty text="loading" />
      ) : page.results.length === 0 ? (
        <Empty text="noRecords" />
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{t("co.when")}</th>
                <th>{t("co.machine")}</th>
                <th>{t("co.program")}</th>
                <th className="num">{t("co.readings")}</th>
                <th>{t("co.tests")}</th>
                <th className="num">{t("co.ster.packs")}</th>
                <th>{t("co.operator")}</th>
                <th>{t("plan.status")}</th>
              </tr>
            </thead>
            <tbody>
              {page.results.map((c) => (
                <tr key={c.id} className={`row-link ${c.result === "fail" ? "co-row-fail" : ""}`} onClick={() => setViewing(c.id)}>
                  <td className="nowrap">{fmtDateTime(c.started_at, lang)}</td>
                  <td>{nm(c.machine_name, lang)} <span className="muted mono small">#{c.cycle_number}</span></td>
                  <td>{t(`co.prog.${c.program}` as TKey)}</td>
                  <td className="num small nowrap">{c.temperature ? `${c.temperature}°C` : "—"} · {c.pressure ? `${c.pressure} bar` : "—"} · {c.hold_minutes ?? "—"}′</td>
                  <td className="nowrap"><span className="co-tests">
                    <span title={t("co.airRemoval")}>{t("co.short.bd")} {testMark(c.air_removal_result, t)}</span>
                    <span title={t("co.ci")}>{t("co.short.ci")} {testMark(c.chemical_indicator, t)}</span>
                    {c.bi_used && <span title={t("co.bi")}>{t("co.short.bi")} {testMark(c.bi_result, t)}</span>}
                  </span></td>
                  <td className="num">{c.pack_count ? `${c.used_count}/${c.pack_count}` : "—"}</td>
                  <td>{nm(c.operator_name, lang) || "—"}</td>
                  <td><StatePill state={c.result} label={t(`co.res.${c.result}` as TKey)} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {page && (page.next || page.previous) && (
        <div className="pager">
          <button className="btn btn-small" disabled={!page.previous} onClick={() => setPageNo((n) => n - 1)}>{t("co.prev")}</button>
          <span className="muted small">{t("co.pageOf", { n: pageNo, total: Math.ceil(page.count / 50) })}</span>
          <button className="btn btn-small" disabled={!page.next} onClick={() => setPageNo((n) => n + 1)}>{t("co.next")}</button>
        </div>
      )}
      {viewing !== null && <CycleView id={viewing} onClose={() => setViewing(null)} onChanged={load} />}
      {adding && <NewCycle machines={machines} onClose={() => setAdding(false)} onSaved={(c) => { setAdding(false); load(); setViewing(c.id); }} />}
    </section>
  );
}

function NewCycle({ machines, onClose, onSaved }: { machines: Equipment[]; onClose: () => void; onSaved: (c: Cycle) => void }) {
  const { t, lang } = useI18n();
  const usable = machines.filter((m) => m.status === "in_service");
  const [v, setV] = useState({
    machine: usable[0]?.id ?? "", program: "134_wrapped", temperature: "134.5", pressure: "2.15", hold_minutes: "5", duration_minutes: "45",
    air_removal_test: "", air_removal_result: "", chemical_indicator: "pass", bi_used: false, bi_lot: "", notes: "",
  });
  const [codes, setCodes] = useState<string[]>([]);
  const [code, setCode] = useState("");
  const [waiting, setWaiting] = useState<Pack[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const isTest = TEST_PROGRAMS.includes(v.program);
  useEffect(() => {
    get<Pack[]>("/api/compliance/packs/").then((rows) => setWaiting(rows.filter((p) => p.state !== "sterile"))).catch(() => setWaiting([]));
  }, []);
  const set = (k: string, value: unknown) => setV((s) => ({ ...s, [k]: value }));
  const addCode = (c: string) => {
    const clean = c.trim().toUpperCase();
    if (clean && !codes.includes(clean)) setCodes((x) => [...x, clean]);
    setCode("");
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const body = { ...v, packs: isTest ? [] : codes, hold_minutes: v.hold_minutes || null, duration_minutes: v.duration_minutes || null, temperature: v.temperature || null, pressure: v.pressure || null };
      onSaved(await post<Cycle>("/api/compliance/cycles/", body));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={t("co.ster.record")} onClose={onClose}>
      <form className="form-grid" onSubmit={submit}>
        <div className="form-grid form-grid-2">
          <div className="field">
            <label htmlFor="cy-machine">{t("co.machine")}</label>
            <select id="cy-machine" required value={v.machine} onChange={(e) => set("machine", e.target.value)}>
              {usable.map((m) => <option key={m.id} value={m.id}>{lang === "ar" ? m.name_ar : m.name_en} · #{(m.cycle_count ?? 0) + 1}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="cy-program">{t("co.program")}</label>
            <select id="cy-program" value={v.program} onChange={(e) => {
              const p = e.target.value;
              setV((s) => ({ ...s, program: p, air_removal_test: p === "bowie_dick" || p === "helix" ? p : s.air_removal_test, air_removal_result: p === "bowie_dick" || p === "helix" ? "pass" : s.air_removal_result }));
            }}>
              {PROGRAMS.map((p) => <option key={p} value={p}>{t(`co.prog.${p}` as TKey)}</option>)}
            </select>
          </div>
        </div>
        <div className="form-grid form-grid-3 co-readings">
          {(["temperature", "pressure", "hold_minutes", "duration_minutes"] as const).map((k) => (
            <div className="field" key={k}>
              <label htmlFor={`cy-${k}`}>{t(`co.f.${k}` as TKey)}</label>
              <input id={`cy-${k}`} type="number" step={k === "pressure" ? "0.01" : k === "temperature" ? "0.1" : "1"} dir="ltr" value={v[k]} onChange={(e) => set(k, e.target.value)} />
            </div>
          ))}
        </div>
        <div className="form-grid form-grid-3">
          <div className="field">
            <label htmlFor="cy-ar">{t("co.airRemoval")}</label>
            <select id="cy-ar" value={v.air_removal_test} onChange={(e) => set("air_removal_test", e.target.value)}>
              <option value="">{t("co.notDone")}</option>
              <option value="bowie_dick">Bowie-Dick</option>
              <option value="helix">Helix</option>
            </select>
          </div>
          {v.air_removal_test && (
            <div className="field">
              <label htmlFor="cy-arr">{t("co.result")}</label>
              <select id="cy-arr" value={v.air_removal_result} onChange={(e) => set("air_removal_result", e.target.value)}>
                <option value="">—</option>
                <option value="pass">{t("co.res.pass")}</option>
                <option value="fail">{t("co.res.fail")}</option>
              </select>
            </div>
          )}
          <div className="field">
            <label htmlFor="cy-ci">{t("co.ci")}</label>
            <select id="cy-ci" value={v.chemical_indicator} onChange={(e) => set("chemical_indicator", e.target.value)}>
              <option value="">—</option>
              <option value="pass">{t("co.res.pass")}</option>
              <option value="fail">{t("co.res.fail")}</option>
            </select>
          </div>
        </div>
        <div className="field field-check">
          <input id="cy-bi" type="checkbox" checked={v.bi_used} onChange={(e) => set("bi_used", e.target.checked)} />
          <label htmlFor="cy-bi">{t("co.biInLoad")}</label>
        </div>
        {v.bi_used && (
          <div className="field">
            <label htmlFor="cy-bilot">{t("co.biLot")}</label>
            <input id="cy-bilot" dir="ltr" value={v.bi_lot} onChange={(e) => set("bi_lot", e.target.value)} />
          </div>
        )}
        {!isTest && (
          <div className="field">
            <label htmlFor="cy-pack">{t("co.ster.loadPacks")}</label>
            <div className="toolbar">
              <input id="cy-pack" dir="ltr" value={code} placeholder={t("co.scanHint")} onChange={(e) => setCode(e.target.value)} onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addCode(code);
                }
              }} />
              <button type="button" className="btn" onClick={() => addCode(code)}>{t("add")}</button>
            </div>
            {codes.length > 0 && (
              <div className="chip-row">
                {codes.map((c) => (
                  <button type="button" key={c} className="chip active" onClick={() => setCodes((x) => x.filter((y) => y !== c))} title={t("co.remove")}>
                    <span className="mono">{c}</span> ✕
                  </button>
                ))}
              </div>
            )}
            {waiting.length > 0 && (
              <>
                <p className="field-hint">{t("co.ster.needCycle")}</p>
                <div className="chip-row co-pack-chips">
                  {waiting.filter((p) => !codes.includes(p.code)).slice(0, 24).map((p) => (
                    <button type="button" key={p.id} className="chip" onClick={() => addCode(p.code)} title={nm({ en: p.name_en, ar: p.name_ar }, lang)}>
                      <span className="mono">{p.code}</span>
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        )}
        <div className="field">
          <label htmlFor="cy-notes">{t("notes")}</label>
          <textarea id="cy-notes" rows={2} value={v.notes} onChange={(e) => set("notes", e.target.value)} />
        </div>
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="form-actions">
          <button type="button" className="btn" onClick={onClose}>{t("cancel")}</button>
          <button className="btn btn-primary" disabled={busy}>{t("save")}</button>
        </div>
      </form>
    </Modal>
  );
}

export function CycleView({ id, onClose, onChanged }: { id: number; onClose: () => void; onChanged?: () => void }) {
  const { t, lang } = useI18n();
  const { can } = useAuth();
  const [c, setC] = useState<Cycle | null>(null);
  const [affected, setAffected] = useState<{ patients: Load[]; shelf: Load[] } | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(() => {
    get<Cycle>(`/api/compliance/cycles/${id}/`).then((x) => {
      setC(x);
      if (x.result === "fail") get<{ patients: Load[]; shelf: Load[] }>(`/api/compliance/cycles/${id}/affected/`).then(setAffected).catch(() => undefined);
    }).catch((err) => setError(errorText(err)));
  }, [id]);
  useEffect(load, [load]);
  const readBi = async (result: "negative" | "positive") => {
    if (result === "positive" && !window.confirm(t("co.biPositiveConfirm"))) return;
    try {
      await post(`/api/compliance/cycles/${id}/bi/`, { result });
      load();
      onChanged?.();
    } catch (err) {
      setError(errorText(err));
    }
  };
  const contacted = async (ld: Load) => {
    const note = window.prompt(t("co.recallNote"), ld.recall_note) ?? undefined;
    if (note === undefined) return;
    await post(`/api/compliance/cycles/${id}/recall/`, { load: ld.id, contacted: true, note });
    load();
  };
  return (
    <Modal title={c ? `${nm(c.machine_name, lang)} · #${c.cycle_number}` : t("loading")} onClose={onClose}>
      {!c ? (
        <p className="muted">{error || t("loading")}</p>
      ) : (
        <div className="co-cycle">
          <div className="invoice-head">
            <div>
              <p className="strong">{t(`co.prog.${c.program}` as TKey)}</p>
              <p className="muted small">{fmtDateTime(c.started_at, lang)} · {nm(c.operator_name, lang) || "—"}</p>
            </div>
            <StatePill state={c.result} label={t(`co.res.${c.result}` as TKey)} />
          </div>
          {c.failure_reasons.length > 0 && (
            <div className="co-warnbox" role="alert">
              <strong>{t("co.whyFailed")}</strong>
              <ul>{c.failure_reasons.map((r) => <li key={r}>{r}</li>)}</ul>
            </div>
          )}
          <dl className="co-facts">
            <div><dt>{t("co.f.temperature")}</dt><dd>{c.temperature ?? "—"}</dd></div>
            <div><dt>{t("co.f.pressure")}</dt><dd>{c.pressure ?? "—"}</dd></div>
            <div><dt>{t("co.f.hold_minutes")}</dt><dd>{c.hold_minutes ?? "—"}</dd></div>
            <div><dt>{t("co.f.duration_minutes")}</dt><dd>{c.duration_minutes ?? "—"}</dd></div>
            <div><dt>{t("co.airRemoval")}</dt><dd>{c.air_removal_test ? `${c.air_removal_test === "helix" ? "Helix" : "Bowie-Dick"}: ${c.air_removal_result ? t(`co.res.${c.air_removal_result}` as TKey) : "—"}` : t("co.notDone")}</dd></div>
            <div><dt>{t("co.ci")}</dt><dd>{c.chemical_indicator ? t(`co.res.${c.chemical_indicator}` as TKey) : "—"}</dd></div>
            {c.bi_used && <div><dt>{t("co.bi")}</dt><dd>{c.bi_lot} · {t(`co.res.${c.bi_result || "pending"}` as TKey)}{c.bi_read_at ? ` · ${fmtDateTime(c.bi_read_at, lang)}` : ""}</dd></div>}
          </dl>
          {c.bi_used && c.bi_result === "pending" && can("compliance", "edit") && (
            <div className="toolbar">
              <span className="muted small">{t("co.readBi")}</span>
              <button className="btn btn-small" onClick={() => void readBi("negative")}>{t("co.res.negative")}</button>
              <button className="btn btn-small" onClick={() => void readBi("positive")}>{t("co.res.positive")}</button>
            </div>
          )}
          {c.notes && <p className="notice pad-s">{c.notes}</p>}
          {affected && (
            <section className="subsection co-recall">
              <h3><Icon name="phone" size={16} /> {t("co.recallTitle", { n: affected.patients.length })}</h3>
              {c.bi_result === "positive" && <p className="muted small">{t("co.recallWindow")}</p>}
              {affected.patients.length === 0 ? (
                <p className="muted small">{t("co.recallNone")}</p>
              ) : (
                <ul className="plain-list inst-list">
                  {affected.patients.map((ld) => (
                    <li key={ld.id}>
                      <span className="grow">
                        <strong>{nm(ld.patient, lang)}</strong> <span className="muted mono small">{ld.patient?.file_number}</span>
                        <span className="muted small block" dir="auto">
                          <span dir="ltr">{ld.patient?.phone}</span> · {ld.pack.code}{ld.cycle_number && ld.cycle_number !== c.cycle_number ? ` (#${ld.cycle_number})` : ""} · {fmtDateTime(ld.used_at, lang)}{ld.appointment?.dentist ? ` · ${nm(ld.appointment.dentist, lang)}` : ""}
                        </span>
                        {ld.recall_note && <span className="small block">{ld.recall_note}</span>}
                      </span>
                      {ld.recall_contacted_at ? (
                        <span className="pill pill-ok">{t("co.contacted")}</span>
                      ) : can("compliance", "edit") ? (
                        <button className="btn btn-small btn-primary" onClick={() => void contacted(ld)}>{t("co.markContacted")}</button>
                      ) : (
                        <span className="pill pill-ready">{t("co.toCall")}</span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {affected.shelf.length > 0 && <p className="muted small">{t("co.shelfPacks", { codes: affected.shelf.map((s) => s.pack.code).join(", ") })}</p>}
            </section>
          )}
          {!affected && c.loads && c.loads.length > 0 && (
            <section className="subsection">
              <h3>{t("co.ster.packsInLoad", { n: c.loads.length })}</h3>
              <ul className="plain-list inst-list">
                {c.loads.map((ld) => (
                  <li key={ld.id}>
                    <span className="mono small">{ld.pack.code}</span>
                    <span className="grow">{nm(ld.pack, lang)}</span>
                    {ld.patient ? <span className="small">{nm(ld.patient, lang)} · {fmtDateTime(ld.used_at, lang)}</span> : <span className="muted small">{t("co.until", { date: fmtDate(ld.expires_on, lang) })}</span>}
                  </li>
                ))}
              </ul>
            </section>
          )}
          {error && <p className="form-error" role="alert">{error}</p>}
        </div>
      )}
    </Modal>
  );
}

function Packs() {
  const { t, lang } = useI18n();
  const { can } = useAuth();
  const [rows, setRows] = useState<Pack[] | null>(null);
  const [state, setState] = useState<"all" | PackState>("all");
  const [search, setSearch] = useState("");
  const [using, setUsing] = useState<Pack | null>(null);
  const [history, setHistory] = useState<Pack | null>(null);
  const [adding, setAdding] = useState(false);
  const load = useCallback(() => {
    get<Pack[]>(`/api/compliance/packs/${search ? `?search=${encodeURIComponent(search)}` : ""}`).then(setRows).catch(() => setRows([]));
  }, [search]);
  useEffect(() => {
    const timer = window.setTimeout(load, search ? 250 : 0);
    return () => window.clearTimeout(timer);
  }, [load, search]);
  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    rows?.forEach((p) => (c[p.state] = (c[p.state] ?? 0) + 1));
    return c;
  }, [rows]);
  const shown = (rows ?? []).filter((p) => state === "all" || p.state === state);
  const states: PackState[] = ["sterile", "used", "expired", "failed", "none"];
  return (
    <section className="card">
      <header className="card-head">
        <Segmented
          value={state}
          onChange={setState}
          label={t("lab.show")}
          options={[{ id: "all", label: t("all"), n: rows?.length }, ...states.map((s) => ({ id: s, label: t(`co.pack.${s}` as TKey), n: counts[s] ?? 0, warn: s === "expired" || s === "failed" }))]}
        />
        <div className="toolbar">
          <label className="top-search search-field">
            <Icon name="search" />
            <input type="search" aria-label={t("search")} placeholder={t("co.packSearch")} value={search} onChange={(e) => setSearch(e.target.value)} />
          </label>
          {can("compliance", "edit") && <button className="btn btn-primary" onClick={() => setAdding(true)}><Icon name="plus" size={18} /> {t("co.addPack")}</button>}
        </div>
      </header>
      {rows === null ? <Empty text="loading" /> : shown.length === 0 ? <Empty text="noRecords" /> : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{t("co.code")}</th>
                <th>{t("co.pack")}</th>
                <th>{t("co.branch")}</th>
                <th>{t("plan.status")}</th>
                <th>{t("co.lastCycle")}</th>
                <th>{t("co.sterileUntil")}</th>
                <th>{t("co.usedFor")}</th>
                <th className="cell-actions">{t("actions")}</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((p) => (
                <tr key={p.id}>
                  <td className="mono small">{p.code}</td>
                  <td>{lang === "ar" ? p.name_ar : p.name_en} <span className="muted small">· {t(`co.kind.${p.kind}` as TKey)}</span></td>
                  <td>{nm(p.branch_name, lang) || "—"}</td>
                  <td><StatePill state={p.state} label={t(`co.pack.${p.state}` as TKey)} /></td>
                  <td className="small">{p.last ? `${p.last.machine} #${p.last.cycle_number} · ${fmtDateTime(p.last.sterilised_at, lang)}` : "—"}</td>
                  <td className="nowrap">{p.last ? fmtDate(p.last.expires_on, lang) : "—"}</td>
                  <td className="small">{p.last?.patient ? `${nm(p.last.patient, lang)} · ${fmtDateTime(p.last.used_at, lang)}` : "—"}</td>
                  <td className="cell-actions">
                    {p.state === "sterile" && can("compliance", "create") && <button className="btn btn-small btn-primary" onClick={() => setUsing(p)}>{t("co.openFor")}</button>}
                    <button className="btn btn-small" onClick={() => setHistory(p)}>{t("co.history")}</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {using && <UsePack pack={using} onClose={() => setUsing(null)} onSaved={() => { setUsing(null); load(); }} />}
      {history && <PackHistory pack={history} onClose={() => setHistory(null)} />}
      {adding && <NewPack onClose={() => setAdding(false)} onSaved={() => { setAdding(false); load(); }} />}
    </section>
  );
}

function NewPack({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const { t, name } = useI18n();
  const branches = useBranches();
  const [v, setV] = useState({ code: "", name_en: "", name_ar: "", kind: "cassette", branch: "", contents: "" });
  const [error, setError] = useState("");
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await post("/api/compliance/packs/", { ...v, branch: v.branch || null });
      onSaved();
    } catch (err) {
      setError(errorText(err));
    }
  };
  const field = (k: keyof typeof v, label: TKey, dir?: string) => (
    <div className="field">
      <label htmlFor={`np-${k}`}>{t(label)}</label>
      <input id={`np-${k}`} dir={dir} required={k !== "contents"} value={v[k]} onChange={(e) => setV((s) => ({ ...s, [k]: e.target.value }))} />
    </div>
  );
  return (
    <Modal title={t("co.addPack")} onClose={onClose}>
      <form className="form-grid" onSubmit={submit}>
        {field("code", "co.code", "ltr")}
        {field("name_en", "nameEn", "ltr")}
        {field("name_ar", "nameAr", "rtl")}
        <div className="form-grid form-grid-2">
          <div className="field">
            <label htmlFor="np-kind">{t("co.kindLabel")}</label>
            <select id="np-kind" value={v.kind} onChange={(e) => setV((s) => ({ ...s, kind: e.target.value }))}>
              {["cassette", "pouch", "tray", "handpiece", "surgical", "implant"].map((k) => <option key={k} value={k}>{t(`co.kind.${k}` as TKey)}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="np-branch">{t("co.branch")}</label>
            <select id="np-branch" value={v.branch} onChange={(e) => setV((s) => ({ ...s, branch: e.target.value }))}>
              <option value="">{t("none")}</option>
              {branches.map((b) => <option key={b.id} value={b.id}>{name(b)}</option>)}
            </select>
          </div>
        </div>
        {field("contents", "co.contents")}
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="form-actions">
          <button type="button" className="btn" onClick={onClose}>{t("cancel")}</button>
          <button className="btn btn-primary">{t("save")}</button>
        </div>
      </form>
    </Modal>
  );
}

function UsePack({ pack, onClose, onSaved }: { pack: Pack; onClose: () => void; onSaved: () => void }) {
  const { t, lang } = useI18n();
  const [patient, setPatient] = useState<PatientInfo | null>(null);
  const [error, setError] = useState("");
  const save = async () => {
    if (!patient) return;
    try {
      await post(`/api/compliance/packs/${pack.id}/use/`, { patient: patient.id });
      onSaved();
    } catch (err) {
      setError(errorText(err));
    }
  };
  return (
    <Modal title={t("co.openPackTitle", { code: pack.code })} onClose={onClose}>
      <div className="form-grid">
        <p className="muted small">{lang === "ar" ? pack.name_ar : pack.name_en} · {pack.last ? `${pack.last.machine} #${pack.last.cycle_number}` : ""}</p>
        <PatientPicker value={patient} onChange={setPatient} />
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="form-actions">
          <button className="btn" onClick={onClose}>{t("cancel")}</button>
          <button className="btn btn-primary" disabled={!patient} onClick={() => void save()}>{t("co.openFor")}</button>
        </div>
      </div>
    </Modal>
  );
}

function PackHistory({ pack, onClose }: { pack: Pack; onClose: () => void }) {
  const { t, lang } = useI18n();
  const [rows, setRows] = useState<(Load & { cycle: { id: number; number: number; machine: { en: string; ar: string }; started_at: string; result: string } })[] | null>(null);
  useEffect(() => {
    get<typeof rows>(`/api/compliance/packs/${pack.id}/history/`).then(setRows).catch(() => setRows([]));
  }, [pack.id]);
  return (
    <Modal title={`${pack.code} · ${t("co.history")}`} onClose={onClose}>
      {rows === null ? <p className="muted">{t("loading")}</p> : rows.length === 0 ? <p className="muted">{t("noRecords")}</p> : (
        <ul className="plain-list inst-list">
          {rows.map((r) => (
            <li key={r.id}>
              <span className="grow small">{fmtDateTime(r.cycle.started_at, lang)} · {nm(r.cycle.machine, lang)} #{r.cycle.number}</span>
              <StatePill state={r.cycle.result} label={t(`co.res.${r.cycle.result}` as TKey)} />
              <span className="small">{r.patient ? nm(r.patient, lang) : "—"}</span>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}

function Trace() {
  const { t, lang } = useI18n();
  const [patient, setPatient] = useState<PatientInfo | null>(null);
  const [rows, setRows] = useState<TraceRow[] | null>(null);
  const [failed, setFailed] = useState<Cycle[]>([]);
  const [viewing, setViewing] = useState<number | null>(null);
  useEffect(() => {
    get<Page<Cycle>>("/api/compliance/cycles/?result=fail").then((p) => setFailed(p.results)).catch(() => setFailed([]));
  }, []);
  useEffect(() => {
    if (!patient) {
      setRows(null);
      return;
    }
    get<TraceRow[]>(`/api/compliance/trace/patient/${patient.id}/`).then(setRows).catch(() => setRows([]));
  }, [patient]);
  return (
    <div className="co-two">
      <section className="card pad">
        <h2>{t("co.trace.fromPatient")}</h2>
        <p className="muted small">{t("co.trace.fromPatientHint")}</p>
        <PatientPicker value={patient} onChange={setPatient} />
        {rows && (rows.length === 0 ? <p className="muted">{t("co.trace.none")}</p> : (
          <ul className="plain-list co-trace">
            {rows.map((r) => (
              <li key={r.id} className={r.cycle.result === "fail" ? "is-fail" : ""}>
                <button className="co-trace-row" onClick={() => setViewing(r.cycle.id)}>
                  <span className="strong">{fmtDateTime(r.used_at, lang)}</span>
                  <span className="small">{r.pack.code} · {nm(r.cycle.machine, lang)} #{r.cycle.number} · {fmtDateTime(r.cycle.started_at, lang)}</span>
                  <span className="small muted">{nm(r.cycle.operator, lang)}</span>
                  <StatePill state={r.cycle.result} label={t(`co.res.${r.cycle.result}` as TKey)} />
                </button>
              </li>
            ))}
          </ul>
        ))}
      </section>
      <section className="card pad">
        <h2>{t("co.trace.fromCycle")}</h2>
        <p className="muted small">{t("co.trace.fromCycleHint")}</p>
        {failed.length === 0 ? <p className="muted">{t("co.trace.noFailed")}</p> : (
          <ul className="plain-list co-trace">
            {failed.map((c) => (
              <li key={c.id} className="is-fail">
                <button className="co-trace-row" onClick={() => setViewing(c.id)}>
                  <span className="strong">{nm(c.machine_name, lang)} #{c.cycle_number}</span>
                  <span className="small">{fmtDateTime(c.started_at, lang)} · {t("co.packsUsedN", { n: c.used_count })}</span>
                  <span className="small muted">{c.failure_reasons[0]}</span>
                  <StatePill state="fail" label={t("co.res.fail")} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
      {viewing !== null && <CycleView id={viewing} onClose={() => setViewing(null)} />}
    </div>
  );
}

function DailyChecklist() {
  const { t, lang, name } = useI18n();
  const { can } = useAuth();
  const branches = useBranches();
  const [branch, setBranch] = useState<number | null>(null);
  const [rows, setRows] = useState<Checklist[]>([]);
  const [today, setToday] = useState<Record<string, boolean>>({});
  const [notes, setNotes] = useState("");
  const [msg, setMsg] = useState("");
  useEffect(() => {
    if (branch === null && branches[0]) setBranch(branches[0].id);
  }, [branches, branch]);
  const load = useCallback(() => {
    if (branch === null) return;
    getAll<Checklist>(`/api/compliance/checklists/?branch=${branch}`).then((r) => {
      setRows(r.slice(0, 14));
      const mine = r.find((x) => x.date === isoToday());
      setToday(mine?.items ?? {});
      setNotes(mine?.notes ?? "");
    }).catch(() => setRows([]));
  }, [branch]);
  useEffect(load, [load]);
  const existing = rows.find((x) => x.date === isoToday());
  const save = async () => {
    setMsg("");
    try {
      if (existing) await patch(`/api/compliance/checklists/${existing.id}/`, { items: today, notes });
      else await post("/api/compliance/checklists/", { branch, date: isoToday(), items: today, notes });
      setMsg(t("saved"));
      load();
    } catch (err) {
      setMsg(errorText(err));
    }
  };
  return (
    <div className="co-two">
      <section className="card pad">
        <div className="card-head-plain">
          <h2>{t("co.check.today")}</h2>
          <select aria-label={t("co.branch")} value={branch ?? ""} onChange={(e) => setBranch(Number(e.target.value))}>
            {branches.map((b) => <option key={b.id} value={b.id}>{name(b)}</option>)}
          </select>
        </div>
        <div className="co-checks">
          {CHECK_ITEMS.map((k) => (
            <label key={k} className={`co-check ${today[k] ? "on" : ""}`}>
              <input type="checkbox" checked={Boolean(today[k])} disabled={!can("compliance", "create")} onChange={(e) => setToday((s) => ({ ...s, [k]: e.target.checked }))} />
              <span>{t(`co.check.${k}` as TKey)}</span>
            </label>
          ))}
        </div>
        <div className="field">
          <label htmlFor="ck-notes">{t("notes")}</label>
          <input id="ck-notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
        </div>
        {can("compliance", "create") && (
          <div className="form-actions">
            {msg && <span className="muted small">{msg}</span>}
            <button className="btn btn-primary" onClick={() => void save()}>{t("save")}</button>
          </div>
        )}
      </section>
      <section className="card">
        <header className="card-head"><h2>{t("co.check.recent")}</h2></header>
        {rows.length === 0 ? <Empty text="noRecords" /> : (
          <div className="table-wrap">
            <table className="co-check-table">
              <thead>
                <tr>
                  <th>{t("co.date")}</th>
                  {CHECK_ITEMS.map((k) => <th key={k} className="center" title={t(`co.check.${k}` as TKey)}>{t(`co.checkShort.${k}` as TKey)}</th>)}
                  <th>{t("co.by")}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td className="nowrap">{fmtDate(r.date, lang)}</td>
                    {CHECK_ITEMS.map((k) => <td key={k} className="center">{r.items[k] ? <span className="co-test pass">✓</span> : <span className="co-test fail">✗</span>}</td>)}
                    <td className="small">{nm(r.done_by_name, lang)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
