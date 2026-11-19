/**
 * The kinds that keep the generic view, read in his words beside the generic
 * reader (outbox/model.ts `payloadView`): a form's publish, a Google share, a
 * Frame.io comment or version, a Teams post. Each says what goes and nothing
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
        fields: [...row("Person", str(p.email)), ...row("Access", role ? (ACCESS[role] ?? role) : null), ...(p.notify === true ? [{ label: "Notice", value: "Tells them by mail" }] : [])],
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
      const shapes = Array.isArray(p.shapes) ? p.shapes.length : 0;
      return {
        fields: [...row("File", str(p.fileName)), ...row("At", str(p.clock)), ...(shapes ? [{ label: "Marks", value: `${shapes} ${shapes === 1 ? "shape" : "shapes"}` }] : [])],
        body: str(p.text),
      };
    }
    case "teams.post":
      // The post is the body at any length; with html beside it, the generic reader reads the html, which is what goes.
      return typeof p.html === "string" ? null : { fields: row("In", str(p.chat)), body: str(p.text) };
    default:
      return null;
  }
}
