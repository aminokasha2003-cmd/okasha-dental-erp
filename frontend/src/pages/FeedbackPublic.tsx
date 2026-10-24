import { useEffect, useState } from "react";
import { useI18n } from "../i18n";

interface Info {
  clinic: { ar: string; en: string };
  name: { ar: string; en: string };
  language: string;
  dentist: { ar: string; en: string } | null;
  visit_date: string | null;
  answered: boolean;
}

/** The patient's own page from a feedback link: no login, the token is the key. */
export function FeedbackPublic({ token }: { token: string }) {
  const { t, lang, setLang } = useI18n();
  const [info, setInfo] = useState<Info | null>(null);
  const [missing, setMissing] = useState(false);
  const [score, setScore] = useState(0);
  const [comment, setComment] = useState("");
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");
  const url = `/api/crm/public/feedback/${encodeURIComponent(token)}/`;
  useEffect(() => {
    fetch(url)
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((d: Info) => {
        setInfo(d);
        if (d.language === "en" || d.language === "ar") setLang(d.language);
      })
      .catch(() => setMissing(true));
  }, [url, setLang]);
  const send = async () => {
    setError("");
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ score, comment }) });
    if (r.ok) setDone(true);
    else setError(t("fb.pub.error"));
  };
  const pick = (n: { ar: string; en: string } | null | undefined) => (n ? (lang === "ar" ? n.ar || n.en : n.en || n.ar) : "");
  const labels = [t("fb.pub.s1"), t("fb.pub.s2"), t("fb.pub.s3"), t("fb.pub.s4"), t("fb.pub.s5")];
  return (
    <div className="login-page feedback-page">
      <div className="card login-card feedback-card">
        <img src="/brand/logo.svg" alt="" className="feedback-logo" />
        <button type="button" className="btn btn-small lang-switch" onClick={() => setLang(lang === "ar" ? "en" : "ar")}>{lang === "ar" ? "English" : "عربي"}</button>
        {missing ? (
          <p>{t("fb.pub.missing")}</p>
        ) : !info ? (
          <p className="muted">{t("loading")}</p>
        ) : done || info.answered ? (
          <>
            <h1>{t("fb.pub.thanks")}</h1>
            <p className="muted">{t("fb.pub.thanksSub", { clinic: pick(info.clinic) })}</p>
          </>
        ) : (
          <>
            <h1>{t("fb.pub.hello", { name: pick(info.name) })}</h1>
            <p className="muted">
              {t("fb.pub.ask", { clinic: pick(info.clinic) })}
              {info.dentist ? ` ${t("fb.pub.with", { dentist: pick(info.dentist) })}` : ""}
            </p>
            <div className="star-picker big" role="radiogroup" aria-label={t("crm.fb.score")}>
              {[1, 2, 3, 4, 5].map((n) => (
                <button key={n} type="button" role="radio" aria-checked={score === n} aria-label={labels[n - 1]} className={n <= score ? "on" : ""} onClick={() => setScore(n)}>★</button>
              ))}
            </div>
            <p className="star-caption">{score ? labels[score - 1] : " "}</p>
            <label className="field">
              <span className="field-label">{t("fb.pub.comment")}</span>
              <textarea rows={3} value={comment} onChange={(e) => setComment(e.target.value)} />
            </label>
            {error && <p className="form-error" role="alert">{error}</p>}
            <button className="btn btn-primary" disabled={!score} onClick={() => void send()}>{t("fb.pub.send")}</button>
          </>
        )}
      </div>
    </div>
  );
}
