import { beforeEach, describe, expect, it, vi } from "vitest";

const KEY = "docket.tc.lastSeen";
const OLD_KEY = "thread-last-seen";
const FLOOR_KEY = "docket.tc.seenFloor";

function mockLocalStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => void data.set(key, value),
      removeItem: (key: string) => void data.delete(key),
      clear: () => data.clear(),
      key: (index: number) => [...data.keys()][index] ?? null,
      get length() {
        return data.size;
      },
    },
  });
  return data;
}

async function load() {
  vi.resetModules();
  return import("./sessionSeen");
}

describe("sessionSeen", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("reads an empty map when nothing is stored or the value is junk", async () => {
    mockLocalStorage({ [KEY]: "not json" });
    const mod = await load();
    expect(mod.loadLastSeen()).toEqual({});
  });

  it("keeps only finite numbers", async () => {
    mockLocalStorage({ [KEY]: JSON.stringify({ a: 5, b: "x", c: null }) });
    const mod = await load();
    expect(mod.loadLastSeen()).toEqual({ a: 5 });
  });

  it("marks a session seen, persists it, and keeps the newest time", async () => {
    const data = mockLocalStorage();
    const mod = await load();
    mod.markSessionSeen("s1", 100);
    mod.markSessionSeen("s1", 50);
    expect(mod.loadLastSeen()).toEqual({ s1: 100 });
    mod.flushLastSeen();
    expect(JSON.parse(data.get(KEY) ?? "{}")).toEqual({ s1: 100 });
  });

  it("marks many sessions seen in one write and keeps newer stamps", async () => {
    const data = mockLocalStorage();
    const mod = await load();
    mod.markSessionSeen("s1", 100);
    const listener = vi.fn();
    mod.subscribeLastSeen(listener);
    mod.markSessionsSeen(["s1", "s2", "s3", ""], 80);
    expect(mod.loadLastSeen()).toEqual({ s1: 100, s2: 80, s3: 80 });
    expect(JSON.parse(data.get(KEY) ?? "{}")).toEqual({ s1: 100, s2: 80, s3: 80 });
    expect(listener).toHaveBeenCalledTimes(1);
    const before = mod.loadLastSeen();
    mod.markSessionsSeen(["s1"], 50);
    expect(mod.loadLastSeen()).toBe(before);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("returns the same snapshot until a write and notifies subscribers", async () => {
    mockLocalStorage();
    const mod = await load();
    const listener = vi.fn();
    const off = mod.subscribeLastSeen(listener);
    const before = mod.loadLastSeen();
    expect(mod.loadLastSeen()).toBe(before);
    mod.markSessionSeen("s2", 7);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(mod.loadLastSeen()).not.toBe(before);
    off();
    mod.markSessionSeen("s3", 8);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("prunes ids the server no longer knows, once, and notifies", async () => {
    const data = mockLocalStorage({ [KEY]: JSON.stringify({ keep: 5, gone: 6 }) });
    const mod = await load();
    const listener = vi.fn();
    mod.subscribeLastSeen(listener);
    const before = mod.loadLastSeen();
    mod.pruneLastSeen(new Set(["keep", "other"]));
    expect(mod.loadLastSeen()).toEqual({ keep: 5 });
    expect(mod.loadLastSeen()).not.toBe(before);
    expect(JSON.parse(data.get(KEY) ?? "{}")).toEqual({ keep: 5 });
    expect(listener).toHaveBeenCalledTimes(1);
    // Nothing to drop: no write, no notification.
    const stable = mod.loadLastSeen();
    mod.pruneLastSeen(new Set(["keep"]));
    expect(mod.loadLastSeen()).toBe(stable);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("adopts the old renderer's map when the new key is empty", async () => {
    const data = mockLocalStorage({ [OLD_KEY]: JSON.stringify({ a: 5, b: "x" }) });
    const mod = await load();
    expect(mod.loadLastSeen()).toEqual({ a: 5 });
    expect(JSON.parse(data.get(KEY) ?? "{}")).toEqual({ a: 5 });
    expect(data.get(OLD_KEY)).toBeDefined();
  });

  it("leaves a populated new map alone", async () => {
    const data = mockLocalStorage({
      [KEY]: JSON.stringify({ n: 9 }),
      [OLD_KEY]: JSON.stringify({ a: 5 }),
    });
    const mod = await load();
    expect(mod.loadLastSeen()).toEqual({ n: 9 });
    expect(JSON.parse(data.get(KEY) ?? "{}")).toEqual({ n: 9 });
  });

  it("ignores a junk old value but still stamps the floor", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1234);
    const data = mockLocalStorage({ [OLD_KEY]: "not json" });
    const mod = await load();
    expect(mod.loadLastSeen()).toEqual({});
    expect(mod.seenFloor()).toBe(1234);
    expect(data.get(FLOOR_KEY)).toBe("1234");
    expect(data.has(KEY)).toBe(false);
  });

  it("writes the floor once and keeps it across reloads", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1000);
    mockLocalStorage();
    expect((await load()).seenFloor()).toBe(1000);
    now.mockReturnValue(2000);
    expect((await load()).seenFloor()).toBe(1000);
  });

  it("survives a storage that throws", async () => {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: () => {
          throw new Error("denied");
        },
        setItem: () => {
          throw new Error("denied");
        },
      },
    });
    const mod = await load();
    expect(mod.loadLastSeen()).toEqual({});
    expect(() => mod.markSessionSeen("s1", 1)).not.toThrow();
    expect(mod.loadLastSeen()).toEqual({ s1: 1 });
    expect(mod.seenFloor()).toBe(0);
  });
});

