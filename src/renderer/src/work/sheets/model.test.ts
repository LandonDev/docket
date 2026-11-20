import { describe, expect, it } from "vitest";
import { cellText, chartBars, chartFrom, chartTicks, holds, sheetChanges, tickText } from "./model";
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

  it("makes bars from a range, leaving out a row without a number, on a round axis", () => {
    expect(chartBars([["Item", "Total"], ["Flights", 5768], ["Hotel", "3969"], ["Ground", null]])).toEqual([
      { label: "Flights", value: 5768 },
      { label: "Hotel", value: 3969 },
    ]);
    expect(chartTicks(5768)).toEqual({ top: 6000, bottom: 0, ticks: [0, 2000, 4000, 6000] });
    expect(tickText(2000)).toBe("2k");
    expect(tickText(1_500_000)).toBe("1.5M");
  });

  it("puts a credit on a signed axis: zero always on it, round steps on both sides, a minus sign in its words", () => {
    // Mixed: one step from the whole span, each end rounded out to a whole step.
    expect(chartBars([["Item", "Total"], ["Flights", 5768], ["Refund", -1200]])).toEqual([
      { label: "Flights", value: 5768 },
      { label: "Refund", value: -1200 },
    ]);
    expect(chartTicks(4000, -2000)).toEqual({ top: 4000, bottom: -2000, ticks: [-2000, 0, 2000, 4000] });
    expect(chartTicks(5768, -1200)).toEqual({ top: 10000, bottom: -5000, ticks: [-5000, 0, 5000, 10000] });
    // All below zero: the mirror of the positive axis.
    expect(chartTicks(0, -5768)).toEqual({ top: 0, bottom: -6000, ticks: [-6000, -4000, -2000, 0] });
    // Nothing but zeros: the one tick.
    expect(chartTicks(0, 0)).toEqual({ top: 1, bottom: 0, ticks: [0] });
    expect(tickText(-2000)).toBe("\u22122k");
    expect(tickText(-40)).toBe("\u221240");
  });

  it("names a new chart for its value column and sets it right of the selection", () => {
    const chart = chartFrom({ sheet: "s", reference: "A3:B8", range: { startRow: 2, endRow: 7, startColumn: 0, endColumn: 1 } }, [["Item", "Total"]], "c1");
    expect(chart).toEqual({ id: "c1", sheet: "s", range: "A3:B8", title: "Total", row: 2, col: 3 });
  });
});
