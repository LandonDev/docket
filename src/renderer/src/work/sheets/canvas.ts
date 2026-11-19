import { defineChunk } from "../../lib/lazyChunk";
import { Table } from "../icons";
import type { CanvasKindDef } from "../canvas/kind";

/**
 * The sheet kind of canvas item (docs/agents/work-sheets.md). A stub: its
 * body says "Not built yet" until the sheets pillar's milestone builds it
 * (`PILLAR_MILESTONE` in src/shared/work/ids.ts), which then points `chunk`
 * at its own module and corrects what the kind claims.
 */
export const sheetCanvas: CanvasKindDef = {
  kind: "sheet",
  label: "Sheet",
  icon: Table,
  opens: {
    sources: [{ at: "lifeos", table: "sheets" }, { at: "microsoft", app: "excel" }],
    mime: ["application/vnd.google-apps.spreadsheet", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
    ext: ["tcsheet", "xlsx", "xlsm", "csv"],
  },
  phone: "web",
  guestable: true,
  chunk: defineChunk("work-sheets-canvas", () => import("../canvas/NotBuilt")),
};
