import { describe, expect, it } from "vitest";
import { CATEGORY_GRID, ENTRIES_TAIL, headIsNarrow, NARROW_HEAD, NARROW_ONLY, OWED_GRID, TO_CONFIRM_GRID, WIDE_HEAD, WIDE_ONLY } from "./layout";

/** The px a class string's last track (or width), wide and under 640px. */
const wide = (cls: string): number => Number(/(\d+)px\](?:\s|$)/.exec(cls.split(" ")[0])?.[1] ?? NaN);
const narrow = (cls: string): number => Number(/@max-\[640px\]\/money:\S*?(\d+)px\]/.exec(cls)?.[1] ?? NaN);

describe("one right edge for money", () => {
  it("ends every list's amounts 120px inside the column", () => {
    // By category and Owed: their last track and a 16px gap; To confirm: its track and a 12px gap.
    expect(wide(CATEGORY_GRID) + 16).toBe(120);
    expect(wide(OWED_GRID) + 16).toBe(120);
    expect(wide(TO_CONFIRM_GRID) + 12).toBe(120);
    // Entries hangs 8px past the column and its amount cell has 12px padding.
    expect(wide(ENTRIES_TAIL) + 12 - 8).toBe(120);
  });

  it("under 640px ends By category's and Entries' amounts on one 48px edge", () => {
    expect(narrow(CATEGORY_GRID) + 16).toBe(48);
    expect(narrow(ENTRIES_TAIL) + 12 - 8).toBe(48);
  });

  it("under 640px keeps Owed's press on its 120px edge", () => {
    expect(narrow(OWED_GRID) + 16).toBe(120);
  });

  it("swaps Category's column for Who's second line on one width", () => {
    expect(WIDE_ONLY).toBe("@max-[640px]/money:hidden");
    expect(NARROW_ONLY).toContain("@max-[640px]/money:block");
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

  it("walks the header's content widths around the boundary in quarter pixels: the toggle hides exactly where More takes its rows", () => {
    for (let content = NARROW_HEAD - 3; content <= NARROW_HEAD + 3; content += 0.25) {
      expect(headIsNarrow(content), `${content}px`).toBe(toggleHidden(content));
    }
    // Sol round 4: a 543.75px header is 519.75px of content (WorkViewPage's `pl-4 pr-2`): the toggle is hidden, so More
    // holds the choices, where an integer clientWidth of 544 said it need not.
    expect(headIsNarrow(543.75 - 24)).toBe(true);
    expect(headIsNarrow(508)).toBe(true);
    expect(headIsNarrow(520)).toBe(false);
  });

  it("holds nothing narrow for a header not laid out yet", () => {
    expect(headIsNarrow(0)).toBe(false);
  });
});
