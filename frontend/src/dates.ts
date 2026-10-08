// Dates in the clinic's local time. The calendar works in whole local days.

const pad = (n: number) => String(n).padStart(2, "0");

/** "2026-10-08" for a Date, in local time. */
export function isoDay(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T12:00:00`);
  d.setDate(d.getDate() + n);
  return isoDay(d);
}

/** Minutes since midnight for "HH:MM[:SS]" or a Date. */
export function minutesOf(value: string | Date): number {
  if (typeof value === "string") {
    const [h, m] = value.split(":").map(Number);
    return h * 60 + m;
  }
  return value.getHours() * 60 + value.getMinutes();
}

export function hhmm(minutes: number): string {
  return `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
}

/** Local time of an ISO timestamp, "14:30". */
export function timeOf(iso: string): string {
  return hhmm(minutesOf(new Date(iso)));
}

/** Monday = 0, matching the server's working hours. */
export function weekdayOf(day: string): number {
  return (new Date(`${day}T12:00:00`).getDay() + 6) % 7;
}

/** ISO timestamp with the browser's offset for a local day and time. */
export function localIso(day: string, time: string): string {
  return new Date(`${day}T${time}:00`).toISOString();
}

export function formatDay(day: string, lang: string): string {
  return new Date(`${day}T12:00:00`).toLocaleDateString(lang === "ar" ? "ar-EG" : "en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

export function formatDateTime(iso: string, lang: string): string {
  return new Date(iso).toLocaleString(lang === "ar" ? "ar-EG" : "en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
