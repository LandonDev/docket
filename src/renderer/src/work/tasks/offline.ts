import { useSyncExternalStore } from "react";

/** The words of `linkWords` for a computer that is itself offline, said where a form that writes to LifeOS holds its press. */
export const OFFLINE_WORDS = "This computer is offline";

const subscribe = (listener: () => void): (() => void) => {
  window.addEventListener("online", listener);
  window.addEventListener("offline", listener);
  return () => {
    window.removeEventListener("online", listener);
    window.removeEventListener("offline", listener);
  };
};

/**
 * Whether this computer itself is offline. New task and New event write straight to LifeOS, not through a host, so a
 * link to the box that is down leaves them able; this computer offline does not, and their Add is held while it is.
 */
export function useComputerOffline(): boolean {
  return useSyncExternalStore(subscribe, () => navigator.onLine === false, () => false);
}
