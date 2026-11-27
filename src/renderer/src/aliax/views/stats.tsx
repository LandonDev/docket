import { useMemo, type ReactNode } from "react";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, ComposedChart, Line, LineChart, Tooltip as ChartTooltip, XAxis, YAxis } from "recharts";
import type { PaceSeries, StatsBundle, StatsStatus } from "@shared/aliaxStats";
import { Bone, Loaded, Region } from "@renderer/components/bones";
import { PageEmpty, PageSection } from "@renderer/components/page";
import { Empty, EmptyDescription, EmptyTitle } from "@renderer/components/ui/empty";
import { thisDesktopInLine } from "@renderer/lib/native";
import { AXIS, BAR, BAR_CURSOR, CHART_HEIGHT, ChartFrame, GRID, HBAR, LINE, LINE_CURSOR } from "@aliax/charts/chart";
import { ChartLegend, type LegendItem } from "@aliax/charts/legend";
import { NEUTRAL_SERIES, SERIES, SERVICE_SERIES } from "@aliax/charts/palette";
import { ChartTooltipContent } from "@aliax/charts/tooltip";
import { TIMEZONE, clip, compact, compactTick, modelLabel, shortDay } from "@aliax/lib/viz";
import { HEATMAP_HEIGHT, Heatmap } from "./stats/heatmap";
import { fillDays, windowDays } from "./stats/days";
import { modelMix, OTHER_KEY } from "./stats/modelMix";

const PROVIDER: Record<string, string> = { codex: "Codex", "claude-code": "Claude Code" };

const windowName = (label: string): string => (label === "week" ? "weekly limit" : `${label.replace("h", "-hour")} limit`);

export const paceTitle = (p: PaceSeries): string => `${PROVIDER[p.service] ?? p.service} ${windowName(p.label)}`;

const hoursLeft = (p: PaceSeries): number => Math.max(0, ((1 - p.nowFrac) * p.periodMs) / 3_600_000);
/** "3 days", "1 hour", "5 hours", "under an hour": rounded first, then the word picked for that number. */
export const timeLeft = (h: number): string => {
  if (h >= 48) return `${Math.round(h / 24)} days`;
  if (h < 1) return "under an hour";
  const hours = Math.round(h);
  return hours === 1 ? "1 hour" : `${hours} hours`;
};

/** The pace chart's headline in words; running low is amber, never red. The time named is the reset's,
 *  never when the limit runs out. */
export function paceLine(p: PaceSeries): { text: string; warning: boolean } {
  if (p.projectedPercent === null) return { text: "No cycle running", warning: false };
  const left = timeLeft(hoursLeft(p));
  if (p.projectedPercent > 100) return { text: `Will run out before the reset in ${left}`, warning: true };
  // "used": Accounts and the usage popover say a window as what is left, so the share here is named.
  return { text: `Ends near ${p.projectedPercent}% used at this pace, resets in ${left}`, warning: p.projectedPercent > 85 };
}

/** The sections' headings, in order: known before the bundle, so drawn at once. */
const HEADINGS = ["Pace", "Daily output", "Model mix", "Top projects", "Cache hit rate", "Busiest hours", "Tools used"] as const;

const percent = (v: number): string => `${Math.round(v)}%`;
type TooltipProps = Parameters<typeof ChartTooltipContent>[0];
/** Recharts' hover state handed to the one readout, with the chart's own formatters. */
const tooltip = (props: { active?: boolean; payload?: readonly unknown[]; label?: unknown }, options: Omit<TooltipProps, "active" | "label">) => (
  <ChartTooltipContent active={props.active} payload={props.payload as TooltipProps["payload"]} label={props.label as TooltipProps["label"]} {...options} />
);

/** Daily output's and Model mix's unit, said once under each title; their hover values say "tokens" too. */
export const OUTPUT_UNIT = "Output tokens a day";
export const tokenValue = (v: number): string => `${compact(v)} tokens`;

function Section({ title, description, children }: { title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <PageSection title={title} description={description}>
      {children}
    </PageSection>
  );
}

/** A section with no data in the 30 days its query reads. A section whose
 *  description already names its window (Cache hit rate, Busiest hours'
 *  60 days) says Nothing yet, so the window is said once; one drawn with
 *  no description (Cache hit rate with no rate to print) names it here. */
