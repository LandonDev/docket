/**
 * A host's open in two phases (docs/agents/launch-mirror.md "The open in two phases"). What the first paint needs
 * runs the moment a socket opens: the session changes, the workspaces, the shown thread, its focus, the model
 * catalog. The rest (the inbox, dev servers, port forwards, host jobs, computer history, thread resources, the
 * providers' doctor) waits for `afterOpen`: an idle slot once the window is usable, one at a time on a remote host,
 * and only while the socket that opened is still the live one, so nothing is asked twice for one open.
 */

import { LOCAL_ENVIRONMENT_ID } from "../connection/registry";

type OpenLink = {
  readonly environmentId: string;
  readonly connected: boolean;
  /** A test's fake may have none: then only `connected` guards a later open. */
  onClose?(listener: () => void): () => void;
};
type Task = () => unknown;

let usable = false;
const usableWaiters: (() => void)[] = [];

/** The window is usable (main.tsx, at `tc:ready`): the second phase may run. */
export function markUsable(): void {
  if (usable) return;
  usable = true;
  for (const wake of usableWaiters.splice(0)) wake();
}

function whenUsable(): Promise<void> {
  // A hidden window paints nothing, so nothing waits on it: its second phase runs at once.
  if (usable || (typeof document !== "undefined" && document.visibilityState === "hidden")) return Promise.resolve();
  return new Promise((resolve) => usableWaiters.push(resolve));
}

function idleSlot(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestIdleCallback === "function") requestIdleCallback(() => resolve());
    else setTimeout(resolve, 0);
  });
}

/** Each link's count of closes: a task queued on one open runs only if no close came since. */
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
  const run = async (): Promise<void> => {
    if (count.n !== at || !link.connected) return;
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
  remoteChains.clear();
}
