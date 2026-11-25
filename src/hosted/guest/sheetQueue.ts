import type { SavedSession } from "work-kit/sheet/collab";
import { offlinePrefix } from "./offline";

/**
 * A sheet's unsent edits on the guest's own device (docs/agents/work-guests.md "The copy on a guest's device"): what
 * an Edit link's page typed while the line was down, kept by the link so a closed tab loses none of it, and sent when
 * the page next opens. The session caps it (500 batches, 2 MiB); here it is kept a day at most, by one tab at a time,
 * and wiped with the link (`wipeOffline` deletes every database under the link's prefix, this one too).
 */

/** How long unsent edits wait for the sheet before they are let go. */
export const QUEUE_KEEP_MS = 24 * 60 * 60_000;
/** Writes are gathered: a burst of typing is one write. */
export const QUEUE_WRITE_MS = 250;

export const queueName = (linkId: string): string => `${offlinePrefix(linkId)}:sheet`;

interface Kept {
  /** when the oldest edit still unsent was made */
  at: number;
  saved: SavedSession;
}

export interface SheetQueue {
  /** What was kept, and how many edits were let go for being over a day old. */
  load(): Promise<{ saved: SavedSession | null; old: number }>;
  save(saved: SavedSession): void;
  /** Writes what waits now (the page is being hidden). */
  flush(): void;
  /** Writes nothing more: the link is over, and its copy is being wiped. */
  stop(): void;
}

const unsent = (s: SavedSession): number => (s.inflight ? s.inflight.edits : 0) + s.pending.reduce((n, b) => n + b.edits, 0);

function open(idb: IDBFactory, name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = idb.open(name, 1);
    req.onupgradeneeded = () => req.result.createObjectStore("q");
    req.onsuccess = () => resolve(req.result);
    req.onerror = req.onblocked = () => reject(req.error ?? new Error("the queue could not be opened"));
  });
}

export function sheetQueue(
  linkId: string,
  idb: IDBFactory = indexedDB,
  now: () => number = Date.now,
  timers: { set(fn: () => void, ms: number): unknown; clear(t: unknown): void } = { set: (fn, ms) => setTimeout(fn, ms), clear: (t) => clearTimeout(t as ReturnType<typeof setTimeout>) },
): SheetQueue {
  const name = queueName(linkId);
  let since: number | null = null;
  let waiting: SavedSession | null = null;
  let timer: unknown = null;
  let stopped = false;
  // One write at a time, in order: the newest state is the one left on the device.
  let lane: Promise<void> = Promise.resolve();
  const write = (): void => {
    timer = null;
    const saved = waiting;
    waiting = null;
    if (!saved || stopped) return;
    const kept: Kept = { at: since ?? now(), saved };
    lane = lane
      .then(async () => {
        if (stopped) return;
        const db = await open(idb, name);
        try {
          await new Promise<void>((resolve, reject) => {
            const tx = db.transaction("q", "readwrite");
            tx.objectStore("q").put(kept, "saved");
            tx.oncomplete = () => resolve();
            tx.onerror = tx.onabort = () => reject(tx.error ?? new Error("the queue could not be written"));
          });
        } finally {
          db.close();
        }
      })
      // A device that keeps nothing (private browsing, a full disk): the edits stay in the tab.
      .catch(() => {});
  };
  return {
    async load() {
      try {
        const db = await open(idb, name);
        try {
          const kept = await new Promise<Kept | undefined>((resolve, reject) => {
            const req = db.transaction("q", "readonly").objectStore("q").get("saved");
            req.onsuccess = () => resolve(req.result as Kept | undefined);
            req.onerror = () => reject(req.error ?? new Error("the queue could not be read"));
          });
          if (!kept?.saved || typeof kept.saved.cid !== "string") return { saved: null, old: 0 };
          const edits = unsent(kept.saved);
          if (edits && now() - kept.at > QUEUE_KEEP_MS) return { saved: { ...kept.saved, inflight: null, pending: [] }, old: edits };
          since = edits ? kept.at : null;
          return { saved: kept.saved, old: 0 };
        } finally {
          db.close();
        }
      } catch {
        return { saved: null, old: 0 };
      }
    },
    save(saved) {
      if (stopped) return;
      since = unsent(saved) ? (since ?? now()) : null;
      waiting = saved;
      timer ??= timers.set(write, QUEUE_WRITE_MS);
    },
    flush() {
      if (timer === null) return;
      timers.clear(timer);
      write();
    },
    stop() {
      stopped = true;
      if (timer !== null) timers.clear(timer);
      timer = null;
      waiting = null;
    },
  };
}

/**
 * One tab a link keeps the queue: a second tab of the same link would send batches under the same client id, and
 * the sheet would take one tab's batch for the other's sent again. Answers whether this tab holds it, and the way to
 * let it go. A browser with no locks keeps no queue.
 */
export function claimQueue(linkId: string, locks: LockManager | undefined = typeof navigator === "undefined" ? undefined : navigator.locks): Promise<{ held: boolean; release(): void }> {
  if (!locks) return Promise.resolve({ held: false, release: () => {} });
  return new Promise((resolve) => {
    let release = (): void => {};
    void locks
      .request(queueName(linkId), { ifAvailable: true }, (lock) => {
        if (!lock) return resolve({ held: false, release: () => {} });
        return new Promise<void>((done) => {
          release = done;
          resolve({ held: true, release: () => release() });
        });
      })
      .catch(() => resolve({ held: false, release: () => {} }));
  });
}
