// @vitest-environment jsdom
/**
 * The kind's bar's lead and end (docs/agents/work-files.md "Two files in one tab"): a second file's head rides in
 * its kind's bar, so the side is one 32px row level with the bar of the file beside it. The lead stands first and
 * the end last, and a bar with them is drawn even where the kind feeds it nothing.
 */
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { NO_FEEDS } from "./frame";
import { KindBar } from "./KindBar";

afterEach(cleanup);

describe("the bar's lead and end", () => {
  it("draws the lead first and the end last", () => {
    render(<KindBar feeds={NO_FEEDS} tools={<span>Tools</span>} onHistory={() => undefined} lead={<span>Roster.xlsx</span>} end={<button>Close</button>} />);
    const bar = document.querySelector<HTMLElement>("[data-canvas-bar]")!;
    expect(bar.className).toContain("h-8");
    expect(bar.firstElementChild!.hasAttribute("data-canvas-bar-lead")).toBe(true);
    expect(bar.firstElementChild!.textContent).toBe("Roster.xlsx");
    expect(bar.lastElementChild!.lastElementChild!.textContent).toBe("Close");
  });

  it("is drawn with a lead where the kind feeds it nothing, and not without one", () => {
    const { rerender } = render(<KindBar feeds={NO_FEEDS} />);
    expect(document.querySelector("[data-canvas-bar]")).toBeNull();
    rerender(<KindBar feeds={NO_FEEDS} lead={<span>Roster.xlsx</span>} />);
    expect(document.querySelector("[data-canvas-bar]")).not.toBeNull();
  });
});
