import type { ShowSlide } from "@shared/contract-work-slides";
import { chordKey } from "../../../lib/keys";

/**
 * A show's state and its keys (docs/DESIGN.md "The show"; the key table is
 * shared.md's): which slide, which build of it, blank, the end, and the
 * number being typed. Pure, so the slideshow, the presenter's view and a
 * clicker all move one state and cannot disagree.
 */

/** A slide of a show; `builds` is how many presses it takes before the next slide (none until the host reads a deck's timing). */
export type Slide = ShowSlide & { builds?: number };

export interface ShowState {
  slides: Slide[];
  /** the slide shown, by its place in `slides` */
  at: number;
  /** how many of the slide's builds are shown */
  step: number;
  /** the screen is black; the slide is still under it */
  blank: boolean;
  /** past the last slide: "End of show", and one more press closes */
  ended: boolean;
  /** the show is over: its windows go */
  closed: boolean;
  /** digits typed, waiting for Return to jump */
  typed: string;
  /** the slide picker is open */
  picker: boolean;
}

export type ShowAct =
  | { t: "next" }
  | { t: "prev" }
  | { t: "first" }
  | { t: "last" }
  /** a slide by its number in the deck, hidden or not */
  | { t: "goto"; number: number }
  | { t: "digit"; digit: string }
  /** Return: the slide whose number was typed, else the next press */
  | { t: "enter" }
  | { t: "blank" }
  | { t: "picker"; open?: boolean }
  /** Escape: closes the picker first, then the show */
  | { t: "escape" }
  | { t: "end" }
  /** the file changed under the show: its slides again, the place kept by the slide's id */
  | { t: "deck"; slides: Slide[] };

const buildsOf = (slide: Slide | undefined): number => Math.max(0, slide?.builds ?? 0);
const clamp = (n: number, low: number, high: number): number => Math.min(high, Math.max(low, n));

/** The next slide a press reaches from `from`, in a direction, passing hidden ones; -1 when there is none. */
function shownFrom(slides: readonly Slide[], from: number, by: 1 | -1): number {
  for (let i = from + by; i >= 0 && i < slides.length; i += by) if (!slides[i].hidden) return i;
  return -1;
}

/** Where a show starts: the first slide he would reach, or the slide he is on (hidden or not). */
export function startShowState(slides: Slide[], from: "start" | number): ShowState {
  const first = shownFrom(slides, -1, 1);
  const asked = from === "start" ? -1 : slides.findIndex((s) => s.id === from);
  return { slides, at: asked >= 0 ? asked : Math.max(0, first), step: 0, blank: false, ended: false, closed: false, typed: "", picker: false };
}

const show = (state: ShowState, at: number, step = 0): ShowState => ({ ...state, at, step, blank: false, ended: false, typed: "", picker: false });

export function showReducer(state: ShowState, act: ShowAct): ShowState {
  if (state.closed) return state;
  switch (act.t) {
    case "next": {
      // A black screen comes back to the slide it hid; the press does nothing more.
      if (state.blank) return { ...state, blank: false, typed: "" };
      if (state.ended) return { ...state, closed: true };
      if (state.step < buildsOf(state.slides[state.at])) return { ...state, step: state.step + 1, typed: "" };
      const to = shownFrom(state.slides, state.at, 1);
      return to < 0 ? { ...state, ended: true, typed: "", picker: false } : show(state, to);
    }
    case "prev": {
      if (state.blank) return { ...state, blank: false, typed: "" };
      // Back from the end is the last slide as it was left, whole.
      if (state.ended) return state.slides.length ? { ...state, ended: false, typed: "" } : state;
      if (state.step > 0) return { ...state, step: state.step - 1, typed: "" };
      const to = shownFrom(state.slides, state.at, -1);
      return to < 0 ? { ...state, typed: "" } : show(state, to, buildsOf(state.slides[to]));
    }
    case "first": {
      const to = shownFrom(state.slides, -1, 1);
      return to < 0 ? state : show(state, to);
    }
    case "last": {
      const to = shownFrom(state.slides, state.slides.length, -1);
      return to < 0 ? state : show(state, to);
    }
    case "goto":
      return state.slides.length && Number.isFinite(act.number) ? show(state, clamp(Math.round(act.number), 1, state.slides.length) - 1) : state;
    case "digit":
      return /^\d$/.test(act.digit) ? { ...state, typed: (state.typed + act.digit).slice(-4) } : state;
    case "enter":
      return state.typed ? showReducer({ ...state, typed: "" }, { t: "goto", number: Number(state.typed) }) : showReducer(state, { t: "next" });
    case "blank":
      return state.ended ? state : { ...state, blank: !state.blank, typed: "", picker: false };
    case "picker":
      return { ...state, picker: act.open ?? !state.picker, typed: "" };
    case "escape":
      return state.picker ? { ...state, picker: false } : { ...state, closed: true };
    case "end":
      return { ...state, closed: true };
    case "deck": {
      const id = state.slides[state.at]?.id;
      const kept = act.slides.findIndex((s) => s.id === id);
      const at = kept >= 0 ? kept : clamp(state.at, 0, Math.max(0, act.slides.length - 1));
      return { ...state, slides: act.slides, at, step: kept >= 0 ? Math.min(state.step, buildsOf(act.slides[at])) : 0, ended: state.ended || act.slides.length === 0 };
    }
  }
}

