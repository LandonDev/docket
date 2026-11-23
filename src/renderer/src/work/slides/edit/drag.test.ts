import { describe, expect, it } from "vitest";
import type { DeckShape } from "@shared/contract-work-slides";
import {
  angleLabel,
  cornersOf,
  geometryOp,
  handleAt,
  linesOf,
  moveTo,
  nudge,
  parseLength,
  quadOf,
  resizeTo,
  sizeLabel,
  turnTo,
  unitFor,
  type Own,
} from "./drag";

const SLIDE = { width: 12_192_000, height: 6_858_000 };
const own = (box: Own["box"], rot = 0, flipH = false, flipV = false): Own => ({ box, rot, flipH, flipV });
const near = (a: { x: number; y: number }, b: { x: number; y: number }): void => {
  expect(a.x).toBeCloseTo(b.x, 0);
  expect(a.y).toBeCloseTo(b.y, 0);
};
const NO_LINES = { x: [], y: [] };
const FREE = { snap: false, tol: 0, eps: 0.5 };

describe("a shape's place from its own box", () => {
  it("draws the corners the host draws: flipped, then turned clockwise about the centre", () => {
    const c = cornersOf(own([0, 0, 200, 100]));
    expect(c).toEqual([{ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 100 }, { x: 0, y: 100 }]);
    // A quarter turn: the top-left corner goes to the top-right of the turned box.
    const t = cornersOf(own([0, 0, 200, 100], 90));
    near(t[0], { x: 150, y: -50 });
    near(t[1], { x: 150, y: 150 });
    // Flipped across, its own top-left is drawn at the right.
    near(cornersOf(own([0, 0, 200, 100], 0, true))[0], { x: 200, y: 0 });
    expect(quadOf(own([0, 0, SLIDE.width / 2, SLIDE.height]), SLIDE)[2]).toEqual([0.5, 1]);
  });
});

describe("moving", () => {
  it("moves by the pointer and, with snap, pulls an edge or the centre onto the nearest line, with a guide there", () => {
    const shape = own([1000, 1000, 2000, 1000]);
    expect(moveTo(shape, 500, -300, NO_LINES, FREE).own.box).toEqual([1500, 700, 2000, 1000]);
    const lines = { x: [0, 6000, 12000], y: [0, 4000, 8000] };
    // The centre (2000 + 3990) comes 10 short of the middle line: pulled onto it.
    const got = moveTo(shape, 3990, 0, lines, { snap: true, tol: 20, eps: 0.5 });
    expect(got.own.box[0]).toBe(5000);
    expect(got.guides.x).toEqual([6000]);
    // Too far away: it stays where the pointer put it, and no guide.
    const off = moveTo(shape, 3900, 0, lines, { snap: true, tol: 20, eps: 0.5 });
    expect(off.own.box[0]).toBe(4900);
    expect(off.guides.x).toEqual([]);
    // No snap (Alt or Cmd): never pulled; a guide only where it lies exactly on a line.
    expect(moveTo(shape, 3990, 0, lines, FREE).own.box[0]).toBe(4990);
    expect(moveTo(shape, 4000, 0, lines, FREE).guides.x).toEqual([6000]);
  });

  it("lines up by the box it is drawn in when turned, and with other shapes' edges and centres", () => {
    const other: DeckShape = { id: 9, name: "", bbox: null, text: "", quad: [[0.5, 0.5], [0.75, 0.5], [0.75, 0.75], [0.5, 0.75]] };
    const lines = linesOf(SLIDE, [other]);
    expect(lines.x).toEqual([0, SLIDE.width / 2, SLIDE.width, SLIDE.width / 2, SLIDE.width * 0.625, SLIDE.width * 0.75]);
    // A square turned 45 degrees: its drawn box is wider than it is.
    const turned = own([0, 0, 1000, 1000], 45);
    const right = Math.max(...cornersOf(turned).map((p) => p.x));
    const got = moveTo(turned, 1000 - right + 5, 0, { x: [1000], y: [] }, { snap: true, tol: 10, eps: 0.5 });
    expect(Math.max(...cornersOf(got.own).map((p) => p.x))).toBeCloseTo(1000, 0);
  });
});

