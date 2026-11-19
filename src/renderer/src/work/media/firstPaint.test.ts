import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The media canvas is a lazy chunk, but zod's one copy sits in the first
 * paint's chunk, and a lazy chunk that imports a zod schema adds the zod
 * code it uses there. Milestone 34's canvas imported its frame maths from
 * the wire's contract, whose schemas put 5 kB over the first-paint budget;
 * `scripts/entryGraph.test.ts` cannot see that, since no first-paint file
 * imports the canvas. So the canvas takes values only from
 * `@shared/mediaFrames`, which imports types alone, and every other shared
 * import of it is a type.
 */
const DIR = import.meta.dirname;
const VALUE_IMPORT = /^import\s+(?!type\b)[^;]*?from\s+["']([^"']+)["']/gm;

describe("the media canvas and zod", () => {
  it("imports no value from a module with zod schemas", () => {
    const shipped = readdirSync(DIR).filter((f) => /\.tsx?$/.test(f) && !/\.(test|dom\.test|preview|preview\.fixtures)\.tsx?$/.test(f));
    expect(shipped).toContain("MediaCanvas.tsx");
    for (const file of shipped) {
      const text = readFileSync(join(DIR, file), "utf8");
      for (const [, from] of text.matchAll(VALUE_IMPORT)) {
        const allowed = !from.startsWith("@shared") && from !== "zod" ? true : from === "@shared/mediaFrames";
        expect(allowed, `${file} imports a value from ${from}`).toBe(true);
      }
    }
  });

  it("keeps mediaFrames.ts free of values from other modules", () => {
    const text = readFileSync(join(DIR, "../../../../shared/mediaFrames.ts"), "utf8");
    expect([...text.matchAll(VALUE_IMPORT)].map((m) => m[1])).toEqual([]);
  });
});
