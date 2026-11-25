/**
 * A line break inside a notes paragraph (Shift+Return in PowerPoint, `a:br`), as the deck tool reads it (python-pptx's
 * vertical tab). Chromium draws it as a box, so wherever notes show it is a line break; a paragraph ends at `\n`.
 */
const BREAK = "\v";
const ENDS = /[\n\v]/g;

/** Notes as they are drawn: each line break inside a paragraph shown as a line break. */
export const notesShown = (notes: string): string => notes.replaceAll(BREAK, "\n");

/**
 * The notes his field now shows, written back with the line breaks they began with: a line between the same lines
 * as before keeps its own kind of end (a break inside a paragraph stays one), and a line he started is a paragraph,
 * as Return makes one in PowerPoint.
 */
export function notesTyped(shown: string, before: string): string {
  const ends: string[] = before.match(ENDS) ?? [];
  const old = before.split(ENDS);
  const lines = shown.split("\n");
  if (!ends.includes(BREAK)) return shown;
  const kept = (k: number): string => {
    // As many lines as before: each end stays where it was.
    if (lines.length === old.length) return ends[k];
    let lead = 0;
    while (lead < Math.min(lines.length, old.length) && lines[lead] === old[lead]) lead += 1;
    if (k < lead && k < ends.length) return ends[k];
    let trail = 0;
    while (trail < Math.min(lines.length, old.length) - lead && lines[lines.length - 1 - trail] === old[old.length - 1 - trail]) trail += 1;
    // The end before a line of the unchanged tail is the one before it was, if a line came before it then.
    const was = old.length - (lines.length - (k + 1));
    return k + 1 >= lines.length - trail && was >= 1 ? ends[was - 1] : "\n";
  };
  return lines.reduce((out, line, k) => (k ? out + kept(k - 1) + line : line), "");
}
