import type { SheetExportAnswer, SheetPreviewAnswer, SheetPreviewFormat, SheetStoreKind } from "@shared/contract-work-sheets";
import { registry } from "../../lib/connection";
import { saveFile } from "../formats/model";
import type { Drawn, PreviewBytes, PreviewFormat, PreviewSource } from "../formats/preview";
import { fromBase64 } from "./host";

/**
 * The sheet's side of Preview (docs/agents/work-sheets.md "Preview and
 * export"): each format a workbook goes out as, drawn on the host that holds
 * it (`work.sheets.preview`).
 *
 * - Excel, PDF and Print are LibreOffice's PDF of the workbook, the file as
 *   it stands (a sheet the service holds as the .xlsx the model writer makes).
 * - OpenDocument and Excel 97-2003 are drawn from the exported file itself,
 *   so he sees what that format keeps.
 * - CSV and TSV are one sheet's shown values as a table, with the sheets to
 *   pick from; a web page is LibreOffice's HTML.
 *
 * Export makes the file on the host when he presses (`work.sheets.previewExport`),
 * from the workbook as it stands then, never a picture kept from an earlier
 * look, and saves it through the system's own dialog. Print hands the whole
 * PDF to this computer's viewer. An opened Excel file is already Excel's: its
 * Excel format saves a copy of it as it stands.
 */

export type SheetFormat = SheetPreviewFormat | "print";

/** `SHEET_PREVIEW_READ_MAX`: the most bytes one read answers. The canvas takes no value from the contract (firstPaint.test.ts); a test holds them equal. */
export const READ_MAX = 4 * 1024 * 1024;

/** In the bar's order: what Excel and mail read first. An opened Excel file's own format saves a copy of itself. */
export function sheetFormats(opts: { store: SheetStoreKind; name: string }): (PreviewFormat & { id: SheetFormat })[] {
  const own = opts.store === "package";
  return [
    { id: "xlsx", label: "Excel", ext: own && /\.xlsm$/i.test(opts.name) ? "xlsm" : "xlsx", paged: true, verb: own ? "Save a copy" : "Export" },
    { id: "pdf", label: "PDF", ext: "pdf", paged: true, verb: "Export" },
    // What goes to paper is the PDF: the same picture, and the verb is Print….
    { id: "print", label: "Print", paged: true, verb: "Print…" },
    { id: "ods", label: "OpenDocument", ext: "ods", paged: true, verb: "Export" },
    { id: "xls", label: "Excel 97-2003", ext: "xls", paged: true, verb: "Export" },
    { id: "csv", label: "CSV", ext: "csv", paged: false, verb: "Export" },
    { id: "tsv", label: "TSV", ext: "tsv", paged: false, verb: "Export" },
    { id: "html", label: "Web page", ext: "html", paged: false, verb: "Export" },
  ];
}

const MIME: Record<SheetPreviewFormat | "xlsm", string> = {
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xlsm: "application/vnd.ms-excel.sheet.macroEnabled.12",
  pdf: "application/pdf",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
  xls: "application/vnd.ms-excel",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  html: "text/html",
};

type Request = <T>(env: string, method: string, params: unknown, opts?: { timeoutMs?: number }) => Promise<T>;
const linkRequest: Request = (env, method, params, opts) => registry.linkOf(env).request(method, params, opts);

export interface SheetPreviewDeps {
  env: string;
  itemId: string;
  store: SheetStoreKind;
  /** the workbook's file name: an opened .xlsm saves a copy as one */
  name: string;
  /** A test hands in its own wire, save and print. */
  request?: Request;
  save?(name: string, blob: Blob): void;
  /** hands a PDF to this computer to print (work/formats/printOut.ts) */
  print?(name: string, bytes: Uint8Array): Promise<void>;
}

const cancelled = (): DOMException => new DOMException("The draw was cancelled", "AbortError");
/** A render takes as long as LibreOffice does: a 2,000-page sheet is seconds, a cold host more. */
const DRAW_MS = 5 * 60_000;

/** The sheet's `PreviewSource`: one object for as long as the item shows the same workbook. */
export function sheetPreviewSource(deps: SheetPreviewDeps): PreviewSource {
  const request = deps.request ?? linkRequest;
  const save = deps.save ?? saveFile;
  const print =
    deps.print ??
    (async (name: string, bytes: Uint8Array): Promise<void> => {
      const { printPdf } = await import("../formats/printOut");
      await printPdf(name, bytes);
    });
  const call = <T>(method: string, params: Record<string, unknown>, timeoutMs = DRAW_MS): Promise<T> => request<T>(deps.env, method, { itemId: deps.itemId, ...params }, { timeoutMs });
  // The sheet a CSV or TSV was last drawn for: what its export holds.
  const sheetOf = new Map<SheetPreviewFormat, string>();

  const bytesOf = (rev: string, size: number): PreviewBytes => ({
    rev,
    size,
    read: async (offset, length) => fromBase64((await call<{ data: string }>("work.sheets.previewRead", { rev, offset, length: Math.min(length, READ_MAX) }, 60_000)).data),
  });

  /** Every byte of a kept file, a frame at a time. */
  const whole = async (bytes: PreviewBytes): Promise<Uint8Array<ArrayBuffer>> => {
    const out = new Uint8Array(bytes.size);
    for (let offset = 0; offset < bytes.size; ) {
      const part = await bytes.read(offset, Math.min(READ_MAX, bytes.size - offset));
      if (part.length === 0) throw new Error("The file could not be read to its end");
      out.set(part, offset);
      offset += part.length;
    }
    return out;
  };

  const host = (format: SheetFormat): SheetPreviewFormat => (format === "print" ? "pdf" : format);

  return {
    formats: sheetFormats(deps),
    async draw(format, opts) {
      if (opts.signal.aborted) throw cancelled();
      const id = host(format as SheetFormat);
      const sheet = opts.sheet ?? sheetOf.get(id);
      const got = await call<SheetPreviewAnswer>("work.sheets.preview", { format: id, ...(opts.pages ? { pages: opts.pages } : {}), ...(sheet ? { sheet } : {}), ...(opts.by ? { by: opts.by } : {}) });
      if (opts.signal.aborted) throw cancelled();
      let drawn: Drawn;
      if (got.kind === "paged") drawn = { picture: { kind: "paged", pdf: bytesOf(got.rev, got.size), pages: got.pages, drawnBy: got.drawnBy, ...(got.shown ? { shown: got.shown } : {}) }, drops: got.drops };
      else if (got.kind === "table") {
        sheetOf.set(id, got.name);
        drawn = { picture: { kind: "table", name: got.name, rows: got.rows, sheets: got.sheets }, drops: got.drops };
      } else drawn = { picture: { kind: "html", html: got.html }, drops: got.drops };
      return drawn;
    },
    async export(format) {
      const id = host(format as SheetFormat);
      // The workbook as it stands now: the host makes the file afresh, or answers the one it made of these same bytes.
      const sheet = sheetOf.get(id);
      const made = await call<SheetExportAnswer>("work.sheets.previewExport", { format: id, ...(sheet ? { sheet } : {}) });
      const bytes = await whole(bytesOf(made.rev, made.size));
      if (format === "print") await print(made.name, bytes);
      else save(made.name, new Blob([bytes], { type: MIME[made.name.toLowerCase().endsWith(".xlsm") ? "xlsm" : id] }));
      return { name: made.name };
    },
  };
}
