// Small fetch wrapper: adds the JWT, refreshes it once when it expires, and
// turns Django REST Framework errors into readable messages.

const ACCESS = "erp.access";
const REFRESH = "erp.refresh";

export class ApiError extends Error {
  status: number;
  fields: Record<string, string[]>;
  constructor(status: number, message: string, fields: Record<string, string[]> = {}) {
    super(message);
    this.status = status;
    this.fields = fields;
  }
}

export interface Page<T> {
  count: number;
  next: string | null;
  previous: string | null;
  results: T[];
}

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export const tokens = {
  get access() {
    return storage()?.getItem(ACCESS) ?? null;
  },
  get refresh() {
    return storage()?.getItem(REFRESH) ?? null;
  },
  set(access: string, refresh?: string) {
    storage()?.setItem(ACCESS, access);
    if (refresh) storage()?.setItem(REFRESH, refresh);
  },
  clear() {
    storage()?.removeItem(ACCESS);
    storage()?.removeItem(REFRESH);
  },
};

let onLoggedOut: () => void = () => {};
export function setLoggedOutHandler(fn: () => void) {
  onLoggedOut = fn;
}

async function refreshAccess(): Promise<boolean> {
  const refresh = tokens.refresh;
  if (!refresh) return false;
  const res = await fetch("/api/auth/refresh/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refresh }),
  });
  if (!res.ok) return false;
  const data = await res.json();
  tokens.set(data.access, data.refresh);
  return true;
}

function flattenErrors(data: unknown): { message: string; fields: Record<string, string[]> } {
  if (!data || typeof data !== "object") return { message: String(data ?? ""), fields: {} };
  if (Array.isArray(data)) return { message: data.join(" "), fields: {} };
  const obj = data as Record<string, unknown>;
  if (typeof obj.detail === "string") return { message: obj.detail, fields: {} };
  const fields: Record<string, string[]> = {};
  const messages: string[] = [];
  for (const [key, value] of Object.entries(obj)) {
    const list = Array.isArray(value) ? value.map(String) : [typeof value === "object" ? JSON.stringify(value) : String(value)];
    if (key === "non_field_errors") messages.push(...list);
    else fields[key] = list;
  }
  if (!messages.length) messages.push(...Object.entries(fields).map(([k, v]) => `${k}: ${v.join(" ")}`));
  return { message: messages.join(" "), fields };
}

export async function api<T = unknown>(path: string, options: RequestInit = {}, retry = true): Promise<T> {
  const headers = new Headers(options.headers);
  const isForm = options.body instanceof FormData;
  if (options.body && !isForm && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  if (tokens.access) headers.set("Authorization", `Bearer ${tokens.access}`);
  const res = await fetch(path.startsWith("/") ? path : `/api/${path}`, { ...options, headers });
  if (res.status === 401 && retry && tokens.refresh) {
    if (await refreshAccess()) return api<T>(path, options, false);
    tokens.clear();
    onLoggedOut();
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const data = text ? JSON.parse(text) : undefined;
  if (!res.ok) {
    const { message, fields } = flattenErrors(data);
    throw new ApiError(res.status, message || res.statusText, fields);
  }
  return data as T;
}

export const get = <T>(path: string) => api<T>(path);
export const post = <T>(path: string, body: unknown) =>
  api<T>(path, { method: "POST", body: body instanceof FormData ? body : JSON.stringify(body) });
export const patch = <T>(path: string, body: unknown) => api<T>(path, { method: "PATCH", body: JSON.stringify(body) });
export const del = (path: string) => api<void>(path, { method: "DELETE" });

/** Fetch every page of a list endpoint (master data lists are small). */
export async function getAll<T>(path: string): Promise<T[]> {
  const out: T[] = [];
  let url: string | null = path;
  while (url) {
    const page: Page<T> = await get<Page<T>>(url);
    out.push(...page.results);
    url = page.next ? new URL(page.next).pathname + new URL(page.next).search : null;
  }
  return out;
}

/** Download a protected file with the token and open it in a new tab. */
export async function openProtectedFile(path: string) {
  const headers: HeadersInit = tokens.access ? { Authorization: `Bearer ${tokens.access}` } : {};
  const res = await fetch(path, { headers });
  if (!res.ok) throw new ApiError(res.status, res.statusText);
  const url = URL.createObjectURL(await res.blob());
  window.open(url, "_blank", "noopener");
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
