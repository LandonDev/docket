import { describe, expect, it, vi } from "vitest";
import { WORK_CHATS_KEY } from "../outbox/model";
import type { HostItem } from "../outbox/store";
import { dueRows, type DueTask } from "./due";
import { heldWhen } from "../outbox/when";
import { heldRows, placeOf } from "./held";
import { liveLine, meetingRows, placeAndPeople, type MeetingEvent } from "./meetings";
import { dayBounds, fold, merge } from "./model";
import { keepRows } from "./stable";
import type { TodayRow, TodayWorkspace } from "./types";
import { waitingRows, type Wait } from "./waiting";

/** Made-up rows, in the machine's own zone: every time is written as a local wall time. */
const at = (day: number, hour: number, minute = 0) => new Date(2026, 10, day, hour, minute).getTime();
const DAY = dayBounds(at(23, 12));
const job = (sector: string, environmentId = "box"): TodayWorkspace => ({ environmentId, workspaceId: `${environmentId}-${sector}`, sector: sector as TodayWorkspace["sector"], name: sector, path: `/w/${sector}`, open: true });
const JOBS = [job("purdue"), job("ref"), job("hypixel")];
const workspaceOf = (sector: string) => JOBS.find((w) => w.sector === sector) ?? null;

describe("meetings", () => {
  const event = (id: string, sector: string, title: string, startsAt: number, more: Partial<MeetingEvent> = {}): MeetingEvent => ({ _id: id, title, sector: sector as MeetingEvent["sector"], startsAt, endsAt: startsAt + 3_600_000, allDay: false, ...more });
  const EVENTS = [
    event("e3", "ref", "JV basketball, Harrison at West Lafayette", at(23, 18), { location: "Harrison High School", leaveAt: at(23, 17, 10) }),
    event("e1", "purdue", "Staff sync", at(23, 10, 30), { location: "CoRec 2212", attendees: [{ address: "DANA@example.edu" }, { address: "stranger@example.com" }] }),
    event("e0", "hypixel", "Render review", at(23, 9)),
    event("e4", "purdue", "Roster day", at(23, 0), { allDay: true, endsAt: at(24, 0) }),
    event("e5", "cosmic", "Standup", at(23, 8, 30)),
    event("e6", "purdue", "Hidden", at(23, 11), { hidden: true }),
    event("e7", "purdue", "Staff sync", at(24, 9)),
    event("e8", "ref", "Crew day", at(24, 0), { allDay: true, endsAt: at(25, 0) }),
  ];
  const ways = () => ({ workspaceOf, peopleOf: (sector: string) => (sector === "purdue" ? [{ _id: "p1", name: "Dana Reyes", emails: ["dana@example.edu"] }] : []), open: vi.fn(), prepare: vi.fn() });

  it("lists today's events of the jobs: all-day first, then by start; a sector with no job, a hidden event and tomorrow's are left out", () => {
    const { rows, note } = meetingRows(EVENTS, DAY, at(23, 9, 30), ways());
    expect(rows.map((r) => [r.key, r.when])).toEqual([
      ["event:e4", "All day"],
      ["event:e0", "9:00 AM"],
      ["event:e1", "10:30 AM"],
      ["event:e3", "6:00 PM"],
    ]);
    expect(rows.map((r) => r.at)).toEqual([0, 1, 2, 3]);
    expect(note).toBeUndefined();
  });

  it("words the place and the people as Agenda does", () => {
    const { rows } = meetingRows(EVENTS, DAY, at(23, 9, 30), ways());
    expect(rows.find((r) => r.key === "event:e1")!.detail).toBe("CoRec 2212, with Dana Reyes");
    expect(rows.find((r) => r.key === "event:e3")!.detail).toBe("Harrison High School");
    expect(rows.find((r) => r.key === "event:e0")!.detail).toBeUndefined();
    const crowd = [1, 2, 3, 4, 5].map((n) => ({ _id: `p${n}`, name: `Person ${n}`, emails: [`p${n}@example.edu`] }));
    expect(placeAndPeople(event("x", "purdue", "X", 0, { attendees: crowd.map((p) => ({ address: p.emails[0]! })) }), crowd)).toBe("With Person 1, Person 2, Person 3, and 2 more");
  });

  it("the live line is Leave while that is ahead, then in N min within the hour, then Now, then nothing", () => {
    const game = EVENTS[0]!;
    expect(liveLine(game, at(23, 9))).toBe("Leave 5:10 PM");
    expect(liveLine(game, at(23, 17, 9))).toBe("Leave 5:10 PM");
    // The leave time has passed: the hour before the start counts down.
    expect(liveLine(game, at(23, 17, 10))).toBe("in 50 min");
    expect(liveLine(game, at(23, 17, 59))).toBe("in 1 min");
    expect(liveLine(game, at(23, 18))).toBe("Now");
    expect(liveLine(game, at(23, 18, 59))).toBe("Now");
    expect(liveLine(game, at(23, 19))).toBeUndefined();
    const sync = EVENTS[1]!;
    // No leave time and more than an hour off: nothing moves.
    expect(liveLine(sync, at(23, 9))).toBeUndefined();
    expect(liveLine(sync, at(23, 9, 30))).toBe("in 60 min");
    expect(liveLine(sync, at(23, 10, 5))).toBe("in 25 min");
    // He has left: the trip is no longer a leave-by.
    expect(liveLine({ ...game, travel: { departedAt: at(23, 17) } }, at(23, 17, 5))).toBe("in 55 min");
    expect(liveLine(EVENTS[3]!, at(23, 9))).toBeUndefined();
  });

  it("a meeting that ended is past and folds into N earlier; it offers no Prepare", () => {
    const { rows } = meetingRows(EVENTS, DAY, at(23, 11, 45), ways());
    expect(rows.filter((r) => r.past).map((r) => r.key)).toEqual(["event:e0", "event:e1"]);
    expect(rows.find((r) => r.key === "event:e0")!.acts).toBeUndefined();
    expect(rows.find((r) => r.key === "event:e3")!.acts?.map((a) => a.label)).toEqual(["Prepare"]);
    const [section] = merge([{ source: { id: "meetings", section: { id: "meetings", title: "Meetings", order: 20, empty: "No meetings today" } }, answer: { rows } }]);
    const shown = fold(section!);
    expect(shown.earlier).toBe(2);
    expect(shown.rows.map((r) => r.key)).toEqual(["event:e4", "event:e3"]);
  });

  it("once every meeting has ended says so, with tomorrow's first timed event", () => {
    const timed = EVENTS.filter((e) => !e.allDay);
    const over = meetingRows(timed, DAY, at(23, 19, 30), ways());
    expect(over.rows.every((r) => r.past)).toBe(true);
    // The "N earlier" line already says today's are over: the note says only what comes next, and nothing with no tomorrow.
    expect(over.note).toBe("Tomorrow starts at 9:00 AM with Staff sync.");
    expect(meetingRows(timed.filter((e) => e.startsAt < DAY.to), DAY, at(23, 19, 30), ways()).note).toBeUndefined();
    // No meeting today at all: the section's own empty line says it, with no note.
    expect(meetingRows(timed.filter((e) => e.startsAt >= DAY.to), DAY, at(23, 9), ways())).toEqual({ rows: [] });
  });

  it("at midnight the day is the next one: yesterday's are gone and tomorrow's are today's", () => {
    const next = dayBounds(at(24, 0, 1));
    const { rows } = meetingRows(EVENTS, next, at(24, 0, 1), ways());
    expect(rows.map((r) => r.key)).toEqual(["event:e8", "event:e7"]);
  });

  it("the press opens the event in its job, and Prepare starts a thread there", () => {
    const w = ways();
    const { rows } = meetingRows(EVENTS, DAY, at(23, 9, 30), w);
    const sync = rows.find((r) => r.key === "event:e1")!;
    sync.open();
    expect(w.open).toHaveBeenCalledWith(JOBS[0], EVENTS[1]);
    void sync.acts![0]!.run();
    expect(w.prepare).toHaveBeenCalledWith(JOBS[0], EVENTS[1]);
  });
});

