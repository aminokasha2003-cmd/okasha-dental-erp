// Export a dashboard or report to a PDF file. The page is drawn as an image in the
// light theme (so Arabic text keeps its shaping) and split across A4 pages.
// The libraries load only when someone exports.

export async function exportPdf(element: HTMLElement, filename: string, options: { landscape?: boolean } = {}) {
  const [{ default: html2canvas }, { jsPDF }] = await Promise.all([import("html2canvas"), import("jspdf")]);
  const canvas = await html2canvas(element, {
    scale: 2,
    useCORS: true,
    backgroundColor: "#ffffff",
    windowWidth: Math.max(element.scrollWidth, 1100),
    onclone: (doc, clone) => {
      doc.documentElement.dataset.theme = "light";
      doc.body.classList.add("pdf-mode");
      clone.classList.add("pdf-root");
    },
  });
  const pdf = new jsPDF({ orientation: options.landscape ? "landscape" : "portrait", unit: "mm", format: "a4" });
  const pageW = pdf.internal.pageSize.getWidth();
  const pageH = pdf.internal.pageSize.getHeight();
  const margin = 10;
  const width = pageW - margin * 2;
  const pxPerMm = canvas.width / width;
  const sliceH = Math.floor((pageH - margin * 2) * pxPerMm);
  let y = 0;
  let page = 0;
  while (y < canvas.height) {
    const h = Math.min(sliceH, canvas.height - y);
    const part = document.createElement("canvas");
    part.width = canvas.width;
    part.height = h;
    part.getContext("2d")!.drawImage(canvas, 0, y, canvas.width, h, 0, 0, canvas.width, h);
    if (page > 0) pdf.addPage();
    pdf.addImage(part.toDataURL("image/jpeg", 0.92), "JPEG", margin, margin, width, h / pxPerMm);
    y += h;
    page += 1;
  }
  pdf.save(filename.endsWith(".pdf") ? filename : `${filename}.pdf`);
}
