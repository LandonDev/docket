import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/*
 * The loading rule's guard (docs/agents/loading-bones.md; docs/DESIGN.md
 * "Loading and empty states"). Skullet draws every skeleton, and one file
 * imports it: components/bonesEngine.tsx. App code imports
 * components/bones.tsx. A file that imports `skullet`, or the hand-drawn
 * `Skeleton` (components/ui/skeleton.tsx), or writes the bone's fill on a
 * box of its own (`bg-skeleton`), draws bones by hand and fails here.
 *
 * HELD is the folders not yet converted, one line a folder, as paths under
 * src/. A thread that converts a folder deletes its line; a line with
 * nothing left to hold fails, so the list only shrinks. When it is empty,
 * delete components/ui/skeleton.tsx and the two cases that speak of it.
 */

const SRC = resolve(__dirname, "../../..");
const RENDERER = join(SRC, "renderer/src");
const ENGINE = "renderer/src/components/bonesEngine.tsx";
const SKELETON = "renderer/src/components/ui/skeleton.tsx";

/** Folders whose files may still import `Skeleton` or write `bg-skeleton`. */
export const HELD: readonly string[] = [
  "renderer/src/work/browser",
  "renderer/src/work/canvas",
  "renderer/src/work/docs",
  "renderer/src/work/formats",
  "renderer/src/work/history",
  "renderer/src/work/pdf",
];

/** Files inside a held folder that are converted already and must stay so. */
const CONVERTED_IN_HELD: readonly string[] = [];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.tsx?$/.test(name)) out.push(path);
  }
  return out;
}

const files = walk(SRC).map((path) => ({ file: relative(SRC, path), path, text: readFileSync(path, "utf8") }));
const held = (file: string) => !CONVERTED_IN_HELD.includes(file) && HELD.some((folder) => file.startsWith(`${folder}/`));

