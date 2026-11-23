// @vitest-environment jsdom
/**
 * Today kept warm (docs/agents/work-today.md "Speed"): the sources run on
 * for ten minutes after the page closes and from a hover, in a root of
 * their own; the page runs them itself while it is open; and the two-day
 * habit decides the idle warm.
 */
import { act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./env", () => ({ useTodayEnv: () => ({ env: { day: { from: 0, to: 1 }, workspaces: [], lifeos: { environmentId: "", sector: null, client: null, state: "off" }, workspaceOf: () => null }, reach: "ok", lifeosHost: null, retryLifeos: undefined }) }));

import { resetToday, todayNow } from "./store";
import type { TodaySource } from "./types";
import { KEEP_MS, keepingWarm, keepWarm, noteOpened, openedLately, pageOpen, setWarmAllowed } from "./warm";

const runs = { count: 0 };
const answer = { rows: [{ key: "x:1", section: "x", sector: null, title: "A row", open: () => {} }] };
const counted: TodaySource = {
  id: "x",
  section: { id: "x", title: "X", order: 1, empty: "" },
  use: () => {
    runs.count++;
    return answer;
  },
};

beforeEach(() => {
  vi.useFakeTimers();
  runs.count = 0;
  localStorage.clear();
  resetToday([counted]);
  setWarmAllowed(true);
});
afterEach(() => {
  act(() => setWarmAllowed(false));
  vi.useRealTimers();
});

describe("the keeper", () => {
  it("runs the sources with no page, puts their answers in the store, and stops after ten minutes", async () => {
    await act(async () => keepWarm());
    expect(keepingWarm()).toBe(true);
    expect(runs.count).toBeGreaterThan(0);
    expect(todayNow().answers.get("x")).toBe(answer);
    await act(async () => void vi.advanceTimersByTime(KEEP_MS - 1));
    expect(keepingWarm()).toBe(true);
    await act(async () => void vi.advanceTimersByTime(1));
    expect(keepingWarm()).toBe(false);
    // What it read stays for the next open.
    expect(todayNow().answers.get("x")).toBe(answer);
  });

  it("a second warm starts the ten minutes again, with one root", async () => {
    await act(async () => keepWarm());
    await act(async () => void vi.advanceTimersByTime(KEEP_MS - 1000));
    await act(async () => keepWarm());
    await act(async () => void vi.advanceTimersByTime(KEEP_MS - 1000));
    expect(keepingWarm()).toBe(true);
    await act(async () => void vi.advanceTimersByTime(1000));
    expect(keepingWarm()).toBe(false);
  });

  it("stands down while the page is open, which runs the sources itself, and takes over when it closes", async () => {
    await act(async () => keepWarm());
    await act(async () => pageOpen(true));
    expect(keepingWarm()).toBe(false);
    // A hover on the rail row while the page is open starts nothing.
    await act(async () => keepWarm());
    expect(keepingWarm()).toBe(false);
    await act(async () => pageOpen(false));
    expect(keepingWarm()).toBe(true);
    await act(async () => void vi.advanceTimersByTime(KEEP_MS));
    expect(keepingWarm()).toBe(false);
  });
});

describe("the habit", () => {
  const at = (day: number, hour = 9) => new Date(2026, 10, day, hour).getTime();

  it("keeps two dates and nothing else", () => {
    noteOpened(at(20));
    noteOpened(at(20, 17));
    noteOpened(at(21));
    noteOpened(at(23));
    expect(JSON.parse(localStorage.getItem("work.today.opened.v1")!)).toEqual(["2026-11-23", "2026-11-21"]);
  });

  it("is worth an idle read when he opened Today today or on either of the two days before", () => {
    expect(openedLately(at(23))).toBe(false);
    noteOpened(at(21));
    expect(openedLately(at(21, 22))).toBe(true);
    expect(openedLately(at(22))).toBe(true);
    expect(openedLately(at(23))).toBe(true);
    expect(openedLately(at(24))).toBe(false);
    localStorage.setItem("work.today.opened.v1", "not json");
    expect(openedLately(at(23))).toBe(false);
  });
});
