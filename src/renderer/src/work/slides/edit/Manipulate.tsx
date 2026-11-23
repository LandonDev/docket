import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type Ref } from "react";
import type { DeckShape, DeckSlide } from "@shared/contract-work-slides";
import { modOrCtrl } from "../../../lib/keys";
import { HANDLE, hit, inQuad, ROTATE_HANDLE, selectionOf, type Quad } from "../geometry";
import {
  angleLabel,
  cornersOf,
  DRAG_START_PX,
  geometryOp,
  handleAt,
  linesOf,
  MIN_SIDE_PX,
  moveTo,
  nudge,
  quadOf,
  resizeTo,
  sizeLabel,
  SNAP_PX,
  turnTo,
  type Lines,
  type Own,
  type Pt,
  type Size,
  type Unit,
} from "./drag";
import type { HandSession, Landing } from "./session";

/**
 * His hand on a picked shape (docs/DESIGN.md "The slide editor"): the shape
 * dragged to move it, a handle to resize it, the turn handle to turn it, the
 * arrows to nudge it. While he drags, the shape's own picture, cut from the
 * stage along its corners, is carried at 80% where the pointer puts it, over
 * the picture as it was; guides mark the lines it meets; a label by the
 * corner says its size or its angle. On release one `geometry` edit goes, and
 * the carried picture stays until the stage paints the slide anew. Escape
 * puts it back. Nothing animates.
 */

/** How near a handle a press counts as on it, in screen pixels: wider than the handle drawn. */
const HANDLE_HIT = 8;
/** Nudges come one a key; they go as one edit once the keys rest this long. */
const NUDGE_REST_MS = 400;
/** The label's room, for keeping it on the stage: a size and an angle. */
const LABEL_W = { size: 104, angle: 40 } as const;
const LABEL_OFF = 6;

/** A shape the hand can move: picked by its corners, with its own box on the slide. */
export type Movable = DeckShape & { quad: Quad; own: NonNullable<DeckShape["own"]> };
export const movable = (shape: DeckShape | undefined): shape is Movable => !!shape?.quad && !!shape.own;
/** A table, a chart and media cannot be turned. */
export const turnable = (shape: DeckShape): boolean => shape.kind !== "table" && shape.kind !== "chart";

type Mode = { kind: "move" } | { kind: "resize"; handle: number } | { kind: "turn" } | { kind: "nudge" };

interface Live {
  mode: Mode;
  shape: Movable;
  was: Own;
  now: Own;
  guides: Lines;
}

export interface ManipulateHandle {
  /** A press on the stage's layer: it becomes a drag once the pointer moves. */
  down(event: PointerEvent | React.PointerEvent): void;
  /** The arrows: the picked shape by whole pixels of the stage. */
  nudge(shape: Movable, dx: number, dy: number): void;
  /** Whether the click that ends a drag is to be let go: the press was a drag, not a pick. */
  dragged(): boolean;
  /** Whether a drag or a run of nudges is live: Escape is its own then. */
  live(): boolean;
}

/** The affine that lays a box `w0` by `h0` (its own top-left at 0, 0) on a quad's corners, in stage pixels: a CSS matrix. */
function matrixOnto(q: readonly Pt[], w0: number, h0: number): [number, number, number, number, number, number] {
  return [(q[1].x - q[0].x) / w0, (q[1].y - q[0].y) / w0, (q[3].x - q[0].x) / h0, (q[3].y - q[0].y) / h0, q[0].x, q[0].y];
}

function invert([a, b, c, d, e, f]: readonly number[]): [number, number, number, number, number, number] {
  const det = a * d - b * c || 1;
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}

const px = (quad: Quad, w: number, h: number): Pt[] => quad.map(([x, y]) => ({ x: x * w, y: y * h }));
const css = (m: readonly number[]): string => `matrix(${m.map((v) => +v.toFixed(6)).join(",")})`;

