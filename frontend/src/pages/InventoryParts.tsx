import { useCallback, useEffect, useMemo, useState, type CSSProperties, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { ApiError, del, get, getAll, patch, post, type Page } from "../api";
import { useAuth } from "../auth";
import { useI18n, type TKey } from "../i18n";
import { Field, Modal, type FieldDef } from "../components/Crud";
import { Icon } from "../components/Icon";
import { escapeHtml, printDocument, useLetterhead } from "../components/print";
import { fmtDate, locale, money } from "../format";
import type { Branch, ItemCategory, MovementKind, POStatus, PurchaseOrder, StockItem, StockLot, StockMovement, Supplier } from "../types";
import { errorText, personName, useCurrency } from "./BillingParts";

// Inventory and purchasing (phase 5): shared pieces for the Inventory page.
// Item, adjust, transfer and purchase order dialogs, labels and formatting.

export const CATEGORIES: ItemCategory[] = ["consumable", "material", "implant", "instrument", "medicine", "lab_material", "office", "other"];
export const UNITS = ["piece", "box", "pack", "ml", "g", "cartridge", "syringe", "capsule", "tube", "bottle", "roll", "pair", "disc", "block"];
export const KINDS: MovementKind[] = ["receive", "use", "adjust", "transfer_out", "transfer_in", "return_to_supplier", "waste"];
export const PO_STATUSES: POStatus[] = ["draft", "ordered", "partially_received", "received", "cancelled"];
const LOT_CATEGORIES: ItemCategory[] = ["implant", "medicine"];

export const PO_PILL: Record<POStatus, string> = {
  draft: "pill pill-outline",
  ordered: "pill pill-ok",
  partially_received: "pill pill-ready",
  received: "pill pill-mint",
  cancelled: "pill pill-muted",
};

export const KIND_PILL: Record<MovementKind, string> = {
  receive: "pill pill-mint",
  use: "pill pill-ok",
  adjust: "pill pill-outline",
  transfer_out: "pill",
  transfer_in: "pill",
  return_to_supplier: "pill pill-muted",
  waste: "pill pill-warn",
};

export function isoToday() {
  return new Date().toLocaleDateString("en-CA");
}

export function daysUntil(iso: string) {
  const day = new Date(`${iso}T12:00:00`).getTime();
  const now = new Date(`${isoToday()}T12:00:00`).getTime();
  return Math.round((day - now) / 86_400_000);
}

export function fmtQty(value: string | number, lang: string) {
  return Number(value).toLocaleString(locale(lang), { maximumFractionDigits: 3 });
}

/** Item name in the reader's language, from either an item or an item_info. */
export function itemName(i: { en?: string; ar?: string; name_en?: string; name_ar?: string }, lang: string) {
  const en = i.name_en ?? i.en ?? "";
  const ar = i.name_ar ?? i.ar ?? "";
  return lang === "ar" ? ar || en : en || ar;
}

export function useUnit() {
  const { t } = useI18n();
  return useCallback((unit: string) => (UNITS.includes(unit) ? t(`inv.unit.${unit}` as TKey) : unit), [t]);
}

/** Roles that see costs: those who approve purchases or maintain the catalogue. */
export function useMoneyAccess() {
  const { can } = useAuth();
  return can("inventory", "approve") || can("inventory", "edit");
}

export function useBranches() {
  const [rows, setRows] = useState<Branch[]>([]);
  useEffect(() => {
    getAll<Branch>("/api/masterdata/branches/?is_active=true").then(setRows).catch(() => undefined);
  }, []);
  return rows;
}

export function useSuppliers(activeOnly = true) {
  const [rows, setRows] = useState<Supplier[]>([]);
  useEffect(() => {
    getAll<Supplier>(`/api/inventory/suppliers/${activeOnly ? "?active=1" : ""}`).then(setRows).catch(() => undefined);
  }, [activeOnly]);
  return rows;
}

/** Expiry date with a badge: expired and soon-expiring lots in the warning colours. */
export function Expiry({ date, days }: { date: string | null; days?: number | null }) {
  const { t, lang } = useI18n();
  if (!date) return <span className="muted">—</span>;
  const d = days ?? daysUntil(date);
  return (
    <span className="expiry">
      <span className="nowrap">{fmtDate(date, lang)}</span>
      {d < 0 ? (
        <span className="pill pill-warn tiny exp-expired">{t("inv.expired")}</span>
      ) : d <= 30 ? (
        <span className="pill pill-warn tiny">{t("inv.inDays", { n: d })}</span>
      ) : d <= 90 ? (
        <span className="pill pill-ready tiny">{t("inv.inDays", { n: d })}</span>
      ) : null}
    </span>
  );
}

/* ------------------------------------------------------------ item form */

type ItemValues = Record<string, unknown>;

const ITEM_DEFAULTS: ItemValues = {
  code: "",
  name_en: "",
  name_ar: "",
  category: "consumable",
  unit: "piece",
  units_per_pack: 1,
  preferred_supplier: null,
  last_cost: "0",
  reorder_level: "0",
  reorder_quantity: "0",
  tracks_lots: false,
  is_active: true,
  notes: "",
  brand: "",
  system: "",
  diameter: "",
  length: "",
};

export function ItemDialog({ item, onClose, onSaved }: { item: StockItem | null; onClose: () => void; onSaved: (item: StockItem) => void }) {
  const { t } = useI18n();
  const suppliers = useSuppliers();
  const unit = useUnit();
  const [values, setValues] = useState<ItemValues>(() =>
    item ? { ...ITEM_DEFAULTS, ...item, diameter: item.diameter ?? "", length: item.length ?? "" } : { ...ITEM_DEFAULTS },
  );
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const implant = values.category === "implant";

  const fields: FieldDef[] = [
    { name: "name_en", label: "nameEn", required: true, dir: "ltr" },
    { name: "name_ar", label: "nameAr", required: true, dir: "rtl" },
    { name: "code", label: "inv.code", dir: "ltr" },
    { name: "category", label: "inv.category", type: "select", required: true, options: CATEGORIES.map((c) => ({ value: c, label: t(`inv.cat.${c}` as TKey) })) },
    { name: "unit", label: "inv.unit", type: "select", required: true, options: UNITS.map((u) => ({ value: u, label: unit(u) })) },
    { name: "units_per_pack", label: "inv.unitsPerPack", type: "number", step: "1" },
    { name: "preferred_supplier", label: "inv.supplier", type: "select", options: suppliers.map((s) => ({ value: s.id, label: s.name })) },
    { name: "last_cost", label: "inv.lastCost", type: "number", step: "0.01", dir: "ltr" },
    { name: "reorder_level", label: "inv.reorderLevel", type: "number", step: "0.001", hint: "inv.reorderLevelHint", dir: "ltr" },
    { name: "reorder_quantity", label: "inv.reorderQty", type: "number", step: "0.001", hint: "inv.reorderQtyHint", dir: "ltr" },
  ];
  const implantFields: FieldDef[] = [
    { name: "brand", label: "inv.brand" },
    { name: "system", label: "inv.system" },
    { name: "diameter", label: "inv.diameter", type: "number", step: "0.01", dir: "ltr" },
    { name: "length", label: "inv.length", type: "number", step: "0.1", dir: "ltr" },
  ];

  const set = (name: string, value: unknown) =>
    setValues((s) => {
      const next = { ...s, [name]: value };
      // New items in lot-tracked categories track lots by default.
      if (name === "category" && !item) next.tracks_lots = LOT_CATEGORIES.includes(value as ItemCategory);
      return next;
    });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErrors({});
    setMessage("");
    const body: ItemValues = { ...values };
    for (const key of ["category_label", "unit_label", "preferred_supplier_name", "on_hand", "stock_value", "is_low", "next_expiry", "stock", "created_at", "id"]) delete body[key];
    body.preferred_supplier = values.preferred_supplier ? Number(values.preferred_supplier) : null;
    body.units_per_pack = Math.max(1, Number(values.units_per_pack) || 1);
    for (const key of ["last_cost", "reorder_level", "reorder_quantity"]) body[key] = values[key] === "" ? "0" : values[key];
    if (implant) {
      body.diameter = values.diameter === "" ? null : values.diameter;
      body.length = values.length === "" ? null : values.length;
    } else {
      Object.assign(body, { brand: "", system: "", diameter: null, length: null });
    }
    try {
      onSaved(item ? await patch<StockItem>(`/api/inventory/items/${item.id}/`, body) : await post<StockItem>("/api/inventory/items/", body));
    } catch (err) {
      if (err instanceof ApiError && Object.keys(err.fields).length) {
        setErrors(err.fields);
        const known = [...fields, ...implantFields].map((f) => f.name).concat(["tracks_lots", "is_active", "notes"]);
        if (!Object.keys(err.fields).every((f) => known.includes(f))) setMessage(errorText(err));
      } else setMessage(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={item ? t("inv.editItem") : t("inv.newItem")} onClose={onClose}>
      <form className="form-grid" onSubmit={submit}>
        <div className="form-grid form-grid-2">
          {fields.map((f) => (
            <Field key={f.name} field={f} value={values[f.name]} errors={errors[f.name]} onChange={(v) => set(f.name, v)} />
          ))}
        </div>
        {implant && (
          <fieldset className="subform inv-implant form-grid form-grid-2">
            <legend>{t("inv.implantSpecs")}</legend>
            {implantFields.map((f) => (
              <Field key={f.name} field={f} value={values[f.name]} errors={errors[f.name]} onChange={(v) => set(f.name, v)} />
            ))}
          </fieldset>
        )}
        <Field field={{ name: "notes", label: "notes" }} value={values.notes} errors={errors.notes} onChange={(v) => set("notes", v)} />
        <div className="checks-row">
          <Field field={{ name: "tracks_lots", label: "inv.tracksLots", type: "checkbox" }} value={values.tracks_lots} errors={errors.tracks_lots} onChange={(v) => set("tracks_lots", v)} />
          <Field field={{ name: "is_active", label: "active", type: "checkbox" }} value={values.is_active} errors={errors.is_active} onChange={(v) => set("is_active", v)} />
        </div>
        {message && <p className="form-error" role="alert">{message}</p>}
        <div className="form-actions">
          <button type="button" className="btn" onClick={onClose}>{t("cancel")}</button>
          <button type="submit" className="btn btn-primary" disabled={busy}>{t("save")}</button>
        </div>
      </form>
    </Modal>
  );
}

/* ------------------------------------------------------------ item view */

export function ItemView({
  initial,
  branches,
  onClose,
  onChanged,
  onReorder,
}: {
  initial: StockItem;
  branches: Branch[];
  onClose: () => void;
  onChanged: () => void;
  onReorder?: (item: StockItem) => void;
}) {
  const { t, lang, name } = useI18n();
  const { can } = useAuth();
  const showMoney = useMoneyAccess();
  const unit = useUnit();
  const [item, setItem] = useState(initial);
  const [lots, setLots] = useState<StockLot[] | null>(null);
  const [moves, setMoves] = useState<StockMovement[] | null>(null);
  const [dialog, setDialog] = useState<"edit" | "adjust" | "waste" | "transfer" | null>(null);

  const load = useCallback(() => {
    getAll<StockLot>(`/api/inventory/lots/?item=${initial.id}&in_stock=1`).then(setLots).catch(() => setLots([]));
    get<Page<StockMovement>>(`/api/inventory/movements/?item=${initial.id}`)
      .then((p) => setMoves(p.results.slice(0, 15)))
      .catch(() => setMoves([]));
    get<StockItem>(`/api/inventory/items/${initial.id}/`).then(setItem).catch(() => undefined);
  }, [initial.id]);
  useEffect(load, [load]);

  const done = () => {
    setDialog(null);
    load();
    onChanged();
  };
  const editable = can("inventory", "edit");
  const branchesWithStock = new Set(item.stock.filter((s) => Number(s.quantity) > 0).map((s) => s.branch.id));
  const specs = [item.brand, item.system, item.diameter && `Ø ${Number(item.diameter)}`, item.length && `${Number(item.length)} mm`].filter(Boolean).join(" · ");

  return (
    <Modal title={name(item)} onClose={onClose}>
      <div className="case-view inv-item-view">
        <div className="invoice-head">
          <div>
            <p className="small muted">
              {item.code && <span className="mono">{item.code} · </span>}
              {t(`inv.cat.${item.category}` as TKey)}
              {!item.is_active && <span className="pill pill-muted tiny">{t("inactive")}</span>}
            </p>
            {specs && <p className="small ink-2">{specs}</p>}
          </div>
          <div className="inv-onhand">
            <span className="overline">{t("inv.onHand")}</span>
            <strong>{fmtQty(item.on_hand, lang)}</strong>
            <span className="muted small">{unit(item.unit)}</span>
            {item.is_low && <span className="pill pill-warn tiny">{t("inv.low")}</span>}
          </div>
        </div>

        <div className="case-grid">
          <section>
            <h3 className="sub-head">{t("inv.byBranch")}</h3>
            {item.stock.length === 0 ? (
              <p className="muted small">{t("inv.noStock")}</p>
            ) : (
              <dl className="kv">
                {item.stock.map((s) => (
                  <div key={s.branch.id}>
                    <dt>{personName(s.branch, lang)}</dt>
                    <dd className="num">{fmtQty(s.quantity, lang)} {unit(item.unit)}</dd>
                  </div>
                ))}
              </dl>
            )}
          </section>
          <section>
            <h3 className="sub-head">{t("lab.details")}</h3>
            <dl className="kv">
              <div><dt>{t("inv.supplier")}</dt><dd>{item.preferred_supplier_name || "—"}</dd></div>
              <div><dt>{t("inv.reorderLevel")}</dt><dd className="num">{fmtQty(item.reorder_level, lang)}</dd></div>
              <div><dt>{t("inv.reorderQty")}</dt><dd className="num">{fmtQty(item.reorder_quantity, lang)}</dd></div>
              {showMoney && <div><dt>{t("inv.lastCost")}</dt><dd className="num">{money(item.last_cost, lang)}</dd></div>}
              {showMoney && <div><dt>{t("inv.stockValue")}</dt><dd className="num">{money(item.stock_value, lang)}</dd></div>}
              <div><dt>{t("inv.tracksLots")}</dt><dd>{item.tracks_lots ? t("yes") : t("no")}</dd></div>
            </dl>
          </section>
        </div>

        <section className="subsection">
          <h3 className="sub-head">{t("inv.lots")}</h3>
          {lots === null ? (
            <p className="muted small">{t("loading")}</p>
          ) : lots.length === 0 ? (
            <p className="muted small">{t("inv.noStock")}</p>
          ) : (
            <div className="table-wrap inset-table">
              <table>
                <thead>
                  <tr>
                    <th>{t("ap.branch")}</th>
                    {item.tracks_lots && <th>{t("inv.lot")}</th>}
                    <th>{t("inv.expiry")}</th>
                    <th className="num">{t("inv.qty")}</th>
                    {showMoney && <th className="num">{t("inv.value")}</th>}
                  </tr>
                </thead>
                <tbody>
                  {lots.map((l) => (
                    <tr key={l.id} className={l.days_to_expiry !== null && l.days_to_expiry < 0 ? "is-expired" : ""}>
                      <td>{personName(l.branch_name, lang)}</td>
                      {item.tracks_lots && <td className="mono small">{l.lot_number || "—"}</td>}
                      <td><Expiry date={l.expiry_date} days={l.days_to_expiry} /></td>
                      <td className="num">{fmtQty(l.quantity, lang)}</td>
                      {showMoney && <td className="num">{money(l.value, lang)}</td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="subsection">
          <h3 className="sub-head">{t("inv.recentMoves")}</h3>
          {moves === null ? (
            <p className="muted small">{t("loading")}</p>
          ) : moves.length === 0 ? (
            <p className="muted small">{t("inv.noMoves")}</p>
          ) : (
            <ul className="plain-list inv-moves">
              {moves.map((m, i) => (
                <li key={m.id} style={{ "--i": i } as CSSProperties}>
                  <span className={KIND_PILL[m.kind]}>{t(`inv.kind.${m.kind}` as TKey)}</span>
                  <span className={`num strong ${Number(m.quantity) > 0 ? "qty-in" : ""}`}>{signed(m.quantity, lang)}</span>
                  <span className="grow small ink-2">{moveRef(m, lang, t)}</span>
                  <span className="muted small nowrap">{new Date(m.created_at).toLocaleDateString(locale(lang), { day: "numeric", month: "short" })}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <div className="form-actions">
          {onReorder && can("inventory", "create") && item.preferred_supplier && (
            <button className="btn" onClick={() => onReorder(item)}>
              <Icon name="receipt" size={16} /> {t("inv.reorder")}
            </button>
          )}
          {editable && branches.length > 1 && (
            <button className="btn" onClick={() => setDialog("transfer")}>{t("inv.transfer")}</button>
          )}
          {editable && (
            <button className="btn" onClick={() => setDialog("waste")}>{t("inv.waste")}</button>
          )}
          {editable && (
            <button className="btn" onClick={() => setDialog("adjust")}>{t("inv.adjust")}</button>
          )}
          {editable && (
            <button className="btn btn-primary" onClick={() => setDialog("edit")}>{t("edit")}</button>
          )}
        </div>
      </div>
      {dialog === "edit" && (
        <ItemDialog
          item={item}
          onClose={() => setDialog(null)}
          onSaved={(next) => {
            setItem(next);
            done();
          }}
        />
      )}
      {(dialog === "adjust" || dialog === "waste") && (
        <AdjustDialog item={item} kind={dialog} lots={lots ?? []} branches={branches} preferBranch={[...branchesWithStock][0]} onClose={() => setDialog(null)} onSaved={done} />
      )}
      {dialog === "transfer" && <TransferDialog item={item} lots={lots ?? []} branches={branches} preferBranch={[...branchesWithStock][0]} onClose={() => setDialog(null)} onSaved={done} />}
    </Modal>
  );
}

export function signed(value: string, lang: string) {
  const n = Number(value);
  return `${n > 0 ? "+" : n < 0 ? "−" : ""}${fmtQty(Math.abs(n), lang)}`;
}

/** What a movement is for: an order, a patient, a lab case, a branch, or its note. */
export function moveRef(m: StockMovement, lang: string, t: (k: TKey, v?: Record<string, string | number>) => string) {
  const parts: string[] = [];
  if (m.purchase_order) parts.push(m.purchase_order);
  if (m.patient_info) parts.push(personName(m.patient_info, lang));
  if (m.lab_case_number) parts.push(m.lab_case_number);
  if (m.other_branch_name) parts.push(t(m.kind === "transfer_in" ? "inv.fromBranch" : "inv.toBranch", { b: personName(m.other_branch_name, lang) }));
  if (m.note && !parts.length) parts.push(m.note);
  return parts.join(" · ");
}

/* ---------------------------------------------------- adjust and waste */

function BranchSelect({ branches, value, onChange, label = "ap.branch", exclude }: { branches: Branch[]; value: number | ""; onChange: (v: number | "") => void; label?: TKey; exclude?: number | "" }) {
  const { t, name } = useI18n();
  return (
    <label className="field">
      <span className="field-label">{t(label)}</span>
      <select required value={value} onChange={(e) => onChange(e.target.value ? Number(e.target.value) : "")}>
        <option value="">—</option>
        {branches
          .filter((b) => b.id !== exclude)
          .map((b) => (
            <option key={b.id} value={b.id}>{name(b)}</option>
          ))}
      </select>
    </label>
  );
}

function lotLabel(l: StockLot, lang: string, unit: string) {
  return [l.lot_number || "—", l.expiry_date ? fmtDate(l.expiry_date, lang) : "", `${fmtQty(l.quantity, lang)} ${unit}`].filter(Boolean).join(" · ");
}

export function AdjustDialog({
  item,
  kind,
  lots,
  branches,
  preferBranch,
  onClose,
  onSaved,
}: {
  item: StockItem;
  kind: "adjust" | "waste";
  lots: StockLot[];
  branches: Branch[];
  preferBranch?: number;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t, lang } = useI18n();
  const unit = useUnit();
  const [branch, setBranch] = useState<number | "">(preferBranch ?? (branches.length === 1 ? branches[0].id : ""));
  const [lot, setLot] = useState<string>("");
  const [lotNumber, setLotNumber] = useState("");
  const [expiry, setExpiry] = useState("");
  const [mode, setMode] = useState<"counted" | "change">("counted");
  const [amount, setAmount] = useState("");
  const [cost, setCost] = useState(item.last_cost);
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const here = lots.filter((l) => l.branch === branch);
  const isNewLot = item.tracks_lots && lot === "new";
  useEffect(() => {
    // Pick the first lot at the branch (soonest expiry) or a new one when there is none.
    const first = lots.find((l) => l.branch === branch);
    setLot(item.tracks_lots ? (first ? String(first.id) : kind === "adjust" ? "new" : "") : "");
  }, [branch, lots, item.tracks_lots, kind]);

  const current = item.tracks_lots
    ? Number(here.find((l) => String(l.id) === lot)?.quantity ?? 0)
    : Number(item.stock.find((s) => s.branch.id === branch)?.quantity ?? 0);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    const body: Record<string, unknown> = { item: item.id, branch, kind, reason };
    if (item.tracks_lots) {
      if (isNewLot) Object.assign(body, { lot_number: lotNumber, expiry_date: expiry || null });
      else body.lot = Number(lot);
    }
    if (kind === "waste") body.quantity = amount;
    else if (mode === "counted") body.counted = amount;
    else body.quantity = amount;
    if (kind === "adjust" && (isNewLot || !item.tracks_lots) && cost !== "") body.unit_cost = cost;
    try {
      await post("/api/inventory/adjust/", body);
      onSaved();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const after = amount === "" ? null : kind === "waste" ? current - Number(amount) : mode === "counted" ? Number(amount) : current + Number(amount);

  return (
    <Modal title={`${t(kind === "waste" ? "inv.wasteTitle" : "inv.adjustTitle")} · ${itemName(item, lang)}`} onClose={onClose}>
      <form className="form-grid" onSubmit={submit}>
        <p className="muted small">{t(kind === "waste" ? "inv.wasteIntro" : "inv.adjustIntro")}</p>
        <div className="form-grid form-grid-2">
          <BranchSelect branches={branches} value={branch} onChange={setBranch} />
          {item.tracks_lots && (
            <label className="field">
              <span className="field-label">{t("inv.lot")}</span>
              <select required value={lot} onChange={(e) => setLot(e.target.value)}>
                {!here.length && kind === "waste" && <option value="">—</option>}
                {here.map((l) => (
                  <option key={l.id} value={l.id}>{lotLabel(l, lang, unit(item.unit))}</option>
                ))}
                {kind === "adjust" && <option value="new">{t("inv.newLot")}</option>}
              </select>
            </label>
          )}
          {isNewLot && (
            <>
              <label className="field">
                <span className="field-label">{t("inv.lotNumber")}</span>
                <input required dir="ltr" value={lotNumber} onChange={(e) => setLotNumber(e.target.value)} />
              </label>
              <label className="field">
                <span className="field-label">{t("inv.expiry")}</span>
                <input type="date" value={expiry} onChange={(e) => setExpiry(e.target.value)} />
              </label>
            </>
          )}
        </div>
        {kind === "adjust" && (
          <div className="segmented" role="group" aria-label={t("inv.adjust")}>
            <button type="button" aria-pressed={mode === "counted"} onClick={() => setMode("counted")}>{t("inv.counted")}</button>
            <button type="button" aria-pressed={mode === "change"} onClick={() => setMode("change")}>{t("inv.changeBy")}</button>
          </div>
        )}
        <div className="form-grid form-grid-2">
          <label className="field">
            <span className="field-label">
              {kind === "waste" ? t("inv.qtyWasted") : mode === "counted" ? t("inv.countedQty") : t("inv.changeQty")} ({unit(item.unit)})
            </span>
            <input type="number" required dir="ltr" step="0.001" min={kind === "waste" || mode === "counted" ? "0" : undefined} value={amount} onChange={(e) => setAmount(e.target.value)} />
          </label>
          {kind === "adjust" && (isNewLot || !item.tracks_lots) && (
            <label className="field">
              <span className="field-label">{t("inv.unitCost")}</span>
              <input type="number" dir="ltr" step="0.01" min="0" value={cost} onChange={(e) => setCost(e.target.value)} />
            </label>
          )}
        </div>
        {branch !== "" && (
          <p className="inv-after small">
            {t("inv.nowHere", { n: fmtQty(current, lang) })}
            {after !== null && !Number.isNaN(after) && (
              <>
                <Icon name="arrow" size={14} className="flip-rtl" />
                <strong className={after < 0 ? "owed" : ""}>{fmtQty(after, lang)}</strong>
              </>
            )}
          </p>
        )}
        <label className="field">
          <span className="field-label">{t("inv.reason")}</span>
          <input required value={reason} placeholder={t(kind === "waste" ? "inv.wasteReasonPh" : "inv.adjustReasonPh")} onChange={(e) => setReason(e.target.value)} />
        </label>
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="form-actions">
          <button type="button" className="btn" onClick={onClose}>{t("cancel")}</button>
          <button type="submit" className="btn btn-primary" disabled={busy || branch === ""}>{t("save")}</button>
        </div>
      </form>
    </Modal>
  );
}

/* ------------------------------------------------------------ transfer */

export function TransferDialog({ item, lots, branches, preferBranch, onClose, onSaved }: { item: StockItem; lots: StockLot[]; branches: Branch[]; preferBranch?: number; onClose: () => void; onSaved: () => void }) {
  const { t, lang } = useI18n();
  const unit = useUnit();
  const [from, setFrom] = useState<number | "">(preferBranch ?? "");
  const [to, setTo] = useState<number | "">("");
  const [lot, setLot] = useState("");
  const [quantity, setQuantity] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const here = lots.filter((l) => l.branch === from);
  const available = Number(item.stock.find((s) => s.branch.id === from)?.quantity ?? 0);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await post("/api/inventory/transfer/", { item: item.id, from_branch: from, to_branch: to, quantity, lot: lot ? Number(lot) : null, note });
      onSaved();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={`${t("inv.transfer")} · ${itemName(item, lang)}`} onClose={onClose}>
      <form className="form-grid" onSubmit={submit}>
        <div className="form-grid form-grid-2">
          <BranchSelect branches={branches} value={from} onChange={(v) => { setFrom(v); setLot(""); if (v === to) setTo(""); }} label="inv.fromBranchLabel" />
          <BranchSelect branches={branches} value={to} onChange={setTo} label="inv.toBranchLabel" exclude={from} />
          {item.tracks_lots && (
            <label className="field">
              <span className="field-label">{t("inv.lot")}</span>
              <select value={lot} onChange={(e) => setLot(e.target.value)}>
                <option value="">{t("inv.fefo")}</option>
                {here.map((l) => (
                  <option key={l.id} value={l.id}>{lotLabel(l, lang, unit(item.unit))}</option>
                ))}
              </select>
            </label>
          )}
          <label className="field">
            <span className="field-label">{t("inv.qty")} ({unit(item.unit)})</span>
            <input type="number" required dir="ltr" step="0.001" min="0.001" value={quantity} onChange={(e) => setQuantity(e.target.value)} />
            {from !== "" && <span className="field-hint">{t("inv.available", { n: fmtQty(available, lang) })}</span>}
          </label>
        </div>
        <label className="field">
          <span className="field-label">{t("notes")}</span>
          <input value={note} onChange={(e) => setNote(e.target.value)} />
        </label>
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="form-actions">
          <button type="button" className="btn" onClick={onClose}>{t("cancel")}</button>
          <button type="submit" className="btn btn-primary" disabled={busy || from === "" || to === ""}>{t("inv.transfer")}</button>
        </div>
      </form>
    </Modal>
  );
}

/* ------------------------------------------------------ purchase orders */

export interface PODraft {
  supplier?: number | null;
  branch?: number | null;
  lines?: { item: number; quantity: string; unit_cost?: string }[];
}

type LineRow = { key: number; item: number | ""; quantity: string; unit_cost: string };
let lineKey = 0;

export function PODialog({ order, draft, onClose, onSaved }: { order: PurchaseOrder | null; draft?: PODraft; onClose: () => void; onSaved: (po: PurchaseOrder) => void }) {
  const { t, lang, name } = useI18n();
  const currency = useCurrency();
  const branches = useBranches();
  const suppliers = useSuppliers();
  const unit = useUnit();
  const [items, setItems] = useState<StockItem[]>([]);
  const [supplier, setSupplier] = useState<number | "">(order?.supplier ?? draft?.supplier ?? "");
  const [branch, setBranch] = useState<number | "">(order?.branch ?? draft?.branch ?? "");
  const [expected, setExpected] = useState(order?.expected_date ?? "");
  const [notes, setNotes] = useState(order?.notes ?? "");
  const [lines, setLines] = useState<LineRow[]>(() =>
    order
      ? order.lines.map((l) => ({ key: ++lineKey, item: l.item, quantity: String(Number(l.quantity_ordered)), unit_cost: l.unit_cost }))
      : (draft?.lines ?? []).map((l) => ({ key: ++lineKey, item: l.item, quantity: String(Number(l.quantity)), unit_cost: l.unit_cost ?? "" })),
  );
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    getAll<StockItem>("/api/inventory/items/?active=1")
      .then((rows) => {
        setItems(rows);
        // Fill in the last cost for lines that came without one.
        setLines((ls) => ls.map((l) => (l.unit_cost === "" ? { ...l, unit_cost: rows.find((i) => i.id === l.item)?.last_cost ?? "0" } : l)));
      })
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    if (branch === "" && branches.length === 1) setBranch(branches[0].id);
  }, [branches, branch]);
  useEffect(() => {
    if (!order && lines.length === 0) setLines([{ key: ++lineKey, item: "", quantity: "1", unit_cost: "" }]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fromSupplier = items.filter((i) => supplier !== "" && i.preferred_supplier === supplier);
  const others = items.filter((i) => !(supplier !== "" && i.preferred_supplier === supplier));
  const update = (key: number, patchRow: Partial<LineRow>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patchRow } : l)));
  const pickItem = (key: number, id: number | "") => {
    const found = items.find((i) => i.id === id);
    update(key, { item: id, unit_cost: found?.last_cost ?? "", ...(found && Number(found.reorder_quantity) > 0 ? { quantity: String(Number(found.reorder_quantity)) } : {}) });
  };
  const total = lines.reduce((sum, l) => sum + (Number(l.quantity) || 0) * (Number(l.unit_cost) || 0), 0);
  const used = new Set(lines.map((l) => l.item));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const rows = lines.filter((l) => l.item !== "");
    if (!rows.length) return setError(t("inv.needLine"));
    setBusy(true);
    setError("");
    const body = {
      supplier,
      branch,
      expected_date: expected || null,
      notes,
      lines: rows.map((l) => ({ item: l.item, quantity_ordered: l.quantity, ...(l.unit_cost !== "" ? { unit_cost: l.unit_cost } : {}) })),
    };
    try {
      onSaved(order ? await patch<PurchaseOrder>(`/api/inventory/purchase-orders/${order.id}/`, body) : await post<PurchaseOrder>("/api/inventory/purchase-orders/", body));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const option = (i: StockItem) => (
    <option key={i.id} value={i.id} disabled={used.has(i.id)}>
      {itemName(i, lang)}{i.code ? ` · ${i.code}` : ""}
    </option>
  );

  return (
    <Modal title={order ? `${t("edit")} · ${order.number}` : t("inv.newPo")} onClose={onClose}>
      <form className="form-grid" onSubmit={submit}>
        <div className="form-grid form-grid-3">
          <label className="field">
            <span className="field-label">{t("inv.supplier")}</span>
            <select required value={supplier} onChange={(e) => setSupplier(e.target.value ? Number(e.target.value) : "")}>
              <option value="">—</option>
              {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </label>
          <label className="field">
            <span className="field-label">{t("inv.deliverTo")}</span>
            <select required value={branch} onChange={(e) => setBranch(e.target.value ? Number(e.target.value) : "")}>
              <option value="">—</option>
              {branches.map((b) => <option key={b.id} value={b.id}>{name(b)}</option>)}
            </select>
          </label>
          <label className="field">
            <span className="field-label">{t("inv.expected")}</span>
            <input type="date" value={expected} min={isoToday()} onChange={(e) => setExpected(e.target.value)} />
          </label>
        </div>

        <fieldset className="field po-lines">
          <legend className="field-label">{t("inv.lines")}</legend>
          <div className="po-line po-line-head" aria-hidden="true">
            <span>{t("inv.item")}</span>
            <span>{t("inv.qty")}</span>
            <span>{t("inv.unitCost")}</span>
            <span className="num">{t("inv.lineTotal")}</span>
            <span />
          </div>
          {lines.map((l, i) => {
            const it = items.find((x) => x.id === l.item);
            return (
              <div key={l.key} className="po-line" style={{ "--i": i } as CSSProperties}>
                <select aria-label={t("inv.item")} required value={l.item} onChange={(e) => pickItem(l.key, e.target.value ? Number(e.target.value) : "")}>
                  <option value="">{t("inv.pickItem")}</option>
                  {fromSupplier.length > 0 && <optgroup label={t("inv.fromSupplier")}>{fromSupplier.map(option)}</optgroup>}
                  {fromSupplier.length > 0 ? <optgroup label={t("inv.otherItems")}>{others.map(option)}</optgroup> : others.map(option)}
                </select>
                <label className="po-qty">
                  <input aria-label={t("inv.qty")} type="number" required dir="ltr" step="0.001" min="0.001" value={l.quantity} onChange={(e) => update(l.key, { quantity: e.target.value })} />
                  {it && <span className="muted small">{unit(it.unit)}</span>}
                </label>
                <input aria-label={t("inv.unitCost")} type="number" dir="ltr" step="0.01" min="0" value={l.unit_cost} onChange={(e) => update(l.key, { unit_cost: e.target.value })} />
                <span className="num po-line-total">{money((Number(l.quantity) || 0) * (Number(l.unit_cost) || 0), lang)}</span>
                <button type="button" className="btn btn-icon btn-small" aria-label={t("inv.removeLine")} title={t("inv.removeLine")} onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}>
                  <Icon name="close" size={16} />
                </button>
              </div>
            );
          })}
          <button type="button" className="btn btn-small add-line" onClick={() => setLines((ls) => [...ls, { key: ++lineKey, item: "", quantity: "1", unit_cost: "" }])}>
            <Icon name="plus" size={16} /> {t("inv.addLine")}
          </button>
        </fieldset>

        <p className="bill-total">
          <span>{t("bill.total")}</span>
          <strong>{money(total, lang)} <span className="muted small">{currency}</span></strong>
        </p>
        <label className="field">
          <span className="field-label">{t("notes")}</span>
          <textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </label>
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="form-actions">
          <button type="button" className="btn" onClick={onClose}>{t("cancel")}</button>
          <button type="submit" className="btn btn-primary" disabled={busy || supplier === "" || branch === ""}>{t("inv.saveDraft")}</button>
        </div>
      </form>
    </Modal>
  );
}

function usePrintPO() {
  const { t, lang } = useI18n();
  const letterhead = useLetterhead(lang);
  const currency = useCurrency();
  const unit = useUnit();
  return (po: PurchaseOrder) => {
    const rows = po.lines
      .map(
        (l, i) =>
          `<tr><td>${i + 1}</td><td>${escapeHtml(itemName(l.item_info, lang))}${l.item_info.code ? ` <span style="color:#5A6B7B">${escapeHtml(l.item_info.code)}</span>` : ""}</td><td>${fmtQty(l.quantity_ordered, lang)} ${escapeHtml(unit(l.item_info.unit))}</td><td style="text-align:end">${money(l.unit_cost, lang)}</td><td style="text-align:end">${money(l.total, lang)}</td></tr>`,
      )
      .join("");
    printDocument({
      title: `${t("inv.po")} ${po.number}`,
      lang,
      clinic: letterhead,
      patient: [
        `${escapeHtml(t("inv.supplier"))}: <strong>${escapeHtml(po.supplier_name)}</strong>`,
        `${escapeHtml(t("inv.deliverTo"))}: ${escapeHtml(personName(po.branch_name, lang))}`,
        escapeHtml(fmtDate((po.ordered_at ?? po.created_at).slice(0, 10), lang)),
        po.expected_date ? `${escapeHtml(t("inv.expected"))}: ${escapeHtml(fmtDate(po.expected_date, lang))}` : "",
      ]
        .filter(Boolean)
        .join(" · "),
      body: `<table><thead><tr><th>#</th><th>${escapeHtml(t("inv.item"))}</th><th>${escapeHtml(t("inv.qty"))}</th><th style="text-align:end">${escapeHtml(t("inv.unitCost"))}</th><th style="text-align:end">${escapeHtml(t("bill.amount", { cur: currency }))}</th></tr></thead><tbody>${rows}</tbody><tfoot><tr><td colspan="4" style="text-align:end;border:0;font-weight:600">${escapeHtml(t("bill.total"))}</td><td style="text-align:end;border:0;font-weight:600">${money(po.total, lang)}</td></tr></tfoot></table>${po.notes ? `<p class="body">${escapeHtml(po.notes)}</p>` : ""}`,
      footer: `<div class="sign"><span></span><div class="line">${escapeHtml(t("inv.approvedBy"))}</div></div>`,
    });
  };
}

export function POView({ initial, onClose, onChanged }: { initial: PurchaseOrder; onClose: () => void; onChanged: () => void }) {
  const { t, lang } = useI18n();
  const { can } = useAuth();
  const currency = useCurrency();
  const unit = useUnit();
  const print = usePrintPO();
  const [po, setPo] = useState(initial);
  const [dialog, setDialog] = useState<"edit" | "receive" | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const open = po.status === "ordered" || po.status === "partially_received";

  const run = async (fn: () => Promise<PurchaseOrder>) => {
    setBusy(true);
    setError("");
    try {
      setPo(await fn());
      onChanged();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!window.confirm(t("inv.confirmDeletePo"))) return;
    try {
      await del(`/api/inventory/purchase-orders/${po.id}/`);
      onChanged();
      onClose();
    } catch (err) {
      setError(errorText(err));
    }
  };
  const when = (iso: string | null) => (iso ? fmtDate(iso.slice(0, 10), lang) : "");

  return (
    <Modal title={`${t("inv.po")} ${po.number}`} onClose={onClose}>
      <div className="case-view">
        <div className="invoice-head">
          <div>
            <p className="strong">{po.supplier_name}</p>
            <p className="muted small">
              {t("inv.deliverTo")}: {personName(po.branch_name, lang)}
              {po.expected_date && <> · {t("inv.expected")}: {fmtDate(po.expected_date, lang)}</>}
            </p>
          </div>
          <span className={PO_PILL[po.status]}>{t(`inv.po.${po.status}` as TKey)}</span>
        </div>
        <ol className="po-steps" aria-label={t("plan.status")}>
          <li className="done">{t("inv.po.draft")} <span className="muted small">{when(po.created_at)}</span></li>
          <li className={po.ordered_at ? "done" : ""}>{t("inv.po.ordered")} <span className="muted small">{when(po.ordered_at)}</span></li>
          <li className={po.received_at ? "done" : po.status === "partially_received" ? "part" : ""}>{t("inv.po.received")} <span className="muted small">{when(po.received_at)}</span></li>
        </ol>
        {po.cancelled_at && <p className="notice pad-sm">{t("inv.cancelledBecause", { reason: po.cancel_reason })}</p>}
        <div className="table-wrap inset-table">
          <table>
            <thead>
              <tr>
                <th>{t("inv.item")}</th>
                <th className="num">{t("inv.ordered")}</th>
                <th className="num">{t("inv.receivedQty")}</th>
                <th className="num">{t("inv.unitCost")}</th>
                <th className="num">{t("bill.amount", { cur: currency })}</th>
              </tr>
            </thead>
            <tbody>
              {po.lines.map((l) => (
                <tr key={l.id}>
                  <td>
                    {itemName(l.item_info, lang)} {l.item_info.code && <span className="muted mono small">{l.item_info.code}</span>}
                  </td>
                  <td className="num">{fmtQty(l.quantity_ordered, lang)} <span className="muted small">{unit(l.item_info.unit)}</span></td>
                  <td className={`num ${Number(l.quantity_received) >= Number(l.quantity_ordered) ? "qty-in" : ""}`}>{fmtQty(l.quantity_received, lang)}</td>
                  <td className="num">{money(l.unit_cost, lang)}</td>
                  <td className="num">{money(l.total, lang)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={4} className="num strong">{t("bill.total")}</td>
                <td className="num strong">{money(po.total, lang)}</td>
              </tr>
              {Number(po.received_value) > 0 && (
                <tr>
                  <td colSpan={4} className="num muted">{t("inv.receivedValue")}</td>
                  <td className="num">{money(po.received_value, lang)}</td>
                </tr>
              )}
            </tfoot>
          </table>
        </div>
        {po.notes && <p className="instructions">{po.notes}</p>}
        {cancelling && (
          <div className="inline-form">
            <input autoFocus aria-label={t("inv.cancelReason")} placeholder={t("inv.cancelReason")} value={reason} onChange={(e) => setReason(e.target.value)} />
            <button className="btn" onClick={() => setCancelling(false)}>{t("back")}</button>
            <button className="btn btn-primary" disabled={busy || !reason.trim()} onClick={() => void run(() => post<PurchaseOrder>(`/api/inventory/purchase-orders/${po.id}/cancel/`, { reason }))}>
              {t("inv.cancelPo")}
            </button>
          </div>
        )}
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="form-actions">
          {po.status === "draft" && can("inventory", "delete") && <button className="btn" onClick={() => void remove()}>{t("delete")}</button>}
          {!cancelling && po.status !== "received" && po.status !== "cancelled" && can("inventory", "approve") && (
            <button className="btn" onClick={() => setCancelling(true)}>{t("inv.cancelPo")}</button>
          )}
          <button className="btn" onClick={() => print(po)}>
            <Icon name="file" size={16} /> {t("print")}
          </button>
          {po.status === "draft" && can("inventory", "create") && <button className="btn" onClick={() => setDialog("edit")}>{t("edit")}</button>}
          {po.status === "draft" && can("inventory", "approve") && (
            <button className="btn btn-primary" disabled={busy} onClick={() => void run(() => post<PurchaseOrder>(`/api/inventory/purchase-orders/${po.id}/order/`, {}))}>
              {t("inv.placeOrder")}
            </button>
          )}
          {open && can("inventory", "create") && (
            <button className="btn btn-primary" onClick={() => setDialog("receive")}>
              <Icon name="box" size={16} /> {t("inv.receive")}
            </button>
          )}
        </div>
      </div>
      {dialog === "edit" && (
        <PODialog
          order={po}
          onClose={() => setDialog(null)}
          onSaved={(next) => {
            setDialog(null);
            setPo(next);
            onChanged();
          }}
        />
      )}
      {dialog === "receive" && (
        <ReceiveDialog
          po={po}
          onClose={() => setDialog(null)}
          onSaved={(next) => {
            setDialog(null);
            setPo(next);
            onChanged();
          }}
        />
      )}
    </Modal>
  );
}

function ReceiveDialog({ po, onClose, onSaved }: { po: PurchaseOrder; onClose: () => void; onSaved: (po: PurchaseOrder) => void }) {
  const { t, lang } = useI18n();
  const unit = useUnit();
  const due = useMemo(() => po.lines.filter((l) => Number(l.remaining) > 0), [po]);
  const [rows, setRows] = useState(() => Object.fromEntries(due.map((l) => [l.id, { quantity: String(Number(l.remaining)), lot_number: "", expiry_date: "", unit_cost: l.unit_cost }])));
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const set = (id: number, patchRow: Partial<(typeof rows)[number]>) => setRows((r) => ({ ...r, [id]: { ...r[id], ...patchRow } }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const lines = due
      .filter((l) => Number(rows[l.id].quantity) > 0)
      .map((l) => {
        const r = rows[l.id];
        return {
          line: l.id,
          quantity: r.quantity,
          unit_cost: r.unit_cost,
          ...(l.item_info.tracks_lots ? { lot_number: r.lot_number, expiry_date: r.expiry_date || null } : {}),
        };
      });
    if (!lines.length) return setError(t("inv.nothingToReceive"));
    setBusy(true);
    setError("");
    try {
      onSaved(await post<PurchaseOrder>(`/api/inventory/purchase-orders/${po.id}/receive/`, { lines, note }));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={`${t("inv.receive")} · ${po.number}`} onClose={onClose}>
      <form className="form-grid" onSubmit={submit}>
        <p className="muted small">{t("inv.receiveIntro")}</p>
        <ul className="plain-list receive-list">
          {due.map((l, i) => {
            const r = rows[l.id];
            const active = Number(r.quantity) > 0;
            return (
              <li key={l.id} className={`receive-row ${active ? "" : "is-disabled"}`} style={{ "--i": i } as CSSProperties}>
                <div className="receive-name">
                  <strong>{itemName(l.item_info, lang)}</strong>
                  <span className="muted small">{t("inv.stillDue", { n: fmtQty(l.remaining, lang), u: unit(l.item_info.unit) })}</span>
                </div>
                <div className="receive-fields">
                  <label className="field">
                    <span className="field-label">{t("inv.qty")}</span>
                    <input type="number" dir="ltr" step="0.001" min="0" max={Number(l.remaining)} value={r.quantity} onChange={(e) => set(l.id, { quantity: e.target.value })} />
                  </label>
                  <label className="field">
                    <span className="field-label">{t("inv.unitCost")}</span>
                    <input type="number" dir="ltr" step="0.01" min="0" value={r.unit_cost} onChange={(e) => set(l.id, { unit_cost: e.target.value })} />
                  </label>
                  {l.item_info.tracks_lots && (
                    <>
                      <label className="field">
                        <span className="field-label">{t("inv.lotNumber")}</span>
                        <input dir="ltr" required={active} value={r.lot_number} onChange={(e) => set(l.id, { lot_number: e.target.value })} />
                      </label>
                      <label className="field">
                        <span className="field-label">{t("inv.expiry")}</span>
                        <input type="date" value={r.expiry_date} onChange={(e) => set(l.id, { expiry_date: e.target.value })} />
                      </label>
                    </>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
        <label className="field">
          <span className="field-label">{t("notes")}</span>
          <input value={note} placeholder={t("inv.receiveNotePh")} onChange={(e) => setNote(e.target.value)} />
        </label>
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="form-actions">
          <button type="button" className="btn" onClick={onClose}>{t("cancel")}</button>
          <button type="submit" className="btn btn-primary" disabled={busy}>{t("inv.receiveStock")}</button>
        </div>
      </form>
    </Modal>
  );
}

/** Patient name linking to the file when the reader may open patients. */
export function PatientLink({ p }: { p: { id: number; en: string; ar: string; file_number: string } | null }) {
  const { lang } = useI18n();
  const { can } = useAuth();
  if (!p) return <span className="muted">—</span>;
  return (
    <span>
      {can("patients") ? <Link to={`/patients/${p.id}`}>{personName(p, lang)}</Link> : personName(p, lang)} <span className="muted mono small">{p.file_number}</span>
    </span>
  );
}
