import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { DashBlock, DashboardView, DashFigure, DashFormat, DashFrom, DashProposal, DashSheet } from "@shared/contract-work-dashboards";
import { ExternalLink, RefreshCw } from "../../chrome/icons";
import { Button } from "../../components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "../../components/ui/popover";
import { Skeleton } from "../../components/ui/skeleton";
import { Spinner } from "../../components/ui/spinner";
import { Table as DataTable, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { TooltipProvider } from "../../components/ui/tooltip";
import { Tip, TruncateTip } from "../../components/tip";
import { dayTime } from "../../lib/duration";
import { EmptyState } from "../../surfaces/SurfaceSkeleton";
import { sayError } from "../canvas/frame";
import type { CanvasBodyProps, CanvasShell, ReviewAdapter } from "../canvas/kind";
import { Table } from "../icons";
import { linkDashHost, type DashHost } from "./host";

/**
 * The dashboard kind (docs/agents/work-dashboards.md; the approved page is
 * .temp-code/prototypes/work-workspaces-2/dashboard.html, "A page of
 * figures"): one column read top to bottom, the figures as text on one
 * hairline row, one plain chart, flat tables. Every figure opens where it
 * came from. "As of" is said once, in the bar. A block an agent adds waits
 * for his Accept, tinted as added, stepped from the bar.
 */

type Block = DashBlock & { proposed?: DashProposal };

interface Slot {
  view: DashboardView | null;
  error: string | null;
  refreshing: boolean;
  /** A read after the first one failed: the figures shown may be old, so the page says it is out of date until a read answers. */
  missed: boolean;
}
class DashStore {
  private slot: Slot = { view: null, error: null, refreshing: false, missed: false };
  private readonly listeners = new Set<() => void>();
  get = (): Slot => this.slot;
  set = (patch: Partial<Slot>): void => {
    this.slot = { ...this.slot, ...patch };
    for (const l of this.listeners) l();
  };
  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
}
const stores = new Map<string, DashStore>();
const storeOf = (itemId: string): DashStore => {
  let s = stores.get(itemId);
  if (!s) stores.set(itemId, (s = new DashStore()));
  return s;
};
const hosts = new Map<string, DashHost>();
function hostFor(props: Props): DashHost {
  if (props.host) return props.host;
  const key = `${props.env}\n${props.item.id}`;
  let host = hosts.get(key);
  if (!host) hosts.set(key, (host = linkDashHost(props.env, props.item)));
  return host;
}
const useSlot = (store: DashStore): Slot => useSyncExternalStore(store.subscribe, store.get);

type Props = CanvasBodyProps<undefined> & { host?: DashHost };

/** How often an open dashboard asks whether a sheet it reads has moved. */
const STALE_POLL_MS = 30_000;

export function Body(props: Props) {
  const { item, shell } = props;
  const host = hostFor(props);
  const store = storeOf(item.id);
  const { view, error, missed } = useSlot(store);

  // A failed first read is said once, on the state line with Retry; Retry reads again.
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    const load = (): void =>
      void host.open().then(
        (v) => live && store.set({ view: v, error: null, missed: false }),
        (e: unknown) => {
          if (!live) return;
          // After the first read a failure keeps the figures but marks them out of date, never drops it in silence.
          if (store.get().view) store.set({ missed: true });
          else store.set({ error: e instanceof Error ? e.message : "The dashboard did not load." });
        },
      );
    load();
    const off = host.watch((v) => store.set({ view: v, missed: false }));
    const t = setInterval(load, STALE_POLL_MS);
    return () => {
      live = false;
      off();
      clearInterval(t);
    };
  }, [host, store, attempt]);

  const [current, setCurrent] = useState(0);
  const retryOpen = (): void => {
    store.set({ error: null });
    setAttempt((n) => n + 1);
  };
  useFeeds(shell, host, store, view, error, retryOpen, current, setCurrent);

  if (error) return null;
  if (!view) return <DashSkeleton />;
  if (!view.blocks.length) return <EmptyState title="Ask for a number" />;
  const proposed = view.blocks.filter((b) => b.proposed);
  const currentId = proposed[Math.min(current, proposed.length - 1)]?.id;
  const stale = view.stale || missed;
  return (
    <div data-dashboard data-stale={stale || undefined} className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain">
      <div className="@container mx-auto max-w-[672px] px-6 pt-6 pb-12">
        {groups(view.blocks).map((g) =>
          g.kind === "figures" ? (
            <Figures key={g.blocks[0].id} blocks={g.blocks} stale={stale} current={currentId} open={(f) => void host.openSheet(f.sheet, f.sheetTitle).catch((e: unknown) => sayError(e, "Couldn't open the sheet"))} />
          ) : (
            <Section key={g.block.id} block={g.block} stale={stale} current={g.block.id === currentId} />
          ),
        )}
      </div>
    </div>
  );
}

