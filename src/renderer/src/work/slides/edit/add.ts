import type { DeckShape, DeckSlide, DeckView } from "@shared/contract-work-slides";
import type { Box, Size } from "./drag";

/**
 * What he adds to a deck by hand (docs/agents/work-slides.md "Adding to a
 * slide"), pure: where a new shape lands and how big, which layouts a slide
 * may take, and finding what an edit made in the view it answered.
 */

const INCH = 914_400;
/** A pixel of a picture at 96 to the inch, as PowerPoint places one. */
const EMU_PER_PIXEL = 9_525;

/** The outlines offered, PowerPoint's names for them, how wide each is for its height, and each drawn in a 16px box. */
export const PRESETS = [
  { preset: "rect", label: "Rectangle", aspect: 1.6, path: "M2 4.5h12v7H2z" },
  { preset: "roundRect", label: "Rounded rectangle", aspect: 1.6, path: "M4 4.5h8a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2z" },
  { preset: "ellipse", label: "Oval", aspect: 1, path: "M8 2.5a5.5 5.5 0 1 1 0 11 5.5 5.5 0 0 1 0-11z" },
  { preset: "triangle", label: "Triangle", aspect: 1.15, path: "M8 2.5l6 11H2z" },
  { preset: "diamond", label: "Diamond", aspect: 1, path: "M8 2l6 6-6 6-6-6z" },
  { preset: "rightArrow", label: "Arrow", aspect: 2, path: "M2 6h7.5V3.5L14 8l-4.5 4.5V10H2z" },
  { preset: "chevron", label: "Chevron", aspect: 1, path: "M3 3h6l4.5 5L9 13H3l4.5-5z" },
  { preset: "star5", label: "Star", aspect: 1, path: "M8 2l1.8 3.9 4.2.5-3.1 2.9.8 4.2L8 11.4l-3.7 2.1.8-4.2L2 6.4l4.2-.5z" },
] as const;
export type Preset = (typeof PRESETS)[number]["preset"];

/** A box `w` by `h` in the slide's middle. */
export function centred(size: Size, w: number, h: number): Box {
  const width = Math.max(1, Math.round(w));
  const height = Math.max(1, Math.round(h));
  return [Math.round((size.width - width) / 2), Math.round((size.height - height) / 2), width, height];
}

/** A text box: two fifths of the slide across, one line of 18pt (with its insets) down. */
export const textBoxAt = (size: Size): Box => centred(size, size.width * 0.4, INCH * 0.5);

/** A drawn shape: three tenths of the slide's height tall, at its own proportions. */
export function shapeAt(size: Size, preset: Preset): Box {
  const aspect = PRESETS.find((p) => p.preset === preset)?.aspect ?? 1;
  const h = size.height * 0.3;
  return centred(size, h * aspect, h);
}

/** A picture or a video at its own proportions: its own size at 96 to the inch, made smaller to fit three fifths of the slide each way. */
export function pictureAt(size: Size, width: number, height: number): Box {
  if (!(width > 0 && height > 0)) return centred(size, size.width * 0.6, size.width * 0.6 * (9 / 16));
  const w = width * EMU_PER_PIXEL;
  const h = height * EMU_PER_PIXEL;
  const k = Math.min(1, (size.width * 0.6) / w, (size.height * 0.6) / h);
  return centred(size, w * k, h * k);
}

/** A table: an inch and a half a column up to four fifths of the slide, two fifths of an inch a row. */
export const tableAt = (size: Size, rows: number, cols: number): Box => centred(size, Math.min(cols * INCH * 1.5, size.width * 0.8), Math.min(rows * INCH * 0.4, size.height * 0.8));

/** A chart: three fifths of the slide each way. */
export const chartAt = (size: Size): Box => centred(size, size.width * 0.6, size.height * 0.6);

/** The data a new chart starts with, PowerPoint's own, for him (or an agent) to change. */
export const SAMPLE_CHART = {
  categories: ["Category 1", "Category 2", "Category 3", "Category 4"],
  series: [
    { name: "Series 1", values: [4.3, 2.5, 3.5, 4.5] },
    { name: "Series 2", values: [2.4, 4.4, 1.8, 2.8] },
    { name: "Series 3", values: [2, 2, 3, 5] },
  ],
};

/** The words a new text box starts with, selected so his first key replaces them. */
export const NEW_TEXT = "Text";

/** The shape an insert made: the one on the slide now whose id was not there before. */
export function madeShape(before: DeckSlide | undefined, after: DeckView | null, slideId: number): DeckShape | undefined {
  const had = new Set(before?.shapes.map((s) => s.id) ?? []);
  return after?.slides.find((s) => s.id === slideId && s.tint !== "del")?.shapes.find((s) => !had.has(s.id));
}

/** The slide an `add` or a `duplicate` made: the one in the deck now whose id was not there before. */
export function madeSlide(before: DeckView, after: DeckView | null): DeckSlide | undefined {
  const had = new Set(before.slides.map((s) => s.id));
  return after?.slides.find((s) => !had.has(s.id));
}

type Layout = NonNullable<DeckView["layouts"]>[number];

/**
 * The layouts a slide may take: the one it has, and each whose placeholders hold a match (same index and kind) for
 * every one of its layout's, as the host asks of a `layout` edit. The slide's own placeholders are those of its
 * layout, a list that can only be longer than what the slide holds, so a layout offered here is one the host takes.
 */
export function layoutsFor(view: DeckView, slide: DeckSlide | undefined): Layout[] {
  const all = view.layouts ?? [];
  // The host's own word for it, where it gives one: exactly the layouts a `layout` edit of this slide takes.
  if (slide?.layoutsFit) return all.filter((l) => slide.layoutsFit!.includes(l.name));
  const now = all.find((l) => l.name === slide?.layout);
  if (!now) return [];
  return all.filter((l) => l === now || now.holds.every((h) => l.holds.some((o) => o.idx === h.idx && o.kind === h.kind)));
}

/** The layout a new slide after this one takes: its own, as PowerPoint gives, unless it is a title slide; then the next of its master. */
export function layoutAfter(view: DeckView, slide: DeckSlide | undefined): string | undefined {
  const all = view.layouts ?? [];
  const now = all.find((l) => l.name === slide?.layout);
  if (!now) return slide?.layout ?? all[1]?.name ?? all[0]?.name;
  const title = now.holds.some((h) => h.kind === "subtitle");
  return title ? (all.find((l) => l.master === now.master && l !== now && l.holds.some((h) => h.kind === "body"))?.name ?? now.name) : now.name;
}
