import { useState, type FormEvent } from "react";
import { useAuth } from "../auth";
import { useI18n } from "../i18n";
import { Icon } from "../components/Icon";

export function Login() {
  const { t, lang, setLang } = useI18n();
  const { login } = useAuth();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await login(username, password);
    } catch {
      setError(t("signInFailed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-page">
      <form className="card login-card" onSubmit={submit}>
        <div className="login-head">
          <div className="brand-mark">
            <Icon name="tooth" size={26} />
          </div>
          <h1>{t("appName")}</h1>
        </div>
        <div className="field">
          <label htmlFor="username">{t("username")}</label>
          <input id="username" autoComplete="username" dir="ltr" value={username} onChange={(e) => setUsername(e.target.value)} required />
        </div>
        <div className="field">
          <label htmlFor="password">{t("password")}</label>
          <input id="password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </div>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <button className="btn btn-primary btn-block" disabled={busy}>
          {t("signIn")}
        </button>
        <div className="segmented center" role="group" aria-label={t("language")}>
          <button type="button" aria-pressed={lang === "en"} onClick={() => setLang("en")} lang="en">
            English
          </button>
          <button type="button" aria-pressed={lang === "ar"} onClick={() => setLang("ar")} lang="ar">
            العربية
          </button>
        </div>
      </form>
    </div>
  );
}