function NoData({ named = false }: { named?: boolean }) {
  return <PageEmpty>{named ? "Nothing yet" : "Nothing in the last 30 days"}</PageEmpty>;
}

/** A value plot's margin: 8px over the top gridline holds the top half of its centred 12px tick ("100%", "100k"),
 *  which the chart's SVG would cut at 4; the chart's height is unchanged, the plot gives the room. */
export const PLOT_MARGIN = { top: 8, right: 12, bottom: 0, left: 0 } as const;
/** A value axis: 44px, the ticks 8px from the plot. Recharts sets a tick a tick line's length further out even with
 *  no line drawn, so its length is 0: "100%" has the whole 36px, room on a wider fallback font too. */
export const VALUE_AXIS = { ...AXIS, width: 44, tickSize: 0 } as const;

/** One hour mark of the pace chart: the usual band and line, and this cycle's reading where it was measured. */
export type PacePoint = { hours: number; usual: [number, number] | null; median: number | null; current: number | null };

/**
 * The pace chart's points. This cycle's line ends at its latest sample
 * (`nowFrac`, `nowPercent`): the hours after it are blank in the line and
 * its readout, never the last reading carried on as if measured then.
 */
export function paceData(series: PaceSeries): PacePoint[] {
  const tenths = (hours: number): number => Math.round(hours * 10) / 10;
  const out: PacePoint[] = series.points.map((p) => ({
    hours: tenths(p.hours),
    usual: p.p25 !== null && p.p75 !== null ? [p.p25, p.p75] : null,
    median: p.median,
    current: p.frac <= series.nowFrac ? p.current : null,
  }));
  // The latest sample between two hour marks is a point of its own, so the line reaches it.
  const live = out.some((p) => p.current !== null);
  const now = tenths((series.nowFrac * series.periodMs) / 3_600_000);
  if (live && !out.some((p) => p.hours === now)) {
    const i = out.findIndex((p) => p.hours > now);
    out.splice(i < 0 ? out.length : i, 0, { hours: now, usual: null, median: null, current: series.nowPercent });
  }
  return out;
}

function PaceChart({ series }: { series: PaceSeries }) {
  // The cycle is drawn in its provider's colour, as on every other chart.
  const color = SERVICE_SERIES[series.service as keyof typeof SERVICE_SERIES] ?? SERIES[0];
  const weekly = series.periodMs > 86_400_000;
  const data = paceData(series);
  return (
    <>
      <ChartFrame label={paceTitle(series)}>
        <ComposedChart data={data} margin={PLOT_MARGIN}>
          <CartesianGrid {...GRID} />
          <XAxis {...AXIS} dataKey="hours" type="number" domain={["dataMin", "dataMax"]} tickFormatter={(v: number) => (weekly ? `${Math.round(v / 24)}d` : `${v}h`)} minTickGap={24} />
          <YAxis {...VALUE_AXIS} domain={[0, 100]} tickFormatter={percent} />
          <ChartTooltip
            cursor={LINE_CURSOR}
            isAnimationActive={false}
            content={(props) =>
              tooltip(props, {
                payload: (props.payload as TooltipProps["payload"])?.filter((e) => e.dataKey !== "usual"),
                labelFormatter: (v) => (weekly ? `Day ${Math.round(Number(v) / 24)}` : `Hour ${v}`),
                valueFormatter: percent,
              })
            }
          />
          <Area dataKey="usual" name="Usual range" stroke="none" fill="var(--foreground)" fillOpacity={0.08} connectNulls isAnimationActive={false} activeDot={false} />
          <Line {...LINE} dataKey="median" name="Usual" stroke="var(--muted-foreground)" strokeWidth={1.5} connectNulls />
          <Line {...LINE} dataKey="current" name="This cycle" stroke={color} connectNulls />
        </ComposedChart>
      </ChartFrame>
    </>
  );
}

/** A cache rate's dot where neither neighbour has one (the line needs two points); nothing elsewhere. */
function LoneDot({ rows, index, cx, cy }: { rows: readonly { hit: number | null }[]; index: number; cx?: number; cy?: number }) {
  const lone = rows[index]?.hit != null && rows[index - 1]?.hit == null && rows[index + 1]?.hit == null;
  return lone && cx !== undefined && cy !== undefined ? <circle data-lone-dot cx={cx} cy={cy} r={2} fill={NEUTRAL_SERIES} /> : <g />;
}

