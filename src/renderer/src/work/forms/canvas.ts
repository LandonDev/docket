import { defineChunk } from "../../lib/lazyChunk";
import { ListChecks } from "../../chrome/icons";
import type { CanvasKindDef } from "../canvas/kind";

/**
 * The form kind of canvas item (docs/agents/work-forms.md). A stub: its
 * body says "Not built yet" until the forms pillar's milestone builds it
 * (`PILLAR_MILESTONE` in src/shared/work/ids.ts), which then points `chunk`
 * at its own module and corrects what the kind claims.
 */
export const formCanvas: CanvasKindDef = {
  kind: "form",
  label: "Form",
  icon: ListChecks,
  opens: { ext: ["tcform"] },
  phone: "web",
  guestable: false,
  chunk: defineChunk("work-forms-canvas", () => import("../canvas/NotBuilt")),
};
