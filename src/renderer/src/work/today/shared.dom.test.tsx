// @vitest-environment jsdom
/**
 * Today stops asking for what it holds (the perf pass's M2): one read a method for the window, shared by the page and
 * the keeper that runs its sources while it is closed; a slot is asked again only when a push names it or it went
 * stale while none read it; `work.prep.upcoming` once a host. Every assertion counts requests.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { Link } from "../../lib/connection";
import type { ServerPush } from "../../lib/tcserver/types";
import { forgetEach, FRESH_MS, useEachWorkspace } from "./read";
import { source as prep } from "../prep/today";
import type { TodayEnv, TodayWorkspace } from "./types";

/** A host's link that answers every ask at once, and counts them. */
class FakeLink implements Link {
  profile = "local" as const;
  connected = true;
  asked: { method: string; params: unknown }[] = [];
  private pushes = new Set<(push: ServerPush) => void>();
  private opens = new Set<() => void>();
  constructor(readonly environmentId: string) {}
  request<T>(method: string, params?: unknown): Promise<T> {
    this.asked.push({ method, params });
    return Promise.resolve((method === "work.prep.upcoming" ? { meetings: [] } : { n: this.asked.length }) as T);
  }
  onPush(listener: (push: ServerPush) => void): () => void {
    this.pushes.add(listener);
    return () => this.pushes.delete(listener);
  }
  onOpen(listener: () => void): () => void {
    this.opens.add(listener);
    return () => this.opens.delete(listener);
  }
  onClose(): () => void {
    return () => {};
  }
  push(push: unknown): void {
    for (const listener of this.pushes) listener(push as ServerPush);
  }
  open(): void {
    for (const listener of this.opens) listener();
  }
}

let box: FakeLink;
const linkOf = (): Link => box;
const job = (workspaceId: string): TodayWorkspace => ({ environmentId: "box", workspaceId, sector: "purdue", name: workspaceId, path: `/w/${workspaceId}`, open: true });
const envOf = (workspaces: TodayWorkspace[]): TodayEnv => ({ day: { from: 0, to: 86_400_000 }, workspaces, lifeos: { environmentId: "", sector: null, client: null, state: "off" }, workspaceOf: () => null });
const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));

beforeEach(() => {
  box = new FakeLink("box");
  forgetEach();
});
afterEach(() => {
  forgetEach();
  vi.useRealTimers();
});

describe("one read a method, shared by the page and the keeper", () => {
  const JOBS = [job("a"), job("b"), job("c")];
  const ENV = envOf(JOBS);
  const use = (env: TodayEnv) => useEachWorkspace<{ n: number }>(env, "work.money.owed", (w) => ({ workspaceId: w.workspaceId }), { push: "work.money", linkOf });

  it("opening and closing Today while the keeper runs asks nothing", async () => {
    const env = envOf(JOBS);
    const keeper = renderHook(() => use(env));
    await settle();
    expect(box.asked).toHaveLength(3);
    // The page opens: it reads what the keeper holds, in its first frame.
    const pageEnv = envOf([...JOBS]);
    const page = renderHook(() => use(pageEnv));
    expect(page.result.current.answers).toHaveLength(3);
    await settle();
    // The keeper stops while the page is open, and starts again when it closes: the page's own `pageOpen`.
    keeper.unmount();
    page.unmount();
    const againEnv = envOf([...JOBS]);
    const again = renderHook(() => use(againEnv));
    await settle();
    expect(box.asked).toHaveLength(3);
    again.unmount();
  });

  it("with no reader, a push marks the job it names, and the next reader asks that one alone", async () => {
    const first = renderHook(() => use(ENV));
    await settle();
    first.unmount();
    box.push({ push: "work.money", workspaceId: "b" });
    expect(box.asked).toHaveLength(3);
    const next = renderHook(() => use(ENV));
    await settle();
    expect(box.asked.slice(3).map((a) => a.params)).toEqual([{ workspaceId: "b" }]);
    next.unmount();
  });

  it("with a reader, a push asks at once", async () => {
    const reader = renderHook(() => use(ENV));
    await settle();
    box.push({ push: "work.money", workspaceId: "c" });
    expect(box.asked.slice(3).map((a) => a.params)).toEqual([{ workspaceId: "c" }]);
    reader.unmount();
  });

  it("a read with no push of its own is asked again once its answers are older than 30 s", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const quiet = (env: TodayEnv) => useEachWorkspace<{ n: number }>(env, "work.files.changed", (w) => ({ workspaceId: w.workspaceId }), { linkOf });
    const first = renderHook(() => quiet(ENV));
    await settle();
    first.unmount();
    vi.setSystemTime(Date.now() + FRESH_MS - 1_000);
    const soon = renderHook(() => quiet(ENV));
    await settle();
    expect(box.asked).toHaveLength(3);
    soon.unmount();
    vi.setSystemTime(Date.now() + FRESH_MS + 1_000);
    const later = renderHook(() => quiet(ENV));
    await settle();
    expect(box.asked).toHaveLength(6);
    later.unmount();
  });

  it("a reopened link with no reader marks its host's jobs for the next reader", async () => {
    const first = renderHook(() => use(ENV));
    await settle();
    first.unmount();
    box.open();
    const next = renderHook(() => use(ENV));
    await settle();
    expect(box.asked).toHaveLength(6);
    next.unmount();
  });
});

describe("prep's marks", () => {
  it("six workspaces on one host ask work.prep.upcoming exactly once", async () => {
    const { registry } = await import("../../lib/connection");
    vi.spyOn(registry, "linkOf").mockReturnValue(box as never);
    const six = ["a", "b", "c", "d", "e", "f"].map(job);
    const env = envOf(six);
    const { unmount } = renderHook(() => prep.use(env));
    await settle();
    expect(box.asked.filter((a) => a.method === "work.prep.upcoming")).toHaveLength(1);
    unmount();
    vi.restoreAllMocks();
  });
});
