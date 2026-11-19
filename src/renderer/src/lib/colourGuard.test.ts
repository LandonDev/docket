import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/* Colours live in index.css's token declarations. These counted exceptions
 * are palette data or values required by an outside API; each names its use.
 * The counts only shrink. COLOUR_GUARD_PRINT=1 prints the current tally.
 * SVG assets, tests, test helpers and fixtures are not renderer source.
 */
const ROOT = resolve(__dirname, "..");
const ALLOWED: Record<string, { reason: string; count: number }> = {
  "chrome/ColorPicker.tsx": { reason: "The saturation field and hue strip are the colours being picked.", count: 9 },
  "lib/colorUtils.ts": { reason: "The colour converter needs a hex fallback when canvas cannot resolve a colour.", count: 2 },
  "lib/editorPalette.ts": { reason: "The highlight tables are CodeMirror's syntax palettes.", count: 18 },
  "lib/intellijTheme.ts": { reason: "IntelliJ syntax palettes are editor content.", count: 26 },
  "lib/tabGroups.ts": { reason: "Group colours are the named palette offered to the user.", count: 9 },
  "lib/terminalPalette.ts": { reason: "The ANSI tables map terminal colour codes; the fallbacks stand in for the tokens on a page without the stylesheet.", count: 38 },
  "surfaces/monaco/theme.ts": { reason: "Monaco requires hex palettes, including syntax and fallback colours.", count: 26 },
  "surfaces/settings/hosts/dialogs/PairDialog.tsx": { reason: "The QR encoder requires black and white for its image.", count: 2 },
};

// Match complete hex colours, never part of a word or an id (#ABCDE-12345).
// Underscores separate colours in Tailwind arbitrary values.
const COLOURS = /(?<![a-z\d#])#(?:[a-f\d]{8}|[a-f\d]{6}|[a-f\d]{4}|[a-f\d]{3})(?![a-z\d-])|(?<![a-z\d-])(?:rgba?|hsla?|oklch)\(/gi;
type Hit = { file: string; line: number; token: string };

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (!["test", "tests", "fixtures", "__fixtures__", "__tests__"].includes(name)) walk(path, out);
    } else if (/\.(tsx?|css)$/.test(name) && !/\.(test|fixtures)\.tsx?$/.test(name)) out.push(path);
  }
  return out;
}

const blank = (text: string) => text.replace(/[^\n]/g, " ");

function sourceToScan(text: string, file: string): string {
  // Keep offsets for diagnostics; comments do not paint a colour.
  let source = text.replace(/\/\*[\s\S]*?\*\/|^\s*\/\/[^\n]*/gm, blank);
  if (file === "index.css") {
    // The top holds both the current tokens and the legacy token declarations.
    // Exempt only custom properties in those blocks, never their CSS rules.
    const end = source.indexOf("\nhtml,\nbody,\n#root {");
    const prefix = end < 0 ? "" : source.slice(0, end);
    const tokens = prefix.replace(/(?:^|\n)(?::root|html\.theme-light|@theme(?: inline)?)\s*\{[^{}]*\}/g,
      (block) => block.replace(/--[\w-]+\s*:[^;]+;/g, blank));
    source = tokens + source.slice(prefix.length);
  }
  return source;
}