describe("due", () => {
  const task = (id: string, sector: string, title: string, more: Partial<DueTask> = {}): DueTask => ({ _id: id, title, sector: sector as DueTask["sector"], status: "todo", ...more });
  const TASKS = [
    task("t3", "purdue", "Order jerseys", { dueAt: at(23, 15) }),
    task("t9", "purdue", "Next week's", { dueAt: at(30, 9) }),
    task("t1", "ref", "Renew registration", { dueAt: at(21, 9) }),
    task("t2", "hypixel", "Pinned, no date", { pinned: true }),
    task("t4", "cosmic", "No job for this sector", { dueAt: at(23, 9) }),
    task("t5", "purdue", "Undated and unpinned"),
    task("t6", "ref", "Yesterday's", { dueAt: at(22, 17) }),
    task("t7", "purdue", "Tonight", { dueAt: at(23, 23, 59) }),
  ];
  const ways = () => ({ workspaceOf, open: vi.fn(), done: vi.fn(async () => {}), tomorrow: vi.fn(async () => {}) });
  const shown = (rows: TodayRow[]) => merge([{ source: { id: "due", section: { id: "due", title: "Due", order: 30, empty: "" } }, answer: { rows } }])[0]!.rows;

  it("keeps work-kit's Today group: pinned, or due before the next local midnight; a sector with no job is left out", () => {
    const rows = dueRows(TASKS, at(23, 12), ways());
    expect(rows.map((r) => r.key).sort()).toEqual(["task:t1", "task:t2", "task:t3", "task:t6", "task:t7"]);
  });

  it("orders the most overdue first, then today's by time, then the pinned with no date", () => {
    expect(shown(dueRows(TASKS, at(23, 12), ways())).map((r) => r.key)).toEqual(["task:t1", "task:t6", "task:t3", "task:t7", "task:t2"]);
  });

  it("says the due time as the Tasks view does, late once it has passed, and nothing for a task with no date", () => {
    const rows = dueRows(TASKS, at(23, 16), ways());
    const by = (key: string) => rows.find((r) => r.key === key)!;
    expect([by("task:t1").when, by("task:t1").late]).toEqual(["Nov 21", true]);
    expect([by("task:t6").when, by("task:t6").late]).toEqual(["Yesterday", true]);
    expect([by("task:t3").when, by("task:t3").late]).toEqual(["3:00 PM", true]);
    expect([by("task:t7").when, by("task:t7").late]).toEqual(["11:59 PM", undefined]);
    expect([by("task:t2").when, by("task:t2").late]).toEqual([undefined, undefined]);
  });

  it("at midnight a task due tomorrow becomes today's", () => {
    const tomorrow = [task("t8", "purdue", "Tomorrow morning", { dueAt: at(24, 9) })];
    expect(dueRows(tomorrow, at(23, 23, 59), ways())).toHaveLength(0);
    expect(dueRows(tomorrow, at(24, 0, 1), ways()).map((r) => r.key)).toEqual(["task:t8"]);
  });

  it("a row's tick, its Tomorrow and its press go to the job the task is in", async () => {
    const w = ways();
    const row = dueRows(TASKS, at(23, 12), w).find((r) => r.key === "task:t3")!;
    expect(row.lead).toMatchObject({ kind: "tick", label: "Mark Order jerseys done" });
    if (row.lead?.kind === "tick") await row.lead.run();
    expect(w.done).toHaveBeenCalledWith(JOBS[0], TASKS[0]);
    expect(row.acts!.map((a) => a.label)).toEqual(["Tomorrow"]);
    await row.acts![0]!.run();
    expect(w.tomorrow).toHaveBeenCalledWith(TASKS[0]);
    row.open();
    expect(w.open).toHaveBeenCalledWith(JOBS[0], TASKS[0]);
  });

  it("a row's tick and press look up the job when pressed: one built for a workspace since removed acts on the sector's job now", async () => {
    // Two workspaces hold Purdue; the row was built while the box's routed it.
    const mac = job("purdue", "mac");
    let routed = JOBS[0]!;
    const w = { ...ways(), workspaceOf: (sector: string) => (sector === "purdue" ? routed : workspaceOf(sector)) };
    const row = dueRows(TASKS, at(23, 12), w).find((r) => r.key === "task:t3")!;
    expect(row.workspace).toEqual({ environmentId: "box", workspaceId: "box-purdue" });
    // The box's workspace is removed; the Mac's routes Purdue now.
    routed = mac;
    if (row.lead?.kind === "tick") await row.lead.run();
    expect(w.done).toHaveBeenCalledWith(mac, TASKS[0]);
    row.open();
    expect(w.open).toHaveBeenCalledWith(mac, TASKS[0]);
  });
});

