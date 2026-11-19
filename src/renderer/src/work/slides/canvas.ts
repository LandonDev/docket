import { defineChunk } from "../../lib/lazyChunk";
import { Slides } from "../icons";
import { defineCanvasKind, type CanvasKindDef } from "../canvas/kind";
import type { SlidesState } from "./SlidesCanvas";

/**
 * The slides kind of canvas item (docs/agents/work-slides.md). The body is
 * its own chunk, with pdf.js behind it: a slide is a page of the PDF the
 * host renders from the deck. A Google deck is milestone 30's: the host
 * refuses it with a sentence.
 */
export const slidesCanvas: CanvasKindDef = defineCanvasKind<SlidesState>({
  kind: "slides",
  label: "Slides",
  icon: Slides,
  opens: {
    sources: [{ at: "microsoft", app: "powerpoint" }],
    mime: ["application/vnd.google-apps.presentation", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
    ext: ["pptx"],
  },
  phone: "native",
  guestable: false,
  chunk: defineChunk("work-slides-canvas", () => import("./SlidesCanvas")),
});
