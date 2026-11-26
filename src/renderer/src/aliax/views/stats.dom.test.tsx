// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SECTION_SKELETON, StatsView, paceHeight, paceLine, paceTitle, resetPaceCount } from "./stats";
import { HEATMAP_HEIGHT } from "./stats/heatmap";
import { STATS } from "./stats.fixtures";

afterEach(() => {
  cleanup();
  resetPaceCount();
});

const headings = () => screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
const ORDER = ["Pace", "Daily output", "Model mix", "Top projects", "Cache hit rate", "Busiest hours", "Tools used"];

describe("Stats", () => {
  it("holds every pace series in one Pace section: seven sections in all", () => {
    render(<StatsView data={STATS} status={null} />);
    expect(headings()).toEqual(ORDER);
    const pace = screen.getByRole("region", { name: "Pace" });
    const series = pace.querySelectorAll("[data-slot=pace-series]");
    expect(series).toHaveLength(2);
    STATS.pace.forEach((p, i) => {
      expect(series[i].textContent).toContain(paceTitle(p));
      expect(series[i].textContent).toContain(paceLine(p).text);
    });
    // The one running out reads amber; a line is two facts with no dot between them.
    const words = screen.getByText(paceLine(STATS.pace[1]).text);
    expect(words.className).toContain("text-warning");
    expect(pace.textContent).not.toContain("·");
  });

  it("keeps the empty pace inside the same section", () => {
    render(<StatsView data={{ ...STATS, pace: [] }} status={null} />);
    expect(headings()).toEqual(ORDER);
    const pace = screen.getByRole("region", { name: "Pace" });
    expect(screen.getByText("Needs three finished cycles").getAttribute("data-slot")).toBe("page-empty");
    expect(pace.querySelector("[data-slot=empty]")).toBeNull();
  });

  it("says an empty section as the page's one muted line", () => {
    render(<StatsView data={{ ...STATS, daily: [] }} status={null} />);
    const daily = screen.getByRole("region", { name: "Daily output" });
    expect(daily.querySelector("[data-slot=page-empty]")!.textContent).toBe("Nothing in the last 30 days");
    expect(daily.querySelector("[data-slot=empty]")).toBeNull();
  });

  it("names each empty section's real window once: Busiest hours reads 60 days", () => {
    render(<StatsView data={{ ...STATS, heatmap: [] }} status={null} />);
    const busiest = screen.getByRole("region", { name: "Busiest hours" });
    // The description names the 60 days once; the empty line does not repeat it, nor contradict it.
    expect(busiest.textContent).toContain("last 60 days");
    expect(busiest.querySelector("[data-slot=page-empty]")!.textContent).toBe("Nothing yet");
    expect(busiest.textContent).not.toContain("30 days");
  });

  it("names Cache hit rate's 30 days on its empty line when no rate gives it a description", () => {
    render(<StatsView data={{ ...STATS, cacheDaily: [], totals: { ...STATS.totals, cache_read: 0, input: 0, cache_write: 0 } }} status={null} />);
    const cache = screen.getByRole("region", { name: "Cache hit rate" });
    expect(cache.querySelector("[data-slot=page-empty]")!.textContent).toBe("Nothing in the last 30 days");
  });

  it("says a pace headline as two facts, the title medium, 4px apart", () => {
    render(<StatsView data={STATS} status={null} />);
    const headline = screen.getByRole("region", { name: "Pace" }).querySelector("[data-slot=pace-series] p")!;
    expect(headline.className).toContain("text-xs");
    expect(headline.className).toContain("gap-x-1");
    expect(headline.firstElementChild!.className).toContain("font-medium");
  });

  it("draws a pace cycle in its provider's colour: Codex is chart-2", () => {
    render(<StatsView data={STATS} status={null} />);
    const pace = screen.getByRole("region", { name: "Pace" });
    const swatch = pace.querySelector("[data-slot=chart-legend] span span") as HTMLElement;
    expect(swatch.style.backgroundColor).toBe("var(--chart-2)");
  });

  it("draws Busiest hours, which counts both providers, on the neutral ramp, never Claude's colour", () => {
    render(<StatsView data={STATS} status={null} />);
    const busiest = screen.getByRole("region", { name: "Busiest hours" });
    const swatches = [...busiest.querySelectorAll<HTMLElement>("[data-ramp]")];
    expect(swatches.length).toBeGreaterThan(0);
    for (const swatch of swatches) expect(swatch.getAttribute("style")).toMatch(/var\(--foreground\)/);
  });

  it("loads under the same seven headings, each section in the shape it will hold", () => {
    render(<StatsView data={null} status={null} />);
    expect(headings()).toEqual(ORDER);
    const height = (h: string) => (document.querySelector(`[data-section-skeleton="${h}"]`) as HTMLElement).style.height;
    // A chart's 200px plot, with its legend's 24px where it draws one and the pace headline's above that.
    // Pace: its one legend, then two series (a fresh window's guess), each its headline and plot, 16px apart.
    expect(height("Pace")).toBe(`${paceHeight(2)}px`);
    expect(paceHeight(2)).toBe(24 + 2 * (24 + 200) + 16);
    expect(height("Daily output")).toBe("224px");
    expect(height("Model mix")).toBe("224px");
    expect(height("Cache hit rate")).toBe("200px");
    // The ranked lists at their eight 28px rows; the heatmap at its grid.
    expect(height("Top projects")).toBe("232px");
    expect(height("Tools used")).toBe("232px");
    expect(height("Busiest hours")).toBe(`${HEATMAP_HEIGHT}px`);
    // The two sections with a description line keep it.
    for (const h of ORDER) {
      const region = screen.getByRole("region", { name: h });
      const line = region.querySelector("p [data-slot=skeleton]");
      expect(Boolean(line), h).toBe(Boolean(SECTION_SKELETON[h as keyof typeof SECTION_SKELETON].description));
    }
  });
});

