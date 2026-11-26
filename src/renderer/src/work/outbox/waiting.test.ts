import { describe, expect, it } from "vitest";
import { aheadTime, changesOf, dayLabel, doneDays, doneLine, doneWords, flatOrder, laterChoices, openOnly, resultsHead, rowSide, startsAt, summaryHead, tickable, waitingSections, whoWords, wordDiff, type Item } from "./waiting";

const NOW = new Date(2026, 10, 24, 9, 40).getTime();
const at = (d: number, h: number, m = 0) => new Date(2026, 10, d, h, m).getTime();

let n = 0;
const item = (over: Partial<Item> = {}): Item => ({
  environmentId: "box",
  ref: { at: "host", id: `h${++n}` },
  kind: "mail.send",
  state: "held",
  workspaceId: "purdue",
  sessionId: "roster",
  sector: "purdue",
  summary: "Send to Dana Lee: Re: budget",
  verb: "Send",
  payload: {},
  createdAt: at(24, 8),
  decidedBy: null,
  decidedAt: null,
  routineRunId: null,
  updatedAt: at(24, 8),
  ...over,
});

const ORDER = ["purdue", "cosmic", "hypixel"];
const places = {
  jobOrder: (_env: string, ws: string | null) => (ws ? ORDER.indexOf(ws) : 99),
  jobOf: (_env: string, ws: string | null) => ({ purdue: "Purdue Esports", cosmic: "Cosmic", hypixel: "Hypixel" })[ws ?? ""] ?? "Work Chats",
  titleOf: (i: Item) => ({ roster: "Nationals roster", release: "Release 2.14", sweep: "Morning sweep" })[i.sessionId ?? ""] ?? null,
};

describe("Waiting's order", () => {
  it("leads with Not sent and Starts soon, then each thread by job then its oldest item, then Scheduled", () => {
    const failed = item({ state: "failed", sessionId: "release", workspaceId: "cosmic", createdAt: at(23, 16) });
    const invite = item({ kind: "calendar.op", payload: { eventStartsAt: at(24, 14) }, sessionId: "sweep", createdAt: at(24, 7) });
    const later = item({ kind: "calendar.op", payload: { eventStartsAt: at(30, 14) }, sessionId: "sweep", createdAt: at(24, 7, 5) });
    const cosmic = item({ sessionId: "release", workspaceId: "cosmic", createdAt: at(24, 6) });
    const roster2 = item({ createdAt: at(24, 8, 11) });
    const roster1 = item({ createdAt: at(24, 8, 10) });
    const timed = item({ state: "scheduled", scheduledFor: at(25, 8), sessionId: "release", workspaceId: "cosmic" });
    const sections = waitingSections([cosmic, roster2, timed, invite, failed, roster1, later], places, NOW);
    expect(sections.map((s) => s.title)).toEqual(["Not sent", "Starts soon", "Morning sweep", "Nationals roster", "Release 2.14", "Scheduled"]);
    expect(sections[1]!.items).toEqual([invite]);
    // A thread's items oldest first; a job's threads by their oldest item.
    expect(sections[3]!.items).toEqual([roster1, roster2]);
    expect(sections.find((s) => s.title === "Release 2.14")!.items).toEqual([cosmic]);
    expect(flatOrder(sections)).toHaveLength(7);
  });

  it("names a group by its thread and its job, or by the job alone where no thread made it", () => {
    const [own, none] = waitingSections([item(), item({ sessionId: null, workspaceId: "hypixel" })], places, NOW);
    expect(own).toMatchObject({ kind: "thread", title: "Nationals roster", job: "Purdue Esports", sector: "purdue" });
    expect(none).toMatchObject({ kind: "thread", title: "Hypixel", job: null });
  });

  it("keeps an out-of-date invite out of Starts soon: it waits in its thread for Discard or Ask again", () => {
    const stale = item({ kind: "calendar.op", state: "stale", payload: { eventStartsAt: at(24, 14) } });
    expect(waitingSections([stale], places, NOW).map((s) => s.kind)).toEqual(["thread"]);
  });

  it("reads an Outlook invite's start as the host's deadline does", () => {
    expect(startsAt(item({ kind: "office.calendar.op", payload: { op: "create", event: { start: "2026-11-24T14:00:00" } } }))).toBe(at(24, 14));
    expect(startsAt(item({ kind: "office.calendar.op", payload: { op: "answer", start: "2026-11-25T10:00:00" } }))).toBe(at(25, 10));
    expect(startsAt(item({ kind: "calendar.op", payload: { payload: { startsAt: at(26, 9) } } }))).toBe(at(26, 9));
    expect(startsAt(item())).toBeNull();
  });
});

