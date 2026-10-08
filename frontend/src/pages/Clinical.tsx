import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { get } from "../api";
import { useI18n } from "../i18n";
import { CrudSection } from "../components/Crud";
import type { ConsentTemplate, PatientInfo, TreatmentPlan, VisitNote } from "../types";
import { fmtDate, money } from "./PatientClinical";

/** Clinical work list: unsigned notes, plans in progress, consent templates. */
export function Clinical() {
  const { t, lang } = useI18n();
  const [notes, setNotes] = useState<VisitNote[] | null>(null);
  const [plans, setPlans] = useState<TreatmentPlan[] | null>(null);

  useEffect(() => {
    get<VisitNote[]>("/api/clinical/visit-notes/?unsigned=1").then(setNotes).catch(() => setNotes([]));
    get<TreatmentPlan[]>("/api/clinical/plans/?status=accepted,in_progress").then(setPlans).catch(() => setPlans([]));
  }, []);

  const who = (p: PatientInfo) => (
    <Link to={`/patients/${p.id}`} className="row-link">
      {(lang === "ar" ? p.ar || p.en : p.en || p.ar) || p.file_number} <span className="muted mono small">{p.file_number}</span>
    </Link>
  );
  const staff = (n: { ar: string; en: string } | null) => (n ? (lang === "ar" ? n.ar || n.en : n.en || n.ar) : "");

  return (
    <div className="page">
      <h1>{t("cl.title")}</h1>
      <div className="two-col">
        <section className="card">
          <header className="card-head">
            <h2>{t("cl.toSign")}</h2>
          </header>
          {notes === null ? (
            <p className="muted pad">{t("loading")}</p>
          ) : notes.length === 0 ? (
            <p className="muted pad">{t("cl.toSignEmpty")}</p>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>{t("note.date")}</th>
                    <th>{t("cl.patient")}</th>
                    <th>{t("cl.dentist")}</th>
                  </tr>
                </thead>
                <tbody>
                  {notes.map((n) => (
                    <tr key={n.id}>
                      <td className="nowrap">{fmtDate(n.visit_date, lang)}</td>
                      <td>{who(n.patient_info)}</td>
                      <td>{staff(n.dentist_name)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
        <section className="card">
          <header className="card-head">
            <h2>{t("cl.activePlans")}</h2>
          </header>
          {plans === null ? (
            <p className="muted pad">{t("loading")}</p>
          ) : plans.length === 0 ? (
            <p className="muted pad">{t("cl.activePlansEmpty")}</p>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>{t("cl.patient")}</th>
                    <th>{t("plan.progress")}</th>
                    <th className="num">{t("cl.remaining")}</th>
                  </tr>
                </thead>
                <tbody>
                  {plans.map((p) => (
                    <tr key={p.id}>
                      <td>
                        {who(p.patient_info)}
                        <p className="muted small">{[p.title, staff(p.dentist_name)].filter(Boolean).join(" · ")}</p>
                      </td>
                      <td className="nowrap">{t("plan.doneOf", { done: p.totals.done_count, n: p.totals.count })}</td>
                      <td className="num">{money(Number(p.totals.total) - Number(p.totals.done), lang)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
      <CrudSection<ConsentTemplate & Record<string, unknown>>
        title={t("consent.templates")}
        endpoint="/api/clinical/consent-templates/"
        module="clinical"
        columns={[
          { label: "consent.titleEn", render: (r) => r.title_en },
          { label: "consent.titleAr", render: (r) => <span dir="rtl">{r.title_ar}</span> },
          { label: "active", render: (r) => (r.is_active ? t("yes") : t("no")) },
        ]}
        fields={[
          { name: "title_en", label: "consent.titleEn", dir: "ltr" },
          { name: "title_ar", label: "consent.titleAr", dir: "rtl" },
          { name: "body_en", label: "consent.bodyEn", type: "textarea", dir: "ltr" },
          { name: "body_ar", label: "consent.bodyAr", type: "textarea", dir: "rtl" },
          { name: "is_active", label: "active", type: "checkbox" },
        ]}
        defaults={{ is_active: true }}
        deleteLabel="deactivate"
      />
    </div>
  );
}
