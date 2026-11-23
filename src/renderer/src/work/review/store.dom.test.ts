// @vitest-environment jsdom
import { act, cleanup, render, renderHook } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LEFT, weekOf, type ReviewBody } from "@shared/work/review";
import { registry, TimeoutError, type EnvironmentStatus } from "../../lib/connection";
import { workspaceStore } from "../../lib/tcserver/workspaces";
import { setWorkOn, workSwitch } from "../../lib/workSwitch";
import { AFTER, fixtureView, TZ, WEEK } from "./fixtures";
import { resetShown, shownWeek, showWeekNamed, useWeekTurn } from "./shown";
import { loadRoutine, loadWeek, loadZone, makeAgain, markSeen, resetReviewStore, reviewNow, reviewZone, settleHost, settleRow, thisWeek, undoSettle, useReview } from "./store";

/**
 * The page's store: every host with Work on is asked for its part, the parts are merged by sector with LifeOS taken
 * once, a host that is off is one line, and each press goes to the host that owns the row.
 */

const open = { transport: "open" } as EnvironmentStatus;
const offline = { transport: "offline" } as EnvironmentStatus;
type Answer = (method: string, params: Record<string, unknown>) => unknown;
let links: Record<string, { status: EnvironmentStatus; answer: Answer; calls: { method: string; params: Record<string, unknown> }[] }>;

/** The two parts the made-up week has: the box's and the Mac's. */
const parts = () => {
  const { view } = fixtureView("full");
  const made = (host: "box" | "mac"): ReviewBody => bodies[host]!;
  return { view, made };
};
let bodies: Record<string, ReviewBody>;

beforeEach(async () => {
  // The fixture's own bodies, read back out of a merge: one a host.
  const fixtures = await import("./fixtures");
  const full = fixtures.fixtureView("full").view.review!;
  const boxJobs = full.jobs.map((j) => ({ workspaceId: j.at.find((a) => a.environmentId === "env-box")!.workspaceId, sector: j.sector, name: j.name }));
  const base: ReviewBody = { host: "box", from: WEEK.from, to: WEEK.to, tz: TZ, madeAt: AFTER, by: "routine", over: true, jobs: boxJobs, lifeos: { events: [], sent: [{ id: "m1", threadId: "t1", subject: "Season 12 patch notes", to: ["Riley Okafor"], addresses: [], at: WEEK.from + 3_600_000, sector: "cosmic" }], done: [], answered: [], answeredSince: null }, points: [[WEEK.from + 3_600_000, 0, "said"]], ran: [[0, 3_600_000]], slipped: { at: AFTER, rows: [{ key: "task:k1", ref: { kind: "task", id: "k1", dueAt: WEEK.from }, sector: "hypixel", workspaceId: null, title: "Send the thumbnail drafts", at: WEEK.from, people: [], others: 0, open: true }, { key: "mail:tw1", ref: { kind: "mail", threadId: "tw1", since: WEEK.from }, sector: "cosmic", workspaceId: null, title: "Winter video schedule", at: WEEK.from, people: [], others: 0, open: true }, { key: "held:host:h1", ref: { kind: "held", ref: { at: "host", id: "h1" } }, sector: "purdue", workspaceId: "w-purdue", title: "Reply to the facilities office", at: WEEK.from, people: [], others: 0, open: true }] }, shipped: [], before: null, left: [] };
  bodies = {
    box: base,
    mac: { ...base, host: "mac", jobs: [{ workspaceId: "m-cosmic", sector: "cosmic", name: "Cosmic" }], points: [[WEEK.from + 3_700_000, 0, "edited"]], ran: [[0, 1_800_000]], slipped: { at: AFTER, rows: [{ key: "held:host:h1", ref: { kind: "held", ref: { at: "host", id: "h1" } }, sector: "cosmic", workspaceId: "m-cosmic", title: "Post the patch notes", at: WEEK.from, people: [], others: 0, open: true }] } },
  };
  const host = (id: string, answer: Answer) => ({ status: open, answer, calls: [] as { method: string; params: Record<string, unknown> }[] });
  links = {
    "env-box": host("env-box", (method) => (method === "work.review.week" ? bodies.box : method === "work.review.list" ? { weeks: [], tz: TZ } : method === "work.review.settle" ? { undo: "tok" } : method === "work.review.routine" ? null : { ok: true })),
    "env-mac": host("env-mac", (method) => (method === "work.review.week" ? bodies.mac : method === "work.review.list" ? { weeks: [], tz: "America/New_York" } : method === "work.review.settle" ? { undo: null, sessionId: "nudge" } : method === "work.review.routine" ? { workspaceId: "m-cosmic", routineId: "r1", words: "Fridays at 4:00 PM" } : { ok: true })),
  };
  vi.spyOn(registry, "statusOf").mockImplementation((id) => links[id]?.status ?? offline);
  vi.spyOn(registry, "environment").mockImplementation((id) => ({ id, name: id === "env-mac" ? "The Mac" : "The box", routes: [], credentialRef: null }) as never);
  vi.spyOn(registry, "environments").mockReturnValue([{ id: "env-box", platform: "linux" }, { id: "env-mac", platform: "darwin" }] as never);
  vi.spyOn(registry, "linkOf").mockImplementation(
    (id) =>
      ({
        environmentId: id,
        request: async (method: string, params: Record<string, unknown>) => {
          links[id]!.calls.push({ method, params });
          const got = links[id]!.answer(method, params);
          if (got instanceof Error) throw got;
          return got;
        },
      }) as never,
  );
  setWorkOn("env-box", true);
  setWorkOn("env-mac", true);
  resetReviewStore({ now: () => AFTER });
  void parts;
});

