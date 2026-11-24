import { defineChunk } from "../../lib/lazyChunk";
import { ListChecks } from "../../chrome/icons";
import { defineCanvasKind, type CanvasKindDef } from "../canvas/kind";
import type { MsFormState } from "./MsFormCanvas";

/**
 * The Microsoft form kind of canvas item (docs/agents/work-msforms.md): the
 * real Forms page in the Office-live guest, and its answers read from the
 * workbook Forms keeps. A form is no file: its source is `{ at: 'msform' }`,
 * and the kind claims it alone. The body is its own chunk; this file rides
 * the canvas chunk, so it stays small.
 */
export const msformCanvas: CanvasKindDef = defineCanvasKind<MsFormState>({
  kind: "msform",
  label: "Microsoft form",
  icon: ListChecks,
  opens: { sources: [{ at: "msform" }] },
  phone: "web",
  guestable: false,
  chunk: defineChunk("work-msforms-canvas", () => import("./MsFormCanvas")),
});
