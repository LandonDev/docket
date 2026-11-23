// @vitest-environment jsdom
/**
 * Today's three LifeOS sources against a LifeOS in memory and hosts that
 * answer from memory: what each reads, what each act sends and what a
 * failure puts back (docs/agents/work-today.md "Where each row comes from").
 */
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const world = vi.hoisted(() => ({
  calls: [] as { env: string; method: string; params: unknown }[],
  fail: new Set<string>(),
  toasts: [] as { line: string; undo?: () => void; error?: boolean; loading?: boolean }[],
  opened: [] as string[],
  started: [] as unknown[][],
}));

vi.mock("../../lib/connection", async (original) => ({
  ...(await original<typeof import("../../lib/connection")>()),
  registry: {
    linkOf: (env: string) => ({
      request: async (method: string, params: unknown) => {
        world.calls.push({ env, method, params });
        if (world.fail.has(method)) throw new Error(`${method} was refused`);
        return method === "work.mail.nudge" ? { sessionId: "thread-9" } : { threadId: null, nextId: null };
      },
      onPush: () => () => undefined,
      onOpen: () => () => undefined,
      connected: true,
    }),
    onLink: () => () => undefined,
  },
}));
vi.mock("../../components/ui/toaster", () => {
  const toast = Object.assign((line: string, opts?: { action?: { onClick(): void } }) => void world.toasts.push({ line, ...(opts?.action ? { undo: opts.action.onClick } : {}) }), {
    error: (line: string) => void world.toasts.push({ line, error: true }),
    loading: (line: string) => (world.toasts.push({ line, loading: true }), "toast-1"),
    dismiss: () => {},
  });
  return { loadToast: () => Promise.resolve(toast) };
});
vi.mock("../shell/WorkColumn", () => ({ startThreadAbout: (...args: unknown[]) => void world.started.push(args) }));

import { openWorkView, workEnterPort, workOpenPort, workViewNow } from "../../lib/workSwitch";
import { projectStore } from "../../stores/project";
import { shell, shellStore } from "../../stores/shell";
import { resetLifeos } from "../shell/lifeos";
import { source as due } from "./due";
import { FakeConvex, fakeSession } from "./fakeLifeos";
import { source as meetings } from "./meetings";
import { dayBounds } from "./model";
import { goTo, openToday, TODAY, toggleToday } from "./open";
import { resetToday, todayNow } from "./store";
import type { TodayEnv, TodayRow, TodayWorkspace } from "./types";
import { source as waiting } from "./waiting";

const at = (day: number, hour: number, minute = 0) => new Date(2026, 10, day, hour, minute).getTime();
const job = (environmentId: string, sector: string): TodayWorkspace => ({ environmentId, workspaceId: `${environmentId}-${sector}`, sector: sector as TodayWorkspace["sector"], name: sector, path: `/w/${sector}`, open: true });
const JOBS = [job("box", "purdue"), job("mac", "ref")];

let convex: FakeConvex;
function envNow(now = at(23, 9, 30)): TodayEnv {
  return { day: dayBounds(now), workspaces: JOBS, lifeos: fakeSession("box", convex), workspaceOf: (sector) => JOBS.find((w) => w.sector === sector) ?? null };
}
const rowOf = (rows: TodayRow[] | undefined, key: string): TodayRow => rows!.find((r) => r.key === key)!;

beforeEach(() => {
  vi.useFakeTimers({ now: at(23, 9, 30), toFake: ["Date", "setTimeout", "clearTimeout"] });
  convex = new FakeConvex().answer("auth:caller", { sectors: "all" });
  world.calls.length = 0;
  world.fail.clear();
  world.toasts.length = 0;
  world.opened.length = 0;
  world.started.length = 0;
  workOpenPort.set((id) => void world.opened.push(id));
  resetToday([]);
});
afterEach(() => {
  cleanup();
  resetLifeos();
  workOpenPort.set(null);
  openWorkView(null);
  vi.useRealTimers();
});

