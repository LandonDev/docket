// Fixtures for `bun run ui:preview src/renderer/src/work/slides/SlidesCanvas.preview.tsx#SlidesPreview --width 864`,
// and the preview's deck: the prototype's sponsor deck drawn as slides in its own dark look with a gold rule.
// The deck's colours are the picture's, not the app's, so they live here, where the colour guard does not look.
import type { PdfDoc } from "../pdf/engine";

export default [
  { name: "Suggestions: five changes, the stage on a reworded slide", props: { moment: "sugg" } },
  { name: "Notes, written directly, with Undo", props: { moment: "notes" } },
  { name: "Real PowerPoint", props: { moment: "ppt" } },
  { name: "Loading", props: { moment: "loading" } },
  { name: "No picture: LibreOffice is not here", props: { moment: "nopicture" } },
];

export interface PreviewSlide {
  title: string;
  points?: string[];
  kind?: "title";
  sub?: string;
}

export const SPONSOR: PreviewSlide[] = [
  { kind: "title", title: "Spring LAN 2027", sub: "Sponsor deck" },
  { title: "Why sponsor Spring LAN", points: ["The biggest student LAN in the Midwest", "Your brand on stream and on the floor", "Purdue students who build PCs"] },
  { title: "Who comes", points: ["480 players across 3 titles", "6,200 stream viewers", "38% from engineering"] },
  { title: "Packages", points: ["Gold, $5,000: stage naming and a booth", "Silver, $2,500: a booth", "Bronze, $1,000: logo on stream"] },
  { title: "Timeline", points: ["Dec 15: commit", "Feb 1: logos", "Apr 10: the event"] },
  { title: "Last year", points: ["410 players", "5,100 viewers", "Sold out in 9 days"] },
  { title: "Commit by Dec 15", points: ["Reply to Landon Hale", "Invoices go out in January"] },
  { title: "Thank you", points: ["landon@purdue.edu"] },
];

/** A deck render without pdf.js: each page a slide drawn in the deck's look. */
export function sponsorDoc(order: number[]): PdfDoc {
  return {
    pages: order.length,
    size: () => ({ width: 720, height: 405 }),
    measure: async () => ({ width: 720, height: 405 }),
    async paint(page, host, scale) {
      const s = SPONSOR[order[page - 1] - 1];
      const px = (n: number): string => `${(n * scale * 96) / 72}px`;
      const slide = host.ownerDocument.createElement("div");
      slide.style.cssText = `position:absolute;inset:0;background:#131417;color:#f4f4f5;font-family:"Segoe UI","Helvetica Neue",Arial,"Liberation Sans",sans-serif;padding:${px(s.kind ? 110 : 54)} ${px(62)} 0;overflow:hidden`;
      const rule = `<div style="width:${px(s.kind ? 72 : 44)};height:${px(3)};background:#cfb991;margin-bottom:${px(12)}"></div>`;
      const title = `<div style="font-size:${px(s.kind ? 48 : 30)};line-height:1.2;font-weight:600;letter-spacing:-0.01em">${s.title}</div>`;
      const sub = s.sub ? `<div style="margin-top:${px(8)};font-size:${px(24)};color:#cfb991">${s.sub}</div>` : "";
      const points = (s.points ?? []).map((p) => `<div style="margin-top:${px(12)};font-size:${px(18)};color:#c9cad0">${p}</div>`).join("");
      slide.innerHTML = rule + title + sub + `<div style="margin-top:${px(14)}">${points}</div>`;
      host.replaceChildren(slide);
    },
    text: async () => [],
    release: () => undefined,
    destroy: () => undefined,
  };
}
