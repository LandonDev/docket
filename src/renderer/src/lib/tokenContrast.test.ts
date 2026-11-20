import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { contrast, luminance, over, resolve, themes, type Theme } from "./colourMath";
import { HIGHLIGHT_INKS } from "./editorPalette";
import { DARCULA, LIGHT } from "./intellijTheme";
import { ANSI } from "./terminalPalette";

/**
 * The contrast contract (docs/DESIGN.md "The light theme"): every pair of
 * tokens that meets on screen, by tier, in both themes, read from index.css.
 * A failure names the pair and its ratio: move the value, never the floor.
 * TOKEN_CONTRAST_PRINT=1 prints each tier's lowest pair per theme, the
 * numbers DESIGN.md cites.
 */
const css = readFileSync(join(__dirname, "../index.css"), "utf8");
const THEMES = Object.entries(themes(css)) as [name: "dark" | "light", theme: Theme][];

const GROUPS = ["--sidebar-group", "--sidebar-group-hover", "--sidebar-group-selected"];
const SURFACES = ["--background", "--sidebar", "--card", "--popover", "--muted", "--secondary", ...GROUPS];
const PAGE = ["--background", "--card"];
const EDGE_GROUNDS = ["--background", "--sidebar", "--card"];

/** A token's value in a theme; a literal colour (a palette table's ink) is itself. */
const value = (theme: Theme, token: string): string => resolve(theme, token.startsWith("--") ? `var(${token})` : token);
/** `ink` on `ground`: either may be thin, and is then laid over what is under it (`ground`, then `base`). */
function ratio(theme: Theme, ink: string, ground: string, base = "--background"): number {
  const under = over(value(theme, ground), value(theme, base));
  return contrast(over(value(theme, ink), under), under);
}

/** `only` keeps a pair to the one theme that has it (a name work-kit reads has no value in dark). */
type Pair = { ink: string; on: string; base?: string; only?: "light" };
const wash = (token: string, percent: number): string => `color-mix(in srgb, var(${token}) ${percent}%, transparent)`;
/** The hover vocabulary (docs/DESIGN.md "Type tints"): foreground at 5% on a hovered row, 7% on a ghost button, 12% pressed. */
const HOVER_WASHES = [5, 7, 12].map((percent) => wash("--foreground", percent));
const CHROME = ["--background", "--sidebar", "--card"];
const STATUS = ["--thread-success", "--thread-warning", "--thread-danger", "--thread-info"];
const pairs = (inks: string[], grounds: string[]): Pair[] => inks.flatMap((ink) => grounds.map((on) => ({ ink, on })));

