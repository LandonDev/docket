import { CANVAS_KINDS, type CanvasKind, type CanvasSource } from "@shared/work";
import type { CanvasKindDef } from "./kind";
import { defineChunk } from "../../lib/lazyChunk";
import { File } from "../icons";
import { mailCanvas } from "../mail/canvas";
import { documentCanvas } from "../docs/canvas";
import { sheetCanvas } from "../sheets/canvas";
import { pdfCanvas } from "../pdf/canvas";
import { slidesCanvas } from "../slides/canvas";
import { mediaCanvas } from "../media/canvas";
import { browserCanvas } from "../browser/canvas";
import { historyCanvas } from "../history/canvas";
import { meetingCanvas } from "../meetings/canvas";
import { formCanvas } from "../forms/canvas";
import { dashboardCanvas } from "../dashboards/canvas";

export type * from "./kind";
export { defineCanvasKind } from "./kind";

/**
 * The canvas pane's kinds (docs/agents/work-canvas.md): the eleven kinds of
 * item a thread can hold beside it, one definition each, in the folder of
 * the pillar that owns it (`work/<pillar>/canvas.ts`). The pane
 * (CanvasPane.tsx) draws the frame every kind shares, the tab row, the
 * kind's bar and the selection bar, and a kind fills the body and feeds the
 * frame through `CanvasShell`. A pillar fills its own file and edits
 * nothing here.
 */

/** Every kind, once. A missing kind fails typecheck. */
export const CANVAS: Record<CanvasKind, CanvasKindDef> = {
  mail: mailCanvas,
  document: documentCanvas,
  sheet: sheetCanvas,
  pdf: pdfCanvas,
  slides: slidesCanvas,
  media: mediaCanvas,
  browser: browserCanvas,
  history: historyCanvas,
  meeting: meetingCanvas,
  form: formCanvas,
  dashboard: dashboardCanvas,
};

/**
 * What stands in for a kind this build does not know. A host a release ahead may hold an item of a kind added
 * since (its window made it, and the list is the host's): the tab row draws it as a file by its name and the pane
 * says to update, so the other tabs stay usable. It claims nothing, has no bar and no History.
 */
const UNKNOWN_KIND: Omit<CanvasKindDef, "kind"> = {
  label: "File",
  icon: File,
  opens: {},
  phone: "native",
  guestable: false,
  chunk: defineChunk("work-canvas-unknown", () => import("./UnknownKind")),
};
const unknown = new Map<string, CanvasKindDef>();

/** The kind's definition, or the stand-in for one this build does not know: every lookup by an item's kind goes through here. */
export function kindDefOf(kinds: Record<CanvasKind, CanvasKindDef>, kind: CanvasKind): CanvasKindDef {
  if (knowsKind(kinds, kind)) return kinds[kind];
  let stand = unknown.get(kind);
  if (!stand) unknown.set(kind, (stand = { ...UNKNOWN_KIND, kind }));
  return stand;
}
/** Whether this build draws the kind. */
export const knowsKind = (kinds: Record<CanvasKind, CanvasKindDef>, kind: CanvasKind): boolean => Object.hasOwn(kinds, kind);

/** What is known of a thing to open, beyond its source. */
export interface OpenHint {
  mime?: string;
  /** A file name or path; its extension is read. */
  name?: string;
}

const extensionOf = (name: string): string => {
  const base = name.slice(Math.max(name.lastIndexOf("/"), name.lastIndexOf("\\")) + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
};

const claimsSource = (def: CanvasKindDef, source: CanvasSource): boolean =>
  (def.opens.sources ?? []).some(
    (claim) =>
      claim.at === source.at &&
      (claim.app === undefined || (source.at === "microsoft" && source.app === claim.app)) &&
      (claim.table === undefined || (source.at === "lifeos" && source.table === claim.table)),
  );

/**
 * The kind that opens a source: the one that claims the source itself (a
 * Microsoft file goes to the kind of its Office app, a LifeOS row to the
 * kind of its table, a browser session to the browser), else the one that
 * claims the mime type, else the one that claims the file's extension; null
 * when no kind does. Kinds are asked in `CANVAS_KINDS`' order.
 */
export function kindFor(source: CanvasSource, hint: OpenHint = {}, kinds: Record<CanvasKind, CanvasKindDef> = CANVAS): CanvasKind | null {
  const defs = CANVAS_KINDS.map((kind) => kinds[kind]);
  const bySource = defs.find((def) => claimsSource(def, source));
  if (bySource) return bySource.kind;
  const mime = (hint.mime ?? (source.at === "google" ? source.mime : "")).toLowerCase();
  // `image/*` claims every image type.
  const byMime = mime ? defs.find((def) => (def.opens.mime ?? []).some((m) => (m.endsWith("/*") ? mime.startsWith(m.slice(0, -1)) : m === mime))) : undefined;
  if (byMime) return byMime.kind;
  const name = hint.name ?? (source.at === "file" ? source.path : "");
  const ext = name ? extensionOf(name) : "";
  return (ext ? defs.find((def) => (def.opens.ext ?? []).includes(ext)) : undefined)?.kind ?? null;
}

/**
 * The kind that shows a file, by its extension, or by its mime type when the
 * name has none; null when no kind does. The one lookup for a file from
 * outside: a drop, Open file…, a mail's attachment. The type a desktop or a
 * mail gives is a guess from the name (a `.ts` script comes as `video/mp2t`,
 * a `.csv` from Windows as `application/vnd.ms-excel`), so it never
 * overrules one.
 */
export function kindForFile(name: string, mime?: string, kinds: Record<CanvasKind, CanvasKindDef> = CANVAS): CanvasKind | null {
  if (extensionOf(name)) return kindFor({ at: "file", host: "", path: name }, {}, kinds);
  return mime ? kindFor({ at: "thread" }, { mime }, kinds) : null;
}
