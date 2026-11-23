import { createElement, type ComponentType } from "react";
import type { SheetCellJson, SheetChart } from "@shared/contract-work-sheets";
import { fontsOfSnapshot, SheetCanvas, type SheetCanvasProps, type SheetHandle } from "work-kit/sheet";
import type { Decode, GridLink, Workbook } from "./sync";

/**
 * The grid the sheet canvas draws: work-kit's `SheetCanvas` on Univer, and
 * the few reads of it the body makes. A test or a preview hands in its own
 * (testkit.tsx), since Univer draws on a canvas jsdom does not have.
 */
export interface SheetGrid {
  Canvas: ComponentType<SheetCanvasProps>;
  /** The grid's own code beyond the canvas (the formula worker), loaded with the workbook. */
  prepare(): Promise<void>;
  /** Makes the formula worker; there once `prepare` has settled. */
  worker?: () => Worker;
  /** Reads the faces a workbook's fonts are drawn with, before the grid draws it: a canvas does not draw again when a face arrives late. Never rejects. */
  fonts(workbook: Workbook): Promise<void>;
  /** Reads one font's faces, before the row lays it on a cell. */
  font(name: string): Promise<void>;
  link(handle: SheetHandle): GridLink;
  /** A range's values, A1 on that sheet, row by row. */
  values(handle: SheetHandle, sheet: string, a1: string): unknown[][];
  /** Seats a chart over its top-left cell, scrolling with the cells; `onSlot` gets the element to draw it in. What it returns takes it off. */
  place(handle: SheetHandle, chart: SheetChart, size: { width: number; height: number }, onSlot: (slot: HTMLElement | null) => void): () => void;
  decode: Decode;
}

let SheetWorker: (new () => Worker) | null = null;

/** The element Univer seats over a cell; the body draws the chart into it through a portal, so the chart keeps the app's context. */
function ChartSlot({ popup }: { popup?: { extraProps?: { onSlot?: (slot: HTMLElement | null) => void; width?: number; height?: number } } }) {
  const { onSlot, width, height } = popup?.extraProps ?? {};
  return createElement("div", { ref: onSlot, "data-sheet-chart-slot": "", style: { width, height } });
}

const sheetOf = (handle: SheetHandle, sheet: string) => handle.api.getActiveWorkbook()?.getSheetBySheetId(sheet) ?? null;

export const univerGrid: SheetGrid = {
  Canvas: SheetCanvas,
  async prepare() {
    // Vite builds the worker as its own module chunk (electron.vite.config.ts `worker.format`), fetched only now.
    SheetWorker ??= (await import("work-kit/sheet/worker?worker")).default;
  },
  worker: () => new SheetWorker!(),
  // The font files' list is read only when a workbook is about to be drawn (and a static preview never reads it).
  fonts: async (workbook) => (await import("./fonts")).ensureSheetFonts(fontsOfSnapshot(workbook as never)),
  font: async (name) => (await import("./fonts")).ensureSheetFonts([name]),
  link: (handle) => ({
    unitId: handle.api.getActiveWorkbook()?.getId() ?? "",
    apply: (mutations) => handle.apply(mutations),
    onMutation: (listener) => handle.onMutation(listener),
    read: (sheet, row, col) => (sheetOf(handle, sheet)?.getRange(row, col).getCellData() ?? null) as SheetCellJson | null,
    formula: (sheet, row, col) => sheetOf(handle, sheet)?.getRange(row, col).getFormula() || null,
    undo: () => handle.api.undo(),
    onCommand: (listener) => handle.onCommand(listener),
    style: (id) => (handle.api.getActiveWorkbook()?.getWorkbook().getStyles().get(id) as Record<string, unknown> | null | undefined) ?? null,
    // A list as it stands: what an opened Excel file is sent after a rule changes (sync.ts `forPackage`).
    rules: (kind, sheet) =>
      kind === "conditional" ? handle.rules.conditional.list(sheet) : kind === "validation" ? handle.rules.validation.list(sheet) : kind === "names" ? handle.rules.names.list() : kind === "tables" ? handle.tables.models(sheet) : kind === "pages" ? handle.pages.get(sheet) : handle.rules.filter.get(sheet),
  }),
  values: (handle, sheet, a1) => (sheetOf(handle, sheet)?.getRange(a1).getValues() ?? []) as unknown[][],
  place(handle, chart, size, onSlot) {
    const sheet = sheetOf(handle, chart.sheet);
    if (!sheet) return () => undefined;
    // As the grid seats a presence label: a popup on the cell to the left opens at its right edge, level with its top.
    const popup = sheet.getRange(chart.row, Math.max(0, chart.col - 1)).attachPopup({
      componentKey: ChartSlot,
      direction: "horizontal",
      offset: [0, 0],
      extraProps: { onSlot, ...size },
    });
    return () => {
      popup?.dispose();
      onSlot(null);
    };
  },
  async decode(bytes, format) {
    if (format === "xlsx") return (await import("work-kit/sheet/xlsx")).importXlsx(bytes).workbook as never;
    return JSON.parse(new TextDecoder().decode(bytes));
  },
};
