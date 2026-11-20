/**
 * Where the Computers page puts its computers (docs/DESIGN.md "Computers"):
 * one has the stage, the others sit in a strip beside it, or under it when
 * the page is narrow. Pure, so the page and its test read the same numbers.
 * Sizes are CSS pixels.
 */

export interface Size {
  width: number;
  height: number;
}

/** The page's inset on every side. */
export const STAGE_INSET = 16;
/** Between the stage and the strip, and between the picture and its caption. */
export const STAGE_GAP = 16;
export const CAPTION_GAP = 8;
/** The caption's row under the stage's picture: a 20px title over a 16px line. */
export const CAPTION_HEIGHT = 36;
/** The strip's tiles are this wide, and no wider. */
export const STRIP_MIN = 176;
export const STRIP_MAX = 240;
/** Under this width the strip goes under the stage. */
export const STRIP_BELOW = 640;

export interface StageLayout {
  /** the room the stage's picture may fill, before its own shape is known */
  room: Size;
  /** where the other computers sit; `none` when the stage is alone */
  strip: "side" | "below" | "none";
  /** a strip tile's width on the side; under the stage the tiles share its width */
  stripWidth: number;
}

/** The page's room for its computers (`page`, the area under the header), and how many there are. */
export function stageLayout(page: Size, count: number): StageLayout {
  const inner = { width: Math.max(0, page.width - STAGE_INSET * 2), height: Math.max(0, page.height - STAGE_INSET * 2) };
  const caption = CAPTION_GAP + CAPTION_HEIGHT;
  if (count <= 1) return { room: { width: inner.width, height: Math.max(0, inner.height - caption) }, strip: "none", stripWidth: 0 };
  if (page.width < STRIP_BELOW) return { room: { width: inner.width, height: Math.max(0, inner.height - caption) }, strip: "below", stripWidth: 0 };
  const stripWidth = Math.round(Math.min(STRIP_MAX, Math.max(STRIP_MIN, inner.width * 0.18)));
  return { room: { width: Math.max(0, inner.width - stripWidth - STAGE_GAP), height: Math.max(0, inner.height - caption) }, strip: "side", stripWidth };
}

/**
 * The stage's picture: its shape, as large as the room allows both ways, and
 * never past twice the stream's own pixels, so a small window stays small
 * instead of turning to blur. `frame` is in the stream's pixels; `dpr` the
 * screen's. Before the frame is known the picture takes 16:10 at the room's
 * size.
 */
export function fitStage(room: Size, frame: Size | null, dpr: number): Size {
  const shape = frame && frame.width > 0 && frame.height > 0 ? frame : { width: 16, height: 10 };
  let width = Math.min(room.width, (room.height * shape.width) / shape.height);
  if (frame) width = Math.min(width, (frame.width / Math.max(1, dpr)) * 2);
  width = Math.max(0, Math.floor(width));
  return { width, height: Math.floor((width * shape.height) / shape.width) };
}

/** Which computer has the stage: his pick while it is there; else the one kept from before; else the one that needs him; else the one that acted last. */
export function stageOf<T extends { key: string; asking: boolean; lastCallAt: number }>(tiles: readonly T[], pick: string | null, kept: string | null): string | null {
  if (pick && tiles.some((t) => t.key === pick)) return pick;
  if (kept && tiles.some((t) => t.key === kept)) return kept;
  const asking = tiles.find((t) => t.asking);
  if (asking) return asking.key;
  let last: T | null = null;
  for (const t of tiles) if (!last || t.lastCallAt > last.lastCallAt) last = t;
  return last?.key ?? null;
}
