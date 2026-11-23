import type { DeckShape } from "@shared/contract-work-slides";
import { paperFor } from "../../formats/model";
import type { Quad } from "../geometry";

/**
 * A shape moved, resized and turned by hand (docs/agents/work-slides.md
 * "Moving a shape"), pure. Everything is in the slide's EMU, as the outline's
 * `own` and a `geometry` edit have it: the box as it lies before any turn
 * (left, top, width, height), flipped and then turned clockwise about its
 * centre, as DrawingML's `a:xfrm` draws it (deckScript.ts `about`).
 */

export type Box = [left: number, top: number, width: number, height: number];
export interface Own {
  box: Box;
  rot: number;
  flipH: boolean;
  flipV: boolean;
}
export interface Pt {
  x: number;
  y: number;
}
/** The slide in EMU. */
export interface Size {
  width: number;
  height: number;
}

/** The handles, clockwise from the top-left as the selection draws them, by the side of the box each pulls: -1, 0 or 1 along its own width and height. */
export const HANDLE_SIGNS: ReadonlyArray<readonly [number, number]> = [
  [-1, -1],
  [0, -1],
  [1, -1],
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
];

/** How near, in screen pixels, an edge has to come to a line to be pulled onto it. */
export const SNAP_PX = 6;
/** Turned with Shift, the angle goes in steps of this many degrees. */
export const TURN_STEP = 15;
/** How far a pointer moves, in screen pixels, before a press becomes a drag. */
export const DRAG_START_PX = 3;
/** The least a side may shrink to, in screen pixels. */
export const MIN_SIDE_PX = 4;

export const centreOf = (own: Own): Pt => ({ x: own.box[0] + own.box[2] / 2, y: own.box[1] + own.box[3] / 2 });

/** The box's own across and down, as drawn: flipped, then turned. */
export function axesOf(own: Own): { ex: Pt; ey: Pt } {
  const r = (own.rot * Math.PI) / 180;
  const fx = own.flipH ? -1 : 1;
  const fy = own.flipV ? -1 : 1;
  return { ex: { x: fx * Math.cos(r), y: fx * Math.sin(r) }, ey: { x: -fy * Math.sin(r), y: fy * Math.cos(r) } };
}

/** A point given in the box's own numbers about its centre, where it is drawn. */
function drawnAt(own: Own, u: number, v: number): Pt {
  const c = centreOf(own);
  const { ex, ey } = axesOf(own);
  return { x: c.x + u * ex.x + v * ey.x, y: c.y + u * ex.y + v * ey.y };
}

/** Its four corners as drawn, in EMU: its own top-left, top-right, bottom-right, bottom-left, as the outline's `quad` lists them. */
export function cornersOf(own: Own): [Pt, Pt, Pt, Pt] {
  const hw = own.box[2] / 2;
  const hh = own.box[3] / 2;
  return [drawnAt(own, -hw, -hh), drawnAt(own, hw, -hh), drawnAt(own, hw, hh), drawnAt(own, -hw, hh)];
}

/** Its corners as shares of the slide, as the outline's `quad`. */
export const quadOf = (own: Own, size: Size): Quad => cornersOf(own).map((p) => [p.x / size.width, p.y / size.height]) as unknown as Quad;

/** Where a handle is drawn, in EMU. */
export function handleAt(own: Own, handle: number): Pt {
  const [sx, sy] = HANDLE_SIGNS[handle] ?? [0, 0];
  return drawnAt(own, (sx * own.box[2]) / 2, (sy * own.box[3]) / 2);
}

/** The box around a shape as drawn, in EMU: its left, centre and right, its top, middle and bottom. */
export function spanOf(corners: readonly Pt[]): { x: [number, number, number]; y: [number, number, number] } {
  const xs = corners.map((p) => p.x);
  const ys = corners.map((p) => p.y);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  return { x: [x0, (x0 + x1) / 2, x1], y: [y0, (y0 + y1) / 2, y1] };
}

/** The lines a shape lines up with: the slide's edges and centre, and every other shape's edges and centres. */
export interface Lines {
  x: number[];
  y: number[];
}

export function linesOf(size: Size, others: readonly DeckShape[]): Lines {
  const lines: Lines = { x: [0, size.width / 2, size.width], y: [0, size.height / 2, size.height] };
  for (const shape of others) {
    if (!shape.quad) continue;
    const span = spanOf(shape.quad.map(([x, y]) => ({ x: x * size.width, y: y * size.height })));
    lines.x.push(...span.x);
    lines.y.push(...span.y);
  }
  return lines;
}

