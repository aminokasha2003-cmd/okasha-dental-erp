import { useCallback, useEffect, useState } from "react";
import { ApiError, del, get, getAll, patch, post } from "../api";
import { useAuth } from "../auth";
import { useI18n, type TKey } from "../i18n";
import { ActiveBadge, CrudSection, Field, Modal } from "../components/Crud";
import type { MetaInfo, Role } from "../types";

type UserRow = {
  id: number;
  username: string;
  first_name: string;
  last_name: string;
  email: string;
  phone: string;
  language: "en" | "ar";
  roles: number[];
  is_active: boolean;
  last_login: string | null;
};

function RoleEditor({ role, meta, onClose, onSaved }: { role: Role | null; meta: MetaInfo; onClose: () => void; onSaved: () => void }) {
  const { t, moduleName } = useI18n();
  const [draft, setDraft] = useState({
    code: role?.code ?? "",
    name_en: role?.name_en ?? "",
    name_ar: role?.name_ar ?? "",
    permissions: role?.permissions ?? {},
  });
  const [error, setError] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});

  const toggle = (module: string, action: string, on: boolean) => {
    const current = new Set(draft.permissions[module] ?? []);
    if (on) {
      current.add(action);
      current.add("view"); // every other action needs view
    } else {
      current.delete(action);
      if (action === "view") current.clear();
    }
    setDraft({ ...draft, permissions: { ...draft.permissions, [module]: meta.actions.filter((a) => current.has(a)) } });
  };

  const save = async () => {
    setError("");
    setFieldErrors({});
    try {
      if (role) await patch(`/api/roles/${role.id}/`, draft);
      else await post("/api/roles/", draft);
      onSaved();
    } catch (err) {
      if (err instanceof ApiError) setFieldErrors(err.fields);
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <Modal title={role ? `${t("edit")}: ${role.name_en}` : `${t("add")}: ${t("users.roles")}`} onClose={onClose}>
      <div className="form-grid form-grid-3">
        <Field field={{ name: "name_en", label: "nameEn", required: true, dir: "ltr" }} value={draft.name_en} errors={fieldErrors.name_en} onChange={(v) => setDraft({ ...draft, name_en: String(v) })} />
        <Field field={{ name: "name_ar", label: "nameAr", required: true, dir: "rtl" }} value={draft.name_ar} errors={fieldErrors.name_ar} onChange={(v) => setDraft({ ...draft, name_ar: String(v) })} />
        {!role?.is_system && (
          <Field field={{ name: "code", label: "roles.code", required: true, dir: "ltr" }} value={draft.code} errors={fieldErrors.code} onChange={(v) => setDraft({ ...draft, code: String(v) })} />
        )}
      </div>
      <div className="table-wrap matrix">
        <table>
          <thead>
            <tr>
              <th>{t("roles.module")}</th>
              {meta.actions.map((a) => (
                <th key={a} className="center">
                  {t(`action.${a}` as TKey)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {meta.modules.map((m) => (
              <tr key={m.code}>
                <td>{moduleName(m.code)}</td>
                {meta.actions.map((a) => (
                  <td key={a} className="center">
                    <input
                      type="checkbox"
                      aria-label={`${moduleName(m.code)}: ${t(`action.${a}` as TKey)}`}
                      checked={Boolean(draft.permissions[m.code]?.includes(a))}
                      onChange={(e) => toggle(m.code, a, e.target.checked)}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="form-actions">
        <button className="btn" onClick={onClose}>
          {t("cancel")}
        </button>
        <button className="btn btn-primary" onClick={() => void save()}>
          {t("save")}
        </button>
      </div>
    </Modal>
  );
}

function RolesSection({ onRoles }: { onRoles: (roles: Role[]) => void }) {
  const { t } = useI18n();
  const { can } = useAuth();
  const [roles, setRoles] = useState<Role[]>([]);
  const [meta, setMeta] = useState<MetaInfo | null>(null);
  const [editing, setEditing] = useState<{ role: Role | null } | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    const data = await getAll<Role>("/api/roles/");
    setRoles(data);
    onRoles(data);
  }, [onRoles]);

  useEffect(() => {
    void load();
    void get<MetaInfo>("/api/meta/").then(setMeta);
  }, [load]);

  const remove = async (role: Role) => {
    if (!window.confirm(t("confirmDelete"))) return;
    try {
      await del(`/api/roles/${role.id}/`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <section className="card">
      <header className="card-head">
        <h2>{t("users.roles")}</h2>
        {can("users", "create") && (
          <button className="btn btn-primary" onClick={() => setEditing({ role: null })}>
            + {t("add")}
          </button>
        )}
      </header>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>{t("nameEn")}</th>
              <th>{t("nameAr")}</th>
              <th>{t("roles.users")}</th>
              <th>{t("roles.permissions")}</th>
              <th className="cell-actions">{t("actions")}</th>
            </tr>
          </thead>
          <tbody>
            {roles.map((r) => (
              <tr key={r.id}>
                <td>
                  {r.name_en} {r.is_system && <span className="pill">{t("roles.builtIn")}</span>}
                </td>
                <td dir="rtl">{r.name_ar}</td>
                <td>{r.user_count}</td>
                <td className="muted small">{Object.keys(r.permissions).length}</td>
                <td className="cell-actions">
                  {can("users", "edit") && (
                    <button className="btn btn-small" onClick={() => setEditing({ role: r })}>
                      {t("edit")}
                    </button>
                  )}
                  {can("users", "delete") && !r.is_system && (
                    <button className="btn btn-small btn-danger" onClick={() => void remove(r)}>
                      {t("delete")}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {editing && meta && (
        <RoleEditor
          role={editing.role}
          meta={meta}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void load();
          }}
        />
      )}
    </section>
  );
}

export function Users() {
  const { t, name } = useI18n();
  const [roles, setRoles] = useState<Role[]>([]);
  const onRoles = useCallback((r: Role[]) => setRoles(r), []);
  const roleOptions = roles.map((r) => ({ value: r.id, label: name(r) }));

  return (
    <div className="page">
      <h1>{t("nav.users")}</h1>
      <CrudSection<UserRow>
        title={t("users.users")}
        endpoint="/api/users/"
        module="users"
        deleteLabel="deactivate"
        defaults={{ is_active: true, language: "ar", roles: [] }}
        prepare={(v, isNew) => {
          const body = { ...v };
          if (!isNew && !body.password) delete body.password;
          delete body.last_login;
          return body;
        }}
        columns={[
          { label: "username", render: (r) => <span dir="ltr">{r.username}</span> },
          { label: "users.firstName", render: (r) => [r.first_name, r.last_name].filter(Boolean).join(" ") },
          { label: "users.roles.label", render: (r) => r.roles.map((id) => name(roles.find((x) => x.id === id))).join("، ") },
          { label: "users.lastLogin", render: (r) => (r.last_login ? new Date(r.last_login).toLocaleString() : "—") },
          { label: "active", render: (r) => <ActiveBadge value={r.is_active} /> },
        ]}
        fields={[
          { name: "username", label: "username", required: true, dir: "ltr" },
          { name: "first_name", label: "users.firstName" },
          { name: "last_name", label: "users.lastName" },
          { name: "email", label: "email", type: "email", dir: "ltr" },
          { name: "phone", label: "phone", dir: "ltr" },
          { name: "language", label: "language", type: "select", required: true, options: [{ value: "ar", label: "العربية" }, { value: "en", label: "English" }] },
          { name: "password", label: "users.newPassword", type: "password", hint: "users.passwordHint" },
          { name: "roles", label: "users.roles.label", type: "multiselect", options: roleOptions },
          { name: "is_active", label: "active", type: "checkbox" },
        ]}
      />
      <RolesSection onRoles={onRoles} />
    </div>
  );
}
