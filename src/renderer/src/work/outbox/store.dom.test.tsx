// @vitest-environment jsdom
/**
 * The Outbox store stops asking for what it holds (the perf pass's M2): a push patches the count and, while a reader
 * shows the lists, makes one read for every push within 500 ms; only the Outbox page reads what was decided, the grants
 * and the offers; a mount reads only what is stale; a reconnect reads once more; a row keeps its object while its
 * `updatedAt` stands; a detail is one ask. Every assertion counts requests or notifies.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { OutboxItem } from "@shared/contract-work-outbox";

type Call = { env: string; method: string; params: Record<string, unknown> };
const world = vi.hoisted(() => ({
  calls: [] as Call[],
  items: [] as OutboxItem[],
  pushes: [] as ((push: unknown) => void)[],
  opens: [] as (() => void)[],
  withResults: true,
}));

vi.mock("../../lib/connection", async (original) => {
  const link = {
    environmentId: "box",
    connected: true,
    onPush: (fn: (push: unknown) => void) => (world.pushes.push(fn), () => undefined),
    onOpen: (fn: () => void) => (world.opens.push(fn), () => undefined),
    onClose: () => () => undefined,
    request: async (method: string, params: Record<string, unknown> = {}) => {
      world.calls.push({ env: "box", method, params });
      const waiting = world.items.filter((i) => i.state === "held");
      switch (method) {
        case "work.outbox.list":
          return params.show === "done" ? { items: world.items.filter((i) => i.state === "sent") } : { items: waiting, waiting: waiting.length };
        case "work.outbox.grants":
          return { grants: [] };
        case "work.outbox.offers":
          return { offers: [] };
        case "work.outbox.results":
          return { results: [{ id: "r-alone" }] };
        case "work.outbox.get": {
          const item = world.items.find((i) => i.ref.id === (params.ref as { id: string }).id)!;
          return params.results && world.withResults ? { ...item, results: [{ id: "r1", sessionId: item.sessionId }] } : item;
        }
      }
      throw new Error(`unknown ${method}`);
    },
  };
  return {
    ...(await original<typeof import("../../lib/connection")>()),
    registry: { linkOf: () => link, onLink: (listener: (l: typeof link, event: string) => void) => (listener(link, "added"), () => undefined) },
  };
});

const { setWorkOn, useOutboxWaiting, workSwitch } = await import("../../lib/workSwitch");
const store = await import("./store");
const { useResults, resetResults } = await import("./results");

const item = (id: string, over: Partial<OutboxItem> = {}): OutboxItem =>
  ({ ref: { at: "host", id }, kind: "chat.reply", state: "held", summary: id, verb: "Send", workspaceId: "ws", sector: "purdue", payload: {}, createdAt: 1, updatedAt: 1, ...over }) as unknown as OutboxItem;
const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));
const methods = () => world.calls.map((c) => (c.method === "work.outbox.list" ? `list:${c.params.show}` : c.method));

beforeEach(async () => {
  world.calls = [];
  world.items = [item("a"), item("b"), item("c")];
  world.withResults = true;
  workSwitch.reset();
  store.resetOutboxStore();
  resetResults();
  setWorkOn("box", true);
  await settle();
  world.calls = [];
});
afterEach(() => {
  // The hold: nothing the store reads on its own ever presses.
  expect(world.calls.filter((c) => /\.(send|discard|edit|grant|takeOffer|decide)$/.test(c.method))).toEqual([]);
  vi.useRealTimers();
});

/** A reader of what waits, as Today's held source and Messages are; counts the store's notifies. */
function waitingReader() {
  let notifies = 0;
  const hook = renderHook(() => {
    notifies++;
    return store.useOutbox();
  });
  return { hook, notifies: () => notifies };
}

