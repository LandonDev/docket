import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { contrast, declarations, resolve, themes } from "./lib/colourMath";

/**
 * The splash paints before the stylesheet loads, so index.html carries a copy
 * of two tokens per theme. They are the app's own, and the logo is drawn in
 * the theme's ink: a white picture of it vanished on the light splash.
 */
const html = readFileSync(join(__dirname, "../index.html"), "utf8");
const style = html.slice(html.indexOf("<style>") + 7, html.indexOf("</style>"));
const app = themes(readFileSync(join(__dirname, "index.css"), "utf8"));
const dark = declarations(style, ":root");
const splash = { dark, light: new Map([...dark, ...declarations(style, "html.theme-light")]) };

describe("the boot splash", () => {
  for (const theme of ["dark", "light"] as const) {
    it(`wears the app's background and foreground in the ${theme} theme`, () => {
      expect(splash[theme].get("--boot-background")).toBe(resolve(app[theme], "var(--background)"));
      expect(splash[theme].get("--boot-foreground")).toBe(resolve(app[theme], "var(--foreground)"));
      expect(contrast(splash[theme].get("--boot-foreground")!, splash[theme].get("--boot-background")!)).toBeGreaterThan(4.5);
    });
  }

  it("draws its logo as a mask in the theme's ink, never as the white picture itself", () => {
    const body = html.slice(html.indexOf("<body>"));
    expect(body).toContain('<div id="boot-mark"></div>');
    expect(body).not.toMatch(/<img/);
    expect(style).toMatch(/#boot-mark \{[^}]*background: var\(--boot-foreground\);[^}]*mask: url\("\.\/monocode\.png"\)/);
    expect(style).toMatch(/#boot-splash \{[^}]*\}/);
    expect(style).toContain("background: var(--boot-background)");
  });

  it("names no retired appearance variable", () => {
    expect(style).not.toMatch(/--theme-hue|--theme-saturation|--sidebar-opacity|--background-lightness/);
  });
});
