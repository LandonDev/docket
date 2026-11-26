import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { oklab, over, resolve, themes } from "./colourMath";

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

    // An item on the chrome (a rail row, a thread row, a tab, a pressed control in the title bar) is bare at rest,
    // hovers on `chrome-hover` and is selected on the groups' selected step: the hover must stay between the two,
    // or hovering a neighbour looks more chosen than the chosen one.
    it(`keeps a hovered item between the sidebar and the selected step in the ${name} theme`, () => {
      const sidebar = resolve(theme, "var(--sidebar)");
      const l = (colour: string): number => oklab(colour)[0];
      const selected = Math.abs(lightness(theme, "--sidebar-group-selected") - l(sidebar));
      for (const token of ["--chrome-hover", "--chrome-hover-ghost"]) {
        const hover = Math.abs(l(over(resolve(theme, `var(${token})`), sidebar)) - l(sidebar));
        expect({ token, seen: hover >= 0.01, underSelected: selected - hover >= 0.01 }, `${token}: ${hover.toFixed(4)} from the sidebar, selected ${selected.toFixed(4)}`).toEqual({ token, seen: true, underSelected: true });
      }
    });

  }
});