describe("waiting on others", () => {
  const wait = (id: string, sector: string | undefined, to: Wait["waiting"]["to"], subject: string, since: number, more: Partial<Wait> = {}): Wait => ({ _id: id, subject, ...(sector ? { sector: sector as NonNullable<Wait["sector"]> } : {}), waiting: { since, dueAt: since + 3 * 86_400_000, asked: false, to }, ...more });
  const WAITS = [
    wait("m2", "hypixel", [{ name: "Priya Nair", address: "priya@example.com" }, { address: "a@example.com" }, { address: "b@example.com" }], "Render queue access", at(20, 14)),
    wait("m1", "purdue", [{ name: "Marcus Bell", address: "marcus@example.edu" }], "Sponsor deck for the spring LAN", at(17, 9)),
    wait("m3", "cosmic", [{ address: "nobody@example.com" }], "No job for this sector", at(1, 9)),
    wait("m4", undefined, [{ address: "x@example.com" }], "By its account's sector", at(22, 23), { ownSector: "ref" }),
  ];
  const ways = () => ({ workspaceOf, open: vi.fn(), nudge: vi.fn(async () => {}), dismiss: vi.fn(async () => {}) });
  const shown = (rows: TodayRow[]) => merge([{ source: { id: "waiting", section: { id: "waiting", title: "Waiting on others", order: 40, empty: "" } }, answer: { rows } }])[0]!.rows;

  it("lists the longest wait first: whom he wrote to, the subject, how long he has waited", () => {
    const rows = shown(waitingRows(WAITS, DAY.from, ways()));
    expect(rows.map((r) => [r.title, r.detail, r.when, r.sector])).toEqual([
      ["Marcus Bell", "Sponsor deck for the spring LAN", "6 days", "purdue"],
      ["Priya Nair and 2 more", "Render queue access", "3 days", "hypixel"],
      // Sent late yesterday is a day.
      ["x@example.com", "By its account's sector", "1 day", "ref"],
    ]);
  });

  it("offers Nudge and Dismiss, each on the mail's own job, and the press opens the mail there", async () => {
    const w = ways();
    const row = waitingRows(WAITS, DAY.from, w).find((r) => r.key === "mail:m1")!;
    expect(row.acts!.map((a) => a.label)).toEqual(["Nudge", "Dismiss"]);
    await row.acts![0]!.run();
    expect(w.nudge).toHaveBeenCalledWith(JOBS[0], WAITS[1]);
    await row.acts![1]!.run();
    expect(w.dismiss).toHaveBeenCalledWith(WAITS[1]);
    row.open();
    expect(w.open).toHaveBeenCalledWith(JOBS[0], WAITS[1]);
  });
});

