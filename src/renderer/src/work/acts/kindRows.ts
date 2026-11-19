/**
 * The kinds that keep the generic view, read in his words beside the generic
 * reader (outbox/model.ts `payloadView`): a form's publish, a Google share, a
 * Frame.io comment or version, a Teams post, a computer act. Each says what goes and nothing
 * the host keeps for itself: no ids, revisions, paths or raw JSON. A kind not
 * named here falls back to `payloadView`.
 */

export type KindRows = { fields: { label: string; value: string }[]; body: string | null };

type Rec = Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const row = (label: string, value: string | null) => (value === null ? [] : [{ label, value }]);

const ACCESS: Record<string, string> = { reader: "Can view", commenter: "Can comment", writer: "Can edit" };
const MB = 1024 * 1024;
/** "700 MB", "1.5 MB": whole above 100 MB, one place below. */
export const megabytes = (bytes: number): string => `${(bytes / MB).toFixed(bytes >= 100 * MB ? 0 : 1)} MB`;

const SHAPE: Record<string, [string, string]> = { rect: ["a box", "boxes"], ellipse: ["an oval", "ovals"], line: ["a line", "lines"], arrow: ["an arrow", "arrows"], pen: ["a drawn line", "drawn lines"] };
/** What Frame.io cannot draw as drawn, said as the host's post makes it (frameio/map.ts `annotationOf`). */
const LOSSY: Record<string, string> = { ellipse: "an oval as its box", pen: "a drawn line as straight lines" };

/** A comment's marks in words ("a pin, 2 boxes and an oval"), and what Frame.io draws otherwise ("an oval as its box"). */
export function marksWords(pin: unknown, shapes: unknown): { words: string | null; changes: string | null } {
  const counts = new Map<string, number>();
  for (const s of Array.isArray(shapes) ? shapes : []) {
    const tool = (s as { tool?: unknown } | null)?.tool;
    if (typeof tool === "string") counts.set(tool, (counts.get(tool) ?? 0) + 1);
  }
  const parts = [...(pin && typeof pin === "object" ? ["a pin"] : []), ...[...counts].map(([tool, n]) => (n === 1 ? (SHAPE[tool]?.[0] ?? `a ${tool}`) : `${n} ${SHAPE[tool]?.[1] ?? `${tool}s`}`))];
  const words = parts.length ? (parts.length === 1 ? parts[0]! : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`) : null;
  const lossy = [...counts.keys()].flatMap((tool) => (LOSSY[tool] ? [LOSSY[tool]] : []));
  const cap = (t: string | null) => (t ? t[0]!.toUpperCase() + t.slice(1) : null);
  return { words: cap(words), changes: cap(lossy.join("; ") || null) };
}

export function kindRows(kind: string, payload: unknown): KindRows | null {
  const p = (payload && typeof payload === "object" ? payload : {}) as Rec;
  switch (kind) {
    case "form.publish": {
      const n = num(p.questions);
      return { fields: [...row("Form", str(p.title)), ...row("Questions", n === null ? null : String(n))], body: str(p.content) };
    }
    case "share.google": {
      const role = str(p.role);
      return {
        fields: [
          ...row("Person", str(p.email)),
          ...row("Access", role ? (ACCESS[role] ?? role) : null),
          // The Google account the file is shared from: the one place it is said.
          ...row("Account", str(p.account)),
          ...(p.notify === true ? [{ label: "Notice", value: "Tells them by mail" }] : []),
        ],
        body: null,
      };
    }
    case "frameio.post": {
      if (p.what === "version") {
        const size = num(p.size);
        return {
          fields: [...row("On top of", str(p.ontoName)), ...row("File", str(p.name)), ...row("Size", size === null ? null : megabytes(size)), ...row("From", str(p.from))],
          body: null,
        };
      }
      const span = num(p.durationFrames);
      const at = str(p.clock);
      const marks = marksWords(p.pin, p.shapes);
      return {
        fields: [
          ...row("File", str(p.fileName)),
          ...row("At", at ? (span && span > 1 ? `${at}, for ${span} frames` : at) : null),
          ...row("Marks", marks.words),
          ...row("Goes as", marks.changes),
        ],
        body: str(p.text),
      };
    }
    case "teams.post":
      // The post is the body at any length; with html beside it, the generic reader reads the html, which is what goes.
      return typeof p.html === "string" ? null : { fields: row("In", str(p.chat)), body: str(p.text) };
    case "computer.act": {
      // What he approves: the app and window it acts in, the page, and what the step lands on. The title is the heading,
      // the label the Send button, and the raw arguments (an index, coordinates) say nothing the kept picture does not.
      const app = p.app && typeof p.app === "object" ? str((p.app as Rec).name) : str(p.app);
      const args = (p.args && typeof p.args === "object" ? p.args : {}) as Rec;
      const read = (p.read && typeof p.read === "object" ? p.read : {}) as Rec;
      return { fields: [...row("App", app), ...row("Window", str(p.window)), ...row("URL", str(args.url)), ...row("On", str(read.on))], body: null };
    }
    default:
      return null;
  }
}
