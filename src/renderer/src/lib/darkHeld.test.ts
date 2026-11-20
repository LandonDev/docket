import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { declarations } from "./colourMath";
import { HIGHLIGHT_INKS } from "./editorPalette";
import { DARCULA } from "./intellijTheme";
import { ANSI, MINIMUM_CONTRAST, TERMINAL_DARK } from "./terminalPalette";

/**
 * Dark is held (docs/agents/appearance.md). The owner works in the dark theme
 * every day, so no change may move how it looks without his asking.
 * darkHeld.json is a frozen copy of the dark token block and of the dark
 * code palettes, as they were before the light theme was built. A token may
 * be added; one that is here may not move or go.
 *
 * If this fails, a dark value changed. Give the new look to light's value
 * and leave dark's (index.css "Held in dark" shows how), or, if the owner
 * asked for the change in dark, update darkHeld.json in the same commit and
 * say so in its message.
 */
const WHY = "Dark is held: put the new look in light's value, or update lib/darkHeld.json if the owner asked for this change in dark.";
const held = JSON.parse(readFileSync(join(__dirname, "darkHeld.json"), "utf8")) as { tokens: Record<string, string>; palettes: Record<string, unknown> };
const root = declarations(readFileSync(join(__dirname, "../index.css"), "utf8"), ":root");
const flat = (value: string | undefined): string | undefined => value?.replace(/\s+/g, " ").trim();

describe("dark, held as it was", () => {
  it("keeps every dark token's value", () => {
    const moved = Object.entries(held.tokens)
      .filter(([name, value]) => flat(root.get(name)) !== value)
      .map(([name, value]) => `${name}: was ${value}, is ${flat(root.get(name)) ?? "gone"}`);
    expect(moved, WHY).toEqual([]);
    expect(Object.keys(held.tokens).length).toBeGreaterThan(140);
  });

  it("keeps the dark code palettes: the terminal's, CodeMirror's and Darcula", () => {
    expect({ ansi: ANSI.dark, terminal: TERMINAL_DARK, terminalMinimumContrast: MINIMUM_CONTRAST.dark, codemirror: HIGHLIGHT_INKS.dark, darcula: DARCULA }, WHY).toEqual(held.palettes);
  });

  it("gives every token that is held in dark a light value of its own, so light is never the thing held back", () => {
    const light = declarations(readFileSync(join(__dirname, "../index.css"), "utf8"), "html.theme-light");
    // The names under "Held in dark" in index.css: each has two values on purpose.
    const HELD = ["--link-color", "--near-foreground", "--soft-foreground", "--ink-35", "--ink-38", "--ink-40", "--ink-45", "--ink-50", "--ink-55", "--ink-muted-60", "--diff-context-dim", "--diff-context-strong", "--pr-code-keyword", "--pr-code-type", "--slide-stage", "--slide-stage-inset", "--mark-tile", "--sheet-shadow", "--calendar-selected", "--calendar-today", "--radius", "--ring-duration"];
    for (const name of HELD) {
      expect(root.has(name), `${name} in :root`).toBe(true);
      expect(light.has(name), `${name} in html.theme-light`).toBe(true);
      expect(flat(light.get(name)), name).not.toBe(flat(root.get(name)));
    }
  });
});
