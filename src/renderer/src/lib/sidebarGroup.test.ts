import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { oklab, resolve, themes } from "./colourMath";

/**
 * A group in the chrome (a project card in the workspace column) sits on its
 * own fill over the sidebar, a step darker or lighter when hovered and again
 * when selected (docs/DESIGN.md "Colour"). The steps keep their order in both
 * themes, selected the farthest from the sidebar. What reads on each step is
 * lib/tokenContrast.test.ts's.
 */
const { dark, light } = themes(readFileSync(join(__dirname, "../index.css"), "utf8"));

const STEPS = ["--sidebar", "--sidebar-group", "--sidebar-group-hover", "--sidebar-group-selected"];
const lightness = (theme: Map<string, string>, token: string): number => oklab(resolve(theme, `var(${token})`))[0];

describe("sidebar group steps", () => {
  for (const [name, theme] of [["dark", dark], ["light", light]] as const) {
    it(`step away from the sidebar in order in the ${name} theme`, () => {
      const ls = STEPS.map((t) => lightness(theme, t));
      // Dark steps up from the sidebar, light steps down: the same distance order either way.
      const away = ls.map((l) => Math.abs(l - ls[0]));
      for (let i = 1; i < STEPS.length; i++) {
        const gap = away[i] - away[i - 1];
        expect({ step: STEPS[i], ok: gap >= 0.01 - 1e-9 }, `${STEPS[i]} is ${gap.toFixed(4)} past ${STEPS[i - 1]}`).toEqual({ step: STEPS[i], ok: true });
      }
      expect(Math.max(...away)).toBe(away[STEPS.length - 1]);
    });

  }
});
