import { workErrorWords } from "../../lib/workErrorWords";

/**
 * The host's reason a deck has no picture, without the words the state
 * line's own word already says ("There is no picture of the slides: …").
 * Its own small file, so the show reads it without the canvas's chunk.
 */
export function renderDetail(error: string): string {
  const rest = error.replace(/^There is no picture of the slides:\s*/, "");
  return workErrorWords(rest.charAt(0).toUpperCase() + rest.slice(1));
}

/** A show's line where the host's reason is not for him: the deck has no picture, or did not load. */
export const NO_PICTURE = "There is no picture of the slides.";
export const DECK_NOT_LOADED = "The deck did not load.";
