import { useEffect, useRef, useState, type CSSProperties } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { get } from "../api";
import { useAuth } from "../auth";
import { useI18n, type TKey } from "../i18n";
import { useTheme } from "../theme";
import { AnimatedLogo } from "./AnimatedLogo";
import { Icon, type IconName } from "./Icon";

interface NavItem {
  to: string;
  label: TKey;
  icon: IconName;
  module?: string;
}

// One slot per module. Modules still to come show as "soon".
const WORK: NavItem[] = [
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

/** Small counts on the sidebar: patients waiting, notes to sign, lab work needing this user. */
function useBadges() {
  const { can } = useAuth();
  const [badges, setBadges] = useState<Record<string, number>>({});
  useEffect(() => {
    const load = () => {
      if (can("appointments"))
        get<{ waiting: unknown[] }>("/api/appointments/queue/")
          .then((q) => setBadges((b) => ({ ...b, "/appointments": q.waiting.length })))
          .catch(() => undefined);
      if (can("lab"))
        get<{ attention: number }>("/api/lab/summary/")
          .then((s) => setBadges((b) => ({ ...b, "/lab": s.attention })))
          .catch(() => undefined);
      if (can("clinical", "approve"))
        get<unknown[]>("/api/clinical/visit-notes/?unsigned=1")
          .then((rows) => setBadges((b) => ({ ...b, "/clinical": rows.length })))
          .catch(() => undefined);
    };
    load();
    const timer = window.setInterval(load, 60_000);
    return () => window.clearInterval(timer);
  }, [can]);
  return badges;
}

function greetingKey(): TKey {
  const hour = new Date().getHours();
  return hour < 12 ? "greet.morning" : hour < 17 ? "greet.afternoon" : "greet.evening";
}

export function Layout() {
  const { t, lang, name } = useI18n();
  const { me, can, logout, changeLanguage } = useAuth();
  const { theme, toggle } = useTheme();
  const navigate = useNavigate();
  const location = useLocation();
  const badges = useBadges();
  // On desktop the sidebar is an icon rail that opens over the page while the
  // pointer (or keyboard focus) is on it. A short delay stops it flashing open
  // when the pointer only passes over.
  const [peek, setPeek] = useState(false);
  const peekTimer = useRef<number>();
  const collapsed = !peek;
  const [open, setOpen] = useState(false);
  const visible = (items: NavItem[]) => items.filter((i) => !i.module || can(i.module));
  const displayName = me ? [me.first_name, me.last_name].filter(Boolean).join(" ") || me.username : "";
  const firstName = me?.first_name || displayName;
  const roleNames = me?.roles.map((r) => name(r)).join(" · ");

  // Close the phone menu after moving to another page.
  useEffect(() => setOpen(false), [location.pathname]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const openPeek = (delay: number) => {
    window.clearTimeout(peekTimer.current);
    peekTimer.current = window.setTimeout(() => setPeek(true), delay);
  };
  const closePeek = () => {
    window.clearTimeout(peekTimer.current);
    setPeek(false);
  };
  useEffect(() => () => window.clearTimeout(peekTimer.current), []);
  useEffect(() => closePeek(), [location.pathname]);

  let index = 0;
  const link = (item: NavItem) => {
    const badge = badges[item.to];
    return (
      <NavLink
        key={item.to}
        to={item.to}
        end={item.to === "/"}
        className="nav-link"
        title={collapsed ? t(item.label) : undefined}
        style={{ "--i": index++ } as CSSProperties}
      >
        <span className="nav-icon">
          <Icon name={item.icon} />
        </span>
        <span className="nav-text">{t(item.label)}</span>
        {badge ? (
          <span className="nav-badge" aria-label={t("nav.badge", { n: badge })}>
            {badge}
          </span>
        ) : null}
      </NavLink>
    );
  };

  const date = new Date().toLocaleDateString(lang === "ar" ? "ar-EG" : "en-GB", { weekday: "long", day: "numeric", month: "long" });

  return (
    <div className={`shell is-rail ${collapsed ? "is-collapsed" : "is-peek"} ${open ? "menu-open" : ""}`}>
      <div className="sidebar-scrim" onClick={() => setOpen(false)} aria-hidden="true" />
      <aside
        className="sidebar"
        id="sidebar"
        onMouseEnter={() => openPeek(140)}
        onMouseLeave={closePeek}
        onFocus={() => openPeek(0)}
        onBlur={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && closePeek()}
      >
        <div className="brand">
          <div className="brand-mark">
            <AnimatedLogo tone="dark" />
          </div>
          <div className="brand-text">
            <strong>{me?.clinic ? name(me.clinic) : t("appName")}</strong>
            <span className="brand-sub">Clinic ERP</span>
          </div>
          <button className="side-icon-btn close-btn" onClick={() => setOpen(false)} aria-label={t("close")}>
            <Icon name="close" size={18} />
          </button>
        </div>

        <div className="greeting">
          <p className="greeting-hello">{t(greetingKey(), { name: firstName })}</p>
          <p className="greeting-date">{date}</p>
        </div>

        <nav aria-label="Main" className="side-nav">
          <p className="nav-group">{t("group.work")}</p>
          {visible(WORK).map(link)}
          {visible(SETUP).length > 0 && <p className="nav-group">{t("group.setup")}</p>}
          {visible(SETUP).map(link)}
          <p className="nav-group">{t("comingLater")}</p>
          {LATER.map((item) => (
            <span key={item.to} className="nav-link nav-disabled" aria-disabled="true" title={collapsed ? t(item.label) : undefined} style={{ "--i": index++ } as CSSProperties}>
              <span className="nav-icon">
                <Icon name={item.icon} />
              </span>
              <span className="nav-text">{t(item.label)}</span>
              <span className="nav-soon">{t("nav.soon")}</span>
            </span>
          ))}
        </nav>

        <div className="side-user">
          <div className="avatar" aria-hidden="true">
            {displayName.slice(0, 1).toUpperCase()}
          </div>
          <div className="user-text">
            <strong>{displayName}</strong>
            <span>{roleNames}</span>
          </div>
          <button className="side-icon-btn" onClick={logout} aria-label={t("signOut")} title={t("signOut")}>
            <Icon name="logout" size={18} />
          </button>
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <button className="btn btn-icon menu-btn" onClick={() => setOpen(true)} aria-label={t("nav.menu")} aria-controls="sidebar" aria-expanded={open}>
            <Icon name="menu" />
          </button>
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
          <ThemeButton theme={theme} onToggle={toggle} />
          <div className="segmented" role="group" aria-label={t("language")}>
            <button aria-pressed={lang === "en"} onClick={() => changeLanguage("en")} lang="en">
              English
            </button>
            <button aria-pressed={lang === "ar"} onClick={() => changeLanguage("ar")} lang="ar">
              العربية
            </button>
          </div>
        </header>
        <main className="content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

export function ThemeButton({ theme, onToggle }: { theme: string; onToggle: () => void }) {
  const { t } = useI18n();
  const label = theme === "dark" ? t("theme.toLight") : t("theme.toDark");
  return (
    <button type="button" className="btn btn-icon theme-btn" onClick={onToggle} aria-label={label} title={label}>
      <span className={`theme-icons ${theme}`} aria-hidden="true">
        <Icon name="sun" className="theme-sun" />
        <Icon name="moon" className="theme-moon" />
      </span>
    </button>
  );
}
