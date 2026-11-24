import { describe, expect, it } from "vitest";
import type { TellRow } from "@shared/work/tell";
import { carryLegacy, digestNotice, emptyLine, FOLD_PAST, forgetGone, listSections, marked, nameOf, nowToasts, onlyToday, openInterrupts, refusedLine, rowWhen, systemNotices, tellingOf, tellingsOf, unansweredLine } from "./notice";
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
    // one he was told of at once, before the day was made, is in the day's list, not in its count
    expect(digestNotice({ days: [day("2026-11-24")], rows: [row({ day: "2026-11-24", how: "now", toldAt: at(24, 7) })] })).toBeNull();
    expect(digestNotice({ days: [], rows: [row()] })).toBeNull();
  });
  it("keeps saying a thing that waited and whose clock came due after the day was made: the day is still not opened", () => {
    const waited = row({ day: "2026-11-24", how: "now", toldAt: at(24, 9), sector: "purdue" });
    expect(digestNotice({ days: [day("2026-11-24")], rows: [waited] })!.line).toBe("Digest: 1 thing in Purdue");
  });
  it("judges a row by when its own host made the day: a host that made it late told its rows before that", () => {
    // The box made the day at 8:00, the Mac at 8:20; the Mac told this at once at 8:10, before its own day.
    const days = [day("2026-11-24", { hosts: ["box", "mac"], madeBy: { box: at(24, 8), mac: at(24, 8, 20) } })];
    const told = { ...row({ day: "2026-11-24", how: "now", toldAt: at(24, 8, 10) }), environmentId: "mac" };
    expect(digestNotice({ days, rows: [told] })).toBeNull();
    expect(digestNotice({ days, rows: [{ ...told, environmentId: "box" }] })!.line).toBe("Digest: 1 thing in Cosmic");
  });
  it("opens Today only when the one unseen day is today: Today shows that day alone", () => {
    const now = at(24, 10);
    expect(onlyToday([day("2026-11-24")], now)).toBe(true);
    expect(onlyToday([day("2026-11-24"), day("2026-11-23")], now)).toBe(false);
    expect(onlyToday([day("2026-11-23")], now)).toBe(false);
    expect(onlyToday([], now)).toBe(false);
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
  it("closed once, a new telling shows again: a send that fails a second time, a deadline brought forward", () => {
    const first = row({ key: `unsent:host:h1@${at(23, 10)}`, how: "now", toldAt: at(23, 10), by: at(23, 10) });
    const closed = new Set([tellingOf(first)]);
    expect(openInterrupts({ rows: [first] }, closed, now)).toEqual([]);
    const again = { ...first, key: `unsent:host:h1@${at(23, 11)}`, toldAt: at(23, 11, 30), by: at(23, 11) };
    expect(openInterrupts({ rows: [again] }, closed, now).map((r) => r.id)).toEqual([first.id]);
    const invite = row({ key: "held:lifeos:calendarOps:op1", how: "now", toldAt: at(23, 9), by: at(23, 15) });
    const sooner = { ...invite, toldAt: at(23, 11), by: at(23, 14) };
    expect(openInterrupts({ rows: [sooner] }, new Set([tellingOf(invite)]), now)).toHaveLength(1);
  });
  it("is the same telling unless its clock moved earlier, or it has one where the closed one had none", () => {
    const told = row({ key: "unsent:lifeos:outbox:ob1", how: "now", toldAt: at(23, 10), by: at(23, 10) });
    const marks = new Set([tellingOf(told)]);
    // a day old, its clock dropped: the same one
    expect(marked(marks, { ...told, by: undefined })).toBe(true);
    // a later clock: the same one (the host does not tell it again either)
    expect(marked(marks, { ...told, by: at(23, 12) })).toBe(true);
    // an earlier clock: new
    expect(marked(marks, { ...told, by: at(23, 9) })).toBe(false);
    // closed with no clock, told with one: new
    expect(marked(new Set([tellingOf({ ...told, by: undefined })]), told)).toBe(false);
  });
  it("forgets a key no host holds any more, so the next telling under it is new; a key some host holds keeps its mark", () => {
    const first = row({ key: "messages:c1", how: "now", toldAt: at(23, 10) });
    const marks = new Set([tellingOf(first), tellingOf(row({ key: "prep:ev1:1", by: at(23, 14) }))]);
    const kept = forgetGone(marks, [row({ key: "prep:ev1:1", host: "mac" })])!;
    expect([...kept]).toEqual([`k:prep:ev1:1@${at(23, 14)}`]);
    expect(marked(kept, { ...first, id: "again", toldAt: at(23, 11) })).toBe(false);
    expect(forgetGone(kept, [row({ key: "prep:ev1:1" })])).toBeNull();
  });
  it("carries forward a mark the release before saved, for the live row it names, in either old form", () => {
    const meeting = row({ key: "prep:ev1:1", how: "now", toldAt: at(23, 9), by: at(23, 14) });
    const message = row({ key: "messages:c1", how: "now", toldAt: at(23, 11) });
    // before round 3: key@toldAt; round 3: key@by. A new telling under the message's key (another toldAt) is not carried.
    expect(carryLegacy(new Set([`k:prep:ev1:1@${at(23, 9)}`, `k:messages:c1@${at(23, 8)}`]), [meeting, message])).toEqual([tellingOf(meeting)]);
    expect(carryLegacy(new Set([`k:prep:ev1:1@${at(23, 14)}`]), [meeting])).toEqual([tellingOf(meeting)]);
  });
  it("closed on one host's copy, the same meeting told by another host stays closed, and is heard once", () => {
    const box = row({ key: "prep:ev1:1", host: "box", how: "now", toldAt: at(23, 10), by: at(23, 14) });
    const mac = { ...box, id: "m1", host: "mac", toldAt: at(23, 10, 2) };
    expect(tellingOf(mac)).toBe(tellingOf(box));
    expect(openInterrupts({ rows: [mac] }, new Set([tellingOf(box)]), now)).toEqual([]);
    const heard = new Set([tellingOf(box)]);
    expect(systemNotices(null, nowToasts([mac]), (r) => heard.has(tellingOf(r)))[0]!.silent).toBe(true);
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
  it("say a long fold's tellings as a short fingerprint of the whole list, so one deadline moved is still a new notice", () => {
    const many = Array.from({ length: 40 }, (_, i) => row({ key: `held:lifeos:outbox:${"x".repeat(30)}${i}`, how: "now", toldAt: 1_000 + i }));
    const moved = many.map((r, i) => (i === 17 ? { ...r, by: 9_999 } : r));
    const a = systemNotices(null, nowToasts(many))[0]!;
    const b = systemNotices(null, nowToasts(moved))[0]!;
    expect(a.body).toBe(b.body);
    expect(a.telling!.length).toBeLessThan(1_000);
    expect(a.telling).not.toBe(b.telling);
    expect(tellingsOf(many)).toBe(tellingsOf([...many]));
  });
  it("say the same two things: the digest silent under Work, an interrupt under its job in the app's voice", () => {
    const a = row({ key: "prep:1", sector: "purdue", title: "Budget review starts at 2:00 PM", detail: "With Dana Reyes", how: "now", toldAt: 1 });
    const digest = digestNotice({ days: [day("2026-11-24")], rows: [row({ day: "2026-11-24", how: "digest" })] });
    expect(systemNotices(digest, nowToasts([a]))).toEqual([
      { key: "digest:2026-11-24", title: "Work", body: "Digest: 1 thing in Cosmic", silent: true },
      // the detail on a line of its own: a title that holds a colon is never joined to it by another
      // its telling: the same thing told again in the same words is a new notice (src/main/notice.ts)
      { key: "work-now:k:prep:1", title: "Purdue", body: "Budget review starts at 2:00 PM\nWith Dana Reyes", telling: "k:prep:1@" },
    ]);
    const many = Array.from({ length: 4 }, (_, i) => row({ key: `k${i}`, how: "now", toldAt: i + 1 }));
    // folded: every open one by name, newest first, as the phone's banner says it
    expect(systemNotices(null, nowToasts(many))).toEqual([{ key: "work-now", title: "Work", body: "4 things need you: Morning summary; Morning summary; Morning summary; Morning summary", telling: "k:k0@ k:k1@ k:k2@ k:k3@" }]);
  });
  it("sound only for a telling not heard before: a thing that joins sounds, a fold that loses one or breaks up does not", () => {
    const many = Array.from({ length: 5 }, (_, i) => row({ key: `k${i}`, how: "now", toldAt: i + 1 }));
    const heard = new Set(many.slice(0, 4).map(tellingOf));
    const isHeard = (r: TellRow): boolean => heard.has(tellingOf(r));
    // the fifth joined: the fold holds an unheard telling
    expect(systemNotices(null, nowToasts(many), isHeard)[0]!.silent).toBeUndefined();
    // the newest went: four he heard remain
    expect(systemNotices(null, nowToasts(many.slice(0, 4)), isHeard)[0]).toMatchObject({ key: "work-now", silent: true });
    // the fold breaks up: each of the three is one he heard
    expect(systemNotices(null, nowToasts(many.slice(0, 3)), isHeard).map((n) => n.silent)).toEqual([true, true, true]);
    // a thing on its own, new: it sounds
    expect(systemNotices(null, nowToasts([many[4]!]), isHeard)[0]!.silent).toBeUndefined();
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
  it("under a day's heading the told time names its day only when it is another day's: the heading is not said again on its rows", () => {
    const told = { title: "Morning summary" };
    // yesterday's digest: a row told that morning, and one told the evening before
    expect(rowWhen({ ...told, at: at(23, 7, 1) }, now, "en-US", "2026-11-23")).toBe("7:01 AM");
    expect(rowWhen({ ...told, at: at(22, 21, 14) }, now, "en-US", "2026-11-23")).toBe("Sun 9:14 PM");
    // today's digest holds what was told yesterday afternoon
    expect(rowWhen({ ...told, at: at(23, 16, 20) }, now, "en-US", "2026-11-24")).toBe("Mon 4:20 PM");
    const view = { days: [day("2026-11-23")], rows: [row({ day: "2026-11-23", how: "digest" })] };
    expect(listSections(view, now, "en-US").map((s) => s.day)).toEqual(["2026-11-23"]);
    expect(listSections({ days: [], rows: [row()] }, now, "en-US")[0]!.day).toBe("2026-11-24");
  });
  it("a clock already past when it was told is no deadline: a failed send ends with when it failed", () => {
    expect(rowWhen({ title: "Not sent: Send to Rivera Dental", at: at(24, 5, 17), by: at(24, 5, 17) }, now, "en-US")).toBe("5:17 AM");
    expect(rowWhen({ title: "Not sent: Send to Rivera Dental", at: at(24, 5, 18), by: at(24, 5, 17) }, now, "en-US")).toBe("5:18 AM");
  });
  it("never says a clock twice: a row whose words carry its time ends with when it was told", () => {
    expect(rowWhen({ title: "Budget review starts at 2:00 PM", detail: "With Dana Reyes", at: at(24, 13, 50), by: at(24, 14) }, at(24, 13, 55), "en-US")).toBe("1:50 PM");
    expect(rowWhen({ title: "Prep is ready for Budget review", detail: "2:00 PM, with Dana Reyes", at: at(24, 8), by: at(24, 14) }, now, "en-US")).toBe("8:00 AM");
    // whichever space the host's formatter put before PM
    expect(rowWhen({ title: "Budget review starts at 2:00\u202fPM", at: at(24, 13, 50), by: at(24, 14) }, at(24, 13, 55), "en-US")).toBe("1:50 PM");
  });
  it("says in one line since when Work has had nothing to tell: the thirty days the ledger keeps", () => {
    expect(emptyLine(at(24, 10), "en-US")).toBe("Nothing since Oct 25");
  });
  it("yesterday is the calendar day before, also on the night the clocks go back", () => {
    // Nov 1, 2026, 11:30 PM in a zone that fell back that morning: 24 hours earlier is still Nov 1 there.
    const late = new Date(2026, 10, 1, 23, 30).getTime();
    const view = { days: [day("2026-10-31", { madeAt: new Date(2026, 9, 31, 8).getTime() })], rows: [row({ day: "2026-10-31", how: "digest" })] };
    expect(listSections(view, late, "en-US").map((s) => s.title)).toEqual(["Yesterday"]);
  });
  it("names the hosts that did not answer or did not take a setting, in his words", () => {
    expect(unansweredLine([])).toBe("");
    expect(unansweredLine(["The Mac"])).toBe("The Mac did not answer");
    expect(unansweredLine(["The box", "The Mac", "The PC"])).toBe("The box, The Mac and The PC did not answer");
    expect(refusedLine([])).toBe("");
    expect(refusedLine(["The box", "The Mac"])).toBe("The box and The Mac did not take it");
  });
});