const TIERS: { name: string; floor: number; pairs: Pair[] }[] = [
  {
    // Text that must be read: the inks, a link, the status colours (a count, "Failed", a hunk's +n −n),
    // the composer's skill and mention ink, each label on its own fill, and the inverted tooltip.
    name: "text",
    floor: 4.5,
    pairs: [
      ...pairs(
        ["--foreground", "--muted-foreground", "--link", "--thread-success", "--thread-warning", "--thread-waiting", "--thread-danger", "--thread-info"],
        SURFACES,
      ),
      // An alert's description and a search hit's line (foreground at 80% in dark, held; foreground in light).
      // Struck words in a compare and a command's strings and flags (foreground at 70% in dark, held).
      ...pairs(["--near-foreground", "--soft-foreground"], PAGE),
      // Ink the composer and the markdown source draw, on the grounds they are typed on.
      ...pairs(["--color-skill", "--color-mention", "--color-markdown-heading"], [...PAGE, "--popover"]),
      { ink: "--primary-foreground", on: "--primary" },
      { ink: "--accent-foreground", on: "--accent" },
      { ink: "--destructive-foreground", on: "--destructive" },
      { ink: "--card-foreground", on: "--card" },
      { ink: "--popover-foreground", on: "--popover" },
      { ink: "--secondary-foreground", on: "--secondary" },
      { ink: "--ui-wash-foreground", on: "--ui-wash" },
      // work-kit's date picker reads these names; each must be a pair that reads. Dark gives them no value, as before.
      { ink: "--calendar-selected-foreground", on: "--calendar-selected", only: "light" },
      { ink: "--calendar-active-foreground", on: "--calendar-active", only: "light" },
      { ink: "--calendar-today-foreground", on: "--calendar-today", only: "light" },
      { ink: "--foreground", on: "--calendar-range", only: "light" },
      // Text on a hovered or pressed row, and a status colour on its own tint (an alert's tone).
      ...["--foreground", "--muted-foreground"].flatMap((ink) => HOVER_WASHES.flatMap((on) => CHROME.map((base) => ({ ink, on, base })))),
      ...STATUS.flatMap((ink) => CHROME.map((base) => ({ ink, on: wash(ink, 10), base }))),
      // The ladder's two upper steps (a completion's detail, a signature, a quote): muted-foreground in light.
      ...pairs(["--ink-50", "--ink-55"], [...PAGE, "--popover", "--muted"]),
      { ink: "--background", on: "--foreground" },
    ],
  },
  // Text that may be missed: a line number, ghost text, a done task, a diff's comment; and the same on a hovered or pressed row.
  {
    name: "quiet text",
    floor: 3,
    pairs: [
      ...pairs(["--faint-foreground"], SURFACES),
      ...HOVER_WASHES.flatMap((on) => CHROME.map((base) => ({ ink: "--faint-foreground", on, base }))),
      // The ladder's lower steps: faint-foreground in light, the mixes dark always had.
      ...pairs(["--ink-35", "--ink-38", "--ink-40", "--ink-45", "--ink-muted-60"], [...PAGE, "--popover"]),
    ],
  },
  {
    // A mark is seen, not read: the focus ring, a type's glyph, a chart's series, an agent page's two extra series.
    name: "mark",
    floor: 3,
    pairs: [
      ...pairs(["--accent", "--ring", "--type-chat", "--type-planning", "--type-project-plan", "--type-implementation", "--type-orchestration", "--type-research"], SURFACES),
      ...pairs(["--chart-1", "--chart-2", "--chart-3", "--chart-4", "--chart-neutral", "--chart-neutral-rest", "--chart-neutral-stale", "--thread-violet", "--thread-cyan"], PAGE),
      // The project screens' stages of work (a state's glyph, a meter's segment) on the page, a lane and the rail's cards.
      ...pairs(["--stage-doing", "--stage-waiting", "--stage-done"], EDGE_GROUNDS),
    ],
  },
  { name: "edge", floor: 1.15, pairs: pairs(["--border"], EDGE_GROUNDS) },
  { name: "field edge", floor: 1.4, pairs: pairs(["--input"], PAGE) },
  {
    // Words on a canvas tint, the tint laid on the page or a card.
    name: "wash",
    floor: 4.5,
    pairs: [
      ...["--add-bg", "--add-bg-soft", "--del-bg", "--sel-bg", "--diff-gap", "--find-hit", "--comment", "--comment-hot"].flatMap((on) => PAGE.map((base) => ({ ink: "--foreground", on, base }))),
      ...["--add-bg-paper", "--del-bg-paper", "--sel-bg-paper", "--find-bg-paper", "--find-bg-paper-current"].map((on) => ({ ink: "--paper-ink", on, base: "--paper" })),
      // The skill label on its own wash, on the title bar (`bg-skill/15 text-skill`).
      { ink: "--color-skill", on: "color-mix(in srgb, var(--color-skill) 15%, transparent)", base: "--sidebar" },
    ],
  },
];

/**
 * Code draws with palettes of its own (docs/DESIGN.md "The light theme"):
 * the editor's two syntax themes, CodeMirror's two tables and the terminal's
 * sixteen colours per theme, each on the pane, which is `background`. A
 * comment may be missed (3:1); everything else is read (4.5:1). Monaco's
 * completion list names a kind in colour on the popover and on its
 * highlighted row (`muted`), and letters a kind's badge on a fill of its own.
 */
