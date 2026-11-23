// @vitest-environment jsdom
/**
 * The shelf's tiles: two groups, a tile's name and kind, the arrows walking
 * the tiles in reading order and by row, Return making once, the spinner only
 * after a make has taken 150ms, the tile pressing without moving, and a
 * tile's menu from a right-click and from its ⋯ with a starter's rows and his own.
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Template } from "@shared/work/templates";
import { shelfGroups, tileMenu } from "./model";
import { nextTile, Shelf, SPIN_AFTER_MS } from "./Shelf";

const tpl = (id: string, name: string, over: Partial<Template> = {}): Template => ({
  id,
  name,
  kind: "document",
  form: "docx",
  where: id.startsWith("job:") ? "job" : id.startsWith("all:") ? "all" : "starter",
  fields: [],
  source: { at: "file", host: "box", path: `/w/Templates/${name}.docx` },
  ...over,
});

const TEMPLATES = [
  tpl("job:Crew memo.docx", "Crew memo"),
  tpl("starter:ref/game-report", "Game report", { fields: ["Home", "Away"] }),
  tpl("starter:ref/season-log", "Season log", { kind: "sheet", form: "xlsx" }),
  tpl("starter:any/meeting-notes", "Meeting notes"),
  tpl("all:Pitch.pptx", "Pitch", { kind: "deck", form: "pptx" }),
];
const groups = shelfGroups(TEMPLATES, "Dummy Esports");
const menuRows = (t: Template) => tileMenu(t, "Dummy Esports").map((row) => ({ kind: "item" as const, ...row }));
const tiles = () => screen.getAllByRole("button").filter((b) => b.hasAttribute("data-tile-open"));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("the shelf", () => {
  it("draws the job's group then All jobs, each a 12px label over its tiles, a tile its plate and one line of glyph and name", () => {
    render(<Shelf groups={groups} layout="page" making={null} onPress={() => {}} />);
    const job = screen.getByRole("region", { name: "Dummy Esports" });
    expect(within(job).getByRole("heading").className).toContain("text-xs");
    expect(within(job).getAllByRole("button").map((b) => b.getAttribute("aria-label"))).toEqual(["Crew memo", "Game report", "Season log"]);
    const all = screen.getByRole("region", { name: "All jobs" });
    expect(within(all).getAllByRole("button").map((b) => b.getAttribute("aria-label"))).toEqual(["Pitch", "Meeting notes"]);
    const tile = job.querySelector('[data-tile="starter:ref/season-log"]')!;
    expect(tile.querySelector('[data-plate="sheet"]')).not.toBeNull();
    // No badge, count or second line: the plate, then the name.
    expect(tile.textContent).toBe("Season log");
  });

  it("aligns a tile to the grid's edge, washes it on hover and scales it while pressed, never moving it", () => {
    render(<Shelf groups={groups} layout="page" making={null} onPress={() => {}} />);
    const tile = document.querySelector('[data-tile="job:Crew memo.docx"]')!;
    for (const cls of ["-m-1.5", "p-1.5", "rounded-xl", "hover:bg-foreground/5", "has-[>[data-tile-open]:active]:scale-[0.97]", "motion-reduce:transition-none"]) expect(tile.className).toContain(cls);
    expect(document.querySelector('[data-tile="job:Crew memo.docx"] [data-tile-open]')!.className).toContain("rounded-[inherit]");
  });

  it("lays the dialog's grid in three columns, two under 640px, and the page's by 148px tiles", () => {
    const { container, rerender } = render(<Shelf groups={groups} layout="dialog" making={null} onPress={() => {}} />);
    expect(container.querySelector("section > div")!.className).toContain("grid-cols-3 gap-x-3 gap-y-4 max-sm:grid-cols-2");
    rerender(<Shelf groups={groups} layout="page" making={null} onPress={() => {}} />);
    expect(container.querySelector("section > div")!.className).toContain("grid-cols-[repeat(auto-fill,minmax(148px,1fr))]");
  });

  it("is one tab stop, and the arrows walk the tiles across both groups", () => {
    render(<Shelf groups={groups} layout="page" making={null} onPress={() => {}} />);
    const all = tiles();
    expect(all.map((t) => t.tabIndex)).toEqual([0, -1, -1, -1, -1]);
    all[0]!.focus();
    fireEvent.keyDown(all[0]!, { key: "ArrowRight" });
    expect(document.activeElement).toBe(all[1]);
    expect(tiles().map((t) => t.tabIndex)).toEqual([-1, 0, -1, -1, -1]);
    fireEvent.keyDown(all[1]!, { key: "End" });
    expect(document.activeElement).toBe(all[4]);
    fireEvent.keyDown(all[4]!, { key: "ArrowRight" });
    expect(document.activeElement).toBe(all[4]);
    fireEvent.keyDown(all[4]!, { key: "Home" });
    expect(document.activeElement).toBe(all[0]);
  });

  it("walks up and down to the nearest tile of the next row", () => {
    // Three in a row, then two: the second row's second tile sits under the first row's second.
    const at = (left: number, top: number) => ({ getBoundingClientRect: () => ({ left, top, width: 100, height: 80 }) }) as unknown as HTMLElement;
    const grid = [at(0, 0), at(110, 0), at(220, 0), at(0, 100), at(110, 100)];
    expect(nextTile(grid, 1, "ArrowDown")).toBe(4);
    expect(nextTile(grid, 2, "ArrowDown")).toBe(4);
    expect(nextTile(grid, 3, "ArrowUp")).toBe(0);
    expect(nextTile(grid, 0, "ArrowUp")).toBe(0);
    expect(nextTile(grid, 4, "ArrowDown")).toBe(4);
  });

  it("makes on Return, once", () => {
    const onPress = vi.fn();
    render(<Shelf groups={groups} layout="dialog" making={null} onPress={onPress} />);
    const tile = tiles()[1]!;
    const enter = fireEvent.keyDown(tile, { key: "Enter" });
    expect(enter).toBe(false);
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(onPress.mock.calls[0]![0].id).toBe("starter:ref/game-report");
    fireEvent.click(tile);
    expect(onPress).toHaveBeenCalledTimes(2);
  });

  it("turns the glyph to a spinner only once a make has taken 150ms", () => {
    vi.useFakeTimers();
    const { rerender } = render(<Shelf groups={groups} layout="page" making={null} onPress={() => {}} />);
    const tile = () => document.querySelector('[data-tile="job:Crew memo.docx"]')!;
    rerender(<Shelf groups={groups} layout="page" making="job:Crew memo.docx" onPress={() => {}} />);
    expect(tile().querySelector('[data-slot="spinner"]')).toBeNull();
    act(() => void vi.advanceTimersByTime(SPIN_AFTER_MS - 1));
    expect(tile().querySelector('[data-slot="spinner"]')).toBeNull();
    act(() => void vi.advanceTimersByTime(1));
    expect(tile().querySelector('[data-slot="spinner"]')).not.toBeNull();
    expect(tile().querySelector("[data-tile-open]")!.getAttribute("aria-busy")).toBe("true");
    rerender(<Shelf groups={groups} layout="page" making={null} onPress={() => {}} />);
    expect(tile().querySelector('[data-slot="spinner"]')).toBeNull();
  });

  it("has no menu in the dialog", () => {
    render(<Shelf groups={groups} layout="dialog" making={null} onPress={() => {}} />);
    expect(screen.queryByRole("button", { name: /^More for/ })).toBeNull();
  });

  it("opens a starter's menu from a right-click: New from this, Edit a copy, Hide", async () => {
    const onMenu = vi.fn();
    render(<Shelf groups={groups} layout="page" making={null} onPress={() => {}} menuFor={menuRows} onMenu={onMenu} />);
    fireEvent.contextMenu(screen.getByRole("button", { name: "Game report" }));
    const items = await screen.findAllByRole("menuitem");
    expect(items.map((i) => i.textContent)).toEqual(["New from this", "Edit a copy", "Hide"]);
    fireEvent.click(screen.getByRole("menuitem", { name: "Hide" }));
    expect(onMenu.mock.calls[0]![0]).toBe("remove");
    expect(onMenu.mock.calls[0]![1].id).toBe("starter:ref/game-report");
  });

  it("opens the same menu from a tile's ⋯, with his own rows for his own", async () => {
    const onMenu = vi.fn();
    render(<Shelf groups={groups} layout="page" making={null} onPress={() => {}} menuFor={menuRows} onMenu={onMenu} />);
    const more = screen.getByRole("button", { name: "More for Crew memo" });
    // Shown by the hover reveal, at once on keyboard focus: one wrapper, the tile's group.
    expect(more.parentElement!.className).toContain("group-hover/item:opacity-100");
    fireEvent.click(more);
    const items = await screen.findAllByRole("menuitem");
    expect(items.map((i) => i.textContent)).toEqual(["New from this", "Edit", "Rename…", "Use in all jobs", "Remove"]);
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename…" }));
    expect(onMenu.mock.calls[0]).toEqual(["rename", TEMPLATES[0]]);
  });
});