describe("the meetings source", () => {
  const EVENTS = [
    { _id: "e1", title: "Staff sync", sector: "purdue", startsAt: at(23, 10, 30), endsAt: at(23, 11), allDay: false, location: "CoRec 2212", attendees: [{ address: "dana@example.edu" }] },
    { _id: "e2", title: "Crew meeting", sector: "ref", startsAt: at(23, 18), endsAt: at(23, 19), allDay: false, leaveAt: at(23, 17, 10) },
    { _id: "e3", title: "Staff sync", sector: "purdue", startsAt: at(24, 9), endsAt: at(24, 10), allDay: false },
  ];

  it("reads two local days once for every job, and the people of each sector a job holds", () => {
    convex.answer("events:range", EVENTS).answer("people:directory", (args: Record<string, unknown>) => (args.sector === "purdue" ? [{ _id: "p1", name: "Dana Reyes", emails: ["dana@example.edu"] }] : []));
    const env = envNow();
    const { result } = renderHook(() => meetings.use(env));
    expect(convex.reads.filter((r) => r.name === "events:range").map((r) => r.args)).toEqual([{ from: at(23, 0), to: at(25, 0) }]);
    expect(convex.reads.filter((r) => r.name === "people:directory").map((r) => r.args.sector).sort()).toEqual(["purdue", "ref"]);
    expect(result.current.rows!.map((r) => [r.title, r.detail, r.when, r.whenLine])).toEqual([
      ["Staff sync", "CoRec 2212, with Dana Reyes", "10:30 AM", "in 60 min"],
      ["Crew meeting", undefined, "6:00 PM", "Leave 5:10 PM"],
    ]);
  });

  it("the live line moves with the minute, and only the row it belongs to is a new row", async () => {
    convex.answer("events:range", EVENTS);
    const env = envNow();
    const { result } = renderHook(() => meetings.use(env));
    const before = result.current.rows!;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    const after = result.current.rows!;
    expect(after[0]!.whenLine).toBe("in 59 min");
    expect(after[0]).not.toBe(before[0]);
    // The other row says what it said: the same object, so its row does not redraw.
    expect(after[1]).toBe(before[1]);
  });

  it("is still to answer until LifeOS does, and says LifeOS's own refusal against the host that read it", () => {
    const env = envNow();
    const { result } = renderHook(() => meetings.use(env));
    expect(result.current).toEqual({ loading: true });
    act(() => void convex.answer("events:range", () => {
      throw new Error("events:range is gone");
    }));
    expect(result.current.failed).toEqual([{ environmentId: "box", error: "events:range is gone" }]);
  });

  it("Prepare starts a thread about the event in its job's workspace, and the press opens it in that job's Agenda", () => {
    convex.answer("events:range", EVENTS);
    const env = envNow();
    const { result } = renderHook(() => meetings.use(env));
    const crew = rowOf(result.current.rows, "event:e2");
    void crew.acts![0]!.run();
    expect(world.started).toEqual([[{ kind: "event", label: "Crew meeting", ref: { at: "lifeos", table: "events", id: "e2" } }, null, "/w/ref"]]);
    crew.open();
    expect(workViewNow()).toEqual({ workspaceId: "mac-ref", view: "agenda", event: "e2" });
    expect(projectStore.getState().projectCwd).toBe("/w/ref");
  });
});

