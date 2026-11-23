// The clock changes, in a zone that has them: the times a step offers are the instants it sends, and its "Next day" is true.
// The zone is set before any date is read; vitest runs each file in its own process (pool: forks), so no other test sees it.
process.env.TZ = "America/New_York";

import { afterAll, describe, expect, it } from "vitest";
import { endsNextDay, formOf, spanOf, whenOf } from "./model";

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

  it("does not call an end in the repeated hour the next day's", () => {
    // From the first 1:45 AM to the second 1:15 AM: half an hour, the same day, though 1:15 is earlier on the clock.
    const offered = { start: FIRST_1_30 + 15 * MINUTE, end: SECOND_1_30 - 15 * MINUTE };
    const form = formOf(offered);
    expect(form).toEqual({ day: "2026-11-01", from: "01:45", to: "01:15" });
    expect(endsNextDay(form, offered)).toBe(false);
    expect(whenOf(form, offered)).toEqual(offered);
  });

  it("reads a span past midnight on the night the clocks go forward on its own days", () => {
    // 2027-03-14: 2:00 AM does not exist. 11:30 PM the night before to 2:30 AM is read on the 14th, where the clock has skipped.
    const form = { day: "2027-03-13", from: "23:30", to: "03:30" };
    const when = spanOf(form) as { start: number; end: number };
    expect(endsNextDay(form)).toBe(true);
    expect(new Date(when.end).getHours()).toBe(3);
    expect(new Date(when.end).getDate()).toBe(14);
    // Three clock hours after 11:30 PM are only three real hours here: 12:30, 1:30, then 3:30.
    expect(when.end - when.start).toBe(3 * HOUR);
  });
});
