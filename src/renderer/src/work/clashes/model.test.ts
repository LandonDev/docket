import { describe, expect, it } from "vitest";
import type { Clash, ClashSide } from "@shared/work/clashes";
import { doneWords, formOf, freeAfter, lateDraft, lateMinutes, marksOf, sideOf, spanOf, wayWords } from "./model";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** A Thursday at noon, this machine's clock. */
const T0 = new Date(2026, 10, 26, 12, 0).getTime();

const side = (eventId: string, startH: number, hours: number, more: Partial<ClashSide> = {}): ClashSide => ({
  eventId,
  sector: "ref",
  title: eventId,
  startsAt: T0 + startH * HOUR,
  endsAt: T0 + (startH + hours) * HOUR,
  can: [],
  ...more,
});
const overlap = (more: Partial<Clash> = {}): Clash => ({ id: "a-b", kind: "overlap", a: side("a", 0, 2, { sector: "purdue", title: "Staff meeting" }), b: side("b", 1, 2, { title: "Varsity Basketball" }), ...more });
const drive = (more: Partial<Clash> = {}): Clash => ({ id: "a-b", kind: "drive", a: side("a", 0, 1), b: side("b", 1.5, 2), minutes: 45, miles: 30, measured: true, shortBy: 15, ...more });

describe("marksOf", () => {
  it("lists each event's clashes, its leave-by, and the events that clash at all", () => {
    const second: Clash = { ...overlap(), id: "b-c", a: overlap().b, b: side("c", 2, 1) };
    const marks = marksOf({ clashes: [overlap(), second], leaves: [{ eventId: "c", leaveAt: T0, from: "start", measured: true }] });
    expect(marks.ready).toBe(true);
    expect(marks.clashes.get("a")?.map((c) => c.id)).toEqual(["a-b"]);
    expect(marks.clashes.get("b")?.map((c) => c.id)).toEqual(["a-b", "b-c"]);
    expect([...marks.marked].sort()).toEqual(["a", "b", "c"]);
    expect(marks.leaves.get("c")?.leaveAt).toBe(T0);
    expect(marks.leaves.get("a")).toBeUndefined();
  });
});

describe("the time a move starts filled with", () => {
  it("is the first quarter hour after the other event that the drive allows, for as long as the event runs", () => {
    // The game ends at 3:00 and the drive is 38 minutes: 3:38 is offered as 3:45.
    const clash = overlap({ minutes: 38 });
    expect(freeAfter(clash, "a")).toEqual({ start: T0 + 3 * HOUR + 45 * MINUTE, end: T0 + 5 * HOUR + 45 * MINUTE });
  });

  it("moves the later event past the earlier one's end", () => {
    expect(freeAfter(overlap(), "b")).toEqual({ start: T0 + 2 * HOUR, end: T0 + 4 * HOUR });
  });

  it("names which side is which", () => {
    expect(sideOf(overlap(), "b").other.eventId).toBe("a");
    expect(sideOf(overlap(), "a").other.eventId).toBe("b");
  });
});

describe("running late", () => {
  it("is late by the minutes the drive is short", () => {
    expect(lateMinutes(drive())).toBe(15);
  });

  it("is late by the time two events share, and the drive between them", () => {
    expect(lateMinutes(overlap())).toBe(60);
    expect(lateMinutes(overlap({ minutes: 20 }))).toBe(80);
  });

  it("drafts one line to the people on the later event", () => {
    expect(lateDraft(drive({ b: side("b", 1.5, 2, { title: "Varsity Basketball" }) }), ["dana@example.com"])).toEqual({
      to: ["dana@example.com"],
      cc: [],
      bcc: [],
      subject: "Running late: Varsity Basketball",
      body: "I'm running about 15 minutes late.",
    });
    expect(lateDraft(drive({ shortBy: 1 }), []).body).toBe("I'm running about 1 minute late.");
  });
});

describe("the step's words", () => {
  it("says what goes and to whom", () => {
    expect(wayWords("decline", "Staff meeting")).toBe("Declines Staff meeting. Its organizer is told.");
    expect(wayWords("propose", "Staff meeting")).toBe("Asks the organizer of Staff meeting for this time. Nothing moves until they agree.");
    expect(wayWords("move", "Dinner")).toBe("Moves Dinner on your calendar.");
  });

  it("answers the press", () => {
    expect(doneWords("decline", "Staff meeting")).toBe("Declined Staff meeting");
    expect(doneWords("propose", "Staff meeting")).toBe("New time proposed for Staff meeting");
    expect(doneWords("move", "Dinner")).toBe("Moved Dinner");
  });
});

describe("the time fields", () => {
  it("round-trip a span on this machine's clock", () => {
    const span = { start: T0 + 45 * MINUTE, end: T0 + 2 * HOUR };
    expect(formOf(span)).toEqual({ day: "2026-11-26", from: "12:45", to: "14:00" });
    expect(spanOf(formOf(span))).toEqual(span);
  });

  it("say what is wrong in words", () => {
    expect(spanOf({ day: "", from: "12:00", to: "13:00" })).toBe("Pick a day and its times");
    expect(spanOf({ day: "2026-11-26", from: "13:00", to: "13:00" })).toBe("It must end after it starts");
  });
});
