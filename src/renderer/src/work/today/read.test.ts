import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Link } from "../../lib/connection";
import type { ServerPush } from "../../lib/tcserver/types";
import { EACH_TIMEOUT_MS, eachWorkspace, forgetEach } from "./read";
import type { TodayWorkspace } from "./types";

type Asked = { method: string; params: unknown; resolve(value: unknown): void; reject(err: unknown): void };

/** A host's link the test answers by hand. */
class FakeLink implements Link {
  profile = "local" as const;
  connected = true;
  asked: Asked[] = [];
  private pushes = new Set<(push: ServerPush) => void>();
  private opens = new Set<() => void>();
  constructor(readonly environmentId: string) {}
  request<T>(method: string, params?: unknown): Promise<T> {
    return new Promise<T>((resolve, reject) => this.asked.push({ method, params, resolve: resolve as (value: unknown) => void, reject }));
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
  get listening(): number {
    return this.pushes.size + this.opens.size;
  }
}

const job = (environmentId: string, workspaceId: string, open = true): TodayWorkspace => ({ environmentId, workspaceId, sector: "purdue", name: workspaceId, path: `/w/${workspaceId}`, open });
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

describe("eachWorkspace", () => {
  let box: FakeLink;
  let mac: FakeLink;
  const linkOf = (id: string): Link => (id === "box" ? box : mac);
  const paramsOf = (w: TodayWorkspace) => ({ workspaceId: w.workspaceId });
  beforeEach(() => {
    vi.useFakeTimers();
    box = new FakeLink("box");
    mac = new FakeLink("mac");
    forgetEach();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("asks each job on its own and answers what has come back so far", async () => {
    const read = eachWorkspace<{ n: number }>("work.files.changed", { linkOf });
    read.set([job("box", "w1"), job("box", "w2"), job("mac", "w3")], paramsOf);
    expect(box.asked.map((a) => [a.method, a.params])).toEqual([
      ["work.files.changed", { workspaceId: "w1" }],
      ["work.files.changed", { workspaceId: "w2" }],
    ]);
    expect(mac.asked).toHaveLength(1);
    expect(read.snapshot()).toMatchObject({ answers: [], loading: true, failed: [] });
    // The Mac answers first: its rows show while the box is still out.
    mac.asked[0]!.resolve({ n: 3 });
    await flush();
    expect(read.snapshot().answers.map((a) => [a.workspace.workspaceId, a.value])).toEqual([["w3", { n: 3 }]]);
    expect(read.snapshot().loading).toBe(true);
    box.asked[1]!.resolve({ n: 2 });
    box.asked[0]!.resolve({ n: 1 });
    await flush();
    // In the jobs' order, whatever order they answered in.
    expect(read.snapshot().answers.map((a) => a.workspace.workspaceId)).toEqual(["w1", "w2", "w3"]);
    expect(read.snapshot().loading).toBe(false);
  });

  it("ends a call at six seconds: the host is named as failed, and holds up no other", async () => {
    const read = eachWorkspace<{ n: number }>("work.files.changed", { linkOf });
    read.set([job("box", "w1"), job("mac", "w3")], paramsOf);
    box.asked[0]!.resolve({ n: 1 });
    await flush();
    await vi.advanceTimersByTimeAsync(EACH_TIMEOUT_MS - 1);
    expect(read.snapshot().failed).toEqual([]);
    expect(read.snapshot().loading).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    const after = read.snapshot();
    expect(after.loading).toBe(false);
    expect(after.failed.map((f) => [f.environmentId, f.error])).toEqual([["mac", "It did not answer in time"]]);
    expect(after.answers.map((a) => a.workspace.workspaceId)).toEqual(["w1"]);
    // Its Retry asks that host alone, and a late first answer is dropped for the new one.
    after.failed[0]!.retry?.();
    expect(mac.asked).toHaveLength(2);
    expect(box.asked).toHaveLength(1);
    expect(read.snapshot().failed).toEqual([]);
    mac.asked[0]!.resolve({ n: 99 });
    mac.asked[1]!.resolve({ n: 4 });
    await flush();
    expect(read.snapshot().answers.find((a) => a.workspace.workspaceId === "w3")?.value).toEqual({ n: 4 });
    expect(read.snapshot().failed).toEqual([]);
  });

  it("is loading before it is handed its jobs: nothing asked is not nothing there", () => {
    const read = eachWorkspace("work.files.changed", { linkOf });
    expect(read.snapshot()).toMatchObject({ answers: [], loading: true, failed: [] });
    read.set([], paramsOf);
    expect(read.snapshot().loading).toBe(false);
  });

  it("a failed read asked again by Retry is out again: loading until it answers, so the page is not clear meanwhile", async () => {
    const read = eachWorkspace<{ n: number }>("work.money.owed", { linkOf });
    read.set([job("box", "w1")], paramsOf);
    box.asked[0]!.reject(new Error("refused"));
    await flush();
    expect(read.snapshot()).toMatchObject({ loading: false, failed: [{ environmentId: "box" }] });
    read.snapshot().failed[0]!.retry?.();
    expect(read.snapshot()).toMatchObject({ loading: true, failed: [] });
    box.asked[1]!.resolve({ n: 1 });
    await flush();
    expect(read.snapshot()).toMatchObject({ loading: false, failed: [] });
  });

  it("asks every job again when told what it asks for moved (the day turned), dropping a late answer to the last ask", async () => {
    let day = "mon";
    const read = eachWorkspace<{ day: string }>("work.prep.upcoming", { linkOf });
    read.set([job("box", "w1")], () => ({ day }));
    day = "tue";
    read.again();
    expect(box.asked.map((a) => a.params)).toEqual([{ day: "mon" }, { day: "tue" }]);
    // The new day's answer comes first; the old ask's, late, is dropped.
    box.asked[1]!.resolve({ day: "tue" });
    await flush();
    box.asked[0]!.resolve({ day: "mon" });
    await flush();
    expect(read.snapshot().answers.map((a) => a.value)).toEqual([{ day: "tue" }]);
  });

  it("a read made afresh (a reopen) starts with each job's last value: a fast job's answer drops no slow job's, and one that fails keeps its own", async () => {
    const first = eachWorkspace<{ n: number }>("work.money.owed", { linkOf });
    first.set([job("box", "w1"), job("mac", "w3")], paramsOf);
    box.asked[0]!.resolve({ n: 1 });
    mac.asked[0]!.resolve({ n: 3 });
    await flush();
    first.close();
    const again = eachWorkspace<{ n: number }>("work.money.owed", { linkOf });
    again.set([job("box", "w1"), job("mac", "w3")], paramsOf);
    // Both stand at once, read again: out, and whole.
    expect(again.snapshot()).toMatchObject({ loading: true, stale: true });
    expect(again.snapshot().answers.map((a) => a.value)).toEqual([{ n: 1 }, { n: 3 }]);
    // The Mac answers first: the box's last value still stands beside it.
    mac.asked[1]!.resolve({ n: 4 });
    await flush();
    expect(again.snapshot().answers.map((a) => a.value)).toEqual([{ n: 1 }, { n: 4 }]);
    expect(again.snapshot()).toMatchObject({ loading: true, stale: true });
    // The box runs out of time: it keeps what it had, and says it did not answer.
    await vi.advanceTimersByTimeAsync(EACH_TIMEOUT_MS);
    expect(again.snapshot().answers.map((a) => a.value)).toEqual([{ n: 1 }, { n: 4 }]);
    expect(again.snapshot()).toMatchObject({ loading: false, stale: false, failed: [{ environmentId: "box" }] });
  });

  it("forgets a job's last value once the job leaves", async () => {
    const first = eachWorkspace<{ n: number }>("work.money.owed", { linkOf });
    first.set([job("box", "w1"), job("box", "w2")], paramsOf);
    box.asked[0]!.resolve({ n: 1 });
    box.asked[1]!.resolve({ n: 2 });
    await flush();
    first.set([job("box", "w1")], paramsOf);
    first.close();
    const again = eachWorkspace<{ n: number }>("work.money.owed", { linkOf });
    again.set([job("box", "w1"), job("box", "w2")], paramsOf);
    expect(again.snapshot().answers.map((a) => a.workspace.workspaceId)).toEqual(["w1"]);
    // Not whole: w2 has nothing to show while it is out.
    expect(again.snapshot()).toMatchObject({ loading: true, stale: false });
  });

  it("names a host once however many of its jobs failed, with the host's own words", async () => {
    const read = eachWorkspace("work.files.changed", { linkOf });
    read.set([job("box", "w1"), job("box", "w2")], paramsOf);
    box.asked[0]!.reject(new Error("Work is off on this host"));
    box.asked[1]!.reject(new Error("Work is off on this host"));
    await flush();
    expect(read.snapshot().failed.map((f) => [f.environmentId, f.error])).toEqual([["box", "Work is off on this host"]]);
  });

  it("skips a host whose link is not open, and asks it once the link is", async () => {
    const read = eachWorkspace<{ n: number }>("work.files.changed", { linkOf });
    read.set([job("box", "w1"), job("mac", "w3", false)], paramsOf);
    expect(mac.asked).toHaveLength(0);
    // An offline host is neither loading nor failed here: the page names it at its foot.
    box.asked[0]!.resolve({ n: 1 });
    await flush();
    expect(read.snapshot()).toMatchObject({ loading: false, failed: [] });
    read.set([job("box", "w1"), job("mac", "w3", true)], paramsOf);
    expect(mac.asked).toHaveLength(1);
    // The box was not asked again for the Mac's return.
    expect(box.asked).toHaveLength(1);
  });

  it("asks again on its push (one job when the push names it) and when a link opens again", async () => {
    const read = eachWorkspace<{ n: number }>("work.files.changed", { linkOf, push: "work.files" });
    read.set([job("box", "w1"), job("box", "w2")], paramsOf);
    box.asked[0]!.resolve({ n: 1 });
    box.asked[1]!.resolve({ n: 2 });
    await flush();
    box.push({ push: "work.outbox" });
    expect(box.asked).toHaveLength(2);
    box.push({ push: "work.files", workspaceId: "w2" });
    expect(box.asked.slice(2).map((a) => a.params)).toEqual([{ workspaceId: "w2" }]);
    box.push({ push: "work.files" });
    expect(box.asked).toHaveLength(5);
    box.open();
    expect(box.asked).toHaveLength(7);
    // A job read again keeps its last value until the new one lands: no bones over rows he can see.
    expect(read.snapshot().answers).toHaveLength(2);
    expect(read.snapshot().loading).toBe(false);
  });

  it("a read that fails after it once answered keeps the value it had", async () => {
    const read = eachWorkspace<{ n: number }>("work.files.changed", { linkOf, push: "work.files" });
    read.set([job("box", "w1")], paramsOf);
    box.asked[0]!.resolve({ n: 1 });
    await flush();
    box.push({ push: "work.files" });
    box.asked[1]!.reject(new Error("timed out"));
    await flush();
    expect(read.snapshot().answers.map((a) => a.value)).toEqual([{ n: 1 }]);
    expect(read.snapshot().failed.map((f) => f.error)).toEqual(["timed out"]);
  });

  it("forgets a job that left, tells its listeners, and lets go of the links when closed", async () => {
    const read = eachWorkspace<{ n: number }>("work.files.changed", { linkOf, push: "work.files" });
    const heard = vi.fn();
    read.subscribe(heard);
    read.set([job("box", "w1"), job("mac", "w3")], paramsOf);
    box.asked[0]!.resolve({ n: 1 });
    mac.asked[0]!.resolve({ n: 3 });
    await flush();
    expect(heard).toHaveBeenCalled();
    read.set([job("box", "w1")], paramsOf);
    expect(read.snapshot().answers.map((a) => a.workspace.workspaceId)).toEqual(["w1"]);
    expect(mac.listening).toBe(0);
    read.close();
    expect(box.listening).toBe(0);
    box.push({ push: "work.files" });
    expect(box.asked).toHaveLength(1);
    // A later set starts it again (a remount under StrictMode).
    read.set([job("box", "w1")], paramsOf);
    expect(box.asked).toHaveLength(2);
  });

  it("the same snapshot object until something changes", async () => {
    const read = eachWorkspace("work.files.changed", { linkOf });
    read.set([job("box", "w1")], paramsOf);
    const first = read.snapshot();
    expect(read.snapshot()).toBe(first);
    box.asked[0]!.resolve({});
    await flush();
    expect(read.snapshot()).not.toBe(first);
  });
});
