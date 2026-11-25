import type { DeckShape, DeckSlide, DeckView } from "@shared/contract-work-slides";

/**
 * Find on a deck's words (docs/agents/work-slides.md "Find"), pure: every
 * place a query stands in the slides' shapes and their notes, in the order
 * PowerPoint's Find walks them (slide by slide; on a slide its shapes back
 * to front, then its notes), and the count he reads. It reads the outline
 * the view already holds: nothing is asked of the host, and nothing is
 * changed.
 */

export type FindOptions = { matchCase: boolean; wholeWord: boolean };

/** One place the query stands: on a slide (by its key), in a shape (by its id) or in the notes (`shape` null), `at` characters in. */
export interface DeckMatch {
  slideKey: string;
  shape: number | null;
  at: number;
  length: number;
}

/** More than this many and the count says "1,000+": a deck is seldom that long, and stepping stays quick. */
export const FIND_CAP = 1000;

const wordChar = (c: string | undefined): boolean => !!c && /[\p{L}\p{N}_]/u.test(c);

/** Each place `query` stands in `words`, as offsets into `words`. */
export function placesIn(words: string, query: string, options: FindOptions, limit = FIND_CAP): number[] {
  if (!query || !words) return [];
  const hay = options.matchCase ? words : words.toLowerCase();
  const needle = options.matchCase ? query : query.toLowerCase();
  // Lower-casing can change a length (İ); then the offsets would not be the words' own, so the words are matched as they are.
  const [h, n] = hay.length === words.length && needle.length === query.length ? [hay, needle] : [words, query];
  const out: number[] = [];
  for (let at = h.indexOf(n); at >= 0 && out.length < limit; at = h.indexOf(n, at + n.length)) {
    if (options.wholeWord && (wordChar(words[at - 1]) || wordChar(words[at + n.length]))) continue;
    out.push(at);
  }
  return out;
}

/** The slides find walks: the deck's as he sees it in the strip, a slide a suggestion takes out left out. */
const slidesOf = (view: DeckView): DeckSlide[] => view.slides.filter((s) => s.tint !== "del");

/** A shape's words as find reads them: a table's cell by cell, else its own. */
const wordsOf = (shape: DeckShape): string => (shape.cells ? shape.cells.map((row) => row.join("\t")).join("\n") : shape.text);

/** Every match of `query` in the deck, in find's order, and whether there were more than the cap. */
export function deckMatches(view: DeckView | null, query: string, options: FindOptions): { matches: DeckMatch[]; capped: boolean } {
  const matches: DeckMatch[] = [];
  if (!view || !query) return { matches, capped: false };
  const add = (slideKey: string, shape: number | null, words: string): boolean => {
    for (const at of placesIn(words, query, options, FIND_CAP + 1 - matches.length)) matches.push({ slideKey, shape, at, length: query.length });
    return matches.length > FIND_CAP;
  };
  for (const slide of slidesOf(view)) {
    for (const shape of slide.shapes) if (add(slide.key, shape.id, wordsOf(shape))) return { matches: matches.slice(0, FIND_CAP), capped: true };
    if (add(slide.key, null, slide.notes)) return { matches: matches.slice(0, FIND_CAP), capped: true };
  }
  return { matches, capped: false };
}

/** The match find starts on: the first on the slide on the stage or after it, else the deck's first. */
export function firstFrom(view: DeckView | null, matches: DeckMatch[], slideKey: string | null): number {
  if (!view || matches.length === 0) return -1;
  const order = slidesOf(view).map((s) => s.key);
  const from = Math.max(0, order.indexOf(slideKey ?? ""));
  const at = matches.findIndex((m) => order.indexOf(m.slideKey) >= from);
  return at < 0 ? 0 : at;
}

/** The count as he reads it, in the document's words: "3 of 17", "No results", or nothing before he types. */
export function findCount(query: string, total: number, current: number, capped: boolean): string {
  if (query === "") return "";
  if (total === 0) return "No results";
  return `${(Math.max(current, 0) + 1).toLocaleString("en-US")} of ${total.toLocaleString("en-US")}${capped ? "+" : ""}`;
}