describe("Pace", () => {
  it("says its legend once, at its head, never under each series", () => {
    render(<StatsView data={STATS} status={null} />);
    const pace = screen.getByRole("region", { name: "Pace" });
    expect(pace.querySelectorAll("[data-slot=chart-legend]")).toHaveLength(1);
    expect(pace.querySelector("[data-slot=pace-series] [data-slot=chart-legend]")).toBeNull();
    expect(pace.querySelector("[data-slot=chart-legend]")!.textContent).toContain("Usual");
  });

  it("waits as tall as the last bundle drew it", () => {
    const three = { ...STATS, pace: [...STATS.pace, { ...STATS.pace[0], label: "week" }] };
    render(<StatsView data={three} status={null} />);
    cleanup();
    render(<StatsView data={null} status={null} />);
    expect((document.querySelector('[data-section-skeleton="Pace"]') as HTMLElement).style.height).toBe(`${paceHeight(3)}px`);
  });
});

describe("an empty month", () => {
  it("says the 30 days are empty, not the machine, when older logs are indexed", () => {
    const empty = { ...STATS, totals: { ...STATS.totals, turns: 0 }, pace: [], heatmap: [] };
    render(<StatsView data={empty} status={{ indexing: false, filesDone: 40, filesTotal: 40, rows: 1200 }} />);
    expect(screen.getByText("Nothing in the last 30 days")).toBeTruthy();
    expect(screen.queryByText(/session logs on this machine/)).toBeNull();
  });

  it("keeps the page open for Busiest hours when the last turn was 31 to 60 days ago", () => {
    const zero = { input: 0, output: 0, cache_read: 0, cache_write: 0, turns: 0 };
    const quiet = { ...STATS, totals: { ...STATS.totals, ...zero }, pace: [], daily: [], byProject: [], byTool: [], cacheDaily: [], modelDaily: [], byModel: [] };
    render(<StatsView data={quiet} status={{ indexing: false, filesDone: 40, filesTotal: 40, rows: 1200 }} />);
    const busiest = screen.getByRole("region", { name: "Busiest hours" });
    expect(busiest.querySelector("[data-slot=page-empty]")).toBeNull();
    // The 30-day sections say their own empty line; the page is not one empty state.
    expect(screen.getByRole("region", { name: "Daily output" }).querySelector("[data-slot=page-empty]")!.textContent).toBe("Nothing in the last 30 days");
    expect(document.querySelector("[data-slot=empty]")).toBeNull();
    // No hit rate is claimed for a month with no input.
    expect(screen.getByRole("region", { name: "Cache hit rate" }).textContent).not.toContain("% of input");
  });
});
