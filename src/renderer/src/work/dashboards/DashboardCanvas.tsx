import { useEffect, useState, useSyncExternalStore } from "react";
import type { DashBlock, DashboardView, DashFigure, DashFormat, DashFrom, DashProposal, DashSheet } from "@shared/contract-work-dashboards";
import { ExternalLink, RefreshCw } from "../../chrome/icons";
import { Button } from "../../components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "../../components/ui/popover";
import { Skeleton } from "../../components/ui/skeleton";
import { Spinner } from "../../components/ui/spinner";
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
}
class DashStore {
  private slot: Slot = { view: null, error: null, refreshing: false };
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
  const { view, error } = useSlot(store);

  useEffect(() => {
    let live = true;
    const load = (): void =>
      void host.open().then(
        (v) => live && store.set({ view: v, error: null }),
        (e: unknown) => live && !store.get().view && store.set({ error: e instanceof Error ? e.message : "The dashboard did not load." }),
      );
    load();
    const off = host.watch((v) => store.set({ view: v }));
    const t = setInterval(load, STALE_POLL_MS);
    return () => {
      live = false;
      off();
      clearInterval(t);
    };
  }, [host, store]);

  const [current, setCurrent] = useState(0);
  useFeeds(shell, host, store, view, current, setCurrent);

