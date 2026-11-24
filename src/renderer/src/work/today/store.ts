import { useSyncExternalStore } from "react";
import { DUR } from "../../lib/ease";
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
  /** Sources that threw while they ran, or did not load: no longer run, and each said on the page, which is never clear without them. */
  broken: readonly Loaded[];
  /** Sources still loading: they draw nothing yet, and the page is not clear while one is out. */
  pending: readonly string[];
  answers: ReadonlyMap<string, TodayAnswer>;
  folds: Folds;
  /** The key of the held row whose sheet is open. */
  held: string | null;
  /** How many held items he has decided since the sheet opened: the run counts forward ("2 of 3"). */
  heldDone: number;
  /** Rows on their way out by his own act (a tick, Tomorrow, Dismiss, a Send from the sheet): still drawn, fading. */
  leaving: ReadonlySet<string>;
  /** Rows that have faded: their place closes, so the rows under them glide up. */
  closing: ReadonlySet<string>;
  /** Rows his act took off the page, until the source that made them stops giving them. */
  gone: ReadonlySet<string>;
  /** How many of the page's own toasts are up (an act's "Marked done" with its Undo). */
  toastsUp: number;
};

const NONE: ReadonlySet<string> = new Set();
let state: TodayState = { sources: [], broken: [], pending: [], answers: new Map(), folds: NO_FOLDS, held: null, heldDone: 0, leaving: NONE, closing: NONE, gone: NONE, toastsUp: 0 };
let scrollTop = 0;
let focusKey: string | null = null;
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

/**
 * What a source that threw answers from then on: nothing, and one line that
 * says so. In its own section "this" is that section; under Also the line
 * names what is missing (`what` in the registry), so two such lines are two.
 */
export function brokenAnswer(source: Pick<TodaySource, "id" | "section">): TodayAnswer {
  const what = source.section ? "this" : (TODAY_SOURCES.find((entry) => entry.id === source.id)?.what ?? "everything");
  return { rows: [], failed: [{ environmentId: "", error: source.id, said: `Today could not show ${what}` }] };
}
const broke = new WeakMap<Pick<TodaySource, "id">, TodayAnswer>();
const brokenOf = (source: Pick<TodaySource, "id" | "section">): TodayAnswer => broke.get(source) ?? broke.set(source, brokenAnswer(source)).get(source)!;

/** The answers the store kept from before a source read again: their rows are a whole answer, not half of one. */
const keptAnswers = new WeakSet<TodayAnswer>();

/** Each loaded source with what it last answered, in the registry's order; one that threw answers that it could not be shown. */
export function fedOf(s: TodayState): Fed[] {
  const order = TODAY_SOURCES.map((entry) => entry.id);
  const at = (id: string): number => (order.includes(id) ? order.indexOf(id) : order.length);
  const fed = [
    ...s.sources.map(({ source }) => {
      const answer = s.answers.get(source.id) ?? WAITING;
      return { source, answer, ...(keptAnswers.has(answer) ? { kept: true } : {}) };
    }),
    ...s.broken.map(({ source }) => ({ source, answer: brokenOf(source) })),
    // Not loaded yet: no section to draw, but a source still out, so the page is not clear (model.ts `page`).
    ...s.pending.map((id) => ({ source: { id }, answer: WAITING })),
  ];
  return s.broken.length || s.pending.length ? fed.sort((a, b) => at(a.source.id) - at(b.source.id)) : fed;
}

// ── the sources ────────────────────────────────────────────────────────────

/** How long the page waits for its sources before it shows without the late ones. */
const READY_MS = 1_500;
let loading: Promise<void> | null = null;

function seat(loaded: Loaded): void {
  const order = TODAY_SOURCES.map((entry) => entry.id);
  const sources = [...state.sources.filter((s) => s.id !== loaded.id), loaded].sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  set({ sources, pending: state.pending.filter((id) => id !== loaded.id) });
}

