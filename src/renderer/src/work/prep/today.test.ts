import { describe, expect, it } from "vitest";
import type { PrepUpcoming } from "@shared/contract-work-prep";
import { TODAY_SOURCES } from "../today/sources";
import type { TodayWorkspace } from "../today/types";
import { prepMarks } from "./today";

/** Prep's marks on Today's meeting rows (docs/agents/work-prep.md "The borders"). */

const job = (workspaceId: string, sector: string): TodayWorkspace => ({ environmentId: "box", workspaceId, sector, name: sector, path: `/work/${sector}`, open: true });
const meeting = (over: Partial<PrepUpcoming>): PrepUpcoming => ({ workspaceId: "ws-purdue", sector: "purdue", eventId: "ev1", title: "Staff sync", startsAt: 1, endsAt: 2, with: ["Maya Chen"], state: "none", ...over });

describe("prep on Today", () => {
  it("marks each meeting's row: a press opens its page in its job, and only a brief says Prep is ready", () => {
    const purdue = job("ws-purdue", "purdue");
    const cosmic = job("ws-cosmic", "cosmic");
    // one host answers every job of its own to each job's ask
    const all = { meetings: [meeting({}), meeting({ eventId: "ev2", state: "briefed" }), meeting({ eventId: "ev3", state: "after" }), meeting({ workspaceId: "ws-cosmic", sector: "cosmic", eventId: "c1", state: "working" })] };
    const went: unknown[] = [];
    const marks = prepMarks([{ workspace: purdue, value: all }, { workspace: cosmic, value: all }], (workspace, target) => void went.push({ workspace: workspace.workspaceId, target }));
    // each meeting once, from its own job
    expect(marks.map((m) => [m.key, m.note])).toEqual([["event:ev1", undefined], ["event:ev2", "Prep is ready"], ["event:ev3", undefined], ["event:c1", undefined]]);
    for (const mark of marks) mark.open!();
    expect(went).toEqual([
      { workspace: "ws-purdue", target: { view: "prep", event: "ev1" } },
      { workspace: "ws-purdue", target: { view: "prep", event: "ev2" } },
      { workspace: "ws-purdue", target: { view: "prep", event: "ev3" } },
      { workspace: "ws-cosmic", target: { view: "prep", event: "c1" } },
    ]);
    // a mark never makes a row, raises no fault and has no verb of its own
    expect(marks.every((m) => !m.late && !m.act && !m.whenLine)).toBe(true);
  });

  it("answers no mark for a host that said nothing", () => {
    expect(prepMarks([])).toEqual([]);
    expect(prepMarks([{ workspace: job("ws-purdue", "purdue"), value: { meetings: [] } }])).toEqual([]);
  });

  it("is one of Today's sources, loaded on its own", async () => {
    const mine = TODAY_SOURCES.find((s) => s.id === "prep");
    expect(mine).toBeTruthy();
    expect((await mine!.load()).source.id).toBe("prep");
  });
});
