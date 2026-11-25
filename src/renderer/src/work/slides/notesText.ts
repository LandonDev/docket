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
 * as Return makes one in PowerPoint. Each old end is kept at most once: Return beside a break keeps the break on one
 * side and makes a paragraph on the other, never two breaks.
 */
export function notesTyped(shown: string, before: string): string {
  const ends: string[] = before.match(ENDS) ?? [];
  const old = before.split(ENDS);
  const lines = shown.split("\n");
  if (!ends.includes(BREAK)) return shown;
  // As many lines as before: each end stays where it was.
  if (lines.length === old.length) return lines.reduce((out, line, k) => (k ? out + ends[k - 1] + line : line), "");
  // The lines unchanged at the head and at the tail; what he typed lies between.
  let lead = 0;
  while (lead < Math.min(lines.length, old.length) && lines[lead] === old[lead]) lead += 1;
  let trail = 0;
  while (trail < Math.min(lines.length, old.length) - lead && lines[lines.length - 1 - trail] === old[old.length - 1 - trail]) trail += 1;
  const tail = lines.length - trail;
  /** The end after line `k`, between it and line `k + 1`. */
  const kept = (k: number): string => {
    // Within the head, or within the tail: the end it had.
    if (k + 1 < lead) return ends[k]!;
    if (k >= tail) return ends[k - (lines.length - old.length)]!;
    // After the head's last line: the end that followed it.
    if (k === lead - 1) return ends[k] ?? "\n";
    // Before the tail's first line: the end that came before it, unless the head's last line took that one.
    const was = old.length - trail - 1;
    if (k + 1 === tail && was >= 0 && was !== lead - 1) return ends[was]!;
    return "\n";
  };
  return lines.reduce((out, line, k) => (k ? out + kept(k - 1) + line : line), "");
}
