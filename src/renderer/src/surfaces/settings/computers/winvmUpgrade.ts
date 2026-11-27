import { useSyncExternalStore } from "react";
import type { WinvmScreen, WinvmState } from "@shared/contract-work-winvm";
import { registry } from "../../../lib/connection";
import { hostFailure } from "../../../lib/hostFailure";

/**
 * Fits my window's upgrade on a machine without live resize (docs/agents/settings.md "Windows VM"), watched here and
 * not by the page: it takes minutes, and he may leave Settings meanwhile. The watch reads the machine's state pushes
 * (and its state again when the socket opens) until the upgrade ends. It succeeded only when that end says so: awake,
 * no error, on the live-resize display. Any other end, or a refusal at the press, writes the size that stood back, so
 * the stored setting never claims what the machine cannot do, and keeps the reason for the page to say; a write back the
 * computer refused is said too, with a Retry that writes it again. An end this window cannot confirm (a read again
 * after a socket opened that shows no step and no end) is said with a Retry that reads the machine again.
 */

/** A running upgrade; one whose end this window could not confirm (it keeps watching; Retry reads the machine again);
 *  one that failed and put the size that stood back; or one that failed and could not put it back (Retry tries again). */
export type Upgrade =
  | { phase: "held" }
  | { phase: "running" }
  | { phase: "unconfirmed"; reason: string }
  | { phase: "failed"; reason: string }
  | { phase: "unrestored"; reason: string; failed: string };

const upgrades = new Map<string, Upgrade>();
/** The computers whose upgrade `runUpgrade` is watching (from its first write to its end). */
const watching = new Set<string>();
/** What Retry does for a computer's upgrade line: read the machine again, or write the old size back again. */
const retries = new Map<string, () => Promise<void>>();
const listeners = new Set<() => void>();

function put(environmentId: string, upgrade: Upgrade | null): void {
  if (upgrade) upgrades.set(environmentId, upgrade);
  else upgrades.delete(environmentId);
  for (const listener of listeners) listener();
}

/** The upgrade running on a computer, or what the last one left to say; null when there is nothing to say. */
export function useUpgrade(environmentId: string): Upgrade | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => upgrades.get(environmentId) ?? null,
  );
}

/** The upgrade line's Retry: settles once its read or its write has. */
export const retryUpgrade = (environmentId: string): Promise<void> => retries.get(environmentId)?.() ?? Promise.resolve();

/** Test seam. */
export function resetUpgradesForTests(): void {
  upgrades.clear();
  watching.clear();
  retries.clear();
  for (const listener of listeners) listener();
}

/** Fits my window is on its way from his pick: Screen size is held from the confirm, through the save, until the watch
 *  takes over (`runUpgrade`) or `releaseHold` lets it go. "held" draws no saving mark: nothing is written before his
 *  yes, and the save's own mark starts with its write. */
export const holdForUpgrade = (environmentId: string): void => put(environmentId, { phase: "held" });

/** The hold ends with no watch behind it (his Cancel, or a save refused before the upgrade began). */
export function releaseHold(environmentId: string): void {
  const phase = upgrades.get(environmentId)?.phase;
  if (phase === "held" || (phase === "running" && !watching.has(environmentId))) put(environmentId, null);
}

/** His next change of the screen size: what an old upgrade left to say has been said. */
export const forgetUpgrade = (environmentId: string): void => {
  const phase = upgrades.get(environmentId)?.phase;
  if (phase === "failed" || phase === "unrestored") {
    retries.delete(environmentId);
    put(environmentId, null);
  }
};

/** Screen size is held while an upgrade is unresolved: running, its end unconfirmed, or the size that stood not put
 *  back (a restore in flight included); a pick then could be written over by the upgrade's own rollback. */
export const upgradeHolds = (upgrade: Upgrade | null): boolean =>
  upgrade?.phase === "held" || upgrade?.phase === "running" || upgrade?.phase === "unconfirmed" || upgrade?.phase === "unrestored";

/** It went through: awake, with no error, on the live-resize display. The display alone does not say so. */
export const upgradeWorked = (end: WinvmState): boolean => end.state === "awake" && !end.error && end.display?.device === "virtio";

