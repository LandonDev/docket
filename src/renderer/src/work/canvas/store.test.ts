import { beforeEach, describe, expect, it, vi } from "vitest";
import { canvasItem, fakeHost } from "./testkit";

/** The renderer's copy of a thread's canvas items: what it does to the list before the host answers, and when the host says no. */

const host = vi.hoisted(() => ({ current: null as ReturnType<typeof import("./testkit").fakeHost> | null, pushes: new Set<(push: never) => void>(), opens: new Set<() => void>() }));
vi.mock("../../lib/connection", () => {
  const link = {
    environmentId: "local",
    request: (method: string, params?: Record<string, unknown>) => host.current!.link.request(method, params),
    onPush: (listener: (push: never) => void) => (host.pushes.add(listener), () => host.pushes.delete(listener)),
    onOpen: (listener: () => void) => (host.opens.add(listener), () => host.opens.delete(listener)),
  };
  return { registry: { linkOf: () => link, onLink: (listener: (l: typeof link, event: string) => void) => (listener(link, "added"), () => undefined) } };
});

import { canvasOf, closeItem, keepState, keptState, loadCanvas, openItem, reorderItems, resetCanvasStore, selectedAfter, selectItem, setFolded } from "./store";

const A = canvasItem("a");
const B = canvasItem("b");
const C = canvasItem("c");
const ids = (): string[] => canvasOf("t1").items.map((item) => item.id);

beforeEach(() => {
  // What a window keeps across launches: a plain store stands in for it here.
  const kept = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (key: string) => kept.get(key) ?? null, setItem: (key: string, value: string) => void kept.set(key, value) });
  resetCanvasStore();
});

async function loaded(items = [A, B, C]) {
  host.current = fakeHost(items, host as never);
  await loadCanvas("local", "t1");
  return host.current;
}

describe("the tab to show after the list changed", () => {
  it("keeps the shown tab while it is open, else takes its neighbour, the next one first", () => {
    expect(selectedAfter([A, B, C], [A, B, C], "b")).toBe("b");
    expect(selectedAfter([A, B, C], [A, C], "b")).toBe("c");
    expect(selectedAfter([A, B, C], [A, B], "c")).toBe("b");
    expect(selectedAfter([A, B, C], [], "b")).toBeNull();
    expect(selectedAfter([], [A, B], null)).toBe("a");
    // A remembered tab that the host no longer has open gives way to the first.
    expect(selectedAfter([], [A, B], "gone")).toBe("a");
  });
});

describe("a thread's canvas in the window", () => {
  it("lists what the host has open and shows the first", async () => {
    await loaded();
    expect(canvasOf("t1")).toMatchObject({ loaded: true, selected: "a", folded: false });
    expect(ids()).toEqual(["a", "b", "c"]);
  });

  it("a host that does not answer reads as no items, and the thread still shows", async () => {
    host.current = fakeHost([], host as never);
    host.current.link.request = async () => {
      throw new Error("Work is off on this host");
    };
    await loadCanvas("local", "t1");
    expect(canvasOf("t1")).toMatchObject({ loaded: true, items: [] });
  });

  it("closes a tab at once and shows its neighbour; a host that refuses puts it back", async () => {
    const h = await loaded();
    selectItem("t1", "b");
    await closeItem("local", "t1", "b");
    expect(ids()).toEqual(["a", "c"]);
    expect(canvasOf("t1").selected).toBe("c");

    const request = h.link.request;
    h.link.request = async (method, params) => {
      if (method === "work.canvas.close") throw new Error("no canvas item c");
      return request(method, params);
    };
    await expect(closeItem("local", "t1", "c")).rejects.toThrow("no canvas item c");
    expect(ids()).toEqual(["a", "c"]);
  });

  it("reorders at once and keeps the order the host answers", async () => {
    const h = await loaded();
    const moved = reorderItems("local", "t1", ["c", "a"]);
    // Before the host answers: the listed ids first, the rest after.
    expect(ids()).toEqual(["c", "a", "b"]);
    await moved;
    expect(ids()).toEqual(["c", "a", "b"]);
    expect(h.calls.at(-1)).toEqual({ method: "work.canvas.reorder", params: { sessionId: "t1", order: ["c", "a"] } });
  });

  it("a reorder the host refuses goes back to the host's order", async () => {
    const h = await loaded();
    const request = h.link.request;
    h.link.request = async (method, params) => {
      if (method === "work.canvas.reorder") throw new Error("unknown thread: t1");
      return request(method, params);
    };
    await expect(reorderItems("local", "t1", ["c", "b", "a"])).rejects.toThrow("unknown thread: t1");
    expect(ids()).toEqual(["a", "b", "c"]);
  });

  it("keeps a kind's view state for a tab whose close the host refused", async () => {
    const h = await loaded();
    keepState("b", { zoom: 2 });
    const request = h.link.request;
    h.link.request = async (method, params) => {
      if (method === "work.canvas.close") throw new Error("no");
      return request(method, params);
    };
    await expect(closeItem("local", "t1", "b")).rejects.toThrow("no");
    expect(ids()).toEqual(["a", "b", "c"]);
    expect(keptState("b")).toEqual({ zoom: 2 });
  });

  it("shows an item it opened without waiting for the push", async () => {
    await loaded([A]);
    const made = await openItem("local", "t1", { kind: "pdf", source: { at: "thread" }, title: "Contract" });
    expect(ids()).toEqual(["a", made.id]);
    expect(canvasOf("t1").selected).toBe(made.id);
  });

  it("follows the host's push, and asks again when its socket comes back", async () => {
    const h = await loaded([A]);
    h.push([A, B], "b");
    expect(canvasOf("t1")).toMatchObject({ selected: "b" });
    expect(ids()).toEqual(["a", "b"]);
    // Nothing is on screen for the thread (no hook subscribed), so a reconnect asks for nothing.
    const before = h.calls.length;
    h.reopen();
    expect(h.calls.length).toBe(before);
  });

  it("remembers the shown tab and the fold across a restart, and forgets a fold with nothing left to fold", async () => {
    await loaded();
    selectItem("t1", "c");
    setFolded("t1", true);
    resetCanvasStore();
    await loaded();
    expect(canvasOf("t1")).toMatchObject({ selected: "c", folded: true });
    host.current!.push([]);
    expect(canvasOf("t1")).toMatchObject({ selected: null, folded: false });
    // The fold cannot be set with no item to show.
    setFolded("t1", true);
    expect(canvasOf("t1").folded).toBe(false);
  });

  it("keeps a kind's view state while the item is open, and drops it when the item closes", async () => {
    await loaded();
    keepState("b", { zoom: 2 });
    expect(keptState("b")).toEqual({ zoom: 2 });
    await closeItem("local", "t1", "b");
    expect(keptState("b")).toBeUndefined();
  });
});
