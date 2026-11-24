// @vitest-environment jsdom
/** Clashes on Today: a mark on both events' rows with Resolve, a leave-by as the row's live line, and never a row of their own. */
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LifeosRange } from "@shared/work/clashes";
import type { TodayAnswer, TodayEnv } from "../today/types";

const HOUR = 3_600_000;
const MINUTE = 60_000;
// A fixed morning, and the clock held on it: the events below stand hours ahead, and a run late in the evening
// carried them over midnight, where a clash's words gain the weekday ("Mon 11:00 PM") and no longer matched.
const now = new Date(2026, 10, 23, 9, 0).getTime();
const lifeos = vi.hoisted(() => ({ asked: [] as { name: string; args: unknown }[], answer: { status: "loading" } as unknown }));
vi.mock("../shell/lifeos", async (original) => ({
  ...(await original<object>()),
  useLifeosQuery: (_session: unknown, name: string, args: unknown) => {
    lifeos.asked.push({ name, args });
    return lifeos.answer;
  },
}));

const { source } = await import("./today");
const { clashAsk } = await import("./open");
const { clockOf } = await import("@shared/work/clashes");
const { TODAY_SOURCES } = await import("../today/sources");

beforeEach(() => void vi.useFakeTimers({ now, toFake: ["Date"] }));
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  clashAsk.set(null);
  lifeos.asked.length = 0;
});

const env: TodayEnv = {
  day: { from: now - 5 * HOUR, to: now + 19 * HOUR },
  workspaces: [],
  lifeos: { environmentId: "box", sector: null, client: null, state: "connected" } as never,
  workspaceOf: (sector) => (sector === "ref" ? ({ environmentId: "box", workspaceId: "ws_ref", sector, name: "Ref", path: "/", open: true } as never) : null),
};
const side = (eventId: string, sector: string, title: string, startH: number, hours: number) => ({ eventId, sector, title, startsAt: now + startH * HOUR, endsAt: now + (startH + hours) * HOUR, can: [] });
const meeting = side("ev_meeting", "purdue", "Staff meeting", 2, 2);
const game = side("ev_game", "ref", "Varsity Basketball", 3, 2);
const range = (more: Partial<LifeosRange> = {}): LifeosRange => ({ clashes: [{ id: "ev_meeting-ev_game", kind: "overlap", a: meeting as never, b: game as never }], leaves: [], ...more });

/** The source's answer, read through a component, since `use` is a hook. */
function answerOf(value: unknown, on: TodayEnv = env): TodayAnswer {
  lifeos.answer = value;
  let answer: TodayAnswer = {};
  function Probe() {
    answer = source.use(on);
    return null;
  }
  render(<Probe />);
  return answer;
}

