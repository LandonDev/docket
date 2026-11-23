import type { DeckPoint, DeckShape, DeckShapeKind } from "@shared/contract-work-slides";

/**
 * Where a shape is on the stage, and which shape a press lands on (docs/DESIGN.md
 * "The slide editor"). A shape's `quad` is its own box's four corners as drawn,
 * turned and flipped with it and with every group above it, in shares of the
 * slide; everything here is in those shares or in the stage's CSS pixels.
 */

/**
 * The kinds a hand can pick. A kind is here only once its box was held to the pixels LibreOffice draws
 * (src/main/server/work/slides/boxes.test.ts): the box the outline gives must be where the shape is, or handles
 * would sit beside it. A connector's box is its two ends, not its line, and a frame (a diagram, an embedded
 * object) is edited in PowerPoint: neither is picked.
 */
export const PICKABLE: Readonly<Record<DeckShapeKind, boolean>> = { text: true, other: true, picture: true, table: true, chart: true, media: true, connector: false, frame: false };

export type Quad = readonly [DeckPoint, DeckPoint, DeckPoint, DeckPoint];

/** A shape a press can select: of a kind that passed its box test, with a place on the slide. */
export const pickable = (shape: DeckShape): shape is DeckShape & { quad: Quad } => !!shape.quad && PICKABLE[shape.kind ?? "other"];

/** Whether a point is inside a quad (its corners in order, either way round). */
export function inQuad(quad: Quad, x: number, y: number): boolean {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const [ax, ay] = quad[i];
    const [bx, by] = quad[(i + 1) % 4];
    const cross = (bx - ax) * (y - ay) - (by - ay) * (x - ax);
    if (cross === 0) continue;
    if (sign === 0) sign = Math.sign(cross);
    else if (Math.sign(cross) !== sign) return false;
  }
  // A quad with no area (every corner on one point or one line) holds nothing: it must not take every press.
  return sign !== 0;
}

/** The shape a press at a point lands on: the topmost pickable one whose box holds it (shapes are in z-order, last on top). */
export function hit(shapes: readonly DeckShape[], x: number, y: number): DeckShape | null {
  for (let i = shapes.length - 1; i >= 0; i--) {
    const shape = shapes[i];
    if (pickable(shape) && inQuad(shape.quad, x, y)) return shape;
  }
  return null;
}

export interface Px {
  x: number;
  y: number;
}

/** How far over the top edge the rotate handle sits, and the handles' sizes, in CSS pixels at any zoom. */
export const HANDLE = 8;
/** The edge of a handle, in px: the selection's own measure, not an icon's stroke. */
export const HANDLE_EDGE = 1.5;
export const ROTATE_HANDLE = 10;
export const ROTATE_RISE = 22;
export const ROTATE_STEM = 12;

/**
 * A selection as it is drawn on a stage of `width` by `height` CSS pixels: the outline's corners, the eight
 * handles (corners and edge midpoints, clockwise from the top-left), and the rotate handle with its stem, which
 * rise from the middle of the top edge away from the shape, so the whole selection turns with it.
 */
export function selectionOf(quad: Quad, width: number, height: number): { corners: Px[]; handles: Px[]; rotate: Px; stem: [Px, Px] } {
  const corners = quad.map(([x, y]) => ({ x: x * width, y: y * height }));
  const mid = (a: Px, b: Px): Px => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  const [tl, tr, br, bl] = corners;
  const top = mid(tl, tr);
  const handles = [tl, top, tr, mid(tr, br), br, mid(br, bl), bl, mid(bl, tl)];
  // Away from the shape: from the middle of the bottom edge through the middle of the top one.
  const bottom = mid(bl, br);
  const length = Math.hypot(top.x - bottom.x, top.y - bottom.y) || 1;
  const out = { x: (top.x - bottom.x) / length, y: (top.y - bottom.y) / length };
  const along = (d: number): Px => ({ x: top.x + out.x * d, y: top.y + out.y * d });
  return { corners, handles, rotate: along(ROTATE_RISE), stem: [along(ROTATE_RISE - ROTATE_STEM - ROTATE_HANDLE / 2), along(ROTATE_RISE - ROTATE_HANDLE / 2)] };
}

/** The shapes a key can move the selection through, in reading order: by their box's top, then its left. */
export function readingOrder(shapes: readonly DeckShape[]): DeckShape[] {
  return shapes.filter(pickable).sort((a, b) => {
    const [ax, ay] = [Math.min(...a.quad.map((p) => p[0])), Math.min(...a.quad.map((p) => p[1]))];
    const [bx, by] = [Math.min(...b.quad.map((p) => p[0])), Math.min(...b.quad.map((p) => p[1]))];
    return Math.abs(ay - by) > 0.02 ? ay - by : ax - bx;
  });
}

/** What a shape is called where it has no words: by what it is. */
export const KIND_WORDS: Readonly<Record<DeckShapeKind, string>> = { text: "Text", other: "Shape", picture: "Picture", table: "Table", chart: "Chart", media: "Media", connector: "Line", frame: "Object" };
