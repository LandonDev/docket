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

/** Return never opens a row he cannot see. */
describe("a highlighted row out of sight", () => {
  const box = { scrollTop: 280, height: 380 };
  it("is one scrolled past the box's top or not yet reached at its bottom, by more than half its height", () => {
    expect(outOfSight({ top: 0, height: 28 }, box)).toBe(true);
    expect(outOfSight({ top: 260, height: 28 }, box)).toBe(true);
    expect(outOfSight({ top: 700, height: 28 }, box)).toBe(true);
  });
  it("is not one he can see half of or more, nor any row of a list with nothing laid out", () => {
    expect(outOfSight({ top: 280, height: 28 }, box)).toBe(false);
    expect(outOfSight({ top: 270, height: 28 }, box)).toBe(false);
    expect(outOfSight({ top: 640, height: 28 }, box)).toBe(false);
    expect(outOfSight({ top: 0, height: 28 }, { scrollTop: 500, height: 0 })).toBe(false);
  });
});