/** The upgrade's end, from a state: live resize on and working (the old display cannot be awake on it, so this needs no
 *  step seen first: a reconnect may have missed them all), the first that is not a display step once one was seen, or an
 *  error before any. */
export function upgradeEnded(state: WinvmState, seen: boolean): boolean {
  if (state.state === "setting-up") return false;
  return upgradeWorked(state) || seen || !!state.error;
}

/** "1280 × 800", as the select says a size. */
const sizeWords = (screen: WinvmScreen): string => screen.replace("x", " × ");

/**
 * Starts the upgrade and waits for its end. Resolves once live resize is on; rejects with his words when the
 * computer refused it or it ended any other way, after `before` (the size that stood) is written back, or said not to
 * be. A read again after a socket opened that cannot say where the upgrade stands leaves it unconfirmed, still watched.
 */
export function runUpgrade(environmentId: string, before: WinvmScreen | null): Promise<void> {
  const link = registry.linkOf(environmentId);
  const words = (err: unknown, act = "did not fit the Windows VM to your window"): string => hostFailure(environmentId, err, act, true);
  const unsure = (err: unknown): Upgrade => ({ phase: "unconfirmed", reason: words(err, "has not said yet whether the Windows VM fits your window") });
  put(environmentId, { phase: "running" });
  watching.add(environmentId);
  let seen = false;
  // Once the watch has its end, a reply still on its way (a read after a socket opened) changes nothing.
  let settled = false;
  let offPush = (): void => {};
  let offOpen = (): void => {};
  const ended = new Promise<WinvmState>((resolve) => {
    const look = (state: WinvmState, read: boolean): void => {
      if (settled) return;
      if (state.state === "setting-up") {
        seen = true;
        if (upgrades.get(environmentId)?.phase === "unconfirmed") put(environmentId, { phase: "running" });
      }
      if (upgradeEnded(state, seen)) {
        settled = true;
        offPush();
        offOpen();
        retries.delete(environmentId);
        resolve(state);
        return;
      }
      // A read with no step seen and no end: the upgrade may not have started, or ended while no socket was open.
      if (read && !seen && state.state !== "setting-up") put(environmentId, unsure(null));
    };
    const recheck = (): Promise<void> =>
      link.request<WinvmState>("work.winvm.state", {}).then(
        (state) => look(state, true),
        (err: unknown) => {
          if (!settled) put(environmentId, unsure(err));
        },
      );
    retries.set(environmentId, recheck);
    offPush = link.onPush((push) => {
      if (push.push === "work.winvm") look(push.state as WinvmState, false);
    });
    // A socket that dropped meanwhile missed pushes: its state, read again once it opens.
    offOpen = link.onOpen(() => void recheck());
  });
  const fail = async (reason: string): Promise<never> => {
    const restore = (): Promise<void> =>
      link.request("work.winvm.settings", { screen: before }).then(
        () => {
          retries.delete(environmentId);
          put(environmentId, { phase: "failed", reason });
        },
        (err: unknown) => {
          // What did not happen leads, then the computer's reason when it gave one.
          const act = `did not put the screen size back to ${sizeWords(before ?? "fit")}`;
          const lead = words(null, act);
          const why = words(err, act);
          put(environmentId, { phase: "unrestored", reason: why === lead ? lead : `${lead} ${why}`, failed: reason });
        },
      );
    if (before && before !== "fit") {
      retries.set(environmentId, restore);
      await restore();
    } else put(environmentId, { phase: "failed", reason });
    throw new Error(reason);
  };
  return link
    .request("work.winvm.display.upgrade", {})
    .then(
    async () => {
      const end = await ended;
      if (!upgradeWorked(end)) {
        // The machine's own reason stands on the Windows row (its state's error); this one says what did not happen.
        await fail(words(null));
      }
      put(environmentId, null);
    },
    async (err: unknown) => {
      settled = true;
      offPush();
      offOpen();
      retries.delete(environmentId);
      await fail(words(err));
    },
    )
    .finally(() => watching.delete(environmentId));
}