const SYNTAX = { dark: { intellij: DARCULA, codemirror: HIGHLIGHT_INKS.dark, ansi: ANSI.dark }, light: { intellij: LIGHT, codemirror: HIGHLIGHT_INKS.light, ansi: ANSI.light } };
const QUIET_INKS = new Set(["comment", "docComment"]);
// A program's black on the dark pane, as every dark terminal draws it: dark's table is held as it was.
const ANSI_LIFTED = { dark: { black: 1.16, brightBlack: 3.84 }, light: {} } as Record<"dark" | "light", Record<string, number>>;
const KIND_NAMES = ["--editor-type-name", "--editor-constant-name", "--editor-keyword-name"];
const KIND_BADGES = ["text", "class", "interface", "enum", "method", "field", "variable", "keyword"].map((kind) => `--editor-symbol-${kind}`);

function codePairs(name: "dark" | "light"): { label: string; ink: string; on: string; floor: number }[] {
  const { intellij, codemirror, ansi } = SYNTAX[name];
  return [
    ...Object.entries(intellij).filter(([key]) => key !== "bg").map(([key, ink]) => ({ label: `intellij ${key}`, ink, on: "--background", floor: QUIET_INKS.has(key) ? 3 : 4.5 })),
    ...Object.entries(codemirror).map(([key, ink]) => ({ label: `codemirror ${key}`, ink, on: "--background", floor: QUIET_INKS.has(key) ? 3 : 4.5 })),
    ...Object.entries(ansi).filter(([key]) => !(key in ANSI_LIFTED[name])).map(([key, ink]) => ({ label: `ansi ${key}`, ink, on: "--background", floor: 4.5 })),
    // Light's highlighted row is `muted`; dark's is IDEA's own fill, held as it was (surfaces/monaco/theme.ts).
    ...KIND_NAMES.flatMap((ink) => (name === "light" ? ["--popover", "--muted"] : ["--popover"]).map((on) => ({ label: ink, ink, on, floor: 4.5 }))),
    ...KIND_BADGES.map((on) => ({ label: "a badge's letter", ink: "--editor-symbol-foreground", on, floor: 4.5 })),
  ].filter((p) => !(name === "dark" && held(p)));
}

/**
 * Held in dark. The owner works in the dark theme while the light one is
 * built, so dark keeps every value it had: where the contract finds a dark
 * pair under its floor, the pair is recorded here at its measured ratio and
 * left alone. Each is a change for him to ask for, never one to make for
 * him (docs/agents/appearance.md "Dark is held").
 */
const HELD_IN_DARK: (Pair & { ratio: number; floor?: number })[] = [
  // White on the lighter fills dark uses for the accent and for red.
  { ink: "--accent-foreground", on: "--accent", ratio: 2.88 },
  { ink: "--destructive-foreground", on: "--destructive", ratio: 2.77 },
  // The neutral chart's two quieter steps, as marks.
  { ink: "--chart-neutral", on: "--background", ratio: 2.42 },
  { ink: "--chart-neutral", on: "--card", ratio: 2.44 },
  { ink: "--chart-neutral-rest", on: "--background", ratio: 1.85 },
  { ink: "--chart-neutral-rest", on: "--card", ratio: 1.89 },
  // The ladder dark's quieter text always stood on: a placeholder, a pending mark and a diff's comment are a
  // hair under 3:1, a completion's detail a hair under 4.5:1.
  ...Object.entries({ "--background": 2.85, "--card": 2.85, "--popover": 2.84 }).map(([on, ratio]) => ({ ink: "--ink-35", on, ratio, floor: 3 })),
  { ink: "--ink-muted-60", on: "--card", ratio: 2.99, floor: 3 },
  { ink: "--ink-muted-60", on: "--popover", ratio: 2.94, floor: 3 },
  ...Object.entries({ "--card": 4.43, "--popover": 4.36, "--muted": 4.16 }).map(([on, ratio]) => ({ ink: "--ink-50", on, ratio })),
  // Supporting and quiet text on a pressed row (foreground at 12%).
  { ink: "--muted-foreground", on: HOVER_WASHES[2], base: "--card", ratio: 4.31 },
  { ink: "--faint-foreground", on: HOVER_WASHES[2], base: "--background", ratio: 2.91, floor: 3 },
  { ink: "--faint-foreground", on: HOVER_WASHES[2], base: "--card", ratio: 2.67, floor: 3 },
  // The white letter on IDEA's completion badges.
  ...Object.entries({ class: 3.87, interface: 3.32, enum: 4, method: 4.36, field: 2.97, variable: 3.25, keyword: 4.42 }).map(([kind, ratio]) => ({ ink: "--editor-symbol-foreground", on: `--editor-symbol-${kind}`, ratio })),
];
const held = (p: { ink: string; on: string; base?: string }): boolean => HELD_IN_DARK.some((h) => h.ink === p.ink && h.on === p.on && h.base === p.base);

