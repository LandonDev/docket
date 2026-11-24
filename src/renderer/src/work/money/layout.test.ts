import { describe, expect, it } from "vitest";
import { CATEGORY_GRID, ENTRIES_TAIL, NARROW_ONLY, OWED_GRID, TO_CONFIRM_GRID, WIDE_ONLY } from "./layout";

/** The px a class string's last track (or width), wide and under 520px. */
const wide = (cls: string): number => Number(/(\d+)px\](?:\s|$)/.exec(cls.split(" ")[0])?.[1] ?? NaN);
const narrow = (cls: string): number => Number(/@max-\[520px\]\/money:\S*?(\d+)px\]/.exec(cls)?.[1] ?? NaN);

describe("one right edge for money", () => {
  it("ends every list's amounts 120px inside the column", () => {
    // By category and Owed: their last track and a 16px gap; To confirm: its track and a 12px gap.
    expect(wide(CATEGORY_GRID) + 16).toBe(120);
    expect(wide(OWED_GRID) + 16).toBe(120);
    expect(wide(TO_CONFIRM_GRID) + 12).toBe(120);
    // Entries hangs 8px past the column and its amount cell has 12px padding.
    expect(wide(ENTRIES_TAIL) + 12 - 8).toBe(120);
  });

  it("under 520px ends By category's and Entries' amounts on one 48px edge", () => {
    expect(narrow(CATEGORY_GRID) + 16).toBe(48);
    expect(narrow(ENTRIES_TAIL) + 12 - 8).toBe(48);
  });

  it("swaps Category's column for Who's second line on one width", () => {
    expect(WIDE_ONLY).toBe("@max-[520px]/money:hidden");
    expect(NARROW_ONLY).toContain("@max-[520px]/money:block");
  });
});
