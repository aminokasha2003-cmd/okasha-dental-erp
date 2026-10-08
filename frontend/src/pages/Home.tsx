import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { get, type Page } from "../api";
import { useAuth } from "../auth";
import { useI18n, type TKey } from "../i18n";
import { Icon } from "../components/Icon";

interface Step {
  key: TKey;
  to: string;
  module: string;
  done: () => Promise<boolean>;
}

const count = async (path: string) => (await get<Page<unknown>>(path)).count;

export function Home() {
  const { t } = useI18n();
  const { me, can } = useAuth();
  const [status, setStatus] = useState<Record<string, boolean | undefined>>({});

  useEffect(() => {
    const steps: Step[] = [
      { key: "home.step.clinic", to: "/settings", module: "settings", done: async () => Boolean(me?.clinic?.phone && me?.clinic?.tax_registration_number) },
      { key: "home.step.branch", to: "/settings", module: "settings", done: async () => (await count("/api/masterdata/branches/")) > 0 },
      { key: "home.step.chairs", to: "/settings", module: "settings", done: async () => (await count("/api/masterdata/chairs/")) > 0 },
      { key: "home.step.hours", to: "/settings", module: "settings", done: async () => (await count("/api/masterdata/working-hours/")) > 0 },
      { key: "home.step.staff", to: "/staff", module: "masterdata", done: async () => (await count("/api/masterdata/staff/")) > 0 },
      { key: "home.step.procedures", to: "/procedures", module: "masterdata", done: async () => (await count("/api/masterdata/procedures/")) > 0 },
      { key: "home.step.users", to: "/users", module: "users", done: async () => (await count("/api/users/")) > 1 },
    ];
    for (const step of steps) {
      if (!can(step.module)) continue;
      step
        .done()
        .then((done) => setStatus((s) => ({ ...s, [step.key]: done })))
        .catch(() => undefined);
    }
  }, [me, can]);

  const rows: { key: TKey; to: string; module: string }[] = [
    { key: "home.step.clinic", to: "/settings", module: "settings" },
    { key: "home.step.branch", to: "/settings", module: "settings" },
    { key: "home.step.chairs", to: "/settings", module: "settings" },
    { key: "home.step.hours", to: "/settings", module: "settings" },
    { key: "home.step.staff", to: "/staff", module: "masterdata" },
    { key: "home.step.procedures", to: "/procedures", module: "masterdata" },
    { key: "home.step.users", to: "/users", module: "users" },
  ];

  return (
    <div className="page">
      <h1>{t("home.title")}</h1>
      <p className="muted">{t("home.intro")}</p>
      <section className="card">
        <ul className="checklist">
          {rows
            .filter((r) => can(r.module))
            .map((r) => {
              const done = status[r.key];
              return (
                <li key={r.key}>
                  <span className={done ? "check done" : "check"}>
                    <Icon name={done ? "check" : "circle"} size={18} />
                  </span>
                  <span className="grow">{t(r.key)}</span>
                  <span className={done ? "pill pill-ok" : "pill pill-warn"}>{done ? t("home.done") : t("home.todo")}</span>
                  <Link to={r.to} className="btn btn-small">
                    {t("home.open")}
                  </Link>
                </li>
              );
            })}
        </ul>
      </section>
    </div>
  );
}
