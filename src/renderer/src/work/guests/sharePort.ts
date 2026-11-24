import { useSyncExternalStore } from "react";

/**
 * Which item's Share sheet was asked for, by its item id: File → Share…, More and the keys ask here, and the item's
 * own Share button (guests/Share.tsx) opens its sheet. No React in the ask, so a menu can call it from anywhere.
 */

let asked: { itemId: string; n: number } | null = null;
let n = 0;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

export function openShare(itemId: string): void {
  asked = { itemId, n: ++n };
  for (const listener of listeners) listener();
}

/** A number that grows with each ask for this item's sheet; 0 while none was made. */
export function useShareAsked(itemId: string | undefined): number {
  return useSyncExternalStore(subscribe, () => (itemId && asked?.itemId === itemId ? asked.n : 0));
}
