// Fixtures for `bun run ui:preview src/renderer/src/work/slides/preview/DeckPreview.preview.tsx#DeckPreviewPreview --width 1200`:
// each format of a deck's Preview at 1,200 and at 520 wide.
// The deck's and the paper's colours are the picture's, not the app's, so they live here, where the colour guard does not look.
import type { PdfDoc } from "../../pdf/engine";
import { SPONSOR, sponsorDoc } from "../SlidesCanvas.preview.fixtures";

const MOMENTS = [
  ["pptx", "PowerPoint: the file as LibreOffice draws it, with Check in PowerPoint"],
  ["pdf", "PDF of the slides: Layout and Hidden slides, and what a PDF leaves out"],
  ["handouts", "PDF, handouts of 6 a page: Paper joins the rows"],
  ["print", "Print"],
  ["pics", "Pictures: Type and Size"],
  ["video", "Video of the slides: silent, and it says so; Made by where PowerPoint is in reach"],
  ["odp", "OpenDocument, drawn from the .odp"],
] as const;

export default [1200, 520].flatMap((width) => MOMENTS.map(([moment, name]) => ({ name: `${name} (${width}px)`, props: { moment, width } })));

/** A sheet of handouts: Letter paper with six slides on it, drawn as the host lays them out. */
export function handoutsDoc(): PdfDoc {
  const slides = sponsorDoc(SPONSOR.map((_, i) => i + 1));
  const paper = { width: 612, height: 792 };
  const sheets = Math.ceil(SPONSOR.length / 6);
  return {
    pages: sheets,
    size: () => paper,
    measure: async () => paper,
    async paint(page, host, scale, _text, signal) {
      const px = (n: number): string => `${(n * scale * 96) / 72}px`;
      const sheet = host.ownerDocument.createElement("div");
      sheet.style.cssText = "position:absolute;inset:0;overflow:hidden";
      const w = (540 - 18) / 2;
      const h = w * (9 / 16);
      for (let k = 0; k < 6; k++) {
        const at = (page - 1) * 6 + k;
        if (at >= SPONSOR.length) break;
        const cell = host.ownerDocument.createElement("div");
        cell.style.cssText = `position:absolute;left:${px(36 + (k % 2) * (w + 18))};top:${px(36 + Math.floor(k / 2) * (h + 60) + 40)};width:${px(w)};height:${px(h)};outline:1px solid #c3c8cf`;
        sheet.appendChild(cell);
        await slides.paint(at + 1, cell, (scale * w) / 720, null, signal);
      }
      const number = host.ownerDocument.createElement("div");
      number.style.cssText = `position:absolute;right:${px(36)};bottom:${px(30)};font:${px(9)} Arial,sans-serif;color:#5b6270`;
      number.textContent = `${page} of ${sheets}`;
      sheet.appendChild(number);
      host.replaceChildren(sheet);
    },
    text: async () => [],
    release: () => undefined,
    destroy: () => undefined,
  };
}


/** A slide of the sponsor deck as a small picture (a `data:` URL), as the host's thumbnails are. */
export function sponsorThumb(n: number): string {
  const s = SPONSOR[n - 1]!;
  const lines = (s.points ?? []).map((p, i) => `<text x="62" y="${190 + i * 34}" font-size="18" fill="#c9cad0">${p.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</text>`).join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 720 405"><rect width="720" height="405" fill="#131417"/><rect x="62" y="${s.kind ? 110 : 54}" width="${s.kind ? 72 : 44}" height="3" fill="#cfb991"/><text x="62" y="${s.kind ? 170 : 104}" font-family="Arial,sans-serif" font-size="${s.kind ? 48 : 30}" font-weight="600" fill="#f4f4f5">${s.title}</text>${s.sub ? `<text x="62" y="212" font-family="Arial,sans-serif" font-size="24" fill="#cfb991">${s.sub}</text>` : ""}<g font-family="Arial,sans-serif">${lines}</g></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}
