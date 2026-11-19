import { defineChunk } from "../../lib/lazyChunk";
import { Globe } from "../../chrome/icons";
import type { CanvasKindDef } from "../canvas/kind";

/**
 * The browser kind of canvas item (docs/agents/work-browser.md). A stub: its
 * body says "Not built yet" until the browser pillar's milestone builds it
 * (`PILLAR_MILESTONE` in src/shared/work/ids.ts), which then points `chunk`
 * at its own module and corrects what the kind claims.
 */
export const browserCanvas: CanvasKindDef = {
  kind: "browser",
  label: "Browser",
  icon: Globe,
  opens: { sources: [{ at: "browser" }] },
  phone: "native",
  guestable: false,
  chunk: defineChunk("work-browser-canvas", () => import("../canvas/NotBuilt")),
};
