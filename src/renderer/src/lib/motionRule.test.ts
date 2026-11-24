import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/*
 * The reduced-motion rule (lib/motion.ts, docs/DESIGN.md "Reduced motion"):
 * reduced is fewer and gentler, never none. One place reads the system's
 * setting; every stylesheet says reduced as `:where([data-motion="reduced"])`;
 * nothing under it stops all motion at once; and the marks that say work is
 * going on never read the rule. A Windows PC with its animation effects off
 * reports reduce, and the app used to go still on it (1.0.377).
 */

const ROOT = resolve(__dirname, "../..");
const REDUCED = ':where([data-motion="reduced"])';

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.(tsx?|css)$/.test(name) && !/\.(test|fixtures)\.tsx?$/.test(name)) out.push(path);
  }
  return out;
}

const files = walk(join(ROOT, "src")).map((path) => ({ path: relative(ROOT, path), text: readFileSync(path, "utf8") }));
const sheets = files.filter((file) => file.path.endsWith(".css"));

/** The body of the brace block opening at `open`. */
function block(text: string, open: number): string {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) return text.slice(open + 1, i);
  }
  return text.slice(open + 1);
}

/** Every rule under the reduced attribute: its selector and declarations. */
function reducedRules(text: string): { selector: string; body: string }[] {
  const rules: { selector: string; body: string }[] = [];
  let at = text.indexOf(REDUCED);
  while (at >= 0) {
    const open = text.indexOf("{", at);
    const inner = block(text, open);
    const nested = [...inner.matchAll(/([^{};]+)\{([^{}]*)\}/g)];
    if (nested.length === 0) rules.push({ selector: text.slice(text.lastIndexOf("}", at) + 1, at).trim() || "&", body: inner });
    for (const [, selector, body] of nested) rules.push({ selector: selector.trim(), body });
    at = text.indexOf(REDUCED, open);
  }
  return rules;
}

/** Selectors that would still every element at once. */
const BLANKET = /(^|[\s,(>+~])(\*|html|body|:root)(?=$|[\s,)>+~:[.])/;
/** The marks that say work is going on: they move under reduced motion too. */
const ESSENTIAL = /spinner|working-|shimmer|stream-step|z-fade/;
/** Keyframe animations reduced motion stops, each with what still moves. */
const STILLED: Record<string, string> = {
  'thead tr.stream-rise': "a table's header row born mid-stream: its card fades in instead",
};

describe("the reduced-motion rule", () => {
  it("reads the system's setting in lib/motion.ts alone", () => {
    const readers = files.filter((file) => file.path !== "src/lib/motion.ts" && /prefers-reduced-motion/.test(file.text));
    expect(readers.map((file) => file.path)).toEqual([]);
    const motionHooks = files.filter((file) => /import \{[^}]*\buseReducedMotion\b[^}]*\} from ["']motion\/react["']/.test(file.text));
    expect(motionHooks.map((file) => file.path)).toEqual([]);
    expect(files.filter((file) => /MotionConfig reducedMotion="user"/.test(file.text)).map((file) => file.path)).toEqual([]);
  });

  it("gives Tailwind's motion variants the same attribute", () => {
    const index = readFileSync(join(ROOT, "src/index.css"), "utf8");
    expect(index).toContain('@custom-variant motion-reduce (&:where([data-motion="reduced"], [data-motion="reduced"] *));');
    expect(index).toContain('@custom-variant motion-safe (&:where([data-motion="full"], [data-motion="full"] *));');
  });

  it("never stops all motion at once, nor a mark of work, under reduced motion", () => {
    const found: string[] = [];
    for (const sheet of sheets)
      for (const { selector, body } of reducedRules(sheet.text)) {
        const stops = /(?:^|;|\s)(?:animation|transition)\s*:\s*none\b|animation-name\s*:\s*none\b/.test(body);
        if (!stops) continue;
        if (BLANKET.test(selector)) found.push(`${sheet.path}: ${selector} stops everything`);
        else if (ESSENTIAL.test(selector)) found.push(`${sheet.path}: ${selector} is a mark of work`);
        else if (/animation(?:-name)?\s*:\s*none/.test(body) && !Object.keys(STILLED).some((kept) => selector.includes(kept)))
          found.push(`${sheet.path}: ${selector} stops its animation; keep its fade, or list it in STILLED with what still moves`);
      }
    expect(found).toEqual([]);
    expect(files.filter((file) => /motion-reduce:animate-none/.test(file.text)).map((file) => file.path)).toEqual([]);
  });

  it("leaves the marks of work moving whatever the setting", () => {
    for (const path of ["src/components/ui/spinner.tsx", "src/components/ui/working-mark.tsx", "src/components/ui/working-text.tsx", "src/lib/streamReveal.ts"]) {
      const text = readFileSync(join(ROOT, path), "utf8");
      expect(text, path).not.toMatch(/useReducedMotion|reducedMotion\(|data-motion/);
    }
  });

  it("finds a blanket stop when one is written", () => {
    const sheet = `${REDUCED} {\n  *, *::before {\n    animation: none !important;\n  }\n}`;
    const [rule] = reducedRules(sheet);
    expect(rule.selector).toBe("*, *::before");
    expect(BLANKET.test(rule.selector)).toBe(true);
    expect(BLANKET.test(".t-toggle")).toBe(false);
  });
});
