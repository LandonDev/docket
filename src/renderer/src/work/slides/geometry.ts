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
 * How far under the slide's bottom edge the pane's floating bar (Ask) is anchored. The frame lays the bar above its
 * anchor, 6px off and 32px tall (canvas/SelectionBar.tsx), so this leaves it 4px under the picture: never over a shape,
 * a handle or the typing box, where his next press goes.
 */
export const ASK_UNDER = 42;

/** Where the floating bar is anchored for a picked shape: under the slide's bottom-left corner, in page pixels. */
export const askAnchor = (slide: { left: number; bottom: number }): { left: number; top: number } => ({ left: slide.left, top: slide.bottom + ASK_UNDER });

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

/** What a shape is called where it has no words: by what it is. */
export const KIND_WORDS: Readonly<Record<DeckShapeKind, string>> = { text: "Text", other: "Shape", picture: "Picture", table: "Table", chart: "Chart", media: "Media", connector: "Line", frame: "Object" };

/**
 * Where a shape's words are laid on a stage of `width` by `height` CSS pixels: the corner they start from, how far
 * they run across and down, and the turn. Words keep reading the right way in a mirrored shape, as PowerPoint and
 * LibreOffice draw them: flipped across they read as before, flipped down they turn half round. Either way they start
 * at the drawn top-right corner and run toward the drawn top-left.
 */
export function textFrameOf(quad: Quad, flip: boolean, width: number, height: number): { left: number; top: number; width: number; height: number; turn: number } {
  const c = quad.map(([x, y]) => ({ x: x * width, y: y * height }));
  const [origin, across, down] = flip ? [c[1], c[0], c[2]] : [c[0], c[1], c[3]];
  const dx = across.x - origin.x;
  const dy = across.y - origin.y;
  return { left: origin.x, top: origin.y, width: Math.hypot(dx, dy), height: Math.hypot(down.x - origin.x, down.y - origin.y), turn: (Math.atan2(dy, dx) * 180) / Math.PI };
}

/**
 * The colour of the ground a shape's words sit on, from samples of the drawn picture just inside its edges (each an
 * RGBA): the colour most of them share, near enough. On a flat fill that is the fill; on a picture or a gradient it
 * is the one colour the edges have most of, so the box is that flat colour while he types. Null with no samples.
 */
export function groundOf(samples: ReadonlyArray<readonly [number, number, number, number]>): string | null {
  const counts = new Map<string, { n: number; rgb: [number, number, number] }>();
  for (const [r, g, b, a] of samples) {
    if (a < 128) continue;
    // Within 8 of a step: anti-aliased edges and JPEG noise count with the fill.
    const key = [r, g, b].map((v) => v >> 3).join(",");
    const got = counts.get(key);
    if (got) got.n++;
    else counts.set(key, { n: 1, rgb: [r, g, b] });
  }
  let best: { n: number; rgb: [number, number, number] } | null = null;
  for (const c of counts.values()) if (!best || c.n > best.n) best = c;
  return best ? `#${best.rgb.map((v) => v.toString(16).padStart(2, "0")).join("")}` : null;
}
