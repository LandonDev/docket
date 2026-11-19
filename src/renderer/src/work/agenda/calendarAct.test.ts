import { describe, expect, it } from "vitest";
import { grantFor } from "../outbox/model";
import { dayLines, opFields, opStart, type CalendarOp, type DayEvent } from "./calendarAct";

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
});
