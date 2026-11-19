import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The sheet canvas is a lazy chunk behind its kind: work-kit's grid is
 * about 12 MB and its formula worker 7.4 MB, and none of it may enter the
 * first paint or the canvas chunk. canvas.ts rides the canvas chunk, so it
 * names the body only through `import()`; the body takes no value from a
 * module with zod schemas (the contract), whose zod code would land in the
 * first paint's chunk (pdf/firstPaint.test.ts); the worker is fetched only
 * when a sheet opens.
 */
const DIR = import.meta.dirname;
const VALUE_IMPORT = /^import\s+(?!type\b)[^;]*?from\s+["']([^"']+)["']/gm;
const shipped = readdirSync(DIR).filter((f) => /\.tsx?$/.test(f) && !/\.(test|dom\.test|preview|preview\.fixtures)\.tsx?$/.test(f) && f !== "testkit.tsx");
const read = (file: string): string => readFileSync(join(DIR, file), "utf8");

describe("the sheet canvas and the first paint", () => {
  it("imports no value from a module with zod schemas", () => {
    expect(shipped).toContain("SheetBody.tsx");
    for (const file of shipped) for (const [, from] of read(file).matchAll(VALUE_IMPORT)) expect(from.startsWith("@shared") || from === "zod", `${file} imports a value from ${from}`).toBe(false);
  });

  it("keeps the kind's file free of the grid: only a type and the chunk's import()", () => {
    const text = read("canvas.ts");
    expect([...text.matchAll(VALUE_IMPORT)].map((m) => m[1]).filter((from) => from.startsWith("./") || from.startsWith("work-kit"))).toEqual([]);
    expect(text).toContain('import("./SheetBody")');
  });

  it("loads the formula worker only when a sheet opens", () => {
    for (const file of shipped) {
      const text = read(file);
      expect(/^import[^;]*from\s+["']work-kit\/sheet\/(worker|xlsx)/m.test(text), `${file} imports the worker or the importer statically`).toBe(false);
    }
    expect(read("grid.ts")).toContain('import("work-kit/sheet/worker?worker")');
  });
});
