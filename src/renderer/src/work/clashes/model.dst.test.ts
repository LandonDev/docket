// The clock changes, in a zone that has them: the times a step offers are the instants it sends, and its "Next day" is true.
// The zone is set before any date is read; vitest runs each file in its own process (pool: forks), so no other test sees it.
process.env.TZ = "America/New_York";

import { afterAll, describe, expect, it } from "vitest";
import { endHint, fieldOf, formOf, spanOf, whenOf } from "./model";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
// 2026-11-01 in New York: at 2:00 AM EDT the clocks go back to 1:00 AM EST, so 1:00 to 1:59 AM comes twice.
const FIRST_1_30 = Date.UTC(2026, 10, 1, 5, 30);
const SECOND_1_30 = Date.UTC(2026, 10, 1, 6, 30);

afterAll(() => {
  delete process.env.TZ;
});

describe("a step's times when the clocks change", () => {
  it("runs in a zone whose clocks go back that night", () => {
    expect(formOf({ start: FIRST_1_30, end: SECOND_1_30 })).toEqual({ day: "2026-11-01", from: "01:30", to: "01:30" });
  });

  it("sends the second 1:30 AM when that is what was offered and left alone, though the field reads the same as the first", () => {
    const offered = { start: SECOND_1_30, end: SECOND_1_30 + 90 * MINUTE };
    const form = formOf(offered);
    expect(form).toEqual({ day: "2026-11-01", from: "01:30", to: "03:00" });
    expect(whenOf(form, offered)).toEqual(offered);
    // Read back with nothing offered, the field means the first 1:30 AM: an hour early.
    expect(spanOf(form)).toEqual({ start: FIRST_1_30, end: offered.end });
  });

  it("keeps an untouched From at the instant offered when he edits only To", () => {
    const offered = { start: SECOND_1_30, end: SECOND_1_30 + 30 * MINUTE };
    const form = formOf(offered);
    expect(form.to).toBe("02:00");
    expect(whenOf({ ...form, to: "02:15" }, offered)).toEqual({ start: SECOND_1_30, end: SECOND_1_30 + 45 * MINUTE });
  });

  it("reads a To he types into the repeated hour as its first time after the start", () => {
    // From left at the second 1:30 AM; To typed as 1:45 is the second 1:45, a quarter hour on, not the next day's.
    const offered = { start: SECOND_1_30, end: SECOND_1_30 + 90 * MINUTE };
    const form = { ...formOf(offered), to: "01:45" };
    expect(whenOf(form, offered)).toEqual({ start: SECOND_1_30, end: SECOND_1_30 + 15 * MINUTE });
    expect(endHint(form, offered)).toBeUndefined();
  });

  it("takes a To earlier on the clock as the next day's on the day that is 25 hours long", () => {
    // 12:30 AM on the day the clocks go back to 12:15 AM the next: 24 hours and three quarters, and still under a day by the clock.
    const form = { day: "2026-11-01", from: "00:30", to: "00:15" };
    const when = spanOf(form) as { start: number; end: number };
    expect(when).toEqual({ start: new Date(2026, 10, 1, 0, 30).getTime(), end: new Date(2026, 10, 2, 0, 15).getTime() });
    expect(when.end - when.start).toBe(24 * HOUR + 45 * MINUTE);
    expect(endHint(form)).toBe("Next day");
  });

  it("reads a To earlier on the clock on the Day first when the hour repeats, before the next day", () => {
    // 2027-11-07: 1:00 to 1:59 AM comes twice. An offer that crossed midnight, moved to that day: 1:45 AM to 1:30 AM is 45 minutes, to the second 1:30.
    const offered = { start: new Date(2027, 10, 3, 23, 30).getTime(), end: new Date(2027, 10, 4, 0, 30).getTime() };
    const form = { day: "2027-11-07", from: "01:45", to: "01:30" };
    const when = whenOf(form, offered) as { start: number; end: number };
    expect(when.end - when.start).toBe(45 * MINUTE);
    // The fields read backward; the line under To says which 1:30 goes.
    expect(endHint(form, offered)).toBe("Second 1:30 AM");
  });

  it("says under To when an end is the second time its clock shows, typed or offered, and nothing in an hour that comes once", () => {
    const twice = { start: FIRST_1_30, end: SECOND_1_30 };
    expect(endHint(formOf(twice), twice)).toBe("Second 1:30 AM");
    expect(endHint({ day: "2026-11-01", from: "01:15", to: "01:30" })).toBeUndefined();
    expect(endHint({ day: "2026-11-01", from: "00:30", to: "03:00" })).toBeUndefined();
  });

  it("refuses a long event's To in the skipped hour of the day it keeps, rather than send it a day short", () => {
    // Fri 6:00 PM to Sun 1:00 AM, To typed as 2:30 on the Sunday the clocks go forward.
    const offered = { start: new Date(2027, 2, 12, 18, 0).getTime(), end: new Date(2027, 2, 14, 1, 0).getTime() };
    const skipped = "To is in the hour the clocks skip that day. Pick another time.";
    expect(whenOf({ ...formOf(offered), to: "02:30" }, offered)).toBe(skipped);
    // Sat 1:00 AM to Sun 3:30 AM, To typed as 2:30: the same, never Saturday's 2:30.
    const other = { start: new Date(2027, 2, 13, 1, 0).getTime(), end: new Date(2027, 2, 14, 3, 30).getTime() };
    expect(whenOf({ ...formOf(other), to: "02:30" }, other)).toBe(skipped);
    // A Day that puts the kept end on that Sunday's skipped hour is refused too.
    const late = { start: new Date(2027, 2, 5, 18, 0).getTime(), end: new Date(2027, 2, 7, 2, 30).getTime() };
    expect(whenOf({ ...formOf(late), day: "2027-03-12" }, late)).toBe(skipped);
  });

  it("says the same minute is no span the day before the clocks go forward, not that the clocks skip it", () => {
    expect(spanOf({ day: "2027-03-13", from: "02:30", to: "02:30" })).toBe("It must end after it starts");
  });

  it("says the same minute is no span in the hour the clocks repeat too, though an offer left alone keeps its two instants", () => {
    expect(spanOf({ day: "2026-11-01", from: "01:30", to: "01:30" })).toBe("It must end after it starts");
    const short = { start: new Date(2027, 10, 3, 23, 30).getTime(), end: new Date(2027, 10, 4, 0, 30).getTime() };
    expect(whenOf({ day: "2027-11-07", from: "01:30", to: "01:30" }, short)).toBe("It must end after it starts");
    const offered = { start: FIRST_1_30, end: SECOND_1_30 };
    expect(whenOf(formOf(offered), offered)).toEqual(offered);
  });

  it("keeps the end's day under To when the clocks skip the To on it, so the refusal has a day to be about", () => {
    const day = (ms: number) => new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric" }).format(ms);
    // Fri 6:00 PM to Sun 1:00 AM, To typed as 2:30: refused, and still said of Sunday.
    const offered = { start: new Date(2027, 2, 12, 18, 0).getTime(), end: new Date(2027, 2, 14, 1, 0).getTime() };
    expect(endHint(formOf(offered), offered)).toBe(day(offered.end));
    expect(endHint({ ...formOf(offered), to: "02:30" }, offered)).toBe(day(offered.end));
    // The night before, To 2:30 AM is the next day's skipped hour.
    expect(endHint({ day: "2027-03-13", from: "23:00", to: "02:30" })).toBe("Next day");
    // On the day itself, a skipped To later on the clock is the Day's own: no hint.
    expect(endHint({ day: "2027-03-14", from: "00:30", to: "02:30" })).toBeUndefined();
    // Another refusal has no day to name.
    expect(endHint({ day: "2027-03-13", from: "02:30", to: "02:30" })).toBeUndefined();
  });

  it("does not call an end in the repeated hour the next day's", () => {
    // From the first 1:45 AM to the second 1:15 AM: half an hour, the same day, though 1:15 is earlier on the clock.
    const offered = { start: FIRST_1_30 + 15 * MINUTE, end: SECOND_1_30 - 15 * MINUTE };
    const form = formOf(offered);
    expect(form).toEqual({ day: "2026-11-01", from: "01:45", to: "01:15" });
    expect(endHint(form, offered)).toBe("Second 1:15 AM");
    expect(whenOf(form, offered)).toEqual(offered);
  });

  it("reads a span past midnight on the night the clocks go forward on its own days", () => {
    // 2027-03-14: 2:00 AM does not exist. 11:30 PM the night before to 2:30 AM is read on the 14th, where the clock has skipped.
    const form = { day: "2027-03-13", from: "23:30", to: "03:30" };
    const when = spanOf(form) as { start: number; end: number };
    expect(endHint(form)).toBe("Next day");
    expect(new Date(when.end).getHours()).toBe(3);
    expect(new Date(when.end).getDate()).toBe(14);
    // Three clock hours after 11:30 PM are only three real hours here: 12:30, 1:30, then 3:30.
    expect(when.end - when.start).toBe(3 * HOUR);
  });

  it("refuses a time he types into the hour the clocks skip, in words, rather than send it an hour on", () => {
    // 2027-03-14 in New York: 2:00 to 2:59 AM never shows. A Date reads 2:30 AM there as 3:30 AM.
    const offered = { start: Date.UTC(2027, 2, 14, 5, 30), end: Date.UTC(2027, 2, 14, 8, 0) };
    const form = formOf(offered);
    expect(form).toEqual({ day: "2027-03-14", from: "00:30", to: "04:00" });
    const from = whenOf({ ...form, from: "02:30" }, offered);
    expect(from).toBe("From is in the hour the clocks skip that day. Pick another time.");
    const to = whenOf({ ...form, to: "02:15" }, offered);
    expect(to).toBe("To is in the hour the clocks skip that day. Pick another time.");
    expect(spanOf({ day: "2027-03-13", from: "23:00", to: "02:30" })).toBe(to);
    // The mirror: the evening of the 14th to 2:30 AM on the 15th, a morning that has the time.
    const night = { day: "2027-03-14", from: "23:00", to: "02:30" };
    expect(spanOf(night)).toEqual({ start: new Date(2027, 2, 14, 23, 0).getTime(), end: new Date(2027, 2, 15, 2, 30).getTime() });
    expect(endHint(night)).toBe("Next day");
    // The refusal names its field, for the step to mark.
    expect([fieldOf(from as string), fieldOf(to as string), fieldOf("It must end after it starts"), fieldOf(null)]).toEqual(["from", "to", null, null]);
    // The hours either side of it are times like any other.
    expect(whenOf({ ...form, from: "01:30" }, offered)).toEqual({ start: Date.UTC(2027, 2, 14, 6, 30), end: offered.end });
    expect(whenOf({ ...form, from: "03:00" }, offered)).toEqual({ start: Date.UTC(2027, 2, 14, 7, 0), end: offered.end });
  });
});
