import type { DeckSlide, SlideOp, SlideTransition } from "@shared/contract-work-slides";

/**
 * What the Animate tab reads and sets (docs/agents/work-slides.md "The
 * Animate tab"): a slide's transition as a cut, a fade or a push with its
 * side, a press and a wait; its builds as the shapes that come in on a press,
 * in order, each by Appear or by Fade, where that is all the slide's timing
 * holds. Pure.
 */

export type Side = "l" | "r" | "u" | "d";

/** PowerPoint's Effect Options for a push, in its order. A side names where the new slide comes from: `l` moves left, so it comes from the right (show/pictures.tsx). */
export const PUSH_SIDES: ReadonlyArray<{ dir: Side; label: string }> = [
  { dir: "u", label: "From bottom" },
  { dir: "r", label: "From left" },
  { dir: "l", label: "From right" },
  { dir: "d", label: "From top" },
];

export const KINDS = [
  { value: "none", label: "None" },
  { value: "fade", label: "Fade" },
  { value: "push", label: "Push" },
] as const;
export type Kind = (typeof KINDS)[number]["value"];

/** A wait he has not set yet, in seconds: what After takes when he ticks it. */
export const AFTER_FIRST = 5;

/** A slide's transition as the tab holds it: `kind` is the file's own name for one this app does not play. */
export interface Comes {
  kind: Kind | string;
  dir: Side;
  click: boolean;
  /** seconds, or null: it never moves on by itself */
  after: number | null;
}

export function comesOf(t: SlideTransition | undefined): Comes {
  const kind = !t || t.kind === "cut" ? "none" : t.kind;
  const dir = PUSH_SIDES.some((s) => s.dir === t?.dir) ? (t!.dir as Side) : "u";
  return { kind, dir, click: t?.click !== false, after: t?.after !== undefined ? t.after / 1000 : null };
}

/** Whether the app plays it (and the tab can set its timing without replacing it). */
export const played = (kind: string): kind is Kind => KINDS.some((k) => k.value === kind);

/** A name the file uses, as he reads it: "wipe" is "Wipe", "randomBar" is "Random bar". */
export const kindName = (kind: string): string => KINDS.find((k) => k.value === kind)?.label ?? `${kind.charAt(0).toUpperCase()}${kind.slice(1).replace(/([A-Z])/g, (c) => ` ${c.toLowerCase()}`)}`;

/** The one edit that sets it: the whole transition, which replaces what the slide had. */
export function transitionOp(slide: number, c: Comes & { kind: Kind }): SlideOp {
  return { op: "transition", slide, kind: c.kind, ...(c.kind === "push" ? { dir: c.dir } : {}), click: c.click, after: c.after };
}

/** Seconds as he types them: "5", "2.5 s", "2,5"; null for anything else. */
export function parseSeconds(text: string): number | null {
  const m = /^\s*(\d+(?:[.,]\d+)?)\s*(s|sec|secs|seconds?)?\s*$/i.exec(text);
  if (!m) return null;
  const v = Number(m[1].replace(",", "."));
  return v <= 86_400 ? Math.round(v * 100) / 100 : null;
}
export const secondsText = (v: number): string => `${Number(v.toFixed(2))} s`;

/** The reader's reasons a slide is shown whole (src/main/server/work/slides/builds.ts), in his words. */
const WHOLE_WORDS: Record<string, string> = {
  "a trigger": "An effect starts on a press of a shape",
  "a motion path": "A shape moves along a path",
  "an emphasis that changes where things end": "It has an emphasis effect",
  "an entrance or exit that undoes itself": "An effect plays and goes back",
};

/**
 * The slide's builds as the tab can set them: the order and those of it that fade in, where a `builds` edit would
 * write back just that (`SlideBuilds.order`, or no builds at all); else why they are PowerPoint's, and whether he
 * may take them out (not on a slide with a video or a sound, whose own timing goes with them).
 */
export type BuildsHold = { order: number[]; fade: number[] } | { why: string; replace: boolean };

export function buildsHold(slide: DeckSlide): BuildsHold {
  const b = slide.builds;
  if (b?.order) return { order: b.order, fade: b.fade ?? [] };
  const media = slide.shapes.find((s) => s.kind === "media");
  if (media) return { why: media.media === "audio" ? "It holds a sound" : "It holds a video", replace: false };
  if (!b) return { order: [], fade: [] };
  return { why: buildsWhy(b), replace: true };
}

/** The one edit that sets the builds: the whole order, each shape still in it keeping its Fade. */
export function buildsOp(slide: number, order: readonly number[], fade: readonly number[]): SlideOp {
  const fading = order.filter((id) => fade.includes(id));
  return { op: "builds", slide, order: [...order], ...(fading.length ? { fade: fading } : {}) };
}

function buildsWhy(b: NonNullable<DeckSlide["builds"]>): string {
  if (b.whole) return WHOLE_WORDS[b.whole] ?? "Its timing is more than this app reads";
  if (b.steps.some((s) => s.paras.length)) return "Its text comes in a paragraph at a time";
  for (let k = 1; k < b.steps.length; k++) {
    const was = new Set(b.steps[k - 1].shapes);
    if (b.steps[k].shapes.some((id) => !was.has(id))) return "A shape leaves on a press";
    if (was.size - b.steps[k].shapes.length > 1) return "More than one shape comes in on a press";
  }
  return "Its effects are more than appear or fade on click";
}

/** The shapes he may add: on the slide, in no group (PowerPoint builds a group as one), not yet in the list. */
export const addable = (slide: DeckSlide, order: readonly number[]) => slide.shapes.filter((s) => s.group === undefined && !order.includes(s.id));

/** The order with one shape moved by `by` places, kept inside the list. */
export function moved(order: readonly number[], id: number, by: number): number[] {
  const from = order.indexOf(id);
  const to = Math.max(0, Math.min(order.length - 1, from + by));
  if (from < 0 || to === from) return [...order];
  const next = order.filter((x) => x !== id);
  next.splice(to, 0, id);
  return next;
}
