import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { brandInk, brandOf, POPOVER_LUMINANCE } from "./addonBrand";
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
    // Black marks vanish on the dark menu; pale ones on the white one.
    for (const name of ["notion", "vercel", "github"]) {
      expect(brandInk(hexOf(name), POPOVER_LUMINANCE.dark), name).toBeNull();
      expect(brandInk(hexOf(name), POPOVER_LUMINANCE.light), name).toBe(`#${hexOf(name)}`);
    }
    for (const name of ["supabase", "cloudflare"]) {
      expect(brandInk(hexOf(name), POPOVER_LUMINANCE.light), name).toBeNull();
      expect(brandInk(hexOf(name), POPOVER_LUMINANCE.dark), name).toBe(`#${hexOf(name)}`);
    }
    expect(brandInk("808080", 0.2159)).toBeNull();
  });

  it("stands at 3:1, the bar for a mark", () => {
    // #949494 is 3.03:1 on white, #959595 2.99:1.
    expect(brandInk("949494", 1)).toBe("#949494");
    expect(brandInk("959595", 1)).toBeNull();
  });

  it("measures against the popover of each theme", () => {
    const app = themes(readFileSync(join(__dirname, "../index.css"), "utf8"));
    for (const theme of ["dark", "light"] as const) expect(POPOVER_LUMINANCE[theme]).toBeCloseTo(luminance(resolve(app[theme], "var(--popover)")), 3);
  });

  it("flags the one raster mark drawn light on clear, which takes a matte tile", () => {
    expect(brandOf("cosmic-admin")).toMatchObject({ lightOnClear: true });
    expect(brandOf("lifeos")).not.toHaveProperty("lightOnClear");
  });
});
