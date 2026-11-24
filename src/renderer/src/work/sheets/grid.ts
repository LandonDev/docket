import type { ComponentType } from "react";
import type { SheetCellJson } from "@shared/contract-work-sheets";
import { fontsOfSnapshot, readObjectsResource, SheetCanvas, type SheetCanvasProps, type SheetHandle } from "work-kit/sheet";
import type { Book, Decode, GridLink, Workbook } from "./sync";
import { snapshotMedia } from "./objects";

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
  decode: Decode;
}

let SheetWorker: (new () => Worker) | null = null;

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
    // Univer's own end of the cell editor, keeping what he typed (as Return does): a tab's close sends it with the rest.
    commit: async () => handle.api.getActiveWorkbook()?.endEditingAsync(true),
    onCommand: (listener) => handle.onCommand(listener),
    style: (id) => (handle.api.getActiveWorkbook()?.getWorkbook().getStyles().get(id) as Record<string, unknown> | null | undefined) ?? null,
    // A list as it stands: what an opened Excel file is sent after a rule changes (sync.ts `forPackage`).
    rules: (kind, sheet) =>
      kind === "conditional" ? handle.rules.conditional.list(sheet) : kind === "validation" ? handle.rules.validation.list(sheet) : kind === "names" ? handle.rules.names.list() : kind === "tables" ? handle.tables.models(sheet) : kind === "pages" ? handle.pages.get(sheet) : handle.rules.filter.get(sheet),
    objects: {
      list: () => handle.objects.list(),
      sheetId: (name) => handle.store.get().sheets.find((s) => s.name === name)?.id,
      sheetName: (id) => handle.store.get().sheets.find((s) => s.id === id)?.name,
      apply: (changes) => handle.objects.apply(changes),
    },
  }),
  values: (handle, sheet, a1) => (sheetOf(handle, sheet)?.getRange(a1).getValues() ?? []) as unknown[][],

  async decode(bytes, format): Promise<Book> {
    if (format === "xlsx") {
      // An Excel file's charts and pictures are read with it, and each picture's bytes kept by its part for the grid to draw.
      const { importXlsx, readMedia } = await import("work-kit/sheet/xlsx");
      const { workbook, objects } = importXlsx(bytes);
      const media = new Map<string, { bytes: Uint8Array; type: string }>();
      for (const picture of objects.pictures) {
        const got = media.has(picture.part) ? undefined : readMedia(bytes, picture.part);
        if (got) media.set(picture.part, { bytes: got, type: picture.contentType });
      }
      return { workbook: workbook as never, objects, media };
    }
    // A sheet the service holds keeps its charts and pictures in its snapshot, a made picture's bytes beside them.
    const workbook = JSON.parse(new TextDecoder().decode(bytes)) as Workbook & { resources?: Array<{ name: string; data: string }> };
    const objects = readObjectsResource(workbook as never);
    return objects ? { workbook, objects, media: snapshotMedia(workbook) } : { workbook };
  },
};
