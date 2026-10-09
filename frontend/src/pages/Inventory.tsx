import { useCallback, useEffect, useMemo, useState, type CSSProperties, type FormEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { del, get, getAll, patch, post, type Page } from "../api";
import { useAuth } from "../auth";
import { useI18n, type TKey } from "../i18n";
import { ActiveBadge, Modal, RecordForm, type FieldDef } from "../components/Crud";
import { Icon, type IconName } from "../components/Icon";
import { fmtDate, locale, money } from "../format";
import type {
  Branch,
  ImplantTrace,
  InventorySummary,
  ItemCategory,
  MovementKind,
  Patient,
  POStatus,
  Procedure,
  ProcedureMaterial,
  PurchaseOrder,
  StockItem,
  StockLot,
  StockMovement,
  SuggestResult,
  Supplier,
} from "../types";
import { errorText, personName, useCurrency } from "./BillingParts";
import {
  CATEGORIES,
  Expiry,
  ItemDialog,
  ItemView,
  KIND_PILL,
  KINDS,
  PO_PILL,
  PODialog,
  POView,
  PatientLink,
  fmtQty,
  itemName,
  moveRef,
  signed,
  useBranches,
  useMoneyAccess,
  useUnit,
  type PODraft,
} from "./InventoryParts";
import { patientName } from "./Patients";

type Tab = "overview" | "stock" | "orders" | "suppliers" | "movements" | "trace" | "materials";
const BRANCH_KEY = "erp.inv.branch";

function savedBranch(): number | "" {
  try {
    return Number(sessionStorage.getItem(BRANCH_KEY)) || "";
  } catch {
    return "";
  }
}

/** Suggested order quantity: the reorder quantity, or enough to reach twice the reorder level. */
function reorderQty(item: StockItem) {
  if (Number(item.reorder_quantity) > 0) return item.reorder_quantity;
  return String(Math.max(Number(item.reorder_level) * 2 - Number(item.on_hand), 1));
}

/** Inventory and purchasing: stock per branch, purchase orders, suppliers, the ledger and implant tracing. */
export function Inventory() {
  const { t, name } = useI18n();
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const tab = (params.get("tab") as Tab) || "overview";
  const branches = useBranches();
  const [branch, setBranch] = useState<number | "">(savedBranch);
  const [version, setVersion] = useState(0);
  const [poDraft, setPoDraft] = useState<PODraft | null>(null);
  const [viewPo, setViewPo] = useState<PurchaseOrder | null>(null);
  const bump = useCallback(() => setVersion((v) => v + 1), []);

  useEffect(() => {
    try {
      sessionStorage.setItem(BRANCH_KEY, String(branch));
    } catch {
      /* storage blocked */
    }
  }, [branch]);
  // A remembered branch that no longer exists falls back to all branches.
  useEffect(() => {
    if (branches.length && branch !== "" && !branches.some((b) => b.id === branch)) setBranch("");
  }, [branches, branch]);

  const tabs: { id: Tab; label: TKey; show: boolean }[] = [
    { id: "overview", label: "inv.tab.overview", show: true },
    { id: "stock", label: "inv.tab.stock", show: true },
    { id: "orders", label: "inv.tab.orders", show: true },
    { id: "suppliers", label: "inv.tab.suppliers", show: true },
    { id: "movements", label: "inv.tab.movements", show: true },
    { id: "trace", label: "inv.tab.trace", show: true },
    { id: "materials", label: "inv.tab.materials", show: true },
  ];
  const go = (next: Tab, extra: Record<string, string> = {}) => setParams({ tab: next, ...extra }, { replace: true });
  const reorder = (item: StockItem) =>
    setPoDraft({ supplier: item.preferred_supplier, branch: branch || (branches.length === 1 ? branches[0].id : null), lines: [{ item: item.id, quantity: reorderQty(item) }] });
  const shared = { branch, branches, version, bump, onReorder: can("inventory", "create") ? reorder : undefined, onOpenPo: setViewPo };

  return (
    <div className="page inv-page">
      <div className="page-head">
        <div>
          <h1>{t("inv.title")}</h1>
          <p className="muted">{t("inv.subtitle")}</p>
        </div>
        {branches.length > 1 && (
          <label className="field inline">
            <span>{t("ap.branch")}</span>
            <select value={branch} onChange={(e) => setBranch(e.target.value ? Number(e.target.value) : "")}>
              <option value="">{t("box.allBranches")}</option>
              {branches.map((b) => (
                <option key={b.id} value={b.id}>{name(b)}</option>
              ))}
            </select>
          </label>
        )}
      </div>
      <div className="segmented tabs inv-tabs" role="tablist">
        {tabs
          .filter((x) => x.show)
          .map((x) => (
            <button key={x.id} role="tab" aria-selected={tab === x.id} className={tab === x.id ? "active" : ""} onClick={() => go(x.id)}>
              {t(x.label)}
            </button>
          ))}
      </div>
      {tab === "overview" && <Overview {...shared} go={go} />}
      {tab === "stock" && <Stock {...shared} initialFilter={params.get("filter")} />}
      {tab === "orders" && <Orders {...shared} onNew={() => setPoDraft({ branch: branch || null })} />}
      {tab === "suppliers" && <Suppliers />}
      {tab === "movements" && <Movements branch={branch} version={version} />}
      {tab === "trace" && <Trace />}
      {tab === "materials" && <Materials />}
      {poDraft && (
        <PODialog
          order={null}
          draft={poDraft}
          onClose={() => setPoDraft(null)}
          onSaved={(po) => {
            setPoDraft(null);
            bump();
            setViewPo(po);
          }}
        />
      )}
      {viewPo && <POView key={viewPo.id} initial={viewPo} onClose={() => setViewPo(null)} onChanged={bump} />}
    </div>
  );
}

interface Shared {
  branch: number | "";
  branches: Branch[];
  version: number;
  bump: () => void;
  onReorder?: (item: StockItem) => void;
  onOpenPo: (po: PurchaseOrder) => void;
}

const branchQuery = (branch: number | "", sep = "&") => (branch ? `${sep}branch=${branch}` : "");

/* ------------------------------------------------------------ overview */

function Tile({ i, icon, label, value, sub, tone = "", onClick }: { i: number; icon: IconName; label: string; value: string | number; sub?: string; tone?: string; onClick?: () => void }) {
  const body = (
    <>
      <span className="inv-tile-icon" aria-hidden="true">
        <Icon name={icon} size={18} />
      </span>
      <span className="overline">{label}</span>
      <span className="inv-tile-n">{value}</span>
      {sub && <span className="small inv-tile-sub">{sub}</span>}
    </>
  );
  const style = { "--i": i } as CSSProperties;
  return onClick ? (
    <button type="button" className={`card inv-tile ${tone}`} style={style} onClick={onClick}>
      {body}
    </button>
  ) : (
    <div className={`card inv-tile ${tone}`} style={style}>
      {body}
    </div>
  );
}

function Overview({ branch, branches, version, bump, onReorder, onOpenPo, go }: Shared & { go: (tab: Tab, extra?: Record<string, string>) => void }) {
  const { t, lang } = useI18n();
  const { can } = useAuth();
  const showMoney = useMoneyAccess();
  const currency = useCurrency();
  const unit = useUnit();
  const [summary, setSummary] = useState<InventorySummary | null>(null);
  const [low, setLow] = useState<StockItem[] | null>(null);
  const [lots, setLots] = useState<StockLot[] | null>(null);
  const [viewing, setViewing] = useState<StockItem | null>(null);
  const [suggesting, setSuggesting] = useState(false);
  const [suggested, setSuggested] = useState<SuggestResult | null>(null);

  const load = useCallback(() => {
    get<InventorySummary>(`/api/inventory/summary/${branchQuery(branch, "?")}`).then(setSummary).catch(() => undefined);
    get<Page<StockItem>>(`/api/inventory/items/?low=1&active=1${branchQuery(branch)}`)
      .then((p) => setLow(p.results))
      .catch(() => setLow([]));
    Promise.all([
      get<Page<StockLot>>(`/api/inventory/lots/?expired=1${branchQuery(branch)}`),
      get<Page<StockLot>>(`/api/inventory/lots/?expiring=60${branchQuery(branch)}`),
    ])
      .then(([expired, soon]) => setLots([...expired.results, ...soon.results]))
      .catch(() => setLots([]));
  }, [branch]);
  useEffect(load, [load, version]);

  const s = summary;
  const tiles = s
    ? [
        showMoney && { icon: "wallet" as IconName, label: t("inv.stockValue"), value: money(s.stock_value, lang), sub: t("inv.itemsN", { n: s.items }), tone: "total", onClick: () => go("stock") },
        { icon: "box" as IconName, label: t("inv.lowStock"), value: s.low_stock, sub: t("inv.atReorder"), tone: s.low_stock ? "warn" : "", onClick: () => go("stock", { filter: "low" }) },
        { icon: "circle" as IconName, label: t("inv.outOfStock"), value: s.out_of_stock, sub: t("inv.nothingLeft"), tone: s.out_of_stock ? "warn" : "" },
        { icon: "calendar" as IconName, label: t("inv.expiring"), value: s.expiring_30, sub: t("inv.expiringSub", { a: s.expiring_60, b: s.expiring_90 }), tone: s.expiring_30 ? "sand" : "", onClick: () => go("stock", { filter: "expiring" }) },
        { icon: "history" as IconName, label: t("inv.expiredStock"), value: s.expired_with_stock, sub: t("inv.expiredSub"), tone: s.expired_with_stock ? "warn" : "" },
        { icon: "receipt" as IconName, label: t("inv.purchaseOrders"), value: s.open_orders, sub: t("inv.openDrafts", { n: s.draft_orders }), tone: "", onClick: () => go("orders") },
        showMoney && { icon: "chart" as IconName, label: t("inv.consumedMonth"), value: money(s.consumed_this_month, lang), sub: currency, tone: "mint", onClick: () => go("movements") },
      ].filter(Boolean)
    : [];

  return (
    <>
      <div className="inv-tiles">
        {s === null
          ? Array.from({ length: 6 }, (_, i) => <div key={i} className="card inv-tile is-loading" style={{ "--i": i } as CSSProperties} aria-hidden="true" />)
          : tiles.map((x, i) => x && <Tile key={x.label} i={i} {...x} />)}
      </div>

      {can("inventory", "create") && (
        <section className="card pad inv-suggest">
          <div className="grow">
            <h2>{t("inv.suggestTitle")}</h2>
            <p className="muted small">{t("inv.suggestHint")}</p>
          </div>
          <button className="btn btn-accent" onClick={() => setSuggesting(true)}>
            <Icon name="receipt" size={18} /> {t("inv.suggest")}
          </button>
        </section>
      )}

      {suggested && (
        <section className="card inv-suggested">
          <header className="card-head">
            <h2>{suggested.orders.length ? t("inv.draftsMade", { n: suggested.orders.length }) : t("inv.noDraftsMade")}</h2>
            <button className="btn btn-small" onClick={() => setSuggested(null)}>{t("close")}</button>
          </header>
          {suggested.orders.length > 0 && (
            <ul className="plain-list pad">
              {suggested.orders.map((po, i) => (
                <li key={po.id} style={{ "--i": i } as CSSProperties}>
                  <button className="bill-row" onClick={() => onOpenPo(po)}>
                    <span className="mono small">{po.number}</span>
                    <span className="grow strong">{po.supplier_name}</span>
                    <span className="muted small">{t("inv.linesN", { n: po.lines.length })}</span>
                    <span className="num strong">{money(po.total, lang)}</span>
                    <Icon name="arrow" size={16} className="flip-rtl" />
                  </button>
                </li>
              ))}
            </ul>
          )}
          {suggested.no_supplier.length > 0 && (
            <div className="pad">
              <p className="notice pad-sm small">{t("inv.noSupplierNote")}</p>
              <ul className="plain-list inv-attn-list">
                {suggested.no_supplier.map((x) => (
                  <li key={x.id}>
                    <span className="grow">{itemName(x, lang)}</span>
                    <span className="muted small">{t("inv.suggestedQty", { n: fmtQty(x.suggested, lang), u: unit(x.unit) })}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      )}

      <div className="two-col">
        <section className="card">
          <header className="card-head">
            <h2>{t("inv.needsReorder")}</h2>
            {low && low.length > 0 && <span className="pill pill-warn">{low.length}</span>}
          </header>
          {low === null ? (
            <p className="muted pad">{t("loading")}</p>
          ) : low.length === 0 ? (
            <p className="muted pad inv-all-good"><Icon name="check" size={18} /> {t("inv.allStocked")}</p>
          ) : (
            <ul className="plain-list inv-attn-list pad">
              {low.slice(0, 10).map((item, i) => (
                <li key={item.id} style={{ "--i": i } as CSSProperties}>
                  <button className="link-button grow" onClick={() => setViewing(item)}>
                    {itemName(item, lang)}
                  </button>
                  <span className="small nowrap">
                    <strong className="owed num">{fmtQty(item.on_hand, lang)}</strong> <span className="muted">/ {fmtQty(item.reorder_level, lang)} {unit(item.unit)}</span>
                  </span>
                  {onReorder && (
                    <button className="btn btn-small" onClick={() => onReorder(item)}>{t("inv.reorder")}</button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className="card">
          <header className="card-head">
            <h2>{t("inv.expiringLots")}</h2>
            <span className="muted small">{t("inv.next60")}</span>
          </header>
          {lots === null ? (
            <p className="muted pad">{t("loading")}</p>
          ) : lots.length === 0 ? (
            <p className="muted pad inv-all-good"><Icon name="check" size={18} /> {t("inv.noExpiring")}</p>
          ) : (
            <ul className="plain-list inv-attn-list pad">
              {lots.slice(0, 12).map((l, i) => (
                <li key={l.id} className={l.days_to_expiry !== null && l.days_to_expiry < 0 ? "is-expired" : ""} style={{ "--i": i } as CSSProperties}>
                  <span className="grow">
                    <span className="block">{itemName(l.item_info, lang)}</span>
                    <span className="muted small">
                      {l.lot_number && <span className="mono">{l.lot_number} · </span>}
                      {personName(l.branch_name, lang)} · {fmtQty(l.quantity, lang)} {unit(l.item_info.unit)}
                    </span>
                  </span>
                  <Expiry date={l.expiry_date} days={l.days_to_expiry} />
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      {viewing && <ItemView initial={viewing} branches={branches} onClose={() => setViewing(null)} onChanged={bump} onReorder={onReorder} />}
      {suggesting && (
        <SuggestDialog
          branch={branch}
          branches={branches}
          onClose={() => setSuggesting(false)}
          onDone={(result) => {
            setSuggesting(false);
            setSuggested(result);
            bump();
          }}
        />
      )}
    </>
  );
}

function SuggestDialog({ branch, branches, onClose, onDone }: { branch: number | ""; branches: Branch[]; onClose: () => void; onDone: (r: SuggestResult) => void }) {
  const { t, name } = useI18n();
  const [target, setTarget] = useState<number | "">(branch || (branches.length === 1 ? branches[0].id : ""));
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [supplier, setSupplier] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    getAll<Supplier>("/api/inventory/suppliers/?active=1").then(setSuppliers).catch(() => undefined);
  }, []);
  useEffect(() => {
    if (target === "" && branches.length === 1) setTarget(branches[0].id);
  }, [branches, target]);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      onDone(await post<SuggestResult>("/api/inventory/purchase-orders/suggest/", { branch: target, ...(supplier ? { supplier: Number(supplier) } : {}) }));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={t("inv.suggest")} onClose={onClose}>
      <form className="form-grid" onSubmit={submit}>
        <p className="muted small">{t("inv.suggestIntro")}</p>
        <div className="form-grid form-grid-2">
          <label className="field">
            <span className="field-label">{t("inv.deliverTo")}</span>
            <select required value={target} onChange={(e) => setTarget(e.target.value ? Number(e.target.value) : "")}>
              <option value="">—</option>
              {branches.map((b) => <option key={b.id} value={b.id}>{name(b)}</option>)}
            </select>
          </label>
          <label className="field">
            <span className="field-label">{t("inv.supplier")}</span>
            <select value={supplier} onChange={(e) => setSupplier(e.target.value)}>
              <option value="">{t("inv.allSuppliers")}</option>
              {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </label>
        </div>
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="form-actions">
          <button type="button" className="btn" onClick={onClose}>{t("cancel")}</button>
          <button type="submit" className="btn btn-primary" disabled={busy || target === ""}>{t("inv.makeDrafts")}</button>
        </div>
      </form>
    </Modal>
  );
}

/* --------------------------------------------------------------- stock */

type StockFilter = "all" | "low" | "expiring";

function Stock({ branch, branches, version, bump, onReorder, initialFilter }: Shared & { initialFilter: string | null }) {
  const { t, lang } = useI18n();
  const { can } = useAuth();
  const showMoney = useMoneyAccess();
  const unit = useUnit();
  const [search, setSearch] = useState("");
  const [cats, setCats] = useState<ItemCategory[]>([]);
  const [filter, setFilter] = useState<StockFilter>(initialFilter === "low" || initialFilter === "expiring" ? initialFilter : "all");
  const [rows, setRows] = useState<StockItem[] | null>(null);
  const [viewing, setViewing] = useState<StockItem | null>(null);
  const [adding, setAdding] = useState(false);

  const load = useCallback(() => {
    const q = new URLSearchParams();
    if (search.trim()) q.set("search", search.trim());
    if (cats.length) q.set("category", cats.join(","));
    if (filter === "low") q.set("low", "1");
    if (filter === "expiring") q.set("expiring", "90");
    if (branch) q.set("branch", String(branch));
    getAll<StockItem>(`/api/inventory/items/?${q}`).then(setRows).catch(() => setRows([]));
  }, [search, cats, filter, branch]);
  useEffect(() => {
    const timer = window.setTimeout(load, search ? 250 : 0);
    return () => window.clearTimeout(timer);
  }, [load, search, version]);

  const toggle = (c: ItemCategory) => setCats((xs) => (xs.includes(c) ? xs.filter((x) => x !== c) : [...xs, c]));
  const filters: { id: StockFilter; label: TKey }[] = [
    { id: "all", label: "inv.filter.all" },
    { id: "low", label: "inv.filter.low" },
    { id: "expiring", label: "inv.filter.expiring" },
  ];

  return (
    <>
      <section className="card pad inv-filters">
        <div className="inv-filter-top">
          <label className="top-search search-field">
            <Icon name="search" />
            <input type="search" aria-label={t("search")} placeholder={t("inv.searchItems")} value={search} onChange={(e) => setSearch(e.target.value)} />
          </label>
          <div className="segmented" role="group" aria-label={t("inv.show")}>
            {filters.map((f) => (
              <button key={f.id} aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>{t(f.label)}</button>
            ))}
          </div>
          {can("inventory", "edit") && (
            <button className="btn btn-primary" onClick={() => setAdding(true)}>
              <Icon name="plus" size={18} /> {t("inv.newItem")}
            </button>
          )}
        </div>
        <div className="chip-row inv-chips" role="group" aria-label={t("inv.category")}>
          <button className={`chip ${cats.length === 0 ? "active" : ""}`} aria-pressed={cats.length === 0} onClick={() => setCats([])}>{t("all")}</button>
          {CATEGORIES.map((c) => (
            <button key={c} className={`chip ${cats.includes(c) ? "active" : ""}`} aria-pressed={cats.includes(c)} onClick={() => toggle(c)}>
              {t(`inv.cat.${c}` as TKey)}
            </button>
          ))}
        </div>
      </section>

      <section className="card">
        {rows === null ? (
          <p className="muted pad">{t("loading")}</p>
        ) : rows.length === 0 ? (
          <div className="empty-state">
            <Icon name="box" size={32} />
            <p className="muted">{search || cats.length || filter !== "all" ? t("inv.noMatch") : t("inv.noItems")}</p>
          </div>
        ) : (
          <div className="table-wrap">
            <table className="inv-table">
              <thead>
                <tr>
                  <th>{t("inv.code")}</th>
                  <th>{t("inv.item")}</th>
                  <th>{t("inv.category")}</th>
                  <th className="num">{t("inv.onHand")}</th>
                  <th className="num">{t("inv.reorderLevel")}</th>
                  <th>{t("inv.nextExpiry")}</th>
                  {showMoney && <th className="num">{t("inv.stockValue")}</th>}
                  <th>{t("inv.supplier")}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((item, i) => (
                  <tr key={item.id} className={`row-link ${item.is_active ? "" : "is-inactive"}`} style={{ "--i": Math.min(i, 12) } as CSSProperties} onClick={() => setViewing(item)}>
                    <td className="mono small">{item.code || "—"}</td>
                    <td>
                      <button className="link-button row-main" onClick={(e) => { e.stopPropagation(); setViewing(item); }}>{itemName(item, lang)}</button>
                      {item.category === "implant" && (item.brand || item.diameter) && (
                        <span className="block muted small">{[item.brand, item.system, item.diameter && `Ø${Number(item.diameter)}`, item.length && `${Number(item.length)} mm`].filter(Boolean).join(" · ")}</span>
                      )}
                      {!item.is_active && <span className="pill pill-muted tiny">{t("inactive")}</span>}
                    </td>
                    <td><span className={`cat-dot cat-${item.category}`} aria-hidden="true" />{t(`inv.cat.${item.category}` as TKey)}</td>
                    <td className={`num ${Number(item.on_hand) <= 0 ? "muted" : "strong"}`}>
                      {fmtQty(item.on_hand, lang)} <span className="muted small">{unit(item.unit)}</span>
                    </td>
                    <td className="num">
                      {Number(item.reorder_level) > 0 ? fmtQty(item.reorder_level, lang) : <span className="muted">—</span>}
                      {item.is_low && <span className="pill pill-warn tiny">{t("inv.low")}</span>}
                    </td>
                    <td><Expiry date={item.next_expiry} /></td>
                    {showMoney && <td className="num">{money(item.stock_value, lang)}</td>}
                    <td className="small">{item.preferred_supplier_name || <span className="muted">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {viewing && <ItemView key={viewing.id} initial={viewing} branches={branches} onClose={() => setViewing(null)} onChanged={bump} onReorder={onReorder} />}
      {adding && (
        <ItemDialog
          item={null}
          onClose={() => setAdding(false)}
          onSaved={(item) => {
            setAdding(false);
            bump();
            setViewing(item);
          }}
        />
      )}
    </>
  );
}

/* ----------------------------------------------------- purchase orders */

type OrderFilter = "all" | POStatus | "open";

function Orders({ branch, version, onOpenPo, onNew }: Shared & { onNew: () => void }) {
  const { t, lang } = useI18n();
  const { can } = useAuth();
  const [filter, setFilter] = useState<OrderFilter>("all");
  const [search, setSearch] = useState("");
  const [rows, setRows] = useState<PurchaseOrder[] | null>(null);
  const [counts, setCounts] = useState<Record<string, number>>({});

  const load = useCallback(() => {
    const q = new URLSearchParams();
    if (filter === "open") q.set("open", "1");
    else if (filter !== "all") q.set("status", filter);
    if (search.trim()) q.set("search", search.trim());
    if (branch) q.set("branch", String(branch));
    get<Page<PurchaseOrder>>(`/api/inventory/purchase-orders/?${q}`).then((p) => setRows(p.results)).catch(() => setRows([]));
  }, [filter, search, branch]);
  useEffect(() => {
    const timer = window.setTimeout(load, search ? 250 : 0);
    return () => window.clearTimeout(timer);
  }, [load, search, version]);
  useEffect(() => {
    get<InventorySummary>(`/api/inventory/summary/${branchQuery(branch, "?")}`)
      .then((s) => setCounts({ draft: s.draft_orders, open: s.open_orders }))
      .catch(() => undefined);
  }, [branch, version]);

  const filters: { id: OrderFilter; label: TKey }[] = [
    { id: "all", label: "all" },
    { id: "draft", label: "inv.po.draft" },
    { id: "open", label: "inv.po.open" },
    { id: "received", label: "inv.po.received" },
    { id: "cancelled", label: "inv.po.cancelled" },
  ];

  return (
    <>
      <section className="card pad toolbar lab-bar">
        <div className="chip-row" role="group" aria-label={t("inv.show")}>
          {filters.map((f) => (
            <button key={f.id} className={`chip ${filter === f.id ? "active" : ""}`} aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>
              {t(f.label)}
              {counts[f.id] !== undefined && <span className="chip-count">{counts[f.id]}</span>}
            </button>
          ))}
        </div>
        <div className="toolbar grow-end">
          <label className="top-search search-field">
            <Icon name="search" />
            <input type="search" aria-label={t("search")} placeholder={t("inv.searchPo")} value={search} onChange={(e) => setSearch(e.target.value)} />
          </label>
          {can("inventory", "create") && (
            <button className="btn btn-primary" onClick={onNew}>
              <Icon name="plus" size={18} /> {t("inv.newPo")}
            </button>
          )}
        </div>
      </section>
      <section className="card">
        {rows === null ? (
          <p className="muted pad">{t("loading")}</p>
        ) : rows.length === 0 ? (
          <div className="empty-state">
            <Icon name="receipt" size={32} />
            <p className="muted">{t("inv.noOrders")}</p>
          </div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{t("inv.poNumber")}</th>
                  <th>{t("inv.supplier")}</th>
                  <th>{t("ap.branch")}</th>
                  <th>{t("plan.status")}</th>
                  <th>{t("inv.expected")}</th>
                  <th className="num">{t("inv.lines")}</th>
                  <th className="num">{t("bill.total")}</th>
                  <th>{t("inv.created")}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((po) => (
                  <tr key={po.id} className="row-link" onClick={() => onOpenPo(po)}>
                    <td className="mono small">{po.number}</td>
                    <td className="strong">{po.supplier_name}</td>
                    <td>{personName(po.branch_name, lang)}</td>
                    <td><span className={PO_PILL[po.status]}>{t(`inv.po.${po.status}` as TKey)}</span></td>
                    <td className="nowrap">{po.expected_date ? fmtDate(po.expected_date, lang) : <span className="muted">—</span>}</td>
                    <td className="num">{po.lines.length}</td>
                    <td className="num strong">{money(po.total, lang)}</td>
                    <td className="nowrap muted">{fmtDate(po.created_at.slice(0, 10), lang)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

/* ----------------------------------------------------------- suppliers */

function Suppliers() {
  const { t } = useI18n();
  const { can } = useAuth();
  const [rows, setRows] = useState<Supplier[] | null>(null);
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<{ row: Supplier | null } | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(() => {
    getAll<Supplier>(`/api/inventory/suppliers/${search.trim() ? `?search=${encodeURIComponent(search.trim())}` : ""}`)
      .then(setRows)
      .catch((err) => setError(errorText(err)));
  }, [search]);
  useEffect(() => {
    const timer = window.setTimeout(load, search ? 250 : 0);
    return () => window.clearTimeout(timer);
  }, [load, search]);

  const fields: FieldDef[] = [
    { name: "name", label: "inv.supplierName", required: true },
    { name: "contact_person", label: "inv.contactPerson" },
    { name: "phone", label: "pt.mobile", dir: "ltr" },
    { name: "whatsapp", label: "inv.whatsapp", dir: "ltr" },
    { name: "email", label: "inv.email", type: "email", dir: "ltr" },
    { name: "payment_terms", label: "inv.paymentTerms" },
    { name: "address", label: "inv.address" },
    { name: "notes", label: "notes", type: "textarea" },
    { name: "is_active", label: "active", type: "checkbox" },
  ];
  const save = async (values: Record<string, unknown>) => {
    if (editing?.row) await patch(`/api/inventory/suppliers/${editing.row.id}/`, values);
    else await post("/api/inventory/suppliers/", values);
    setEditing(null);
    load();
  };
  const remove = async (row: Supplier) => {
    if (!window.confirm(t("confirmDelete"))) return;
    setError("");
    try {
      await del(`/api/inventory/suppliers/${row.id}/`);
      load();
    } catch (err) {
      setError(errorText(err));
    }
  };
  const canEdit = can("inventory", "edit");
  const canDelete = can("inventory", "delete");

  return (
    <section className="card">
      <header className="card-head">
        <label className="top-search search-field">
          <Icon name="search" />
          <input type="search" aria-label={t("search")} placeholder={t("inv.searchSuppliers")} value={search} onChange={(e) => setSearch(e.target.value)} />
        </label>
        {canEdit && (
          <button className="btn btn-primary" onClick={() => setEditing({ row: null })}>
            <Icon name="plus" size={18} /> {t("inv.newSupplier")}
          </button>
        )}
      </header>
      {error && <p className="form-error" role="alert">{error}</p>}
      {rows === null ? (
        <p className="muted pad">{t("loading")}</p>
      ) : rows.length === 0 ? (
        <p className="muted pad">{t("noRecords")}</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{t("inv.supplierName")}</th>
                <th>{t("inv.contactPerson")}</th>
                <th>{t("pt.mobile")}</th>
                <th>{t("inv.paymentTerms")}</th>
                <th>{t("plan.status")}</th>
                {(canEdit || canDelete) && <th className="cell-actions">{t("actions")}</th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => (
                <tr key={s.id}>
                  <td>
                    <span className="strong">{s.name}</span>
                    {s.email && <span className="block muted small" dir="ltr">{s.email}</span>}
                  </td>
                  <td>{s.contact_person || <span className="muted">—</span>}</td>
                  <td className="nowrap">
                    {s.phone ? <a href={`tel:${s.phone}`} dir="ltr">{s.phone}</a> : <span className="muted">—</span>}
                    {s.whatsapp && (
                      <a className="pill pill-mint tiny" href={`https://wa.me/${s.whatsapp.replace(/\D/g, "")}`} target="_blank" rel="noreferrer">WhatsApp</a>
                    )}
                  </td>
                  <td className="small">{s.payment_terms || <span className="muted">—</span>}</td>
                  <td><ActiveBadge value={s.is_active} /></td>
                  {(canEdit || canDelete) && (
                    <td className="cell-actions">
                      {canEdit && <button className="btn btn-small" onClick={() => setEditing({ row: s })}>{t("edit")}</button>}
                      {canDelete && <button className="btn btn-small btn-danger" onClick={() => void remove(s)}>{t("delete")}</button>}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing && (
        <Modal title={editing.row ? t("inv.editSupplier") : t("inv.newSupplier")} onClose={() => setEditing(null)}>
          <RecordForm fields={fields} isNew={!editing.row} initial={editing.row ? { ...editing.row } : { is_active: true }} onSubmit={save} onCancel={() => setEditing(null)} />
        </Modal>
      )}
    </section>
  );
}

/* ----------------------------------------------------------- movements */

function ItemPicker({ value, onChange, label }: { value: { id: number; label: string } | null; onChange: (v: { id: number; label: string } | null) => void; label: string }) {
  const { t, lang } = useI18n();
  const [search, setSearch] = useState("");
  const [results, setResults] = useState<StockItem[]>([]);
  useEffect(() => {
    if (!search.trim()) return setResults([]);
    const timer = window.setTimeout(() => {
      get<Page<StockItem>>(`/api/inventory/items/?search=${encodeURIComponent(search.trim())}`)
        .then((p) => setResults(p.results.slice(0, 8)))
        .catch(() => setResults([]));
    }, 250);
    return () => window.clearTimeout(timer);
  }, [search]);
  if (value)
    return (
      <span className="picked-chip">
        <span className="muted small">{label}:</span> <strong>{value.label}</strong>
        <button type="button" className="side-icon-btn" aria-label={t("inv.clear")} onClick={() => onChange(null)}>
          <Icon name="close" size={14} />
        </button>
      </span>
    );
  return (
    <div className="item-picker">
      <label className="top-search">
        <Icon name="search" />
        <input type="search" aria-label={label} placeholder={t("inv.searchItems")} value={search} onChange={(e) => setSearch(e.target.value)} />
      </label>
      {results.length > 0 && (
        <ul className="picker-results picker-float">
          {results.map((i) => (
            <li key={i.id}>
              <button
                type="button"
                onClick={() => {
                  onChange({ id: i.id, label: itemName(i, lang) });
                  setSearch("");
                }}
              >
                <strong>{itemName(i, lang)}</strong> {i.code && <span className="muted mono small">{i.code}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Movements({ branch, version }: { branch: number | ""; version: number }) {
  const { t, lang } = useI18n();
  const showMoney = useMoneyAccess();
  const unit = useUnit();
  const [kind, setKind] = useState<MovementKind | "">("");
  const [item, setItem] = useState<{ id: number; label: string } | null>(null);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [rows, setRows] = useState<StockMovement[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [count, setCount] = useState(0);

  const query = useMemo(() => {
    const q = new URLSearchParams();
    if (kind) q.set("kind", kind);
    if (item) q.set("item", String(item.id));
    if (from) q.set("from", from);
    if (to) q.set("to", to);
    if (branch) q.set("branch", String(branch));
    return q.toString();
  }, [kind, item, from, to, branch]);
  useEffect(() => {
    setRows(null);
    get<Page<StockMovement>>(`/api/inventory/movements/?${query}`)
      .then((p) => {
        setRows(p.results);
        setNext(p.next);
        setCount(p.count);
      })
      .catch(() => setRows([]));
  }, [query, version]);
  const more = () => {
    if (!next) return;
    const url = new URL(next);
    get<Page<StockMovement>>(url.pathname + url.search).then((p) => {
      setRows((r) => [...(r ?? []), ...p.results]);
      setNext(p.next);
    });
  };

  return (
    <>
      <section className="card pad toolbar inv-move-bar">
        <label className="field inline">
          <span>{t("inv.kind")}</span>
          <select value={kind} onChange={(e) => setKind(e.target.value as MovementKind | "")}>
            <option value="">{t("all")}</option>
            {KINDS.map((k) => <option key={k} value={k}>{t(`inv.kind.${k}` as TKey)}</option>)}
          </select>
        </label>
        <ItemPicker value={item} onChange={setItem} label={t("inv.item")} />
        <label className="field inline">
          <span>{t("com.from")}</span>
          <input type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label className="field inline">
          <span>{t("com.to")}</span>
          <input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} />
        </label>
        {(kind || item || from || to) && (
          <button className="btn btn-small" onClick={() => { setKind(""); setItem(null); setFrom(""); setTo(""); }}>{t("inv.clear")}</button>
        )}
      </section>
      <section className="card">
        {rows === null ? (
          <p className="muted pad">{t("loading")}</p>
        ) : rows.length === 0 ? (
          <div className="empty-state">
            <Icon name="history" size={32} />
            <p className="muted">{t("inv.noMoves")}</p>
          </div>
        ) : (
          <>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>{t("note.date")}</th>
                    <th>{t("inv.kind")}</th>
                    <th>{t("inv.item")}</th>
                    <th>{t("inv.lot")}</th>
                    <th className="num">{t("inv.qty")}</th>
                    <th className="num">{t("inv.balance")}</th>
                    {showMoney && <th className="num">{t("inv.value")}</th>}
                    <th>{t("ap.branch")}</th>
                    <th>{t("inv.reference")}</th>
                    <th>{t("inv.by")}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((m) => (
                    <tr key={m.id}>
                      <td className="nowrap small">{new Date(m.created_at).toLocaleString(locale(lang), { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</td>
                      <td><span className={KIND_PILL[m.kind]}>{t(`inv.kind.${m.kind}` as TKey)}</span></td>
                      <td>{itemName(m.item_info, lang)}</td>
                      <td className="mono small">{m.lot_number || <span className="muted">—</span>}</td>
                      <td className={`num strong ${Number(m.quantity) > 0 ? "qty-in" : ""}`}>
                        {signed(m.quantity, lang)} <span className="muted small">{unit(m.item_info.unit)}</span>
                      </td>
                      <td className="num">{fmtQty(m.balance_after, lang)}</td>
                      {showMoney && <td className="num">{money(Math.abs(Number(m.value)), lang)}</td>}
                      <td className="small">{personName(m.branch_name, lang)}</td>
                      <td className="small">
                        {m.patient_info ? <PatientLink p={m.patient_info} /> : moveRef(m, lang, t) || <span className="muted">—</span>}
                        {m.patient_info && (m.lab_case_number || m.purchase_order) && <span className="muted"> · {m.lab_case_number || m.purchase_order}</span>}
                        {m.note && (m.patient_info || m.purchase_order || m.other_branch_name) && !(m.purchase_order && m.note.includes(m.purchase_order)) && <span className="block muted">{m.note}</span>}
                      </td>
                      <td className="small muted">{m.by || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="pad table-foot">
              <span className="muted small">{t("inv.showingOf", { n: rows.length, total: count })}</span>
              {next && <button className="btn btn-small" onClick={more}>{t("inv.loadMore")}</button>}
            </div>
          </>
        )}
      </section>
    </>
  );
}

/* ------------------------------------------------------- implant trace */

function Trace() {
  const { t, lang, name } = useI18n();
  const { can } = useAuth();
  const [mode, setMode] = useState<"lot" | "patient">("lot");
  const [lot, setLot] = useState("");
  const [patient, setPatient] = useState<{ id: number; label: string } | null>(null);
  const [search, setSearch] = useState("");
  const [found, setFound] = useState<Patient[]>([]);
  const [result, setResult] = useState<ImplantTrace | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (mode !== "patient" || !search.trim() || !can("patients")) return setFound([]);
    const timer = window.setTimeout(() => {
      get<Page<Patient>>(`/api/patients/?search=${encodeURIComponent(search.trim())}`)
        .then((p) => setFound(p.results.slice(0, 8)))
        .catch(() => setFound([]));
    }, 250);
    return () => window.clearTimeout(timer);
  }, [search, mode, can]);

  const run = async (query: string) => {
    setBusy(true);
    setError("");
    try {
      setResult(await get<ImplantTrace>(`/api/inventory/implant-trace/?${query}`));
    } catch (err) {
      setError(errorText(err));
      setResult(null);
    } finally {
      setBusy(false);
    }
  };
  const byLot = (e: FormEvent) => {
    e.preventDefault();
    if (lot.trim()) void run(`lot=${encodeURIComponent(lot.trim())}`);
  };
  const pick = (p: Patient) => {
    setPatient({ id: p.id, label: `${patientName(p, lang)} · ${p.file_number}` });
    setSearch("");
    setFound([]);
    void run(`patient=${p.id}`);
  };
  const switchMode = (m: "lot" | "patient") => {
    setMode(m);
    setResult(null);
    setError("");
  };

  return (
    <>
      <section className="card pad inv-trace">
        <div>
          <h2>{t("inv.traceTitle")}</h2>
          <p className="muted small">{t("inv.traceHint")}</p>
        </div>
        <div className="segmented" role="group" aria-label={t("inv.traceBy")}>
          <button aria-pressed={mode === "lot"} onClick={() => switchMode("lot")}>{t("inv.byLot")}</button>
          {can("patients") && <button aria-pressed={mode === "patient"} onClick={() => switchMode("patient")}>{t("inv.byPatient")}</button>}
        </div>
        {mode === "lot" ? (
          <form className="inline-form" onSubmit={byLot}>
            <input dir="ltr" aria-label={t("inv.lotNumber")} placeholder={t("inv.lotPh")} value={lot} onChange={(e) => setLot(e.target.value)} />
            <button type="submit" className="btn btn-primary" disabled={busy || !lot.trim()}>
              <Icon name="search" size={18} /> {t("inv.trace")}
            </button>
          </form>
        ) : patient ? (
          <div className="picked">
            <span className="muted">{t("ap.patient")}:</span> <strong>{patient.label}</strong>
            <button type="button" className="btn btn-small" onClick={() => { setPatient(null); setResult(null); }}>{t("ap.change")}</button>
          </div>
        ) : (
          <div className="field">
            <input type="search" autoFocus aria-label={t("ap.patient")} placeholder={t("pt.searchHint")} value={search} onChange={(e) => setSearch(e.target.value)} />
            {found.length > 0 && (
              <ul className="picker-results">
                {found.map((p) => (
                  <li key={p.id}>
                    <button type="button" onClick={() => pick(p)}>
                      <strong>{patientName(p, lang)}</strong> <span className="muted num">{p.file_number}</span> <span className="muted" dir="ltr">{p.phone}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        {error && <p className="form-error" role="alert">{error}</p>}
      </section>
      {result && (
        <section className="card">
          <header className="card-head">
            <h2>{t("inv.traceFound", { n: result.count, p: result.patients })}</h2>
          </header>
          {result.results.length === 0 ? (
            <p className="muted pad">{t("inv.traceNone")}</p>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>{t("note.date")}</th>
                    <th>{t("cl.patient")}</th>
                    <th>{t("inv.item")}</th>
                    <th>{t("inv.lot")}</th>
                    <th>{t("inv.expiry")}</th>
                    <th className="num">{t("inv.qty")}</th>
                    <th>{t("inv.procedure")}</th>
                    <th>{t("inv.dentist")}</th>
                    <th>{t("ap.branch")}</th>
                  </tr>
                </thead>
                <tbody>
                  {result.results.map((r) => (
                    <tr key={r.id}>
                      <td className="nowrap">{fmtDate(r.used_at.slice(0, 10), lang)}</td>
                      <td><PatientLink p={r.patient} /></td>
                      <td>
                        {itemName(r.item, lang)}
                        {(r.item.brand || r.item.diameter) && (
                          <span className="block muted small">{[r.item.brand, r.item.system, r.item.diameter && `Ø${Number(r.item.diameter)}`, r.item.length && `${Number(r.item.length)} mm`].filter(Boolean).join(" · ")}</span>
                        )}
                      </td>
                      <td className="mono small">{r.lot_number || "—"}</td>
                      <td><Expiry date={r.expiry_date} /></td>
                      <td className="num">{fmtQty(r.quantity, lang)}</td>
                      <td>
                        {r.procedure ? personName(r.procedure, lang) : r.lab_case || "—"}
                        {r.tooth ? <span className="muted small"> · {t("tooth.label", { n: String(r.tooth) })}</span> : null}
                      </td>
                      <td className="small">{r.dentist ? personName(r.dentist, lang) : "—"}</td>
                      <td className="small">{name({ name_en: r.branch.en, name_ar: r.branch.ar })}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </>
  );
}

/* ------------------------------------------------- procedure materials */

function Materials() {
  const { t, lang, name } = useI18n();
  const { can } = useAuth();
  const showMoney = useMoneyAccess();
  const unit = useUnit();
  const [procedures, setProcedures] = useState<Procedure[] | null>(null);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Procedure | null>(null);
  const [rows, setRows] = useState<ProcedureMaterial[] | null>(null);
  const [items, setItems] = useState<StockItem[]>([]);
  const [counts, setCounts] = useState<Record<number, number>>({});
  const [adding, setAdding] = useState({ item: "", quantity: "1" });
  const [error, setError] = useState("");
  const editable = can("inventory", "edit");

  useEffect(() => {
    getAll<Procedure>("/api/masterdata/procedures/?is_active=true").then(setProcedures).catch(() => setProcedures([]));
    getAll<StockItem>("/api/inventory/items/?active=1").then(setItems).catch(() => undefined);
    getAll<ProcedureMaterial>("/api/inventory/procedure-materials/")
      .then((all) => setCounts(all.reduce<Record<number, number>>((acc, m) => ({ ...acc, [m.procedure]: (acc[m.procedure] ?? 0) + 1 }), {})))
      .catch(() => undefined);
  }, []);
  const load = useCallback(() => {
    if (!selected) return;
    getAll<ProcedureMaterial>(`/api/inventory/procedure-materials/?procedure=${selected.id}`)
      .then((list) => {
        setRows(list);
        setCounts((c) => ({ ...c, [selected.id]: list.length }));
      })
      .catch(() => setRows([]));
  }, [selected]);
  useEffect(() => {
    setRows(null);
    setError("");
    load();
  }, [load]);

  const shown = (procedures ?? []).filter((p) => {
    const q = search.trim().toLowerCase();
    return !q || p.code.toLowerCase().includes(q) || p.name_en.toLowerCase().includes(q) || p.name_ar.includes(q);
  });
  const cost = (rows ?? []).reduce((sum, m) => sum + Number(m.quantity) * Number(items.find((i) => i.id === m.item)?.last_cost ?? 0), 0);
  const listed = new Set((rows ?? []).map((m) => m.item));

  const add = async (e: FormEvent) => {
    e.preventDefault();
    if (!selected || !adding.item) return;
    setError("");
    try {
      await post("/api/inventory/procedure-materials/", { procedure: selected.id, item: Number(adding.item), quantity: adding.quantity });
      setAdding({ item: "", quantity: "1" });
      load();
    } catch (err) {
      setError(errorText(err));
    }
  };
  const change = async (m: ProcedureMaterial, quantity: string) => {
    if (!quantity || Number(quantity) === Number(m.quantity)) return;
    setError("");
    try {
      await patch(`/api/inventory/procedure-materials/${m.id}/`, { quantity });
      load();
    } catch (err) {
      setError(errorText(err));
    }
  };
  const remove = async (m: ProcedureMaterial) => {
    setError("");
    try {
      await del(`/api/inventory/procedure-materials/${m.id}/`);
      load();
    } catch (err) {
      setError(errorText(err));
    }
  };

  return (
    <div className="inv-split">
      <section className="card inv-proc-list">
        <header className="card-head">
          <label className="top-search search-field">
            <Icon name="search" />
            <input type="search" aria-label={t("search")} placeholder={t("inv.searchProcedures")} value={search} onChange={(e) => setSearch(e.target.value)} />
          </label>
        </header>
        {procedures === null ? (
          <p className="muted pad">{t("loading")}</p>
        ) : shown.length === 0 ? (
          <p className="muted pad">{t("noRecords")}</p>
        ) : (
          <ul className="plain-list proc-pick">
            {shown.map((p) => (
              <li key={p.id}>
                <button className={selected?.id === p.id ? "active" : ""} aria-pressed={selected?.id === p.id} onClick={() => setSelected(p)}>
                  <span className="grow">
                    <span className="block">{name(p)}</span>
                    <span className="muted small mono">{p.code}</span>
                  </span>
                  {counts[p.id] ? <span className="chip-count">{counts[p.id]}</span> : null}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="card inv-proc-detail">
        {!selected ? (
          <div className="empty-state">
            <Icon name="list" size={32} />
            <p className="muted">{t("inv.pickProcedure")}</p>
          </div>
        ) : (
          <>
            <header className="card-head">
              <div>
                <h2>{name(selected)}</h2>
                <p className="muted small">{t("inv.materialsHint")}</p>
              </div>
              {showMoney && rows && rows.length > 0 && (
                <div className="cost-total">
                  <span className="muted small">{t("inv.materialCost")}</span>
                  <strong className="num">{money(cost, lang)}</strong>
                </div>
              )}
            </header>
            {rows === null ? (
              <p className="muted pad">{t("loading")}</p>
            ) : rows.length === 0 ? (
              <p className="muted pad">{t("inv.noMaterials")}</p>
            ) : (
              <ul className="plain-list mat-list">
                {rows.map((m, i) => (
                  <li key={m.id} style={{ "--i": i } as CSSProperties}>
                    <span className="grow">
                      <span className="block">{itemName(m.item_info, lang)}</span>
                      <span className="muted small">{t(`inv.cat.${m.item_info.category}` as TKey)}</span>
                    </span>
                    {editable ? (
                      <label className="mat-qty">
                        <input
                          type="number"
                          dir="ltr"
                          step="0.001"
                          min="0.001"
                          aria-label={t("inv.qty")}
                          defaultValue={Number(m.quantity)}
                          onBlur={(e) => void change(m, e.target.value)}
                        />
                        <span className="muted small">{unit(m.item_info.unit)}</span>
                      </label>
                    ) : (
                      <span className="num strong">{fmtQty(m.quantity, lang)} <span className="muted small">{unit(m.item_info.unit)}</span></span>
                    )}
                    {editable && (
                      <button className="btn btn-icon btn-small" aria-label={t("inv.removeLine")} title={t("inv.removeLine")} onClick={() => void remove(m)}>
                        <Icon name="close" size={16} />
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {editable && (
              <form className="mat-add pad" onSubmit={add}>
                <select aria-label={t("inv.item")} required value={adding.item} onChange={(e) => setAdding((a) => ({ ...a, item: e.target.value }))}>
                  <option value="">{t("inv.pickItem")}</option>
                  {items.filter((i) => !listed.has(i.id)).map((i) => (
                    <option key={i.id} value={i.id}>{itemName(i, lang)}{i.code ? ` · ${i.code}` : ""}</option>
                  ))}
                </select>
                <input type="number" dir="ltr" step="0.001" min="0.001" required aria-label={t("inv.qty")} value={adding.quantity} onChange={(e) => setAdding((a) => ({ ...a, quantity: e.target.value }))} />
                <button type="submit" className="btn btn-primary">
                  <Icon name="plus" size={16} /> {t("add")}
                </button>
              </form>
            )}
            {error && <p className="form-error" role="alert">{error}</p>}
          </>
        )}
      </section>
    </div>
  );
}
