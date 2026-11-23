import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The PDF and slides canvases are lazy chunks, but zod's one copy sits in
 * the first paint's chunk, and a lazy chunk that imports a zod schema adds
 * the zod code it uses there (milestone 34 found it on the media canvas);
 * `scripts/entryGraph.test.ts` cannot see that, since no first-paint file
 * imports a canvas. So the canvases take values only from shared modules
 * that hold no zod and import none (`ZOD_FREE`, each read here to be sure),
 * and every other shared import is a type. pdf.js is imported only inside
 * engine.ts, with `import()`.
 */
const DIRS = { pdf: import.meta.dirname, slides: join(import.meta.dirname, "../slides") };
/** The shared modules a canvas may take a value from: no zod in them, nor in what they import a value from. */
const ZOD_FREE: Record<string, string> = { "@shared/pdfCite": "pdfCite.ts", "@shared/work/slideFormats": "work/slideFormats.ts", "@shared/work/deckShow": "work/deckShow.ts" };
const SHARED = join(import.meta.dirname, "../../../../shared");
const VALUE_IMPORT = /^import\s+(?!type\b)[^;]*?from\s+["']([^"']+)["']/gm;
const shipped = (dir: string): string[] => readdirSync(dir).filter((f) => /\.tsx?$/.test(f) && !/\.(test|dom\.test|preview|preview\.fixtures)\.tsx?$/.test(f) && f !== "testkit.ts");

describe("the PDF and slides canvases and the first paint", () => {
  it("import no value from a module with zod schemas", () => {
    expect(shipped(DIRS.pdf)).toContain("PdfCanvas.tsx");
    expect(shipped(DIRS.slides)).toContain("SlidesCanvas.tsx");
    for (const [name, dir] of Object.entries(DIRS)) {
      for (const file of shipped(dir)) {
        const text = readFileSync(join(dir, file), "utf8");
        for (const [, from] of text.matchAll(VALUE_IMPORT)) {
          const allowed = !from.startsWith("@shared") && from !== "zod" ? true : from in ZOD_FREE;
          expect(allowed, `${name}/${file} imports a value from ${from}`).toBe(true);
        }
      }
    }
  });

  it("takes shared values only from modules with no zod anywhere under them", () => {
    const seen = new Set<string>();
    const walk = (file: string): void => {
      if (seen.has(file)) return;
      seen.add(file);
      const text = readFileSync(file, "utf8");
      for (const [, from] of text.matchAll(VALUE_IMPORT)) {
        expect(from, `${file} imports a value from ${from}`).not.toBe("zod");
        expect(from.startsWith("."), `${file} imports a value from ${from}`).toBe(true);
        walk(join(file, "..", `${from}.ts`));
      }
    };
    for (const file of Object.values(ZOD_FREE)) walk(join(SHARED, file));
    expect(seen.size).toBeGreaterThanOrEqual(Object.keys(ZOD_FREE).length);
  });

  it("load pdf.js only with the canvas, from engine.ts", () => {
    for (const [name, dir] of Object.entries(DIRS)) {
      for (const file of shipped(dir)) {
        const text = readFileSync(join(dir, file), "utf8");
        expect(/^import[^;]*from\s+["']pdfjs-dist/m.test(text), `${name}/${file} imports pdf.js statically`).toBe(false);
        if (!(name === "pdf" && file === "engine.ts")) expect(text.includes('import("pdfjs-dist'), `${name}/${file} loads pdf.js`).toBe(false);
      }
    }
  });

  it("keeps pdfCite.ts free of values from other modules", () => {
    const text = readFileSync(join(DIRS.pdf, "../../../../shared/pdfCite.ts"), "utf8");
    expect([...text.matchAll(VALUE_IMPORT)].map((m) => m[1])).toEqual([]);
  });
});
