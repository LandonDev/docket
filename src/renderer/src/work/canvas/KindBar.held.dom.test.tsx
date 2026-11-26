// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { tooltipChunk, warmTooltips } from "../../components/ui/tooltip";
import { Skeleton } from "../../components/ui/skeleton";
import { NO_FEEDS } from "./frame";
import { BarHold, BarShut, useShutsBar } from "./barHold";
import { BAR_TOOLS_ONLY, KindBar } from "./KindBar";

beforeAll(async () => {
  await act(async () => {
    await tooltipChunk.load();
    warmTooltips();
  });
});
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
const drawn = (el: HTMLElement): boolean =>
  !(el.className.includes(BAR_TOOLS_ONLY) && el.matches(":has([data-canvas-tools]:empty), :has([data-canvas-tools] > [data-bar-hold]:only-child)"));

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

describe("a shut item lets the bar's hold go", () => {
  it("drawn with a bone, then shut with nothing to hold (a failed open, a password ask), the bar goes", () => {
    const { container, rerender } = render(<KindBar feeds={NO_FEEDS} tools={<Tools shows="bone" />} />);
    rerender(<KindBar feeds={NO_FEEDS} tools={<Tools shows="nothing" />} shut />);
    expect(bar(container).hasAttribute("data-bar-held")).toBe(false);
    expect(drawn(bar(container))).toBe(false);
    // Retry: the kind's bone holds the bar again.
    rerender(<KindBar feeds={NO_FEEDS} tools={<Tools shows="bone" />} />);
    rerender(<KindBar feeds={NO_FEEDS} tools={<Tools shows="nothing" />} />);
    expect(drawn(bar(container))).toBe(true);
  });

  /** The live walk (S9): a Word file that could not become a document kept the hold's empty 32px row over "Couldn't open". */
  it("held by the hold alone (a Word file becoming a document), then shut by its failure, the bar goes", () => {
    const { container, rerender } = render(<KindBar feeds={NO_FEEDS} tools={<Tools shows="hold" />} />);
    expect(drawn(bar(container))).toBe(true);
    rerender(<KindBar feeds={NO_FEEDS} tools={<Tools shows="hold" />} shut />);
    expect(bar(container).hasAttribute("data-bar-held")).toBe(false);
    // The rule that hides it: the hold's mark is the tools' only child.
    expect(bar(container).className).toContain("has-[[data-canvas-tools]>[data-bar-hold]:only-child]:hidden");
    expect(drawn(bar(container))).toBe(false);
  });

  it("shut, the bar still draws what it holds", () => {
    const { container } = render(<KindBar feeds={NO_FEEDS} tools={<Tools shows="share" />} shut />);
    expect(drawn(bar(container))).toBe(true);
  });

  it("the centred failure and the password ask tell the pane while they show, and take it back when they go", () => {
    const said: boolean[] = [];
    const Shuts = () => {
      useShutsBar();
      return null;
    };
    const { rerender } = render(
      <BarShut.Provider value={(shut) => said.push(shut)}>
        <Shuts />
      </BarShut.Provider>,
    );
    expect(said).toEqual([true]);
    rerender(<BarShut.Provider value={(shut) => said.push(shut)}>{null}</BarShut.Provider>);
    expect(said).toEqual([true, false]);
  });
});

describe("a mode he cannot change", () => {
  it("is a Tab stop whose tip says why, where the kind gives a reason", async () => {
    const note = "Others review this, so the agent's notes wait for you";
    const { container } = render(<KindBar feeds={{ ...NO_FEEDS, mode: { value: "suggests", note } }} />);
    const mode = container.querySelector<HTMLElement>("[data-canvas-mode]")!;
    expect(mode.tabIndex).toBe(0);
    expect(mode.getAttribute("data-slot")).toBe("tooltip-trigger");
    for (const pass of [0, 1]) {
      fireEvent.pointerEnter(mode);
      fireEvent.mouseEnter(mode);
      fireEvent.focus(mode);
      await act(async () => {});
      fireEvent.pointerMove(mode);
      fireEvent.mouseMove(mode);
      if (pass === 0) {
        fireEvent.pointerLeave(mode);
        fireEvent.mouseLeave(mode);
      }
    }
    await waitFor(() => expect([...document.querySelectorAll('[data-slot="tooltip-content"]')].map((el) => el.textContent)).toContain(note));
  });

  it("with no reason is its words alone, no Tab stop", () => {
    const { container } = render(<KindBar feeds={{ ...NO_FEEDS, mode: { value: "writes" } }} />);
    expect(container.querySelector<HTMLElement>("[data-canvas-mode]")!.hasAttribute("tabindex")).toBe(false);
  });
});

describe("a bar whose tools all give way in the narrow form", () => {
  const share = (
    <span data-narrow-hide>
      <button type="button">Share</button>
    </span>
  );
  it("is hidden by the narrow width of the box around it, so a read-only sheet's Share leaves no empty band beside a thread", () => {
    const { container } = render(<KindBar feeds={NO_FEEDS} tools={share} shut />);
    expect(bar(container).className).toContain("@max-[580px]/barbox:hidden");
    expect(bar(container).parentElement!.className).toContain("@container/barbox");
  });

  it("is not, where anything else stands in it, or while it is held", () => {
    const { container, rerender } = render(<KindBar feeds={NO_FEEDS} tools={[share, <span key="p">1/14</span>]} shut />);
    expect(bar(container).className).not.toContain("/barbox:hidden");
    rerender(<KindBar feeds={NO_FEEDS} tools={<Tools shows="bone" />} />);
    rerender(<KindBar feeds={NO_FEEDS} tools={share} />);
    expect(bar(container).hasAttribute("data-bar-held")).toBe(true);
    expect(bar(container).className).not.toContain("/barbox:hidden");
  });
});
