/**
 * A line break inside a notes paragraph (Shift+Return in PowerPoint, `a:br`), as the deck tool reads it (python-pptx's
 * vertical tab). Chromium draws it as a box, so wherever notes show it is a line break; a paragraph ends at `\n`.
 */
const BREAK = "\v";
const ENDS = /[\n\v]/g;

/** Notes as they are drawn: each line break inside a paragraph shown as a line break. */
export const notesShown = (notes: string): string => notes.replaceAll(BREAK, "\n");

/**
 * The notes his field now shows, written back with the line breaks they began with. A break is one letter shown as
 * one, so the field's text and the notes match letter for letter: what lies before and after his edit is kept as it
 * was, and only the part he changed is read again (`linesTyped`). `caret`, the field's caret after the edit, says
 * where the edit ends, so Return just before a break makes its paragraph there (`first\n\vsecond`) and just after it
 * there (`first\v\nsecond`), though the field shows both alike; with none the edit is read as late as it can be.
 */
export function notesTyped(shown: string, before: string, caret?: number): string {
  if (!before.includes(BREAK)) return shown;
  const was = notesShown(before);
  const most = Math.min(shown.length, was.length);
  // The text after the caret is the old text's tail, unless the edit was not at the caret (undo, a drop).
  const after = caret === undefined ? -1 : shown.length - caret;
  const atCaret = after >= 0 && after <= was.length && shown.endsWith(was.slice(was.length - after));
  let lead = 0;
  const leadMax = atCaret ? Math.min(caret!, was.length - after) : most;
  while (lead < leadMax && shown[lead] === was[lead]) lead += 1;
  let trail = atCaret ? after : 0;
  if (!atCaret) while (trail < most - lead && shown[shown.length - 1 - trail] === was[was.length - 1 - trail]) trail += 1;
  return before.slice(0, lead) + linesTyped(shown.slice(lead, shown.length - trail), before.slice(lead, before.length - trail)) + before.slice(before.length - trail);
}

/**
 * The part he changed, written back line by line: a line between the same lines as before keeps its own kind of end
 * (a break inside a paragraph stays one), and a line he started is a paragraph, as Return makes one in PowerPoint. Each
 * old end is kept at most once: never two breaks where he made one paragraph.
 */
function linesTyped(shown: string, before: string): string {
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
