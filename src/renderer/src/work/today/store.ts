import { useSyncExternalStore } from "react";
import { NO_FOLDS, type Fed, type Folds } from "./model";
import { TODAY_SOURCES } from "./sources";
import type { TodayAnswer, TodaySource } from "./types";

/**
 * What Today keeps for the life of the window (docs/agents/work-today.md
 * "Speed"): the sources that loaded, the last answer of each, the folds he
 * opened, where the page was scrolled and the held item its sheet shows.
 * Module state, so a reopen paints the rows it had at once and the live
 * reads correct them; nothing here is saved.
 */

type Loaded = { id: string; source: TodaySource };

export type TodayState = {
  /** The sources that loaded, in the registry's order. */
  sources: readonly Loaded[];
  answers: ReadonlyMap<string, TodayAnswer>;
  folds: Folds;
  /** The key of the held row whose sheet is open. */
  held: string | null;
};

let state: TodayState = { sources: [], answers: new Map(), folds: NO_FOLDS, held: null };
let scrollTop = 0;
const listeners = new Set<() => void>();

function set(next: Partial<TodayState>): void {
  state = { ...state, ...next };
  for (const listener of listeners) listener();
}

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

export const todayNow = (): TodayState => state;

export function useTodayState(): TodayState {
  return useSyncExternalStore(subscribe, todayNow, todayNow);
}

/** A source that has never answered is still to answer: its section draws bones. */
const WAITING: TodayAnswer = { loading: true };

/** Each loaded source with what it last answered. */
export const fedOf = (s: TodayState): Fed[] => s.sources.map(({ source }) => ({ source, answer: s.answers.get(source.id) ?? WAITING }));

// ── the sources ────────────────────────────────────────────────────────────

/** How long the page waits for its sources before it shows without the late ones. */
const READY_MS = 1_500;
let loading: Promise<void> | null = null;

function seat(loaded: Loaded): void {
  const order = TODAY_SOURCES.map((entry) => entry.id);
  const sources = [...state.sources.filter((s) => s.id !== loaded.id), loaded].sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  set({ sources });
}

/**
 * Loads every registered source, each on its own: one that fails to load is
 * left out and logged, and the page shows the rest. Resolves once all have
 * settled, or after a moment, so a source that never loads holds up nothing.
 */
export function loadSources(): Promise<void> {
  loading ??= Promise.race([
    Promise.all(
      TODAY_SOURCES.map((entry) =>
        entry.load().then(
          (module) => seat({ id: entry.id, source: module.source }),
          (error: unknown) => console.warn(`[today] the ${entry.id} source did not load`, error),
        ),
      ),
    ).then(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, READY_MS)),
  ]);
  return loading;
}

/** A source that threw while it ran: left out, with what it had answered. */
export function dropSource(id: string, error: unknown): void {
  console.warn(`[today] the ${id} source failed and was left out`, error);
  const answers = new Map(state.answers);
  answers.delete(id);
  set({ sources: state.sources.filter((s) => s.id !== id), answers });
}

/** What a source answers now. The same answer again wakes no one. */
export function putAnswer(id: string, answer: TodayAnswer): void {
  if (state.answers.get(id) === answer) return;
  set({ answers: new Map(state.answers).set(id, answer) });
}

// ── what he did to the page ────────────────────────────────────────────────

/** Unfold a section's "N more" or its "N earlier"; they stay open until the window closes. */
export function unfold(which: keyof Folds, section: string): void {
  if (state.folds[which].has(section)) return;
  set({ folds: { ...state.folds, [which]: new Set(state.folds[which]).add(section) } });
}

/** Open the sheet on a held row, by its key; null closes it. */
export function openHeld(key: string | null): void {
  if (state.held !== key) set({ held: key });
}

export const scrollOfToday = (): number => scrollTop;
export function keepScroll(top: number): void {
  scrollTop = top;
}

/** Test and preview seam: the page with these sources in place of the registry's, or as the window first has it. */
export function resetToday(sources?: readonly TodaySource[]): void {
  loading = sources ? Promise.resolve() : null;
  scrollTop = 0;
  set({ sources: (sources ?? []).map((source) => ({ id: source.id, source })), answers: new Map(), folds: NO_FOLDS, held: null });
}
