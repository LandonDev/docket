// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComputerTile } from "../lib/computers";
import { ComputersPage, ComputersView, Tile, tileLine } from "./ComputersView";
import fixtures from "./ComputersView.fixtures";
import { tile } from "./threads/computer/LiveFullView.fixtures";

const h = vi.hoisted(() => ({ tiles: [] as ComputerTile[], desktop: true, streams: [] as { key: string; take: boolean | undefined; run: boolean }[] }));
vi.mock("../lib/computers", async (original) => ({ ...(await original<typeof import("../lib/computers")>()), useComputers: () => h.tiles }));
vi.mock("../lib/computerSessions", async (original) => ({ ...(await original<typeof import("../lib/computerSessions")>()), previewContext: () => ({ desktop: h.desktop, localId: null }) }));
vi.mock("./threads/computer/Viewport", async (original) => {
  const actual = await original<typeof import("./threads/computer/Viewport")>();
  return {
    ...actual,
    // the stream itself is the viewport tests' business: here, what a tile asks of it
    useLiveStream: (entry: { previewKey?: string } | null, run: boolean, _box: unknown, _measure: unknown, opts?: { take?: boolean }) => {
      h.streams.push({ key: entry?.previewKey ?? "", take: opts?.take, run });
      return { state: { status: "live", app: "Chromium", window: "Concur", width: 1280, height: 800, drawn: true }, retry: () => undefined, canvas: { current: null }, ring: { current: null }, mode: "video" };
    },
  };
});
// the window's own buttons belong to the frame's tests
vi.mock("../chrome/WindowControls", () => ({ WindowControls: () => null }));
vi.mock("../chrome/TitleBar", () => ({ OverlayNav: () => null }));
const openLightbox = vi.hoisted(() => vi.fn());
vi.mock("../chrome/lightboxStore", () => ({ openLightbox }));

beforeEach(() => {
  h.tiles = [];
  h.desktop = true;
  h.streams.length = 0;
  openLightbox.mockReset();
});
afterEach(cleanup);

