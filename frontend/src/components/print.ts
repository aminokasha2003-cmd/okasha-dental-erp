import { useAuth } from "../auth";
import type { TKey } from "../i18n";
import { fmtDate } from "../format";
import { patientName } from "../pages/Patients";
import type { Patient } from "../types";

// Printable pages (prescriptions, consent forms, invoices, receipts) on the clinic letterhead.


export function escapeHtml(text: string) {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** Open a printable page in a new window: clinic letterhead, patient line, body. */
export function printDocument({ title, lang, clinic, patient, body, footer }: { title: string; lang: string; clinic: { name: string; address: string; phone: string }; patient: string; body: string; footer: string }) {
  const win = window.open("", "_blank");
  if (!win) return;
  const dir = lang === "ar" ? "rtl" : "ltr";
  win.document.write(`<!doctype html><html lang="${lang}" dir="${dir}"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;600&family=IBM+Plex+Sans+Arabic:wght@400;600&family=Outfit:wght@600&display=swap" rel="stylesheet">
<style>
body{font-family:"IBM Plex Sans","IBM Plex Sans Arabic",system-ui,sans-serif;color:#16242F;margin:32px;font-size:14px;line-height:1.55}
header{display:flex;justify-content:space-between;align-items:center;border-bottom:2px solid #446681;padding-bottom:12px;margin-bottom:18px;gap:16px}
header img{height:56px}.clinic{text-align:end;font-size:12px;color:#3A4B5A}.clinic strong{font-family:Outfit,"IBM Plex Sans Arabic",sans-serif;font-size:18px;color:#16242F;display:block}
h1{font-family:Outfit,"IBM Plex Sans Arabic",sans-serif;font-size:22px;margin:0 0 8px}.patient{color:#3A4B5A;margin:0 0 18px}
table{width:100%;border-collapse:collapse}th,td{text-align:start;padding:8px;border-bottom:1px solid #DCE4EB;vertical-align:top}th{font-size:12px;color:#5A6B7B}
.rx{font-family:Outfit,serif;font-size:28px;color:#446681}.body{white-space:pre-wrap}.sign{margin-top:36px;display:flex;justify-content:space-between;gap:24px;align-items:flex-end}
.sign img{max-height:110px;display:block}.line{border-top:1px solid #16242F;min-width:220px;padding-top:4px;font-size:12px;color:#3A4B5A}
@media print{body{margin:12mm}}
</style></head><body>
<header><img src="${window.location.origin}/brand/logo.svg" alt=""><div class="clinic"><strong>${escapeHtml(clinic.name)}</strong>${escapeHtml(clinic.address)}<br><span dir="ltr">${escapeHtml(clinic.phone)}</span></div></header>
<h1>${escapeHtml(title)}</h1><p class="patient">${patient}</p>${body}${footer}
<script>window.onload=function(){setTimeout(function(){window.print()},300)}</script></body></html>`);
  win.document.close();
}

export function useLetterhead(lang: string) {
  const { me } = useAuth();
  const c = me?.clinic;
  return {
    name: (lang === "ar" ? c?.name_ar || c?.name_en : c?.name_en || c?.name_ar) ?? "",
    address: (lang === "ar" ? c?.address_ar || c?.address_en : c?.address_en || c?.address_ar) ?? "",
    phone: c?.phone ?? "",
  };
}

export function patientLine(patient: Patient, lang: string, t: (key: TKey, vars?: Record<string, string | number>) => string, date: string) {
  return [escapeHtml(patientName(patient, lang)), escapeHtml(patient.file_number), patient.age !== null ? escapeHtml(t("pt.years", { n: patient.age })) : "", escapeHtml(fmtDate(date, lang))]
    .filter(Boolean)
    .join(" · ");
}