const SPECIFIER = /(?:from\s+|import\s*\(\s*|import\s+)["']([^"']+)["']/g;
const specifiers = (text: string) => [...text.matchAll(SPECIFIER)].map((match) => match[1]);
/** The file under src/ a specifier names, for the two ways the renderer writes one. */
function target(from: string, specifier: string): string | null {
  const base = specifier.startsWith("@renderer/") ? join(RENDERER, specifier.slice("@renderer/".length)) : specifier.startsWith(".") ? resolve(dirname(from), specifier) : null;
  return base ? relative(SRC, base) : null;
}

const importsSkullet = (text: string) => specifiers(text).some((specifier) => specifier === "skullet" || specifier.startsWith("skullet/"));
const importsSkeleton = (path: string, text: string) => specifiers(text).some((specifier) => target(path, specifier) === SKELETON.replace(/\.tsx$/, ""));
/** The bone's fill as a utility class: a bone drawn by hand, whatever element wears it. */
const BONE_FILL = /(?<![\w-])bg-skeleton(?:-stage|-matte)?(?![\w-])/;

describe("the loading bones", () => {
  it("lets one file import Skullet", () => {
    const offenders = files.filter(({ file, text }) => file !== ENGINE && importsSkullet(text)).map(({ file }) => file);
    expect(offenders, "import components/bones.tsx; only components/bonesEngine.tsx imports skullet").toEqual([]);
  });

  it("draws no bone by hand outside the folders still held: no `Skeleton`, no `bg-skeleton`", () => {
    const offenders = files
      .filter(({ file }) => file !== SKELETON && !held(file) && !/\.test\.tsx?$/.test(file))
      .filter(({ path, text }) => importsSkeleton(path, text) || BONE_FILL.test(text))
      .map(({ file }) => file);
    expect(offenders, "draw the screen from a sample in a Region (docs/agents/loading-bones.md)").toEqual([]);
  });

  it("holds only folders that still draw one: a converted folder's line is deleted", () => {
    const emptied = HELD.filter((folder) => !files.some(({ file, path, text }) => file.startsWith(`${folder}/`) && held(file) && (importsSkeleton(path, text) || BONE_FILL.test(text))));
    expect(emptied, "these folders draw no bone by hand any more: delete their lines from HELD").toEqual([]);
    for (const folder of HELD) expect(existsSync(join(SRC, folder)), folder).toBe(true);
    expect([...HELD].sort()).toEqual([...HELD]);
  });

  it("keeps the engine out of every static import but the front's own dynamic one", () => {
    // The first paint's budget has no room for Skullet (scripts/check-bundle-size.ts): whoever imports the engine
    // statically folds it back in.
    const engine = ENGINE.replace(/\.tsx$/, "");
    const importers = files.filter(({ path, text }) => specifiers(text).some((specifier) => target(path, specifier) === engine)).map(({ file }) => file);
    expect(importers).toEqual(["renderer/src/components/bones.tsx"]);
    const front = files.find(({ file }) => file === "renderer/src/components/bones.tsx")!.text;
    expect(front).toMatch(/import\("\.\/bonesEngine"\)/);
    expect(front).not.toMatch(/from "\.\/bonesEngine"/);
    expect(front).toMatch(/typeof import\("\.\/bonesEngine"\)/);
  });

  // components/bones.css lays the drawing out through Skullet's own attributes (`skullet-pane`, `skullet-loading`,
  // `skullet-ghost`, `skullet-snapshot`, `skullet-layer`, `skullet-exiting`), bonesEngine.tsx builds Skullet's three
  // boxes itself and reads `skullet/internal`, and bonesBridge.ts lifts its bars out of a shadow root. A new version
  // may change any of that with no error: check those three places and the preview's inline script, then move the pin.
  it("pins Skullet to the version the engine and the sheet were written against", () => {
    const { devDependencies, dependencies } = JSON.parse(readFileSync(join(SRC, "..", "package.json"), "utf8")) as { devDependencies: Record<string, string>; dependencies: Record<string, string> };
    expect(devDependencies.skullet).toBe("0.0.3");
    // Compiled into out/, never shipped as a package (scripts/shippedDeps.test.ts).
    expect(dependencies.skullet).toBeUndefined();
  });
});

describe("the bones' theme", () => {
  const sheet = readFileSync(join(RENDERER, "components/bones.css"), "utf8");
  const index = readFileSync(join(RENDERER, "index.css"), "utf8");

  it("is set once, from Docket's own tokens, with the sweep", () => {
    const root = /:root \{([^}]*)\}/.exec(sheet)![1];
    expect(root).toMatch(/--skullet-base: var\(--skeleton\);/);
    expect(root).toMatch(/--skullet-highlight: var\(--skeleton-sheen\);/);
    expect(root).toMatch(/--skullet-animation: shimmer;/);
    expect(sheet).toMatch(/\[data-bones-on="stage"\] \{\s*--skullet-base: var\(--skeleton-stage\);/);
    expect(sheet).toMatch(/\[data-bones-on="matte"\] \{\s*--skullet-base: var\(--skeleton-matte\);\s*--skullet-highlight: var\(--skeleton-matte-sheen\);/);
  });

  it("stills the bones under reduced motion", () => {
    expect(sheet).toMatch(/:where\(\[data-motion="reduced"\]\) \{\s*\[data-region\],\s*\[data-bone\],\s*\[data-bones-layer\] \{\s*--skullet-animation: none;/);
  });

  it("keeps Skullet's own sheet in the page, so the first and the last bones restyle nothing", () => {
    expect(index).toMatch(/@import "skullet\/styles\.css";\s*@import "\.\/components\/bones\.css";/);
  });

  it("gives the sweep a value in each theme", () => {
    const dark = /:root \{[\s\S]*?\n\}/.exec(index)![0];
    const light = /html\.theme-light \{[\s\S]*?\n\}/.exec(index)![0];
    for (const block of [dark, light]) {
      expect(block).toMatch(/--skeleton-sheen:/);
      expect(block).toMatch(/--skeleton-matte-sheen:/);
    }
  });
});
