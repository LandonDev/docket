import { defineChunk } from "../../lib/lazyChunk";
import { Mic } from "../icons";
import type { CanvasKindDef } from "../canvas/kind";

/**
 * The meeting kind of canvas item (docs/agents/work-meetings.md). A stub: its
 * body says "Not built yet" until the meetings pillar's milestone builds it
 * (`PILLAR_MILESTONE` in src/shared/work/ids.ts), which then points `chunk`
 * at its own module and corrects what the kind claims.
 */
export const meetingCanvas: CanvasKindDef = {
  kind: "meeting",
  label: "Meeting",
  icon: Mic,
  opens: { mime: ["audio/*"], ext: ["mp3", "m4a", "wav"] },
  phone: "native",
  guestable: false,
  chunk: defineChunk("work-meetings-canvas", () => import("../canvas/NotBuilt")),
};
