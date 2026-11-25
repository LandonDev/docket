/** A sheet's unsent edits on the guest's device: kept by the link, a day at most, one tab at a time, and never written again once the link is over. */
import { describe, expect, it } from "vitest";
import type { SavedSession } from "work-kit/sheet/collab";
import { wipeOffline } from "./offline";
import { claimQueue, QUEUE_KEEP_MS, QUEUE_WRITE_MS, queueName, sheetQueue } from "./sheetQueue";

/** The few calls the queue makes of IndexedDB, over a map. */
function fakeIdb() {
  const dbs = new Map<string, Map<string, unknown>>();
  const later = (fn: () => void): void => void Promise.resolve().then(fn);
  const idb = {
    writes: 0,
    open(name: string) {
      const req: { result?: unknown; onupgradeneeded?: () => void; onsuccess?: () => void; onerror?: () => void; onblocked?: () => void; error?: unknown } = {};
      later(() => {
        const made = !dbs.has(name);
        if (made) dbs.set(name, new Map());
        const store = dbs.get(name)!;
        req.result = {
          createObjectStore: () => {},
          close: () => {},
          transaction: () => {
            const tx: { oncomplete?: () => void; onerror?: () => void; onabort?: () => void; objectStore(): unknown } = {
              objectStore: () => ({
                put: (value: unknown, key: string) => {
                  idb.writes++;
                  store.set(key, structuredClone(value));
                  later(() => tx.oncomplete?.());
                },
                get: (key: string) => {
                  const got: { result?: unknown; onsuccess?: () => void } = {};
                  later(() => {
                    got.result = store.get(key);
                    got.onsuccess?.();
                  });
                  return got;
                },
              }),
            };
            return tx;
          },
        };
        if (made) req.onupgradeneeded?.();
        req.onsuccess?.();
      });
      return req;
    },
    databases: async () => [...dbs.keys()].map((name) => ({ name })),
    deleteDatabase(name: string) {
      const req: { onsuccess?: () => void } = {};
      later(() => {
        dbs.delete(name);
        req.onsuccess?.();
      });
      return req;
    },
  };
  return { idb: idb as never as IDBFactory & { writes: number }, dbs };
}

function clock() {
  let now = 1_000_000;
  const waiting: { fn: () => void; at: number }[] = [];
  return {
    now: () => now,
    timers: { set: (fn: () => void, ms: number) => (waiting.push({ fn, at: now + ms }), waiting.at(-1)), clear: (t: unknown) => void waiting.splice(waiting.indexOf(t as never), 1) },
    async pass(ms: number) {
      now += ms;
      for (const w of waiting.filter((x) => x.at <= now)) {
        waiting.splice(waiting.indexOf(w), 1);
        w.fn();
      }
      for (let i = 0; i < 20; i++) await Promise.resolve();
    },
  };
}

const saved = (edits: number): SavedSession => ({ cid: "client-0001", rev: 7, mark: "m1", n: 3, inflight: null, pending: edits ? [{ mutations: [{ id: "sheet.mutation.set-range-values", params: {} }], edits }] : [] });

describe("a sheet's unsent edits on the guest's device", () => {
  it("writes a burst of typing once, and the next open reads it back", async () => {
    const { idb, dbs } = fakeIdb();
    const c = clock();
    const q = sheetQueue("L1", idb, c.now, c.timers);
    expect(await q.load()).toEqual({ saved: null, old: 0 });
    for (const n of [1, 2, 3]) q.save(saved(n));
    expect(idb.writes).toBe(0);
    await c.pass(QUEUE_WRITE_MS);
    expect(idb.writes).toBe(1);
    expect([...dbs.keys()]).toEqual([queueName("L1")]);
    expect(await sheetQueue("L1", idb, c.now, c.timers).load()).toEqual({ saved: saved(3), old: 0 });
    // Another link's queue is its own.
    expect(await sheetQueue("L2", idb, c.now, c.timers).load()).toEqual({ saved: null, old: 0 });
  });

  it("lets go of edits that waited over a day, counted from the oldest still unsent, and keeps the client's place", async () => {
    const { idb } = fakeIdb();
    const c = clock();
    const q = sheetQueue("L1", idb, c.now, c.timers);
    q.save(saved(2));
    await c.pass(QUEUE_WRITE_MS);
    await c.pass(QUEUE_KEEP_MS - 60_000);
    // A later edit does not make the first one young again.
    q.save(saved(3));
    await c.pass(QUEUE_WRITE_MS);
    const soon = await sheetQueue("L1", idb, c.now, c.timers).load();
    expect(soon.old).toBe(0);
    await c.pass(120_000);
    const late = await sheetQueue("L1", idb, c.now, c.timers).load();
    expect(late).toEqual({ saved: { ...saved(0) }, old: 3 });
    // Once every edit is answered the clock starts again with the next one.
    const again = sheetQueue("L1", idb, c.now, c.timers);
    again.save(saved(0));
    again.save(saved(1));
    await c.pass(QUEUE_WRITE_MS);
    await c.pass(QUEUE_KEEP_MS - 60_000);
    expect((await sheetQueue("L1", idb, c.now, c.timers).load()).old).toBe(0);
  });

  it("writes at once when the page is hidden, and nothing more once the link is over: the wipe leaves no copy", async () => {
    const { idb, dbs } = fakeIdb();
    const c = clock();
    const q = sheetQueue("L1", idb, c.now, c.timers);
    q.save(saved(1));
    q.flush();
    await c.pass(0);
    expect(idb.writes).toBe(1);
    q.save(saved(2));
    q.stop();
    await wipeOffline("L1", undefined, idb);
    await c.pass(QUEUE_WRITE_MS * 4);
    q.save(saved(3));
    await c.pass(QUEUE_WRITE_MS * 4);
    expect(idb.writes).toBe(1);
    expect([...dbs.keys()]).toEqual([]);
  });

  it("one tab a link holds the queue; a second keeps its edits in the tab, and takes over once the first lets go", async () => {
    let holder: (() => void) | null = null;
    const locks = {
      request: async (_name: string, _o: unknown, fn: (lock: object | null) => Promise<void> | undefined) => {
        if (holder) return fn(null);
        const held = fn({});
        holder = () => {};
        await held;
        holder = null;
      },
    } as never as LockManager;
    const first = await claimQueue("L1", locks);
    expect(first.held).toBe(true);
    expect((await claimQueue("L1", locks)).held).toBe(false);
    first.release();
    await Promise.resolve();
    await Promise.resolve();
    expect((await claimQueue("L1", locks)).held).toBe(true);
    // A browser with no locks keeps no queue.
    expect((await claimQueue("L1", undefined as never)).held).toBe(false);
  });
});
