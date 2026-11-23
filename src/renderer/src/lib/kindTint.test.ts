import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { contrast, declarations, hue, hueDistance, oklab, over, resolve, themes } from "./colourMath";

/**
 * A file's kind tint colours its glyph in the Files place and nothing else
 * (docs/DESIGN.md "File kind tints"). It must never read as Needs you (amber)
 * or Failed (red), must show on every surface a row sits on, and the nine
 * must be told apart. A near-neutral tint (chroma under 0.04) reads as no
 * hue, so it is exempt from the hue rules.
 */
const css = readFileSync(join(__dirname, "../index.css"), "utf8");
const { dark, light } = themes(css);

const KINDS = ["doc", "sheet", "slides", "pdf", "image", "video", "audio", "text", "folder"].map((k) => `--kind-${k}`);
const STATUSES = ["--warning", "--destructive"];
const NEUTRAL_CHROMA = 0.04;
// Where a glyph sits: the page, a card, a popover, the rail, a selected row (`muted`), and each of those hovered (foreground at 5%).
const SURFACES = ["--background", "--card", "--popover", "--sidebar", "--muted"];
const HOVER = "color-mix(in srgb, var(--foreground) 5%, transparent)";

const chroma = (colour: string): number => {
  const [, a, b] = oklab(over(colour, "#000"));
  return Math.hypot(a, b);
};

describe("file kind tints", () => {
  it("declares exactly these nine in each theme's block", () => {
    const kindsIn = (selector: string): string[] => [...declarations(css, selector).keys()].filter((n) => n.startsWith("--kind-")).sort();
    expect(kindsIn(":root")).toEqual([...KINDS].sort());
    expect(kindsIn("html.theme-light")).toEqual([...KINDS].sort());
  });

  for (const [name, theme] of [["dark", dark], ["light", light]] as const) {
    const v = (token: string): string => resolve(theme, `var(${token})`);
    const chromatic = KINDS.filter((k) => chroma(v(k)) >= NEUTRAL_CHROMA);

    it(`holds in-gamut oklch literals in the ${name} theme, so the hue drawn is the hue measured`, () => {
      for (const kind of KINDS) {
        const m = /^oklch\(([\d.]+) ([\d.]+) ([\d.]+)\)$/.exec(v(kind));
        expect(m, `${kind} in ${name}: ${v(kind)}`).not.toBeNull();
        const measured = chroma(v(kind));
        expect(Math.abs(measured - parseFloat(m![2])), `${kind} in ${name}: chroma ${m![2]} drawn as ${measured.toFixed(3)}`).toBeLessThan(0.005);
      }
    });

    it(`keeps text and folder near-neutral and the other seven chromatic in the ${name} theme`, () => {
      expect(chromatic, name).toEqual(KINDS.filter((k) => k !== "--kind-text" && k !== "--kind-folder"));
    });

    it(`stays 30° of OKLCH hue from amber and red in the ${name} theme`, () => {
      const near = chromatic.flatMap((kind) =>
        STATUSES.map((status) => ({ kind, status, degrees: hueDistance(v(kind), v(status)) }))
          .filter((d) => d.degrees < 30)
          .map((d) => `${d.kind} from ${d.status} in ${name}: ${d.degrees.toFixed(1)}°`),
      );
      expect(near).toEqual([]);
    });

    it(`keeps the chromatic kinds 20° of hue apart in the ${name} theme`, () => {
      const close: string[] = [];
      for (const [i, a] of chromatic.entries())
        for (const b of chromatic.slice(i + 1)) {
          const degrees = hueDistance(v(a), v(b));
          if (degrees <= 20) close.push(`${a} and ${b} in ${name}: ${degrees.toFixed(1)}° (${hue(v(a)).toFixed(0)}°, ${hue(v(b)).toFixed(0)}°)`);
        }
      expect(close).toEqual([]);
    });

    it(`reaches 3:1 on every surface a glyph sits on, selected and hovered rows too, in the ${name} theme`, () => {
      const under: string[] = [];
      for (const kind of KINDS)
        for (const surface of SURFACES)
          for (const [label, ground] of [
            [surface, over(v(surface), v("--background"))],
            [`${surface} hovered`, over(resolve(theme, HOVER), v(surface), v("--background"))],
          ] as const) {
            const ratio = contrast(over(v(kind), ground), ground);
            if (ratio < 3) under.push(`${kind} on ${label} in ${name}: ${ratio.toFixed(2)}`);
          }
      expect(under).toEqual([]);
    });
  }
});