/** A source whose chunk did not load: said as one that threw, so the page is never clear without it. */
function unloaded(id: string, error: unknown): void {
  console.warn(`[today] the ${id} source did not load`, error);
  const stub: TodaySource = { id, use: () => ({}) };
  set({ broken: [...state.broken.filter((s) => s.id !== id), { id, source: stub }], pending: state.pending.filter((p) => p !== id) });
}

/**
 * Loads every registered source, each on its own: one that fails to load is
 * left out and logged, and the page says it could not show it. Resolves once
 * all have settled, or after a moment, so a source that is slow to load
 * holds up no other; until it lands the page is not "All clear".
 */
export function loadSources(): Promise<void> {
  if (!loading) set({ pending: TODAY_SOURCES.map((entry) => entry.id).filter((id) => !state.sources.some((s) => s.id === id)) });
  loading ??= Promise.race([
    Promise.all(
      TODAY_SOURCES.map((entry) =>
        entry.load().then(
          (module) => seat({ id: entry.id, source: module.source }),
          (error: unknown) => unloaded(entry.id, error),
        ),
      ),
    ).then(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, READY_MS)),
  ]);
  return loading;
}

/**
 * A source that threw while it ran: it is run no more, what it had answered
 * is dropped, and the page says it could not be shown, in its own section or
 * under Also. The page shows the rest, and is never "All clear" without it.
 */
export function dropSource(id: string, error: unknown): void {
  console.warn(`[today] the ${id} source failed and was left out`, error);
  const dropped = state.sources.find((s) => s.id === id);
  const answers = new Map(state.answers);
  answers.delete(id);
  set({ sources: state.sources.filter((s) => s.id !== id), broken: dropped ? [...state.broken.filter((s) => s.id !== id), dropped] : state.broken, answers });
}

/** What each source last handed over, as it handed it: the same answer again wakes no one. */
const handed = new Map<string, TodayAnswer>();

/**
 * What a source answers now. One that is still to answer (`loading`, no
 * rows) keeps the rows, marks and note it had, so a reopen paints what was
 * there and the live read corrects it. A row his act took off is forgotten
 * once no source gives it, so the same thing may show again another day.
 */
export function putAnswer(id: string, answer: TodayAnswer): void {
  if (handed.get(id) === answer) return;
  handed.set(id, answer);
  const had = state.answers.get(id);
  // A read on hosts that is out again answers its empty list while it waits: that is not a whole answer either.
  const keeps = !!answer.loading && !answer.rows?.length && !!had?.rows?.length;
  const kept: TodayAnswer = keeps ? { ...answer, rows: had!.rows!, ...(had!.marks ? { marks: had!.marks } : {}), ...(had!.note ? { note: had!.note } : {}) } : answer;
  if (keeps) keptAnswers.add(kept);
  const answers = new Map(state.answers).set(id, kept);
  set({ answers, ...(state.gone.size ? { gone: stillGiven(state.gone, answers) } : {}) });
}

const given = (key: string): boolean => [...state.answers.values()].some((answer) => answer.rows?.some((row) => row.key === key));

function stillGiven(gone: ReadonlySet<string>, answers: ReadonlyMap<string, TodayAnswer>): ReadonlySet<string> {
  const given = new Set<string>();
  for (const answer of answers.values()) for (const row of answer.rows ?? []) given.add(row.key);
  const still = [...gone].filter((key) => given.has(key));
  return still.length === gone.size ? gone : new Set(still);
}

// ── a row that leaves by his own act ───────────────────────────────────────

const timers = new Map<string, ReturnType<typeof setTimeout>>();
const without = (set: ReadonlySet<string>, key: string): ReadonlySet<string> => {
  if (!set.has(key)) return set;
  const next = new Set(set);
  next.delete(key);
  return next;
};

/**
 * His act took a row off the page (docs/DESIGN.md "Today", a row that
 * leaves): it fades over `--dur-fast` where it stands, then its place
 * closes over `--dur-base` as the rows under it glide up, then it is gone.
 * The source need not wait for LifeOS or the host to drop it.
 */
