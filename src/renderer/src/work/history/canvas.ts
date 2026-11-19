import { defineChunk } from "../../lib/lazyChunk";
import { History } from "../icons";
import type { CanvasKindDef } from "../canvas/kind";

/**
 * The history kind of canvas item (docs/agents/work-history.md). A stub: its
 * body says "Not built yet" until the history pillar's milestone builds it
 * (`PILLAR_MILESTONE` in src/shared/work/ids.ts), which then points `chunk`
 * at its own module and corrects what the kind claims. Nothing claims it: the pane opens it by name, on the source of the item whose versions it shows.
 */
export const historyCanvas: CanvasKindDef = {
  kind: "history",
  label: "History",
  icon: History,
  opens: {},
  phone: "web",
  guestable: false,
  chunk: defineChunk("work-history-canvas", () => import("../canvas/NotBuilt")),
};
