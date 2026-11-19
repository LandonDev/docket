import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/* One key map (lib/keys.ts). A handler that reads `metaKey` itself works on a
   Mac and nowhere else, and a hint typed as ⌘ reads wrong on Windows, so no
   renderer file but lib/keys.ts does either: handlers ask `modKey`,
   `modOrCtrl` and their kin, hints go through `keyHint` and `keyCaps`.
   Comments may say ⌘: they describe the Mac the code was written on. */

const root = resolve(__dirname, "..");

/* Glyphs that stay, each for a reason. The list only shrinks. */
const GLYPHS_ALLOWED: Record<string, string> = {
  "lib/keys.ts": "the map itself",
  // Appshots is a Mac-only feature (its settings page shows on a Mac alone); its name is its key.
  "lib/settings.ts": "Appshots: double-tap ⌘, on macOS only",
  "surfaces/AppshotsSettings.tsx": "Appshots: double-⌘, on macOS only",
};

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.tsx?$/.test(name) && !/\.(test|fixtures)\.tsx?$/.test(name)) out.push(path);
  }
  return out;
}

/** A source with its comments blanked, so only code and strings are left. */
export function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

const files = walk(root).map((path) => ({ file: relative(root, path), code: withoutComments(readFileSync(path, "utf8")) }));

describe("one key map", () => {
  it("no handler reads metaKey outside lib/keys.ts", () => {
    const readers = files.filter(({ file, code }) => file !== "lib/keys.ts" && /\bmetaKey\b/.test(code)).map(({ file }) => file);
    expect(readers).toEqual([]);
  });

  it("no hint types a key glyph outside lib/keys.ts", () => {
    const typed = files.filter(({ file, code }) => !(file in GLYPHS_ALLOWED) && /[⌘⌥⌃⇧⏎↩⌫]/.test(code)).map(({ file }) => file);
    expect(typed).toEqual([]);
  });

  it("the allow-list names only files that still need it", () => {
    const stale = Object.keys(GLYPHS_ALLOWED).filter((file) => !files.some((f) => f.file === file && /[⌘⌥⌃⇧⏎↩⌫]/.test(f.code)));
    expect(stale).toEqual([]);
  });

  it("the comment stripper keeps code and strings", () => {
    expect(withoutComments('const a = "⌘"; // ⌘K opens search')).toBe('const a = "⌘"; ');
    expect(withoutComments("/** ⌘S saves */\nsave();")).toBe("\nsave();");
    expect(withoutComments('const url = "https://example.com";')).toBe('const url = "https://example.com";');
  });
});
