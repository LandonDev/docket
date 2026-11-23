import { describe, expect, it } from "vitest";
import type { TellRow } from "@shared/work/tell";
import { digestNotice, emptyLine, FOLD_PAST, listSections, nameOf, nowToasts, openInterrupts, rowWhen, systemNotices, tellingOf } from "./notice";
import type { MergedDay } from "./store";

/** What the desktop shows of the digest, as rules over made-up rows. */

const at = (day: number, h: number, m = 0): number => new Date(2026, 10, day, h, m).getTime();
let n = 0;
const row = (over: Partial<TellRow> = {}): TellRow => ({
  id: `t${++n}`,
  host: "box",
  kind: "routines.done",
  group: "results",
  workspaceId: "ws",
  sector: "cosmic",
  title: "Morning summary",
  at: at(23, 9),
  how: "waiting",
  day: null,
  toldAt: null,
  ...over,
});
const day = (d: string, over: Partial<MergedDay> = {}): MergedDay => ({ day: d, madeAt: at(Number(d.slice(-2)), 8), seenAt: null, hosts: ["box"], ...over });

describe("the digest's notice", () => {
  it("is one line for every day he has not opened: the count and the jobs", () => {
    const view = {
      days: [day("2026-11-24"), day("2026-11-23", { seenAt: 5 })],
      rows: [row({ day: "2026-11-24", how: "digest" }), row({ day: "2026-11-24", how: "digest", sector: "purdue" }), row({ day: "2026-11-23", how: "digest", sector: "ref" }), row()],
    };
    const notice = digestNotice(view)!;
    expect(notice.line).toBe("Digest: 2 things in Cosmic and Purdue");
    expect(notice.days.map((d) => d.day)).toEqual(["2026-11-24"]);
  });
  it("covers several unseen days in one notice", () => {
    const view = { days: [day("2026-11-24"), day("2026-11-23")], rows: [row({ day: "2026-11-24", how: "digest" }), row({ day: "2026-11-23", how: "digest", sector: "ref" })] };
    expect(digestNotice(view)!.line).toBe("Digest: 2 things in Cosmic and Ref");
    expect(digestNotice(view)!.days).toHaveLength(2);
  });
  it("is gone once the day is seen anywhere, and says nothing of a day whose rows have all gone", () => {
    expect(digestNotice({ days: [day("2026-11-24", { seenAt: 9 })], rows: [row({ day: "2026-11-24", how: "digest" })] })).toBeNull();
    expect(digestNotice({ days: [day("2026-11-24")], rows: [] })).toBeNull();
    // one he was told of at once is in the day's list, not in its count
    expect(digestNotice({ days: [day("2026-11-24")], rows: [row({ day: "2026-11-24", how: "now", toldAt: 5 })] })).toBeNull();
    expect(digestNotice({ days: [], rows: [row()] })).toBeNull();
  });
});

describe("an interrupt", () => {
  const now = at(23, 12);
  it("is a toast while it is told, a day old at most, and not closed or opened here", () => {
    const a = row({ key: "prep:1", how: "now", toldAt: at(23, 11) });
    const b = row({ key: "clash:2", how: "now", toldAt: at(23, 10) });
    const old = row({ how: "now", toldAt: at(22, 9) });
    const view = { rows: [a, b, old, row()] };
    expect(openInterrupts(view, new Set(), now).map((r) => r.id)).toEqual([b.id, a.id]);
    expect(openInterrupts(view, new Set([tellingOf(a)]), now).map((r) => r.id)).toEqual([b.id]);
  });
  it("closed once, the same thing told again later shows again: a send that fails a second time", () => {
    const first = row({ key: "unsent:host:h1", how: "now", toldAt: at(23, 10) });
    const closed = new Set([tellingOf(first)]);
    expect(openInterrupts({ rows: [first] }, closed, now)).toEqual([]);
    const again = { ...first, toldAt: at(23, 11, 30) };
    expect(openInterrupts({ rows: [again] }, closed, now).map((r) => r.id)).toEqual([first.id]);
  });
  it("is one toast a row, its detail the second line", () => {
    const a = row({ key: "prep:1", title: "Budget review starts at 2:00 PM", detail: "With Dana Reyes", how: "now", toldAt: 1 });
    expect(nowToasts([a])).toEqual([{ id: "work-now:k:prep:1", title: "Budget review starts at 2:00 PM", detail: "With Dana Reyes", rows: [a] }]);
  });
  it("past three at once they fold into one, which stands for them all", () => {
    const rows = Array.from({ length: FOLD_PAST + 1 }, (_, i) => row({ key: `k${i}`, how: "now", toldAt: i + 1 }));
    expect(nowToasts(rows.slice(0, FOLD_PAST))).toHaveLength(FOLD_PAST);
    expect(nowToasts(rows)).toEqual([{ id: "work-now", title: "4 things need you now", rows }]);
  });
  it("names a row by its key on every host, and by its own id where it has none", () => {
    expect(nameOf(row({ key: "clash:1", host: "box" }))).toBe(nameOf(row({ key: "clash:1", host: "mac" })));
    expect(nameOf(row({ id: "x", host: "box" }))).not.toBe(nameOf(row({ id: "x", host: "mac" })));
  });
});

