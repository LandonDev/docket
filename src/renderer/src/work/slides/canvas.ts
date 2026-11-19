import { defineChunk } from "../../lib/lazyChunk";
import { Slides } from "../icons";
import type { CanvasKindDef } from "../canvas/kind";

/**
 * The slides kind of canvas item (docs/agents/work-slides.md). A stub: its
 * body says "Not built yet" until the slides pillar's milestone builds it
 * (`PILLAR_MILESTONE` in src/shared/work/ids.ts), which then points `chunk`
 * at its own module and corrects what the kind claims.
 */
export const slidesCanvas: CanvasKindDef = {
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
  chunk: defineChunk("work-slides-canvas", () => import("../canvas/NotBuilt")),
};
