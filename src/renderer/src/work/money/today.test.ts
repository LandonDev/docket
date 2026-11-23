import { describe, expect, it, vi } from "vitest";
import type { MoneyOwed } from "@shared/contract-work-money";
import type { TodayWorkspace } from "../today/types";

const went: unknown[] = [];
vi.mock("../today/open", () => ({ goTo: (workspace: unknown, target: unknown) => void went.push([workspace, target]) }));
vi.mock("../today/read", () => ({ useEachWorkspace: () => ({ answers: [], loading: false, failed: [] }) }));

const { owedRows, source } = await import("./today");
const { TODAY_SOURCES } = await import("../today/sources");

const ref: TodayWorkspace = { environmentId: "box", workspaceId: "ws-ref", sector: "ref", name: "Ref", path: "/work/Ref", open: true };
const purdue: TodayWorkspace = { environmentId: "mac", workspaceId: "ws-purdue", sector: "purdue", name: "Purdue", path: "/work/Purdue", open: true };
const owed = (rows: MoneyOwed["rows"], toConfirm = 0): MoneyOwed => ({ rows, toConfirm });

describe("Money on Today", () => {
  it("is one of Today's sources, with a section of its own at 60 that is drawn only while something is owed", () => {
    expect(TODAY_SOURCES.map((s) => s.id)).toContain("money");
    expect(source.section).toEqual({ id: "money", title: "Owed", order: 60, empty: "", fold: 5 });
    // Nothing owed anywhere: no row, and so no section and no line.
    expect(owedRows([{ workspace: ref, value: owed([], 3) }])).toEqual([]);
  });

  it("lists each open row with who, which way and how long, and never the count that waits for his accept", () => {
    const rows = owedRows(
      [
        { workspace: ref, value: owed([{ workspaceId: "ws-ref", sector: "ref", row: 4, who: "West Side HS", what: "", amount: 8000, since: "2026-11-07", way: "toHim", reimburse: false, both: false }], 2) },
        { workspace: purdue, value: owed([{ workspaceId: "ws-purdue", sector: "purdue", row: 2, who: "", what: "", amount: 4500, since: null, way: "byHim", reimburse: false, both: false }]) },
      ],
      "2026-11-23",
    );
    expect(rows.map(({ open: _open, ...row }) => row)).toEqual([
      { key: "money:box:ws-ref:4", section: "money", sector: "ref", title: "West Side HS", detail: "Owes you $80.00", at: Date.parse("2026-11-07T12:00:00"), when: "16 days" },
      { key: "money:mac:ws-purdue:2", section: "money", sector: "purdue", title: "Entry", detail: "You owe $45.00" },
    ]);
    expect(JSON.stringify(rows)).not.toContain("confirm");
  });

  it("leads a cost to be paid back with what it was for, never as if the shop owed him", () => {
    const [row] = owedRows([{ workspace: ref, value: owed([{ workspaceId: "ws-ref", sector: "ref", row: 5, who: "Diner on 9th", what: "Crew meal before the game", amount: 1625, since: "2026-11-09", way: "toHim", reimburse: true, both: false }]) }], "2026-11-23");
    expect([row.title, row.detail]).toEqual(["Crew meal before the game", "To be paid back $16.25"]);
  });

  it("opens the row's own job in the Money view", () => {
    owedRows([{ workspace: purdue, value: owed([{ workspaceId: "ws-purdue", sector: "purdue", row: 2, who: "Catering", what: "", amount: 4500, since: "2026-11-20", way: "byHim", reimburse: false, both: false }]) }])[0].open();
    expect(went).toEqual([[purdue, { view: "money" }]]);
  });
});
