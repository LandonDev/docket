import { useSyncExternalStore } from "react";

/**
 * What is typed in Settings' search field, shared by the field (the list, chrome/SettingsRail.tsx) and the results
 * (the page, surfaces/settings/SearchResults.tsx), with the highlighted result's index.
 */
type State = { query: string; active: number };

let state: State = { query: "", active: 0 };
const listeners = new Set<() => void>();
const set = (next: State): void => {
  state = next;
  for (const listener of listeners) listener();
};
const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const settingsSearch = {
  get: (): State => state,
  /** A new query starts at its first result. */
  setQuery: (query: string): void => set({ query, active: 0 }),
  setActive: (active: number): void => {
    if (active !== state.active) set({ ...state, active });
  },
  clear: (): void => {
    if (state.query || state.active) set({ query: "", active: 0 });
  },
};

export const useSettingsSearch = (): State => useSyncExternalStore(subscribe, () => state);

/** The search field asks for focus (⌘F while Settings is open). */
export const FOCUS_SEARCH_EVENT = "docket:settings-search-focus";
export const focusSettingsSearch = (): void => void window.dispatchEvent(new CustomEvent(FOCUS_SEARCH_EVENT));
