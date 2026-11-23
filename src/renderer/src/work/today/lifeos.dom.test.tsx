// @vitest-environment jsdom
/**
 * Today's one LifeOS read over two hosts (docs/agents/work-today.md "One
 * LifeOS session"): the all-sector session's rows, and a sector that
 * session lacks read on another host and merged by id.
 */
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetLifeos } from "../shell/lifeos";
import { FakeConvex, fakeSession } from "./fakeLifeos";
import { act as rowAct, mutate, useLifeosRows } from "./lifeos";
import type { TodayEnv, TodayWorkspace } from "./types";

const toasts = vi.hoisted(() => ({ said: [] as { line: string; undo?: () => void; error?: boolean }[] }));
vi.mock("../../components/ui/toaster", () => {
  const toast = Object.assign((line: string, opts?: { action?: { onClick(): void } }) => void toasts.said.push({ line, ...(opts?.action ? { undo: opts.action.onClick } : {}) }), {
    error: (line: string) => void toasts.said.push({ line, error: true }),
  });
  return { loadToast: () => Promise.resolve(toast) };
});

const job = (environmentId: string, sector: string): TodayWorkspace => ({ environmentId, workspaceId: `${environmentId}-${sector}`, sector: sector as TodayWorkspace["sector"], name: sector, path: `/w/${sector}`, open: true });
type Task = { _id: string; title: string; sector: string };
const pick = (value: Task[]) => value;
const idOf = (task: Task) => task._id;

afterEach(() => {
  cleanup();
  resetLifeos();
  toasts.said.length = 0;
});

function envOf(lifeos: TodayEnv["lifeos"], workspaces: TodayWorkspace[]): TodayEnv {
  return { day: { from: 0, to: 86_400_000 }, workspaces, lifeos, workspaceOf: (sector) => workspaces.find((w) => w.sector === sector) ?? null };
}

