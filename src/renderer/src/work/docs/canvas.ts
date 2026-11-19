import { defineChunk } from "../../lib/lazyChunk";
import { Doc } from "../icons";
import type { CanvasKindDef } from "../canvas/kind";

/**
 * The document kind of canvas item (docs/agents/work-docs.md). A stub: its
 * body says "Not built yet" until the docs pillar's milestone builds it
 * (`PILLAR_MILESTONE` in src/shared/work/ids.ts), which then points `chunk`
 * at its own module and corrects what the kind claims.
 */
export const documentCanvas: CanvasKindDef = {
  kind: "document",
  label: "Document",
  icon: Doc,
  opens: {
    sources: [{ at: "lifeos", table: "docs" }, { at: "lifeos", table: "projectDocs" }, { at: "microsoft", app: "word" }],
    mime: ["application/vnd.google-apps.document", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
    ext: ["tcdoc", "docx"],
  },
  phone: "web",
  guestable: true,
  chunk: defineChunk("work-docs-canvas", () => import("../canvas/NotBuilt")),
};
