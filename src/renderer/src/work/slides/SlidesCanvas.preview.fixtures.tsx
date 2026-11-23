// Fixtures for `bun run ui:preview src/renderer/src/work/slides/SlidesCanvas.preview.tsx#SlidesPreview --width 864`,
// and the preview's deck: the prototype's sponsor deck drawn as slides in its own dark look with a gold rule.
// The deck's colours are the picture's, not the app's, so they live here, where the colour guard does not look.
import type { PdfDoc } from "../pdf/engine";

export default [
  { name: "Suggestions: five changes, the stage on a reworded slide", props: { moment: "sugg" } },
  { name: "Notes, written directly, with Undo", props: { moment: "notes" } },
  { name: "Real PowerPoint", props: { moment: "ppt" } },
  { name: "A shape picked on the stage: its outline, eight handles and the rotate handle", props: { moment: "picked" } },
  { name: "A turned shape picked: the selection turns with it", props: { moment: "turned" } },
  { name: "Typing on a slide: the box over the points, “6,200” selected, the row on it", props: { moment: "typing" } },
  { name: "The format row at 1,200px: a picked title, every control in the row", props: { moment: "row" } },
  { name: "The format row at 520px: what does not fit waits in ⋯", props: { moment: "rownarrow" } },
  { name: "History open from the bar", props: { moment: "history" } },
  { name: "Dragging a shape: its picture carried, a guide where its centre meets the slide's, its size by the corner", props: { moment: "drag" } },
  { name: "The format row at 1,200px with a shape picked: layout, fill, Arrange, Format, Insert, Theme, the view switch", props: { moment: "shaperow" } },
  { name: "The format row at 520px with a shape picked", props: { moment: "shaperownarrow" } },
  { name: "The layout popover: the layouts this slide can take", props: { moment: "layouts" } },
  { name: "Insert open", props: { moment: "insert" } },
  { name: "Theme open", props: { moment: "theme" } },
  { name: "The Format sheet beside the stage", props: { moment: "sheet" } },
  { name: "The Format sheet under the slide on a 640px canvas", props: { moment: "sheetunder" } },
  { name: "The Sorter: sections, a hidden slide", props: { moment: "sorter" } },
  { name: "Loading", props: { moment: "loading" } },
  { name: "No picture: LibreOffice is not here", props: { moment: "nopicture" } },
];

/** The deck's own ground, title ink and point ink (its picture's colours, not the app's). */
export const DECK_GROUND = "#131417";
export const DECK_INK = "F4F4F5";
export const DECK_MUTED = "C9CAD0";
export const DECK_THEME = { colors: { dk1: "131417", lt1: "F4F4F5", dk2: "1F2024", lt2: "C9CAD0", accent1: "CFB991", accent2: "4472C4" }, major: "Arial", minor: "Arial" };

export interface PreviewSlide {
  title: string;
  points?: string[];
  kind?: "title";
  sub?: string;
  /** a gold tag drawn on the slide, at a box in shares of it */
  tag?: { text: string; box: [number, number, number, number] };
}

/** The tag on "Who comes", in shares of the slide: a shape to pick, drag and format. */
export const TAG_BOX: [number, number, number, number] = [0.6, 0.66, 0.88, 0.75];

export const SPONSOR: PreviewSlide[] = [
  { kind: "title", title: "Spring LAN 2027", sub: "Sponsor deck" },
  { title: "Why sponsor Spring LAN", points: ["The biggest student LAN in the Midwest", "Your brand on stream and on the floor", "Purdue students who build PCs"] },
  { title: "Who comes", points: ["480 players across 3 titles", "6,200 stream viewers", "38% from engineering"], tag: { text: "Up 25% on last year", box: TAG_BOX } },
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
      const [x0, y0, x1, y1] = s.tag?.box ?? [0, 0, 0, 0];
      const tag = s.tag
        ? `<div style="position:absolute;left:${x0 * 100}%;top:${y0 * 100}%;width:${(x1 - x0) * 100}%;height:${(y1 - y0) * 100}%;border-radius:${px(3)};background:#cfb991;color:#131417;font-size:${px(14)};font-weight:600;display:flex;align-items:center;justify-content:center;white-space:nowrap">${s.tag.text}</div>`
        : "";
      slide.innerHTML = rule + title + sub + `<div style="margin-top:${px(14)}">${points}</div>` + tag;
      host.replaceChildren(slide);
    },
    text: async () => [],
    release: () => undefined,
    destroy: () => undefined,
  };
}

/** The deck's layouts drawn as their places, one page each, in the deck's look (`DeckView.layoutsPic`). */
export const LAYOUT_BARS: Record<string, Array<[number, number, number, number, boolean?]>> = {
  "Title Slide": [[9, 32, 8, 1.6, true], [9, 40, 50, 9], [9, 54, 30, 5, true]],
  "Title and Content": [[9, 10, 6, 1.4, true], [9, 16, 38, 7], [9, 34, 76, 4], [9, 44, 66, 4], [9, 54, 70, 4]],
  "Section Header": [[9, 44, 6, 1.4, true], [9, 50, 56, 9], [9, 64, 30, 4]],
  "Two Content": [[9, 10, 6, 1.4, true], [9, 16, 38, 7], [9, 34, 36, 4], [9, 44, 30, 4], [55, 34, 36, 4], [55, 44, 30, 4]],
  Comparison: [[9, 10, 6, 1.4, true], [9, 16, 38, 7], [9, 30, 30, 4, true], [9, 40, 34, 4], [55, 30, 30, 4, true], [55, 40, 34, 4]],
  "Title Only": [[9, 10, 6, 1.4, true], [9, 16, 38, 7]],
  Blank: [],
};

export function layoutsDoc(names: string[]): PdfDoc {
  return {
    pages: names.length,
    size: () => ({ width: 720, height: 405 }),
    measure: async () => ({ width: 720, height: 405 }),
    async paint(page, host) {
      const slide = host.ownerDocument.createElement("div");
      slide.style.cssText = "position:absolute;inset:0;background:#131417";
      slide.innerHTML = (LAYOUT_BARS[names[page - 1]] ?? [])
        .map(([x, y, w, h, gold]) => `<i style="position:absolute;left:${x}%;top:${y}%;width:${w}%;height:${h}%;border-radius:1px;background:${gold ? "#cfb991" : "#3a3c43"}"></i>`)
        .join("");
      host.replaceChildren(slide);
    },
    text: async () => [],
    release: () => undefined,
    destroy: () => undefined,
  };
}