describe("a row's trailing word", () => {
  it("is the start in Starts soon, the time it goes in Scheduled, else Out of date, Sending, Changed or the held time", () => {
    const invite = item({ kind: "calendar.op", payload: { eventStartsAt: at(24, 14) } });
    expect(rowSide(invite, "soon", NOW)).toEqual({ text: "2:00 PM", strong: true });
    expect(rowSide(item({ scheduledFor: at(25, 8) }), "scheduled", NOW).text).toMatch(/^Wed 8:00/);
    expect(rowSide(item({ state: "stale" }), "thread", NOW).text).toBe("Out of date");
    expect(rowSide(item({ state: "sending" }), "thread", NOW).text).toBe("Sending");
    expect(rowSide(item({ changed: { at: at(24, 9, 20), by: "thread" } }), "thread", NOW).text).toBe("Changed");
    // His own edit is not news to him.
    expect(rowSide(item({ changed: { at: at(24, 9, 20), by: "you" } }), "thread", NOW).text).toBe("8:00 AM");
    expect(rowSide(item({ createdAt: at(23, 16, 10) }), "thread", NOW).text).toMatch(/^Mon 4:10/);
  });

  it("says a time ahead by its day this week and its date past that", () => {
    expect(aheadTime(at(24, 14), NOW)).toBe("2:00 PM");
    expect(aheadTime(at(26, 8), NOW)).toMatch(/^Thu 8:00/);
    expect(aheadTime(at(24, 8) + 9 * 86_400_000, NOW)).toMatch(/^Dec 3, 8:00/);
  });
});

describe("ticks and the summary", () => {
  it("ticks only what a plain press takes, and keeps a live screen's act, a computer act and a quoted reply for their own page", () => {
    expect(tickable(item())).toBe(true);
    expect(tickable(item({ state: "failed" }))).toBe(true);
    expect(tickable({ ...item({ state: "failed" }), outcomeUnknown: true } as never)).toBe(false);
    expect(tickable(item({ kind: "computer.act" }))).toBe(false);
    expect(tickable(item({ state: "stale" }))).toBe(false);
    expect(tickable(item({ state: "scheduled" }))).toBe(false);
    expect(openOnly(item({ state: "live" }))).toBe(true);
    expect(openOnly(item(), true)).toBe(true);
    expect(openOnly(item())).toBe(false);
  });

  it("sums what goes in one sentence: each kind's own verb, mail to how many people", () => {
    const mail = (address: string) => item({ payload: { message: { to: [{ address }], cc: [], bcc: [] } } });
    const head = summaryHead([mail("a@x.edu"), mail("b@x.edu"), mail("a@x.edu"), item({ kind: "teams.post", verb: "Post" }), item({ kind: "calendar.op", verb: "Accept" })]);
    expect(head).toBe("Send 3 mails to 2 people, post 1 message and accept 1 invite");
    expect(summaryHead([item({ kind: "calendar.op", verb: "Accept" }), item({ kind: "calendar.op", verb: "Decline" })])).toBe("Answer 2 invites");
    expect(summaryHead([], 3)).toBe("Discard 3");
  });

  it("says each result as its row does, and the sum once the press answered", () => {
    expect(doneWords({ state: "sent", lifeos: "queued", verb: "Send", kind: "mail.send", decidedAt: 1 }, "send")).toBe("Queued in LifeOS");
    expect(doneWords({ state: "sent", verb: "Post", kind: "teams.post", decidedAt: 1 }, "send")).toBe("Posted");
    expect(doneWords({ state: "sent", verb: "Accept", kind: "calendar.op", decidedAt: 1 }, "send")).toBe("Accepted");
    expect(doneWords({ state: "discarded", verb: "Send", kind: "mail.send", decidedAt: 1 }, "discard")).toBe("Discarded");
    const done = { state: "done" as const, words: "Posted" };
    const failed = { state: "failed" as const, words: "Gmail did not answer" };
    expect(resultsHead([done, done, done, done, done, failed], "send")).toBe("Sent 5, 1 not sent");
    expect(resultsHead([failed], "send")).toBe("1 not sent");
    expect(resultsHead([done, done], "discard")).toBe("Discarded 2");
  });
});

