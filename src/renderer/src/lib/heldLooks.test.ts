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
