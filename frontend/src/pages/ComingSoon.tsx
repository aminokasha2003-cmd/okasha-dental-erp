import { useI18n, type TKey } from "../i18n";

export function ComingSoon({ title, phase }: { title: TKey; phase: number }) {
  const { t } = useI18n();
  return (
    <div className="page">
      <h1>{t(title)}</h1>
      <section className="card pad empty-state">
        <p className="lead">{t("comingInPhase", { phase })}</p>
        <p className="muted">{t("comingInPhaseHint")}</p>
      </section>
    </div>
  );
}

export function NoAccess() {
  const { t } = useI18n();
  return (
    <div className="page">
      <section className="card pad empty-state">
        <p className="lead">{t("noAccess")}</p>
      </section>
    </div>
  );
}