/**
 * Named exceptions: colours that are someone else's or a picture's, one
 * value per person or sector wherever they are drawn. Each is held at its
 * measured ratio, so a change to one is seen here. None is the only cue:
 * a presence hue carries a name label, a sector dot sits beside the sector's
 * name, and the runner's coin and star are game art.
 */
const PRESENCE_INK = [3.68, 4.23, 7.94, 3.76, 6.46, 7.27, 9.44, 9.16];
const PRESENCE = { dark: [4.97, 4.32, 8.03, 4.86, 6.52, 7.35, 9.54, 9.26], light: [3.68, 4.23, 2.28, 3.76, 2.8, 2.49, 1.92, 1.98] };
const SECTORS = { cosmic: [7.51, 3.66], hypixel: [7.97, 3.16], purdue: [9.51, 2.41], ref: [8.01, 3.11], unify: [7.84, 3.47], life: [7.35, 3.45] };
const EXCEPTIONS: (Pair & { dark: number; light: number })[] = [
  // A presence label's ink on its hue: the shared editor's, one value in both themes.
  ...PRESENCE_INK.map((r, i) => ({ ink: `--presence-ink-${i + 1}`, on: `--presence-${i + 1}`, dark: r, light: r })),
  // A caret or a cell's 2px outline in that hue, on the page.
  ...PRESENCE_INK.map((_, i) => ({ ink: `--presence-${i + 1}`, on: "--background", dark: PRESENCE.dark[i], light: PRESENCE.light[i] })),
  // LifeOS's sector dots on the rail.
  ...Object.entries(SECTORS).map(([sector, [dark, light]]) => ({ ink: `--sector-${sector}`, on: "--sidebar", dark, light })),
  { ink: "--composer-coin", on: "--card", dark: 9.28, light: 1.71 },
  { ink: "--composer-star", on: "--card", dark: 13.04, light: 1.22 },
  // A field's border on the rail in dark is a hair under the field edge's 1.4:1: dark is held as it was.
  { ink: "--input", on: "--sidebar", dark: 1.37, light: 1.46 },
];

