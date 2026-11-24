// @vitest-environment jsdom
/**
 * A held invite's day across a clock change: the day read runs to the next local midnight, as Agenda's days do, so it
 * is 23 hours on the day the clocks go forward and 25 on the day they go back, never an hour of the next day nor one
 * short of its own.
 */
// The zone is set before any date of the test is read; vitest runs each file in its own process (pool: forks).
const incomingZone = process.env.TZ;
process.env.TZ = "America/Chicago";

import { cleanup, render } from "@testing-library/react";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { workTestClock } from "../testClock";

const asked = vi.hoisted(() => [] as { from: number; to: number }[]);
vi.mock("../shell/lifeos", async (original) => ({
  ...(await original<object>()),
  useLifeosSession: () => ({ environmentId: "box", sector: null, client: null, state: "connected" }),
  useLifeosQuery: (_s: unknown, name: string, args: { from: number; to: number }) => {
    if (name === "events:range") asked.push(args);
    return { status: "ready", value: [] };
  },
}));
const { View } = await import("./CalendarActView");

afterEach(() => {
  cleanup();
  asked.length = 0;
  vi.useRealTimers();
});
afterAll(() => {
  if (incomingZone === undefined) delete process.env.TZ;
  else process.env.TZ = incomingZone;
});

const HOUR = 3_600_000;
const dayOf = (y: number, m: number, d: number) => {
  vi.useFakeTimers({ now: workTestClock(), toFake: ["Date"] });
  const startsAt = new Date(y, m, d, 15).getTime();
  const op = { id: "op1", kind: "create", payload: { title: "Review", startsAt, endsAt: startsAt + HOUR } };
  render(<View item={{ kind: "calendar.op", payload: op, sector: "purdue" } as never} env="box" />);
  return asked.at(-1)!;
};

describe("a held invite's day", () => {
  it("is 23 hours on the day the clocks go forward (Mar 14, 2027), midnight to midnight", () => {
    const { from, to } = dayOf(2027, 2, 14);
    expect(from).toBe(new Date(2027, 2, 14).getTime());
    expect(to).toBe(new Date(2027, 2, 15).getTime());
    expect(to - from).toBe(23 * HOUR);
  });

  it("is 25 hours on the day the clocks go back (Nov 1, 2026), midnight to midnight", () => {
    const { from, to } = dayOf(2026, 10, 1);
    expect(from).toBe(new Date(2026, 10, 1).getTime());
    expect(to).toBe(new Date(2026, 10, 2).getTime());
    expect(to - from).toBe(25 * HOUR);
  });

  it("is 24 hours on any other day", () => {
    const { from, to } = dayOf(2026, 10, 23);
    expect(to - from).toBe(24 * HOUR);
  });
});
