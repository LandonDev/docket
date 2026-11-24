import { describe, expect, it } from "vitest";
import { CATCH_UP_BYTES_PER_SEC, CatchUpLane } from "./catchUp";

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

function harness(shown: string | null = null) {
  const state = { shown, bytes: 0, now: 0 };
  const sleeps: number[] = [];
  const naps: (() => void)[] = [];
  const lane = new CatchUpLane({
    shown: () => state.shown,
    bytesIn: () => state.bytes,
    now: () => state.now,
    sleep: (ms) => {
      sleeps.push(ms);
      return new Promise<void>((resolve) => naps.push(resolve));
    },
  });
  const started: string[] = [];
  const answers = new Map<string, { resolve: () => void; reject: (e: Error) => void }>();
  const fetch = (id: string) => (): Promise<void> => {
    started.push(id);
    return new Promise<void>((resolve, reject) => answers.set(id, { resolve, reject }));
  };
  /** The fetch for `id` took `bytes`; the lane's pause after it ends. */
  const answer = async (id: string, bytes = 0): Promise<void> => {
    state.bytes += bytes;
    answers.get(id)!.resolve();
    await flush();
    naps.shift()?.();
    await flush();
  };
  const wake = async (): Promise<void> => {
    naps.shift()?.();
    await flush();
  };
  return { state, lane, started, fetch, answer, answers, sleeps, wake };
}

describe("CatchUpLane", () => {
  it("runs background transcripts one at a time, in the order asked", async () => {
    const h = harness();
    for (const id of ["a", "b", "c"]) void h.lane.run(id, h.fetch(id));
    await flush();
    expect(h.started).toEqual(["a"]);
    expect(h.lane.queued()).toEqual(["b", "c"]);
    await h.answer("a");
    expect(h.started).toEqual(["a", "b"]);
    await h.answer("b");
    expect(h.started).toEqual(["a", "b", "c"]);
  });

  it("never holds the shown thread behind the others", async () => {
    const h = harness("focused");
    for (const id of ["a", "b"]) void h.lane.run(id, h.fetch(id));
    void h.lane.run("focused", h.fetch("focused"));
    await flush();
    // The others wait while its fetch is out.
    expect(h.started).toEqual(["focused"]);
  });

  it("starts no background transcript while the shown thread's fetch is out", async () => {
    const h = harness("focused");
    void h.lane.run("focused", h.fetch("focused"));
    for (const id of ["a", "b"]) void h.lane.run(id, h.fetch(id));
    await flush();
    expect(h.started).toEqual(["focused"]);
    h.answers.get("focused")!.resolve();
    await flush();
    expect(h.started).toEqual(["focused", "a"]);
  });

  it("takes the shown thread first when the window names it after asking for it", async () => {
    const h = harness();
    for (const id of ["a", "b", "c"]) void h.lane.run(id, h.fetch(id));
    // The window's focus lands in a microtask of the same turn, after its loads.
    queueMicrotask(() => (h.state.shown = "c"));
    await flush();
    expect(h.started).toEqual(["c"]);
    await h.answer("c");
    expect(h.started).toEqual(["c", "a"]);
  });

  it("starts a waiting transcript at once when it becomes the shown one", async () => {
    const h = harness();
    for (const id of ["a", "b", "c"]) void h.lane.run(id, h.fetch(id));
    await flush();
    h.state.shown = "c";
    h.lane.promote("c");
    await flush();
    expect(h.started).toEqual(["a", "c"]);
    expect(h.lane.queued()).toEqual(["b"]);
    // The lane's own turn moves on to b once c is in, never c again.
    await h.answer("a");
    expect(h.started).toEqual(["a", "c"]);
    h.answers.get("c")!.resolve();
    await flush();
    expect(h.started).toEqual(["a", "c", "b"]);
  });

  it("pauses after a transcript in proportion to the bytes it took", async () => {
    const h = harness();
    for (const id of ["a", "b"]) void h.lane.run(id, h.fetch(id));
    await flush();
    h.state.now = 100;
    h.state.bytes += CATCH_UP_BYTES_PER_SEC;
    h.answers.get("a")!.resolve();
    await flush();
    // A second's worth of the budget, less the 100 ms the fetch itself took.
    expect(h.sleeps).toEqual([900]);
    expect(h.started).toEqual(["a"]);
  });

  it("yields between two transcripts even when they took nothing", async () => {
    const h = harness();
    for (const id of ["a", "b"]) void h.lane.run(id, h.fetch(id));
    await flush();
    h.answers.get("a")!.resolve();
    await flush();
    expect(h.sleeps).toEqual([0]);
    expect(h.started).toEqual(["a"]);
  });

  it("a failed fetch rejects its caller and the lane goes on", async () => {
    const h = harness();
    const a = h.lane.run("a", h.fetch("a"));
    void h.lane.run("b", h.fetch("b"));
    await flush();
    h.answers.get("a")!.reject(new Error("connection closed"));
    await expect(a).rejects.toThrow("connection closed");
    await flush();
    await h.wake();
    expect(h.started).toEqual(["a", "b"]);
    expect(h.lane.queued()).toEqual([]);
  });
});
