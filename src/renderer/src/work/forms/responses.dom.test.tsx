// @vitest-environment jsdom
/**
 * The answers' table in a pane narrower than it: the edge with more past it fades, so the cut columns read as going on.
 */
import { cleanup, fireEvent, render } from "@testing-library/react";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CanvasShell } from "../canvas/kind";
import { HALF_TAB, ResponseTable, responseName } from "./responses";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const got = { rev: 1, columns: [{ id: "q1", label: "Name" }, { id: "submitted", label: "Submitted" }], rows: [["Dana Lee", "2026-11-19T14:02:00.000Z"]], count: 1, cut: false };
const shell = { selection: () => undefined } as unknown as CanvasShell;

/** jsdom lays nothing out: the box's widths and scroll are set by hand. */
function size(el: HTMLElement, { width, scrollWidth, scrollLeft }: { width: number; scrollWidth: number; scrollLeft: number }): void {
  Object.defineProperty(el, "clientWidth", { configurable: true, value: width });
  Object.defineProperty(el, "scrollWidth", { configurable: true, value: scrollWidth });
  el.scrollLeft = scrollLeft;
}

/** Council round 6, sitting E (Sol): the 24px track insets its pill 2px, so the tabs took 20px. */
it("gives a form bar's tabs the track's whole 24px", () => {
  expect(HALF_TAB).toContain("after:absolute");
  expect(HALF_TAB).toContain("after:-inset-y-0.5");
  expect(HALF_TAB).toContain("after:content-['']");
});

describe("the answers' table", () => {
  it("marks the edge that has more past it, and the wrapper fades that edge", () => {
    render(<ResponseTable title="TempCode proof form" got={got} chart={null} chipRef={{ kind: "item", itemId: "i1" } as never} shell={shell} timeColumn={1} whole="the sheet has them all" />);
    const wrap = document.querySelector("[data-responses-table]") as HTMLElement;
    const box = wrap.querySelector("[data-slot=table-container]") as HTMLElement;
    expect(wrap.className).toContain("[&:has(>[data-overflow-end])]:[--fade-end:24px]");
    expect(wrap.className).toContain("[mask-image:");
    size(box, { width: 400, scrollWidth: 640, scrollLeft: 0 });
    fireEvent.scroll(box);
    expect(box.hasAttribute("data-overflow-end")).toBe(true);
    expect(box.hasAttribute("data-overflow-start")).toBe(false);
    size(box, { width: 400, scrollWidth: 640, scrollLeft: 240 });
    fireEvent.scroll(box);
    expect(box.hasAttribute("data-overflow-end")).toBe(false);
    expect(box.hasAttribute("data-overflow-start")).toBe(true);
  });

  /** Council round 4, sitting E (Sol): the ticks were the table's only stops, so the keyboard could not scroll it sideways. */
  it("is a stop of its own, with the house ring, only while the answers run past the pane", () => {
    const seen: Array<() => void> = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(cb: () => void) {
          seen.push(cb);
        }
        observe(): void {}
        disconnect(): void {}
      },
    );
    render(<ResponseTable title="TempCode proof form" got={got} chart={null} chipRef={{ kind: "item", itemId: "i1" } as never} shell={shell} timeColumn={1} whole="the sheet has them all" />);
    const box = document.querySelector("[data-responses-table] [data-slot=table-container]") as HTMLElement;
    expect(box.hasAttribute("tabindex")).toBe(false);
    expect(box.classList.contains("focus-ring")).toBe(true);
    expect(box.getAttribute("role")).toBe("region");
    expect(box.getAttribute("aria-label")).toBe("Responses");
    size(box, { width: 400, scrollWidth: 640, scrollLeft: 0 });
    act(() => seen.forEach((cb) => cb()));
    expect(box.tabIndex).toBe(0);
    size(box, { width: 700, scrollWidth: 640, scrollLeft: 0 });
    act(() => seen.forEach((cb) => cb()));
    expect(box.hasAttribute("tabindex")).toBe(false);
  });

  /** Council round 2, sitting E: every tick said "Select", so Tab could not tell the responses apart. */
  it("names each tick by its response's first answer, else its place", () => {
    const two = { ...got, rows: [["Dana Lee", "2026-11-19T14:02:00.000Z"], ["", "2026-11-19T15:02:00.000Z"]], count: 2 };
    render(<ResponseTable title="TempCode proof form" got={two} chart={null} chipRef={{ kind: "item", itemId: "i1" } as never} shell={shell} timeColumn={1} whole="the sheet has them all" />);
    const names = [...document.querySelectorAll("tbody [aria-label]")].map((el) => el.getAttribute("aria-label"));
    expect(names).toEqual(["Select Dana Lee", "Select response 2"]);
    // the time is never the name, even where it comes first
    expect(responseName(["2026-11-19T14:02:00.000Z", "Ava Thompson"], 0, 0)).toBe("Ava Thompson");
  });
});