describe("the Computers page", () => {
  it("draws every fixture: a tile for each computer, or the one empty state", () => {
    for (const fixture of fixtures) {
      const view = render(<ComputersPage {...fixture.props} />);
      expect(view.container.querySelectorAll('[data-slot="computer-tile"]'), fixture.name).toHaveLength(fixture.props.tiles.length);
      if (!fixture.props.tiles.length) expect(view.container.textContent, fixture.name).toContain("Nothing is being driven");
      view.unmount();
    }
  });

  it("says nothing is being driven, with one line and no action", () => {
    render(<ComputersPage tiles={[]} onOpenSession={() => undefined} />);
    expect(screen.getByText("Nothing is being driven")).not.toBeNull();
    expect(screen.getByText("A browser or an app an agent is using shows here, live.")).not.toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("is one to three across by how many there are: one alone has the page", () => {
    const grid = (n: number): string => {
      const view = render(<ComputersPage tiles={Array.from({ length: n }, (_, i) => tile({ id: `box\nt${i}` }))} onOpenSession={() => undefined} pictureOf={() => null} />);
      const cls = view.container.querySelector('[data-slot="computer-tiles"]')!.className;
      view.unmount();
      return cls;
    };
    expect(grid(1)).not.toContain("grid-cols-2");
    expect(grid(2)).toContain("@[44rem]/computers:grid-cols-2");
    expect(grid(2)).not.toContain("grid-cols-3");
    expect(grid(3)).toContain("@[66rem]/computers:grid-cols-3");
  });

  it("a tile says its thread, what it is doing and where, as one comma sentence; its title goes to the thread", () => {
    const opened: [string, string][] = [];
    render(<Tile tile={tile()} all={[]} onOpenSession={(thread, host) => opened.push([thread, host])} />);
    const facts = screen.getByRole("article").querySelector('[data-slot="facts"]')!;
    expect([...facts.children].map((c) => c.textContent)).toEqual(["Clicking Submit in Chromium", "The box"]);
    fireEvent.click(screen.getByRole("button", { name: "File the March expense report" }));
    expect(opened).toEqual([["t1", "box"]]);
    // a page he drives reads so, in the foreground
    cleanup();
    render(<Tile tile={tile({ driving: true, doing: null })} all={[]} onOpenSession={() => undefined} />);
    expect(tileLine(tile({ driving: true, doing: "stale" }))).toBe("You are driving");
    expect(screen.getByText("You are driving").className).toContain("text-foreground");
    // between calls there is only where it runs
    cleanup();
    render(<Tile tile={tile({ doing: null })} all={[]} onOpenSession={() => undefined} />);
    expect([...screen.getByRole("article").querySelector('[data-slot="facts"]')!.children].map((c) => c.textContent)).toEqual(["The box"]);
  });

  it("keeps a tile's controls in the standard reveal: Take over or Hand back where it has a driver, and Stop", () => {
    render(<Tile tile={tile()} all={[]} onOpenSession={() => undefined} />);
    const controls = screen.getByRole("article").querySelector('[data-slot="computer-controls"]')!;
    expect(controls.parentElement!.className).toContain("group-hover/item:opacity-100");
    expect(controls.parentElement!.className).toContain("has-focus-visible:opacity-100");
    expect(within(controls as HTMLElement).getByRole("button", { name: "Take over" })).not.toBeNull();
    expect(within(controls as HTMLElement).getByRole("button", { name: "Stop File the March expense report" })).not.toBeNull();
    cleanup();
    render(<Tile tile={tile({ browser: false })} all={[]} onOpenSession={() => undefined} />);
    expect(screen.queryByRole("button", { name: "Take over" })).toBeNull();
  });

  it("plays a tile's stream without taking the box's display, and opens its full view on a click of the picture", () => {
    h.tiles = [tile()];
    render(<ComputersView onClose={() => undefined} onToggleSidebar={() => undefined} onOpenSession={() => undefined} />);
    expect(h.streams.at(-1)).toMatchObject({ key: "t1", take: false, run: true });
    fireEvent.click(screen.getByRole("button", { name: "Live view of Expense report in Chromium" }));
    expect(openLightbox).toHaveBeenCalledTimes(1);
    expect(openLightbox.mock.calls[0][0]).toEqual([{ environmentId: "box", name: "Live view of Expense report in Chromium", live: { threadId: "t1" } }]);
  });

  it("draws one muted line in place of a picture this desktop may not draw, naming the machine", () => {
    h.tiles = [tile({ shownOn: "Studio", where: "Studio", browser: false })];
    render(<ComputersView onClose={() => undefined} onToggleSidebar={() => undefined} onOpenSession={() => undefined} />);
    expect(screen.getByText("Shown on Studio only")).not.toBeNull();
    expect(h.streams).toEqual([]);
  });

  it("is a region named Computers; its title press closes the page and goes to the thread; the browser /ui draws no picture", () => {
    h.tiles = [tile()];
    const closed = vi.fn();
    const opened = vi.fn();
    const view = render(<ComputersView onClose={closed} onToggleSidebar={() => undefined} onOpenSession={opened} />);
    expect(screen.getByRole("region", { name: "Computers" })).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "File the March expense report" }));
    expect(closed).toHaveBeenCalledTimes(1);
    expect(opened).toHaveBeenCalledWith("t1", "box");
    view.unmount();
    h.desktop = false;
    h.streams.length = 0;
    render(<ComputersView onClose={closed} onToggleSidebar={() => undefined} onOpenSession={opened} />);
    expect(screen.getByRole("article")).not.toBeNull();
    expect(screen.queryByRole("button", { name: /^Live view/ })).toBeNull();
    expect(h.streams).toEqual([]);
  });
});
