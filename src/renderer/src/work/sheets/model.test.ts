import { describe, expect, it } from "vitest";
import { cellText, holds, REVIEW_IDS_MOST, reviewBatches, sheetChanges, savedLine } from "./model";
import { suggestion } from "./testkit";

describe("the sheet canvas's model", () => {
  it("steps a run of neighbours as one change, a conflict alone, and a change set with no cells last", () => {
    const { changes, runs, groups } = sheetChanges([
      suggestion("a", 4, 1, { reason: "Group fare" }),
      suggestion("b", 4, 2),
      suggestion("c", 9, 1, { state: "conflict" }),
      suggestion("d", 2, 0, { changeSet: "cs2", state: "orphaned", reason: "Freight" }),
    ]);
    expect(changes.map((c) => [c.kind, c.ids])).toEqual([
      ["cells", ["a", "b"]],
      ["cells", ["c"]],
      ["orphaned", ["d"]],
    ]);
    expect(runs).toHaveLength(2);
    expect(groups).toEqual([
      { id: "cs1", label: "Group fare", by: "agent:local:t1", count: 2 },
      { id: "cs2", label: "Freight", by: "agent:local:t1", count: 1 },
    ]);
  });

  it("says a cell in words and knows whether a cell still holds what was laid", () => {
    expect(cellText({ v: 412 })).toBe("412");
    expect(cellText({ f: "=B5*D5", v: 5768 })).toBe("=B5*D5");
    expect(cellText(null)).toBe("empty");
    expect(holds({ v: 438, s: "usd" }, { v: 438 })).toBe(true);
    expect(holds({ v: 500 }, { v: 438 })).toBe(false);
    expect(holds({ f: "=A1", v: 3 }, { f: "=A1" })).toBe(true);
    expect(holds(null, null)).toBe(true);
  });
});

describe("the saved line", () => {
  const view = { name: "Budget.xlsx", store: "package" as const };

  it("says saved, with the time of his last edit once he has made one, and saving while one is on its way", () => {
    expect(savedLine(view, null, false, null)).toEqual({ state: "saved" });
    expect(savedLine(view, null, false, 1_700_000_000_000)).toEqual({ state: "saved", at: 1_700_000_000_000 });
    expect(savedLine(view, null, true, 1_700_000_000_000)).toEqual({ state: "saving" });
  });

  it("says a refused save in the host's words, with the press that makes it right: Reload on an Excel file, Retry elsewhere", () => {
    expect(savedLine(view, "That cell is locked", true, null)).toEqual({ state: "conflict", detail: "That cell is locked", again: "Reload" });
    expect(savedLine({ ...view, saveError: "The disk is full" }, null, false, null)).toEqual({ state: "conflict", detail: "The disk is full", again: "Reload" });
    expect(savedLine({ name: "Plan", store: "tcsheet" }, "The host did not answer", false, null)).toEqual({ state: "offline", detail: "The host did not answer", again: "Retry" });
  });

  it("says why a file cannot be changed here, before anything else", () => {
    expect(savedLine({ ...view, readOnly: "Saved as .xlsb, which opens here only to read" }, "x", true, 5)).toEqual({ state: "readonly", detail: "Saved as .xlsb, which opens here only to read" });
    expect(savedLine({ ...view, missing: true }, null, false, null)).toEqual({ state: "readonly", detail: "Budget.xlsx moved" });
  });
});

describe("what a press of Accept or Reject names", () => {
  const said = (changeSet: string, ids: string[]) => ({ kind: "orphaned" as const, changeSet, ids });
  const list = [said("cs1", ["cs1:A1", "cs1:A2"]), said("cs2", ["cs2:B1"])];
  it("names the ids on screen, for all, for a group and for one, so what came after he looked is not taken", () => {
    expect(reviewBatches(list, "all")).toEqual([{ ids: ["cs1:A1", "cs1:A2", "cs2:B1"] }]);
    expect(reviewBatches(list, { group: "cs2" })).toEqual([{ ids: ["cs2:B1"] }]);
    expect(reviewBatches(list, 0)).toEqual([{ ids: ["cs1:A1", "cs1:A2"] }]);
  });
  it("leaves out of Accept all and a group's Accept what can only be dropped: a conflict, an orphaned change, an orphaned format", () => {
    // Council r2 (Sol 10): a conflicting row sent with pending ones made the press write the pending ones and say it failed.
    const cell = (id: string, row: number, state: "pending" | "conflict") => ({ id, changeSet: "cs1", by: "agent:h:t1", sheet: "budget", row, col: 0, base: null, proposed: { v: 1 }, state });
    const mixed = sheetChanges([cell("cs1:A1", 0, "pending"), cell("cs1:A3", 2, "conflict"), { ...cell("cs1:A5", 4, "pending"), state: "orphaned" as const }], ["budget"], [
      { id: "f1", changeSet: "cs2", by: "agent:h:t1", kind: "format", sheet: "budget", range: null, words: "Bold", state: "orphaned" } as never,
    ]).changes;
    expect(reviewBatches(mixed, "all", "accept")).toEqual([{ ids: ["cs1:A1"] }]);
    expect(reviewBatches(mixed, { group: "cs1" }, "accept")).toEqual([{ ids: ["cs1:A1"] }]);
    // a reject takes them all, and one pressed by itself is still sent: the host says why it cannot be taken
    expect(reviewBatches(mixed, "all", "reject").flatMap((b) => b.ids).sort()).toEqual(["cs1:A1", "cs1:A3", "cs1:A5", "f1"]);
    expect(reviewBatches(mixed, mixed.findIndex((c) => c.ids.includes("cs1:A3")), "accept")).toEqual([{ ids: ["cs1:A3"] }]);
  });

  it("sends a large review as batches of the ids it shows, never all, and nothing for nothing on screen", () => {
    const many = [said("cs9", Array.from({ length: REVIEW_IDS_MOST * 2 + 1 }, (_, i) => `cs9:${i}`))];
    const batches = reviewBatches(many, "all");
    expect(batches.map((b) => b.ids.length)).toEqual([REVIEW_IDS_MOST, REVIEW_IDS_MOST, 1]);
    expect(batches.flatMap((b) => b.ids)).toEqual(many[0]!.ids);
    expect(reviewBatches(many, { group: "cs9" })).toHaveLength(3);
    expect(reviewBatches([], "all")).toEqual([]);
  });
});
