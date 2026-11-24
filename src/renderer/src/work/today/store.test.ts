import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "./model";
import { comeBack, dropSource, fedOf, leave, openHeld, putAnswer, resetToday, todayNow, unfold } from "./store";
import type { TodayRow, TodaySource, TodayWorkspace } from "./types";

const row = (key: string): TodayRow => ({ key, section: "due", sector: "purdue", title: key, open: () => {} });
const DUE: TodaySource = { id: "due", section: { id: "due", title: "Due", order: 30, empty: "Nothing due today" }, use: () => ({}) };
const jobs: TodayWorkspace[] = [{ environmentId: "box", workspaceId: "w", sector: "purdue", name: "Purdue", path: "/w", open: true }];
const keys = () => {
  const p = page(fedOf(todayNow()), { jobs, lifeos: "ok", gone: todayNow().gone });
  return p.kind === "day" ? p.keys : [];
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  resetToday([DUE]);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Today's store", () => {
  it("a source that has never answered is still to answer; one that is reading again keeps the rows it had", () => {
    expect(fedOf(todayNow())[0]!.answer).toEqual({ loading: true });
    putAnswer("due", { rows: [row("task:1")], note: "A note" });
    putAnswer("due", { loading: true });
    // A reopen paints what was there; the live read corrects it.
    expect(fedOf(todayNow())[0]!.answer).toMatchObject({ loading: true, rows: [{ key: "task:1" }], note: "A note" });
    putAnswer("due", { rows: [] });
    expect(fedOf(todayNow())[0]!.answer).toEqual({ rows: [] });
  });

  it("a read on hosts that is out again with an empty list keeps the rows it had: a reopen is not a day with none", () => {
    putAnswer("due", { rows: [row("owed:1")] });
    // A fresh read's first answer, before any host was asked.
    putAnswer("due", { rows: [], loading: true });
    expect(fedOf(todayNow())[0]).toMatchObject({ kept: true, answer: { loading: true, rows: [{ key: "owed:1" }] } });
    // A whole answer with none is believed.
    putAnswer("due", { rows: [] });
    expect(fedOf(todayNow())[0]!.answer).toEqual({ rows: [] });
  });

  it("the same answer again wakes no one", () => {
    const answer = { rows: [row("task:1")] };
    putAnswer("due", answer);
    const before = todayNow();
    putAnswer("due", answer);
    expect(todayNow()).toBe(before);
  });

  it("a row his act took off fades where it stands, then is off the page before its source drops it", () => {
    putAnswer("due", { rows: [row("task:1"), row("task:2")] });
    leave("task:1");
    // Still drawn while it fades.
    expect(todayNow().leaving.has("task:1")).toBe(true);
    expect(keys()).toEqual(["task:1", "task:2"]);
    vi.advanceTimersByTime(120);
    // Faded: its place closes while the rows under it glide up.
    expect(todayNow().leaving.has("task:1")).toBe(false);
    expect(todayNow().closing.has("task:1")).toBe(true);
    expect(keys()).toEqual(["task:1", "task:2"]);
    vi.advanceTimersByTime(180);
    expect(todayNow().closing.has("task:1")).toBe(false);
    expect(keys()).toEqual(["task:2"]);
  });

  it("comes back at once when the act fails or he undoes it, before the fade ends or after", () => {
    putAnswer("due", { rows: [row("task:1"), row("task:2")] });
    leave("task:1");
    comeBack("task:1");
    vi.advanceTimersByTime(500);
    expect(keys()).toEqual(["task:1", "task:2"]);
    leave("task:2");
    vi.advanceTimersByTime(300);
    expect(keys()).toEqual(["task:1"]);
    comeBack("task:2");
    expect(keys()).toEqual(["task:1", "task:2"]);
  });

  it("forgets a row it took off once no source gives it, so the same task shows again another day", () => {
    putAnswer("due", { rows: [row("task:1")] });
    leave("task:1");
    vi.advanceTimersByTime(300);
    expect(todayNow().gone.has("task:1")).toBe(true);
    putAnswer("due", { rows: [] });
    expect(todayNow().gone.has("task:1")).toBe(false);
    // Snoozed until tomorrow, it is back in the list in the morning.
    putAnswer("due", { rows: [row("task:1")] });
    expect(keys()).toEqual(["task:1"]);
  });

  it("keeps the folds he opened and the held item's sheet; a source that threw is left out with what it answered", () => {
    unfold("more", "due");
    unfold("earlier", "meetings");
    expect([...todayNow().folds.more]).toEqual(["due"]);
    expect([...todayNow().folds.earlier]).toEqual(["meetings"]);
    openHeld("held:box:host:1");
    expect(todayNow().held).toBe("held:box:host:1");
    putAnswer("due", { rows: [row("task:1")] });
    dropSource("due", new Error("a bug"));
    expect(todayNow().sources).toEqual([]);
    expect(todayNow().answers.has("due")).toBe(false);
  });
});