function hits(text: string, file: string): Hit[] {
  const source = sourceToScan(text, file);
  return [...source.matchAll(COLOURS)]
    // A fragment identifies an SVG element or URL target, not a colour.
    .filter((match) => !match[0].startsWith("#") || !/\burl\(\s*["']?$|https?:\/\/[^\s"'`]*$/i.test(source.slice(0, match.index)))
    .map((match) => ({ file, line: source.slice(0, match.index).split("\n").length, token: match[0] }));
}

function scan() {
  const found: Record<string, Hit[]> = {};
  for (const path of walk(ROOT)) {
    const file = relative(ROOT, path);
    const colours = hits(readFileSync(path, "utf8"), file);
    if (colours.length) found[file] = colours;
  }
  return found;
}

/* One declaration, two values (docs/DESIGN.md "The light theme"). A component
 * never asks which theme is on, never names black or white, and never draws
 * text as an opacity of an ink: a mix that reads on dark falls under 3:1 on
 * white. No counted exceptions: fix the code.
 */
const THEME_RULES: { name: string; pattern: RegExp; fix: string }[] = [
  { name: "a dark: utility", pattern: /(?<![\w-])dark:(?=[a-z[(!-])/g, fix: "give the token a value in each theme" },
  { name: "a .theme-light selector", pattern: /\.theme-light(?![\w-])/g, fix: "give the token a light value in index.css's token blocks" },
  {
    name: "black or white by name",
    pattern: /(?<![\w-])(?:bg|text|border|ring|outline|fill|stroke|from|via|to|decoration|shadow|divide|caret|accent)-(?:black|white)(?![\w-])/g,
    fix: "use a token: matte under a video, a -foreground on its fill",
  },
  {
    name: "text as an opacity of an ink",
    pattern: /(?<![\w-])text-(?:muted-|faint-)?foreground\/\d+|(?<![\w-])text-\[color-mix\([^\]]*var\(--(?:muted-|faint-)?foreground\)|(?<![\w-])(?:color|-webkit-text-fill-color)\s*:\s*["'`]?color-mix\([^;\n]*?var\(--(?:muted-|faint-)?foreground\)/g,
    fix: "use muted-foreground or faint-foreground",
  },
];

// The contrast tests' reader finds the light token block by its selector.
const TOKEN_BLOCK_READERS = new Set(["lib/colourMath.ts"]);

function themeHits(text: string, file: string): (Hit & { rule: string })[] {
  let source = text.replace(/\/\*[\s\S]*?\*\/|^\s*\/\/[^\n]*/gm, blank);
  if (file === "index.css") {
    // The token blocks are where a light value is written: `html.theme-light {` opens one, and the
    // `dark:` variant is defined against the class once.
    const end = source.indexOf("\nhtml,\nbody,\n#root {");
    const prefix = end < 0 ? "" : source.slice(0, end);
    source = prefix.replace(/(?<![^\n])html\.theme-light(?= \{)|(?<![^\n])@custom-variant dark [^\n]*/g, blank) + source.slice(prefix.length);
  }
  return THEME_RULES.filter((rule) => !(rule.name === "a .theme-light selector" && TOKEN_BLOCK_READERS.has(file))).flatMap((rule) =>
    [...source.matchAll(rule.pattern)].map((match) => ({ file, line: source.slice(0, match.index).split("\n").length, token: match[0], rule: rule.name })),
  );
}

const tree = scan();
if (process.env.COLOUR_GUARD_PRINT) console.log(JSON.stringify(Object.fromEntries(Object.entries(tree).map(([file, found]) => [file, found.length])), null, 2));
const where = (hit: Hit) => `${hit.file}:${hit.line} "${hit.token}"`;

describe("the colour guard", () => {
  it("finds no literal colour outside token declarations and the named palettes", () => {
    const problems: string[] = [];
    for (const [file, found] of Object.entries(tree)) {
      const allowed = ALLOWED[file];
      if (!allowed) problems.push(...found.map(where));
      else if (found.length > allowed.count)
        problems.push(`${file}: ${found.length} literal colours, ${allowed.count} allowed (${allowed.reason}): ${found.map(where).join(", ")}`);
    }
    expect(problems, "Use a colour token from index.css; palette exception counts only shrink.").toEqual([]);
  });

  it("finds no component that asks which theme is on, names black or white, or thins an ink into text", () => {
    const problems = walk(ROOT).flatMap((path) => {
      const file = relative(ROOT, path);
      return themeHits(readFileSync(path, "utf8"), file).map((hit) => `${where(hit)}: ${hit.rule}`);
    });
    expect(problems, THEME_RULES.map((rule) => `${rule.name}: ${rule.fix}`).join("; ")).toEqual([]);
  });

  it("catches each theme rule, and leaves alone what only looks like one", () => {
    const caught: [string, string][] = [
      ['className="dark:bg-muted"', "a dark: utility"],
      ['"hover:dark:text-foreground"', "a dark: utility"],
      [".theme-light .monaco-editor { color: red; }", "a .theme-light selector"],
      ['document.querySelector("html.theme-light")', "a .theme-light selector"],
      ['"rounded-lg bg-black"', "black or white by name"],
      ['"text-white/80"', "black or white by name"],
      ['"border-white"', "black or white by name"],
      ['"text-foreground/70 line-through"', "text as an opacity of an ink"],
      ['"text-muted-foreground/60"', "text as an opacity of an ink"],
      ['"text-[color-mix(in_srgb,var(--foreground)_50%,transparent)]"', "text as an opacity of an ink"],
      ["  color: color-mix(in srgb, var(--foreground) 55%, transparent);", "text as an opacity of an ink"],
      ['color: "color-mix(in srgb, var(--foreground) 38%, transparent)",', "text as an opacity of an ink"],
      ["-webkit-text-fill-color: color-mix(in srgb, var(--muted-foreground) 35%, transparent);", "text as an opacity of an ink"],
    ];
    for (const [source, rule] of caught) expect(themeHits(source, "example.tsx").map((hit) => hit.rule), source).toEqual([rule]);
    const left = [
      'const tone = { dark: "a", light: "b" };',
      'html.classList.toggle("theme-light", !dark);',
      '"bg-foreground/5 hover:bg-foreground/12 border-foreground/10"',
      "background-color: color-mix(in srgb, var(--foreground) 10%, transparent);",
      'backgroundColor: "color-mix(in srgb, var(--foreground) 10%, transparent)",',
      'borderRight: "1px solid color-mix(in srgb, var(--foreground) 7%, transparent)",',
      "caret-color: var(--foreground);",
      '"text-foreground text-muted-foreground text-faint-foreground bg-matte"',
      '"decoration-[color-mix(in_srgb,var(--destructive)_70%,transparent)]"',
      "// dark:bg-muted in a comment",
    ];
    for (const source of left) expect(themeHits(source, "example.tsx"), source).toEqual([]);
    // In index.css only the token blocks and the variant's own definition may name the class.
    const css = "@custom-variant dark (&:where(html:not(.theme-light), html:not(.theme-light) *));\nhtml.theme-light { --foreground: #000; }\nhtml,\nbody,\n#root { color: red; }\nhtml.theme-light .late { color: red; }";
    expect(themeHits(css, "index.css").map((hit) => hit.line)).toEqual([6]);
    expect(themeHits(css, "assets/components.css")).toHaveLength(4);
  });

  it("lists only existing files and gives each exception a reason", () => {
    for (const [file, allowed] of Object.entries(ALLOWED)) {
      expect(existsSync(join(ROOT, file)), file).toBe(true);
      expect(allowed.reason.length, file).toBeGreaterThan(0);
    }
  });

  it("catches every hex length and colour function, including Tailwind values", () => {
    for (const colour of ["#abc", "#abcd", "#ABCDEF", "#abcdef12", "rgb(1 2 3)", "rgba(0,0,0,.5)", "hsl(0 0% 0%)", "hsla(0,0%,0%,.5)", "oklch(0.5 0 0)", "drop-shadow-[0_1px_0_rgba(0,0,0,.5)]", "bg-[#fff]", "from-[#fff_10%]", "url(data:image/svg+xml;rgb(1 2 3))", 'url(data:image/svg+xml;fill="#fff")']) {
      expect(hits(colour, "example.tsx"), colour).toHaveLength(1);
    }
    expect(hits("#ab #abcde #abcdefg #abcdef123 #ABCDE-12345 var(--foreground) url(#abcdef) https://example.com/#abcdef", "example.tsx")).toEqual([]);
  });

  it("exempts only top-level token declarations, preserving line numbers", () => {
    const css = ':root { --foreground: #fff; color: #123; }\nhtml.theme-light { --foreground: #000; }\n@theme inline { --color-accent: #abc; }\nhtml,\nbody,\n#root { color: #456; }\n.late { --custom: #789; }';
    expect(hits(css, "index.css")).toEqual([
      { file: "index.css", line: 1, token: "#123" },
      { file: "index.css", line: 6, token: "#456" },
      { file: "index.css", line: 7, token: "#789" },
    ]);
    expect(hits(':root { --custom: #fff; }', "assets/components.css")).toHaveLength(1);
    expect(hits('/* #fff */\n// rgb(0 0 0)\nconst ink = "#123456";', "example.ts")).toEqual([{ file: "example.ts", line: 3, token: "#123456" }]);
  });
});
