import type { ChartTooltipContent } from "@aliax/charts/tooltip";
import { defineChunk } from "../../lib/lazyChunk";

/**
 * The year's bars as data, and the chunk that draws them (docs/agents/work-money.md "The chart"). Nothing here
 * imports the chart library: MoneyView reads these and its first open carries no recharts.
 */

const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export type TooltipProps = Parameters<typeof ChartTooltipContent>[0];

/** The chart's height, the chart frame's own (`CHART_HEIGHT`, aliax/charts/chart.tsx): the box kept while the chunk loads. */
export const MONTH_BARS_HEIGHT = 200;

/**
 * The year's bars: no bar below the axis, so a month whose in or out is below zero (a refund he typed) draws that bar at nothing.
 * The true sums ride beside the bars' (`sums`): the hover says the month's figure as the ledger has it, sign and all.
 */
export const byMonthBars = (months: readonly { month: number; in: number; out: number }[]) =>
  months.map((m) => ({ month: MONTH_SHORT[m.month - 1], in: Math.max(0, m.in), out: Math.max(0, m.out), sums: { in: m.in, out: m.out } }));
export type MonthBar = ReturnType<typeof byMonthBars>[number];

/** The hover's rows with each bar's true sum in place of its height ("Out -$20.00" for a month of only a refund). */
export const trueRows = (payload: TooltipProps["payload"]): TooltipProps["payload"] =>
  payload?.map((e) => {
    const sums = (e.payload as { sums?: Record<string, number> } | undefined)?.sums;
    const key = String(e.dataKey ?? "");
    return sums && key in sums ? { ...e, value: sums[key] } : e;
  });

export const monthBarsChunk = defineChunk("work-money-chart", () => import("./MonthBars"));
