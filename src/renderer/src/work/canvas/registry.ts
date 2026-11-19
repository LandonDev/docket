import { CANVAS_KINDS, type CanvasKind, type CanvasSource } from "@shared/work";
import type { CanvasKindDef } from "./kind";
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