describe("the due source", () => {
  const TASKS = [
    { _id: "t1", title: "Renew registration", sector: "ref", status: "todo", dueAt: at(21, 9) },
    { _id: "t2", title: "Order jerseys", sector: "purdue", status: "todo", dueAt: at(23, 15) },
    { _id: "t3", title: "Next week's", sector: "purdue", status: "todo", dueAt: at(30, 9) },
  ];

  it("reads every job's open tasks once and keeps today's", () => {
    convex.answer("tasks:list", TASKS);
    const env = envNow();
    const { result } = renderHook(() => due.use(env));
    expect(convex.reads.filter((r) => r.name === "tasks:list").map((r) => r.args)).toEqual([{}]);
    expect(result.current.rows!.map((r) => [r.key, r.when, r.late])).toEqual([
      ["task:t1", "Nov 21", true],
      ["task:t2", "3:00 PM", undefined],
    ]);
  });

  it("the tick completes the task through its job's host; the row leaves, and Undo reopens it and brings it back", async () => {
    convex.answer("tasks:list", TASKS);
    const env = envNow();
    const { result } = renderHook(() => due.use(env));
    const lead = rowOf(result.current.rows, "task:t1").lead;
    await act(async () => {
      if (lead?.kind === "tick") await lead.run();
    });
    // The task is the ref job's, which lives on the Mac: Done goes there, so a thread's link rides with it.
    expect(world.calls).toEqual([{ env: "mac", method: "work.tasks.done", params: { workspaceId: "mac-ref", taskId: "t1" } }]);
    expect(world.toasts.map((t) => t.line)).toEqual(["Marked done"]);
    expect(todayNow().leaving.has("task:t1")).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120);
    });
    expect(todayNow().leaving.has("task:t1")).toBe(false);
    expect(todayNow().closing.has("task:t1")).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(180);
    });
    expect(todayNow().gone.has("task:t1")).toBe(true);
    await act(async () => {
      world.toasts[0]!.undo!();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(convex.writes).toEqual([{ name: "tasks:reopen", args: { id: "t1" } }]);
    expect(todayNow().gone.has("task:t1")).toBe(false);
  });

  it("a Done the host refuses says so and puts the row back, and the tick's run rejects so the box unticks", async () => {
    convex.answer("tasks:list", TASKS);
    world.fail.add("work.tasks.done");
    const env = envNow();
    const { result } = renderHook(() => due.use(env));
    const lead = rowOf(result.current.rows, "task:t2").lead;
    let failed = false;
    await act(async () => {
      if (lead?.kind === "tick") await lead.run().catch(() => (failed = true));
    });
    expect(failed).toBe(true);
    expect(world.toasts).toEqual([{ line: "Couldn't mark done", error: true }]);
    expect(todayNow().leaving.has("task:t2")).toBe(false);
    expect(todayNow().gone.has("task:t2")).toBe(false);
  });

  it("Tomorrow snoozes the task to the next morning in LifeOS, with Undo", async () => {
    convex.answer("tasks:list", TASKS);
    const env = envNow();
    const { result } = renderHook(() => due.use(env));
    await act(async () => {
      await rowOf(result.current.rows, "task:t2").acts![0]!.run();
    });
    expect(convex.writes).toEqual([{ name: "tasks:snooze", args: { id: "t2", until: at(24, 9) } }]);
    expect(world.toasts.map((t) => t.line)).toEqual(["Snoozed until tomorrow"]);
    expect(todayNow().leaving.has("task:t2")).toBe(true);
    await act(async () => {
      world.toasts[0]!.undo!();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(convex.writes.at(-1)).toEqual({ name: "tasks:unsnooze", args: { id: "t2" } });
    expect(todayNow().leaving.has("task:t2")).toBe(false);
  });

  it("the press opens the task's sheet in its job's Tasks view", () => {
    convex.answer("tasks:list", TASKS);
    const env = envNow();
    const { result } = renderHook(() => due.use(env));
    rowOf(result.current.rows, "task:t2").open();
    expect(workViewNow()).toEqual({ workspaceId: "box-purdue", view: "tasks", task: "t2" });
  });
});

