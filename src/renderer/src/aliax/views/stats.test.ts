import { describe, expect, it } from "vitest";
import type { PaceSeries } from "@shared/aliaxStats";
import { readFileSync } from "node:fs";
import { TICK } from "@aliax/charts/chart";
import { dayTickInterval, paceData, paceLine, PLOT_MARGIN, timeLeft, VALUE_AXIS } from "./stats";

const HOUR = 3_600_000;
/** A 5-hour window `left` hours from its end, heading for `projected` percent. */
const pace = (left: number, projected: number): PaceSeries =>
  ({ periodMs: 5 * HOUR, nowFrac: 1 - left / 5, projectedPercent: projected }) as unknown as PaceSeries;

describe("Stats pace line", () => {
  it("says one hour in the singular, more in the plural", () => {
    expect(paceLine(pace(1.2, 40)).text).toBe("Ends near 40% used at this pace, resets in 1 hour");
    expect(paceLine(pace(2, 120)).text).toBe("Will run out before the reset in 2 hours");
  });

  it("names the time as the reset's, never as when the limit runs out", () => {
    const out = paceLine(pace(72, 140)).text;
    expect(out).toBe("Will run out before the reset in 3 days");
    expect(out).not.toMatch(/, \d+ \w+ left$/);
    expect(paceLine(pace(72, 60)).text).toBe("Ends near 60% used at this pace, resets in 3 days");
  });

  it("rounds before it picks the word", () => {
    expect(timeLeft(1.4)).toBe("1 hour");
    expect(timeLeft(1.6)).toBe("2 hours");
    expect(timeLeft(0.5)).toBe("under an hour");
    expect(timeLeft(72)).toBe("3 days");
  });
});

describe("Stats day axes", () => {
  it("label at most six days, evenly spaced", () => {
    for (const days of [1, 6, 7, 30, 31, 60]) {
      const step = dayTickInterval(days) + 1;
      expect(Math.ceil(days / step), `${days} days`).toBeLessThanOrEqual(6);
    }
    expect(dayTickInterval(30)).toBe(4);
    expect(dayTickInterval(5)).toBe(0);
  });

  // council 5 S F8.1: a narrow plot labels fewer days, so the dates keep their room; a wide one keeps six.
  it("label no more days than the plot's width holds, each at least 64px apart", () => {
    for (const width of [180, 240, 296, 360, 420, 700, 1200]) {
      const step = dayTickInterval(30, width) + 1;
      const labels = Math.ceil(30 / step);
      expect(labels, `${width}px`).toBeLessThanOrEqual(6);
      expect(labels, `${width}px`).toBeGreaterThanOrEqual(1);
      if (labels > 1) expect((width - 56) / labels, `${width}px`).toBeGreaterThanOrEqual(64);
    }
    // The 400px window's chart (about 296px wide) labels three days, not six.
    expect(Math.ceil(30 / (dayTickInterval(30, 296) + 1))).toBe(3);
    expect(dayTickInterval(30, 1200)).toBe(dayTickInterval(30));
  });
});

describe("a value plot's room for its ticks", () => {
  it("holds the top tick's upper half and gives \"100%\" the axis's whole width less the gap", () => {
    // A tick is centred on its gridline: the top one needs half its 12px line above the plot.
    expect(PLOT_MARGIN.top).toBeGreaterThanOrEqual(TICK.fontSize / 2 + 2);
    // Recharts sets the label tickMargin + tickSize in from the axis's width; DejaVu Sans draws "100%" 35px wide at 12px.
    expect(VALUE_AXIS.width - VALUE_AXIS.tickMargin - VALUE_AXIS.tickSize).toBeGreaterThanOrEqual(36);
    expect(VALUE_AXIS.width).toBe(44);
  });
  it("every value axis and plot margin on the page is the shared one", () => {
    const source = readFileSync(new URL("./stats.tsx", import.meta.url), "utf8");
    expect(source).not.toMatch(/margin=\{\{ top: 4/);
    // The one category axis (the bar lists' names) keeps its own width; every other y axis is a value axis.
    expect(source.match(/<YAxis \{\.\.\.AXIS\}/g)?.length ?? 0).toBe(1);
    expect(source.match(/<YAxis \{\.\.\.VALUE_AXIS\}/g)?.length).toBe(4);
  });
});

describe("Stats pace chart's points", () => {
  /** A 5-hour window in 5 one-hour marks, this cycle sampled to 2.5 hours at 40%, the query's latest reading carried past it. */
  const series = (): PaceSeries =>
    ({
      service: "claude-code",
      label: "5h",
      periodMs: 5 * HOUR,
      nowFrac: 0.5,
      nowPercent: 40,
      points: [0, 0.2, 0.4, 0.6, 0.8, 1].map((frac) => ({ frac, hours: frac * 5, p25: 10, median: 20, p75: 30, current: frac <= 0.4 ? frac * 80 : 40 })),
    }) as unknown as PaceSeries;

  it("ends this cycle at its latest sample, blank in every hour after it", () => {
    const data = paceData(series());
    const future = data.filter((p) => p.hours > 2.5);
    expect(future.length).toBe(3);
    expect(future.every((p) => p.current === null)).toBe(true);
    // The usual band and line still run the whole window.
    expect(future.every((p) => p.median === 20 && p.usual !== null)).toBe(true);
  });

  it("reaches the latest sample itself, between two hour marks", () => {
    const data = paceData(series());
    expect(data.find((p) => p.hours === 2.5)).toEqual({ hours: 2.5, usual: null, median: null, current: 40 });
    expect(data.map((p) => p.hours)).toEqual([0, 1, 2, 2.5, 3, 4, 5]);
  });

  it("draws no line, and adds no point, for a window with no live cycle", () => {
    const s = { ...series(), nowFrac: 0, nowPercent: 0, points: series().points.map((p) => ({ ...p, current: null })) } as PaceSeries;
    expect(paceData(s).map((p) => p.hours)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(paceData(s).every((p) => p.current === null)).toBe(true);
  });
});
