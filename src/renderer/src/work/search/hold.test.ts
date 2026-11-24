import { describe, expect, it } from "vitest";
import { holdStill, outOfSight } from "./hold";

/** The scroller taking up what lands above the highlighted row. */
describe("holding the highlighted row still", () => {
  it("moves the scroller by what landed above, and makes the box no taller than the rows from there down", () => {
    // The row was 56px from the box's top; 140px of rows landed above it, in a list now 420px tall.
    expect(holdStill({ rowTop: 196, was: 56, scrollHeight: 420, cap: 380 })).toEqual({ scrollTop: 140, height: 280 });
  });
  it("caps the box at the list's own cap when there is more below than fits", () => {
    expect(holdStill({ rowTop: 300, was: 100, scrollHeight: 900, cap: 380 })).toEqual({ scrollTop: 200, height: 380 });
  });
  it("lets the box be as tall as its rows again when nothing is above the fold", () => {
    expect(holdStill({ rowTop: 56, was: 56, scrollHeight: 300, cap: 380 })).toEqual({ scrollTop: 0, height: null });
    expect(holdStill({ rowTop: 28, was: 56, scrollHeight: 300, cap: 380 })).toEqual({ scrollTop: 0, height: null });
  });
});

/** Return never opens a row he cannot see. Both boxes are where they are drawn on screen. */
describe("a highlighted row out of sight", () => {
  // The list's box stands 96px down the window (under the field and the rule) and shows 380px.
  const box = { top: 96, bottom: 476 };
  const row = (top: number) => ({ top, bottom: top + 28 });
  it("is one scrolled past the box's top or not yet reached at its bottom, by more than half its height", () => {
    expect(outOfSight(row(-184), box)).toBe(true);
    expect(outOfSight(row(76), box)).toBe(true);
    expect(outOfSight(row(470), box)).toBe(true);
  });
  it("is not one he can see half of or more, nor the one row of a short list under the field, nor any row of a list with nothing laid out", () => {
    expect(outOfSight(row(96), box)).toBe(false);
    expect(outOfSight(row(86), box)).toBe(false);
    expect(outOfSight(row(456), box)).toBe(false);
    // one hit of one kind: the box is the row's own height, 96px down
    expect(outOfSight(row(96), { top: 96, bottom: 124 })).toBe(false);
    expect(outOfSight({ top: 0, bottom: 0 }, { top: 0, bottom: 0 })).toBe(false);
  });
});