/** The nearest line to any of `at` within `tol`: how far to move to it, or 0. */
function pull(at: readonly number[], lines: readonly number[], tol: number): number {
  let best = 0;
  let gap = tol;
  for (const v of at) {
    for (const line of lines) {
      const d = line - v;
      if (Math.abs(d) <= gap) {
        gap = Math.abs(d);
        best = d;
      }
    }
  }
  return best;
}

/** The lines that `at` lies on, within half a screen pixel (`eps`), once each. */
const met = (at: readonly number[], lines: readonly number[], eps: number): number[] => [...new Set(lines.filter((line) => at.some((v) => Math.abs(line - v) <= eps)))];

export interface Moved {
  own: Own;
  /** the slide's lines it lies on now: a guide is drawn the slide's height at each `x`, its width at each `y` */
  guides: Lines;
}

const round = (box: Box): Box => [Math.round(box[0]), Math.round(box[1]), Math.max(1, Math.round(box[2])), Math.max(1, Math.round(box[3]))];

/**
 * A shape moved by `dx`, `dy`: with `snap`, each way its edges or centre come within `tol` of a line are pulled
 * onto the nearest one. `eps` is how near counts as on a line, for the guides.
 */
export function moveTo(own: Own, dx: number, dy: number, lines: Lines, opts: { snap: boolean; tol: number; eps: number }): Moved {
  const span = spanOf(cornersOf(own));
  let mx = dx;
  let my = dy;
  if (opts.snap) {
    mx += pull(span.x.map((v) => v + dx), lines.x, opts.tol);
    my += pull(span.y.map((v) => v + dy), lines.y, opts.tol);
  }
  const box = round([own.box[0] + mx, own.box[1] + my, own.box[2], own.box[3]]);
  const moved = { ...own, box };
  const now = spanOf(cornersOf(moved));
  return { own: moved, guides: { x: met(now.x, lines.x, opts.eps), y: met(now.y, lines.y, opts.eps) } };
}

/** Whether a shape lies square to the slide (turned by a whole quarter or not at all), so its edges can meet a line. */
export const square = (own: Own): boolean => Math.abs(own.rot / 90 - Math.round(own.rot / 90)) < 1e-6;

/**
 * A shape resized by one of its handles, the handle drawn at `to`: along its own width and height, so a turned shape
 * keeps its turn, and the side or corner across from the handle stays where it is. With `keep` (Shift) it keeps its
 * proportions, an edge handle growing the other way evenly about the middle. A side shrinks to `min` and no further.
 * With `snap`, a square shape's moving edges are pulled onto the nearest line within `tol`.
 */
export function resizeTo(own: Own, handle: number, to: Pt, lines: Lines, opts: { keep: boolean; snap: boolean; tol: number; eps: number; min: number }): Moved {
  const [sx, sy] = HANDLE_SIGNS[handle] ?? [0, 0];
  const [, , w, h] = own.box;
  const { ex, ey } = axesOf(own);
  const c = centreOf(own);
  // Along which of the slide's ways each pulled side moves: a square shape's own axes lie on the slide's.
  const live = { x: false, y: false };
  if (sx) live[Math.abs(ex.x) > 0.5 ? "x" : "y"] = true;
  if (sy) live[Math.abs(ey.x) > 0.5 ? "x" : "y"] = true;
  const snapping = opts.snap && !opts.keep && square(own);
  const p = { ...to };
  if (snapping) {
    if (live.x) p.x += pull([p.x], lines.x, opts.tol);
    if (live.y) p.y += pull([p.y], lines.y, opts.tol);
  }
  const u = (p.x - c.x) * ex.x + (p.y - c.y) * ex.y;
  const v = (p.x - c.x) * ey.x + (p.y - c.y) * ey.y;
  const ax = (-sx * w) / 2;
  const ay = (-sy * h) / 2;
  let nw = sx ? Math.max(opts.min, sx * (u - ax)) : w;
  let nh = sy ? Math.max(opts.min, sy * (v - ay)) : h;
  if (opts.keep) {
    const ratio = w / h;
    if (sx && sy) {
      const k = Math.max(nw / w, nh / h, opts.min / Math.min(w, h));
      nw = w * k;
      nh = h * k;
    } else if (sx) nh = Math.max(opts.min, nw / ratio);
    else nw = Math.max(opts.min, nh * ratio);
  }
  const cu = sx ? ax + (sx * nw) / 2 : 0;
  const cv = sy ? ay + (sy * nh) / 2 : 0;
  const nc = { x: c.x + cu * ex.x + cv * ey.x, y: c.y + cu * ex.y + cv * ey.y };
  const resized = { ...own, box: round([nc.x - nw / 2, nc.y - nh / 2, nw, nh]) };
  const at = handleAt(resized, handle);
  return { own: resized, guides: snapping ? { x: live.x ? met([at.x], lines.x, opts.eps) : [], y: live.y ? met([at.y], lines.y, opts.eps) : [] } : { x: [], y: [] } };
}

