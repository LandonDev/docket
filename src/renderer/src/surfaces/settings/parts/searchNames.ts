import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { SearchExtra } from "../../../lib/settings/search";
import type { SettingsPageId } from "../../../lib/settings";

/**
 * The names a page's own list holds (add-ons, skills), for Settings' search: the page sets them as it reads its list,
 * and search asks once for them when it first runs, inside Settings, so nothing is read before Settings opens.
 */
export function searchNames(page: SettingsPageId, path: string, ask: () => Promise<readonly string[]>) {
  let names: readonly string[] | null = null;
  let asked = false;
  const listeners = new Set<() => void>();
  const set = (next: readonly string[]): void => {
    names = next;
    for (const listener of listeners) listener();
  };
  const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  /** The names as search takes them, each opening the page. */
  function useExtras(): SearchExtra[] {
    const shown = useSyncExternalStore(subscribe, () => names);
    useEffect(() => {
      if (asked || names !== null) return;
      asked = true;
      ask().then(set, () => {
        asked = false;
      });
    }, []);
    return useMemo(() => [...new Set(shown ?? [])].map((title) => ({ title, page, path })), [shown]);
  }
  /** For tests: forget the names. */
  const reset = (): void => {
    names = null;
    asked = false;
  };
  return { set, useExtras, reset };
}
