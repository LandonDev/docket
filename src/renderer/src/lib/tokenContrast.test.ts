import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { contrast, luminance, over, resolve, themes, type Theme } from "./colourMath";

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

const value = (theme: Theme, token: string): string => resolve(theme, `var(${token})`);
/** `ink` on `ground`: either may be thin, and is then laid over what is under it (`ground`, then `base`). */
function ratio(theme: Theme, ink: string, ground: string, base = "--background"): number {
  const under = over(value(theme, ground), value(theme, base));
  return contrast(over(value(theme, ink), under), under);
}

type Pair = { ink: string; on: string; base?: string };
const pairs = (inks: string[], grounds: string[]): Pair[] => inks.flatMap((ink) => grounds.map((on) => ({ ink, on })));

const TIERS: { name: string; floor: number; pairs: Pair[] }[] = [
  {
    // Text that must be read: the inks, a link, the status colours (a count, "Failed", a hunk's +n −n),
    // the composer's skill and mention ink, each label on its own fill, and the inverted tooltip.
    name: "text",
    floor: 4.5,
    pairs: [
      ...pairs(
        ["--foreground", "--muted-foreground", "--link", "--thread-success", "--thread-warning", "--thread-danger", "--thread-info"],
        SURFACES,
      ),
      // Ink the composer and the markdown source draw, on the grounds they are typed on.
      ...pairs(["--color-skill", "--color-mention", "--color-markdown-heading"], [...PAGE, "--popover"]),
      { ink: "--primary-foreground", on: "--primary" },
      { ink: "--accent-foreground", on: "--accent" },
      { ink: "--destructive-foreground", on: "--destructive" },
      { ink: "--card-foreground", on: "--card" },
      { ink: "--popover-foreground", on: "--popover" },
      { ink: "--secondary-foreground", on: "--secondary" },
      { ink: "--ui-wash-foreground", on: "--ui-wash" },
      // work-kit's date picker reads these names; each must be a pair that reads.
      { ink: "--calendar-selected-foreground", on: "--calendar-selected" },
      { ink: "--calendar-active-foreground", on: "--calendar-active" },
      { ink: "--calendar-today-foreground", on: "--calendar-today" },
      { ink: "--foreground", on: "--calendar-range" },
      { ink: "--background", on: "--foreground" },
    ],
  },
  // Text that may be missed: a line number, ghost text, a done task, a diff's context.
  { name: "quiet text", floor: 3, pairs: pairs(["--faint-foreground"], SURFACES) },
  {
    // A mark is seen, not read: the focus ring, a type's glyph, a chart's series, an agent page's two extra series.
    name: "mark",
    floor: 3,
    pairs: [
      ...pairs(["--accent", "--ring", "--type-chat", "--type-planning", "--type-project-plan", "--type-implementation", "--type-orchestration", "--type-research"], SURFACES),
      ...pairs(["--chart-1", "--chart-2", "--chart-3", "--chart-4", "--chart-neutral", "--chart-neutral-rest", "--chart-neutral-stale", "--thread-violet", "--thread-cyan"], PAGE),
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
    ],
  },
];

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
  // A field's border on the rail in dark is a hair under the field edge's 1.4:1. Dark moves only
  // where a label on a solid fill failed, so this one is recorded, not retuned.
  { ink: "--input", on: "--sidebar", dark: 1.37, light: 1.46 },
];

describe("the contrast contract", () => {
  for (const [name, theme] of THEMES) {
    for (const tier of TIERS) {
      it(`${tier.name}: ${tier.floor}:1 in the ${name} theme`, () => {
        const measured = tier.pairs.map((p) => ({ ...p, ratio: ratio(theme, p.ink, p.on, p.base) }));
        if (process.env.TOKEN_CONTRAST_PRINT) {
          const low = measured.reduce((a, b) => (b.ratio < a.ratio ? b : a));
          console.log(`${name} ${tier.name}: lowest ${low.ink} on ${low.on} ${low.ratio.toFixed(2)}`);
        }
        const under = measured.filter((p) => p.ratio < tier.floor).map((p) => `${p.ink} on ${p.on}${p.base ? ` over ${p.base}` : ""}: ${p.ratio.toFixed(2)}`);
        expect(under, `under ${tier.floor}:1`).toEqual([]);
      });
    }

    it(`holds each named exception at its measured ratio in the ${name} theme`, () => {
      const measured = EXCEPTIONS.map((e) => `${e.ink} on ${e.on}: ${ratio(theme, e.ink, e.on).toFixed(2)}`);
      expect(measured).toEqual(EXCEPTIONS.map((e) => `${e.ink} on ${e.on}: ${e[name].toFixed(2)}`));
    });
  }

  it("reads the tokens it checks", () => {
    const [, light] = THEMES.find(([name]) => name === "light")!;
    expect(value(light, "--success")).toBe(value(light, "--thread-success"));
    expect(luminance(value(light, "--background"))).toBeCloseTo(1, 3);
    // A thin edge is measured as drawn, over its ground, never as its own colour.
    expect(ratio(light, "--border", "--background")).toBeLessThan(2);
    for (const tier of TIERS) for (const p of tier.pairs) for (const [, theme] of THEMES) expect(theme.has(p.ink) && theme.has(p.on), `${p.ink} on ${p.on}`).toBe(true);
  });
});
