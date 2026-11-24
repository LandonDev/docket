// @vitest-environment jsdom
/**
 * A Today row says whatever its columns cut, on hover and focus, only while something is cut: the title, the second
 * line, and the job's whole name, which the 112px job column cuts on a long name and which leads the second line under
 * 480px (docs/agents/work-today.md, docs/DESIGN.md "Today": the dot is never the only cue to the job).
 */
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { tooltipChunk, warmTooltips } from "../../components/ui/tooltip";
import { TodayRowView } from "./TodayRow";
import type { TodayRow } from "./types";

beforeAll(async () => {
  await act(async () => {
    await tooltipChunk.load();
    warmTooltips();
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const row: TodayRow = { key: "due:1", section: "due", sector: "unify", title: "Send the venue the floor plan", detail: "Due today", open: () => undefined };
const JOB = "UnifyPlatforms client services and events";

/** Draws the row with only the element `cut` picks measuring wider than its box. */
function draw(cut: (el: HTMLElement) => boolean) {
  vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(function (this: HTMLElement) {
    return cut(this) ? 300 : 100;
  });
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(100);
  return render(<TodayRowView row={row} job={JOB} />);
}

/** Focuses the row's open control, as the arrows and Tab do, and answers the tip that shows, if any. */
async function tipOf(container: HTMLElement): Promise<Element | null> {
  await act(async () => {
    container.querySelector<HTMLElement>("[data-row-open]")!.focus();
    await new Promise((r) => setTimeout(r, 50));
  });
  return document.querySelector('[data-slot="tooltip-content"]');
}

describe("a Today row's whole words", () => {
  it("draws no tooltip while nothing is cut", async () => {
    const { container } = draw(() => false);
    expect(await tipOf(container)).toBeNull();
  });

  it("says the job's whole name when its column cuts it, with the title and detail", async () => {
    const { container } = draw((el) => el.textContent === JOB && el.classList.contains("truncate"));
    const tip = await tipOf(container);
    expect(tip?.textContent).toContain(row.title);
    expect(tip?.querySelector("[data-tip-detail]")?.textContent).toBe(`${JOB} Due today`);
  });

  it("names the job in the tip when the narrow second line, which the job leads, is cut", async () => {
    const { container } = draw((el) => el.hasAttribute("data-row-detail"));
    expect((await tipOf(container))?.querySelector("[data-tip-detail]")?.textContent).toBe(`${JOB} Due today`);
  });
});
