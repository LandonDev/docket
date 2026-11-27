// @vitest-environment jsdom
/** A canvas tab's whole title: the tab is the tip's trigger, so the arrow keys' focus shows it, and only a cut title has one. */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { tooltipChunk, warmTooltips } from "../../components/ui/tooltip";
import { CanvasTabs } from "./CanvasTabs";
import { tabMin, tabShrink } from "./tabShrink";
import { canvasItem, drivenKinds } from "./testkit";

afterEach(cleanup);

const LONG = "Run of show for the spring invitational, final cut";
const items = [canvasItem("doc", { title: LONG }), canvasItem("sheet", { kind: "sheet", title: "Budget" })];
const tips = () => [...document.querySelectorAll('[data-slot="tooltip-content"]')].map((el) => el.textContent);

async function tabs(cut: boolean) {
  // The tooltips wake only once no control holds the focus and no press is held.
  (document.activeElement as HTMLElement | null)?.blur();
  fireEvent.pointerUp(document);
  await act(async () => {
    await tooltipChunk.load();
    warmTooltips();
  });
  // jsdom lays nothing out: the long title's span says it is cut, as a narrow row would.
  const widths = { scroll: Object.getOwnPropertyDescriptor(Element.prototype, "scrollWidth")!, client: Object.getOwnPropertyDescriptor(Element.prototype, "clientWidth")! };
  Object.defineProperty(Element.prototype, "scrollWidth", { configurable: true, get(this: Element) { return cut && this.textContent === LONG ? 400 : 100; } });
  Object.defineProperty(Element.prototype, "clientWidth", { configurable: true, get: () => 100 });
  const view = render(<CanvasTabs items={items} selected="sheet" onSelect={() => {}} onClose={() => {}} onReorder={() => {}} kinds={drivenKinds(() => {}) as never} />);
  await act(async () => new Promise((r) => setTimeout(r, 0)));
  return { view, restore: () => (Object.defineProperty(Element.prototype, "scrollWidth", widths.scroll), Object.defineProperty(Element.prototype, "clientWidth", widths.client)) };
}

describe("a canvas tab", () => {
  it("keeps its close's room selected or not, and wears the sidebar's own selected fill", async () => {
    const { restore } = await tabs(false);
    try {
      const all = screen.getAllByRole("tab");
      expect(all.map((tab) => tab.getAttribute("aria-selected"))).toEqual(["false", "true"]);
      // A name is cut at one point, so nothing moves under the pointer when the close appears.
      for (const tab of all) expect(tab.className.split(" ")).toContain("pe-7");
      for (const tab of all) expect(tab.className.split(" ")).not.toContain("group-hover/dock-tab:pe-7");
      // `muted` on `sidebar` can barely be seen in light; the Files row's selected fill is plain in both themes.
      expect(all[1]!.className).toContain("aria-selected:bg-sidebar-group-selected");
    } finally {
      restore();
    }
  });
});

describe("the canvas tab row past what fits", () => {
  it("keeps the selected tab's whole name, and the others give in step with their names, as Files' row does", async () => {
    const { restore } = await tabs(false);
    try {
      const shrinkOf = (tab: HTMLElement): number => Number(tab.closest<HTMLElement>(".group\\/dock-tab")!.style.flexShrink);
      const [doc, sheet] = screen.getAllByRole("tab") as [HTMLElement, HTMLElement];
      expect(shrinkOf(sheet)).toBe(0);
      expect(shrinkOf(doc)).toBeCloseTo(tabShrink(LONG));
      expect(shrinkOf(doc)).toBeGreaterThan(0);
      // Each keeps a few letters of its name past that (the row scrolls), never its glyph alone; a short name is not padded.
      for (const tab of [doc, sheet]) expect(tab.closest<HTMLElement>(".group\\/dock-tab")!.style.minWidth).toBe(tabMin(tab.getAttribute("aria-label") ?? tab.textContent!.trim()));
      expect(tabMin(LONG)).toBe(`min(8rem, ${LONG.length}ch + 3.625rem)`);
      expect(tabMin("Events")).toBe("min(8rem, 6ch + 3.625rem)");
    } finally {
      restore();
    }
  });
});

