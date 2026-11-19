// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const host = vi.hoisted(() => ({ platform: "linux", web: false }));

vi.mock("../lib/native", () => ({
  isWebMode: () => host.web,
  nativePlatform: () => host.platform,
  getCurrentWindow: () => ({
    isMaximized: () => Promise.resolve(false),
    onResized: () => Promise.resolve(() => {}),
    minimize: () => Promise.resolve(),
    toggleMaximize: () => Promise.resolve(),
    close: () => Promise.resolve(),
  }),
}));

import { WindowControls } from "./WindowControls";

afterEach(() => {
  cleanup();
  host.platform = "linux";
  host.web = false;
  document.querySelector('meta[name="theme-color"]')?.remove();
});

describe("WindowControls", () => {
  it("Close fills solid red on hover, DESIGN's one exception to status fills above /10; the others stay ghost", () => {
    render(<WindowControls />);
    const close = screen.getByRole("button", { name: "Close window" });
    expect(close.className.split(/\s+/)).toEqual(expect.arrayContaining(["hover:bg-destructive", "hover:text-destructive-foreground"]));
    for (const name of ["Minimize window", "Maximize window"])
      expect(screen.getByRole("button", { name }).className).not.toContain("hover:bg-destructive");
  });

  it("a Windows desktop draws none of ours: it leaves the room Windows' own buttons take and says what they sit on", () => {
    host.platform = "win32";
    document.documentElement.style.setProperty("--sidebar", "#f7f7f5");
    const { container } = render(<WindowControls />);
    expect(screen.queryByRole("button")).toBeNull();
    const space = container.querySelector<HTMLElement>("[data-caption-space]")!;
    expect(space.style.width).toContain("titlebar-area-width");
    expect(document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')!.content).toBe("#f7f7f5");
    // A theme switch says the new shell colour, so main can re-ink the glyphs.
    document.documentElement.style.setProperty("--sidebar", "#111111");
    window.dispatchEvent(new CustomEvent("monocode:schemechange"));
    expect(document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')!.content).toBe("#111111");
    document.documentElement.style.removeProperty("--sidebar");
  });

  it("the /ui page in a Windows browser keeps the drawn controls: there is no window frame of ours there", () => {
    host.platform = "win32";
    host.web = true;
    render(<WindowControls />);
    expect(screen.getByRole("button", { name: "Close window" })).toBeTruthy();
  });
});
