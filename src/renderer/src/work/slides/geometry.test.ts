import { describe, expect, it } from "vitest";
import type { DeckShape } from "@shared/contract-work-slides";
import { hit, inQuad, pickable, PICKABLE, readingOrder, ROTATE_RISE, selectionOf, type Quad } from "./geometry";

const box = (x0: number, y0: number, x1: number, y1: number): Quad => [
  [x0, y0],
  [x1, y0],
  [x1, y1],
  [x0, y1],
];
/** A box turned about its centre by `deg` clockwise, in a square slide's shares. */
function turned(q: Quad, deg: number): Quad {
  const cx = (q[0][0] + q[2][0]) / 2;
  const cy = (q[0][1] + q[2][1]) / 2;
  const r = (deg * Math.PI) / 180;
  return q.map(([x, y]) => [cx + (x - cx) * Math.cos(r) - (y - cy) * Math.sin(r), cy + (x - cx) * Math.sin(r) + (y - cy) * Math.cos(r)]) as unknown as Quad;
}
const shape = (id: number, quad: Quad | undefined, over: Partial<DeckShape> = {}): DeckShape => ({ id, name: `Shape ${id}`, bbox: null, text: "", kind: "other", ...(quad ? { quad: quad as DeckShape["quad"] } : {}), ...over });

describe("where a press lands", () => {
  it("is inside a box, a turned one and a mirrored one (corners the other way round), and not beside it", () => {
    const q = box(0.2, 0.2, 0.6, 0.4);
    expect(inQuad(q, 0.4, 0.3)).toBe(true);
    expect(inQuad(q, 0.61, 0.3)).toBe(false);
    const t = turned(q, 45);
    // The box's own corner is outside once it is turned; a point on its turned long axis is inside.
    expect(inQuad(t, 0.59, 0.21)).toBe(false);
    expect(inQuad(t, 0.4 + 0.1, 0.3 + 0.1)).toBe(true);
    // A shape with no area holds nothing: every corner on one point, or on one line.
    const dot: Quad = [[0.5, 0.5], [0.5, 0.5], [0.5, 0.5], [0.5, 0.5]];
    const line: Quad = [[0.1, 0.5], [0.9, 0.5], [0.9, 0.5], [0.1, 0.5]];
    expect([inQuad(dot, 0.5, 0.5), inQuad(dot, 0.2, 0.9), inQuad(line, 0.5, 0.5), inQuad(line, 0.5, 0.1)]).toEqual([false, false, false, false]);
    const mirrored = [q[1], q[0], q[3], q[2]] as unknown as Quad;
    expect(inQuad(mirrored, 0.4, 0.3)).toBe(true);
    expect(inQuad(mirrored, 0.1, 0.3)).toBe(false);
  });

  it("is the topmost shape under it, passing what cannot be picked", () => {
    const shapes = [shape(1, box(0, 0, 1, 1)), shape(2, box(0.2, 0.2, 0.6, 0.6)), shape(3, box(0.4, 0.4, 0.8, 0.8), { kind: "connector" }), shape(4, undefined)];
    expect(hit(shapes, 0.5, 0.5)?.id).toBe(2);
    expect(hit(shapes, 0.7, 0.7)?.id).toBe(1);
    expect(hit([shapes[2]], 0.5, 0.5)).toBeNull();
    expect(hit([], 0.5, 0.5)).toBeNull();
  });

  it("picks only the kinds whose box was held to the drawn pixels, and only shapes with a place", () => {
    expect(Object.entries(PICKABLE).filter(([, ok]) => !ok).map(([kind]) => kind)).toEqual(["connector", "frame"]);
    expect(pickable(shape(1, box(0, 0, 1, 1), { kind: "picture" }))).toBe(true);
    expect(pickable(shape(1, box(0, 0, 1, 1), { kind: "frame" }))).toBe(false);
    expect(pickable(shape(1, undefined))).toBe(false);
    // A host a release behind names no kind: a shape with a place is a shape.
    expect(pickable({ id: 1, name: "x", bbox: null, text: "", quad: box(0, 0, 1, 1) as DeckShape["quad"] })).toBe(true);
  });
});

describe("a selection on the stage", () => {
  it("has eight handles on the box's corners and edges and a rotate handle 22px over the top edge", () => {
    const s = selectionOf(box(0.25, 0.25, 0.75, 0.5), 800, 400);
    expect(s.corners).toEqual([
      { x: 200, y: 100 },
      { x: 600, y: 100 },
      { x: 600, y: 200 },
      { x: 200, y: 200 },
    ]);
    expect(s.handles).toHaveLength(8);
    expect(s.handles[1]).toEqual({ x: 400, y: 100 });
    expect(s.handles[5]).toEqual({ x: 400, y: 200 });
    expect(s.rotate).toEqual({ x: 400, y: 100 - ROTATE_RISE });
    expect(s.stem).toEqual([
      { x: 400, y: 95 },
      { x: 400, y: 83 },
    ]);
  });

  it("turns with the shape: a box turned a quarter has its rotate handle to its right", () => {
    // On a square stage, so a quarter turn stays a rectangle in pixels.
    const s = selectionOf(turned(box(0.4, 0.3, 0.6, 0.7), 90), 500, 500);
    const top = s.handles[1];
    expect(s.rotate.x).toBeCloseTo(top.x + ROTATE_RISE, 5);
    expect(s.rotate.y).toBeCloseTo(top.y, 5);
  });
});

describe("the order keys move a selection in", () => {
  it("is reading order, top to bottom then left to right, over what can be picked", () => {
    const shapes = [shape(1, box(0.5, 0.5, 0.9, 0.9)), shape(2, box(0.1, 0.1, 0.9, 0.2)), shape(3, box(0.1, 0.5, 0.4, 0.9)), shape(4, box(0.1, 0.3, 0.2, 0.4), { kind: "frame" })];
    expect(readingOrder(shapes).map((s) => s.id)).toEqual([2, 3, 1]);
  });
});