/** A ranked list shows at most this many rows, each 28px, with 8px under the last. */
const RANKED_ROWS = 8;
const rankedHeight = (rows: number): number => rows * 28 + 8;

function RankedBars({ label, data, unit }: { label: string; data: { name: string; value: number }[]; unit: string }) {
  const rows = data.slice(0, RANKED_ROWS);
  if (rows.length === 0) return <NoData />;
  return (
    <ChartFrame label={label} height={rankedHeight(rows.length)}>
      <BarChart data={rows} layout="vertical" margin={{ top: 0, right: 4, bottom: 0, left: 0 }} barCategoryGap={6}>
        <XAxis type="number" hide />
        <YAxis {...AXIS} type="category" dataKey="name" width={128} tickFormatter={(v: string) => clip(v)} />
        <ChartTooltip cursor={BAR_CURSOR} isAnimationActive={false} content={(props) => tooltip(props, { valueFormatter: (v) => `${compact(v)} ${unit}` })} />
        {/* Both providers' work in one bar: the neutral series, never Claude's colour. */}
        <Bar {...HBAR} dataKey="value" name={unit} fill={NEUTRAL_SERIES} />
      </BarChart>
    </ChartFrame>
  );
}

/** A legend's line: 16px of 12px text and its 8px to the plot. */
const LEGEND_PX = 24;
/** A pace series' headline above its plot, the same 16px line and 8px. */
const HEADLINE_PX = 24;
/** Between two pace series (`gap-4`). */
const PACE_GAP_PX = 16;

/** Pace's height for `series` charts: its one legend, then each series' headline and plot. */
export const paceHeight = (series: number): number => LEGEND_PX + series * (HEADLINE_PX + CHART_HEIGHT) + Math.max(0, series - 1) * PACE_GAP_PX;

/** How many pace series the last bundle drew, so Pace's bone is that tall the next time the page loads (two before any). */
let lastPaceCount = 2;
/** For tests: the count a fresh window starts from. */
export const resetPaceCount = (count = 2): void => {
  lastPaceCount = count;
};

/**
 * Pace's legend, once at its head: the cycle's line in each provider's
 * colour, then the usual range. One provider's line is "This cycle"; with
 * two, each is named by its provider, whose headline says which is whose.
 */
function PaceLegend({ pace }: { pace: readonly PaceSeries[] }) {
  const colors = [...new Map(pace.map((p) => [p.service, SERVICE_SERIES[p.service as keyof typeof SERVICE_SERIES] ?? SERIES[0]])).entries()];
  const cycle = colors.length === 1 ? [{ label: "This cycle", color: colors[0]![1] }] : colors.map(([service, color]) => ({ label: `${PROVIDER[service] ?? service} cycle`, color }));
  return <ChartLegend items={[...cycle, { label: "Usual", color: "var(--muted-foreground)" }]} />;
}

/**
 * What each section holds once loaded, so the skeleton takes its shape and
 * the page does not jump when the bundle lands: the plot's height, a legend
 * where the chart draws one, the ranked lists at their eight rows, and the
 * description lines Daily output, Model mix, Cache hit rate and Busiest hours carry.
 */
type Heading = (typeof HEADINGS)[number];
export const SECTION_SKELETON: Record<Heading, { height: number; description?: boolean }> = {
  Pace: { height: paceHeight(1) },
  "Daily output": { height: LEGEND_PX + CHART_HEIGHT, description: true },
  "Model mix": { height: LEGEND_PX + CHART_HEIGHT, description: true },
  "Top projects": { height: rankedHeight(RANKED_ROWS) },
  "Cache hit rate": { height: CHART_HEIGHT, description: true },
  "Busiest hours": { height: HEATMAP_HEIGHT, description: true },
  "Tools used": { height: rankedHeight(RANKED_ROWS) },
};

/** A pace series' headline over its plot: its name, then the line its pace reads. */
function PaceHeadline({ title, line }: { title: string; line: { text: string; warning: boolean } }) {
  return (
    <p className="mb-2 flex flex-wrap gap-x-1 text-xs">
      <span className="font-medium text-foreground">{title}</span>
      <span className={line.warning ? "text-warning" : "text-muted-foreground"}>{line.text}</span>
    </p>
  );
}

