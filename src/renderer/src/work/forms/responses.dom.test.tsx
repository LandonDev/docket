// @vitest-environment jsdom
/**
 * The answers' table in a pane narrower than it: the edge with more past it fades, so the cut columns read as going on.
 */
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { CanvasShell } from "../canvas/kind";
import { ResponseTable } from "./responses";

afterEach(cleanup);

const got = { rev: 1, columns: [{ id: "q1", label: "Name" }, { id: "submitted", label: "Submitted" }], rows: [["Dana Lee", "2026-11-19T14:02:00.000Z"]], count: 1, cut: false };
const shell = { selection: () => undefined } as unknown as CanvasShell;

/** jsdom lays nothing out: the box's widths and scroll are set by hand. */
function size(el: HTMLElement, { width, scrollWidth, scrollLeft }: { width: number; scrollWidth: number; scrollLeft: number }): void {
  Object.defineProperty(el, "clientWidth", { configurable: true, value: width });
  Object.defineProperty(el, "scrollWidth", { configurable: true, value: scrollWidth });
  el.scrollLeft = scrollLeft;
}

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
});