  if (error) return <EmptyState title="Couldn't open this dashboard" line={error} />;
  if (!view) return <DashSkeleton />;
  if (!view.blocks.length) return <EmptyState title="Ask for a number" />;
  const proposed = view.blocks.filter((b) => b.proposed);
  const currentId = proposed[Math.min(current, proposed.length - 1)]?.id;
  return (
    <div data-dashboard data-stale={view.stale || undefined} className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain">
      <div className="@container mx-auto max-w-[672px] px-6 pt-6 pb-12">
        {groups(view.blocks).map((g) =>
          g.kind === "figures" ? (
            <Figures key={g.blocks[0].id} blocks={g.blocks} stale={view.stale} current={currentId} open={(f) => void host.openSheet(f.sheet, f.sheetTitle).catch((e: unknown) => sayError(e, "Couldn't open the sheet"))} />
          ) : (
            <Section key={g.block.id} block={g.block} stale={view.stale} current={g.block.id === currentId} />
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
function useFeeds(shell: CanvasShell, host: DashHost, store: DashStore, view: DashboardView | null, current: number, setCurrent: (n: number) => void): void {
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
  useEffect(() => {
    shell.statusLine(
      failed
        ? {
            tone: "failed",
            word: "Couldn't read the figures",
            detail: failed,
            action: { label: "Retry", run: () => host.refresh().then((v) => store.set({ view: v }), (e: unknown) => sayError(e, "Couldn't read the figures")) },
          }
        : null,
    );
    return () => shell.statusLine(null);
  }, [shell, host, store, failed]);

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

/** "As of", said once, and Refresh. Nothing while blocks wait: the stepper has the end. */
export function Bar(props: Props) {
  const host = hostFor(props);
  const store = storeOf(props.item.id);
  const { view, refreshing } = useSlot(store);
  if (!view || !view.asOf || view.blocks.some((b) => b.proposed)) return null;
  const refresh = (): void => {
    store.set({ refreshing: true });
    void host
      .refresh()
      .then(
        (v) => store.set({ view: v }),
        (e: unknown) => sayError(e, "Couldn't read the figures"),
      )
      .finally(() => store.set({ refreshing: false }));
  };
  return (
    <span data-dash-asof className="ms-auto flex shrink-0 items-center gap-1 tabular-nums">
      <span>As of {dayTime(view.asOf)}</span>
      <Button variant="ghost" size="icon-xs" aria-label="Refresh" disabled={refreshing} onClick={refresh} className="text-muted-foreground">
        {refreshing ? <Spinner /> : <RefreshCw />}
      </Button>
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
          className={`grid grid-cols-3 gap-x-6 border-b border-border pb-4 @max-[520px]:gap-x-3 ${i === 0 ? "mt-8 first:mt-0" : "mt-6"} ${proposed ? `${PROPOSED} pt-3` : ""} ${row.some((x) => x.block === current) ? CURRENT : ""}`}
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
      {f.sub ? <span className="text-xs whitespace-nowrap text-muted-foreground">{f.sub}</span> : null}
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
      <p data-block={block.id} className={`mt-6 text-sm leading-[22px] text-pretty first:mt-0 ${tint}`}>
        {block.text}
      </p>
    );
  if (block.kind === "figures") return null;
  return (
    <section data-block={block.id} className={`mt-8 first:mt-0 ${tint}`}>
      <h3 className="text-[13px] leading-5 font-semibold">{block.title}</h3>
      <div className="mt-3">{block.kind === "chart" ? <Chart bars={block.bars} format={block.format} stale={stale} title={block.title} /> : <FlatTable block={block} />}</div>
    </section>
  );
}

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 1 });
const plain = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
const tick = (v: number, format: DashFormat): string => (format === "money" ? money.format(v) : format === "percent" ? `${plain.format(v)}%` : plain.format(v));

/** A round top for the axis: 1, 2 or 5 times a power of ten, over the largest bar. */
export function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  return ([1, 2, 5, 10].map((m) => m * p).find((m) => m >= v) ?? 10 * p) as number;
}

/** One series of plain bars on the neutral: the current (last) bar in foreground, the rest a muted step of it; no legend. */
function Chart({ bars, format, stale, title }: { bars: { label: string; value: number }[]; format: DashFormat; stale: boolean; title: string }) {
  if (!bars.length) return <p className="text-[13px] text-muted-foreground">Nothing to draw yet.</p>;
  const top = niceMax(Math.max(...bars.map((b) => b.value)));
  const ticks = [0, top / 3, (2 * top) / 3, top];
  return (
    <div role="img" aria-label={`${title}: ${bars.map((b) => `${b.label} ${tick(b.value, format)}`).join(", ")}`} className="grid h-[168px] grid-cols-[40px_minmax(0,1fr)] grid-rows-[minmax(0,1fr)_20px]">
      <div className="relative text-xs text-muted-foreground tabular-nums">
        {ticks.map((t) => (
          <span key={t} className="absolute right-2 translate-y-1/2" style={{ bottom: `${(t / top) * 100}%` }}>
            {tick(t, format)}
          </span>
        ))}
      </div>
      <div className="relative flex items-end justify-around border-b border-border">
        {ticks.slice(1).map((t) => (
          <i key={t} aria-hidden className="absolute inset-x-0 h-0 border-t border-dashed border-border" style={{ bottom: `${(t / top) * 100}%` }} />
        ))}
        {bars.map((b, i) => {
          const on = i === bars.length - 1;
          return (
            <i
              key={`${b.label}${i}`}
              aria-hidden
              className={`relative z-1 w-[min(32px,56%)] rounded-t-[3px] ${on ? (stale ? "bg-(--chart-neutral-stale)" : "bg-foreground") : "bg-(--chart-neutral-rest)"}`}
              style={{ height: `${(Math.max(0, b.value) / top) * 100}%` }}
            />
          );
        })}
      </div>
      <div className="col-start-2 flex justify-around text-xs leading-5 text-muted-foreground">
        {bars.map((b, i) => (
          <span key={`${b.label}${i}`} className={`flex w-0 justify-center whitespace-nowrap ${i === bars.length - 1 ? "font-medium text-foreground" : ""}`}>
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
    <div className="overflow-x-auto overflow-y-hidden">
      <table className="w-full text-[13px] leading-5">
        <thead>
          <tr className="border-b border-border">
            {block.head.map((h, i) => (
              <th key={i} className={`h-8 px-3 text-xs font-medium whitespace-nowrap text-muted-foreground first:ps-0 last:pe-0 ${align(i)}`}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {block.rows.map((r, i) => (
            <tr key={i} className="border-b border-border last:border-0">
              {r.map((v, j) => (
                <td key={j} className={`h-8 max-w-[280px] truncate px-3 whitespace-nowrap first:ps-0 last:pe-0 ${align(j)}`}>
                  {v}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
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