describe("the waiting source", () => {
  const WAITS = [
    { _id: "m1", subject: "Sponsor deck", sector: "purdue", waiting: { since: at(17, 9), dueAt: at(20, 9), asked: false, to: [{ name: "Marcus Bell", address: "marcus@example.edu" }] } },
    { _id: "m2", subject: "Crew list", sector: "ref", waiting: { since: at(20, 14), dueAt: at(23, 9), asked: true, to: [{ address: "crew@example.com" }] } },
  ];

  it("reads the first page of twenty waits once for every job", () => {
    convex.answer("mailWaits:list", { page: WAITS, isDone: true, continueCursor: "" });
    const env = envNow();
    const { result } = renderHook(() => waiting.use(env));
    expect(convex.reads.filter((r) => r.name === "mailWaits:list").map((r) => r.args)).toEqual([{ paginationOpts: { numItems: 20, cursor: null } }]);
    expect(result.current.rows!.map((r) => [r.title, r.when])).toEqual([
      ["Marcus Bell", "6 days"],
      ["crew@example.com", "3 days"],
    ]);
  });

  it("Nudge asks the job's host to start the drafting thread, then opens it", async () => {
    convex.answer("mailWaits:list", { page: WAITS });
    const env = envNow();
    shell.openWorkPlace(TODAY);
    const { result } = renderHook(() => waiting.use(env));
    await act(async () => {
      await rowOf(result.current.rows, "mail:m2").acts![0]!.run();
    });
    expect(world.calls).toEqual([{ env: "mac", method: "work.mail.nudge", params: { workspaceId: "mac-ref", threadId: "m2" } }]);
    expect(world.opened).toEqual(["thread-9"]);
    expect(shellStore.getState().workPlace).toBeNull();
    // A wait that left the row: nothing was dismissed.
    expect(convex.writes).toEqual([]);
  });

  it("a nudge the host refuses says why and opens nothing", async () => {
    convex.answer("mailWaits:list", { page: WAITS });
    world.fail.add("work.mail.nudge");
    const env = envNow();
    const { result } = renderHook(() => waiting.use(env));
    await act(async () => {
      await rowOf(result.current.rows, "mail:m1").acts![0]!.run();
    });
    expect(world.opened).toEqual([]);
    expect(world.toasts.at(-1)).toMatchObject({ line: "The nudge did not start", error: true });
  });

  it("Dismiss takes the wait off in LifeOS, fenced by when he wrote; Undo puts it back as it stood", async () => {
    convex.answer("mailWaits:list", { page: WAITS }).onWrite("mailWaits:dismiss", () => ({ state: "due", dueAt: at(20, 9), since: at(17, 9) }));
    const env = envNow();
    const { result } = renderHook(() => waiting.use(env));
    await act(async () => {
      await rowOf(result.current.rows, "mail:m1").acts![1]!.run();
    });
    expect(convex.writes).toEqual([{ name: "mailWaits:dismiss", args: { threadId: "m1", since: at(17, 9) } }]);
    expect(world.toasts.map((t) => t.line)).toEqual(["Dismissed"]);
    expect(todayNow().leaving.has("mail:m1")).toBe(true);
    await act(async () => {
      world.toasts[0]!.undo!();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(convex.writes.at(-1)).toEqual({ name: "mailWaits:putBack", args: { threadId: "m1", since: at(17, 9), state: "due", dueAt: at(20, 9) } });
    expect(todayNow().leaving.has("mail:m1")).toBe(false);
  });

  it("a Dismiss LifeOS refuses says so and puts the row back", async () => {
    convex.answer("mailWaits:list", { page: WAITS }).onWrite("mailWaits:dismiss", () => {
      throw new Error("stale");
    });
    const env = envNow();
    const { result } = renderHook(() => waiting.use(env));
    await act(async () => {
      await rowOf(result.current.rows, "mail:m1").acts![1]!.run()?.catch(() => {});
    });
    expect(world.toasts).toEqual([{ line: "Couldn't dismiss it", error: true }]);
    expect(todayNow().leaving.has("mail:m1")).toBe(false);
    expect(todayNow().gone.has("mail:m1")).toBe(false);
  });

  it("the press opens the mail in its job's Mail view", () => {
    convex.answer("mailWaits:list", { page: WAITS });
    const env = envNow();
    const { result } = renderHook(() => waiting.use(env));
    rowOf(result.current.rows, "mail:m2").open();
    expect(workViewNow()).toEqual({ workspaceId: "mac-ref", view: "mail", mail: "m2" });
    expect(projectStore.getState().projectCwd).toBe("/w/ref");
  });
});

describe("goTo and the page's own openers", () => {
  it("goTo closes Today, moves the window to the job's workspace and sets the view's target", () => {
    shell.openWorkPlace(TODAY);
    goTo(JOBS[0]!, { view: "tasks", task: "t2" });
    expect(shellStore.getState().workPlace).toBeNull();
    expect(projectStore.getState().projectCwd).toBe("/w/purdue");
    expect(workViewNow()).toEqual({ workspaceId: "box-purdue", view: "tasks", task: "t2" });
  });

  it("goTo enters the workspace as a press on its rail row does, where the window offers that", () => {
    const entered: string[] = [];
    workEnterPort.set((path) => void entered.push(path));
    try {
      goTo(JOBS[1]!, { view: "mail", mail: "m2" });
      expect(entered).toEqual(["/w/ref"]);
      expect(workViewNow()).toEqual({ workspaceId: "mac-ref", view: "mail", mail: "m2" });
    } finally {
      workEnterPort.set(null);
    }
  });

  it("openToday opens the page; the key's toggle closes it when it is the page on screen", () => {
    shell.openWorkPlace(null);
    openToday();
    expect(shellStore.getState().workPlace).toBe("today");
    toggleToday();
    expect(shellStore.getState().workPlace).toBeNull();
    toggleToday();
    expect(shellStore.getState().workPlace).toBe("today");
    shell.openWorkPlace(null);
  });
});
