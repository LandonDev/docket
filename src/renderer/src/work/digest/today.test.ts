import { describe, expect, it, vi } from "vitest";
import type { TellRow } from "@shared/work/tell";
import { ALSO_GROUPS, alsoRows } from "./today";

/** What the digest adds to Today: only the groups no section of Today reads for itself. */

const at = (day: number, h: number, m = 0): number => new Date(2026, 10, day, h, m).getTime();
const DAY = { from: at(24, 0), to: at(25, 0) };
let n = 0;
const row = (over: Partial<TellRow>): TellRow => ({ id: `t${++n}`, host: "box", kind: "routines.done", group: "results", workspaceId: "ws", sector: "cosmic", title: "Morning summary", at: at(24, 7), how: "digest", day: "2026-11-24", toldAt: null, ...over });

describe("the digest's rows on Today", () => {
  it("are today's digest and what was told since, in the groups Today does not read itself", () => {
    const rows = [
      row({ title: "Morning summary", detail: "Done in 12m" }),
      row({ group: "ending", kind: "connections.ending", sector: null, title: "Sign-in to Frame.io ends Dec 5" }),
      row({ group: "system", kind: "outbox.offer", title: "You could stop holding Mail to Dana Reyes" }),
      row({ group: "people", kind: "docs.guest", title: "Dana Reyes edited Pricing notes" }),
      row({ day: null, how: "waiting", at: at(24, 9), title: "Nightly crash triage", detail: "Failed: the sign-in lapsed" }),
    ];
    const got = alsoRows({ rows }, DAY, () => {});
    expect(got.map((r) => [r.section, r.title, r.detail ?? null, r.sector])).toEqual([
      ["also", "Morning summary", "Done in 12m", "cosmic"],
      ["also", "Sign-in to Frame.io ends Dec 5", null, null],
      ["also", "You could stop holding Mail to Dana Reyes", null, "cosmic"],
      ["also", "Dana Reyes edited Pricing notes", null, "cosmic"],
      ["also", "Nightly crash triage", "Failed: the sign-in lapsed", "cosmic"],
    ]);
    expect(new Set(got.map((r) => r.key)).size).toBe(5);
    expect(ALSO_GROUPS).toEqual(["results", "ending", "system"]);
  });
  it("leave out every group Today reads for itself, so nothing shows twice", () => {
    const rows = [
      row({ group: "held", kind: "outbox.held", title: "Held: Send to Dana Reyes" }),
      row({ group: "meetings", kind: "prep.starting", title: "Budget review starts at 2:00 PM" }),
      row({ group: "clashes", kind: "clashes.new", title: "A clash" }),
      row({ group: "review", kind: "review.ready", title: "This week's review is ready" }),
      row({ group: "people", kind: "mail.waiting", title: "3 sent mails have no answer" }),
      row({ group: "people", kind: "messages.new", title: "New chat from Dana Reyes" }),
    ];
    expect(alsoRows({ rows }, DAY, () => {})).toEqual([]);
  });
  it("keep a receipt to confirm: Money's section on Today lists only what is owed", () => {
    const rows = [row({ group: "results", kind: "money.confirm", title: "A receipt to confirm", open: { view: "money", workspaceId: "w1" } })];
    expect(alsoRows({ rows }, DAY, () => {}).map((r) => [r.section, r.title])).toEqual([["also", "A receipt to confirm"]]);
  });
  it("leave out another day's digest, and what was told before today began", () => {
    const rows = [row({ day: "2026-11-23", title: "Yesterday's" }), row({ day: null, how: "waiting", at: at(23, 22), title: "Late last night" })];
    expect(alsoRows({ rows }, DAY, () => {})).toEqual([]);
  });
  it("a row's press is the tell's own target", () => {
    const open = vi.fn();
    const told = row({ open: { thread: "t1" } });
    alsoRows({ rows: [told] }, DAY, open)[0]!.open();
    expect(open).toHaveBeenCalledWith(told);
  });
});
