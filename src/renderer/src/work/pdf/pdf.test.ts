// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { parsePdfCite, pdfCiteHref } from "@shared/contract-work-pdf";
import { parseMarkdownBlocks } from "../../lib/markdownPipeline";
import { citeClick, deliverCite, onCite, resetCites } from "./cite";
import { readRange, runBox } from "./engine";
import { findOnPage } from "./find";
import { COLUMN_TOP, currentPage, layOut, PAGE_GAP, quadsOf, scaleFor, scrollTarget, visibleRange, FIT_FLOOR, ZOOM_MAX } from "./layout";
import { PdfNav } from "./nav";
import { barFits } from "./PdfCanvas";
import { fakeDoc } from "./testkit";

afterEach(resetCites);

describe("find", () => {
  const runs = [
    { str: "A deposit of 50 percent,", box: [0.1, 0.1, 0.5, 0.12] as [number, number, number, number] },
    { str: "$2,485.00, is due by December", box: [0.1, 0.12, 0.6, 0.14] as [number, number, number, number] },
    { str: "15. The Déposit is kept.", box: [0.1, 0.14, 0.5, 0.16] as [number, number, number, number] },
  ];
  it("finds every match on a page, ignoring case and accents", () => {
    const hits = findOnPage(2, runs, "deposit");
    expect(hits).toHaveLength(2);
    expect(hits.every((h) => h.page === 2)).toBe(true);
  });
  it("places a match inside its run by its characters", () => {
    const [hit] = findOnPage(1, runs, "deposit");
    // "deposit" is characters 2 to 8 of a 24-character run 0.4 wide.
    expect(hit.boxes[0][0]).toBeCloseTo(0.1 + (0.4 * 2) / 24, 5);
    expect(hit.boxes[0][2]).toBeCloseTo(0.1 + (0.4 * 9) / 24, 5);
  });
  it("finds a phrase broken across two runs, with a box in each", () => {
    const [hit] = findOnPage(1, runs, "December 15");
    expect(hit.boxes).toHaveLength(2);
  });
  it("finds nothing for blank words", () => {
    expect(findOnPage(1, runs, "   ")).toEqual([]);
  });
});

describe("the column's layout", () => {
  const size = () => ({ width: 612, height: 792 });
  it("fits the page's width up to 1.25, and under 0.5 where the column is that narrow, never past its edge", () => {
    expect(scaleFor("fit", 408, 612)).toBeCloseTo(0.5, 5);
    // A 454px pane with the rail leaves 354px: the page takes 0.43, not a clamped 0.5 that runs off the edge.
    expect(scaleFor("fit", 354, 612)).toBeCloseTo(354 / 816, 5);
    expect(scaleFor("fit", 100, 612)).toBe(FIT_FLOOR);
    expect(scaleFor("fit", 5000, 612)).toBe(ZOOM_MAX);
    expect(scaleFor(1.5, 100, 612)).toBe(1.5);
  });
  it("stacks pages 12px apart under the column's top", () => {
    const { slots } = layOut(3, size, 0.75);
    expect(slots[0].top).toBe(COLUMN_TOP);
    expect(slots[1].top).toBe(COLUMN_TOP + slots[0].height + PAGE_GAP);
    expect(slots[0].width).toBe(612);
  });
  it("mounts only the pages near the viewport of a 300-page file", () => {
    const { slots } = layOut(300, size, 1);
    const [first, last] = visibleRange(slots, slots[149].top, 800);
    expect(first).toBeGreaterThan(140);
    expect(last).toBeLessThan(156);
    expect(last - first).toBeLessThan(8);
  });
  it("names the page a third of the way down the viewport", () => {
    const { slots } = layOut(10, size, 1);
    expect(currentPage(slots, 0, 900)).toBe(1);
    expect(currentPage(slots, slots[4].top - 200, 900)).toBe(5);
  });
  it("scrolls a cited box to a few lines below the top", () => {
    const { slots } = layOut(10, size, 1);
    expect(scrollTarget(slots[5], [0, 0.5, 1, 0.6])).toBe(slots[5].top + slots[5].height * 0.5 - 96);
    expect(scrollTarget(slots[5])).toBe(slots[5].top - COLUMN_TOP);
  });
  it("turns a selection's rects into a box a line, joined where they touch", () => {
    const page = { left: 100, top: 100, width: 1000, height: 1000 };
    const rect = (l: number, t: number, r: number, b: number) => ({ left: l, top: t, right: r, bottom: b, width: r - l, height: b - t });
    const quads = quadsOf([rect(200, 200, 400, 220), rect(400, 200, 600, 220), rect(200, 230, 300, 250), rect(0, 0, 0, 0)], page);
    expect(quads).toEqual([
      [0.1, 0.1, 0.5, 0.12],
      [0.1, 0.13, 0.2, 0.15],
    ]);
  });
  it("reads a text run's box in shares of the page, top-left origin", () => {
    // A US letter page at scale 1: PDF y grows upward, the viewport's downward.
    const viewport = { width: 612, height: 792, convertToViewportPoint: (x: number, y: number) => [x, 792 - y] };
    const box = runBox([10, 0, 0, 10, 61.2, 712.8], 306, 10, viewport)!;
    expect(box[0]).toBeCloseTo(0.1, 5);
    expect(box[2]).toBeCloseTo(0.6, 5);
    expect(box[1]).toBeCloseTo((792 - 722.8) / 792, 5);
    expect(box[3]).toBeCloseTo(0.1, 5);
    expect(runBox([10, 0, 0, 10, 0, 0], 0, 10, viewport)).toBeNull();
  });
});

