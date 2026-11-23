import { describe, expect, it } from "vitest";
import type { SheetMutationJson } from "@shared/contract-work-sheets";
import { RULE_MUTATIONS, RULE_NOISE, RULES_SET } from "@shared/work/sheets";
import { forPackage, latestRules, ruleKinds } from "./sync";

/**
 * A rule changed in an opened Excel file's grid (a conditional format, a validation, a name, the
 * filter) goes to the host as the whole list its change left, since the file is written a list at
 * a time; a store that lists no such control stops the change as he makes it.
 */
const noFormula = (): null => null;
const lists: Record<string, unknown> = {
  "conditional:s1": [{ cfId: "a" }, { cfId: "b" }],
  "validation:s1": [{ uid: "v" }],
  "names:": [{ id: "n", name: "Budget" }],
  "filter:s1": { ref: { startRow: 0, endRow: 9, startColumn: 0, endColumn: 3 } },
  "tables:s1": [{ id: "t", name: "Budget" }],
};
const rules = (kind: string, sheet?: string): unknown => lists[`${kind}:${sheet ?? ""}`];
const all = ruleKinds(["bold", "conditional", "validation", "names", "filter", "sort", "table"]);
const kept = (m: SheetMutationJson, opts: Parameters<typeof forPackage>[2] = { formats: true, rules, kinds: all }) => forPackage(m, noFormula, opts);

describe("the kinds of rule a row lists", () => {
  it("are the Data controls that name a list; a sort and the format controls name none", () => {
    expect([...all].sort()).toEqual(["conditional", "filter", "names", "tables", "validation"]);
    expect([...ruleKinds(["bold", "sort"])]).toEqual([]);
    expect([...ruleKinds(undefined)]).toEqual([]);
  });
});

describe("a rule changed in an opened Excel file", () => {
  it.each(Object.entries(RULE_MUTATIONS))("%s goes as its whole list", (id, kind) => {
    const got = kept({ id, params: kind === "names" ? { unitId: "workbook", id: "n" } : { unitId: "workbook", subUnitId: "s1" } });
    expect(got).toEqual({ keep: [{ id: RULES_SET, params: { kind, ...(kind === "names" ? {} : { subUnitId: "s1" }), list: lists[`${kind}:${kind === "names" ? "" : "s1"}`] } }] });
  });

  it("a filter taken off, or a sheet's last rule removed, goes as nothing there", () => {
    expect(kept({ id: "sheet.mutation.remove-filter", params: { subUnitId: "s2" } })).toEqual({ keep: [{ id: RULES_SET, params: { kind: "filter", subUnitId: "s2", list: null } }] });
  });

  it("what rides beside a filter's change, with nothing of its own, is dropped", () => {
    for (const id of RULE_NOISE) expect(kept({ id, params: { subUnitId: "s1" } })).toEqual({ keep: [] });
  });

  it("is stopped where the host lists no such control, where the grid cannot say its rules, and where a rule names no sheet", () => {
    const stop = { stop: "That change is not saved in an Excel file yet. Make it in Excel" };
    const add = { id: "sheet.mutation.add-conditional-rule", params: { subUnitId: "s1" } };
    expect(kept(add, { formats: true, rules, kinds: ruleKinds(["validation"]) })).toEqual(stop);
    expect(kept(add, { formats: true, kinds: all })).toEqual(stop);
    expect(kept(add, { formats: true })).toEqual(stop);
    expect(kept({ id: "sheet.mutation.add-conditional-rule", params: {} })).toEqual(stop);
    // a workbook Google holds says where the change is made
    expect(kept(add, { google: true })).toEqual({ stop: "That change is not saved in a Google sheet yet. Make it in Google Sheets" });
  });

  it("a sort is saved as it was: its mutation moves cells, and the structural path takes it", () => {
    const sort = { id: "sheet.mutation.reorder-range", params: { subUnitId: "s1" } };
    expect(kept(sort)).toEqual({ keep: [sort] });
  });
});

describe("one turn's rule lists", () => {
  const set = (kind: string, sheet: string | undefined, list: unknown): SheetMutationJson => ({ id: RULES_SET, params: { kind, ...(sheet ? { subUnitId: sheet } : {}), list } });
  it("are sent once each: the last of a kind on a sheet is the list as it stands", () => {
    const cell: SheetMutationJson = { id: "sheet.mutation.set-range-values", params: { subUnitId: "s1" } };
    const turn = [set("conditional", "s1", [1]), cell, set("conditional", "s1", [1, 2]), set("conditional", "s2", ["x"]), set("names", undefined, ["a"]), set("names", undefined, ["a", "b"]), set("validation", "s1", [])];
    expect(latestRules(turn)).toEqual([cell, set("conditional", "s1", [1, 2]), set("conditional", "s2", ["x"]), set("names", undefined, ["a", "b"]), set("validation", "s1", [])]);
  });

  it("a turn with no rule is itself", () => {
    const turn: SheetMutationJson[] = [{ id: "sheet.mutation.set-range-values", params: {} }];
    expect(latestRules(turn)).toBe(turn);
  });
});
