/** Tab names that share a start are cut in the middle, so the end that differs stays (decision 13). */
import { describe, expect, it } from "vitest";
import { tabEnds } from "./tabShrink";

describe("where a tab's name keeps its end", () => {
  it("keeps the word where names that share a start first differ", () => {
    const names = ["Purdue Esports Budget.xlsx", "Purdue Esports Roster.xlsx", "Events"];
    const ends = tabEnds(names);
    expect(names[0]!.slice(ends[0]!)).toBe("Budget.xlsx");
    expect(names[1]!.slice(ends[1]!)).toBe("Roster.xlsx");
    expect(ends[2]).toBeNull();
  });

  it("backs up to the word's start even when the differing letter is inside it", () => {
    const names = ["Spring LAN budget.docx", "Spring LAN bylaws.docx"];
    expect(tabEnds(names).map((end, i) => names[i]!.slice(end!))).toEqual(["budget.docx", "bylaws.docx"]);
  });

  it("cuts where they part inside a first word that has no break", () => {
    const names = ["Report2025.pdf", "Report2026.pdf"];
    expect(names[0]!.slice(tabEnds(names)[0]!)).toBe("5.pdf");
  });

  it("leaves a name whole-ended when nothing is shared, a start is short, or the names are the same", () => {
    expect(tabEnds(["Budget.xlsx"])).toEqual([null]);
    expect(tabEnds(["Bu one", "Bu two"])).toEqual([null, null]);
    expect(tabEnds(["Budget.xlsx", "Budget.xlsx"])).toEqual([null, null]);
    expect(tabEnds(["Events", "Events 2026"])).toEqual([null, 7]);
  });

  it("reads letters the same in either case", () => {
    const names = ["purdue esports Budget", "Purdue Esports Roster"];
    expect(tabEnds(names)).toEqual([15, 15]);
  });
});
