import { describe, expect, it } from "vitest";
import { holdStill } from "./hold";

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