afterEach(() => {
  workSwitch.reset();
  resetReviewStore();
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("the week across hosts", () => {
  it("asks every linked host in the home host's zone and merges their parts, LifeOS taken once", async () => {
    await loadZone();
    // The box is the Work home (the Linux host): its zone is the one weeks are cut in, though the Mac says another.
    expect(reviewZone()).toBe(TZ);
    expect(links["env-mac"]!.calls.map((c) => c.method)).toEqual([]);
    const week = thisWeek();
    await loadWeek(WEEK);
    expect(week.from).toBe(WEEK.to);
    for (const id of ["env-box", "env-mac"]) expect(links[id]!.calls.filter((c) => c.method === "work.review.week").at(-1)).toEqual({ method: "work.review.week", params: { from: WEEK.from, to: WEEK.to, tz: TZ } });
    const view = reviewNow(WEEK);
    expect(view.settled).toBe(true);
    expect(view.off).toEqual([]);
    const cosmic = view.review!.hours.find((h) => h.job === "cosmic")!;
    // One mail, though both hosts carry it; both hosts' points and run time.
    expect(cosmic.stands).toEqual({ said: 1, sent: 1, pressed: 0, edited: 1 });
    expect(cosmic.ranMs).toBe(3_600_000 + 1_800_000);
    expect(view.review!.lifeosFrom).toBe("env-box");
    expect(view.review!.jobs.find((j) => j.key === "cosmic")!.at).toEqual([
      { environmentId: "env-box", workspaceId: "w-cosmic" },
      { environmentId: "env-mac", workspaceId: "m-cosmic" },
    ]);
    // LifeOS's rows once, from the home host; each host's own held row.
    expect(view.review!.slipped.map((r) => [r.key, r.environmentId]).sort()).toEqual([
      ["env-box:held:host:h1", "env-box"],
      ["env-mac:held:host:h1", "env-mac"],
      ["mail:tw1", "env-box"],
      ["task:k1", "env-box"],
    ]);
  });

  it("stands on the hosts that answer: one that is off is one line, never a failure", async () => {
    links["env-mac"]!.status = offline;
    await loadWeek(WEEK);
    expect(links["env-mac"]!.calls).toEqual([]);
    const view = reviewNow(WEEK);
    expect(view.off).toEqual(["The Mac is off. Its threads and held items are not counted."]);
    expect(view.errors).toEqual([]);
    expect(view.settled).toBe(true);
    expect(view.review!.hours.find((h) => h.job === "cosmic")!.ranMs).toBe(3_600_000);
  });

  it("says which host did not answer and keeps what it last said", async () => {
    await loadWeek(WEEK);
    links["env-mac"]!.answer = () => new Error("the request timed out");
    await loadWeek(WEEK);
    const view = reviewNow(WEEK);
    // What it answered before still stands in the numbers, and the line can say so.
    expect(view.errors).toEqual([{ environmentId: "env-mac", name: "The Mac", error: "the request timed out", kept: true }]);
    expect(view.review!.hours.find((h) => h.job === "cosmic")!.ranMs).toBe(3_600_000 + 1_800_000);
    // Its rows stand as last known: nobody checked them this time.
    expect(view.review!.slipped.filter((r) => r.unchecked).map((r) => r.key)).toEqual(["env-mac:held:host:h1"]);
  });

  it("says a host timed out in his words, never the wire method's, and that nothing of it is shown when it never answered", async () => {
    links["env-mac"]!.answer = (method) => (method === "work.review.week" ? new TimeoutError("work.review.week", 30_000) : { ok: true });
    await loadWeek(WEEK);
    expect(reviewNow(WEEK).errors).toEqual([{ environmentId: "env-mac", name: "The Mac", error: "it timed out", kept: false }]);
  });

  it("lists jobs in the order he dragged the rail into, a job on two hosts at its first row's place", async () => {
    const snapshot = workspaceStore.getSnapshot();
    const ws = (id: string, environmentId: string, sector: string) => ({ id, environmentId, kind: "work", sector, name: sector, path: `/${environmentId}/${sector}` });
    vi.spyOn(workspaceStore, "getSnapshot").mockReturnValue({ ...snapshot, workspaces: [ws("w-cosmic", "env-box", "cosmic"), ws("w-hypixel", "env-box", "hypixel"), ws("w-purdue", "env-box", "purdue"), ws("m-cosmic", "env-mac", "cosmic")] } as never);
    // Purdue dragged to the top; the Mac's Cosmic sits last in the rail and must not move Cosmic down.
    localStorage.setItem("monocode.projectRailOrder", JSON.stringify(["/env-box/purdue", "/env-box/cosmic", "/env-box/hypixel", "/env-mac/cosmic"]));
    await loadWeek(WEEK);
    expect(reviewNow(WEEK).review!.jobs.map((j) => j.key).slice(0, 3)).toEqual(["purdue", "cosmic", "hypixel"]);
    // A pinned row leads the rail's list, so it leads here; an open page is told of a pin or a drag and follows at once.
    const { savePinnedProjects, saveProjectRailOrder } = await import("../../lib/recents");
    const page = renderHook(() => useReview(WEEK));
    const order = () => page.result.current.review!.jobs.map((j) => j.key).slice(0, 3);
    act(() => savePinnedProjects(["/env-box/hypixel"]));
    expect(order()).toEqual(["hypixel", "purdue", "cosmic"]);
    act(() => saveProjectRailOrder(["/env-box/hypixel", "/env-box/cosmic", "/env-box/purdue", "/env-mac/cosmic"]));
    expect(order()).toEqual(["hypixel", "cosmic", "purdue"]);
    page.unmount();
  });

  it("holds a host that links again as from before until its new answer lands, with no page open too", async () => {
    await loadWeek(WEEK);
    expect(reviewNow(WEEK).settled).toBe(true);
    // The Mac slept and woke with nobody on the page: the registry tells every listener of the link's return.
    const opens: (() => void)[] = [];
    const link = { environmentId: "env-mac", onPush: () => () => {}, onOpen: (fn: () => void) => (opens.push(fn), () => {}) };
    for (const listener of (registry as unknown as { linkListeners: Set<(l: unknown, e: string) => void> }).linkListeners) listener(link, "added");
    for (const fn of opens) fn();
    const view = reviewNow(WEEK);
    // Its old part still stands in the numbers, as last known; nothing is settled, compared or called empty on it.
    expect(view.settled).toBe(false);
    expect(view.review!.known).toEqual({ calendar: true, desk: false, shipped: false, slipped: false });
    expect(view.review!.slipped.filter((r) => r.unchecked).map((r) => r.key)).toEqual(["env-mac:held:host:h1"]);
    await loadWeek(WEEK);
    expect(reviewNow(WEEK)).toMatchObject({ settled: true, review: { known: { desk: true, slipped: true } } });
  });

  it("moves to a named week before it reads or marks any week seen", async () => {
    // This week is cached and unseen; an older run's row opens the page at its own week.
    await loadZone();
    await loadWeek(thisWeek());
    for (const id of Object.keys(links)) links[id]!.calls.length = 0;
    const { openWorkPlaceAt, takeWorkPlaceAt } = await import("../../lib/workPlaceAt");
    const { View } = await import("./ReviewPage");
    resetShown();
    act(() => openWorkPlaceAt("review", WEEK.from));
    const page = render(createElement(View, {} as never));
    // The bones, not this week's rows.
    expect(page.container.querySelector("[data-review-job]")).toBeNull();
    expect(page.container.querySelector('[role="status"]')).not.toBeNull();
    await act(async () => {
      for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
    });
    const asked = (method: string) => Object.values(links).flatMap((l) => l.calls.filter((c) => c.method === method).map((c) => c.params.from));
    expect(new Set(asked("work.review.seen"))).toEqual(new Set([WEEK.from]));
    expect(new Set(asked("work.review.week"))).toEqual(new Set([WEEK.from]));
    expect(shownWeek().from).toBe(WEEK.from);
    page.unmount();
    takeWorkPlaceAt("review");
    resetShown();
    const { shellStore, initialShellState } = await import("../../stores/shell");
    shellStore.setState(initialShellState());
  });

  it("counts nothing of a host that went off after it answered, as its line says, and counts it again when it is back", async () => {
    await loadWeek(WEEK);
    links["env-mac"]!.answer = () => new Error("the request timed out");
    await loadWeek(WEEK);
    links["env-mac"]!.status = offline;
    const view = reviewNow(WEEK);
    expect(view.off).toEqual(["The Mac is off. Its threads and held items are not counted."]);
    // Neither its last answer nor its last failure is on the page while it is off.
    expect(view.errors).toEqual([]);
    expect(view.review!.hours.find((h) => h.job === "cosmic")!.ranMs).toBe(3_600_000);
    expect(view.review!.slipped.map((r) => r.environmentId)).not.toContain("env-mac");
    links["env-mac"]!.status = open;
    expect(reviewNow(WEEK).review!.hours.find((h) => h.job === "cosmic")!.ranMs).toBe(3_600_000);
  });

  it("says a week is being made while Make again reads it, and no longer once every host has answered", async () => {
    await loadWeek(WEEK);
    expect(reviewNow(WEEK).making).toBe(false);
    const made = makeAgain(WEEK);
    expect(reviewNow(WEEK).making).toBe(true);
    expect(reviewNow(WEEK).review).not.toBeNull();
    await made;
    expect(reviewNow(WEEK).making).toBe(false);
    expect(links["env-box"]!.calls.filter((c) => c.method === "work.review.week")).toHaveLength(2);
  });

  it("says nothing is known to be empty, and compares no weeks, until every host has answered afresh", async () => {
    const before = { from: WEEK.from - 7 * 86_400_000, to: WEEK.to - 7 * 86_400_000, lifeos: { events: [{ sector: "cosmic", from: WEEK.from - 6 * 86_400_000, to: WEEK.from - 6 * 86_400_000 + 8 * 3_600_000 }], sent: [] }, points: [] };
    bodies.box = { ...bodies.box!, before };
    await loadWeek(WEEK);
    expect(reviewNow(WEEK).review!.known).toEqual({ calendar: true, desk: true, shipped: true, slipped: true });
    expect(reviewNow(WEEK).review!.compare.map((c) => c.job)).toEqual(["cosmic"]);
    // The Mac times out: its old part still stands in the totals, so nothing is compared and no "nothing" is claimed.
    links["env-mac"]!.answer = () => new Error("the request timed out");
    await loadWeek(WEEK);
    expect(reviewNow(WEEK).review!.compare).toEqual([]);
    expect(reviewNow(WEEK).review!.known).toEqual({ calendar: true, desk: false, shipped: false, slipped: false });
    // Off: out of both weeks alike, so the comparison holds; what it holds is still not known.
    links["env-mac"]!.status = offline;
    await loadWeek(WEEK);
    expect(reviewNow(WEEK).review!.compare.map((c) => c.job)).toEqual(["cosmic"]);
    expect(reviewNow(WEEK).review!.known.desk).toBe(false);
  });

  it("prefers the LifeOS facts of a host that answered this time, and sends a press there", async () => {
    await loadWeek(WEEK);
    expect(reviewNow(WEEK).review!.lifeosFrom).toBe("env-box");
    // The home times out; what it said before still holds a task the Mac's fresh read no longer lists.
    links["env-box"]!.answer = (method) => (method === "work.review.week" ? new Error("the request timed out") : { ok: true });
    bodies.mac = { ...bodies.mac!, lifeos: bodies.box!.lifeos, slipped: { at: AFTER, rows: bodies.box!.slipped.rows.filter((r) => r.key === "mail:tw1") } };
    await loadWeek(WEEK);
    const review = reviewNow(WEEK).review!;
    expect(review.lifeosFrom).toBe("env-mac");
    expect(review.slipped.filter((r) => r.ref.kind !== "held").map((r) => [r.key, r.environmentId])).toEqual([["mail:tw1", "env-mac"]]);
  });

  it("lists a job whose only host is off, with nothing known of it", async () => {
    const snapshot = workspaceStore.getSnapshot();
    vi.spyOn(workspaceStore, "getSnapshot").mockReturnValue({
      ...snapshot,
      workspaces: [
        { id: "w-cosmic", environmentId: "env-box", kind: "work", sector: "cosmic", name: "Cosmic", path: "/w/cosmic" },
        { id: "m-unify", environmentId: "env-mac", kind: "work", sector: "unify", name: "Unify", path: "/m/unify" },
      ],
    } as never);
    links["env-mac"]!.status = offline;
    bodies.box = { ...bodies.box!, jobs: [{ workspaceId: "w-cosmic", sector: "cosmic", name: "Cosmic" }], slipped: { at: AFTER, rows: [] } };
    await loadWeek(WEEK);
    const review = reviewNow(WEEK).review!;
    expect(review.jobs.map((j) => [j.key, j.name, j.at.length])).toEqual([
      ["cosmic", "Cosmic", 1],
      ["unify", "Unify", 0],
    ]);
    expect(review.known.desk).toBe(false);
  });

  it("answers a press's reload with a read that starts after it, never one already on its way", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const box = links["env-box"]!.answer;
    let reads = 0;
    links["env-box"]!.answer = (method, params) => (method === "work.review.week" ? (reads++, gate.then(() => bodies.box)) : box(method, params));
    const first = loadWeek(WEEK);
    const after = loadWeek(WEEK, true);
    // A plain ask shares the read on its way; the one after a write waits it out and asks again.
    void loadWeek(WEEK);
    expect(reads).toBe(1);
    release();
    await first;
    await after;
    expect(reads).toBe(2);
  });

  it("puts a week on record before any host answers, and asks for the zone again once one can say", async () => {
    for (const id of Object.keys(links)) links[id]!.status = offline;
    await loadZone();
    await loadWeek(WEEK);
    // Off, not loading: nothing is waited for.
    expect(reviewNow(WEEK)).toMatchObject({ review: null, settled: true });
    expect(reviewZone()).not.toBe("Pacific/Kiritimati");
    // The host links: the zone ask that nobody answered was not kept, so this one reaches it.
    links["env-box"]!.status = open;
    const box = links["env-box"]!.answer;
    links["env-box"]!.answer = (method, params) => (method === "work.review.list" ? { weeks: [], tz: "Pacific/Kiritimati" } : box(method, params));
    await loadZone();
    expect(reviewZone()).toBe("Pacific/Kiritimati");
  });

  it("opens at a week only once the zone weeks are cut in is known", async () => {
    // A host far to the east: its Monday midnight is still Sunday in this window's own zone.
    const east = "Pacific/Kiritimati";
    const box = links["env-box"]!.answer;
    links["env-box"]!.answer = (method, params) => (method === "work.review.list" ? { weeks: [], tz: east } : box(method, params));
    const monday = weekOf(WEEK.from + 3 * 86_400_000, east).from;
    resetShown();
    const named = monday - 14 * 86_400_000;
    expect(shownWeek(named).from).not.toBe(named);
    await showWeekNamed(named);
    expect(shownWeek().from).toBe(named);
    resetShown();
  });

  it("turns to the new week at the week's end, for a page left open", () => {
    vi.useFakeTimers();
    try {
      let at = WEEK.to - 60_000;
      resetReviewStore({ now: () => at, zone: TZ });
      resetShown();
      const { result } = renderHook(() => useWeekTurn());
      expect(result.current).toBe(WEEK.from);
      at = WEEK.to + 1_000;
      act(() => void vi.advanceTimersByTime(61_000));
      expect(result.current).toBe(WEEK.to);
      // A machine that slept past the next turn hears it when the window is seen again.
      at = WEEK.to + 8 * 86_400_000;
      act(() => void document.dispatchEvent(new Event("visibilitychange")));
      expect(result.current).toBeGreaterThan(WEEK.to);
    } finally {
      cleanup();
      vi.useRealTimers();
    }
  });

  it("takes LifeOS from another host when the home could not reach it, and says only what is still missing", async () => {
    bodies.box = { ...bodies.box!, lifeos: null, left: [LEFT.lifeos, LEFT.held] };
    await loadWeek(WEEK);
    const view = reviewNow(WEEK);
    expect(view.review!.lifeosFrom).toBe("env-mac");
    expect(view.review!.left).toEqual([LEFT.held]);
  });

  it("is not settled, and has no review, until a host has answered", () => {
    expect(reviewNow(WEEK)).toMatchObject({ review: null, settled: false });
  });

  it("falls back to the window's own zone when no host says one", async () => {
    for (const id of Object.keys(links)) links[id]!.answer = () => new Error("not built: work.review.list");
    await loadZone();
    expect(reviewZone()).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
  });
});

describe("a press goes to the host that owns the row", () => {
  it("LifeOS's rows to the host they were read from, a held row to its own host, a nudge to a host with the job's workspace", async () => {
    await loadWeek(WEEK);
    const review = reviewNow(WEEK).review!;
    const row = (key: string) => review.slipped.find((r) => r.key === key)!;
    expect(settleHost(review, row("task:k1"), "now")).toBe("env-box");
    expect(settleHost(review, row("env-mac:held:host:h1"), "drop")).toBe("env-mac");
    expect(settleHost(review, row("mail:tw1"), "later")).toBe("env-box");
    expect(settleHost(review, row("mail:tw1"), "now")).toBe("env-box");

    const done = await settleRow(review, row("task:k1"), "later");
    expect(done).toEqual({ undo: "tok", environmentId: "env-box" });
    expect(links["env-box"]!.calls.find((c) => c.method === "work.review.settle")).toEqual({ method: "work.review.settle", params: { row: { kind: "task", id: "k1", dueAt: WEEK.from }, how: "later", tz: TZ, sector: "hypixel" } });
    await undoSettle(done, WEEK);
    expect(links["env-box"]!.calls.filter((c) => c.method === "work.review.undo")).toEqual([{ method: "work.review.undo", params: { token: "tok" } }]);
    // Every press and every undo reads the week again.
    expect(links["env-box"]!.calls.filter((c) => c.method === "work.review.week").length).toBeGreaterThan(1);
  });

  it("sends a nudge for a job the home has no workspace of to a host that has one", async () => {
    bodies.box = { ...bodies.box!, jobs: bodies.box!.jobs.filter((j) => j.sector !== "cosmic") };
    await loadWeek(WEEK);
    const review = reviewNow(WEEK).review!;
    const mail = review.slipped.find((r) => r.key === "mail:tw1")!;
    expect(settleHost(review, mail, "now")).toBe("env-mac");
    expect(await settleRow(review, mail, "now")).toEqual({ undo: null, sessionId: "nudge", environmentId: "env-mac" });
  });
});

describe("money", () => {
  it("shows Money's own sums by job, the two ledgers of one job added, and nothing where Money does not answer", async () => {
    const answer = links["env-box"]!.answer;
    links["env-box"]!.answer = (method, params) =>
      method === "work.money.sums" ? { rows: [{ workspaceId: "w-cosmic", sector: "cosmic", in: 100_00, out: 25_00, owedToHim: 0, heOwes: 0, miles: 0, currency: "USD" }, { workspaceId: "w-ref", sector: "ref", in: 0, out: 0, owedToHim: 500, heOwes: 0, miles: 0, currency: "USD" }] } : answer(method, params);
    const mac = links["env-mac"]!.answer;
    links["env-mac"]!.answer = (method, params) => (method === "work.money.sums" ? { rows: [{ workspaceId: "m-cosmic", sector: "cosmic", in: 50_00, out: 0, owedToHim: 0, heOwes: 0, miles: 0, currency: "USD" }] } : mac(method, params));
    await loadZone();
    await loadWeek(WEEK);
    await new Promise((r) => setTimeout(r, 0));
    // Money is asked in local days, the last one exclusive.
    expect(links["env-box"]!.calls.find((c) => c.method === "work.money.sums")).toEqual({ method: "work.money.sums", params: { from: "2026-11-16", to: "2026-11-23" } });
    expect([...reviewNow(WEEK).money]).toEqual([["cosmic", { in: 150_00, out: 25_00 }]]);
    // A host from before Money: no line, and the review stands.
    links["env-box"]!.answer = (method, params) => (method === "work.money.sums" ? new Error("not built") : answer(method, params));
    resetReviewStore({ now: () => AFTER, zone: TZ });
    await loadWeek(WEEK);
    await new Promise((r) => setTimeout(r, 0));
    expect([...reviewNow(WEEK).money]).toEqual([["cosmic", { in: 50_00, out: 0 }]]);
    expect(reviewNow(WEEK).errors).toEqual([]);
    // A host that is off adds no sums either: every number is of the hosts the page counts.
    links["env-mac"]!.status = offline;
    await loadWeek(WEEK);
    expect([...reviewNow(WEEK).money]).toEqual([]);
  });
});

describe("seen, and the routine", () => {
  it("tells every linked host he opened the week", () => {
    links["env-mac"]!.status = offline;
    markSeen(WEEK);
    expect(links["env-box"]!.calls).toEqual([{ method: "work.review.seen", params: { from: WEEK.from } }]);
    expect(links["env-mac"]!.calls).toEqual([]);
  });

  it("names the routine of the first host that has one, the home first", async () => {
    expect(await loadRoutine()).toEqual({ workspaceId: "m-cosmic", routineId: "r1", words: "Fridays at 4:00 PM", environmentId: "env-mac" });
    expect(links["env-box"]!.calls.map((c) => c.method)).toEqual(["work.review.routine"]);
  });
});
