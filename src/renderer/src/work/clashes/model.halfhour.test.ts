// A zone whose clocks go back half an hour: the repeated time is found by the clock itself, not by an hour's shift.
// The zone is set before any date is read; vitest runs each file in its own process (pool: forks), so no other test sees it.
process.env.TZ = "Australia/Lord_Howe";

import { afterAll, describe, expect, it } from "vitest";
import { isSecond, timeNear } from "@shared/work/clashes";
import { hintsOf, spanOf } from "./model";

const MINUTE = 60_000;

afterAll(() => {
  delete process.env.TZ;
});

describe("a step's times where the clocks go back half an hour", () => {
  // 2027-04-04 on Lord Howe: at 2:00 AM the clocks go back to 1:30 AM, so 1:30 to 1:59 AM comes twice.
  const first = new Date(2027, 3, 4, 1, 45).getTime();
  const second = first + 30 * MINUTE;

  it("runs in a zone where 1:45 AM comes twice that night, half an hour apart", () => {
    expect([new Date(first).getHours(), new Date(first).getMinutes()]).toEqual([1, 45]);
    expect([new Date(second).getHours(), new Date(second).getMinutes()]).toEqual([1, 45]);
  });

  it("reads 1:50 AM to 1:45 AM as 25 minutes, to the second 1:45, and says so", () => {
    const form = { day: "2027-04-04", from: "01:50", to: "01:45" };
    const when = spanOf(form) as { start: number; end: number };
    expect(when.end - when.start).toBe(25 * MINUTE);
    expect(when.end).toBe(second);
    expect(hintsOf(form)).toEqual({ to: "Second 1:45 AM" });
  });

  it("says second of the later of the two in an event's times, and of neither side of the half hour", () => {
    expect(isSecond(first)).toBe(false);
    expect(isSecond(second)).toBe(true);
    expect(timeNear(second, first)).toBe("second 1:45 AM");
    expect(isSecond(first - 30 * MINUTE)).toBe(false);
    expect(isSecond(second + 30 * MINUTE)).toBe(false);
  });
});
