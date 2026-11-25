import { describe, expect, it } from "vitest";
import { grantFor } from "../outbox/model";
import { calendarWords, dayLines, opFields, opStart, whenWords, type CalendarOp, type CalendarSource, type DayEvent } from "./calendarAct";

const at = (h: number, m = 0) => new Date(2026, 10, 20, h, m).getTime();
const call: DayEvent = { _id: "ev_call", title: "Kickoff call with Northside PT", sector: "unify", startsAt: at(14), endsAt: at(14, 30), allDay: false, location: "Google Meet" };
const day: DayEvent[] = [
  { _id: "ev_edit", title: "Editing review", sector: "hypixel", startsAt: at(9, 30), allDay: false },
  call,
  { _id: "ev_ref", title: "Varsity boys", sector: "ref", startsAt: at(19), allDay: false },
  { _id: "ev_hid", title: "Hidden", sector: "life", startsAt: at(12), allDay: false, hidden: true },
];

describe("a held calendar act's words", () => {
  it("reads an invitation's answer from its event", () => {
    const op: CalendarOp = { id: "op", kind: "accept", eventId: "ev_call", account: "landon@unify.dev" };
    expect(opFields(op, call).map((f) => [f.label, f.value])).toEqual([
      ["Event", "Kickoff call with Northside PT"],
      ["When", expect.stringContaining("2:00 to 2:30")],
      ["Where", "Google Meet"],
      ["Reply", "Yes"],
      ["Calendar", "landon@unify.dev"],
    ]);
  });

  it("names a shared calendar by its synced source's name, never the provider's id, the account only to tell two apart", () => {
    const team = "c_9f2k1@group.calendar.google.com";
    const sources: CalendarSource[] = [
      { kind: "gcal", channel: team, account: "landon@purdue.edu", label: "Esports Staff" },
      { kind: "gcal", channel: "landon@purdue.edu", account: "landon@purdue.edu", label: "landon@purdue.edu" },
      { kind: "gmail", account: "landon@purdue.edu", label: "Esports Staff" },
    ];
    const op: CalendarOp = { id: "op", kind: "accept", eventId: "ev_call", account: "landon@purdue.edu", calendarId: team };
    expect(opFields(op, call, sources).find((f) => f.label === "Calendar")?.value).toBe("Esports Staff");
    // Two synced calendars of one name: the account tells them apart.
    const twins = [...sources, { kind: "gcal", channel: "c_other@group.calendar.google.com", account: "landon@unify.dev", label: "Esports Staff" }];
    expect(calendarWords(op, twins)).toBe("Esports Staff, landon@purdue.edu");
    // Not synced, or LifeOS not read yet: the account alone, never the id.
    expect(calendarWords(op, null)).toBe("landon@purdue.edu");
    expect(calendarWords(op, [])).toBe("landon@purdue.edu");
    // A person's calendar is named by its address; an account's own by the account.
    expect(calendarWords({ account: "landon@purdue.edu", calendarId: "dana@purdue.edu" }, [])).toBe("dana@purdue.edu, landon@purdue.edu");
    expect(calendarWords({ account: "landon@purdue.edu", calendarId: "landon@purdue.edu" }, sources)).toBe("landon@purdue.edu");
    expect(calendarWords({ account: "landon@purdue.edu" })).toBe("landon@purdue.edu");
  });

  it("puts a proposal on its new time", () => {
    const op: CalendarOp = { id: "op", kind: "propose", eventId: "ev_call", payload: { proposedStart: at(16), proposedEnd: at(16, 30), comment: "Could we move it?" } };
    expect(opStart(op, call)).toBe(at(16));
    expect(opFields(op, call).find((f) => f.label === "Instead")?.value).toContain("4:00 to 4:30");
  });
});