/** An angle in degrees, from 0 up to 360, to a hundredth. */
export const normalAngle = (deg: number): number => {
  const a = Math.round((((deg % 360) + 360) % 360) * 100) / 100;
  return a === 360 ? 0 : a;
};

/**
 * A shape turned by its handle: the angle it had, plus how far the pointer has gone round its centre since the press
 * (`from` is where the press was), so the handle stays on the line from the centre through the pointer. With `step`
 * (Shift) it goes in 15 degree steps.
 */
export function turnTo(own: Own, from: Pt, to: Pt, step: boolean): Own {
  const c = centreOf(own);
  const by = ((Math.atan2(to.y - c.y, to.x - c.x) - Math.atan2(from.y - c.y, from.x - c.x)) * 180) / Math.PI;
  const rot = own.rot + by;
  return { ...own, rot: normalAngle(step ? Math.round(rot / TURN_STEP) * TURN_STEP : rot) };
}

/** A shape nudged by whole screen pixels at the stage's size (`emuPerPx`). */
export function nudge(own: Own, dx: number, dy: number, emuPerPx: number): Own {
  return { ...own, box: round([own.box[0] + dx * emuPerPx, own.box[1] + dy * emuPerPx, own.box[2], own.box[3]]) };
}

/** The deck's lengths in his units: inches where the locale's paper is Letter, centimetres elsewhere, as PowerPoint follows the system. */
export type Unit = "in" | "cm";
export const unitFor = (locale: string): Unit => (paperFor(locale) === "Letter" ? "in" : "cm");
export const EMU_PER: Record<Unit, number> = { in: 914_400, cm: 360_000 };

/** A length in his units, to two places: "3.67". */
export const lengthText = (emu: number, unit: Unit): string => (emu / EMU_PER[unit]).toFixed(2);

/** A length he typed in his units ("3.5", "3.5 in", "9 cm"), as EMU; a unit he names wins. Null when it is not a length. */
export function parseLength(text: string, unit: Unit): number | null {
  const m = /^\s*(-?\d+(?:[.,]\d+)?|-?[.,]\d+)\s*(in|"|cm|mm|pt)?\s*$/i.exec(text);
  if (!m) return null;
  const n = Number(m[1].replace(",", "."));
  if (!Number.isFinite(n)) return null;
  const said = (m[2] ?? unit).toLowerCase();
  const per = said === '"' || said === "in" ? 914_400 : said === "cm" ? 360_000 : said === "mm" ? 36_000 : said === "pt" ? 12_700 : EMU_PER[unit];
  return Math.round(n * per);
}

/** What the label by the corner says while he drags: the size ("3.67 × 0.63 in"), or the turn ("35°"). */
export const sizeLabel = (own: Own, unit: Unit): string => `${lengthText(own.box[2], unit)} × ${lengthText(own.box[3], unit)} ${unit}`;
export const angleLabel = (own: Own): string => `${Math.round(own.rot) % 360}°`;

/** The `geometry` edit for a shape moved, resized or turned: only what changed. Null when nothing did. */
export function geometryOp(slide: number, shape: number, was: Own, now: Own): { op: "geometry"; slide: number; shape: number; box?: Box; rot?: number } | null {
  const moved = now.box.some((v, i) => v !== was.box[i]);
  const turned = normalAngle(now.rot) !== normalAngle(was.rot);
  if (!moved && !turned) return null;
  return { op: "geometry", slide, shape, ...(moved ? { box: now.box } : {}), ...(turned ? { rot: normalAngle(now.rot) } : {}) };
}
