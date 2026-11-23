import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Which build of pdf.js the engine loads. The desktop app's Chromium (142,
 * in Electron 39) has no `Map.prototype.getOrInsertComputed`; pdf.js 6.5's
 * modern build calls it in the window and in the worker and brings no
 * polyfill, so with it no page of a PDF or a deck was ever drawn in the app
 * ("this._requestsByChunk.getOrInsertComputed is not a function"). The
 * legacy build carries its own. A headless Chrome proof never sees this:
 * its Chromium is newer than the app's.
 */
const engine = readFileSync(join(__dirname, "engine.ts"), "utf8");
const root = dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json"));
const read = (file: string): string => readFileSync(join(root, file), "utf8");
const DEFINES = /getOrInsertComputed:\s*function/;

describe("the build of pdf.js the engine loads", () => {
  it("is the legacy one, for the window and for the worker", () => {
    const loaded = [...engine.matchAll(/(?<!typeof )import\("(pdfjs-dist[^"]*)"\)/g)].map((m) => m[1]);
    expect(loaded).toEqual(["pdfjs-dist/legacy/build/pdf.mjs", "pdfjs-dist/legacy/build/pdf.worker.min.mjs?worker"]);
  });

  it("carries the methods the app's Chromium lacks; the modern build calls them and brings none", () => {
    for (const file of ["legacy/build/pdf.mjs", "legacy/build/pdf.worker.min.mjs"]) expect(DEFINES.test(read(file)) || /getOrInsertComputed:function/.test(read(file)), file).toBe(true);
    // Why the legacy build: if a newer pdf.js stops calling it, or the app's Chromium gains it, this line says the choice can be looked at again.
    const modern = read("build/pdf.mjs");
    expect(modern).toContain(".getOrInsertComputed(");
    expect(DEFINES.test(modern)).toBe(false);
  });
});
