// @vitest-environment jsdom
/** A canvas tab's whole title: the tab is the tip's trigger, so the arrow keys' focus shows it, and only a cut title has one. */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { tooltipChunk, warmTooltips } from "../../components/ui/tooltip";
import { CanvasTabs } from "./CanvasTabs";
import { tabShrink } from "./tabShrink";
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