describe("sessionSeen with the hosts' marks", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("lays the hosts' marks over the window's map, and sends Mark all read to them", async () => {
    mockLocalStorage({ [KEY]: JSON.stringify({ a: 10, b: 10 }), [FLOOR_KEY]: "5" });
    const mod = await load();
    let marks: Record<string, number> = { a: 0 };
    const subs = new Set<() => void>();
    const sent: [string[], number][] = [];
    const off = mod.installHostMarks({
      marks: () => marks,
      subscribe: (l) => (subs.add(l), () => subs.delete(l)),
      read: (ids, at) => void sent.push([[...ids], at]),
    });
    // The host's mark wins for its thread (marked unread there), the window's for the rest.
    expect(mod.loadLastSeen()).toEqual({ a: 0, b: 10 });
    expect(mod.loadLastSeen()).toBe(mod.loadLastSeen());
    marks = { a: 20 };
    for (const l of subs) l();
    expect(mod.loadLastSeen()).toEqual({ a: 20, b: 10 });

    mod.markSessionsSeen(["a", "c"], 30);
    mod.markAllSeen(["b"], 40);
    expect(sent).toEqual([[["a", "c"], 30], [["b"], 40]]);
    // A single tab's own mark stays the window's: the host hears the person through readMarks.
    mod.markSessionSeen("d", 50);
    expect(sent).toHaveLength(2);

    off();
    expect(mod.loadLastSeen()).toEqual({ a: 30, b: 40, c: 30, d: 50 });
  });
});

/** The old code's reader (before the write moved off the switch's path):
 *  what an older app on the same userData does with the key. */
function oldRead(raw: string | null): Record<string, number> {
  const parsed = JSON.parse(raw ?? "{}") as Record<string, unknown>;
  const out: Record<string, number> = {};
  for (const [id, at] of Object.entries(parsed)) if (typeof at === "number" && Number.isFinite(at)) out[id] = at;
  return out;
}

