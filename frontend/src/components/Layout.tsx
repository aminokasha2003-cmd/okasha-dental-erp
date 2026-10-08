import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { useAuth } from "../auth";
import { useI18n, type TKey } from "../i18n";
import { AnimatedLogo } from "./AnimatedLogo";
import { Icon, type IconName } from "./Icon";

interface NavItem {
  to: string;
  label: TKey;
  icon: IconName;
  module?: string;
}

// One slot per module. Phases 1 to 4 already have a page that says when they arrive.
const VERSION_1: NavItem[] = [
  { to: "/", label: "nav.home", icon: "home" },
  { to: "/patients", label: "nav.patients", icon: "patients", module: "patients" },
  { to: "/appointments", label: "nav.appointments", icon: "calendar", module: "appointments" },
  { to: "/clinical", label: "nav.clinical", icon: "tooth", module: "clinical" },
  { to: "/billing", label: "nav.billing", icon: "receipt", module: "billing" },
  { to: "/lab", label: "nav.lab", icon: "flask", module: "lab" },
];

const SETUP: NavItem[] = [
  { to: "/settings", label: "nav.settings", icon: "building", module: "settings" },
  { to: "/users", label: "nav.users", icon: "key", module: "users" },
  { to: "/staff", label: "nav.staff", icon: "badge", module: "masterdata" },
  { to: "/procedures", label: "nav.procedures", icon: "list", module: "masterdata" },
  { to: "/audit", label: "nav.audit", icon: "history", module: "audit" },
];

const LATER: NavItem[] = [
  { to: "/inventory", label: "nav.inventory", icon: "box" },
  { to: "/payroll", label: "nav.payroll", icon: "badge" },
  { to: "/crm", label: "nav.crm", icon: "chart" },
];

export function Layout() {
  const { t, lang, name } = useI18n();
  const { me, can, logout, changeLanguage } = useAuth();
  const navigate = useNavigate();
  const visible = (items: NavItem[]) => items.filter((i) => !i.module || can(i.module));
  const displayName = me ? [me.first_name, me.last_name].filter(Boolean).join(" ") || me.username : "";
  const roleNames = me?.roles.map((r) => name(r)).join(" · ");

  const link = (item: NavItem) => (
    <NavLink key={item.to} to={item.to} end={item.to === "/"} className="nav-link">
      <Icon name={item.icon} />
      <span>{t(item.label)}</span>
    </NavLink>
  );

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">
            <AnimatedLogo tone="dark" />
          </div>
          <div className="brand-text">
            <strong>{me?.clinic ? name(me.clinic) : t("appName")}</strong>
            <span className="brand-sub">Clinic ERP</span>
          </div>
        </div>
        <nav aria-label="Main">
          <p className="nav-group">{t("version1")}</p>
          {visible(VERSION_1).map(link)}
          {visible(SETUP).length > 0 && <p className="nav-group">{t("group.setup")}</p>}
          {visible(SETUP).map(link)}
          <p className="nav-group">{t("comingLater")}</p>
          {LATER.map((item) => (
            <span key={item.to} className="nav-link nav-disabled" aria-disabled="true">
              <Icon name={item.icon} />
              <span>{t(item.label)}</span>
            </span>
          ))}
        </nav>
      </aside>
      <div className="main">
        <header className="topbar">
          {can("patients") ? (
            <form
              className="top-search"
              role="search"
              onSubmit={(e) => {
                e.preventDefault();
                const value = new FormData(e.currentTarget).get("q")?.toString() ?? "";
                navigate(`/patients?search=${encodeURIComponent(value)}`);
              }}
            >
              <Icon name="search" />
              <input name="q" type="search" aria-label={t("search")} placeholder={t("pt.searchHint")} />
            </form>
          ) : null}
          <div className="topbar-spacer" />
          <div className="segmented" role="group" aria-label={t("language")}>
            <button aria-pressed={lang === "en"} onClick={() => changeLanguage("en")} lang="en">
              English
            </button>
            <button aria-pressed={lang === "ar"} onClick={() => changeLanguage("ar")} lang="ar">
              العربية
            </button>
          </div>
          <div className="user-chip">
            <div className="avatar" aria-hidden="true">
              {displayName.slice(0, 1).toUpperCase()}
            </div>
            <div className="user-text">
              <strong>{displayName}</strong>
              <span className="muted">{roleNames}</span>
            </div>
          </div>
          <button className="btn" onClick={logout}>
            {t("signOut")}
          </button>
        </header>
        <main className="content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
