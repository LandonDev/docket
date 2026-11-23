import { defineChunk } from "../../lib/lazyChunk";
import { Slides } from "../icons";
import { defineCanvasKind, type CanvasKindDef } from "../canvas/kind";
import type { SlidesState } from "./SlidesCanvas";

/**
 * The slides kind of canvas item (docs/agents/work-slides.md). The body is
 * its own chunk, with pdf.js behind it: a slide is a page of the PDF the
 * host renders from the deck, including a read-only mirror from Google.
 */
export const slidesCanvas: CanvasKindDef = defineCanvasKind<SlidesState>({
  kind: "slides",
  label: "Slides",
  icon: Slides,
  opens: {
    sources: [{ at: "microsoft", app: "powerpoint" }],
    mime: ["application/vnd.google-apps.presentation", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
    // The kind's row is in the first paint, so the list is said here and takes no import: registry.test.ts holds it to `kindOfEntry`, formats.test.ts to SLIDE_IMPORT_EXTS.
    ext: ["pptx", "ppt", "pps", "ppsx", "odp", "key"],
  },
  phone: "native",
  guestable: false,
  chunk: defineChunk("work-slides-canvas", () => import("./SlidesCanvas")),
});