export function leave(key: string): void {
  if (state.leaving.has(key) || state.closing.has(key) || state.gone.has(key)) return;
  set({ leaving: new Set(state.leaving).add(key) });
  const step = (after: number, run: () => void): void => void timers.set(key, setTimeout(run, after));
  step(DUR.fast * 1000, () => {
    set({ leaving: without(state.leaving, key), closing: new Set(state.closing).add(key) });
    step(DUR.base * 1000, () => {
      timers.delete(key);
      // A key no source gives by now is already off the page: kept as gone, it would hide the same thing for ever.
      set({ closing: without(state.closing, key), gone: given(key) ? new Set(state.gone).add(key) : state.gone });
    });
  });
}

/** The act failed or he undid it: the row is back as it was. */
export function comeBack(key: string): void {
  clearTimeout(timers.get(key));
  timers.delete(key);
  if (!state.leaving.has(key) && !state.closing.has(key) && !state.gone.has(key)) return;
  set({ leaving: without(state.leaving, key), closing: without(state.closing, key), gone: without(state.gone, key) });
}

/**
 * How often a toast that has not said it left is looked for. Sonner says so
 * for a close, a time that ran out and a dismiss by code, and the page for a
 * press on its action; this is for any way out it missed. A toast he holds
 * under the pointer, or a loading one, is still in the document, and keeps
 * its place until it is not.
 */
const TOAST_MAX_MS = 12_000;
const toastShows = (): boolean => typeof document !== "undefined" && !!document.querySelector("[data-sonner-toast]");

/** One of the page's toasts is up; call what it returns once, when the toast leaves. */
export function toastUp(): () => void {
  let up = true;
  const down = (): void => {
    if (!up) return;
    up = false;
    clearTimeout(timer);
    set({ toastsUp: Math.max(0, state.toastsUp - 1) });
  };
  const look = (): void => {
    if (toastShows()) timer = setTimeout(look, TOAST_MAX_MS);
    else down();
  };
  let timer = setTimeout(look, TOAST_MAX_MS);
  set({ toastsUp: state.toastsUp + 1 });
  return down;
}

// ── what he did to the page ────────────────────────────────────────────────

/** Unfold a section's "N more" or its "N earlier"; they stay open until the window closes. */
export function unfold(which: keyof Folds, section: string): void {
  if (state.folds[which].has(section)) return;
  set({ folds: { ...state.folds, [which]: new Set(state.folds[which]).add(section) } });
}

/** Open the sheet on a held row, by its key; null closes it. A sheet that opens starts a run. */
export function openHeld(key: string | null): void {
  if (state.held === key) return;
  set(state.held === null ? { held: key, heldDone: 0 } : { held: key });
}

/** His press decided the item the sheet shows: the sheet goes on to `next`, one further into the run, or closes after the last. */
export function advanceHeld(next: string | null): void {
  set(next === null ? { held: null } : { held: next, heldDone: state.heldDone + 1 });
}

export const scrollOfToday = (): number => scrollTop;
export function keepScroll(top: number): void {
  scrollTop = top;
}

/** The stop the arrows were on when he left, so the page he comes back to has its focus where it was. */
export const focusOfToday = (): string | null => focusKey;
export function keepFocus(key: string | null): void {
  focusKey = key;
}

/** What else a reset stops (the root that keeps the sources warm: warm.tsx registers it, since it imports this file). */
export const resetHooks = new Set<() => void>();

/** Test and preview seam: the page with these sources in place of the registry's, or as the window first has it. */
export function resetToday(sources?: readonly TodaySource[]): void {
  for (const hook of resetHooks) hook();
  loading = sources ? Promise.resolve() : null;
  scrollTop = 0;
  focusKey = null;
  handed.clear();
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
  set({ sources: (sources ?? []).map((source) => ({ id: source.id, source })), broken: [], pending: [], answers: new Map(), folds: NO_FOLDS, held: null, heldDone: 0, leaving: NONE, closing: NONE, gone: NONE, toastsUp: 0 });
}