describe("useLifeosRows", () => {
  it("is null until the all-sector read answers, then its rows, and follows the live query", async () => {
    const box = new FakeConvex().answer("auth:caller", { sectors: "all" });
    const env = envOf(fakeSession("box", box), [job("box", "purdue"), job("mac", "ref")]);
    const { result } = renderHook(() => useLifeosRows<Task[], Task>(env, "tasks:list", {}, pick, idOf));
    expect(result.current).toMatchObject({ rows: null, error: null, pending: false, lost: [] });
    act(() => void box.answer("tasks:list", [{ _id: "t1", title: "One", sector: "purdue" }]));
    expect(result.current.rows?.map(idOf)).toEqual(["t1"]);
    expect(result.current.pending).toBe(false);
    act(() => void box.answer("tasks:list", [{ _id: "t1", title: "One", sector: "purdue" }, { _id: "t2", title: "Two", sector: "ref" }]));
    expect(result.current.rows?.map(idOf)).toEqual(["t1", "t2"]);
    // A session that holds every sector reads once: no host is asked for a narrowed session.
    expect(box.reads.filter((r) => r.name === "tasks:list")).toHaveLength(1);
    expect(box.reads.every((r) => !("sector" in r.args))).toBe(true);
  });

  it("reads a sector the session lacks through a session narrowed to it on another host that holds the job, merged by id", async () => {
    const box = new FakeConvex().answer("auth:caller", { sectors: ["purdue"] }).answer("tasks:list", [{ _id: "t1", title: "One", sector: "purdue" }]);
    const mac = new FakeConvex().answer("tasks:list", (args: Record<string, unknown>) => [
      { _id: "t9", title: `Ref's, asked with ${JSON.stringify(args)}`, sector: "ref" },
      // The same row from two sessions is one row: the first to give it wins.
      { _id: "t1", title: "A second copy", sector: "purdue" },
    ]);
    const lifeos = fakeSession("box", box);
    fakeSession("mac", mac, "ref");
    const env = envOf(lifeos, [job("box", "purdue"), job("mac", "ref"), job("box", "unify")]);
    const { result } = renderHook(() => useLifeosRows<Task[], Task>(env, "tasks:list", {}, pick, idOf));
    await waitFor(() => expect(result.current.rows?.map(idOf)).toEqual(["t1", "t9"]));
    expect(result.current.rows![0]!.title).toBe("One");
    // The narrowed read names its sector; unify has no other host, so nothing more is asked.
    expect(mac.reads.filter((r) => r.name === "tasks:list").map((r) => r.args)).toEqual([{ sector: "ref" }]);
    expect(result.current.rows![1]!.title).toContain('"sector":"ref"');
  });

  it("is pending while the session has not said its cover, or a sector's read on another host is still out: the rows that came are not all of them", async () => {
    const box = new FakeConvex().answer("tasks:list", [{ _id: "t1", title: "One", sector: "purdue" }]);
    const mac = new FakeConvex();
    const lifeos = fakeSession("box", box);
    fakeSession("mac", mac, "ref");
    const env = envOf(lifeos, [job("box", "purdue"), job("mac", "ref")]);
    const { result } = renderHook(() => useLifeosRows<Task[], Task>(env, "tasks:list", {}, pick, idOf));
    // The first read is back; whether it covers every job is not known yet.
    expect(result.current).toMatchObject({ rows: [{ _id: "t1" }], pending: true, lost: [] });
    act(() => void box.answer("auth:caller", { sectors: ["purdue"] }));
    // It lacks ref: the read on the Mac is out.
    await waitFor(() => expect(mac.reads.map((r) => r.args)).toEqual([{ sector: "ref" }]));
    expect(result.current.pending).toBe(true);
    act(() => void mac.answer("tasks:list", [{ _id: "t9", title: "Ref's", sector: "ref" }]));
    expect(result.current).toMatchObject({ pending: false, lost: [] });
    expect(result.current.rows?.map(idOf)).toEqual(["t1", "t9"]);
  });

  it("names a sector's read that failed, beside the rows that did arrive; Retry lets go of every read and asks afresh", async () => {
    const box = new FakeConvex().answer("auth:caller", { sectors: ["purdue"] }).answer("tasks:list", [{ _id: "t1", title: "One", sector: "purdue" }]);
    const mac = new FakeConvex().answer("tasks:list", () => {
      throw new Error("tasks:list is gone");
    });
    const lifeos = fakeSession("box", box);
    fakeSession("mac", mac, "ref");
    const env = envOf(lifeos, [job("box", "purdue"), job("mac", "ref")]);
    const { result } = renderHook(() => useLifeosRows<Task[], Task>(env, "tasks:list", {}, pick, idOf));
    await waitFor(() => expect(result.current.lost).toEqual([{ environmentId: "mac", sector: "ref", error: "tasks:list is gone" }]));
    expect(result.current).toMatchObject({ rows: [{ _id: "t1" }], pending: false });
    const asked = { box: box.reads.length, mac: mac.reads.length };
    mac.answer("tasks:list", [{ _id: "t9", title: "Ref's", sector: "ref" }]);
    await act(async () => {
      await result.current.retry();
    });
    await waitFor(() => expect(result.current.rows?.map(idOf)).toEqual(["t1", "t9"]));
    expect(result.current.lost).toEqual([]);
    // Every read was made again, the first one's too.
    expect(box.reads.length).toBeGreaterThan(asked.box);
    expect(mac.reads.length).toBeGreaterThan(asked.mac);
  });

  it("says LifeOS's own refusal of the read", () => {
    const box = new FakeConvex().answer("auth:caller", { sectors: "all" }).answer("tasks:list", () => {
      throw new Error("Could not find public function for 'tasks:list'");
    });
    const env = envOf(fakeSession("box", box), [job("box", "purdue")]);
    const { result } = renderHook(() => useLifeosRows<Task[], Task>(env, "tasks:list", {}, pick, idOf));
    expect(result.current.rows).toBeNull();
    expect(result.current.error).toContain("tasks:list");
  });
});

describe("a row's act", () => {
  it("writes as the session's owner, says what it did in one toast, and its Undo runs the way back", async () => {
    const box = new FakeConvex().onWrite("tasks:snooze", () => "snoozed");
    const session = fakeSession("box", box);
    const result = await rowAct({ run: () => mutate<string>(session, "tasks:snooze", { id: "t1", until: 5 }), message: "Snoozed until tomorrow", failed: "snooze", undo: () => mutate(session, "tasks:unsnooze", { id: "t1" }) });
    expect(result).toBe("snoozed");
    expect(box.writes).toEqual([{ name: "tasks:snooze", args: { id: "t1", until: 5 } }]);
    expect(toasts.said.map((t) => t.line)).toEqual(["Snoozed until tomorrow"]);
    toasts.said[0]!.undo!();
    await waitFor(() => expect(box.writes.at(-1)).toEqual({ name: "tasks:unsnooze", args: { id: "t1" } }));
  });

  it("that fails says so in its own words and rejects, so the row comes back", async () => {
    const box = new FakeConvex().onWrite("tasks:snooze", () => {
      throw new Error("no such task");
    });
    const session = fakeSession("box", box);
    await expect(rowAct({ run: () => mutate(session, "tasks:snooze", { id: "t1", until: 5 }), message: "Snoozed until tomorrow", failed: "snooze" })).rejects.toThrow("no such task");
    expect(toasts.said).toEqual([{ line: "Couldn't snooze", error: true }]);
    await expect(mutate({ environmentId: "box", sector: null, client: null, state: "signed-out" }, "tasks:snooze", {})).rejects.toThrow("LifeOS is not connected");
  });
});