/*
 * The bones' samples (docs/agents/loading-bones.md "Samples"): a legend's
 * words and a pace headline's, in their lengths. A chart has no words to
 * measure, so its plot is one bone at the plot's height.
 */
const SAMPLE_LEGEND: Partial<Record<Heading, LegendItem[]>> = {
  "Daily output": [
    { label: "Claude Code", color: SERVICE_SERIES["claude-code"] },
    { label: "Codex", color: SERVICE_SERIES.codex },
  ],
  "Model mix": [
    { label: "Opus 4.8", color: SERIES[0] },
    { label: "Sonnet 5", color: SERIES[1] ?? SERIES[0] },
    { label: "GPT-5.5", color: SERIES[2] ?? SERIES[0] },
  ],
};
const SAMPLE_PACE_LEGEND: LegendItem[] = [
  { label: "Claude Code cycle", color: SERVICE_SERIES["claude-code"] },
  { label: "Codex cycle", color: SERVICE_SERIES.codex },
  { label: "Usual", color: "var(--muted-foreground)" },
];
const SAMPLE_PACE_HEADLINE = { title: "Claude Code 5-hour limit", line: { text: "Ends near 62% used at this pace, resets in 3 hours", warning: false } };
/** Cache hit rate's line, whose number is the bundle's. */
const SAMPLE_CACHE_LINE = "84% of input served from cache, 30 days";
/** The plot's own height under each section's legend. */
const PLOT: Record<Heading, number> = {
  Pace: CHART_HEIGHT,
  "Daily output": CHART_HEIGHT,
  "Model mix": CHART_HEIGHT,
  "Top projects": rankedHeight(RANKED_ROWS),
  "Cache hit rate": CHART_HEIGHT,
  "Busiest hours": HEATMAP_HEIGHT,
  "Tools used": rankedHeight(RANKED_ROWS),
};

/** One section's bones while the bundle loads or an index pass runs: its legend in words, its plot one bone, as tall as the section will be. */
function SectionBones({ heading }: { heading: Heading }) {
  if (heading === "Pace") {
    // As tall as the last bundle drew it: a page lands with two to four series.
    return (
      <div data-section-skeleton={heading} style={{ height: paceHeight(lastPaceCount) }}>
        <ChartLegend items={SAMPLE_PACE_LEGEND} />
        <div className="flex flex-col gap-4">
          {Array.from({ length: lastPaceCount }, (_, i) => (
            <div key={i}>
              <PaceHeadline {...SAMPLE_PACE_HEADLINE} />
              <Bone className="w-full rounded-lg" height={CHART_HEIGHT} />
            </div>
          ))}
        </div>
      </div>
    );
  }
  const legend = SAMPLE_LEGEND[heading];
  return (
    <div data-section-skeleton={heading} style={{ height: SECTION_SKELETON[heading].height }}>
      {legend ? <ChartLegend items={legend} /> : null}
      <Bone className="w-full rounded-lg" height={PLOT[heading]} />
    </div>
  );
}

/**
 * History from this desktop's session logs, one chart per section, each
 * directly under its heading. Data in, sections out: StatsPage loads.
 */
/** The room one day label takes on its axis: "Oct 30" in 12px tabular figures and the gap to the next. */
export const DAY_TICK_PX = 64;
/** What a day chart's frame gives to things that are not its plot: the y axis (44) and the right margin (12). */
const PLOT_INSET = 56;

/** A day axis labels at most six days, evenly spaced, and no more than its plot's width holds at
 *  `DAY_TICK_PX` each (at least one): "Oct 6" never runs into "Oct 11" in a narrow window, and no
 *  label waits on a text measure (recharts' `minTickGap` needs one). A frame not yet measured (0) takes six. */
export function dayTickInterval(days: number, frameWidth = 0): number {
  const fit = frameWidth > 0 ? Math.max(1, Math.min(6, Math.floor((frameWidth - PLOT_INSET) / DAY_TICK_PX))) : 6;
  return Math.max(0, Math.ceil(days / fit) - 1);
}

