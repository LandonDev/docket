// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Skeleton } from "../../components/ui/skeleton";
import { NO_FEEDS } from "./frame";
import { BarHold } from "./barHold";
import { BAR_TOOLS_ONLY, KindBar } from "./KindBar";

afterEach(cleanup);

/** A kind's `Bar` as the pane mounts it: a truthy element that may render a bone, its tools, the hold or nothing. */
function Tools({ shows }: { shows: "pane" | "bone" | "share" | "hold" | "nothing" }) {
  // The pane's own bone while the kind's code loads (CanvasPane.tsx), not the kind's.
  if (shows === "pane") return <Skeleton aria-hidden data-bar-bone className="h-3 w-30" />;
  if (shows === "bone") return <Skeleton aria-hidden className="h-3 w-30" />;
  if (shows === "share") return <button type="button">Share</button>;
  if (shows === "hold") return <BarHold />;
  return null;
}

const bar = (container: HTMLElement): HTMLElement => container.querySelector<HTMLElement>("[data-canvas-bar]")!;
/** Drawn: not hidden by the tools-only rule, which hides the bar while its tools slot is empty. */
const drawn = (el: HTMLElement): boolean => !(el.className.includes(BAR_TOOLS_ONLY) && el.matches(":has([data-canvas-tools]:empty)"));

describe("the kind's bar keeps its height from the first paint", () => {
  it("drawn with a bone at the first paint, it stays 32px while the tools draw nothing, and through to Share", () => {
    const { container, rerender } = render(<KindBar feeds={NO_FEEDS} tools={<Tools shows="bone" />} />);
    expect(drawn(bar(container))).toBe(true);
    expect(bar(container).className).toContain("h-8");
    // The kind's tools draw nothing for a moment (a read-only deck, a document between states): the bar stays.
    rerender(<KindBar feeds={NO_FEEDS} tools={<Tools shows="nothing" />} />);
    expect(bar(container).querySelector("[data-canvas-tools]:empty")).not.toBeNull();
    expect(drawn(bar(container))).toBe(true);
    rerender(<KindBar feeds={NO_FEEDS} tools={<Tools shows="share" />} />);
    expect(drawn(bar(container))).toBe(true);
  });

  it("a kind whose tools draw nothing has no bar, as before, the pane's loading bone notwithstanding", () => {
    const { container, rerender } = render(<KindBar feeds={NO_FEEDS} tools={<Tools shows="pane" />} />);
    expect(drawn(bar(container))).toBe(true);
    // The kind's code lands and its Bar has nothing (a meeting with no recording): the bar goes.
    rerender(<KindBar feeds={NO_FEEDS} tools={<Tools shows="nothing" />} />);
    expect(drawn(bar(container))).toBe(false);
  });

  it("the hold keeps the bar's place with nothing in it to see or hear", () => {
    const { container } = render(<KindBar feeds={NO_FEEDS} tools={<Tools shows="hold" />} />);
    expect(drawn(bar(container))).toBe(true);
    const hold = bar(container).querySelector("[data-bar-hold]")!;
    expect(hold.getAttribute("aria-hidden")).toBe("true");
    expect(hold.className).toContain("hidden");
  });
});