describe("the day list", () => {
  it("shows the day in time order, the act's own event set apart, hidden ones left out", () => {
    const lines = dayLines({ id: "op", kind: "accept", eventId: "ev_call" }, day, call, "unify");
    expect(lines.map((l) => [l.title, l.own])).toEqual([
      ["Editing review", false],
      ["Kickoff call with Northside PT", true],
      ["Varsity boys", false],
    ]);
  });

  it("adds a new event in its slot, with no sector's mark but the workspace's", () => {
    const lines = dayLines({ id: "op", kind: "create", payload: { title: "Scrim", startsAt: at(17) } }, day, null, "purdue");
    expect(lines.map((l) => l.title)).toEqual(["Editing review", "Kickoff call with Northside PT", "Scrim", "Varsity boys"]);
    expect(lines.find((l) => l.title === "Scrim")).toMatchObject({ own: true, sector: "purdue" });
  });
});

describe("a calendar act's grant", () => {
  it("answers invitations on one account, or invites the named people; a change takes none", () => {
    expect(grantFor({ kind: "calendar.op", payload: { id: "op", kind: "accept", account: "a@b.c" } })).toEqual({ matcher: { kind: "accept", account: "a@b.c", calendarId: null }, label: "Accept invitations on a@b.c" });
    expect(grantFor({ kind: "calendar.op", payload: { id: "op", kind: "create", account: "a@b.c", payload: { attendees: [{ address: "Sam@Purdue.edu", name: "Sam" }] } } })).toEqual({
      matcher: { kind: "create", account: "a@b.c", calendarId: null, attendees: ["sam@purdue.edu"] },
      label: "Invites to Sam on a@b.c",
    });
    expect(grantFor({ kind: "calendar.op", payload: { id: "op", kind: "update", account: "a@b.c" } })).toBeNull();
    expect(grantFor({ kind: "calendar.op", payload: { id: "op", kind: "create", account: "a@b.c" } })).toBeNull();
  });

  it("shows the event's start as the host bound it for the press, over a live read", () => {
    const op: CalendarOp = { id: "o1", kind: "accept", eventId: "e1", eventStartsAt: at(9) };
    expect(opStart(op, { ...call, startsAt: at(11) } as DayEvent)).toBe(at(9));
  });

  it("draws the event's title, time and place as the host bound them, even with no live read", () => {
    const op: CalendarOp = { id: "o1", kind: "accept", eventId: "e1", eventTitle: "Budget review", eventStartsAt: at(9), eventEndsAt: at(10), eventLocation: "Room 210" };
    const rows = opFields(op, null);
    expect(rows.find((r) => r.label === "Event")?.value).toBe("Budget review");
    expect(rows.find((r) => r.label === "Where")?.value).toBe("Room 210");
    expect(rows.find((r) => r.label === "When")?.value).toBeTruthy();
    // a live read that says otherwise does not replace what the press binds
    expect(opFields(op, { ...call, title: "New contract approval", location: "Room 9" } as DayEvent).find((r) => r.label === "Where")?.value).toBe("Room 210");
  });
});

describe("when an act happens", () => {
  const d = new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric" });
  const t = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
  it("names one day once, and both days when the event runs into the next", () => {
    expect(whenWords(at(14), at(14, 30)).startsWith(`${d.format(at(14))}, `)).toBe(true);
    const late = new Date(2026, 10, 20, 22).getTime();
    const after = new Date(2026, 10, 21, 1).getTime();
    expect(whenWords(late, after)).toBe(`${d.format(late)}, ${t.format(late)} to ${d.format(after)}, ${t.format(after)}`);
  });

  it("names a day item's first and last days, its end being the midnight after", () => {
    const fri = new Date(2026, 10, 20).getTime();
    expect(whenWords(fri, new Date(2026, 10, 21).getTime(), true)).toBe(d.format(fri));
    expect(whenWords(fri, new Date(2026, 10, 23).getTime(), true)).toBe(`${d.format(fri)} to ${d.format(new Date(2026, 10, 22).getTime())}`);
  });
});
