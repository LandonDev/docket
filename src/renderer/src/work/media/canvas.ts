import { defineChunk } from "../../lib/lazyChunk";
import { Media } from "../icons";
import type { CanvasKindDef } from "../canvas/kind";

/**
 * The media kind of canvas item (docs/agents/work-media.md). A stub: its
 * body says "Not built yet" until the media pillar's milestone builds it
 * (`PILLAR_MILESTONE` in src/shared/work/ids.ts), which then points `chunk`
 * at its own module and corrects what the kind claims.
 */
export const mediaCanvas: CanvasKindDef = {
  kind: "media",
  label: "Media",
  icon: Media,
  opens: { sources: [{ at: "frameio" }], mime: ["image/*", "video/*"], ext: ["png", "jpg", "jpeg", "gif", "webp", "mp4", "mov", "webm"] },
  phone: "native",
  guestable: false,
  chunk: defineChunk("work-media-canvas", () => import("../canvas/NotBuilt")),
};
