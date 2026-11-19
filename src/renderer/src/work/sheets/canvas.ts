import { defineChunk } from "../../lib/lazyChunk";
import { Table } from "../icons";
import { defineCanvasKind, type CanvasKindDef } from "../canvas/kind";
import type { SheetState } from "./SheetBody";

/**
 * The sheet kind of canvas item (docs/agents/work-sheets.md). The body is
 * its own chunk, with work-kit's grid (Univer) and its formula worker
 * behind it, about 20 MB in all; this file rides the canvas chunk, so it
 * stays small.
 */
export const sheetCanvas: CanvasKindDef = defineCanvasKind<SheetState>({
  kind: "sheet",
  label: "Sheet",
  icon: Table,
  opens: {
    sources: [{ at: "lifeos", table: "sheets" }, { at: "microsoft", app: "excel" }],
    mime: ["application/vnd.google-apps.spreadsheet", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "application/vnd.ms-excel.sheet.macroEnabled.12", "text/csv"],
    ext: ["tcsheet", "xlsx", "xlsm", "csv"],
  },
  phone: "web",
  guestable: true,
  history: true,
  chunk: defineChunk("work-sheets-canvas", () => import("./SheetBody")),
});
