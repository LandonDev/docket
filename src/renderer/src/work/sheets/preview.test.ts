import { describe, expect, it } from "vitest";
import { SHEET_PREVIEW_FORMATS, SHEET_PREVIEW_READ_MAX, type SheetExportAnswer, type SheetPreviewAnswer } from "@shared/contract-work-sheets";
import { PictureMoved } from "../formats/preview";
import { previewProblems } from "../formats/previewContract";
import { READ_MAX, sheetFormats, sheetPreviewSource } from "./preview";
import { KEPT_VALUES } from "@shared/work/sheets";

/**
 * The sheet's PreviewSource (preview.ts) held to the contract every kind keeps (formats/previewContract.ts), over a
 * stand-in for the host: what it asks of `work.sheets.preview`, `previewRead` and `previewExport`, and what it saves.
 */
const PDF = new TextEncoder().encode("%PDF-1.7\n% a stand-in for LibreOffice's pages\n%%EOF\n");
const b64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));

function host() {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const saved: { name: string; size: number; type: string }[] = [];
  const printed: { name: string; size: number }[] = [];
  const kept = new Map<string, Uint8Array>([["a".repeat(32), PDF]]);
  const request = async <T,>(_env: string, method: string, params: unknown): Promise<T> => {
    const p = params as Record<string, unknown>;
    calls.push({ method, params: p });
    if (method === "work.sheets.preview") {
      const format = p.format as string;
      const answer: SheetPreviewAnswer =
        format === "csv" || format === "tsv"
          ? { kind: "table", name: (p.sheet as string) ?? "Budget", rows: [["Item", "Cost"], ["Hotel", "240"]], sheets: ["Budget", "Flights"], drops: ["Flights stays behind", "3 formulas become their values"] }
          : format === "html"
            ? { kind: "html", html: "<table><tr><td>Hotel</td></tr></table>", drops: ["3 formulas become their values"] }
            : format === "ods"
              ? // a long workbook from a host of this release: more pages follow, and nobody has counted them
                { kind: "paged", rev: "a".repeat(32), size: PDF.length, pages: 1, shown: { from: 1, to: 1, of: 2 }, uncounted: true, drawnBy: "libreoffice", drops: ["A chart sheet becomes a sheet", "Prints on more than 1 pages"], notes: ["Prints on more than 1 pages"] }
              : format === "xlsx"
                ? // the same from a host a release behind: the count as it said it, the line among the losses
                  { kind: "paged", rev: "a".repeat(32), size: PDF.length, pages: 1, shown: { from: 1, to: 1, of: 2 }, drawnBy: "libreoffice", drops: ["Prints on more than 1 pages"] }
                : { kind: "paged", rev: "a".repeat(32), size: PDF.length, pages: 1, drawnBy: "libreoffice", drops: format === "xls" ? ["2 tables become plain ranges"] : [] };
      return answer as T;
    }
    if (method === "work.sheets.previewRead") {
      const bytes = kept.get(p.rev as string);
      if (!bytes) throw new Error("That preview is gone: draw it again.");
      return { data: b64(bytes.subarray(p.offset as number, (p.offset as number) + (p.length as number))) } as T;
    }
    if (method === "work.sheets.previewExport") {
      const format = p.format as string;
      const name = `Budget.${format === "xlsx" ? "xlsx" : format}`;
      const rev = "b".repeat(31) + format.length;
      kept.set(rev, PDF);
      const answer: SheetExportAnswer = { rev, size: PDF.length, name, drops: [] };
      return answer as T;
    }
    throw new Error(`no ${method}`);
  };
  return { calls, saved, printed, request };
}

const sourceOf = (h: ReturnType<typeof host>, store: "package" | "tcsheet" = "package", name = "Budget.xlsx") =>
  sheetPreviewSource({
    env: "local",
    itemId: "item1",
    store,
    name,
    request: h.request,
    save: (n, blob) => h.saved.push({ name: n, size: blob.size, type: blob.type }),
    print: async (n, bytes) => void h.printed.push({ name: n, size: bytes.length }),
  });

