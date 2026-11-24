import { describe, expect, it } from "vitest";
import { CATEGORY_GRID, ENTRIES_TAIL, headIsNarrow, NARROW_HEAD, NARROW_ONLY, OWED_GRID, TO_CONFIRM_GRID, WIDE_HEAD, WIDE_ONLY } from "./layout";

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

  it("under 520px keeps Owed's press on its 120px edge", () => {
    expect(narrow(OWED_GRID) + 16).toBe(120);
  });

  it("swaps Category's column for Who's second line on one width", () => {
    expect(WIDE_ONLY).toBe("@max-[520px]/money:hidden");
    expect(NARROW_ONLY).toContain("@max-[520px]/money:block");
  });
});

/** Sol round 3 P2: the toggle hid at a width where More did not yet hold Month and Year. One boundary for both. */
describe("Month or Year in the header or in More, never neither", () => {
  // The container query: hidden while the content box is under the width WIDE_HEAD names (Tailwind's `@max-` is `<`).
  const cssWidth = Number(/@max-\[(\d+)px\]\/viewhead:hidden/.exec(WIDE_HEAD)?.[1] ?? NaN);
  const toggleHidden = (content: number): boolean => content < cssWidth;

  it("names one width in the CSS and the script", () => {
    expect(cssWidth).toBe(NARROW_HEAD);
  });

  it("walks the header's widths around the boundary: the toggle hides exactly where More takes its rows", () => {
    // The frame's header: 16px of padding at the start, 8px at the end (WorkViewPage's `pl-4 pr-2`).
    for (let client = NARROW_HEAD + 24 - 6; client <= NARROW_HEAD + 24 + 6; client++) {
      const content = client - 24;
      expect(headIsNarrow(client, 16, 8), `${client}px`).toBe(toggleHidden(content));
    }
    // Sol's width: 532px of header is 508px of content, so the toggle is hidden and More holds the choices.
    expect(headIsNarrow(532, 16, 8)).toBe(true);
    expect(headIsNarrow(544, 16, 8)).toBe(false);
    expect(headIsNarrow(543, 16, 8)).toBe(true);
  });

  it("holds nothing narrow for a header not laid out yet", () => {
    expect(headIsNarrow(0, 16, 8)).toBe(false);
  });
});