describe("Done", () => {
  it("groups by day, newest first", () => {
    const today = item({ state: "sent", decidedAt: at(24, 8, 41) });
    const earlier = item({ state: "sent", decidedAt: at(24, 7) });
    const yesterday = item({ state: "discarded", decidedAt: at(23, 16) });
    const days = doneDays([earlier, yesterday, today], NOW);
    expect(days.map((d) => d.label)).toEqual(["Today", "Yesterday"]);
    expect(days[0]!.items).toEqual([today, earlier]);
    expect(dayLabel(at(21, 9), NOW)).toMatch(/Sat/);
    expect(dayLabel(at(10, 9), NOW)).toMatch(/^Nov 10$/);
  });

  it("says who decided", () => {
    expect(whoWords({ decidedBy: "owner", via: "outbox" })).toBe("by you");
    expect(whoWords({ decidedBy: "owner:remote", via: "phone" })).toBe("from another device");
    expect(whoWords({ decidedBy: "grant:g1" }, { grantLabel: "Mail to Sam Ortiz" })).toBe("by the grant Mail to Sam Ortiz");
    expect(whoWords({ decidedBy: "owner", via: "request:r1" }, { threadTitle: "Nationals roster" })).toBe("from your approval in Nationals roster");
    expect(whoWords({ decidedBy: "owner", via: "scheduled" })).toBe("scheduled by you");
  });

  it("puts what went in the past, and says what he put away", () => {
    const words = { act: "Send to Dana Lee", about: "Re: budget" };
    expect(doneLine(item({ state: "sent" }), words, NOW)).toEqual({ act: "Sent to Dana Lee", about: "Re: budget" });
    expect(doneLine(item({ state: "discarded" }), words, NOW)).toEqual({ act: "Send to Dana Lee", about: "Re: budget", outcome: "Discarded" });
    expect(doneLine(item({ state: "stale" }), words, NOW)).toEqual({ act: "Send to Dana Lee", about: "Re: budget", outcome: "Out of date" });
    // What LifeOS holds or put back is the outcome, in the trailing slot, never the cut "about": a mail back in drafts never reads as sent.
    expect(doneLine(item({ state: "sent", lifeos: "queued", decidedAt: NOW - 12 * 60_000 }), words, NOW)).toEqual({ act: "Send to Dana Lee", about: "Re: budget", outcome: "Queued in LifeOS for 12m" });
    expect(doneLine(item({ state: "sent", lifeos: "drafts" }), words, NOW)).toEqual({ act: "Send to Dana Lee", about: "Re: budget", outcome: "Back in drafts in LifeOS" });
    expect(doneLine(item({ state: "sent", lifeos: "gone" }), words, NOW)).toEqual({ act: "Send to Dana Lee", about: "Re: budget", outcome: "No longer in LifeOS" });
  });
});

describe("Send later", () => {
  it("offers an hour on, this afternoon while the morning lasts, and tomorrow at 8", () => {
    expect(laterChoices(NOW).map((c) => c.label)).toEqual(["In an hour", "This afternoon", "Tomorrow morning"]);
    expect(laterChoices(NOW)[0]!.at).toBe(at(24, 10, 40));
    expect(laterChoices(NOW)[2]!.at).toBe(at(25, 8));
    expect(laterChoices(at(24, 15)).map((c) => c.label)).toEqual(["In an hour", "Tomorrow morning"]);
  });
});

describe("Show changes", () => {
  it("finds the words taken out and put in", () => {
    expect(wordDiff("Reply by Friday to confirm.", "Reply by Friday to confirm, Riley.")).toEqual([
      { t: "same", s: "Reply by Friday to " },
      { t: "del", s: "confirm." },
      { t: "ins", s: "confirm, Riley." },
    ]);
    expect(wordDiff("same", "same")).toEqual([{ t: "same", s: "same" }]);
  });

  it("lists each field a person reads that moved, and the body's difference", () => {
    const first = { message: { to: [{ address: "a@x.edu" }], subject: "Travel", text: "Bus at 7.\n\nLandon" } };
    const now = { message: { to: [{ address: "a@x.edu" }], subject: "Nationals travel", text: "Bus at 7. Room with Drew.\n\nLandon" } };
    const changes = changesOf(first, now);
    expect(changes.fields).toEqual([{ label: "Subject", was: "Travel", now: "Nationals travel" }]);
    expect(changes.body?.filter((p) => p.t === "ins").map((p) => p.s.trim())).toEqual(["Room with Drew."]);
    expect(changesOf(first, first)).toEqual({ fields: [], body: null });
  });
});

describe("council round 1: words that agree", () => {
  it("counts what LifeOS holds as queued, never as sent", () => {
    const queued = { state: "done" as const, words: "Queued in LifeOS" };
    const sent = { state: "done" as const, words: "" };
    const failed = { state: "failed" as const, words: "Outlook did not answer in time" };
    expect(resultsHead([queued, queued, queued, queued, queued, failed], "send")).toBe("Queued 5 in LifeOS, 1 not sent");
    expect(resultsHead([sent, queued], "send")).toBe("Sent 1, queued 1 in LifeOS");
  });

  it("says nothing beside a plain send's check, and the word where it adds", () => {
    expect(doneWords({ state: "sent", verb: "Send", kind: "mail.send", decidedAt: 1 }, "send")).toBe("");
    expect(doneWords({ state: "sent", verb: "Post", kind: "teams.post", decidedAt: 1 }, "send")).toBe("Posted");
  });

  it("names what goes nowhere by its kind, and an add-on call by what it does", () => {
    const mail = item({ payload: { message: { to: [{ address: "a@x.edu" }] } } });
    expect(summaryHead([mail], [item({ ref: { at: "host", id: "d1" } })])).toBe("Send 1 mail to 1 person and discard 1 mail");
    expect(summaryHead([], [item(), item()])).toBe("Discard 2 mails");
    const echo = (id: string) => item({ ref: { at: "host", id }, kind: "addon.call", verb: "Send", payload: { addonId: "a1", tool: "echo", words: "Echo", addon: "League" } });
    expect(summaryHead([echo("e1"), echo("e2"), echo("e3")])).toBe("Echo with League, 3 times");
  });
});