/**
 * The shape's own picture, cut from the stage along its corners into its own box (turned and flipped back), as an
 * element `w0` by `h0` the caller lays where the shape goes. From the stage's canvas where there is one; else a copy
 * of what is drawn (a test's or a preview's page). Null with nothing drawn, or a shape with no area.
 */
export function carryOf(stage: Element | null, quad: Quad, w: number, h: number): { el: HTMLElement; w0: number; h0: number } | null {
  const host = stage?.querySelector<HTMLElement>("[data-slide-picture]");
  const q = px(quad, w, h);
  const w0 = Math.hypot(q[1].x - q[0].x, q[1].y - q[0].y);
  const h0 = Math.hypot(q[3].x - q[0].x, q[3].y - q[0].y);
  if (!host || !host.firstChild || w0 < 1 || h0 < 1 || w <= 0) return null;
  const doc = host.ownerDocument;
  const into = invert(matrixOnto(q, w0, h0));
  const source = host.querySelector("canvas");
  const ctx = source && source.width > 0 ? (() => {
    try {
      return doc.createElement("canvas").getContext("2d");
    } catch {
      return null;
    }
  })() : null;
  if (source && ctx) {
    const k = source.width / w;
    const out = ctx.canvas;
    out.width = Math.max(1, Math.ceil(w0 * k));
    out.height = Math.max(1, Math.ceil(h0 * k));
    // A pixel of the cut is k of its own box's px; the stage's pixel under it is where the shape's corners put it.
    const [a, b, c, d, e, f] = invert([...matrixOnto(q, w0, h0).slice(0, 4), q[0].x * k, q[0].y * k]);
    ctx.setTransform(a, b, c, d, e, f);
    ctx.drawImage(source, 0, 0);
    Object.assign(out.style, { position: "absolute", left: "0", top: "0", width: `${w0}px`, height: `${h0}px` });
    return { el: out, w0, h0 };
  }
  const box = doc.createElement("div");
  Object.assign(box.style, { position: "absolute", left: "0", top: "0", width: `${w0}px`, height: `${h0}px`, overflow: "hidden" });
  const copy = host.cloneNode(true) as HTMLElement;
  copy.removeAttribute("data-slide-picture");
  Object.assign(copy.style, { position: "absolute", inset: "auto", left: "0", top: "0", width: `${w}px`, height: `${h}px`, transformOrigin: "0 0", transform: css(into) });
  box.append(copy);
  return { el: box, w0, h0 };
}

