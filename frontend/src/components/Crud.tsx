import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ApiError, del, getAll, patch, post } from "../api";
import { useAuth } from "../auth";
import { useI18n, type TKey } from "../i18n";

export interface Option {
  value: string | number;
  label: string;
}

export interface FieldDef {
  name: string;
  label: TKey;
  type?: "text" | "textarea" | "number" | "checkbox" | "select" | "multiselect" | "time" | "date" | "color" | "password" | "email";
  options?: Option[];
  required?: boolean;
  hint?: TKey;
  dir?: "ltr" | "rtl";
  /** Only shown when creating a record. */
  createOnly?: boolean;
  step?: string;
}

export interface ColumnDef<T> {
  label: TKey;
  render: (row: T) => ReactNode;
}

type Row = { id: number } & Record<string, unknown>;

export function Field({
  field,
  value,
  onChange,
  errors,
}: {
  field: FieldDef;
  value: unknown;
  onChange: (value: unknown) => void;
  errors?: string[];
}) {
  const { t } = useI18n();
  const id = `${useId()}-${field.name}`;
  const type = field.type ?? "text";
  let input: ReactNode;
  if (type === "checkbox") {
    return (
      <div className="field field-check">
        <input id={id} name={field.name} type="checkbox" checked={Boolean(value)} onChange={(e) => onChange(e.target.checked)} />
        <label htmlFor={id}>{t(field.label)}</label>
        {errors && <p className="field-error">{errors.join(" ")}</p>}
      </div>
    );
  }
  if (type === "textarea") {
    input = <textarea id={id} name={field.name} value={String(value ?? "")} dir={field.dir} rows={3} onChange={(e) => onChange(e.target.value)} />;
  } else if (type === "select") {
    input = (
      <select id={id} name={field.name} value={value === null || value === undefined ? "" : String(value)} required={field.required} onChange={(e) => onChange(e.target.value === "" ? null : e.target.value)}>
        {!field.required && <option value="">{t("none")}</option>}
        {field.required && (value === null || value === undefined || value === "") && <option value="">—</option>}
        {field.options?.map((o) => (
          <option key={o.value} value={String(o.value)}>
            {o.label}
          </option>
        ))}
      </select>
    );
  } else if (type === "multiselect") {
    const selected = new Set(((value as (string | number)[]) ?? []).map(String));
    input = (
      <div className="checks" role="group" aria-labelledby={`${id}-label`}>
        {field.options?.map((o) => (
          <label key={o.value} className="check-pill">
            <input
              type="checkbox"
              checked={selected.has(String(o.value))}
              onChange={(e) => {
                const next = new Set(selected);
                if (e.target.checked) next.add(String(o.value));
                else next.delete(String(o.value));
                onChange([...next].map(Number));
              }}
            />
            {o.label}
          </label>
        ))}
      </div>
    );
  } else {
    input = (
      <input
        id={id}
        name={field.name}
        type={type}
        dir={field.dir}
        step={field.step}
        required={field.required}
        value={value === null || value === undefined ? "" : String(value)}
        autoComplete={type === "password" ? "new-password" : undefined}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }
  return (
    <div className="field">
      <label id={`${id}-label`} htmlFor={id}>
        {t(field.label)}
      </label>
      {input}
      {field.hint && <p className="field-hint">{t(field.hint)}</p>}
      {errors && <p className="field-error">{errors.join(" ")}</p>}
    </div>
  );
}

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const backdrop = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Escape closes only the topmost dialog when one opens over another.
    const onKey = (e: KeyboardEvent) => {
      const all = document.querySelectorAll(".modal-backdrop");
      if (e.key === "Escape" && all[all.length - 1] === backdrop.current) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const titleId = useId();
  // Rendered on <body> so a card's overflow or animation never clips it.
  return createPortal(
    <div ref={backdrop} className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <h2 id={titleId} className="modal-title">{title}</h2>
        {children}
      </div>
    </div>,
    document.body,
  );
}

export function RecordForm({
  fields,
  initial,
  isNew,
  onSubmit,
  onCancel,
}: {
  fields: FieldDef[];
  initial: Record<string, unknown>;
  isNew: boolean;
  onSubmit: (values: Record<string, unknown>) => Promise<void>;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const [values, setValues] = useState(initial);
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErrors({});
    setMessage("");
    try {
      await onSubmit(values);
    } catch (err) {
      if (err instanceof ApiError) {
        setErrors(err.fields);
        setMessage(Object.keys(err.fields).some((f) => fields.find((x) => x.name === f)) ? "" : err.message);
      } else setMessage(String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="form-grid">
      {fields
        .filter((f) => isNew || !f.createOnly)
        .map((f) => (
          <Field key={f.name} field={f} value={values[f.name]} errors={errors[f.name]} onChange={(v) => setValues((s) => ({ ...s, [f.name]: v }))} />
        ))}
      {message && (
        <p className="form-error" role="alert">
          {message}
        </p>
      )}
      <div className="form-actions">
        <button type="button" className="btn" onClick={onCancel}>
          {t("cancel")}
        </button>
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {t("save")}
        </button>
      </div>
    </form>
  );
}

/** A list of records with add / edit / delete, for one API endpoint. */
export function CrudSection<T extends Row>({
  title,
  endpoint,
  module,
  columns,
  fields,
  defaults = {},
  deleteLabel = "delete",
  prepare,
  onChanged,
  toolbar,
}: {
  title: string;
  endpoint: string;
  module: string;
  columns: ColumnDef<T>[];
  fields: FieldDef[];
  defaults?: Record<string, unknown>;
  deleteLabel?: TKey;
  prepare?: (values: Record<string, unknown>, isNew: boolean) => Record<string, unknown>;
  onChanged?: (rows: T[]) => void;
  toolbar?: ReactNode;
}) {
  const { t } = useI18n();
  const { can } = useAuth();
  const [rows, setRows] = useState<T[] | null>(null);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<{ row: T | null } | null>(null);
  const onChangedRef = useRef(onChanged);
  onChangedRef.current = onChanged;

  const load = useCallback(async () => {
    try {
      const data = await getAll<T>(endpoint);
      setRows(data);
      onChangedRef.current?.(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [endpoint]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async (values: Record<string, unknown>) => {
    const isNew = !editing?.row;
    const body = prepare ? prepare(values, isNew) : values;
    if (isNew) await post(endpoint, body);
    else await patch(`${endpoint}${editing!.row!.id}/`, body);
    setEditing(null);
    await load();
  };

  const remove = async (row: T) => {
    if (!window.confirm(t("confirmDelete"))) return;
    try {
      await del(`${endpoint}${row.id}/`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const canEdit = can(module, "edit");
  const canDelete = can(module, "delete");

  return (
    <section className="card">
      <header className="card-head">
        <h2>{title}</h2>
        <div className="toolbar">
          {toolbar}
          {can(module, "create") && (
            <button className="btn btn-primary" onClick={() => setEditing({ row: null })}>
              + {t("add")}
            </button>
          )}
        </div>
      </header>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {rows === null ? (
        <p className="muted pad">{t("loading")}</p>
      ) : rows.length === 0 ? (
        <p className="muted pad">{t("noRecords")}</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                {columns.map((c) => (
                  <th key={c.label}>{t(c.label)}</th>
                ))}
                {(canEdit || canDelete) && <th className="cell-actions">{t("actions")}</th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  {columns.map((c) => (
                    <td key={c.label}>{c.render(row)}</td>
                  ))}
                  {(canEdit || canDelete) && (
                    <td className="cell-actions">
                      {canEdit && (
                        <button className="btn btn-small" onClick={() => setEditing({ row })}>
                          {t("edit")}
                        </button>
                      )}
                      {canDelete && (
                        <button className="btn btn-small btn-danger" onClick={() => void remove(row)}>
                          {t(deleteLabel)}
                        </button>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing && (
        <Modal title={`${editing.row ? t("edit") : t("add")}: ${title}`} onClose={() => setEditing(null)}>
          <RecordForm
            fields={fields}
            isNew={!editing.row}
            initial={editing.row ? { ...editing.row } : { ...defaults }}
            onSubmit={save}
            onCancel={() => setEditing(null)}
          />
        </Modal>
      )}
    </section>
  );
}

export function YesNo({ value }: { value: unknown }) {
  const { t } = useI18n();
  return <span className={value ? "pill pill-ok" : "pill"}>{value ? t("yes") : t("no")}</span>;
}

export function ActiveBadge({ value }: { value: unknown }) {
  const { t } = useI18n();
  return <span className={value ? "pill pill-ok" : "pill"}>{value ? t("active") : t("inactive")}</span>;
}