/** Runs of figure blocks read as one hairline row of three; every other block stands alone. */
function groups(blocks: Block[]): ({ kind: "figures"; blocks: Extract<Block, { kind: "figures" }>[] } | { kind: "one"; block: Block })[] {
  const out: ReturnType<typeof groups> = [];
  for (const b of blocks) {
    const last = out.at(-1);
    if (b.kind === "figures" && last?.kind === "figures" && !last.blocks.some((x) => !!x.proposed !== !!b.proposed)) last.blocks.push(b);
    else out.push(b.kind === "figures" ? { kind: "figures", blocks: [b] } : { kind: "one", block: b });
  }
  return out;
}

/** What the body tells the pane: the mode (shown, not switched), the stepper over proposed blocks, a read that failed, More's sheets. */
function useFeeds(
  shell: CanvasShell,
  host: DashHost,
  store: DashStore,
  view: DashboardView | null,
  error: string | null,
  retryOpen: () => void,
  current: number,
  setCurrent: (n: number) => void,
): void {
  const has = !!view;
  useEffect(() => {
    if (!has) return shell.mode(null);
    shell.mode({ value: "suggests", note: "A new block waits for you, even on your own dashboard" });
    return () => shell.mode(null);
  }, [shell, has]);

  const proposedIds = view?.blocks.filter((b) => b.proposed).map((b) => b.id).join(",") ?? "";
  const by = view?.blocks.find((b) => b.proposed)?.proposed?.by;
  useEffect(() => {
    const ids = proposedIds ? proposedIds.split(",") : [];
    if (!ids.length || !by) return shell.review(null);
    const run = (w: number | { group: string } | "all", verdict: "accept" | "reject"): Promise<void> =>
      host.review(typeof w === "number" ? { ids: [ids[w]].filter(Boolean) } : "all", verdict).then(
        (v) => store.set({ view: v }),
        (e: unknown) => sayError(e, verdict === "accept" ? "Couldn't keep the block" : "Couldn't drop the block"),
      );
    const review: ReviewAdapter = {
      groups: [{ id: "blocks", label: "Blocks", by, count: ids.length }],
      index: Math.min(current, ids.length - 1),
      count: ids.length,
      step: (to) => {
        setCurrent(to);
        document.querySelector(`[data-block="${ids[to]}"]`)?.scrollIntoView?.({ block: "nearest" });
      },
      accept: (w) => run(w, "accept"),
      reject: (w) => run(w, "reject"),
    };
    shell.review(review);
    return () => shell.review(null);
  }, [shell, host, store, proposedIds, by, current, setCurrent]);

  const failed = view?.failed;
  const retry = useRef(retryOpen);
  retry.current = retryOpen;
  useEffect(() => {
    shell.statusLine(
      error
        ? { tone: "failed", word: "Couldn't open this dashboard", detail: error, action: { label: "Retry", run: () => retry.current() } }
        : failed
          ? {
              tone: "failed",
              word: "Couldn't read the figures",
              detail: failed,
              action: { label: "Retry", run: () => host.refresh().then((v) => store.set({ view: v }), (e: unknown) => sayError(e, "Couldn't read the figures")) },
            }
          : null,
    );
    return () => shell.statusLine(null);
  }, [shell, host, store, failed, error]);

  const sheets = view ? sheetsOf(view.blocks) : [];
  const sheetKey = sheets.map((s) => `${s.sheetTitle}`).join("\n");
  useEffect(() => {
    if (!sheetKey) return shell.more?.(null);
    shell.more?.(sheets.slice(0, 3).map((s, i) => ({ id: `sheet${i}`, label: `Open ${s.sheetTitle}`, icon: Table, run: () => host.openSheet(s.sheet, s.sheetTitle) })));
    return () => shell.more?.(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shell, host, sheetKey]);
}

/** Each sheet the page reads, once, in the order it first appears. */
function sheetsOf(blocks: Block[]): { sheet: DashSheet; sheetTitle: string }[] {
  const seen = new Map<string, { sheet: DashSheet; sheetTitle: string }>();
  for (const b of blocks) {
    const froms: DashFrom[] = b.kind === "chart" || b.kind === "table" ? [b.from] : b.kind === "figures" ? b.figures.flatMap((f) => ("sheet" in f.from ? [f.from] : [])) : [];
    for (const f of froms) {
      const key = f.sheet.at === "lifeos" ? f.sheet.id : `${f.sheet.host}:${f.sheet.path}`;
      if (!seen.has(key)) seen.set(key, { sheet: f.sheet, sheetTitle: f.sheetTitle });
    }
  }
  return [...seen.values()];
}

// ── the bar ──────────────────────────────────────────────────────────

/**
 * "As of", said once, and Refresh; "Out of date" before it once a sheet the
 * page reads has moved. Nothing while blocks wait: the stepper has the end.
 * While the page loads, one bone where the mode will be.
 */
export function Bar(props: Props) {
  const host = hostFor(props);
  const store = storeOf(props.item.id);
  const { view, error, refreshing, missed } = useSlot(store);
  if (!view) return error ? null : <Skeleton data-dash-bar-bone className="h-3 w-30" />;
  if (!view.asOf || view.blocks.some((b) => b.proposed)) return null;
  const refresh = (): void => {
    store.set({ refreshing: true });
    void host
      .refresh()
      .then(
        (v) => store.set({ view: v, missed: false }),
        (e: unknown) => {
          store.set({ missed: true });
          sayError(e, "Couldn't read the figures");
        },
      )
      .finally(() => store.set({ refreshing: false }));
  };
  return (
    <span data-dash-asof className="ms-auto flex shrink-0 items-center gap-1 tabular-nums">
      {view.stale || missed ? <span className="font-medium text-foreground">Out of date</span> : null}
      <span>As of {dayTime(view.asOf)}</span>
      {/* While it reads, the spinner takes the button's own 24px place, so nothing beside it moves. */}
      {refreshing ? (
        <span role="status" aria-label="Reading the figures" className="flex size-6 items-center justify-center text-muted-foreground">
          <Spinner className="size-3" />
        </span>
      ) : (
        <Tip label="Refresh">
          <Button variant="ghost" size="icon-xs" aria-label="Refresh" onClick={refresh} className="text-muted-foreground">
            <RefreshCw />
          </Button>
        </Tip>
      )}
    </span>
  );
}

// ── the page ─────────────────────────────────────────────────────────

const PROPOSED = "-mx-3 rounded-lg bg-(--add-bg) px-3";
const CURRENT = "outline-1 outline-foreground/40 outline-solid";

function Figures({ blocks, stale, current, open }: { blocks: Extract<Block, { kind: "figures" }>[]; stale: boolean; current?: string; open(from: DashFrom): void }) {
  const proposed = !!blocks[0].proposed;
  const figures = blocks.flatMap((b) => b.figures.map((f) => ({ f, block: b.id })));
  const rows: (typeof figures)[] = [];
  for (let i = 0; i < figures.length; i += 3) rows.push(figures.slice(i, i + 3));
  return (
    <>
      {rows.map((row, i) => (
        <div
          key={row[0].f.id}
          data-block={i === 0 ? blocks[0].id : undefined}
          className={`grid grid-cols-3 gap-x-6 gap-y-4 border-b border-border pb-4 @max-[480px]:grid-cols-2 @max-[480px]:gap-x-3 @max-[280px]:grid-cols-1 ${i === 0 ? "mt-8 first:mt-0 [h2+&]:mt-4" : "mt-6"} ${proposed ? `${PROPOSED} pt-3` : ""} ${row.some((x) => x.block === current) ? CURRENT : ""}`}
        >
          {row.map(({ f }) => (
            <Figure key={f.id} f={f} stale={stale} open={open} />
          ))}
        </div>
      ))}
    </>
  );
}

function Figure({ f, stale, open }: { f: DashFigure; stale: boolean; open(from: DashFrom): void }) {
  const value = <span className={`text-base leading-6 font-semibold tracking-[-0.01em] tabular-nums ${stale ? "text-muted-foreground" : ""}`}>{f.value ?? "—"}</span>;
  return (
    <div data-figure={f.id} className="flex min-w-0 flex-col items-start gap-0.5">
      <span className="max-w-full truncate text-xs text-muted-foreground">{f.label}</span>
      <Popover>
        <PopoverTrigger
          render={
            <button
              type="button"
              aria-label={`${f.label}: ${f.value ?? "no value"}. Where it comes from`}
              className="-mx-1 rounded-sm px-1 text-start transition-[background-color] duration-(--dur-hover) hover:bg-foreground/6 aria-expanded:bg-foreground/6"
            />
          }
        >
          {value}
        </PopoverTrigger>
        <PopoverContent align="start" className="w-72 p-3">
          <Source f={f} open={open} />
        </PopoverContent>
      </Popover>
      {f.sub ? (
        <TruncateTip text={f.sub}>
          <span className="max-w-full truncate text-xs text-muted-foreground">{f.sub}</span>
        </TruncateTip>
      ) : null}
    </div>
  );
}

/** Where a number comes from: the sheet, the range and what it counts, in words, and the way to the range. */
function Source({ f, open }: { f: DashFigure; open(from: DashFrom): void }) {
  const from = f.from;
  return (
    <div data-figure-source className="text-[13px] leading-5">
      <dl className="grid grid-cols-[56px_minmax(0,1fr)] gap-x-2 gap-y-1">
        {"sheet" in from ? (
          <>
            <dt className="text-muted-foreground">Sheet</dt>
            <dd className="flex min-w-0 items-center gap-1.5">
              <Table className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate">{from.sheetTitle}</span>
            </dd>
            <dt className="text-muted-foreground">Range</dt>
            <dd className="tabular-nums">{from.range}</dd>
          </>
        ) : (
          <>
            <dt className="text-muted-foreground">From</dt>
            <dd>{from.service}</dd>
          </>
        )}
        <dt className="text-muted-foreground">Counts</dt>
        <dd className="text-pretty">{from.counts}</dd>
      </dl>
      {"sheet" in from ? (
        <div className="-mx-1 -mb-1 mt-3 flex justify-end">
          <Button variant="ghost" size="xs" onClick={() => open(from)}>
            <ExternalLink />
            Open in the sheet
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function Section({ block, stale, current }: { block: Block; stale: boolean; current: boolean }) {
  const tint = `${block.proposed ? `${PROPOSED} pt-3 pb-4` : ""} ${current ? CURRENT : ""}`;
  if (block.kind === "heading")
    return (
      <h2 data-block={block.id} className={`mt-10 text-base leading-6 font-semibold tracking-[-0.01em] first:mt-0 ${tint}`}>
        {block.text}
      </h2>
    );
  if (block.kind === "text")
    return (
      <p data-block={block.id} className={`mt-6 text-sm leading-[22px] text-pretty first:mt-0 [h2+&]:mt-4 ${tint}`}>
        {block.text}
      </p>
    );
  if (block.kind === "figures") return null;
  return (
    <section data-block={block.id} className={`mt-8 first:mt-0 [h2+&]:mt-4 ${tint}`}>
      <h3 className="text-[13px] leading-5 font-semibold">{block.title}</h3>
      <div className="mt-3">{block.kind === "chart" ? <Chart bars={block.bars} format={block.format} stale={stale} title={block.title} /> : <FlatTable block={block} />}</div>
    </section>
  );
}

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 1 });
const plain = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
/** A number's sign as the typeset minus, before any currency sign ("−$5K", never "$-5K"). */
const signed = (v: number, unsigned: (n: number) => string): string => (v < 0 ? `\u2212${unsigned(-v)}` : unsigned(v));
const tick = (v: number, format: DashFormat): string => signed(v, (n) => (format === "money" ? money.format(n) : format === "percent" ? `${plain.format(n)}%` : plain.format(n)));

const full = (v: number, format: DashFormat): string =>
  signed(v, (n) => (format === "money" ? `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}` : format === "percent" ? `${n.toLocaleString("en-US")}%` : n.toLocaleString("en-US")));

/**
 * The axis: three round steps (1, 2 or 5 times a power of ten) whose top
 * clears the largest bar, so every tick is a number a person would write;
 * whole steps when every bar is a whole number (a count never reads 1.7).
 */
export function axis(max: number, whole: boolean): { step: number; top: number } {
  const need = Math.max(max, 0) / 3;
  if (need <= 0) return { step: 1, top: 3 };
  const p = 10 ** Math.floor(Math.log10(need));
  let step = [1, 2, 5, 10].map((m) => m * p).find((m) => m >= need * (1 - 1e-9)) ?? 10 * p;
  if (whole) step = Math.max(1, Math.round(step));
  return { step, top: 3 * step };
}

/**
 * The axis over signed bars: zero always on it, round steps on both sides.
 * All at or above zero is `axis`; all below is its mirror; a mix takes one
 * round step from the whole span (about three of them), each end rounded out
 * to a whole step. The ticks run from the bottom to the top.
 */
export function signedAxis(min: number, max: number, whole: boolean): { step: number; top: number; bottom: number; ticks: number[] } {
  let step: number;
  let top = 0;
  let bottom = 0;
  if (min >= 0) ({ step, top } = axis(max, whole));
  else if (max <= 0) {
    const mirror = axis(-min, whole);
    step = mirror.step;
    bottom = -mirror.top;
  } else {
    step = axis(max - min, whole).step;
    top = Math.ceil(max / step - 1e-9) * step;
    bottom = -Math.ceil(-min / step - 1e-9) * step;
  }
  const ticks: number[] = [];
  for (let i = 0; i <= Math.round((top - bottom) / step); i++) ticks.push(Number((bottom + i * step).toPrecision(12)) || 0);
  return { step, top, bottom, ticks };
}

const MONTH = /^(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?(\s+'?\d{2,4})?$/i;
const DAY = /^(mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?$/i;
const PERIOD = /^(q[1-4]|h[12]|w(ee)?k?\s?\d{1,2}|week\s\d{1,2})(\s+'?\d{2,4})?$/i;
const YEAR = /^(19|20)\d{2}$/;
const DATE = /^\d{4}-\d{2}(-\d{2})?$|^\d{1,2}\/\d{1,2}(\/\d{2,4})?$/;

/** Whether the bars are a run of periods (months, weeks, quarters, years, dates): only then is the last one "now", stressed. */
export function isTimeSeries(labels: string[]): boolean {
  return labels.length > 1 && labels.every((l) => [MONTH, DAY, PERIOD, YEAR, DATE].some((r) => r.test(l.trim())));
}

/** One series of plain bars on the neutral, no legend; on a run of periods the current (last) bar in foreground, the rest a muted step of it. Each bar names its value on hover. */
function Chart({ bars, format, stale, title }: { bars: { label: string; value: number }[]; format: DashFormat; stale: boolean; title: string }) {
  if (!bars.length) return <p className="text-[13px] text-muted-foreground">Nothing to draw yet.</p>;
  const values = bars.map((b) => b.value);
  const { top, bottom, ticks } = signedAxis(Math.min(...values), Math.max(...values), values.every((v) => Number.isInteger(v)));
  const span = top - bottom;
  // Where a value sits, in percent up from the plot's foot; zero is the bars' base, so a negative bar hangs below it.
  const at = (v: number): number => ((v - bottom) / span) * 100;
  const now = isTimeSeries(bars.map((b) => b.label)) ? bars.length - 1 : -1;
  return (
    <div role="img" aria-label={`${title}: ${bars.map((b) => `${b.label} ${tick(b.value, format)}`).join(", ")}`} className="grid h-[168px] grid-cols-[40px_minmax(0,1fr)] grid-rows-[minmax(0,1fr)_20px]">
      <div className="relative text-xs text-muted-foreground tabular-nums">
        {ticks.map((t) => (
          <span key={t} data-tick={t} className="absolute right-2 translate-y-1/2" style={{ bottom: `${at(t)}%` }}>
            {tick(t, format)}
          </span>
        ))}
      </div>
      <TooltipProvider>
        <div className={`relative flex justify-around ${bottom === 0 ? "border-b border-border" : ""}`}>
          {ticks.map((t) =>
            t === bottom && bottom === 0 ? null : (
              <i key={t} aria-hidden data-zero={t === 0 || undefined} className={`absolute inset-x-0 h-0 border-t border-border ${t === 0 ? "" : "border-dashed"}`} style={{ bottom: `${at(t)}%` }} />
            ),
          )}
          {bars.map((b, i) => (
            <span key={`${b.label}${i}`} className="relative z-1 h-full w-[min(32px,56%)]">
              <Tip label={`${b.label}, ${full(b.value, format)}`}>
                <i
                  data-bar={i === now ? "now" : ""}
                  data-sign={b.value < 0 ? "negative" : undefined}
                  className={`absolute inset-x-0 ${b.value < 0 ? "rounded-b-[3px]" : "rounded-t-[3px]"} ${i === now ? (stale ? "bg-(--chart-neutral-stale)" : "bg-foreground") : "bg-(--chart-neutral-rest)"}`}
                  style={{ bottom: `${at(Math.min(0, b.value))}%`, height: `${(Math.abs(b.value) / span) * 100}%` }}
                />
              </Tip>
            </span>
          ))}
        </div>
      </TooltipProvider>
      <div className="col-start-2 flex justify-around text-xs leading-5 text-muted-foreground">
        {bars.map((b, i) => (
          <span key={`${b.label}${i}`} className={`flex w-0 justify-center whitespace-nowrap ${i === now ? "font-medium text-foreground" : ""}`}>
            {b.label}
          </span>
        ))}
      </div>
    </div>
  );
}

function FlatTable({ block }: { block: Extract<Block, { kind: "table" }> }) {
  if (!block.rows.length) return <p className="text-[13px] text-muted-foreground">No rows.</p>;
  const align = (i: number): string => (block.numeric[i] ? "text-end tabular-nums" : "text-start");
  return (
    <DataTable className="leading-5">
      <TableHeader>
        <TableRow>
          {block.head.map((h, i) => (
            <TableHead key={i} className={align(i)}>
              {h}
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {block.rows.map((r, i) => (
          <TableRow key={i}>
            {r.map((v, j) => (
              <TableCell key={j} className={`h-8 max-w-[280px] truncate ${align(j)}`}>
                {v}
              </TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </DataTable>
  );
}

// ── loading ──────────────────────────────────────────────────────────

export function DashSkeleton() {
  return (
    <div data-dashboard-loading aria-busy="true" className="mx-auto w-full max-w-[672px] px-6 pt-6">
      <div className="grid grid-cols-3 gap-x-6 border-b border-border pb-4">
        {[0, 1, 2].map((i) => (
          <div key={i} className="flex flex-col gap-2">
            <Skeleton className="h-3 w-[60%]" />
            <Skeleton className="h-5 w-[48%]" />
            <Skeleton className="h-3 w-[40%]" />
          </div>
        ))}
      </div>
      <Skeleton className="mt-8 h-3.5 w-[22%]" />
      <div className="mt-3 flex h-[140px] items-end justify-around border-b border-border">
        {[60, 75, 52, 88, 66, 80].map((p) => (
          <Skeleton key={p} className="w-[min(32px,10%)] rounded-t-[3px] rounded-b-none" style={{ height: `${p}%` }} />
        ))}
      </div>
    </div>
  );
}
