import { defineChunk } from "../../lib/lazyChunk";
import { Dashboard } from "../icons";
import type { CanvasKindDef } from "../canvas/kind";

/**
 * The dashboard kind of canvas item (docs/agents/work-dashboards.md). A stub: its
 * body says "Not built yet" until the dashboards pillar's milestone builds it
 * (`PILLAR_MILESTONE` in src/shared/work/ids.ts), which then points `chunk`
 * at its own module and corrects what the kind claims.
 */
export const dashboardCanvas: CanvasKindDef = {
  kind: "dashboard",
  label: "Dashboard",
  icon: Dashboard,
  opens: { ext: ["tcdash"] },
  phone: "web",
  guestable: false,
  chunk: defineChunk("work-dashboards-canvas", () => import("../canvas/NotBuilt")),
};