export function StatsView({ data, status }: { data: StatsBundle | null; status: StatsStatus | null }) {
  const mix = useMemo(() => (data ? modelMix(data) : { series: [], rows: [] }), [data]);
  // One slot a calendar day over the window: an idle day draws zero output, and no cache rate a gap, never no room.
  const days = useMemo(() => {
    if (!data) return null;
    const all = windowDays(data);
    return {
      daily: fillDays(all, data.daily, (day) => ({ day, claude: 0, codex: 0 })),
      mix: fillDays(all, mix.rows as { day: string }[], (day) => ({ day, ...Object.fromEntries(mix.series.map((m) => [m.key, 0])) })),
      cache: fillDays<{ day: string; hit: number | null }>(all, data.cacheDaily, (day) => ({ day, hit: null })),
    };
  }, [data, mix]);

  // Busiest hours reads 60 days: a populated heatmap keeps the page open when the 30-day sections are empty.
  const nothing = data !== null && data.totals.turns === 0 && data.pace.length === 0 && data.heatmap.length === 0;
  // An index pass is a load, the first as much as a Reindex: the bundle read meanwhile is an earlier or partial one, and
  // the page's line says how far the pass has got. A worker that is gone runs no pass; its last bundle is drawn.
  const ready = data !== null && days !== null && !(status?.indexing && !data.unavailable);
  // A worker that is gone is the page's red line; its empty bundle states nothing.
  if (ready && nothing && data.unavailable) return null;
  if (ready && nothing) {
    // Logs indexed but none in the window: the window is what is empty, not the machine.
    if ((status?.rows ?? 0) > 0) {
      return (
        <Empty>
          <EmptyTitle>Nothing in the last 30 days</EmptyTitle>
        </Empty>
      );
    }
    return (
      <Empty>
        <EmptyTitle>Nothing to show yet</EmptyTitle>
        <EmptyDescription>No Claude Code or Codex session logs on {thisDesktopInLine()}.</EmptyDescription>
      </Empty>
    );
  }
  const bodies = ready ? sectionBodies(data, days, mix) : null;
  if (ready && data.pace.length > 0) lastPaceCount = data.pace.length;
  const cacheLine = ready ? cacheWords(data) : null;
  const description: Partial<Record<Heading, ReactNode>> = {
    "Daily output": OUTPUT_UNIT,
    "Model mix": OUTPUT_UNIT,
    // The rate is the bundle's: its words wait in the line; a month with no input claims no rate, so no line.
    "Cache hit rate":
      ready && cacheLine === null ? undefined : (
        <Loaded inline data={cacheLine} sample={SAMPLE_CACHE_LINE} label="">
          {(words) => words}
        </Loaded>
      ),
    "Busiest hours": `Output tokens by weekday and hour, last 60 days, times in ${TIMEZONE}`,
  };

  // Every heading and every line known before the bundle is drawn at once; each section's body waits in its own region.
  return (
    <>
      {HEADINGS.map((h, i) => (
        <Section key={h} title={h} description={description[h]}>
          <Region loading={bodies === null} label={i === 0 ? "Loading stats" : ""} bones={() => <SectionBones heading={h} />}>
            {bodies?.[h]}
          </Region>
        </Section>
      ))}
    </>
  );
}

/** Cache hit rate's line: the share of input served from cache, or null for a month with no input. */
function cacheWords(data: StatsBundle): string | null {
  const t = data.totals;
  const cacheDenominator = t.cache_read + t.input + t.cache_write;
  return cacheDenominator > 0 ? `${Math.round((t.cache_read / cacheDenominator) * 100)}% of input served from cache, 30 days` : null;
}

type Days = { daily: StatsBundle["daily"]; mix: { day: string }[]; cache: { day: string; hit: number | null }[] };

