import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(join(__dirname, "../index.css"), "utf8");

// work-kit's outline button standing as a field (TargetField beside a select): the field's edge in light, the button's
// hairline in dark (held: docs/agents/appearance.md "Dark is held").
describe("an outline button that stands as a field", () => {
  it("draws its edge from the held token, which is the field's in light and the button's own in dark", () => {
    expect(css).toMatch(/\.t-raise-outline\.t-raise-field::before\s*\{\s*--raise-shadow: inset 0 0 0 1px var\(--outline-field-edge\);/);
    const root = css.slice(0, css.indexOf("\nhtml.theme-light {"));
    const light = css.slice(css.indexOf("\nhtml.theme-light {"));
    expect(root).toContain("--outline-field-edge: var(--border);");
    expect(light).toContain("--outline-field-edge: var(--input);");
  });
});

// A bone on matte (a computer's picture on its way): the bone itself in dark, a wash of the light page in light.
describe("a bone on matte", () => {
  it("is the bone in dark and a light wash in light, a token the theme maps", () => {
    const root = css.slice(0, css.indexOf("\nhtml.theme-light {"));
    const light = css.slice(css.indexOf("\nhtml.theme-light {"));
    expect(root).toContain("--skeleton-matte: var(--skeleton);");
    expect(light).toContain("--skeleton-matte: color-mix(in srgb, var(--background) 16%, transparent);");
    expect(css).toContain("--color-skeleton-matte: var(--skeleton-matte);");
  });
});

// A video or a picture in a pane (the file pane, Work's player): the page in dark, as it was; `stage` in light.
describe("the media ground", () => {
  it("is the page in dark and the stage in light, a token the theme maps", () => {
    const root = css.slice(0, css.indexOf("\nhtml.theme-light {"));
    const light = css.slice(css.indexOf("\nhtml.theme-light {"));
    expect(root).toContain("--media-ground: var(--background);");
    expect(light).toContain("--media-ground: var(--stage);");
    expect(css).toContain("--color-media-ground: var(--media-ground);");
  });
});

// A bone on stage: the bone in dark, as it was; a firmer wash in light.
describe("a bone on stage", () => {
  it("is the bone in dark and foreground 12% in light, a token the theme maps", () => {
    const root = css.slice(0, css.indexOf("\nhtml.theme-light {"));
    const light = css.slice(css.indexOf("\nhtml.theme-light {"));
    expect(root).toContain("--skeleton-stage: var(--skeleton);");
    expect(light).toContain("--skeleton-stage: color-mix(in srgb, var(--foreground) 12%, transparent);");
    expect(css).toContain("--color-skeleton-stage: var(--skeleton-stage);");
  });
});

// Quieter words on matte: muted-foreground in dark, as it was; a light grey over the matte in light.
describe("quieter words on matte", () => {
  it("are muted-foreground in dark and a light grey in light, a token the theme maps", () => {
    const root = css.slice(0, css.indexOf("\nhtml.theme-light {"));
    const light = css.slice(css.indexOf("\nhtml.theme-light {"));
    expect(root).toContain("--matte-muted-foreground: var(--muted-foreground);");
    expect(light).toContain("--matte-muted-foreground: color-mix(in srgb, var(--background) 60%, transparent);");
    expect(css).toContain("--color-matte-muted-foreground: var(--matte-muted-foreground);");
  });
});
