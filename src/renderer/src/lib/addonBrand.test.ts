import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { brandInk, brandOf, MARK_SURFACE } from "./addonBrand";
import { luminance, resolve, themes } from "./colourMath";

describe("brandOf", () => {
  it("matches a known connector case-insensitively", () => {
    expect(brandOf("Linear")).toMatchObject({ hex: expect.any(String) });
    expect(brandOf("convex")).toMatchObject({ hex: expect.any(String) });
  });
  it("gives cosmic-admin its own raster mark, not a simple-icons vector", () => {
    const brand = brandOf("cosmic-admin");
    expect(brand && "img" in brand).toBe(true);
  });
  it("gives lifeos its app icon as a raster mark", () => {
    const brand = brandOf("lifeos");
    expect(brand && "img" in brand).toBe(true);
    expect(brandOf("LifeOS")).toBe(brand);
  });
  it("is undefined for an addon with no brand mark", () => {
    expect(brandOf("some-unknown-mcp-server")).toBeUndefined();
  });
});

describe("brandInk", () => {
  const hexOf = (name: string): string => {
    const brand = brandOf(name);
    if (!brand || !("hex" in brand)) throw new Error(`${name} has no vector mark`);
    return brand.hex;
  };

  it("keeps a brand's colour where it is seen, and gives it up where it is not", () => {
    // Pale marks vanish on the white menu; black ones would on a dark surface.
    for (const name of ["supabase", "cloudflare"]) expect(brandInk(hexOf(name), MARK_SURFACE.light), name).toBeNull();
    for (const name of ["notion", "vercel", "github", "linear"]) expect(brandInk(hexOf(name), MARK_SURFACE.light), name).toBe(`#${hexOf(name)}`);
    expect(brandInk(hexOf("notion"), 0.0138)).toBeNull();
    expect(brandInk(hexOf("supabase"), 0.0138)).toBe(`#${hexOf("supabase")}`);
  });

  it("stands at 3:1, the bar for a mark", () => {
    // #949494 is 3.03:1 on white, #959595 2.99:1.
    expect(brandInk("949494", 1)).toBe("#949494");
    expect(brandInk("959595", 1)).toBeNull();
  });

  it("judges against light's popover, and nothing in dark, which is held as it was", () => {
    const app = themes(readFileSync(join(__dirname, "../index.css"), "utf8"));
    expect(MARK_SURFACE.light).toBeCloseTo(luminance(resolve(app.light, "var(--popover)")), 3);
    expect(MARK_SURFACE.dark).toBeNull();
    for (const name of ["notion", "supabase"]) expect(brandInk(hexOf(name), MARK_SURFACE.dark)).toBe(`#${hexOf(name)}`);
  });

  it("flags the one raster mark drawn light on clear, which takes a matte tile in light", () => {
    expect(brandOf("cosmic-admin")).toMatchObject({ lightOnClear: true });
    expect(brandOf("lifeos")).not.toHaveProperty("lightOnClear");
    const app = themes(readFileSync(join(__dirname, "../index.css"), "utf8"));
    expect(resolve(app.light, "var(--mark-tile)")).toBe(resolve(app.light, "var(--matte)"));
    expect(resolve(app.dark, "var(--mark-tile)")).toBe("transparent");
  });
});