/** What the next press shows: a build of this slide, another slide, the end, or (at the end) the show closing. */
export type NextPress = { kind: "build"; at: number; step: number; of: number } | { kind: "slide"; at: number } | { kind: "end" } | { kind: "close" };

export function nextPress(state: ShowState): NextPress {
  if (state.ended) return { kind: "close" };
  const builds = buildsOf(state.slides[state.at]);
  if (state.step < builds) return { kind: "build", at: state.at, step: state.step + 1, of: builds };
  const to = shownFrom(state.slides, state.at, 1);
  return to < 0 ? { kind: "end" } : { kind: "slide", at: to };
}

/** "4 / 12": the slide's number in the deck over the deck's count, hidden slides counted. */
export function placeText(state: ShowState): string {
  const slide = state.slides[state.at];
  return slide ? `${slide.number} / ${state.slides.length}` : "";
}

/** The place as a screen reader says it: "Slide 4 of 12, Packages", "End of show", "The screen is black". */
export function placeLabel(state: ShowState): string {
  const slide = state.slides[state.at];
  if (state.ended) return "End of show";
  if (!slide) return "";
  return `${state.blank ? "The screen is black. " : ""}Slide ${slide.number} of ${state.slides.length}${slide.title ? `, ${slide.title}` : ""}`;
}

/** What a key does in a show's window. `swallow` is a key the show takes so nothing else acts on it (a clicker's F5 would reload a browser). */
export type KeyAct = ShowAct | { t: "notes"; by: 1 | -1 } | { t: "swallow" };

/** A key press as the one key map reads it (lib/keys.ts). */
export type KeyLike = Parameters<typeof chordKey>[0] & { key: string };

/**
 * Every key a clicker sends is here (PageDown, PageUp, B or ".", Escape,
 * F5). A key held with ⌘, Ctrl or Alt is the window's, not the show's.
 * While the picker is open the arrows and Return are its own.
 */
export function keyAct(event: KeyLike, state: Pick<ShowState, "picker">): KeyAct | null {
  if (chordKey(event)) return null;
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  if (key === "Escape") return { t: "escape" };
  if (key === "g") return { t: "picker" };
  if (key === "F5") return { t: "swallow" };
  if (state.picker) return null;
  switch (key) {
    case "ArrowRight":
    case "ArrowDown":
    case " ":
    case "PageDown":
    case "n":
      return { t: "next" };
    case "Enter":
      return { t: "enter" };
    case "ArrowLeft":
    case "ArrowUp":
    case "PageUp":
    case "Backspace":
    case "p":
      return { t: "prev" };
    case "Home":
      return { t: "first" };
    case "End":
      return { t: "last" };
    case "b":
    case ".":
      return { t: "blank" };
    case "+":
    case "=":
      return { t: "notes", by: 1 };
    case "-":
      return { t: "notes", by: -1 };
  }
  return /^\d$/.test(key) ? { t: "digit", digit: key } : null;
}

/** The sizes a presenter's notes take, with their line heights; the stepper and + and − walk them. */
export const NOTES_SIZES = [
  [14, 22],
  [16, 24],
  [18, 28],
  [20, 30],
  [24, 34],
  [28, 40],
] as const;
export const NOTES_DEFAULT = 3;
export const stepNotes = (index: number, by: 1 | -1): number => clamp(index + by, 0, NOTES_SIZES.length - 1);
