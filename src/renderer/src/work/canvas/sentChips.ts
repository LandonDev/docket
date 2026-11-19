/**
 * The chips a sent message carried, read back from its text
 * (docs/agents/work-canvas.md "Mentions"). A chip goes to the model as a line
 * of its own (`chipLine`, work/canvas/chips.ts): "About this task: Book the
 * ballroom (LifeOS tasks k1)", a selection's words or a mention's excerpt
 * quoted under it. The lines lead the message, or follow it when it opens
 * with a slash command; the transcript draws them as chips and the rest as
 * the person's words. First paint: plain text in, plain text out, nothing of
 * Work's.
 */
export interface SentChip {
  /** the chip's noun as written: "task", "held act" */
  noun: string;
  label: string;
  /** where it points, as written: "LifeOS tasks k1", "canvas item i1", a path */
  ref: string;
}

const HEAD = /^About this ([a-z][a-z ]{0,30}): (.+) \(([^()\n]+)\)$/;
/** What a chip's reference looks like (`refWords`): a LifeOS row, a canvas item, a pillar's row, a path, a source as JSON. Words in brackets that are none of these are his. */
const REF = /^(?:LifeOS [A-Za-z]+ \S+|canvas item \S+|Work [a-z]+ \S+|\/\S.*|\{.*\})$/;

/** Reads chip lines from the start of `lines`; answers the chips and the first line after them, or null when there are none. */
function readChips(lines: readonly string[], from: number): { chips: SentChip[]; next: number } | null {
  const chips: SentChip[] = [];
  let at = from;
  while (at < lines.length) {
    const head = HEAD.exec(lines[at]);
    if (!head || !REF.test(head[3])) break;
    chips.push({ noun: head[1], label: head[2], ref: head[3] });
    at++;
    while (at < lines.length && lines[at].startsWith("> ")) at++;
  }
  return chips.length > 0 ? { chips, next: at } : null;
}

/** A sent message's chips and the words around them. A message with no chip lines answers its text untouched. */
export function sentChipsOf(text: string): { chips: SentChip[]; text: string } {
  if (!text.startsWith("About this ") && !text.includes("\n\nAbout this ")) return { chips: [], text };
  const lines = text.split("\n");
  // Leading: the lines, then a blank line and his words, or nothing more.
  const lead = readChips(lines, 0);
  if (lead && (lead.next === lines.length || lines[lead.next] === "")) {
    return { chips: lead.chips, text: lines.slice(lead.next + 1).join("\n") };
  }
  // After a slash command: his words, a blank line, then the lines to the end.
  if (text.startsWith("/")) {
    // The last blank line that only chip lines follow: his words may hold blank lines of their own.
    for (let blank = lines.lastIndexOf(""); blank > 0; blank = lines.lastIndexOf("", blank - 1)) {
      const tail = readChips(lines, blank + 1);
      if (tail && tail.next === lines.length) return { chips: tail.chips, text: lines.slice(0, blank).join("\n") };
    }
  }
  return { chips: [], text };
}
