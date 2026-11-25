/**
 * How readily a tab gives up width past what fits, in Files' row (files/TabRow.tsx) and the canvas tab row
 * (CanvasTabs.tsx) alike. The selected tab keeps its whole name (up to the tab's 240px) while any other has room to
 * give; the others give in step with their name's share of the tab, so each loses the same part of its name. Flex
 * takes from each tab in step with its whole width, the glyph and the close's room (about 9 letters) included, which
 * cut a short name ("Events") to a letter while long ones kept most.
 */
export const tabShrink = (name: string, selected = false): number => (selected ? 0 : name.length / (name.length + 9));

/** Where a word starts: after a space, a dash, an underscore, a dot or a bracket. */
const WORD_START = /[\s\-_.()[\]]/;
/** A shared start shorter than this is no reason to cut a name in its middle. */
const SHARED_MIN = 4;

/**
 * Where each open tab's name keeps its end (docs/DESIGN.md "The Files place", decision 13): when tabs share a start
 * ("Purdue Esports Budget.xlsx", "Purdue Esports Roster.xlsx"), a name is cut in its middle so the part that differs
 * stays, from the start of the word where it first differs. Null where nothing is shared, or nothing differs (two
 * files of one name): such a name is cut at its end. The index is into the name, the start of the end kept.
 */
export function tabEnds(names: readonly string[]): (number | null)[] {
  const lower = names.map((name) => name.toLowerCase());
  return lower.map((name, i) => {
    let shared = 0;
    lower.forEach((other, j) => {
      if (j === i) return;
      let at = 0;
      while (at < name.length && at < other.length && name[at] === other[at]) at++;
      shared = Math.max(shared, at);
    });
    if (shared < SHARED_MIN || shared >= name.length) return null;
    let start = shared;
    // Parted at a break ("Events", "Events 2026"): the end kept starts at the next word.
    while (start < name.length - 1 && WORD_START.test(name[start]!)) start++;
    while (start > 0 && !WORD_START.test(name[start - 1]!)) start--;
    // A first word that differs only past its own start ("Report2025", "Report2026") is cut where they part.
    const keep = start > 0 ? start : shared;
    return keep >= SHARED_MIN ? keep : null;
  });
}