describe("the sheet's PreviewSource", () => {
  it("keeps the contract, export included", async () => {
    const h = host();
    expect(await previewProblems(sourceOf(h), { exports: true })).toEqual([]);
    expect(await previewProblems(sourceOf(host(), "tcsheet"), { exports: true })).toEqual([]);
  });

  it("lists Excel, PDF, Print, OpenDocument, Excel 97-2003, CSV, TSV and Web page, each the host draws", () => {
    const formats = sheetFormats({ store: "tcsheet", name: "Budget" });
    expect(formats.map((f) => f.label)).toEqual(["Excel", "PDF", "Print", "OpenDocument", "Excel 97-2003", "CSV", "TSV", "Web page"]);
    expect(formats.filter((f) => f.paged).map((f) => f.id)).toEqual(["xlsx", "pdf", "print", "ods", "xls"]);
    for (const f of formats) if (f.id !== "print") expect(SHEET_PREVIEW_FORMATS as readonly string[]).toContain(f.id);
    expect(formats.find((f) => f.id === "print")?.verb).toBe("Print…");
  });

  it("saves a copy of an opened Excel file as the file it is, an .xlsm as one", () => {
    expect(sheetFormats({ store: "package", name: "Budget.xlsx" })[0]).toMatchObject({ ext: "xlsx", verb: "Save a copy" });
    expect(sheetFormats({ store: "package", name: "Macros.xlsm" })[0]).toMatchObject({ ext: "xlsm", verb: "Save a copy" });
    expect(sheetFormats({ store: "lifeos", name: "Budget" })[0]).toMatchObject({ ext: "xlsx", verb: "Export" });
  });

  it("draws Print as the PDF, and asks for the pages and the sheet he picked", async () => {
    const h = host();
    const source = sourceOf(h);
    const signal = new AbortController().signal;
    await source.draw("print", { signal });
    await source.draw("pdf", { signal, pages: [1, Number.MAX_SAFE_INTEGER] });
    const table = await source.draw("csv", { signal, sheet: "Flights" });
    expect(table.picture).toMatchObject({ kind: "table", name: "Flights", sheets: ["Budget", "Flights"] });
    expect(table.drops).toEqual(["Flights stays behind", "3 formulas become their values"]);
    const asked = h.calls.filter((c) => c.method === "work.sheets.preview").map((c) => c.params);
    expect(asked).toEqual([
      { itemId: "item1", format: "pdf" },
      { itemId: "item1", format: "pdf", pages: [1, Number.MAX_SAFE_INTEGER] },
      { itemId: "item1", format: "csv", sheet: "Flights" },
    ]);
  });

  it("says a whole nobody has counted with no number, and what is no loss apart from the losses", async () => {
    const h = host();
    const source = sourceOf(h);
    const signal = new AbortController().signal;
    const long = await source.draw("ods", { signal });
    expect(long.picture).toMatchObject({ kind: "paged", pages: 1, shown: { from: 1, to: 1 } });
    expect(long.picture.kind === "paged" && long.picture.shown && "of" in long.picture.shown).toBe(false);
    expect(long.notes).toEqual(["Prints on more than 1 pages"]);
    expect(long.drops).toEqual(["A chart sheet becomes a sheet"]);
    // a host a release behind: its count and its line are said as they came
    const old = await source.draw("xlsx", { signal });
    expect(old.picture).toMatchObject({ shown: { from: 1, to: 1, of: 2 } });
    expect(old.notes).toBeUndefined();
    expect(old.drops).toEqual(["Prints on more than 1 pages"]);
  });

  it("exports the sheet a CSV was last drawn for, made afresh on the host", async () => {
    const h = host();
    const source = sourceOf(h);
    await source.draw("csv", { signal: new AbortController().signal, sheet: "Flights" });
    expect(await source.export("csv")).toEqual({ name: "Budget.csv" });
    expect(h.calls.find((c) => c.method === "work.sheets.previewExport")?.params).toEqual({ itemId: "item1", format: "csv", sheet: "Flights" });
    expect(h.saved).toEqual([{ name: "Budget.csv", size: PDF.length, type: "text/csv" }]);
  });

  it("prints the whole PDF through this computer's viewer, never a save", async () => {
    const h = host();
    const source = sourceOf(h);
    await source.draw("print", { signal: new AbortController().signal });
    expect(await source.export("print")).toEqual({ name: "Budget.pdf" });
    expect(h.calls.find((c) => c.method === "work.sheets.previewExport")?.params).toEqual({ itemId: "item1", format: "pdf" });
    expect(h.printed).toEqual([{ name: "Budget.pdf", size: PDF.length }]);
    expect(h.saved).toEqual([]);
  });

  it("prints the workbook Preview drew, and nothing when it changed since: Preview is drawn again first", async () => {
    // Council r3 (Sol 7): a co-author's change after "As it will print" was drawn went to paper unseen.
    const h = host();
    let now = "c".repeat(32);
    const request = async <T,>(env: string, method: string, params: unknown): Promise<T> => {
      const p = params as Record<string, unknown>;
      if (method === "work.sheets.previewExport" && p.drawn !== undefined && p.drawn !== now) {
        h.calls.push({ method, params: p });
        return { rev: "", size: 0, name: "", drops: [], moved: true } as T;
      }
      const got = await h.request<T>(env, method, params);
      return (method === "work.sheets.preview" ? { ...(got as object), book: now } : got) as T;
    };
    const source = sheetPreviewSource({ env: "local", itemId: "item1", store: "package", name: "Budget.xlsx", request, print: async (n, bytes) => void h.printed.push({ name: n, size: bytes.length }) });
    await source.draw("print", { signal: new AbortController().signal });
    expect(await source.export("print")).toEqual({ name: "Budget.pdf" });
    expect(h.calls.filter((c) => c.method === "work.sheets.previewExport").at(-1)?.params).toEqual({ itemId: "item1", format: "pdf", drawn: "c".repeat(32) });
    expect(h.printed).toHaveLength(1);
    now = "d".repeat(32);
    await expect(source.export("print")).rejects.toBeInstanceOf(PictureMoved);
    expect(h.printed).toHaveLength(1);
    // Drawn again, it prints what he now sees.
    await source.draw("print", { signal: new AbortController().signal });
    await source.export("print");
    expect(h.printed).toHaveLength(2);
  });

  it("prints nothing before Preview has drawn the pages, nor after their draw failed; a host that names no workbook prints once drawn", async () => {
    // Council r4 (Sol 4): Print pressed while the first draw was out sent no drawn workbook, and went to paper unchecked.
    const h = host();
    const source = sourceOf(h);
    await expect(source.export("print")).rejects.toBeInstanceOf(PictureMoved);
    expect(h.calls.some((c) => c.method === "work.sheets.previewExport")).toBe(false);
    // The stand-in names no workbook, as a host a release behind: drawn, it prints as before.
    await source.draw("print", { signal: new AbortController().signal });
    expect(await source.export("print")).toEqual({ name: "Budget.pdf" });
    expect(h.printed).toHaveLength(1);
    // A draw that fails leaves no pages he checked.
    let fail = true;
    const failing = sheetPreviewSource({
      env: "local",
      itemId: "item1",
      store: "package",
      name: "Budget.xlsx",
      request: async <T,>(env: string, method: string, params: unknown): Promise<T> => {
        if (fail && method === "work.sheets.preview") throw new Error("LibreOffice stopped");
        const got = await h.request<T>(env, method, params);
        return (method === "work.sheets.preview" ? { ...(got as object), book: "c".repeat(32) } : got) as T;
      },
      print: async (n, bytes) => void h.printed.push({ name: n, size: bytes.length }),
    });
    fail = false;
    await failing.draw("print", { signal: new AbortController().signal });
    fail = true;
    await expect(failing.draw("print", { signal: new AbortController().signal })).rejects.toThrow("LibreOffice stopped");
    await expect(failing.export("print")).rejects.toBeInstanceOf(PictureMoved);
    expect(h.printed).toHaveLength(1);
  });

  it("draws and exports only once his last edit is in the file, and not at all when it is not", async () => {
    // Council r1 (Sol 8): Print drew the cell from before the edit that still waited to be sent.
    const h = host();
    const order: string[] = [];
    let refused: string | null = null;
    const source = sheetPreviewSource({
      env: "local",
      itemId: "item1",
      store: "package",
      name: "Budget.xlsx",
      request: async (env, method, params) => (order.push(method), h.request(env, method, params)),
      save: () => undefined,
      written: async () => {
        order.push("written");
        if (refused) throw new Error(refused);
      },
    });
    await source.draw("pdf", { signal: new AbortController().signal });
    await source.export("pdf");
    expect(order).toEqual(["written", "work.sheets.preview", "written", "work.sheets.previewExport", "work.sheets.previewRead"]);
    refused = "An edit is not saved: That cell is locked";
    await expect(source.draw("pdf", { signal: new AbortController().signal })).rejects.toThrow(refused);
    expect(order.filter((m) => m === "work.sheets.preview")).toHaveLength(1);
  });

  it("says the file's kept values may be out of date before it goes to Print or a folder, from the file made then", async () => {
    // Council r4 (Sol 6): the export's own warning was dropped, so Print handed off old totals with no word.
    const h = host();
    const order: string[] = [];
    const source = sheetPreviewSource({
      env: "local",
      itemId: "item1",
      store: "package",
      name: "Budget.xlsx",
      // (the workbook changed since the picture: the file made now is the one that warns)
      request: async <T,>(env: string, method: string, params: unknown): Promise<T> => {
        const got = await h.request<T>(env, method, params);
        return (method === "work.sheets.previewExport" ? { ...(got as object), drops: [KEPT_VALUES] } : got) as T;
      },
      save: () => void order.push("save"),
      print: async () => void order.push("print"),
      warn: (words) => void order.push(`warn: ${words}`),
    });
    await source.draw("print", { signal: new AbortController().signal });
    await source.export("print");
    await source.export("pdf");
    expect(order).toEqual([`warn: ${KEPT_VALUES}`, "print", `warn: ${KEPT_VALUES}`, "save"]);
    // and nothing is said of a file whose values stand
    const quiet: string[] = [];
    const plain = sheetPreviewSource({ env: "local", itemId: "item1", store: "package", name: "Budget.xlsx", request: h.request, save: () => undefined, warn: (w) => void quiet.push(w) });
    await plain.export("pdf");
    expect(quiet).toEqual([]);
  });

  it("reads a render in frames no larger than the host answers", () => {
    expect(READ_MAX).toBe(SHEET_PREVIEW_READ_MAX);
  });
});
