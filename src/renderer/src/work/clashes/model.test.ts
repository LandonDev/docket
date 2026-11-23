import { describe, expect, it } from "vitest";
import type { Clash, ClashSide } from "@shared/work/clashes";
import { doneWords, endsNextDay, formOf, freeAfter, lateDraft, lateMinutes, marksOf, sideOf, spanOf, wayWords } from "./model";

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
  const morning = T0 - 4 * HOUR;

  it("offers the later event the first quarter hour after the earlier one that the drive allows", () => {
    // The meeting ends at 2:00 and the drive is 38 minutes: 2:38 is offered as 2:45, for the game's two hours.
    expect(freeAfter(overlap({ minutes: 38 }), "b", morning)).toEqual({ start: T0 + 2 * HOUR + 45 * MINUTE, end: T0 + 4 * HOUR + 45 * MINUTE });
    expect(freeAfter(overlap(), "b", morning)).toEqual({ start: T0 + 2 * HOUR, end: T0 + 4 * HOUR });
  });

  it("offers the earlier event the latest quarter hour that ends a drive before the later one starts", () => {
    // The game starts at 1:00 and the drive is 38 minutes: the two-hour meeting must end by 12:22, so 10:15 to 12:15.
    expect(freeAfter(overlap({ minutes: 38 }), "a", morning)).toEqual({ start: T0 - 105 * MINUTE, end: T0 + 15 * MINUTE });
  });

  it("moves the earlier event after the later one when no time before it is left today", () => {
    // It is already noon: nothing before the game is ahead of now.
    expect(freeAfter(overlap({ minutes: 38 }), "a", T0)).toEqual({ start: T0 + 3 * HOUR + 45 * MINUTE, end: T0 + 5 * HOUR + 45 * MINUTE });
    // A slot before it would fall on the day before: after it instead.
    const early = overlap({ a: side("a", -11.5, 2), b: side("b", -11, 2) });
    expect(freeAfter(early, "a", T0 - 24 * HOUR).start).toBe(T0 - 9 * HOUR);
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
  it("says what goes and to whom, without naming the event it stands under", () => {
    expect(wayWords("decline")).toBe("Its organizer is told you declined.");
    expect(wayWords("propose")).toBe("Its organizer is asked for this time. Nothing moves until they agree.");
    expect(wayWords("move")).toBe("It moves on your calendar.");
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

  it("take a To earlier on the clock than From as the next day's, so a span past midnight is one it can offer and accept", () => {
    const late = { start: new Date(2026, 10, 26, 23, 45).getTime(), end: new Date(2026, 10, 27, 1, 15).getTime() };
    const form = formOf(late);
    expect(form).toEqual({ day: "2026-11-26", from: "23:45", to: "01:15" });
    expect(endsNextDay(form)).toBe(true);
    expect(spanOf(form)).toEqual(late);
    expect(endsNextDay({ day: "2026-11-26", from: "13:00", to: "14:00" })).toBe(false);
  });
});
