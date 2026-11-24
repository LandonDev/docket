import { describe, expect, it } from "vitest";
import { clearBy } from "./usePointerHighlight";

/** A row the arrows move to stops clear of a list's faded edges, though the browser's own scroll leaves a row in view where it is. */
describe("how far a list scrolls for a row to stand clear of its edges", () => {
  // A list 380px tall, 96px down the window, whose edges fade over 32px.
  const box = { top: 96, bottom: 476 };
  const row = (top: number) => ({ top, bottom: top + 28 });
  const more = { above: true, below: true };
  it("brings a row that ends in the bottom edge up by what it lacks, and one in the top edge down", () => {
    // one arrow below a row that stood clear: wholly in view, 4px from the bottom
    expect(clearBy(row(444), box, 32, more)).toBe(28);
    expect(clearBy(row(100), box, 32, more)).toBe(-28);
  });
  it("leaves a row that stands clear, and an edge with no more list past it (nothing fades there)", () => {
    expect(clearBy(row(416), box, 32, more)).toBe(0);
    expect(clearBy(row(444), box, 32, { above: true, below: false })).toBe(0);
    expect(clearBy(row(100), box, 32, { above: false, below: true })).toBe(0);
  });
  it("asks nothing of a list with nothing laid out", () => {
    expect(clearBy({ top: 0, bottom: 0 }, { top: 0, bottom: 0 }, 32, more)).toBe(0);
  });
});
