import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

// Light and dark mode. The choice is kept per browser; until someone picks,
// the app follows the device setting.

export type Theme = "light" | "dark";
const KEY = "erp.theme";

function saved(): Theme | null {
  try {
    const value = window.localStorage.getItem(KEY);
    return value === "light" || value === "dark" ? value : null;
  } catch {
    return null;
  }
}
function system(): Theme {
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}
function apply(theme: Theme) {
  document.documentElement.dataset.theme = theme;
}

// Set before the first render so the page never flashes the wrong colours.
apply(saved() ?? system());

interface ThemeState {
  theme: Theme;
  toggle: () => void;
}
const ThemeContext = createContext<ThemeState | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [choice, setChoice] = useState<Theme | null>(saved);
  const [device, setDevice] = useState<Theme>(system);
  const theme = choice ?? device;

  useEffect(() => {
    const media = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!media) return;
    const onChange = () => setDevice(media.matches ? "dark" : "light");
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);
  useEffect(() => apply(theme), [theme]);

  const toggle = useCallback(() => {
    const next: Theme = theme === "dark" ? "light" : "dark";
    try {
      window.localStorage.setItem(KEY, next);
    } catch {
      /* storage blocked */
    }
    // Fade colours across the whole page instead of snapping.
    document.documentElement.classList.add("theme-fade");
    window.setTimeout(() => document.documentElement.classList.remove("theme-fade"), 400);
    setChoice(next);
  }, [theme]);

  const value = useMemo(() => ({ theme, toggle }), [theme, toggle]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used inside ThemeProvider");
  return ctx;
}
