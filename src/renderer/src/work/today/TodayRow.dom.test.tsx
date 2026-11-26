// @vitest-environment jsdom
/**
 * A Today row says whatever its columns cut, on hover and focus, only while something is cut: the title, the second
 * line, and the job's whole name, which the 112px job column cuts on a long name and which leads the second line under
 * 480px (docs/agents/work-today.md, docs/DESIGN.md "Today": the dot is never the only cue to the job).
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
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

it("holds the tick and its Space shortcut until the job's link returns", () => {
  const complete = vi.fn(async () => {});
  const task: TodayRow = { ...row, lead: { kind: "tick", label: "Mark task done", run: complete } };
  const shown = render(<TodayRowView row={task} job={JOB} tickHeld />);
  const tick = () => screen.getByRole("checkbox", { name: "Mark task done" });
  expect(tick().matches('[disabled], [aria-disabled="true"]')).toBe(true);
  fireEvent.keyDown(screen.getByRole("button", { name: `${row.title}, ${row.detail}` }), { key: " " });
  expect(tick().getAttribute("aria-checked")).toBe("false");
  expect(complete).not.toHaveBeenCalled();
  shown.rerender(<TodayRowView row={task} job={JOB} />);
  expect(tick().matches('[disabled], [aria-disabled="true"]')).toBe(false);
});

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

it("keeps a meeting's place and people after a clash's note, the note in the failed tone, the row named by both", () => {
  const meeting: TodayRow = { key: "event:1", section: "meetings", sector: "hypixel", title: "Thumbnail review", detail: "Overlaps Staff sync", detailLate: true, detailAfter: "Studio B, with Priya Nair", open: () => undefined };
  const { container } = render(<TodayRowView row={meeting} job="Hypixel" />);
  const line = container.querySelector("[data-row-detail]")!;
  // No dot or bar between the two facts: the note is in the fault's tone, the row's own line muted, 4px after it.
  expect(line.textContent).toBe("HypixelOverlaps Staff syncStudio B, with Priya Nair");
  expect(screen.getByText("Overlaps Staff sync").className).toContain("text-destructive");
  expect(screen.getByRole("button", { name: "Thumbnail review, Overlaps Staff sync, Studio B, with Priya Nair" })).toBeTruthy();
});
