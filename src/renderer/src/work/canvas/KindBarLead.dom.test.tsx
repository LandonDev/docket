// @vitest-environment jsdom
/**
 * The kind's bar's lead and end (docs/agents/work-files.md "Two files in one tab"): a second file's head rides in
 * its kind's bar, so the side is one 32px row level with the bar of the file beside it. The lead stands first and
 * the end last, and a bar with them is drawn even where the kind feeds it nothing.
 */
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { NO_FEEDS } from "./frame";
import { KindBar, writtenWords } from "./KindBar";

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

describe("the written line's time", () => {
  const at = new Date(2026, 10, 25, 14, 4, 20).getTime();
  const feeds = { ...NO_FEEDS, written: { text: "Wrote 2 sections", at } };

  it("is said after the words, and not again where the save line beside says that minute", () => {
    const { rerender } = render(<KindBar feeds={feeds} />);
    expect(document.querySelector("[data-canvas-written]")!.textContent).toBe("Wrote 2 sections, 2:04 PM");
    rerender(<KindBar feeds={feeds} savedAt={at + 15_000} />);
    expect(document.querySelector("[data-canvas-written]")!.textContent).toBe("Wrote 2 sections");
    rerender(<KindBar feeds={feeds} savedAt={at + 120_000} />);
    expect(document.querySelector("[data-canvas-written]")!.textContent).toBe("Wrote 2 sections, 2:04 PM");
  });

  it("keeps a line whose words already hold their time as it was", () => {
    expect(writtenWords({ text: "Wrote 6 cells, 2:04 PM" }, at)).toBe("Wrote 6 cells, 2:04 PM");
  });
});
