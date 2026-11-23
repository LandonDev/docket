// @vitest-environment jsdom
/**
 * `PagedView`: a file's pages as the Preview frame draws them (docs/DESIGN.md
 * "Work editors: Preview"), over a fake engine: jsdom lays nothing out, so
 * the view is handed its size.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeDoc, fakeEngine, LETTER, type FakePage } from "../pdf/testkit";
import type { PdfEngine } from "../pdf/engine";
import { pagedScale, PagedView, RAIL_FROM, type PagedViewProps } from "./PagedView";
import type { PreviewBytes } from "./preview";

afterEach(cleanup);

const bytes = (rev = "r1"): PreviewBytes => ({ rev, size: 100, read: async (_offset, length) => new Uint8Array(length) });
const pagesOf = (n: number, size = LETTER): FakePage[] => Array.from({ length: n }, (_, i) => ({ size, runs: [{ str: `Words of page ${i + 1}`, box: [0.1, 0.1, 0.9, 0.13] }] }));

function show(n: number, over: Partial<PagedViewProps> = {}) {
  const doc = fakeDoc(pagesOf(n));
  const engine = fakeEngine(doc);
  const seen: [number, number][] = [];
  const view = render(<PagedView bytes={bytes()} zoom="width" label="Plan as Word" engine={engine} width={900} height={700} onPage={(page, pages) => seen.push([page, pages])} {...over} />);
  return { doc, engine, seen, view };
}

const sheets = (): number[] => Array.from(document.querySelectorAll("[data-paged-page]"), (el) => Number(el.getAttribute("data-paged-page")));

describe("the scale", () => {
  it("fits the paper's width between the PDF kind's limits, and a whole page in the window", () => {
    // 852px of room for a 612pt page: 852 / 816 is over 1, and fit width tops out at 125%.
    expect(pagedScale("width", 1100, 600, 612, 792)).toBe(1.25);
    expect(pagedScale("width", 408, 600, 612, 792)).toBeCloseTo(0.5);
    // A whole page in 528px of height: 528 / 1056.
    expect(pagedScale("page", 1100, 528, 612, 792)).toBeCloseTo(0.5);
    // Never wider than the room, even when the window is tall.
    expect(pagedScale("page", 408, 5000, 612, 792)).toBeCloseTo(0.5);
    expect(pagedScale(1.5, 10, 10, 612, 792)).toBe(1.5);
    expect(pagedScale("page", 400, 0, 612, 792)).toBe(pagedScale("width", 400, 0, 612, 792));
  });
});

describe("the pages", () => {
  it("stands in the paper's shape while the render opens, then draws the pages near the window and says which is read", async () => {
    const open: Array<() => void> = [];
    const doc = fakeDoc(pagesOf(60));
    const slow: PdfEngine = { open: () => new Promise((resolve) => open.push(() => resolve(doc))) };
    const seen: [number, number][] = [];
    const { container } = render(<PagedView bytes={bytes()} zoom="width" label="Plan as Word" engine={slow} width={900} height={700} onPage={(page, pages) => seen.push([page, pages])} />);
    expect(container.querySelector("[aria-busy=true]")).not.toBeNull();
    expect(sheets()).toEqual([]);
    await act(async () => open[0]!());
    await waitFor(() => expect(sheets()[0]).toBe(1));
    expect(container.querySelector("[aria-busy=true]")).toBeNull();
    // A window of the file, never all sixty.
    expect(sheets().length).toBeLessThan(10);
    await waitFor(() => expect(doc.painted).toContain(1));
    expect(seen.at(-1)).toEqual([1, 60]);
    expect(screen.getByRole("group", { name: "Plan as Word" })).toBeTruthy();
  });

  it("each sheet is paper on the picture's outline, with the file's words over it", async () => {
    show(3, { height: 3000 });
    await waitFor(() => expect(sheets()).toEqual([1, 2, 3]));
    const sheet = document.querySelector<HTMLElement>("[data-paged-page='1']")!;
    expect(sheet.className).toContain("bg-(--paper)");
    expect(sheet.className).toContain("outline-(--image-outline)");
    await waitFor(() => expect(sheet.textContent).toContain("Words of page 1"));
    expect(sheet.querySelector("[data-pdf-text]")).not.toBeNull();
    // 12px between sheets: the second starts a page's height and a gap under the first.
    const second = document.querySelector<HTMLElement>("[data-paged-page='2']")!;
    expect(parseFloat(second.style.top) - parseFloat(sheet.style.top) - parseFloat(sheet.style.height)).toBe(12);
  });

  it("shows the thumbnail rail from twenty pages, and a press on a thumbnail goes to its page", async () => {
    const short = show(RAIL_FROM - 1);
    await waitFor(() => expect(sheets()[0]).toBe(1));
    expect(document.querySelector("[data-paged-rail]")).toBeNull();
    short.view.unmount();

    const long = show(RAIL_FROM);
    await waitFor(() => expect(document.querySelector("[data-paged-rail]")).not.toBeNull());
    expect(screen.getByRole("button", { name: "Page 1" }).getAttribute("aria-current")).toBe("true");
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Page 4" })));
    await waitFor(() => expect(long.seen.at(-1)).toEqual([4, RAIL_FROM]));
    expect(screen.getByRole("button", { name: "Page 4" }).getAttribute("aria-current")).toBe("true");
    expect(sheets()).toContain(4);
  });

  it("puts the frame's line over the first sheet and its column beside the paper, and drops the column in a narrow canvas", async () => {
    const wide = show(2, { head: <span>As LibreOffice draws it</span>, side: <span>In this format</span> });
    await waitFor(() => expect(sheets()).toEqual([1, 2]));
    expect(screen.getByText("As LibreOffice draws it")).toBeTruthy();
    const side = document.querySelector<HTMLElement>("[data-paged-side]")!;
    expect(side.style.width).toBe("232px");
    expect(side.className).toContain("sticky");
    wide.view.unmount();

    show(2, { head: <span>As LibreOffice draws it</span>, side: <span>In this format</span>, width: 500 });
    await waitFor(() => expect(sheets()).toEqual([1, 2]));
    expect(document.querySelector("[data-paged-side]")).toBeNull();
    expect(screen.getByText("As LibreOffice draws it")).toBeTruthy();
  });

  it("gives the paper more of a wide canvas when no column stands beside it", async () => {
    const withSide = show(1, { side: <span>losses</span>, width: 800 });
    await waitFor(() => expect(sheets()).toEqual([1]));
    const narrow = parseFloat(document.querySelector<HTMLElement>("[data-paged-page='1']")!.style.width);
    withSide.view.unmount();
    show(1, { width: 800 });
    await waitFor(() => expect(sheets()).toEqual([1]));
    const full = parseFloat(document.querySelector<HTMLElement>("[data-paged-page='1']")!.style.width);
    // 800 - 48 of inset - 248 of column is 504px of paper; without the column, 752px.
    expect(narrow).toBe(504);
    expect(full).toBe(752);
  });

  it("dims the paper while another picture of the same file is drawn", async () => {
    const { view } = show(1);
    await waitFor(() => expect(sheets()).toEqual([1]));
    const stack = (): HTMLElement => document.querySelector<HTMLElement>("[data-paged-sheets]")!;
    expect(stack().style.opacity).toBe("1");
    view.rerender(<PagedView bytes={bytes()} zoom="width" label="Plan as Word" engine={fakeEngine(fakeDoc(pagesOf(1)))} width={900} height={700} dim />);
    await waitFor(() => expect(stack().style.opacity).toBe("0.55"));
    expect(stack().className).toContain("duration-(--dur-base)");
    expect(stack().className).toContain("motion-reduce:transition-none");
  });

  it("opens a render once, and a new rev as a new file", async () => {
    const doc = fakeDoc(pagesOf(2));
    const engine = fakeEngine(doc);
    const view = render(<PagedView bytes={bytes("r1")} zoom="width" label="Plan" engine={engine} width={900} height={700} />);
    await waitFor(() => expect(sheets()).toEqual([1, 2]));
    // The same render in a new object (the frame rendered again) is not opened again.
    view.rerender(<PagedView bytes={bytes("r1")} zoom={1} label="Plan" engine={engine} width={900} height={700} />);
    await waitFor(() => expect(sheets()).toEqual([1, 2]));
    expect(engine.opened).toBe(1);
    view.rerender(<PagedView bytes={bytes("r2")} zoom={1} label="Plan" engine={engine} width={900} height={700} />);
    await waitFor(() => expect(engine.opened).toBe(2));
  });

  it("says so when the render cannot be read, and draws nothing in its place", async () => {
    const failed = vi.fn();
    const gone: PdfEngine = { open: () => Promise.reject(new Error("that preview is gone: draw it again")) };
    const { container } = render(<PagedView bytes={bytes()} zoom="width" label="Plan" engine={gone} width={900} height={700} onFail={failed} />);
    await waitFor(() => expect(failed).toHaveBeenCalledWith("that preview is gone: draw it again"));
    expect(container.querySelector("[data-paged-page]")).toBeNull();
    expect(container.querySelector("[aria-busy=true]")).toBeNull();
  });

  it("a page pdf.js could not draw says so on the paper, with Retry", async () => {
    const doc = fakeDoc(pagesOf(1));
    let refuse = true;
    const paint = doc.paint.bind(doc);
    doc.paint = async (...args) => {
      if (refuse) throw new Error("bad page");
      return paint(...args);
    };
    render(<PagedView bytes={bytes()} zoom="width" label="Plan" engine={fakeEngine(doc)} width={900} height={700} />);
    expect(await screen.findByText("Couldn't draw this page")).toBeTruthy();
    expect(document.querySelector("[data-paged-page-failed]")!.className).toContain("text-(--paper-ink-2)");
    refuse = false;
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Retry" })));
    await waitFor(() => expect(document.querySelector("[data-paged-page-failed]")).toBeNull());
  });
});
