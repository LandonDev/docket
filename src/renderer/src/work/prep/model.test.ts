import { describe, expect, it } from "vitest";
import { emptyPrepDoc, type PrepEvent, type PrepPage } from "@shared/contract-work-prep";
import { addedKey, dayWords, fileWhere, isOver, lastLabel, moreWords, nobodyOn, personLine, personTrail, pickable, problemWords, taskLine, timeWords, whenLine } from "./model";

/** A meeting's page in words (docs/agents/work-prep.md "The page"): the comma line, each row's second line and what trails it. */

const at = (hour: number, minute = 0, day = 23): number => new Date(2026, 10, day, hour, minute).getTime();
const NOW = at(9, 30);
const event = (over: Partial<PrepEvent> = {}): PrepEvent => ({ id: "ev1", title: "Staff sync", startsAt: at(14), endsAt: at(14, 45), allDay: false, ...over });

describe("the line under the title", () => {
  it("says the day, the time, the place and when to leave, as one comma sentence", () => {
    expect(whenLine(event({ location: "RecWell 204", leaveAt: at(13, 40) }), NOW)).toBe("Today, 2:00 to 2:45 PM, RecWell 204, leave 1:40");
  });

  it("keeps both halves of the day when a meeting crosses noon, and says a time alone when it has no end", () => {
    expect(timeWords(event({ startsAt: at(11, 30), endsAt: at(12, 15) }))).toBe("11:30 AM to 12:15 PM");
    expect(timeWords(event({ endsAt: undefined }))).toBe("2:00 PM");
    expect(timeWords(event({ allDay: true }))).toBe("all day");
  });

  it("names the day by how far it is", () => {
    expect(dayWords(at(14, 0, 24), NOW)).toBe("Tomorrow");
    expect(dayWords(at(14, 0, 22), NOW)).toBe("Yesterday");
    expect(dayWords(at(14, 0, 16), NOW)).toBe("Mon, Nov 16");
  });

  it("drops the leave time once the meeting has begun, and a place that is only spaces", () => {
    expect(whenLine(event({ location: "  ", leaveAt: at(13, 40) }), at(14, 10))).toBe("Today, 2:00 to 2:45 PM");
  });
});

describe("when a meeting is over", () => {
  it("is at its end, or an hour after its start when the calendar gave none", () => {
    expect(isOver(event(), at(14, 44))).toBe(false);
    expect(isOver(event(), at(14, 45))).toBe(true);
    expect(isOver(event({ endsAt: undefined }), at(14, 59))).toBe(false);
    expect(isOver(event({ endsAt: undefined }), at(15))).toBe(true);
  });
});

describe("a row's words", () => {
  it("gives a person their newest mail's subject, and its day or Declined at the end", () => {
    const mail = { id: "m1", subject: "Bracket for Friday", at: at(7, 30), unread: true };
    expect(personLine({ name: "Maya Chen", mail })).toBe("Bracket for Friday");
    expect(personTrail({ name: "Maya Chen", mail }, NOW)).toBe("7:30 AM");
    expect(personLine({ name: "Maya Chen", mail: { ...mail, subject: " " } })).toBe("(no subject)");
    expect(personTrail({ name: "Tom Beck", declined: true, mail }, NOW)).toBe("Declined");
    expect(personLine({ name: "Dana Reyes" })).toBeUndefined();
    expect(personTrail({ name: "Dana Reyes" }, NOW)).toBeUndefined();
  });

  it("says why a task is here, and nothing for one that only names the subject", () => {
    expect(taskLine({ id: "t1", title: "x", why: "asked", who: "Maya Chen" })).toBe("Asked by Maya Chen");
    expect(taskLine({ id: "t2", title: "x", why: "waiting", who: "Tom Beck" })).toBe("Waiting on Tom Beck");
    expect(taskLine({ id: "t3", title: "x" })).toBeUndefined();
  });

  it("says where a link lives, and counts the people past the ones drawn", () => {
    expect(fileWhere({ title: "Run of show", url: "https://www.docs.example.com/d/1" })).toBe("docs.example.com");
    expect(fileWhere({ title: "Notes" })).toBeUndefined();
    expect(moreWords(3)).toBe("and 3 more");
    expect(moreWords(0)).toBeUndefined();
    expect(lastLabel({ eventId: "e0", title: "Staff sync", startsAt: at(14, 0, 16), decided: [], open: [], tasks: [] })).toBe("Last time, Nov 16");
  });
});

describe("what did not load", () => {
  it("is one sentence, however many parts failed", () => {
    expect(problemWords([])).toBeNull();
    expect(problemWords(["tasks"])).toBe("Tasks did not load");
    expect(problemWords(["people", "tasks", "people"])).toBe("People and tasks did not load");
    expect(problemWords(["people", "tasks", "last"])).toBe("People, tasks and last time did not load");
  });
});

describe("who Add people can tick", () => {
  const page = (over: Partial<PrepPage>): Pick<PrepPage, "people" | "doc" | "morePeople"> => ({ people: [], morePeople: 0, doc: emptyPrepDoc(), ...over });

  it("is those already added, then the sector's people who are not on the event itself, each once", () => {
    const directory = [
      { _id: "p1", name: "Maya Chen", emails: ["MChen@school.edu", "maya@home.test"] },
      { _id: "p2", name: "Tom Beck", emails: ["tbeck@school.edu"] },
      { _id: "p3", name: "Dana Reyes", emails: [] },
      { _id: "p4", name: "Sam Whitaker", emails: ["sam@arena.com"] },
    ];
    const got = pickable(
      page({
        // Tom is on the event already; Maya was added by her second address; Dana by name
        people: [{ name: "Tom Beck", address: "tbeck@school.edu" }, { name: "Maya Chen", address: "maya@home.test", added: true }],
        doc: { ...emptyPrepDoc(), people: [{ name: "Maya Chen", address: "maya@home.test" }, { name: "Dana Reyes" }] },
      }),
      directory,
    );
    expect(got).toEqual([{ name: "Maya Chen", address: "maya@home.test" }, { name: "Dana Reyes" }, { name: "Sam Whitaker", address: "sam@arena.com", personId: "p4" }]);
  });

  it("knows a person by address, else by folded name, as the host does", () => {
    expect(addedKey({ name: "Dana", address: " Dana@X.test " })).toBe("dana@x.test");
    expect(addedKey({ name: "Dána  Reyes" })).toBe("~dana reyes");
    expect(nobodyOn(page({}))).toBe(true);
    expect(nobodyOn(page({ morePeople: 2 }))).toBe(false);
  });
});
