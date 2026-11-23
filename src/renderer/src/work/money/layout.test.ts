import { describe, expect, it } from "vitest";
import { CATEGORY_GRID, ENTRIES_TAIL, OWED_GRID, TO_CONFIRM_GRID } from "./layout";

/** The px a class string's last track (or width) takes. */
const last = (cls: string): number => Number(/(\d+)px\]$/.exec(cls)?.[1] ?? NaN);

describe("one right edge for money", () => {
  it("ends every list's amounts 120px inside the column", () => {
    // By category and Owed: their last track and a 16px gap; To confirm: its track and a 12px gap.
    expect(last(CATEGORY_GRID) + 16).toBe(120);
    expect(last(OWED_GRID) + 16).toBe(120);
    expect(last(TO_CONFIRM_GRID) + 12).toBe(120);
    // Entries hangs 8px past the column and its amount cell has 12px padding.
    expect(last(ENTRIES_TAIL) + 12 - 8).toBe(120);
  });
});