export function Manipulate({
  ref,
  slide,
  shapes,
  picked,
  size,
  width: w,
  height: h,
  stage,
  session,
  land,
  unit,
  canMove,
  onPick,
  onLive,
  seed,
}: {
  ref: Ref<ManipulateHandle>;
  slide: DeckSlide;
  /** what a press can pick, in z-order */
  shapes: ReadonlyArray<DeckShape & { quad: Quad }>;
  picked: (DeckShape & { quad: Quad }) | undefined;
  /** the slide in EMU */
  size: Size;
  width: number;
  height: number;
  /** the stage, whose picture a drag cuts its shape from */
  stage: () => Element | null;
  session: HandSession;
  land: Landing | null;
  unit: Unit;
  /** whether his hand can move this shape now (the deck by hand, no suggestion on the slide, no box open) */
  canMove(shape: DeckShape): shape is Movable;
  onPick(shape: DeckShape): void;
  /** a drag or a run of nudges began, or ended: the selection's handles step aside meanwhile */
  onLive(live: boolean): void;
  /** a preview's: a shape being dragged by this much (EMU) when the stage mounts */
  seed?: { shape: number; dx: number; dy: number } | undefined;
}) {
  const [live, setLive] = useState<Live | null>(null);
  const liveRef = useRef<Live | null>(null);
  const carryHost = useRef<HTMLDivElement>(null);
  const carry = useRef<{ el: HTMLElement; w0: number; h0: number } | null>(null);
  const swallow = useRef(false);
  const stop = useRef<(() => void) | null>(null);
  const nudgeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const props = useRef({ onLive, session, slide, size });
  props.current = { onLive, session, slide, size };

  const show = (next: Live | null): void => {
    const was = liveRef.current;
    liveRef.current = next;
    setLive(next);
    if (!!was !== !!next) props.current.onLive(!!next);
  };
  const dropCarry = (): void => {
    carry.current?.el.remove();
    carry.current = null;
  };
  const takeCarry = (shape: Movable): void => {
    dropCarry();
    carry.current = carryOf(stage(), shape.quad, w, h);
    if (carry.current) carryHost.current?.append(carry.current.el);
  };

  /** The drag, or the run of nudges, ends: one edit with where it is now, the carried picture kept until it lands. */
  const finish = (commit: boolean): void => {
    const done = liveRef.current;
    clearTimeout(nudgeTimer.current);
    stop.current?.();
    stop.current = null;
    show(null);
    if (!done) return;
    const { session: hand, slide: on, size: emu } = props.current;
    const op = commit ? geometryOp(on.id, done.shape.id, done.was, done.now) : null;
    if (!op) return dropCarry();
    void hand.edit([op], "Couldn't move the shape", { slideKey: on.key, shapeId: done.shape.id, quad: quadOf(done.now, emu) });
  };

  // What was carried goes once the new picture has painted, or the edit failed (the session lets go of its landing).
  const mine = land && land.slideKey === slide.key && !land.ground ? land : null;
  useEffect(() => {
    if (!mine && !liveRef.current) dropCarry();
  }, [mine]);
  // A run of nudges still waiting when the stage leaves the slide goes, as a box commits when its tab closes.
  useEffect(
    () => () => {
      if (liveRef.current?.mode.kind === "nudge") finish(true);
      else stop.current?.();
      dropCarry();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  useLayoutEffect(() => {
    const shape = seed ? shapes.find((s) => s.id === seed.shape) : undefined;
    if (!seed || !shape || !canMove(shape)) return;
    const perPx = size.width / w;
    const got = moveTo(shape.own, seed.dx, seed.dy, linesOf(size, shapes.filter((s) => s.id !== shape.id)), { snap: true, tol: SNAP_PX * perPx, eps: perPx * 0.5 });
    show({ mode: { kind: "move" }, shape, was: shape.own, now: got.own, guides: got.guides });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useImperativeHandle(ref, () => ({
    dragged: () => {
      const was = swallow.current;
      swallow.current = false;
      return was;
    },
    live: () => !!liveRef.current,
    nudge(shape, dx, dy) {
      const now = liveRef.current;
      if (now && now.mode.kind !== "nudge") return;
      // A run of nudges on another shape (he tabbed on) goes first, as its own edit.
      if (now && now.shape.id !== shape.id) return finish(true);
      if (!now && (session.moving || !canMove(shape))) return;
      const was = now;
      if (!was) takeCarry(shape);
      const base = was ?? { mode: { kind: "nudge" } as const, shape, was: shape.own, now: shape.own, guides: { x: [], y: [] } };
      const moved = nudge(base.now, dx, dy, size.width / w);
      const lines = linesOf(size, shapes.filter((s) => s.id !== shape.id));
      show({ ...base, now: moved, guides: moveTo(moved, 0, 0, lines, { snap: false, tol: 0, eps: (size.width / w) * 0.5 }).guides });
      clearTimeout(nudgeTimer.current);
      nudgeTimer.current = setTimeout(() => finish(true), NUDGE_REST_MS);
      if (!stop.current) {
        const onKey = (event: KeyboardEvent): void => {
          if (event.key !== "Escape") return;
          event.preventDefault();
          event.stopPropagation();
          finish(false);
        };
        window.addEventListener("keydown", onKey, true);
        stop.current = () => window.removeEventListener("keydown", onKey, true);
      }
    },
    down(event) {
      swallow.current = false;
      if (event.button !== 0 || liveRef.current || session.moving || session.get().box) return;
      const layer = event.currentTarget as HTMLElement;
      const rect = layer.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      const at = { x: ((event.clientX - rect.left) / rect.width) * w, y: ((event.clientY - rect.top) / rect.height) * h };
      // On the picked shape: its turn handle, a handle, or its body; else the shape under the press, picked as it moves.
      let mode: Mode | null = null;
      let shape: DeckShape | undefined;
      if (picked && canMove(picked)) {
        const sel = selectionOf(picked.quad, w, h);
        const near = (p: Pt, r: number): boolean => Math.hypot(p.x - at.x, p.y - at.y) <= r;
        if (turnable(picked) && near(sel.rotate, ROTATE_HANDLE / 2 + 4)) mode = { kind: "turn" };
        else {
          const handle = sel.handles.findIndex((p) => near(p, Math.max(HANDLE_HIT, HANDLE)));
          if (handle >= 0) mode = { kind: "resize", handle };
          else if (inQuad(picked.quad, at.x / w, at.y / h)) mode = { kind: "move" };
        }
        if (mode) shape = picked;
        // A press on a handle is never a press on the slide: it does not let the shape go.
        if (mode && mode.kind !== "move") swallow.current = true;
      }
      if (!mode) {
        shape = hit(shapes, at.x / w, at.y / h) ?? undefined;
        if (shape) mode = { kind: "move" };
      }
      if (!mode || !shape || !canMove(shape)) return;
      const target: Movable = shape;
      const press = { x: event.clientX, y: event.clientY };
      const pointer = event.pointerId;
      const emuAt = (x: number, y: number): Pt => {
        const r = layer.getBoundingClientRect();
        return { x: ((x - r.left) / r.width) * size.width, y: ((y - r.top) / r.height) * size.height };
      };
      const from = emuAt(press.x, press.y);
      const perPx = size.width / rect.width;
      const lines = linesOf(size, shapes.filter((s) => s.id !== target.id));
      const grab = mode.kind === "resize" ? handleAt(target.own, mode.handle) : null;
      const how = mode;
      const move = (e: PointerEvent): void => {
        if (e.pointerId !== pointer) return;
        if (!liveRef.current) {
          if (Math.hypot(e.clientX - press.x, e.clientY - press.y) < DRAG_START_PX) return;
          if (picked?.id !== target.id) onPick(target);
          swallow.current = true;
          try {
            layer.setPointerCapture(pointer);
          } catch {
            /* a test's pointer */
          }
          takeCarry(target);
        }
        const to = emuAt(e.clientX, e.clientY);
        const snap = !(e.altKey || modOrCtrl(e));
        const opts = { snap, tol: SNAP_PX * perPx, eps: perPx * 0.5 };
        const got =
          how.kind === "turn"
            ? { own: turnTo(target.own, from, to, e.shiftKey), guides: { x: [], y: [] } }
            : how.kind === "resize" && grab
              ? resizeTo(target.own, how.handle, { x: grab.x + to.x - from.x, y: grab.y + to.y - from.y }, lines, { ...opts, keep: e.shiftKey, min: MIN_SIDE_PX * perPx })
              : moveTo(target.own, to.x - from.x, to.y - from.y, lines, opts);
        show({ mode: how, shape: target, was: target.own, now: got.own, guides: got.guides });
      };
      const up = (e: PointerEvent): void => {
        if (e.pointerId === pointer) finish(e.type === "pointerup");
      };
      const key = (e: KeyboardEvent): void => {
        if (e.key !== "Escape" || !liveRef.current) return;
        e.preventDefault();
        e.stopPropagation();
        swallow.current = true;
        finish(false);
      };
      const end = (): void => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", up);
        window.removeEventListener("keydown", key, true);
        try {
          layer.releasePointerCapture(pointer);
        } catch {
          /* already let go */
        }
      };
      stop.current?.();
      stop.current = end;
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", up);
      window.addEventListener("keydown", key, true);
    },
  }));

  // The carried picture lies where the shape is now: while he drags, and where he left it until the new picture lands.
  const quad = live ? quadOf(live.now, size) : mine && carry.current ? mine.quad : null;
  useLayoutEffect(() => {
    // A drag that began before the picture was drawn takes the shape's picture once there is one.
    if (live && !carry.current) takeCarry(live.shape);
    const c = carry.current;
    if (!c || !quad) return;
    c.el.style.transformOrigin = "0 0";
    c.el.style.transform = css(matrixOnto(px(quad, w, h), c.w0, c.h0));
  });

  const cover = land && land.slideKey === slide.key && land.ground ? land : null;
  const corners = live ? cornersOf(live.now).map((p) => ({ x: (p.x / size.width) * w, y: (p.y / size.height) * h })) : null;
  const label = live && live.mode.kind !== "nudge" ? (live.mode.kind === "turn" ? angleLabel(live.now) : sizeLabel(live.now, unit)) : null;
  const labelAt = corners ? labelPlace(corners, w, h, live?.mode.kind === "turn" ? LABEL_W.angle : LABEL_W.size) : null;
  return (
    <>
      <div ref={carryHost} data-slide-carry aria-hidden="true" className="pointer-events-none absolute inset-0 opacity-80" />
      {cover ? (
        <svg data-slide-cover aria-hidden="true" width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="pointer-events-none absolute inset-0 overflow-visible">
          <polygon points={px(cover.quad, w, h).map((p) => `${p.x},${p.y}`).join(" ")} fill={cover.ground} stroke={cover.ground} strokeWidth={3} strokeLinejoin="round" />
        </svg>
      ) : null}
      {live && corners ? (
        <svg data-slide-dragging={live.mode.kind} aria-hidden="true" width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="pointer-events-none absolute inset-0 overflow-visible">
          {live.guides.x.map((x) => (
            <line key={`x${x}`} data-slide-guide="x" x1={(x / size.width) * w} y1={0} x2={(x / size.width) * w} y2={h} stroke="var(--sel-line-dark-pic)" strokeWidth={1} />
          ))}
          {live.guides.y.map((y) => (
            <line key={`y${y}`} data-slide-guide="y" x1={0} y1={(y / size.height) * h} x2={w} y2={(y / size.height) * h} stroke="var(--sel-line-dark-pic)" strokeWidth={1} />
          ))}
          <polygon points={corners.map((c) => `${c.x},${c.y}`).join(" ")} fill="none" stroke="var(--sel-line-dark-pic)" strokeWidth={1} />
        </svg>
      ) : null}
      {label && labelAt ? (
        <span
          data-slide-drag-label
          aria-hidden="true"
          className="pointer-events-none absolute h-4 rounded-[4px] bg-(--sel-line-dark-pic) px-1 text-[11px] leading-4 font-medium whitespace-nowrap text-(--paper-ink) tabular-nums"
          style={{ left: labelAt.left, top: labelAt.top }}
        >
          {label}
        </span>
      ) : null}
    </>
  );
}

/** The label sits 6px off the drawn box's bottom-right corner, turned to its other side where the stage ends. */
export function labelPlace(corners: readonly Pt[], w: number, h: number, room: number): { left: number; top: number } {
  const right = Math.max(...corners.map((c) => c.x));
  const bottom = Math.max(...corners.map((c) => c.y));
  const left = right + LABEL_OFF + room > w ? Math.max(0, right - LABEL_OFF - room) : right + LABEL_OFF;
  const top = bottom + LABEL_OFF + 16 > h ? Math.max(0, bottom - LABEL_OFF - 16) : bottom + LABEL_OFF;
  return { left, top };
}
