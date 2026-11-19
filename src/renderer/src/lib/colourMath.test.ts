import { describe, expect, it } from "vitest";
import { contrast, hue, luminance, oklab, over, resolve, rgba } from "./colourMath";

const near = (got: number[], want: number[], digits = 3): void => got.forEach((c, i) => expect(c, `channel ${i}`).toBeCloseTo(want[i], digits));

describe("colourMath", () => {
  it("reads every hex length", () => {
    near(rgba("#fff"), [1, 1, 1, 1]);
    near(rgba("#f008"), [1, 0, 0, 0x88 / 255]);
    near(rgba("#3B82F6"), [0x3b / 255, 0x82 / 255, 0xf6 / 255, 1]);
    near(rgba("#00000000"), [0, 0, 0, 0]);
  });

  it("reads hsl()", () => {
    near(rgba("hsl(0 100% 50%)"), [1, 0, 0, 1]);
    near(rgba("hsl(120 100% 25%)"), [0, 0.5, 0, 1]);
    // hsl(211 92% 62%) is #459bf7 by the CSS algorithm.
    near(rgba("hsl(211 92% 62%)"), [0x45 / 255, 0x9b / 255, 0xf7 / 255, 1], 2);
    near(rgba("hsla(0, 0%, 50%, .5)"), [0.5, 0.5, 0.5, 0.5]);
  });

  it("reads rgb() and oklch(), with an alpha", () => {
    near(rgba("rgb(15 23 42 / 0.1)"), [15 / 255, 23 / 255, 42 / 255, 0.1]);
    near(rgba("rgba(255,255,255,.12)"), [1, 1, 1, 0.12]);
    near(rgba("oklch(1 0 0)"), [1, 1, 1, 1]);
    near(rgba("oklch(0 0 0 / 10%)"), [0, 0, 0, 0.1]);
  });

  it("reads a colour mixed toward transparent as that colour at n% alpha", () => {
    near(rgba("color-mix(in srgb, #ff0000 14%, transparent)"), [1, 0, 0, 0.14]);
    near(rgba("color-mix(in srgb, rgb(0 0 0 / 0.5) 50%, transparent)"), [0, 0, 0, 0.25]);
  });

  it("refuses what it cannot read", () => {
    for (const value of ["color-mix(in oklch, red 50%, blue)", "#12", "rebeccapurple", ""]) expect(() => rgba(value), value).toThrow(/unparsed/);
  });

  it("lays a thin colour over its ground, and one thin colour over another", () => {
    near(rgba(over("rgb(0 0 0 / 0.5)", "#ffffff")), [0.5, 0.5, 0.5, 1]);
    near(rgba(over("#123456", "#ffffff")), rgba("#123456"));
    // 50% white over 50% black over white: 0.5 + 0.5 * (0.5 * 0 + 0.5 * 1).
    near(rgba(over("rgb(255 255 255 / 0.5)", "rgb(0 0 0 / 0.5)", "#ffffff")), [0.75, 0.75, 0.75, 1]);
    expect(() => over("rgb(0 0 0 / 0.5)")).toThrow(/not opaque/);
  });

  it("has no luminance for a colour with nothing under it", () => {
    expect(() => luminance("rgb(0 0 0 / 0.5)")).toThrow(/over/);
    expect(contrast(over("rgb(0 0 0 / 0.5)", "#fff"), "#fff")).toBeCloseTo(contrast("#808080", "#fff"), 1);
  });

  it("follows var() inside a value", () => {
    const theme = new Map([["--a", "var(--b)"], ["--b", "#ff0000"], ["--wash", "color-mix(in srgb, var(--a) 10%, transparent)"]]);
    expect(resolve(theme, "var(--wash)")).toBe("color-mix(in srgb, #ff0000 10%, transparent)");
    near(rgba(resolve(theme, "var(--wash)")), [1, 0, 0, 0.1]);
  });

  it("keeps its measures", () => {
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(oklab("oklch(0.5 0 0)")[0]).toBeCloseTo(0.5, 3);
    expect(hue("oklch(0.6 0.12 285)")).toBeCloseTo(285, 0);
  });
});
