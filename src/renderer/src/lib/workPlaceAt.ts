import { useSyncExternalStore } from "react";
import { shell } from "../stores/shell";
import { workPlaceRow } from "./workPlaces";

/**
 * Opening a page above the Work workspaces at something: a moment the page
 * knows what to do with (Review opens the week that holds it). Plain state
 * beside lib/workPlaces.ts, so a caller in another chunk (a routine's run in
 * Routines, Today's row) opens a page at its place without loading the page.
 * The page reads it with `useWorkPlaceAt` and takes it with `takeWorkPlaceAt`,
 * so a press while the page is already open still moves it.
 */
let wanted: { id: string; at: number } | null = null;
const listeners = new Set<() => void>();

const changed = (): void => {
  for (const listener of listeners) listener();
};

/** Opens the page `id`, at `at` when given; nothing for an id no row has. */
export function openWorkPlaceAt(id: string, at?: number): void {
  if (!workPlaceRow(id)) return;
  wanted = at === undefined ? null : { id, at };
  changed();
  shell.openWorkPlace(id);
}

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

/** The moment the page `id` was asked to open at and has not taken yet; null: none. */
export function useWorkPlaceAt(id: string): number | null {
  const get = (): number | null => (wanted?.id === id ? wanted.at : null);
  return useSyncExternalStore(subscribe, get, get);
}

/** The page took it: the next open without a moment opens where the page stands. */
export function takeWorkPlaceAt(id: string): void {
  if (wanted?.id !== id) return;
  wanted = null;
  changed();
}