describe("sessionSeen on a switch", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
  });

  it("writes localStorage 0 times on the switch's path and once after, in the old key and form", async () => {
    const data = mockLocalStorage({ [KEY]: JSON.stringify({ a: 10, b: 10 }), [FLOOR_KEY]: "5" });
    const writes: string[] = [];
    const setItem = globalThis.localStorage.setItem;
    globalThis.localStorage.setItem = (key: string, value: string) => {
      writes.push(key);
      setItem(key, value);
    };
    const mod = await load();
    mod.loadLastSeen();
    // The switch: the thread leaving, then the one arriving.
    mod.markSessionSeen("a", 20);
    mod.markSessionSeen("b", 30);
    expect(mod.loadLastSeen()).toEqual({ a: 20, b: 30 });
    expect(writes).toEqual([]);
    vi.advanceTimersByTime(mod.SAVE_MS - 1);
    expect(writes).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(writes).toEqual([KEY]);
    expect(oldRead(data.get(KEY) ?? null)).toEqual({ a: 20, b: 30 });
    vi.advanceTimersByTime(10_000);
    expect(writes).toEqual([KEY]);
    vi.useRealTimers();
  });

  it("keeps a mark not yet written over another window's write, and writes both", async () => {
    const data = mockLocalStorage({ [KEY]: JSON.stringify({ a: 10 }), [FLOOR_KEY]: "5" });
    const target = new EventTarget();
    Object.defineProperty(globalThis, "window", { configurable: true, value: target });
    const mod = await load();
    const off = mod.subscribeLastSeen(() => undefined);
    mod.markSessionSeen("a", 20);
    // Another window wrote its own mark meanwhile.
    data.set(KEY, JSON.stringify({ a: 10, z: 99 }));
    target.dispatchEvent(Object.assign(new Event("storage"), { key: KEY }));
    expect(mod.loadLastSeen()).toEqual({ a: 20, z: 99 });
    // The page going away writes what is held at once.
    target.dispatchEvent(new Event("pagehide"));
    expect(oldRead(data.get(KEY) ?? null)).toEqual({ a: 20, z: 99 });
    off();
    Reflect.deleteProperty(globalThis, "window");
    vi.useRealTimers();
  });

  it("a switch between two read threads tells no reader; a switch to an unread one does", async () => {
    mockLocalStorage({ [KEY]: JSON.stringify({ a: 100, b: 200 }), [FLOOR_KEY]: "5" });
    const mod = await load();
    const { createReadMarks } = await import("./readMarks");
    const metas = new Map([
      ["a", { id: "a", updatedAt: 100, readAt: 100 }],
      ["b", { id: "b", updatedAt: 200, readAt: 200 }],
      ["c", { id: "c", updatedAt: 300, readAt: 250 }],
    ]);
    let shown: string | null = "a";
    const focus = new Set<() => void>();
    const marks = createReadMarks({
      metas: () => [...metas.values()],
      metaOf: (id) => metas.get(id) ?? null,
      environmentOf: () => "local",
      onMetaChange: () => () => undefined,
      linkOf: () => undefined,
      attended: () => shown,
      shown: () => shown,
      onFocusChange: (l) => (focus.add(l), () => focus.delete(l)),
    });
    mod.installHostMarks(marks);
    // Every reader (the rail's workspace marks, the Dock badge, the menu) hangs off this.
    const readers = vi.fn();
    mod.subscribeLastSeen(readers);
    const before = mod.loadLastSeen();
    const switchTo = (id: string) => {
      shown = id;
      for (const l of focus) l();
      // stores/subscriptions.ts `syncFocus`: the leaving thread, then the arriving one.
      for (const meta of metas.values()) mod.markSessionSeen(meta.id, meta.updatedAt);
    };
    switchTo("b");
    switchTo("a");
    expect(readers).not.toHaveBeenCalled();
    expect(mod.loadLastSeen()).toBe(before);
    expect(mod.loadLastSeen()).toMatchObject({ a: 100, b: 200 });
    // c was unread: opening it is a change the readers hear.
    switchTo("c");
    expect(readers).toHaveBeenCalled();
    expect(mod.loadLastSeen()).not.toBe(before);
    expect(mod.loadLastSeen().c).toBe(300);
    marks.dispose();
    vi.useRealTimers();
  });
});
