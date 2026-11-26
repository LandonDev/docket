import { useSyncExternalStore } from "react";
import type { WinvmScreen, WinvmState } from "@shared/contract-work-winvm";
import { registry } from "../../../lib/connection";
import { hostFailure } from "../../../lib/hostFailure";

/**
 * Fits my window's upgrade on a machine without live resize (docs/agents/settings.md "Windows VM"), watched here and
 * not by the page: it takes minutes, and he may leave Settings meanwhile. The watch reads the machine's state pushes
 * (and its state again when the socket opens) until the upgrade ends. It succeeded only when that end says so: awake,
 * no error, on the live-resize display. Any other end, or a refusal at the press, writes the size that stood back, so
 * the stored setting never claims what the machine cannot do, and keeps the reason for the page to say.
 */

export type Upgrade = { phase: "running" } | { phase: "failed"; reason: string };

const upgrades = new Map<string, Upgrade>();
const listeners = new Set<() => void>();

function put(environmentId: string, upgrade: Upgrade | null): void {
  if (upgrade) upgrades.set(environmentId, upgrade);
  else upgrades.delete(environmentId);
  for (const listener of listeners) listener();
}

/** The upgrade running on a computer, or the reason the last one failed; null when there is nothing to say. */
export function useUpgrade(environmentId: string): Upgrade | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => upgrades.get(environmentId) ?? null,
  );
}

/** Test seam. */
export function resetUpgradesForTests(): void {
  upgrades.clear();
  for (const listener of listeners) listener();
}

/** His next change of the screen size: an old failure has been said. */
export const forgetUpgrade = (environmentId: string): void => {
  if (upgrades.get(environmentId)?.phase === "failed") put(environmentId, null);
};

/** The upgrade's end, from a state: the first that is not a display step once one was seen, or an error before any. */
export function upgradeEnded(state: WinvmState, seen: boolean): boolean {
  if (state.state === "setting-up") return false;
  return seen || !!state.error;
}

/** It went through: awake, with no error, on the live-resize display. The display alone does not say so. */
export const upgradeWorked = (end: WinvmState): boolean => end.state === "awake" && !end.error && end.display?.device === "virtio";

/**
 * Starts the upgrade and waits for its end. Resolves once live resize is on; rejects with his words when the
 * computer refused it or it ended any other way, after `before` (the size that stood) is written back.
 */
export function runUpgrade(environmentId: string, before: WinvmScreen | null): Promise<void> {
  const link = registry.linkOf(environmentId);
  const words = (err: unknown): string => hostFailure(environmentId, err, "did not fit the Windows VM to your window", true);
  const putBack = async (): Promise<void> => {
    if (before && before !== "fit") await link.request("work.winvm.settings", { screen: before }).catch(() => undefined);
  };
  put(environmentId, { phase: "running" });
  let seen = false;
  let offPush = (): void => {};
  let offOpen = (): void => {};
  const ended = new Promise<WinvmState>((resolve) => {
    const look = (state: WinvmState): void => {
      if (state.state === "setting-up") seen = true;
      if (!upgradeEnded(state, seen)) return;
      offPush();
      offOpen();
      resolve(state);
    };
    offPush = link.onPush((push) => {
      if (push.push === "work.winvm") look(push.state as WinvmState);
    });
    // A socket that dropped meanwhile missed pushes: its state, read again once it opens.
    offOpen = link.onOpen(() => {
      void link.request<WinvmState>("work.winvm.state", {}).then(look, () => undefined);
    });
  });
  const fail = async (reason: string): Promise<never> => {
    await putBack();
    put(environmentId, { phase: "failed", reason });
    throw new Error(reason);
  };
  return link.request("work.winvm.display.upgrade", {}).then(
    async () => {
      const end = await ended;
      if (!upgradeWorked(end)) {
        // The machine's own reason stands on the Windows row (its state's error); this one says what did not happen.
        await fail(words(null));
      }
      put(environmentId, null);
    },
    async (err: unknown) => {
      offPush();
      offOpen();
      await fail(words(err));
    },
  );
}
