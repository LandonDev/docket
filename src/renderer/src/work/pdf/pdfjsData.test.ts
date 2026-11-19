import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { NOTICES, ShippedData, shippedCount, shippedUrl } from "./pdfjsData";

const PDFJS = join(import.meta.dirname, "../../../../../node_modules/pdfjs-dist");

describe("pdf.js's own files, shipped as the PDF canvas's assets", () => {
  it("ships every CMap, the two standard fonts pdf.js never takes from the system, and the JPEG 2000 and JBIG2 decoders", () => {
    expect(shippedCount("cMapUrl")).toBe(readdirSync(join(PDFJS, "cmaps")).filter((f) => f.endsWith(".bcmap")).length);
    expect(shippedCount("cMapUrl")).toBeGreaterThan(150);
    for (const name of ["UniJIS-UCS2-H.bcmap", "Adobe-Korea1-UCS2.bcmap"]) expect(shippedUrl("cMapUrl", name), name).toBeTruthy();
    // pdf.js's own names for them (its worker's getFontNameToFileMap, WasmImage's _filename)
    const worker = readFileSync(join(PDFJS, "build/pdf.worker.mjs"), "utf8");
    for (const [kind, name] of [
      ["standardFontDataUrl", "FoxitSymbol.pfb"],
      ["standardFontDataUrl", "FoxitDingbats.pfb"],
      ["wasmUrl", "openjpeg.wasm"],
      ["wasmUrl", "jbig2.wasm"],
    ] as const) {
      expect(worker.includes(`"${name}"`), `pdf.js asks for ${name}`).toBe(true);
      expect(shippedUrl(kind, name), name).toBeTruthy();
    }
    expect(shippedCount("standardFontDataUrl")).toBe(2);
    expect(shippedCount("wasmUrl")).toBe(2);
    // and each one's licence notice with it
    expect(NOTICES).toHaveLength(6);
  });

  it("ships nothing under a GPL licence or that the canvas never runs", () => {
    for (const name of ["LiberationSans-Regular.ttf", "FoxitSerif.pfb"]) expect(shippedUrl("standardFontDataUrl", name)).toBeNull();
    for (const name of ["quickjs-eval.wasm", "qcms_bg.wasm"]) expect(shippedUrl("wasmUrl", name)).toBeNull();
    expect(shippedUrl("iccUrl", "CGATS001Compat-v2-micro.icc")).toBeNull();
  });

  it("answers pdf.js's ask by name with the asset's bytes, and refuses a file it does not ship", async () => {
    const bytes = new Uint8Array([0, 97, 115, 109]);
    const fetched = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(bytes));
    try {
      const data = new ShippedData({ cMapUrl: null, standardFontDataUrl: null, wasmUrl: null });
      expect(await data.fetch({ kind: "wasmUrl", filename: "openjpeg.wasm" })).toEqual(bytes);
      expect(fetched).toHaveBeenCalledWith(shippedUrl("wasmUrl", "openjpeg.wasm"));
      await expect(data.fetch({ kind: "standardFontDataUrl", filename: "LiberationSans-Regular.ttf" })).rejects.toThrow("which the app does not ship");
      fetched.mockResolvedValueOnce(new Response("gone", { status: 404 }));
      await expect(data.fetch({ kind: "cMapUrl", filename: "UniJIS-UCS2-H.bcmap" })).rejects.toThrow("UniJIS-UCS2-H.bcmap: 404");
    } finally {
      fetched.mockRestore();
    }
  });

  it("is loaded with pdf.js, by import() from engine.ts alone, and handed to getDocument", () => {
    const engine = readFileSync(join(import.meta.dirname, "engine.ts"), "utf8");
    expect(engine).toContain('import("./pdfjsData")');
    expect(engine).toMatch(/getDocument\(\{[^}]*BinaryDataFactory: data/);
    for (const file of readdirSync(import.meta.dirname).filter((f) => /\.tsx?$/.test(f) && !f.includes(".test.") && f !== "pdfjsData.ts")) {
      expect(/^import[^;]*from\s+["']\.\/pdfjsData["']/m.test(readFileSync(join(import.meta.dirname, file), "utf8")), file).toBe(false);
    }
  });
});
