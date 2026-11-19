import { defineChunk } from "../../lib/lazyChunk";
import { Dashboard } from "../icons";
import { defineCanvasKind, type CanvasKindDef } from "../canvas/kind";

/**
 * The dashboard kind of canvas item (docs/agents/work-dashboards.md): a
 * saved page of figures read from sheets. The body is its own chunk; this
 * file rides the canvas chunk. A dashboard lives in the host's row behind
 * the item (`{ at: 'thread' }`), so the kind claims no file.
 */
export const dashboardCanvas: CanvasKindDef = defineCanvasKind<undefined>({
  kind: "dashboard",
  label: "Dashboard",
  icon: Dashboard,
  opens: {},
  phone: "web",
  guestable: false,
  chunk: defineChunk("work-dashboards-canvas", () => import("./DashboardCanvas")),
});
