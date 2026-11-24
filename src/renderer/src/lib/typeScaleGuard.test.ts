import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/*
 * The type guard. Tracking is size-specific (docs/DESIGN.md "Type scale":
 * -0.01em from 16px up, none below), so no renderer file reaches for
 * Tailwind's tracking steps, and every 16px title is one recipe on one line
 * height: semibold, 24px lines, -0.01em.
 */

const ROOT = resolve(__dirname, "..");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.tsx?$/.test(name) && !/\.(test|fixtures)\.tsx?$/.test(name)) out.push(path);
  }
  return out;
}

const files = walk(ROOT).map((path) => ({ file: relative(ROOT, path), text: readFileSync(path, "utf8") }));

describe("the type guard", () => {
  it("never uses Tailwind's tracking steps", () => {
    const hits = files.flatMap(({ file, text }) => [...text.matchAll(/(?<![\w-])tracking-(?:tighter|tight|wide|wider|widest)(?![\w-])/g)].map((m) => `${file}: ${m[0]}`));
    expect(hits).toEqual([]);
  });

  it("sets every 16px semibold title at -0.01em on 24px lines", () => {
    const off: string[] = [];
    for (const { file, text } of files) {
      for (const m of text.matchAll(/["'`][^"'`]*\btext-base font-semibold\b[^"'`]*["'`]/g)) {
        if (!m[0].includes("tracking-[-0.01em]") || !/\bleading-6\b/.test(m[0])) off.push(`${file}: ${m[0]}`);
      }
    }
    expect(off).toEqual([]);
  });
});

describe("the type scale guard", () => {
  it("names 12px text-xs rather than an arbitrary size", () => {
    const hits = files.filter(({ text }) => text.includes("text-[12px]")).map(({ file }) => file);
    expect(hits).toEqual([]);
  });

  it("keeps 11px for key caps and a menu's group labels, and 10px nowhere", () => {
    const off: string[] = [];
    for (const { file, text } of files) {
      if (file === "components/ui/kbd.tsx") continue;
      for (const m of text.matchAll(/["'`][^"'`]*text-\[1[01]px\][^"'`]*["'`]/g)) {
        const lit = m[0];
        const keyCap = lit.includes("data-[slot=kbd]");
        const label = lit.includes("text-[11px]") && lit.includes("font-medium");
        if (lit.includes("text-[10px]") || !(keyCap || label)) off.push(`${file}: ${lit.slice(0, 80)}`);
      }
    }
    expect(off).toEqual([]);
  });
});

describe("Work's type scale guard", () => {
  // docs/DESIGN.md "Type scale" and plan 3.1's table: in Work a literal size is 11 (a label, a key cap, an initial),
  // 13 (a row, the chrome) or 15 (a document's body); 12, 14, 16 and 18 are the named steps; nothing is above text-lg.
  // The clicker is a phone page, read at arm's length, with its own sizes.
  const PHONE_PAGES = new Set(["work/slides/show/Clicker.tsx"]);
  const work = files.filter(({ file }) => file.startsWith("work/") && !file.endsWith(".preview.tsx") && !PHONE_PAGES.has(file));

  it("Work's sizes are on the scale", () => {
    const off: string[] = [];
    for (const { file, text } of work) {
      for (const m of text.matchAll(/(?<![\w-])text-\[(\d+(?:\.\d+)?)px\]/g)) if (!["11", "13", "15"].includes(m[1]!)) off.push(`${file}: ${m[0]}`);
      for (const m of text.matchAll(/(?<![\w-])text-(?:xl|[2-9]xl)(?![\w-])/g)) off.push(`${file}: ${m[0]}`);
    }
    expect(off).toEqual([]);
  });
});