describe("clashes on Today", () => {
  it("is one of Today's sources, and reads the day's clashes on Today's own session", () => {
    expect(TODAY_SOURCES.map((s) => s.id)).toContain("clashes");
    answerOf({ status: "ready", value: range() });
    expect(lifeos.asked).toContainEqual({ name: "clashes:range", args: { from: env.day.from, to: env.day.to } });
  });

  it("marks both events' rows with the clash in each one's own words, as a fault, and makes no row", () => {
    const answer = answerOf({ status: "ready", value: range() });
    expect(answer.rows).toBeUndefined();
    expect(answer.marks?.map((m) => [m.key, m.note, m.late, m.act?.label])).toEqual([
      ["event:ev_meeting", `Overlaps Varsity Basketball (Ref), ${clockOf(game.startsAt)}`, true, "Resolve"],
      ["event:ev_game", `Overlaps Staff meeting (Purdue), ${clockOf(meeting.startsAt)}`, true, "Resolve"],
    ]);
  });

  it("opens the Clash dialog from Resolve, with the job's workspace on the side that has one", () => {
    const answer = answerOf({ status: "ready", value: range() });
    void answer.marks?.[0]?.act?.run();
    expect(clashAsk.get()).toMatchObject({ id: "ev_meeting-ev_game", environmentId: "box", clash: { b: { workspaceId: "ws_ref" } } });
    expect(clashAsk.get()?.clash?.a.workspaceId).toBeUndefined();
  });

  it("says the first of several clashes and how many more", () => {
    const second = { id: "ev_game-ev_dinner", kind: "drive" as const, a: game as never, b: side("ev_dinner", "life", "Dinner", 5.2, 1) as never, minutes: 40, metres: 30_000, measured: true, shortBy: 28 };
    const answer = answerOf({ status: "ready", value: range({ clashes: [...range().clashes, second] }) });
    expect(answer.marks?.find((m) => m.key === "event:ev_game")?.note).toBe(`Overlaps Staff meeting (Purdue), ${clockOf(meeting.startsAt)}, and 1 more`);
    expect(answer.marks?.find((m) => m.key === "event:ev_dinner")?.note).toBe("28 min short after Varsity Basketball (Ref)");
  });

  it("drops a clash once its later event is over, as the Agenda does: no fault and no Resolve on a pair that is done", () => {
    // A 6:00 to 7:00 AM overlap with a 6:30 to 8:00 AM one, read at 9:00 AM.
    const early = { id: "ev_a-ev_b", kind: "overlap" as const, a: side("ev_a", "purdue", "Stand-up", -3, 1) as never, b: side("ev_b", "ref", "Film review", -2.5, 1.5) as never };
    const answer = answerOf({ status: "ready", value: range({ clashes: [early, ...range().clashes] }) });
    expect(answer.marks?.map((m) => m.key)).toEqual(["event:ev_meeting", "event:ev_game"]);
  });

  it("words a pair that began last night under today, so the other event's time keeps its weekday", () => {
    // Both began last night (Sunday) and run into this morning.
    const night = { id: "ev_n1-ev_n2", kind: "overlap" as const, a: side("ev_n1", "purdue", "Server move", -10, 12) as never, b: side("ev_n2", "ref", "Night shift", -9.5, 12) as never };
    const answer = answerOf({ status: "ready", value: range({ clashes: [night] }) });
    expect(answer.marks?.find((m) => m.key === "event:ev_n1")?.note).toBe(`Overlaps Night shift (Ref), Sun ${clockOf(now - 9.5 * HOUR)}`);
  });

  it("gives an event he has to drive to its leave-by as the row's live line, on the same mark as its clash", () => {
    const leaveAt = now + 2 * HOUR;
    const answer = answerOf({
      status: "ready",
      value: range({
        leaves: [
          { eventId: "ev_game", leaveAt, minutes: 40, measured: true, from: "event", fromTitle: "Staff meeting" },
          { eventId: "ev_lunch", leaveAt: now + 30 * MINUTE, minutes: 15, measured: true, from: "start" },
        ],
      }),
    });
    expect(answer.marks?.map((m) => [m.key, m.whenLine, Boolean(m.note)])).toEqual([
      ["event:ev_meeting", undefined, true],
      ["event:ev_game", `Leave ${clockOf(leaveAt)}`, true],
      ["event:ev_lunch", `Leave ${clockOf(now + 30 * MINUTE)}`, false],
    ]);
  });

  it("drops the leave-by once the drive would have him there, so the row's own line shows", () => {
    const answer = answerOf({
      status: "ready",
      value: {
        clashes: [],
        leaves: [
          { eventId: "ev_late", leaveAt: now - 10 * MINUTE, minutes: 30, measured: true, from: "start" },
          { eventId: "ev_begun", leaveAt: now - 45 * MINUTE, minutes: 30, measured: true, from: "start" },
          { eventId: "ev_hand", leaveAt: now - MINUTE, measured: true, from: "start" },
        ],
      },
    });
    // Ten minutes past the leave-by with a thirty minute drive: still the line that matters.
    expect(answer.marks?.map((m) => m.key)).toEqual(["event:ev_late"]);
  });

  it("says it is loading until LifeOS answers; a read LifeOS refused is said in plain words, blaming no host", () => {
    expect(answerOf({ status: "loading" })).toEqual({ loading: true });
    expect(answerOf({ status: "failed", error: "[CONVEX Q(clashes:range)] Server Error" })).toEqual({
      failed: [{ environmentId: "box", error: "[CONVEX Q(clashes:range)] Server Error", said: "LifeOS could not read clashes" }],
    });
  });

  it("says nothing when the session is down: the page's own line already says so", () => {
    const signedOut = { ...env, lifeos: { environmentId: "box", sector: null, client: null, state: "signed-out" } as never };
    expect(answerOf({ status: "failed", error: "Not signed in to LifeOS" }, signedOut)).toEqual({});
  });
});
