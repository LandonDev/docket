import { useEffect, useSyncExternalStore } from "react";
import type { CanvasItem } from "@shared/work";
import { isSlideShowFile } from "@shared/work/slideFormats";

const pending = new Map<string, number>();
const listeners = new Set<() => void>();
const keyOf = (env: string, id: string): string => `${env}\n${id}`;
const listen = (fn: () => void): (() => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

/** Call only on the opening window's own press, after the host returns the item. */
export function noteSlidesOpenedByHand(env: string, item: CanvasItem): void {
  const source = item.source;
  const name = source.at === "file" ? source.path : source.at === "mail" || source.at === "microsoft" ? source.name : "";
  if (item.kind !== "slides" || !isSlideShowFile(name)) return;
  const key = keyOf(env, item.id);
  const until = Date.now() + 120_000;
  pending.set(key, until);
  for (const fn of listeners) fn();
  setTimeout(() => {
    if (pending.get(key) === until) pending.delete(key);
  }, 120_000);
}

/** A restored tab or a thread's push has no opening press to consume. */
export function useOpenShow(env: string, id: string, ready: boolean, start: () => void): void {
  const key = keyOf(env, id);
  const ticket = useSyncExternalStore(listen, () => pending.get(key), () => undefined);
  useEffect(() => {
    if (!ready || ticket === undefined || pending.get(key) !== ticket) return;
    pending.delete(key);
    if (Date.now() <= ticket) start();
  }, [key, ready, start, ticket]);
}
