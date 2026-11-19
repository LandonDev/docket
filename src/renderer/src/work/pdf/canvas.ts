import { defineChunk } from "../../lib/lazyChunk";
import { Pdf } from "../icons";
import type { CanvasKindDef } from "../canvas/kind";

/**
 * The pdf kind of canvas item (docs/agents/work-pdf.md). A stub: its
 * body says "Not built yet" until the pdf pillar's milestone builds it
 * (`PILLAR_MILESTONE` in src/shared/work/ids.ts), which then points `chunk`
 * at its own module and corrects what the kind claims.
 */
export const pdfCanvas: CanvasKindDef = {
  kind: "pdf",
  label: "PDF",
  icon: Pdf,
  opens: { mime: ["application/pdf"], ext: ["pdf"] },
  phone: "native",
  guestable: false,
  chunk: defineChunk("work-pdf-canvas", () => import("../canvas/NotBuilt")),
};
