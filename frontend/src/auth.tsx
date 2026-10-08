import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { ApiError, get, patch, post, setLoggedOutHandler, tokens } from "./api";
import { useI18n, type Lang } from "./i18n";
import type { Me } from "./types";

interface Auth {
  me: Me | null;
  loading: boolean;
  login: (username: string, password: string) => Promise<void>;
  logout: () => void;
  can: (module: string, action?: string) => boolean;
  changeLanguage: (lang: Lang) => void;
  reload: () => Promise<void>;
}

const AuthContext = createContext<Auth | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const { setLang } = useI18n();
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    if (!tokens.access) {
      setMe(null);
      setLoading(false);
      return;
    }
    try {
      const data = await get<Me>("/api/me/");
      setMe(data);
      setLang(data.language);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) tokens.clear();
      setMe(null);
    } finally {
      setLoading(false);
    }
  }, [setLang]);

  useEffect(() => {
    setLoggedOutHandler(() => setMe(null));
    void reload();
  }, [reload]);

  const login = useCallback(
    async (username: string, password: string) => {
      const data = await post<{ access: string; refresh: string }>("/api/auth/token/", { username, password });
      tokens.set(data.access, data.refresh);
      await reload();
    },
    [reload],
  );

  const logout = useCallback(() => {
    tokens.clear();
    setMe(null);
  }, []);

  const can = useCallback(
    (module: string, action = "view") => Boolean(me?.permissions[module]?.includes(action)),
    [me],
  );

  const changeLanguage = useCallback(
    (lang: Lang) => {
      setLang(lang);
      if (me) {
        setMe({ ...me, language: lang });
        void patch("/api/me/", { language: lang }).catch(() => undefined);
      }
    },
    [me, setLang],
  );

  const value = useMemo(() => ({ me, loading, login, logout, can, changeLanguage, reload }), [me, loading, login, logout, can, changeLanguage, reload]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
