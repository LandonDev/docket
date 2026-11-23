/**
 * What a show plays of a deck's effects (docs/agents/work-slides.md "The show"). No zod here and no value import,
 * so the deck's window may take these without adding to the first paint (renderer work/pdf/firstPaint.test.ts);
 * the host reads the same through contract-work-slides.ts.
 */

/** The transitions the show plays (a fade, a push) or that are none (a cut): every other counts in `ShowDeck.changed`. */
export const SHOW_PLAYED_TRANSITIONS: ReadonlySet<string> = new Set(['fade', 'push', 'cut', 'none'])
/** How many effects and transitions of these slides the show plays otherwise or leaves out: `ShowDeck.changed`, from an outline. */
export const effectsChanged = (slides: ReadonlyArray<{ builds?: { changed: number }; transition?: { kind: string } }>): number =>
  slides.reduce((n, s) => n + (s.builds?.changed ?? 0) + (s.transition && !SHOW_PLAYED_TRANSITIONS.has(s.transition.kind) ? 1 : 0), 0)
