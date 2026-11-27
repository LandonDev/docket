// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PAGE_SCROLLER } from "../components/page";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { AccountsSkeleton } from "../aliax/views/accounts/usageSkeleton";
import { DIFF_ROWS_SKELETON_CAP, EmptyState, LoadingLine, PAGE_LIST_WIDTH, SurfaceSkeleton, type SkeletonKind } from "./SurfaceSkeleton";

afterEach(cleanup);

const KINDS: SkeletonKind[] = ["page", "search", "column", "stats", "accounts", "pane", "diff", "diff-rows", "terminal", "frame", "transcript", "rows"];

describe("SurfaceSkeleton", () => {
  it.each(KINDS)("%s: a labelled status whose frame is drawn in bones, never by hand", (kind) => {
    const { container } = render(<SurfaceSkeleton kind={kind} label="Loading notes" />);
    const root = screen.getByRole("status", { name: "Loading notes" });
    expect(root.getAttribute("data-surface-skeleton")).toBe(kind);
    expect(root.getAttribute("aria-busy")).toBe("true");
    // One region of bones alone, its drawing unseen and inert: sample words for Skullet to measure, or a block.
    const region = root.querySelector<HTMLElement>(":scope > [data-region]")!;
    expect(region.dataset.bones).toBeDefined();
    const drawing = region.querySelector<HTMLElement>("[skullet-loading]")!;
    expect(drawing.getAttribute("aria-hidden")).toBe("true");
    expect(drawing.querySelector("p, [data-bone]")).not.toBeNull();
    expect(root.querySelector('[data-slot="skeleton"]')).toBeNull();
    expect(container.innerHTML).not.toMatch(/animate-(pulse|spin)\b|bg-skeleton/);
    // The frame names the wait; the region inside says nothing more.
    expect(within(root).queryByRole("status")).toBeNull();
  });

  it("fills the room it is given where the surface does, and is as tall as its rows where it is a list", () => {
    const filled = render(<SurfaceSkeleton kind="page" />);
    expect(filled.container.querySelector("[data-region]")!.className).toContain("flex-1");
    filled.unmount();
    const rows = render(<SurfaceSkeleton kind="rows" />);
    expect(rows.container.querySelector("[data-region]")!.className).not.toContain("flex-1");
  });

  it("says Loading when given no label", () => {
    render(<SurfaceSkeleton kind="pane" />);
    expect(screen.getByRole("status", { name: "Loading" })).toBeTruthy();
  });

  it("transcript: each turn's bubble on the right before its prose lines", () => {
    const { container } = render(<SurfaceSkeleton kind="transcript" />);
    const turn = container.querySelector("[skullet-ghost] > div > div")!;
    expect(turn.firstElementChild!.className).toContain("self-end");
    expect(turn.firstElementChild!.hasAttribute("data-bone")).toBe(true);
    expect(turn.lastElementChild!.querySelectorAll("p").length).toBe(3);
  });

  it("column: Settings' one 672px column under the strip, with no nav column", () => {
    const { container } = render(<SurfaceSkeleton kind="column" label="Loading settings" />);
    const column = container.querySelector("[data-skeleton-column]")!;
    expect(column.className).toContain("max-w-2xl");
    expect(column.className).toContain("mx-auto");
    expect(container.querySelector(".w-52")).toBeNull();
    // The bare strip keeps its own hairline: an empty box is a leaf Skullet would hide.
    expect(container.querySelector("[skullet-ghost] > .border-b")!.hasAttribute("skullet-own")).toBe(true);
  });

  it.each(["column", "stats", "accounts"] as const)("%s: the column sits in the page's own scroller, so it lands where the page does", (kind) => {
    const { container } = render(<SurfaceSkeleton kind={kind} />);
    const scroller = container.querySelector("[data-skeleton-scroller]")!;
    expect(scroller.className).toBe(PAGE_SCROLLER);
    expect(scroller.querySelector("[data-skeleton-column]")).not.toBeNull();
  });

  it("accounts: the page's rows under its title, at the table's width, with no line the page does not draw", () => {
    const { container } = render(<SurfaceSkeleton kind="accounts" />);
    const page = render(<AccountsSkeleton />).container;
    // The fallback's rows are AccountsSkeleton's, row for row, each with the box the usage bars will fill
    // (56px: the cells' 44 inside the button's 6 above and below), so the page does not change shape when it lands.
    const rows = container.querySelectorAll('[data-slot="account-row-skeleton"]');
    expect(rows).toHaveLength(page.querySelectorAll('[data-slot="account-row-skeleton"]').length);
    for (const row of rows) expect(row.querySelector("[data-skeleton-bars]")!.className).toContain("h-14");
    expect(page.querySelector('[data-slot="usage-cells"]')!.className).toContain("py-1.5");
    // The bars' bones are the page chunk's: the first paint carries none of the Accounts page's code.
    expect(readFileSync(resolve(__dirname, "SurfaceSkeleton.tsx"), "utf8")).not.toMatch(/from "\.\.\/aliax/);
    const column = container.querySelector("[data-skeleton-column]")!;
    expect(column.className).toContain("max-w-6xl");
    // The title in words, as Stats writes its own, then the rows 24px under it: no page line.
    expect(column.children).toHaveLength(2);
    expect(column.children[0]!.textContent).toBe("Accounts");
    // Known before anything loads: drawn as it is, with no bone.
    expect(column.children[0]!.hasAttribute("skullet-own")).toBe(true);
    expect(column.children[1]!.className).toContain("mt-6");
  });

  it("page: the title strip first, then the list at the Inbox's and Notes' own default width", () => {
    const { container } = render(<SurfaceSkeleton kind="page" />);
    const drawing = container.querySelector("[data-surface-skeleton] [skullet-ghost]")!;
    expect(drawing.children[0]!.hasAttribute("data-skeleton-strip")).toBe(true);
    expect(drawing.children[0]!.className).toContain("h-10");
    expect(container.querySelector<HTMLElement>("[data-skeleton-list]")!.style.width).toBe(`${PAGE_LIST_WIDTH}px`);
    for (const view of ["InboxView.tsx", "NotesView.tsx"]) expect(readFileSync(resolve(__dirname, view), "utf8")).toContain("const DEFAULT_WIDTH = PAGE_LIST_WIDTH;");
  });

  it.each([
    [2, 2],
    [3, 1],
  ] as const)("page with %i-line rows: the list's head (%i blocks) before its rows, rows 8px in, the detail on the detail's inset", (lines, blocks) => {
    const { container } = render(<SurfaceSkeleton kind="page" lines={lines} />);
    const list = container.querySelector("[data-skeleton-list]")!;
    const head = list.querySelector("[data-skeleton-head]")!;
    expect(list.firstElementChild).toBe(head);
    expect(head.className).toContain("p-2");
    expect(head.querySelectorAll("[data-bone].h-8")).toHaveLength(blocks);
    const rows = list.querySelectorAll("[data-skeleton-row]");
    expect(rows.length).toBe(8);
    expect(rows[0]!.parentElement!.className).toContain("p-1");
    expect(rows[0]!.className).toContain("px-2");
    // The padding sits inside the 1,024px column, as the Inbox's and Notes' details: past it the lines start where the text does.
    expect(container.querySelector("[data-skeleton-detail]")!.className).not.toContain("px-8");
    const column = container.querySelector("[data-skeleton-detail] > div")!.className;
    for (const cls of ["mx-auto", "max-w-5xl", "px-8", "pt-8"]) expect(column).toContain(cls);
  });

  it("rows: the Inbox's row line for line, a 14px glyph on a 20px line over a 16px line", () => {
    const { container } = render(<SurfaceSkeleton kind="rows" count={1} />);
    const row = container.querySelector("[data-skeleton-row]")!;
    expect(row.className.split(" ")).toEqual(expect.arrayContaining(["gap-0.5", "px-2", "py-2"]));
    const [first, second] = [...row.children] as HTMLElement[];
    expect(first!.className).toContain("h-5");
    expect(first!.querySelector("[data-skeleton-glyph]")!.className).toContain("size-3.5");
    // The line under it is words on a 16px line, 22px in under the title.
    expect(second!.className.split(" ")).toEqual(expect.arrayContaining(["leading-4", "ps-[22px]"]));
    expect(second!.textContent).not.toBe("");
    expect(row.parentElement!.className).toContain("gap-0.5 p-1");
  });

  it("search: the strip, then count one-line rows, each led by the 16px glyph, 12px in", () => {
    const { container: rows } = render(<SurfaceSkeleton kind="search" count={2} />);
    const row = rows.querySelector("[data-skeleton-row]")!;
    expect(row.className).toContain("h-7");
    expect(row.className).toContain("px-2");
    expect(row.parentElement!.className).toContain("p-1");
    expect(row.querySelector("[data-skeleton-glyph]")!.className).toContain("size-4");
    cleanup();
  });

  it("search: the strip, then count one-line rows", () => {
    const { container } = render(<SurfaceSkeleton kind="search" count={5} />);
    expect(container.querySelector("[data-surface-skeleton] [skullet-ghost]")!.children[0]!.hasAttribute("data-skeleton-strip")).toBe(true);
    expect(container.querySelectorAll("[data-skeleton-row]")).toHaveLength(5);
  });

  it("search opened empty: the strip holds the field's bone, and no result rows stand under it", () => {
    const { container } = render(<SurfaceSkeleton kind="search" count={0} />);
    const strip = container.querySelector("[data-skeleton-strip]")!;
    expect(strip.querySelector("[data-skeleton-field]")!.className).toContain("h-8");
    expect(container.querySelectorAll("[data-skeleton-row]")).toHaveLength(0);
    // The window's fallback is that empty search.
    expect(readFileSync(resolve(__dirname, "../App.tsx"), "utf8")).toContain('<SurfaceSkeleton kind="search" count={0} label="Loading search" />');
  });

  it("rows with three lines draws Notes' cards: its time, its title, its first words", () => {
    const { container } = render(<SurfaceSkeleton kind="rows" lines={3} count={2} />);
    const rows = container.querySelectorAll("[data-skeleton-row]");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.querySelectorAll("p")).toHaveLength(3);
    // NoteCard's lines: 16px, then 4px and a 20px title, then 2px and 16px.
    expect([...rows[0]!.querySelectorAll("p")].map((el) => (el.className.includes("leading-5") ? 20 : 16))).toEqual([16, 20, 16]);
    expect([...rows[0]!.querySelectorAll("p")].map((el) => el.className.match(/\bmt-\S+/)?.[0])).toEqual([undefined, "mt-1", "mt-0.5"]);
  });

  it("a switch's skeleton has the Switch's box", () => {
    // The track's box lives in switch-track.ts, which switch.tsx draws from.
    expect(readFileSync(resolve(__dirname, "../components/ui/switch.tsx"), "utf8")).toContain("SWITCH_TRACK");
    expect(readFileSync(resolve(__dirname, "../components/ui/switch-track.ts"), "utf8")).toContain("h-[18px] w-8");
    const { container } = render(<SurfaceSkeleton kind="accounts" count={1} />);
    expect(container.querySelector("[data-skeleton-switch]")!.className).toContain("h-[18px] w-8");
  });

  it("rows: count rows, four by default", () => {
    const six = render(<SurfaceSkeleton kind="rows" count={6} />);
    expect(six.container.querySelectorAll("[data-skeleton-row]").length).toBe(6);
    six.unmount();
    const { container } = render(<SurfaceSkeleton kind="rows" />);
    expect(container.querySelectorAll("[data-skeleton-row]").length).toBe(4);
  });

  it("diff-rows: one 20px line per row the diff shows, at most 8, with no header or border", () => {
    const three = render(<SurfaceSkeleton kind="diff-rows" count={3} />);
    const lines = three.container.querySelectorAll<HTMLElement>("[data-skeleton-row]");
    expect(lines.length).toBe(3);
    for (const line of lines) expect(line.className).toContain("h-5");
    // DiffBody's own 4px above and below the lines.
    expect(three.container.firstElementChild!.className).toContain("py-1");
    for (const line of lines) expect(line.querySelector("p")!.className).toContain("font-mono");
    expect(three.container.innerHTML).not.toMatch(/\bborder/);
    expect(three.container.innerHTML).not.toMatch(/\bh-9\b/);
    three.unmount();
    const many = render(<SurfaceSkeleton kind="diff-rows" count={40} />);
    expect(DIFF_ROWS_SKELETON_CAP).toBe(8);
    expect(many.container.querySelectorAll("[data-skeleton-row]").length).toBe(8);
    many.unmount();
    const none = render(<SurfaceSkeleton kind="diff-rows" count={0} />);
    expect(none.container.querySelectorAll("[data-skeleton-row]").length).toBe(1);
  });
});

describe("LoadingLine", () => {
  it("is a spinner hidden from readers beside its word", () => {
    const { container } = render(<LoadingLine label="Loading comments" />);
    expect(screen.getByRole("status").textContent).toBe("Loading comments");
    expect(container.querySelector('[data-slot="spinner"]')!.getAttribute("aria-hidden")).toBe("true");
  });
});

describe("EmptyState", () => {
  it("is its title alone when given nothing else", () => {
    const { container } = render(<EmptyState title="No file changes" />);
    expect(screen.getByText("No file changes")).toBeTruthy();
    expect(container.querySelector('[data-slot="empty-description"]')).toBeNull();
    expect(container.querySelector("button")).toBeNull();
  });

  it("adds its line and one action when given", () => {
    const onClick = vi.fn();
    const { container } = render(<EmptyState title="No notes yet" line="Notes stay with the project." action={{ label: "New note", onClick }} />);
    expect(container.querySelector('[data-slot="empty-description"]')!.textContent).toBe("Notes stay with the project.");
    expect(container.querySelectorAll("button").length).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: "New note" }));
    expect(onClick).toHaveBeenCalledOnce();
  });
});