describe("find across a file", () => {
  it("counts the matches of every page and steps through them, starting at the page shown", async () => {
    const doc = fakeDoc(
      Array.from({ length: 300 }, (_, i) => ({ runs: i % 50 === 4 ? [{ str: "Insurance certificate due", box: [0.1, 0.2, 0.5, 0.22] as [number, number, number, number] }] : [{ str: `Page ${i + 1} body`, box: [0.1, 0.1, 0.5, 0.12] as [number, number, number, number] }] })),
    );
    const nav = new PdfNav();
    const scrolls: number[] = [];
    nav.scrollTo = (page) => scrolls.push(page);
    nav.attach(doc);
    nav.seen(100);
    nav.query("insurance");
    await vi.waitFor(() => expect(nav.get().find.searching).toBe(false));
    const { hits, current } = nav.get().find;
    expect(hits.map((h) => h.page)).toEqual([5, 55, 105, 155, 205, 255]);
    // The first match shown is the nearest one ahead of page 100.
    expect(hits[current].page).toBe(105);
    expect(scrolls[0]).toBe(105);
    nav.step(1);
    expect(scrolls.at(-1)).toBe(155);
    nav.step(-1);
    nav.step(-1);
    expect(scrolls.at(-1)).toBe(55);
    nav.closeFind();
    expect(nav.get().find.open).toBe(false);
  });
});

describe("find on a slow file", () => {
  /** Pages whose words take a few milliseconds each, so the count is pushed many times as it grows. */
  function slowDoc(pagesWith: number[]) {
    const doc = fakeDoc(Array.from({ length: 300 }, (_, i) => ({ runs: [{ str: pagesWith.includes(i + 1) ? "Insurance certificate due" : `Page ${i + 1}`, box: [0.1, 0.1, 0.5, 0.12] as [number, number, number, number] }] })));
    const text = doc.text;
    doc.text = (n) => new Promise((done) => setTimeout(() => done(text(n)), 2));
    return doc;
  }

  it("keeps the match it showed current while matches behind it arrive and sort in front", async () => {
    const nav = new PdfNav();
    const scrolls: number[] = [];
    nav.scrollTo = (page) => scrolls.push(page);
    nav.attach(slowDoc([5, 55, 105, 155, 205, 255]));
    nav.seen(100);
    nav.query("insurance");
    await vi.waitFor(() => expect(nav.get().find.searching).toBe(false), { timeout: 5000 });
    const { hits, current } = nav.get().find;
    expect(hits.map((h) => h.page)).toEqual([5, 55, 105, 155, 205, 255]);
    expect(hits[current].page).toBe(105);
    expect(scrolls).toEqual([105]);
    nav.step(1);
    expect(scrolls.at(-1)).toBe(155);
  });

  it("wraps to the first match when none lies ahead of the page shown", async () => {
    const nav = new PdfNav();
    const scrolls: number[] = [];
    nav.scrollTo = (page) => scrolls.push(page);
    nav.attach(slowDoc([5]));
    nav.seen(200);
    nav.query("insurance");
    await vi.waitFor(() => expect(nav.get().find.searching).toBe(false), { timeout: 5000 });
    expect(nav.get().find.current).toBe(0);
    expect(scrolls).toEqual([5]);
  });

  it("keeps the page while the file reopens", () => {
    const nav = new PdfNav();
    nav.attach(fakeDoc(Array.from({ length: 20 }, () => ({ runs: [] }))));
    nav.seen(12);
    nav.attach(null);
    nav.attach(fakeDoc(Array.from({ length: 20 }, () => ({ runs: [] }))));
    expect(nav.get().page).toBe(12);
  });
});