describe("resizing", () => {
  const opts = { keep: false, snap: false, tol: 0, eps: 0.5, min: 10 };

  it("keeps the far corner where it is and the handle under the pointer", () => {
    const shape = own([1000, 1000, 2000, 1000]);
    const got = resizeTo(shape, 4, { x: 4000, y: 2500 }, NO_LINES, opts).own;
    expect(got.box).toEqual([1000, 1000, 3000, 1500]);
    // The top-left handle: the bottom-right stays.
    const tl = resizeTo(shape, 0, { x: 500, y: 800 }, NO_LINES, opts).own;
    expect(tl.box).toEqual([500, 800, 2500, 1200]);
    // An edge handle moves its side alone.
    expect(resizeTo(shape, 3, { x: 3500, y: 9999 }, NO_LINES, opts).own.box).toEqual([1000, 1000, 2500, 1000]);
    // Never past the other side: the least size.
    expect(resizeTo(shape, 4, { x: 0, y: 0 }, NO_LINES, opts).own.box.slice(2)).toEqual([10, 10]);
  });

  it("keeps its proportions with Shift, a corner by the larger pull, an edge about the middle", () => {
    const shape = own([0, 0, 2000, 1000]);
    expect(resizeTo(shape, 4, { x: 4000, y: 1200 }, NO_LINES, { ...opts, keep: true }).own.box).toEqual([0, 0, 4000, 2000]);
    expect(resizeTo(shape, 3, { x: 3000, y: 0 }, NO_LINES, { ...opts, keep: true }).own.box).toEqual([0, -250, 3000, 1500]);
  });

  it("resizes a turned shape along its own width and height, its far corner fixed where it is drawn", () => {
    const shape = own([1000, 1000, 2000, 1000], 30);
    const far = handleAt(shape, 0);
    const pulled = handleAt(own([1000, 1000, 2600, 1300], 30), 4);
    // The pointer where the corner of a box 2600 by 1300 with the same top-left drawn corner would be.
    const shifted = { x: pulled.x + (far.x - handleAt(own([1000, 1000, 2600, 1300], 30), 0).x), y: pulled.y + (far.y - handleAt(own([1000, 1000, 2600, 1300], 30), 0).y) };
    const got = resizeTo(shape, 4, shifted, NO_LINES, opts).own;
    expect(got.rot).toBe(30);
    expect(got.box[2]).toBeCloseTo(2600, -1);
    expect(got.box[3]).toBeCloseTo(1300, -1);
    near(handleAt(got, 0), far);
    near(handleAt(got, 4), shifted);
  });

  it("snaps a square shape's moving edge to a line, and says so with a guide", () => {
    const shape = own([0, 0, 2000, 1000]);
    const got = resizeTo(shape, 3, { x: 2990, y: 500 }, { x: [3000], y: [500] }, { ...opts, snap: true, tol: 20 });
    expect(got.own.box[2]).toBe(3000);
    // Only the side that moves meets a line: the middle's y is not his to pull.
    expect(got.guides).toEqual({ x: [3000], y: [] });
    // Turned, nothing snaps.
    expect(resizeTo(own([0, 0, 2000, 1000], 10), 3, { x: 2990, y: 500 }, { x: [3000], y: [] }, { ...opts, snap: true, tol: 20 }).guides).toEqual({ x: [], y: [] });
  });
});

describe("turning", () => {
  it("adds how far the pointer went round the centre, and steps by 15 degrees with Shift", () => {
    const shape = own([0, 0, 200, 200]);
    // From straight above the centre to its right: a quarter turn clockwise.
    expect(turnTo(shape, { x: 100, y: -100 }, { x: 300, y: 100 }, false).rot).toBe(90);
    expect(turnTo(shape, { x: 100, y: -100 }, { x: 100 + 100, y: 100 - 173 }, false).rot).toBeCloseTo(30, 0);
    expect(turnTo(shape, { x: 100, y: -100 }, { x: 100 + 100, y: 100 - 150 }, true).rot).toBe(30);
    // Back past the start comes round to under 360.
    expect(turnTo(shape, { x: 100, y: -100 }, { x: -100, y: 100 }, false).rot).toBe(270);
  });
});

describe("the keyboard and the words", () => {
  it("nudges by whole pixels of the stage", () => {
    expect(nudge(own([1000, 1000, 50, 50]), 1, 0, 16_000).box).toEqual([17_000, 1000, 50, 50]);
    expect(nudge(own([1000, 1000, 50, 50]), 0, -10, 16_000).box).toEqual([1000, -159_000, 50, 50]);
  });

  it("says the size in his units and reads back what he types", () => {
    expect(unitFor("en-US")).toBe("in");
    expect(unitFor("en-GB")).toBe("cm");
    expect(sizeLabel(own([0, 0, 3_355_848, 576_072]), "in")).toBe("3.67 × 0.63 in");
    expect(sizeLabel(own([0, 0, 3_600_000, 360_000]), "cm")).toBe("10.00 × 1.00 cm");
    expect(angleLabel(own([0, 0, 1, 1], 359.6))).toBe("0°");
    expect(parseLength("2.5", "in")).toBe(2_286_000);
    expect(parseLength("3 cm", "in")).toBe(1_080_000);
    expect(parseLength("1,5", "cm")).toBe(540_000);
    expect(parseLength("wide", "in")).toBeNull();
  });

  it("makes one geometry edit of what changed, and none when nothing did", () => {
    const was = own([0, 0, 10, 10]);
    expect(geometryOp(3, 2, was, was)).toBeNull();
    expect(geometryOp(3, 2, was, own([5, 0, 10, 10]))).toEqual({ op: "geometry", slide: 3, shape: 2, box: [5, 0, 10, 10] });
    expect(geometryOp(3, 2, was, own([0, 0, 10, 10], 30))).toEqual({ op: "geometry", slide: 3, shape: 2, rot: 30 });
  });
});
