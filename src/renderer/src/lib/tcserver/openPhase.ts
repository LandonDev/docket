/**
 * A host's open in two phases (docs/agents/launch-mirror.md "The open in two phases"). What the first paint needs
 * runs the moment a socket opens: the session changes, the workspaces, the shown thread, its focus, the model
 * catalog, the primary host's Away state. The rest (the inbox, dev servers, port forwards, host jobs, computer
 * sessions and history, thread resources, another host's Away state, the providers' doctor) waits for
 * `afterOpen`: an idle slot once the window's shell has painted from its primary host (`markUsable` at tc:ready)
 * or `RELEASE_AFTER_MS` after the first such task, whichever is first, so no saved host that never answers holds
 * it; one at a time on a remote host; and only while the transport that opened is still the live one, so nothing
 * is asked twice for one open, a route swapped with no close between included.
 */

import { LOCAL_ENVIRONMENT_ID } from "../connection/registry";

type OpenLink = {
  readonly environmentId: string;
  readonly connected: boolean;
  /** The live socket: replaced on every reconnect and every route swap (EnvLink `transport`). */
  readonly transport?: unknown;
  /** A test's fake may have none: then the transport and `connected` guard a later open. */
  onClose?(listener: () => void): () => void;
};
type Task = () => unknown;

/** The second phase waits at most this long after its first task for the shell's paint. */
export const RELEASE_AFTER_MS = 3_000;
/** An idle slot is waited for at most this long: a busy window still runs the second phase. */
export const IDLE_TIMEOUT_MS = 1_000;

let usable = false;
const usableWaiters: (() => void)[] = [];
let releaseTimer: ReturnType<typeof setTimeout> | null = null;

/** The window's shell has painted from its primary host (main.tsx, at tc:ready): the second phase may run. */
export function markUsable(): void {
  if (usable) return;
  usable = true;
  if (releaseTimer !== null) clearTimeout(releaseTimer);
  releaseTimer = null;
  for (const wake of usableWaiters.splice(0)) wake();
}

function whenUsable(): Promise<void> {
  // A hidden window paints nothing, so nothing waits on it: its second phase runs at once.
  if (usable || (typeof document !== "undefined" && document.visibilityState === "hidden")) return Promise.resolve();
  releaseTimer ??= setTimeout(markUsable, RELEASE_AFTER_MS);
  return new Promise((resolve) => usableWaiters.push(resolve));
}

function idleSlot(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestIdleCallback === "function") requestIdleCallback(() => resolve(), { timeout: IDLE_TIMEOUT_MS });
    else setTimeout(resolve, 0);
  });
}

/** Each link's count of closes, for a fake with no transport: a task runs only if no close came since. */
const closes = new WeakMap<OpenLink, { n: number }>();
function closesOf(link: OpenLink): { n: number } {
  let held = closes.get(link);
  if (!held) {
    const fresh = { n: 0 };
    link.onClose?.(() => fresh.n++);
    closes.set(link, fresh);
    held = fresh;
  }
  return held;
}

/** A remote host's second phase, one task after another. */
const remoteChains = new Map<string, Promise<void>>();

/** Run `task` in the second phase of this open (call it from an `onOpen` listener). */
export function afterOpen(link: OpenLink, task: Task): void {
  const count = closesOf(link);
  const at = count.n;
  const opened = link.transport;
  const run = async (): Promise<void> => {
    if (count.n !== at || link.transport !== opened || !link.connected) return;
    try {
      await task();
    } catch {
      // a loader's own failure is its own: the next open asks again
    }
  };
  if (link.environmentId === LOCAL_ENVIRONMENT_ID) {
    void whenUsable().then(idleSlot).then(run);
    return;
  }
  const chain = (remoteChains.get(link.environmentId) ?? Promise.resolve()).then(whenUsable).then(idleSlot).then(run);
  remoteChains.set(link.environmentId, chain);
}

/** Test seam. */
export function resetOpenPhase(): void {
  usable = false;
  usableWaiters.length = 0;
  if (releaseTimer !== null) clearTimeout(releaseTimer);
  releaseTimer = null;
  remoteChains.clear();
}
