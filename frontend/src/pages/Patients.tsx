import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { get, getAll, post, type Page } from "../api";
import { useAuth } from "../auth";
import { useI18n } from "../i18n";
import { Modal, RecordForm, type Option } from "../components/Crud";
import { PATIENT_DEFAULTS, cleanPatient, patientFields } from "../components/patientFields";
import type { Branch, Patient, StaffMember } from "../types";

export function AlertPills({ alerts }: { alerts: { id?: number; text: string }[] | string[] }) {
  return (
    <span className="alert-pills">
      {alerts.map((a, i) => (
        <span key={i} className="pill pill-alert">
          ⚠ {typeof a === "string" ? a : a.text}
        </span>
      ))}
    </span>
  );
}

/** Branch and dentist choices used by patient and appointment forms. */
export function useChoices() {
  const { name } = useI18n();
  const { can } = useAuth();
  const [branches, setBranches] = useState<Branch[]>([]);
  const [dentists, setDentists] = useState<StaffMember[]>([]);
  useEffect(() => {
    if (!can("masterdata")) return;
    getAll<Branch>("/api/masterdata/branches/?is_active=true").then(setBranches).catch(() => undefined);
    getAll<StaffMember>("/api/masterdata/staff/?staff_type=dentist&is_active=true").then(setDentists).catch(() => undefined);
  }, [can]);
  const options = (rows: { id: number; name_en: string; name_ar: string }[]): Option[] => rows.map((r) => ({ value: r.id, label: name(r) }));
  return { branches, dentists, branchOptions: options(branches), dentistOptions: options(dentists) };
}

export function patientName(p: { name_ar: string; name_en: string }, lang: string) {
  return (lang === "ar" ? p.name_ar || p.name_en : p.name_en || p.name_ar) || "—";
}

export function Patients() {
  const { t, lang } = useI18n();
  const { can } = useAuth();
  const navigate = useNavigate();
  const { branchOptions, dentistOptions } = useChoices();
  const [search, setSearch] = useState("");
  const [showClosed, setShowClosed] = useState(false);
  const [page, setPage] = useState<Page<Patient> | null>(null);
  const [rows, setRows] = useState<Patient[]>([]);
  const [error, setError] = useState("");
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    // Wait a moment after typing stops before searching.
    const timer = window.setTimeout(() => {
      const params = new URLSearchParams({ search, is_active: showClosed ? "" : "true" });
      get<Page<Patient>>(`/api/patients/?${params}`)
        .then((data) => {
          setPage(data);
          setRows(data.results);
          setError("");
        })
        .catch((err) => setError(String(err.message ?? err)));
    }, 250);
    return () => window.clearTimeout(timer);
  }, [search, showClosed]);

  const loadMore = async () => {
    if (!page?.next) return;
    const url = new URL(page.next);
    const data = await get<Page<Patient>>(url.pathname + url.search);
    setPage(data);
    setRows((r) => [...r, ...data.results]);
  };

  const create = async (values: Record<string, unknown>) => {
    const patient = await post<Patient>("/api/patients/", cleanPatient(values));
    navigate(`/patients/${patient.id}`);
  };

  return (
    <div className="page">
      <h1>{t("pt.title")}</h1>
      <section className="card">
        <header className="card-head">
          <div className="field search-field">
            <input
              type="search"
              aria-label={t("search")}
              placeholder={t("pt.searchHint")}
              value={search}
              autoFocus
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <div className="toolbar">
            <label className="check-inline">
              <input type="checkbox" checked={showClosed} onChange={(e) => setShowClosed(e.target.checked)} />
              {t("pt.showClosed")}
            </label>
            {can("patients", "create") && (
              <button className="btn btn-primary" onClick={() => setAdding(true)}>
                + {t("pt.new")}
              </button>
            )}
          </div>
        </header>
        {error && <p className="form-error" role="alert">{error}</p>}
        {page === null ? (
          <p className="muted pad">{t("loading")}</p>
        ) : rows.length === 0 ? (
          <p className="muted pad">{t("noRecords")}</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{t("pt.fileNo")}</th>
                  <th>{t("pt.name")}</th>
                  <th>{t("pt.mobile")}</th>
                  <th>{t("pt.age")}</th>
                  <th>{t("pt.alerts")}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => (
                  <tr key={p.id} className="row-link" onClick={() => navigate(`/patients/${p.id}`)}>
                    <td className="num nowrap">{p.file_number}</td>
                    <td>
                      <Link to={`/patients/${p.id}`} onClick={(e) => e.stopPropagation()}>
                        {patientName(p, lang)}
                      </Link>
                      {!p.is_active && <span className="pill" style={{ marginInlineStart: 8 }}>{t("pt.closed")}</span>}
                    </td>
                    <td dir="ltr" className="num nowrap cell-start">{p.phone}</td>
                    <td className="num">{p.age ?? ""}</td>
                    <td><AlertPills alerts={p.alerts} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {page?.next && (
          <div className="pad center">
            <button className="btn" onClick={() => void loadMore()}>{t("loadMore")}</button>
          </div>
        )}
      </section>
      {adding && (
        <Modal title={t("pt.new")} onClose={() => setAdding(false)}>
          <RecordForm
            fields={patientFields(t, { branches: branchOptions, dentists: dentistOptions })}
            initial={{ ...PATIENT_DEFAULTS }}
            isNew
            onSubmit={create}
            onCancel={() => setAdding(false)}
          />
        </Modal>
      )}
    </div>
  );
}