describe("the system notifications", () => {
  it("say the same two things: the digest silent under Work, an interrupt under its job in the app's voice", () => {
    const a = row({ key: "prep:1", sector: "purdue", title: "Budget review starts at 2:00 PM", detail: "With Dana Reyes", how: "now", toldAt: 1 });
    const digest = digestNotice({ days: [day("2026-11-24")], rows: [row({ day: "2026-11-24", how: "digest" })] });
    expect(systemNotices(digest, nowToasts([a]))).toEqual([
      { key: "digest:2026-11-24", title: "Work", body: "Digest: 1 thing in Cosmic", silent: true },
      { key: "work-now:k:prep:1", title: "Purdue", body: "Budget review starts at 2:00 PM: With Dana Reyes" },
    ]);
    const many = Array.from({ length: 4 }, (_, i) => row({ key: `k${i}`, how: "now", toldAt: i + 1 }));
    expect(systemNotices(null, nowToasts(many))).toEqual([{ key: "work-now", title: "Work", body: "4 things need you now" }]);
  });
});

describe("the list", () => {
  const now = at(24, 10);
  it("is sections by time, newest first: what waits, today's digest with its time, yesterday, then dates", () => {
    const view = {
      days: [day("2026-11-24"), day("2026-11-23"), day("2026-11-20")],
      rows: [row({ title: "Since" }), row({ day: "2026-11-24", how: "digest" }), row({ day: "2026-11-23", how: "digest" }), row({ day: "2026-11-20", how: "digest" })],
    };
    expect(listSections(view, now, "en-US").map((s) => s.title)).toEqual(["Since the digest", "Today, 8:00 AM", "Yesterday", "Fri, Nov 20"]);
  });
  it("orders a section by job, then newest, with what is about no one job last", () => {
    const view = {
      days: [day("2026-11-24")],
      rows: [
        row({ day: "2026-11-24", sector: "purdue", at: 1, title: "p-old" }),
        row({ day: "2026-11-24", sector: null, at: 9, title: "none" }),
        row({ day: "2026-11-24", sector: "cosmic", at: 2, title: "c" }),
        row({ day: "2026-11-24", sector: "purdue", at: 5, title: "p-new" }),
      ],
    };
    expect(listSections(view, now)[0]!.rows.map((r) => r.title)).toEqual(["c", "p-new", "p-old", "none"]);
  });
  it("leaves out a day whose rows have all gone, and is empty when nothing was told", () => {
    expect(listSections({ days: [day("2026-11-24")], rows: [] }, now)).toEqual([]);
  });
  it("ends a row with its clock in words when it has one, else when it was told, naming a day that is not today", () => {
    const held = { title: "Held: Invite Dana Reyes to Spring LAN walkthrough" };
    expect(rowWhen({ ...held, at: at(24, 9, 5) }, now, "en-US")).toBe("9:05 AM");
    expect(rowWhen({ ...held, at: at(23, 16, 20) }, now, "en-US")).toBe("Mon 4:20 PM");
    expect(rowWhen({ ...held, at: at(24, 9), by: at(24, 14) }, now, "en-US")).toBe("by 2:00 PM");
    expect(rowWhen({ ...held, at: at(23, 9), by: at(26, 14) }, now, "en-US")).toBe("by Nov 26, 2:00 PM");
  });
  it("a clock already past when it was told is no deadline: a failed send ends with when it failed", () => {
    expect(rowWhen({ title: "Not sent: Send to Rivera Dental", at: at(24, 5, 17), by: at(24, 5, 17) }, now, "en-US")).toBe("5:17 AM");
    expect(rowWhen({ title: "Not sent: Send to Rivera Dental", at: at(24, 5, 18), by: at(24, 5, 17) }, now, "en-US")).toBe("5:18 AM");
  });
  it("never says a clock twice: a row whose words carry its time ends with when it was told", () => {
    expect(rowWhen({ title: "Budget review starts at 2:00 PM", detail: "With Dana Reyes", at: at(24, 13, 50), by: at(24, 14) }, at(24, 13, 55), "en-US")).toBe("1:50 PM");
    expect(rowWhen({ title: "Prep is ready for Budget review", detail: "2:00 PM, with Dana Reyes", at: at(24, 8), by: at(24, 14) }, now, "en-US")).toBe("8:00 AM");
  });
  it("says since when Work has had nothing to tell: the thirty days the ledger keeps", () => {
    expect(emptyLine(at(24, 10), "en-US")).toBe("Work has had nothing to tell you since Oct 25.");
  });
});
