import { useCallback, useEffect, useState } from "react";
import { get, type Page } from "../api";
import { useI18n, type TKey } from "../i18n";
import type { AuditEntry } from "../types";

function show(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "boolean") return value ? "✓" : "✗";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function ChangeList({ entry }: { entry: AuditEntry }) {
  const { t } = useI18n();
  const items = Object.entries(entry.changes);
  const list = (
    <dl className="changes" dir="ltr">
      {items.map(([field, [before, after]]) => (
        <div key={field}>
          <dt>{field}</dt>
          <dd>
            {entry.action !== "create" && <del>{show(before)}</del>} {entry.action !== "delete" && <ins>{show(after)}</ins>}
          </dd>
        </div>
      ))}
    </dl>
  );
  if (items.length <= 3) return list;
  return (
    <details>
      <summary className="muted small">
        {t("audit.changes")}: {items.length}
      </summary>
      {list}
    </details>
  );
}

export function Audit() {
  const { t, lang } = useI18n();
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [action, setAction] = useState("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (url: string, append: boolean) => {
    setLoading(true);
    try {
      const page = await get<Page<AuditEntry>>(url);
      setEntries((prev) => (append ? [...prev, ...page.results] : page.results));
      setNext(page.next ? new URL(page.next).pathname + new URL(page.next).search : null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(`/api/audit/${action ? `?action=${action}` : ""}`, false);
  }, [action, load]);

  const fmt = new Intl.DateTimeFormat(lang === "ar" ? "ar-EG" : "en-GB", { dateStyle: "medium", timeStyle: "short" });

  return (
    <div className="page">
      <h1>{t("nav.audit")}</h1>
      <section className="card">
        <header className="card-head">
          <div className="segmented" role="group" aria-label={t("audit.what")}>
            {["", "create", "update", "delete"].map((a) => (
              <button key={a || "all"} aria-pressed={action === a} onClick={() => setAction(a)}>
                {a ? t(`audit.action.${a}` as TKey) : t("all")}
              </button>
            ))}
          </div>
        </header>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{t("audit.when")}</th>
                <th>{t("audit.who")}</th>
                <th>{t("audit.what")}</th>
                <th>{t("audit.record")}</th>
                <th>{t("audit.changes")}</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.id}>
                  <td className="nowrap">{fmt.format(new Date(e.timestamp))}</td>
                  <td>{e.user_name ?? t("audit.system")}</td>
                  <td>
                    <span className={`pill pill-${e.action}`}>{t(`audit.action.${e.action}` as TKey)}</span>
                  </td>
                  <td>
                    <div>{e.object_repr}</div>
                    <div className="muted small" dir="ltr">
                      {e.record_type} #{e.object_id}
                    </div>
                  </td>
                  <td>
                    <ChangeList entry={e} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!loading && entries.length === 0 && <p className="muted pad">{t("noRecords")}</p>}
        {next && (
          <div className="pad">
            <button className="btn" disabled={loading} onClick={() => void load(next, true)}>
              {t("audit.more")}
            </button>
          </div>
        )}
      </section>
    </div>
  );
}