describe("a push", () => {
  it("with Today open asks once and notifies once, for every push within 500 ms", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const reader = waitingReader();
    const before = reader.notifies();
    world.items[1] = item("b", { updatedAt: 2, summary: "b again" });
    act(() => {
      for (const push of world.pushes) push({ push: "work.outbox", waiting: 3, failed: 0 });
      for (const push of world.pushes) push({ push: "work.outbox", waiting: 3, failed: 0 });
    });
    expect(world.calls).toEqual([]);
    await act(async () => void (await vi.advanceTimersByTimeAsync(500)));
    expect(methods()).toEqual(["list:waiting"]);
    expect(reader.notifies() - before).toBe(1);
    reader.hook.unmount();
  });

  it("with no reader patches the count and asks nothing", async () => {
    const count = renderHook(() => useOutboxWaiting());
    act(() => {
      for (const push of world.pushes) push({ push: "work.outbox", waiting: 7, failed: 1 });
    });
    await settle();
    expect(world.calls).toEqual([]);
    expect(count.result.current).toBe(7);
    count.unmount();
  });

  it("keeps a row's object while its updatedAt stands: only the changed one is new", async () => {
    const reader = waitingReader();
    const was = reader.hook.result.current.waiting;
    world.items[1] = item("b", { updatedAt: 2 });
    await act(() => store.loadHost("box"));
    const now = reader.hook.result.current.waiting;
    expect(now.map((row, i) => row === was[i])).toEqual([true, false, true]);
    reader.hook.unmount();
  });
});

describe("what each reader reads", () => {
  it("Today's mount reads what waits alone, and only when it is stale", async () => {
    // The boot read is fresh: a mount within 30 s asks nothing.
    await act(() => store.loadOutbox({ ifStale: true }));
    expect(world.calls).toEqual([]);
    // A push while none read marks it stale: the next mount reads what waits, and nothing of the page's.
    for (const push of world.pushes) push({ push: "work.outbox", waiting: 3, failed: 0 });
    await act(() => store.loadOutbox({ ifStale: true }));
    expect(methods()).toEqual(["list:waiting"]);
  });

  it("the Outbox page reads Done, the grants and the offers too; opened again 1 s later it asks nothing", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const page = renderHook(() => store.useOutboxPage());
    await settle();
    expect(methods().sort()).toEqual(["list:done", "list:waiting", "work.outbox.grants", "work.outbox.offers"]);
    page.unmount();
    world.calls = [];
    vi.setSystemTime(Date.now() + 1_000);
    const again = renderHook(() => store.useOutboxPage());
    await settle();
    expect(world.calls).toEqual([]);
    again.unmount();
  });

  it("a reconnect reads once more, though the store is fresh", async () => {
    for (const open of world.opens) open();
    await settle();
    expect(methods()).toEqual(["list:waiting"]);
  });
});

describe("a detail", () => {
  it("is one ask: a sent act's whole read carries its Results, shared by every part that needs it", async () => {
    world.items = [item("s", { kind: "computer.act", state: "sent", decidedAt: 5, sessionId: "t1" } as Partial<OutboxItem>)];
    const shown = { ...world.items[0]!, environmentId: "box" } as store.HostItem;
    const results = renderHook(() => useResults("box", "t1", false));
    store.readDetailResults(shown);
    void store.fetchDetail(shown);
    await settle();
    expect(methods()).toEqual(["work.outbox.get"]);
    expect(world.calls[0]!.params).toMatchObject({ results: true });
    expect(results.result.current.rows.map((r) => r.id)).toEqual(["r1"]);
    results.unmount();
  });

  it("from a host whose answer carries no Results, asks for them on their own", async () => {
    world.withResults = false;
    world.items = [item("s", { state: "sent", decidedAt: 5, sessionId: "t2" } as Partial<OutboxItem>)];
    store.readDetailResults({ ...world.items[0]!, environmentId: "box" } as store.HostItem);
    await settle();
    expect(methods()).toEqual(["work.outbox.get", "work.outbox.results"]);
  });
});