describe("waiting on you", () => {
  const item = (id: string, environmentId: string, workspaceId: string, createdAt: number): HostItem =>
    ({ ref: { at: "lifeos", table: "outbox", id }, environmentId, workspaceId, kind: "mail.send", sector: "purdue", summary: `Send to Dana Reyes: ${id}`, verb: "Send", account: null, state: "held", createdAt }) as unknown as HostItem;

  it("says when an item was held as a time that names its day, never as a bare date a late task's would be", () => {
    const now = at(23, 9, 30);
    expect(heldWhen(at(23, 7, 42), now)).toBe("7:42 AM");
    // Yesterday's and the week's name their day; before that, the date alone.
    expect(heldWhen(at(22, 19, 40), now)).toBe("Sun 7:40 PM");
    expect(heldWhen(at(17, 8, 5), now)).toBe("Tue 8:05 AM");
    expect(heldWhen(at(3, 14, 2), now)).toBe("Nov 3");
  });

  it("names a held row by its own workspace, where two hosts hold one for the sector under two names", () => {
    const names: Record<string, string> = { "box:ws1": "Purdue Esports", "mac:ws9": "Purdue" };
    const rows = heldRows([item("o1", "box", "ws1", at(23, 7)), item("o2", "mac", "ws9", at(23, 8)), item("o3", "mac", "gone", at(23, 9))], at(23, 9, 30), (i) => names[`${i.environmentId}:${i.workspaceId}`]);
    expect(rows.map((r) => r.job)).toEqual(["Purdue Esports", "Purdue", undefined]);
  });

  it("names an item's place as its sheet does: Work Chats for an item of no workspace", () => {
    const nameOf = (environmentId: string, workspaceId: string) => (workspaceId === "ws1" ? `${environmentId}'s Purdue` : undefined);
    expect(placeOf({ environmentId: "box", workspaceId: "ws1" }, nameOf)).toBe("box's Purdue");
    expect(placeOf({ environmentId: "box", workspaceId: null }, nameOf)).toBe("Work Chats");
    expect(placeOf({ environmentId: "box", workspaceId: WORK_CHATS_KEY }, nameOf)).toBe("Work Chats");
    expect(placeOf({ environmentId: "box", workspaceId: "gone" }, nameOf)).toBeUndefined();
  });
});