describe("range reads", () => {
  it("answers a request over a frame once, whole, from slices of a frame", async () => {
    const file = Uint8Array.from({ length: 2_500_000 }, (_, i) => i % 251);
    const calls: Array<[number, number]> = [];
    const read = async (offset: number, length: number) => {
      calls.push([offset, length]);
      return file.slice(offset, offset + length);
    };
    const got = (await readRange(read, 100, 2_400_100))!;
    expect(got.length).toBe(2_400_000);
    expect(got[0]).toBe(file[100]);
    expect(got[got.length - 1]).toBe(file[2_400_099]);
    expect(calls.every(([, length]) => length <= 1024 * 1024)).toBe(true);
    expect(calls).toHaveLength(3);
  });
  it("tries a failed read once more, then drops the request", async () => {
    let fails = 1;
    const flaky = async (offset: number, length: number) => {
      if (fails-- > 0) throw new Error("socket closed");
      return new Uint8Array(length).fill(offset % 7);
    };
    expect(await readRange(flaky, 0, 10)).toHaveLength(10);
    expect(await readRange(async () => Promise.reject(new Error("gone")), 0, 10)).toBeNull();
  });
});

describe("citations", () => {
  it("survive the transcript's markdown as a link", () => {
    const href = pdfCiteHref({ itemId: "abc_1", page: 6, bbox: [0.118, 0.3, 0.882, 0.341] });
    const [block] = parseMarkdownBlocks(`Purdue keeps the deposit ([p. 6, clause 7.2](${href})).`);
    expect(JSON.stringify(block.hast)).toContain(`"href":"${href}"`);
  });
  it("round-trip through the link's form", () => {
    expect(parsePdfCite(pdfCiteHref({ itemId: "abc", page: 6, bbox: [0.118, 0.3, 0.882, 0.341] }))).toEqual({ itemId: "abc", page: 6, bbox: [0.118, 0.3, 0.882, 0.341] });
    expect(parsePdfCite("#pdf:abc:12")).toEqual({ itemId: "abc", page: 12 });
    expect(parsePdfCite("#pdf:abc:0")).toBeNull();
    expect(parsePdfCite("https://example.com")).toBeNull();
  });

  function clickOn(html: string) {
    document.body.innerHTML = html;
    const link = document.querySelector("a")!;
    let prevented = false;
    const event = { target: link, button: 0, defaultPrevented: false, preventDefault: () => (prevented = true) };
    return { event, prevented: () => prevented };
  }

  it("opens the item beside the thread whose pane holds the link, and hands the body the place", async () => {
    const shown: unknown[] = [];
    const host = { environmentOf: (id: string) => (id === "t1" ? "box" : undefined), show: async (...args: unknown[]) => void shown.push(args) };
    const { event, prevented } = clickOn('<div data-session-drop="t1"><p><a href="#pdf:item9:6:118,300,882,341">p. 6</a></p></div>');
    expect(citeClick(event, host)).toBe(true);
    expect(prevented()).toBe(true);
    expect(shown).toEqual([["box", "t1", "item9"]]);
    // The body mounts after the item opens and takes the citation that waited for it.
    const got: unknown[] = [];
    onCite("item9", (cite) => got.push(cite));
    expect(got).toEqual([{ itemId: "item9", page: 6, bbox: [0.118, 0.3, 0.882, 0.341] }]);
  });
  it("hands a body that is up its citation at once", () => {
    const got: unknown[] = [];
    const off = onCite("x", (cite) => got.push(cite.page));
    deliverCite({ itemId: "x", page: 3 });
    deliverCite({ itemId: "x", page: 4 });
    expect(got).toEqual([3, 4]);
    off();
  });
  it("leaves other links alone", () => {
    const host = { environmentOf: () => "local", show: vi.fn() };
    const { event, prevented } = clickOn('<div data-session-drop="t1"><a href="https://purdue.edu">site</a></div>');
    expect(citeClick(event, host)).toBe(false);
    expect(prevented()).toBe(false);
    expect(host.show).not.toHaveBeenCalled();
  });
});

describe("what fits in the bar", () => {
  it("shows one fraction at a time under 560px: the stepper's count, not the pager", () => {
    expect(barFits(520, true, false).pager).toBe(false);
    expect(barFits(520, true, true).pager).toBe(false);
    expect(barFits(600, true, false).pager).toBe(true);
    expect(barFits(400, false, false).pager).toBe(true);
    expect(barFits(0, true, false).pager).toBe(true);
  });
});