describe("the contrast contract", () => {
  for (const [name, theme] of THEMES) {
    for (const tier of TIERS) {
      it(`${tier.name}: ${tier.floor}:1 in the ${name} theme`, () => {
        const measured = tier.pairs.filter((p) => (!p.only || p.only === name) && !(name === "dark" && held(p))).map((p) => ({ ...p, ratio: ratio(theme, p.ink, p.on, p.base) }));
        if (process.env.TOKEN_CONTRAST_PRINT) {
          const low = measured.reduce((a, b) => (b.ratio < a.ratio ? b : a));
          console.log(`${name} ${tier.name}: lowest ${low.ink} on ${low.on} ${low.ratio.toFixed(2)}`);
        }
        const under = measured.filter((p) => p.ratio < tier.floor).map((p) => `${p.ink} on ${p.on}${p.base ? ` over ${p.base}` : ""}: ${p.ratio.toFixed(2)}`);
        expect(under, `under ${tier.floor}:1`).toEqual([]);
      });
    }

    it(`code: every syntax ink, ANSI colour, kind name and badge letter in the ${name} theme`, () => {
      const measured = codePairs(name).map((p) => ({ ...p, ratio: ratio(theme, p.ink, p.on) }));
      expect(measured.length).toBeGreaterThan(35);
      if (process.env.TOKEN_CONTRAST_PRINT) {
        const low = measured.reduce((a, b) => (b.ratio / b.floor < a.ratio / a.floor ? b : a));
        console.log(`${name} code: lowest ${low.label} on ${low.on} ${low.ratio.toFixed(2)} (floor ${low.floor})`);
      }
      expect(measured.filter((p) => p.ratio < p.floor).map((p) => `${p.label} ${p.ink} on ${p.on}: ${p.ratio.toFixed(2)} under ${p.floor}`)).toEqual([]);
      const lifted = Object.entries(ANSI_LIFTED[name]).map(([key, r]) => `${key}: ${r.toFixed(2)}`);
      expect(Object.keys(ANSI_LIFTED[name]).map((key) => `${key}: ${ratio(theme, SYNTAX[name].ansi[key as keyof typeof ANSI.dark], "--background").toFixed(2)}`)).toEqual(lifted);
    });

    it(`holds each named exception at its measured ratio in the ${name} theme`, () => {
      const measured = EXCEPTIONS.map((e) => `${e.ink} on ${e.on}: ${ratio(theme, e.ink, e.on).toFixed(2)}`);
      expect(measured).toEqual(EXCEPTIONS.map((e) => `${e.ink} on ${e.on}: ${e[name].toFixed(2)}`));
    });
  }

  it("holds dark as it was: each pair under its floor there is recorded at its ratio, and none of them has moved", () => {
    const [, dark] = THEMES.find(([name]) => name === "dark")!;
    expect(HELD_IN_DARK.map((h) => `${h.ink} on ${h.on}: ${ratio(dark, h.ink, h.on, h.base).toFixed(2)}`)).toEqual(HELD_IN_DARK.map((h) => `${h.ink} on ${h.on}: ${h.ratio.toFixed(2)}`));
    // A held pair is one a tier checks: a stale entry here would hide nothing and say nothing.
    const checked = [...TIERS.flatMap((tier) => tier.pairs), ...KIND_BADGES.map((on) => ({ ink: "--editor-symbol-foreground", on }))];
    for (const h of HELD_IN_DARK) expect(checked.some((p) => p.ink === h.ink && p.on === h.on && (p as Pair).base === h.base), `${h.ink} on ${h.on}`).toBe(true);
    // And light holds none of them back: every one passes there.
    const [, light] = THEMES.find(([name]) => name === "light")!;
    for (const h of HELD_IN_DARK) expect(ratio(light, h.ink, h.on, h.base), `${h.ink} on ${h.on} in light`).toBeGreaterThanOrEqual(h.floor ?? (h.ink.startsWith("--chart") ? 3 : 4.5));
  });

  it("reads the tokens it checks", () => {
    const [, light] = THEMES.find(([name]) => name === "light")!;
    expect(value(light, "--success")).toBe(value(light, "--thread-success"));
    expect(luminance(value(light, "--background"))).toBeCloseTo(1, 3);
    // A thin edge is measured as drawn, over its ground, never as its own colour.
    expect(ratio(light, "--border", "--background")).toBeLessThan(2);
    for (const tier of TIERS) for (const p of tier.pairs) for (const [, theme] of THEMES) expect((theme.has(p.ink) || !p.ink.startsWith("--")) && (theme.has(p.on) || !p.on.startsWith("--")), `${p.ink} on ${p.on}`).toBe(true);
  });
});