describe("a canvas tab's title", () => {
  it("shows the whole cut title when the tab itself takes the keyboard's focus", async () => {
    const { restore } = await tabs(true);
    try {
      const tab = screen.getByRole("tab", { name: LONG });
      // The tab is the trigger: the title span is not wrapped in one of its own.
      expect(tab.querySelector("[data-slot=tooltip-trigger]")).toBeNull();
      fireEvent.keyDown(document, { key: "Tab" });
      tab.focus();
      fireEvent.focus(tab);
      await waitFor(() => expect(tips()).toContain(LONG), { timeout: 2000 });
    } finally {
      restore();
    }
  });

  it("has no tip while the title fits", async () => {
    const { restore } = await tabs(false);
    try {
      const tab = screen.getByRole("tab", { name: LONG });
      vi.useFakeTimers();
      try {
        fireEvent.keyDown(document, { key: "Tab" });
        tab.focus();
        fireEvent.focus(tab);
        await act(async () => vi.advanceTimersByTimeAsync(900));
        expect(tips()).not.toContain(LONG);
      } finally {
        vi.useRealTimers();
      }
    } finally {
      restore();
    }
  });
});

/** Council round 1 (R1-A4, R1-A6): a tab read "TempCode p…Canvas.tcdoc", Docket's own ending kept and the name cut to keep it. */
describe("a canvas tab's name", () => {
  it("never shows Docket's own ending: the tab, its cut, its tip and its close all name the file as he reads it", () => {
    const own = [canvasItem("doc", { title: "TempCode proof Canvas.tcdoc" }), canvasItem("pdf", { kind: "pdf", title: "TempCode proof Pages.pdf" })];
    render(<CanvasTabs items={own} selected="doc" onSelect={() => {}} onClose={() => {}} onReorder={() => {}} kinds={drivenKinds(() => {}) as never} />);
    expect(screen.getByRole("tab", { name: "TempCode proof Canvas" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Close TempCode proof Canvas" })).toBeTruthy();
    expect(document.body.textContent).not.toContain(".tcdoc");
    // The two share a start: each keeps the word that tells it apart, "Canvas" and "Pages.pdf".
    expect(screen.getByText("Canvas")).toBeTruthy();
    expect(screen.getByText("Pages.pdf")).toBeTruthy();
  });

  it("names a lone item without its ending too", () => {
    render(<CanvasTabs items={[canvasItem("sheet", { kind: "sheet", title: "Budget.tcsheet" })]} selected="sheet" onSelect={() => {}} onClose={() => {}} onReorder={() => {}} kinds={drivenKinds(() => {}) as never} />);
    expect(document.querySelector("[data-view-title]")!.textContent).toBe("Budget");
    expect(screen.getByRole("button", { name: "Close Budget" })).toBeTruthy();
  });
});

describe("a tab closed by its × from the keyboard (council R5-A1)", () => {
  it("hands the focus to the tab shown next, and to the lone title's × once the row folds", async () => {
    const three = [...items, canvasItem("deck", { kind: "deck", title: "Slides" })];
    const props = { onSelect: () => {}, onReorder: () => {}, kinds: drivenKinds(() => {}) as never };
    const closed: string[] = [];
    const view = render(<CanvasTabs {...props} items={three} selected="sheet" onClose={(id) => void closed.push(id)} />);
    const close = screen.getByRole("button", { name: "Close Budget" });
    close.focus();
    fireEvent.click(close);
    expect(closed).toEqual(["sheet"]);
    view.rerender(<CanvasTabs {...props} items={[three[0]!, three[2]!]} selected="deck" onClose={(id) => void closed.push(id)} />);
    await waitFor(() => expect(document.activeElement?.getAttribute("data-canvas-tab")).toBe("deck"));
    // Down to one, the row folds to the title: its × takes the focus.
    const last = screen.getByRole("button", { name: "Close Slides" });
    last.focus();
    fireEvent.click(last);
    view.rerender(<CanvasTabs {...props} items={[three[0]!]} selected="doc" onClose={(id) => void closed.push(id)} />);
    await waitFor(() => expect(document.activeElement?.getAttribute("aria-label")).toBe(`Close ${LONG}`));
  });
});
