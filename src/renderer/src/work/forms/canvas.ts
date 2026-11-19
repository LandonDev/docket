import { defineChunk } from "../../lib/lazyChunk";
import { ListChecks } from "../../chrome/icons";
import { defineCanvasKind, type CanvasKindDef } from "../canvas/kind";
import type { FormState } from "./FormCanvas";

/**
 * The form kind of canvas item (docs/agents/work-forms.md): a form a thread
 * made, its questions and its responses. The body is its own chunk; this
 * file rides the canvas chunk, so it stays small. A form lives in the host's
 * row behind the item (`{ at: 'thread' }`), so the kind claims no file.
 */
export const formCanvas: CanvasKindDef = defineCanvasKind<FormState>({
  kind: "form",
  label: "Form",
  icon: ListChecks,
  opens: {},
  phone: "web",
  guestable: false,
  chunk: defineChunk("work-forms-canvas", () => import("./FormCanvas")),
});