describe("rows that show the same stay the same objects", () => {
  const row = (key: string, more: Partial<TodayRow> = {}): TodayRow => ({ key, section: "meetings", sector: "purdue", title: key, open: () => {}, ...more });

  it("so a minute's tick redraws only the row whose line changed", () => {
    const before = [row("event:1", { whenLine: "in 26 min" }), row("event:2"), row("event:3", { acts: [{ label: "Prepare", run: () => {} }] })];
    const after = keepRows(before, [row("event:1", { whenLine: "in 25 min" }), row("event:2"), row("event:3", { acts: [{ label: "Prepare", run: () => {} }] })]);
    expect(after[0]).not.toBe(before[0]);
    expect(after[1]).toBe(before[1]);
    expect(after[2]).toBe(before[2]);
    // Nothing moved at all: the same array, so nothing downstream runs.
    expect(keepRows(before, [row("event:1", { whenLine: "in 26 min" }), row("event:2"), row("event:3", { acts: [{ label: "Prepare", run: () => {} }] })])).toBe(before);
  });

  it("a row whose verbs, order key or lead changed is a new row", () => {
    const before = [row("mail:1", { at: 5, acts: [{ label: "Nudge", run: () => {} }] })];
    expect(keepRows(before, [row("mail:1", { at: 6, acts: [{ label: "Nudge", run: () => {} }] })])[0]).not.toBe(before[0]);
    expect(keepRows(before, [row("mail:1", { at: 5, acts: [{ label: "Dismiss", run: () => {} }] })])[0]).not.toBe(before[0]);
    expect(keepRows(before, [row("mail:1", { at: 5 })])[0]).not.toBe(before[0]);
  });
});
