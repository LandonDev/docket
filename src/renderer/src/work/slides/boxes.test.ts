import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { DeckShapeKind } from "@shared/contract-work-slides";
import { PICKABLE } from "./geometry";

/**
 * The box test (the editors plan, SLD3): a kind of shape can be picked on the stage only when the box the
 * outline gives it is where LibreOffice draws it, or handles would sit beside the shape. The numbers are
 * measured on a deck of one shape a kind (src/main/server/work/slides/fixtures/kinds.pptx and its README):
 * each shape's own box against the box around its pixels, in the shape's own frame, at 1920 by 1080.
 */
const measured = JSON.parse(readFileSync(join(__dirname, "../../../../main/server/work/slides/fixtures/kinds-pixels.json"), "utf8")) as {
  width: number;
  shapes: Array<{ name: string; kind: DeckShapeKind; found: boolean; px: number }>;
};
/** A handle is 8px: a box within 3px of the pixels at 1920 wide puts every handle on the shape's edge. */
const TOLERANCE = 3;

describe("which kinds of shape a hand can pick", () => {
  it("was measured on every kind the outline names but a frame, which is edited in PowerPoint", () => {
    expect(measured.width).toBe(1920);
    expect(measured.shapes.every((s) => s.found)).toBe(true);
    expect([...new Set(measured.shapes.map((s) => s.kind))].sort()).toEqual(["chart", "connector", "media", "other", "picture", "table", "text"]);
  });

  it("is exactly the kinds whose box is where the pixels are", () => {
    const byKind = new Map<DeckShapeKind, number>();
    for (const s of measured.shapes) byKind.set(s.kind, Math.max(byKind.get(s.kind) ?? 0, s.px));
    for (const [kind, worst] of byKind) expect([kind, PICKABLE[kind]], `${kind}: ${worst}px`).toEqual([kind, worst <= TOLERANCE]);
    expect(PICKABLE.frame).toBe(false);
  });

  it("holds a turned shape and every outline to its box: an ellipse, an arrow, a triangle, a rounded box", () => {
    const px = (name: string): number => measured.shapes.find((s) => s.name === name)!.px;
    expect(px("ellipse turned 30")).toBeLessThan(1);
    for (const name of ["ellipse", "arrow", "rounded box", "triangle", "text box", "picture", "table", "chart", "video"]) expect(px(name), name).toBeLessThanOrEqual(TOLERANCE);
    // A connector's box is its two ends: its line is drawn outside it.
    expect(px("connector")).toBeGreaterThan(TOLERANCE);
  });
});