/** Each section's body once the bundle is in. */
function sectionBodies(data: StatsBundle, days: Days, mix: ReturnType<typeof modelMix>): Record<Heading, ReactNode> {
  const cacheNamed = cacheWords(data) !== null;
  return {
    Pace: (
      <>
        {data.pace.length === 0 ? (
          <PageEmpty>Needs three finished cycles</PageEmpty>
        ) : (
          <>
          <PaceLegend pace={data.pace} />
          <div className="flex flex-col gap-4">
            {data.pace.map((p) => {
              const line = paceLine(p);
              return (
                <div key={`${p.service}-${p.label}`} data-slot="pace-series">
                  <PaceHeadline title={paceTitle(p)} line={line} />
                  <PaceChart series={p} />
                </div>
              );
            })}
          </div>
          </>
        )}
      </>
    ),
    "Daily output": (
      <>
        {data.daily.length === 0 ? (
          <NoData />
        ) : (
          <>
            <ChartLegend
              items={[
                { label: "Claude Code", color: SERVICE_SERIES["claude-code"] },
                { label: "Codex", color: SERVICE_SERIES.codex },
              ]}
            />
            <ChartFrame label="Daily output">
              {(width) => (
              <BarChart data={days.daily} barGap={2} margin={PLOT_MARGIN}>
                <CartesianGrid {...GRID} />
                <XAxis {...AXIS} dataKey="day" tickFormatter={shortDay} interval={dayTickInterval(days.daily.length, width)} />
                <YAxis {...VALUE_AXIS} tickFormatter={compactTick} />
                <ChartTooltip cursor={BAR_CURSOR} isAnimationActive={false} content={(props) => tooltip(props, { labelFormatter: (v) => shortDay(String(v)), valueFormatter: tokenValue })} />
                <Bar {...BAR} dataKey="claude" name="Claude Code" fill={SERVICE_SERIES["claude-code"]} />
                <Bar {...BAR} dataKey="codex" name="Codex" fill={SERVICE_SERIES.codex} />
              </BarChart>
              )}
            </ChartFrame>
          </>
        )}
      </>
    ),
    "Model mix": (
      <>
        {mix.rows.length === 0 ? (
          <NoData />
        ) : (
          <>
            <ChartLegend items={mix.series.map((m) => ({ label: m.key === OTHER_KEY ? m.name : modelLabel(m.name), color: m.color }))} />
            <ChartFrame label="Model mix">
              {(width) => (
              <AreaChart data={days.mix} margin={PLOT_MARGIN}>
                <CartesianGrid {...GRID} />
                <XAxis {...AXIS} dataKey="day" tickFormatter={shortDay} interval={dayTickInterval(days.mix.length, width)} />
                <YAxis {...VALUE_AXIS} tickFormatter={compactTick} />
                <ChartTooltip
                  cursor={LINE_CURSOR}
                  isAnimationActive={false}
                  content={(props) => tooltip(props, { labelFormatter: (v) => shortDay(String(v)), valueFormatter: tokenValue, nameFormatter: (n) => (n === "Other" ? n : modelLabel(n)) })}
                />
                {mix.series.map((m) => (
                  <Area key={m.key} {...LINE} dataKey={m.key} name={m.name} stackId="mix" stroke={m.color} strokeWidth={1.5} fill={m.color} fillOpacity={0.2} />
                ))}
              </AreaChart>
              )}
            </ChartFrame>
          </>
        )}
      </>
    ),
    "Top projects": <RankedBars label="Top projects" data={data.byProject} unit="tokens" />,
    "Cache hit rate": (
      <>
        {data.cacheDaily.length === 0 ? (
          <NoData named={cacheNamed} />
        ) : (
          <ChartFrame label="Cache hit rate">
            {(width) => (
            <LineChart data={days.cache} margin={PLOT_MARGIN}>
              <CartesianGrid {...GRID} />
              <XAxis {...AXIS} dataKey="day" tickFormatter={shortDay} interval={dayTickInterval(days.cache.length, width)} />
              <YAxis {...VALUE_AXIS} domain={[0, 100]} tickFormatter={percent} />
              <ChartTooltip cursor={LINE_CURSOR} isAnimationActive={false} content={(props) => tooltip(props, { labelFormatter: (v) => shortDay(String(v)), valueFormatter: percent })} />
              {/* A rate between two days with none draws no line: its dot alone, so the day is not lost. */}
              <Line {...LINE} dataKey="hit" name="Hit rate" stroke={NEUTRAL_SERIES} dot={(p: { index: number; cx?: number; cy?: number }) => <LoneDot key={p.index} rows={days.cache} {...p} />} />
            </LineChart>
            )}
          </ChartFrame>
        )}
      </>
    ),
    "Busiest hours": data.heatmap.length === 0 ? <NoData named /> : <Heatmap data={data.heatmap} />,
    "Tools used": <RankedBars label="Tools used" data={data.byTool} unit="calls" />,
  };
}
