import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SCHEME_CHANGE_EVENT } from "../lib/appearance";
import { AddonMark } from "./AddonMark";

afterEach(cleanup);
const scheme = (to: "dark" | "light") => act(() => void window.dispatchEvent(new CustomEvent(SCHEME_CHANGE_EVENT, { detail: to })));
const fill = (container: HTMLElement) => container.querySelector("path")!.getAttribute("fill");

describe("AddonMark", () => {
  it("on the light menu draws a brand in its colour only where that colour is seen, else in the foreground; dark keeps every brand's colour", () => {
    const { container } = render(<AddonMark command={{ name: "supabase", source: "mcp" }} />);
    scheme("light");
    // Supabase's green is 2:1 on white: the mark takes the row's ink.
    expect(fill(container)).toBe("currentColor");
    expect(container.querySelector("svg")!.getAttribute("class")).toContain("text-foreground");
    scheme("dark");
    expect(fill(container)).toMatch(/^#[0-9A-F]{6}$/i);
    expect(container.querySelector("svg")!.getAttribute("class")).not.toContain("text-foreground");
    cleanup();
    const notion = render(<AddonMark command={{ name: "notion", source: "mcp" }} />);
    scheme("dark");
    expect(fill(notion.container)).toMatch(/^#[0-9A-F]{6}$/i);
  });

  it("stays monochrome inside a chip, in the chip's own ink", () => {
    const { container } = render(<AddonMark command={{ name: "linear", source: "mcp" }} colored={false} className="text-muted-foreground" />);
    expect(fill(container)).toBe("currentColor");
    expect(container.querySelector("svg")!.getAttribute("class")).not.toContain("text-foreground");
  });

  it("seats a light raster mark on the theme's mark tile, and leaves a mark with its own tile alone", () => {
    const light = render(<AddonMark command={{ name: "cosmic-admin", source: "mcp" }} />);
    const tile = light.container.querySelector("[data-slot=addon-mark-tile]")!;
    expect(tile.className).toContain("bg-(--mark-tile)");
    expect(tile.querySelector("img")).toBeTruthy();
    const own = render(<AddonMark command={{ name: "lifeos", source: "mcp" }} />);
    expect(own.container.querySelector("[data-slot=addon-mark-tile]")).toBeNull();
    expect(own.container.querySelector("img")).toBeTruthy();
  });
});
