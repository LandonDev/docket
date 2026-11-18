import { describe, expect, it } from "vitest";
import { brandOf } from "./addonBrand";

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
