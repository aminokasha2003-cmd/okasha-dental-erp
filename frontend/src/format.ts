export function locale(lang: string) {
  return lang === "ar" ? "ar-EG" : "en-GB";
}
export function fmtDate(iso: string, lang: string) {
  return new Date(iso.length === 10 ? `${iso}T12:00:00` : iso).toLocaleDateString(locale(lang), { day: "numeric", month: "short", year: "numeric" });
}
export function money(value: string | number, lang: string) {
  return Number(value).toLocaleString(locale(lang), { maximumFractionDigits: 2 });
}
