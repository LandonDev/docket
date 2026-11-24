import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import type { HistoryBranch, HistoryVersion } from "@shared/contract-work-history";
import { RowsMenu } from "../../chrome/menuRows";
import { ChevronDown, ChevronLeft, ChevronRight, FileText, PanelRight } from "../../chrome/icons";
import { Button } from "../../components/ui/button";
import { Checkbox } from "../../components/ui/checkbox";
import { reveal, yields } from "../../components/ui/reveal";
import { Empty, EmptyHeader, EmptyTitle } from "../../components/ui/empty";
import { ItemButton } from "../../components/ui/item";
import { Skeleton } from "../../components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../components/ui/tooltip";
import { cn } from "../../lib/cn";
import { dayTime } from "../../lib/duration";
import { EmptyState } from "../../surfaces/SurfaceSkeleton";
import { TypeGlyph } from "../../surfaces/threads/TypeGlyph";
import { sayError } from "../canvas/frame";
import type { CanvasBodyProps, CanvasShell, MoreEntry } from "../canvas/kind";
import { History } from "../icons";
import { PAGE_CHANGE_ID } from "../docs/review";
import { CompareDoc, CompareSkeleton, type Layout } from "./Compare";
import { historyActions, useBranches, useCompare, useVersions } from "./store";

/**
 * The history kind's body and bar (docs/agents/work-history.md; the approved
 * prototype, .temp-code/prototypes/work-workspaces-2/history.html): a
 * document's versions, the compare of two of them, and the review of a
 * branch of suggestions (a restore on a shared document, an agent's idea).
 * A compare is read only: no mode in the bar. One column by default; side
 * by side once each side has 420px.
 */

export interface HistoryState {
  view?: "list" | "compare" | "review";
  /** the compare's sides: version ids, or "live" for the document as it is now */
  from?: string;
  to?: string;
  branchId?: string;
  /** the layout the person chose; unset: by the width */
  layout?: Layout;
  /** versions ticked in the list, at most two */
  picked?: string[];
  /** the change the stepper is on */
  current?: number;
  /** the layout the body last drew, so the bar knows where the pickers go */
  shown?: Layout;
}

/** Side by side from 420px a side. */
export const SIDE_BY_SIDE_FROM = 840;

const initials = (name: string): string => {
  const words = name.trim().split(/\s+/);
  return ((words[0]?.[0] ?? "") + (words[1]?.[0] ?? "")).toUpperCase();
};

/** Who did something, as a list row names them: two names, then how many more. */
export function whoWords(by: readonly string[], names: Record<string, string>): string {
  const all = [...new Set(by.map((p) => names[p] ?? "Someone"))];
  if (all.length === 0) return "Someone";
  if (all.length <= 2) return all.join(" and ");
  return `${all[0]}, ${all[1]} and ${all.length - 2} more`;
}

const CAUSE_WORDS: Record<HistoryVersion["cause"], string> = {
  "agent-turn": "Edited",
  "before-agent": "Before an agent's changes",
  "guest-end": "A guest's visit",
  idle: "Edited",
  "before-restore": "Before a restore",
  restore: "Restored",
  import: "Imported",
  named: "Saved",
};

/** What a version is, in one line: its name, else why it was cut. */
export function versionWords(v: HistoryVersion, all: readonly HistoryVersion[]): string {
  if (v.label) return v.label;
  if (v.cause === "restore" && v.restoredFrom) {
    const from = all.find((x) => x.id === v.restoredFrom);
    return from ? `Restored the ${dayTime(from.at)} version` : "Restored an older version";
  }
  return CAUSE_WORDS[v.cause];
}

/** 24px: a person's initials on `muted`, or the thread's glyph for an agent. */
function Face({ principal, name }: { principal: string | undefined; name: string }) {
  if (principal?.startsWith("agent:"))
    return (
      <span aria-hidden className="grid size-6 shrink-0 place-items-center rounded-full bg-muted outline-1 -outline-offset-1 outline-(--image-outline)">
        <TypeGlyph type="chat" className="size-3.5" />
      </span>
    );
  return (
    <span aria-hidden className="grid size-6 shrink-0 place-items-center rounded-full bg-muted text-[9px] font-semibold text-muted-foreground outline-1 -outline-offset-1 outline-(--image-outline)">
      {initials(name)}
    </span>
  );
}

/** The width the body has, for the layout chosen by width. */
function useWidth(): [RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

/** Brings a change into view: at once, since stepping is done many times in a row. */
function bringIntoView(scroller: HTMLElement | null, row: number): void {
  scroller?.querySelector(`[data-row="${row}"]`)?.scrollIntoView({ block: "center", behavior: "instant" });
}

/**
 * A restore: on his own document written at once, the bar saying so with Undo (back to the version cut
 * just before it, which holds what was typed since); on a shared one, the review of the branch it made.
 */
async function restoreTo(target: HistoryVersion, actions: ReturnType<typeof historyActions>, shell: CanvasShell, set: (patch: Partial<HistoryState>) => void): Promise<void> {
  try {
    const done = await actions.restore(target.id);
    if (done.mode === "branch") return set({ view: "review", branchId: done.branchId, current: 0 });
    set({ view: "list" });
    const back = done.beforeVersionId;
    shell.written({ text: `Restored the ${dayTime(target.at)} version`, ...(back ? { undo: async () => void (await actions.restore(back)) } : {}) });
  } catch (err) {
    // A refused press is said once, as a toast: the state line is for a source that cannot be reached.
    sayError(err, "The restore did not go through");
  }
}

// ── the list ─────────────────────────────────────────────────────────

function VersionRow({ v, all, names, now, shared, picked, picking, onPick, onCompare, onRestore }: { v: HistoryVersion; all: readonly HistoryVersion[]; names: Record<string, string>; now: boolean; shared: boolean; picked: boolean; picking: boolean; onPick(): void; onCompare(): void; onRestore(): void }) {
  const who = whoWords(v.by, names);
  return (
    <div aria-selected={picked} className={cn("group/row relative flex min-h-[52px] items-center gap-3 rounded-lg p-2", picked ? "bg-muted" : "hover:bg-[color-mix(in_srgb,var(--foreground)_5%,transparent)]")}>
      <span className={cn("flex", !(picking || picked) && reveal("row", { row: true }))}>
        <Checkbox aria-label={`Pick the ${dayTime(v.at)} version`} checked={picked} onCheckedChange={onPick} />
      </span>
      <Face principal={v.by[0]} name={who} />
      <span className="flex min-w-0 grow flex-col gap-0.5">
        <span className={cn("truncate text-[13px] leading-5", now && "font-semibold")}>{who}</span>
        <span className="truncate text-xs leading-4 text-muted-foreground">{versionWords(v, all)}</span>
      </span>
      <span className="grid shrink-0 items-center justify-items-end text-xs text-muted-foreground tabular-nums">
        <span className={cn("[grid-area:1/1]", yields("row"))}>{dayTime(v.at)}</span>
        <span className={cn("flex gap-1 [grid-area:1/1]", reveal("row", { row: true, overlay: true }))}>
          <Button variant="ghost" size="xs" onClick={onCompare}>
            Compare
          </Button>
          {now ? null : (
            <Button variant="ghost" size="xs" onClick={onRestore}>
              {shared ? "Suggest restore" : "Restore"}
            </Button>
          )}
        </span>
      </span>
    </div>
  );
}

function BranchRow({ b, names, onOpen }: { b: HistoryBranch; names: Record<string, string>; onOpen(): void }) {
  const who = whoWords(b.authors, names);
  const n = b.diff.rows.length + Number(!!b.diff.page?.length);
  return (
    <ItemButton onClick={onOpen} className="min-h-[52px] flex-nowrap p-2 text-[13px] hover:bg-[color-mix(in_srgb,var(--foreground)_5%,transparent)]">
      <span className="w-4 shrink-0" />
      <Face principal={b.authors[0]} name={who} />
      <span className="flex min-w-0 grow flex-col gap-0.5">
        <span className="truncate text-[13px] leading-5">{b.label.startsWith("Restore") ? "Restore, waiting for you" : who}</span>
        <span className="truncate text-xs leading-4 text-muted-foreground">{n === 1 ? "1 change" : `${n} changes`}</span>
      </span>
      <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{dayTime(b.editedAt)}</span>
    </ItemButton>
  );
}

function ListSkeleton() {
  return (
    <div className="mx-auto flex max-w-[640px] flex-col gap-0.5 px-2 pt-2">
      {[38, 30, 44].map((w, i) => (
        <div key={i} className="flex min-h-[52px] items-center gap-3 p-2 ps-9">
          <Skeleton className="size-6 rounded-full" />
          <div className="flex grow flex-col gap-1.5">
            <Skeleton className="h-3.5" style={{ width: `${w}%` }} />
            <Skeleton className="h-3" style={{ width: `${w + 20}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
}

const Heading = ({ children, count }: { children: ReactNode; count: number }) => (
  <div className="flex items-baseline gap-2 px-2 pt-4 pb-1 text-[13px] font-semibold first:pt-2">
    {children}
    <span className="text-xs font-normal text-muted-foreground tabular-nums">{count}</span>
  </div>
);

function List({ env, source, state, setState, shell }: CanvasBodyProps<HistoryState>) {
  const versions = useVersions(env, source);
  const branches = useBranches(env, source);
  const actions = useMemo(() => historyActions(env, source), [env, source]);
  const picked = state?.picked ?? [];
  const set = (patch: Partial<HistoryState>) => setState({ ...state, ...patch });

  useEffect(() => {
    shell.statusLine(
      versions.error
        ? { tone: "failed", word: "History did not load", detail: versions.error, action: { label: "Retry", run: versions.retry } }
        : branches.error
          ? { tone: "failed", word: "Suggestions did not load", detail: branches.error, action: { label: "Retry", run: branches.retry } }
          : null,
    );
  }, [shell, versions.error, versions.retry, branches.error, branches.retry]);

  const v = versions.value;
  if (!v) return versions.error ? null : <ListSkeleton />;
  const pending = branches.value?.branches ?? [];
  if (v.versions.length === 0 && pending.length === 0) return <EmptyState title="No versions yet" />;
  const names = { ...v.names, ...branches.value?.names };
  const restore = (target: HistoryVersion) => restoreTo(target, actions, shell, set);
  return (
    <div className="mx-auto flex max-w-[640px] flex-col gap-0.5 px-2 pt-2 pb-8">
      {pending.length > 0 ? (
        <>
          <Heading count={pending.length}>Waiting for you</Heading>
          {pending.map((b) => (
            <BranchRow key={b.id} b={b} names={names} onOpen={() => set({ view: "review", branchId: b.id, current: 0 })} />
          ))}
          <Heading count={v.versions.length}>Versions</Heading>
        </>
      ) : null}
      {v.versions.map((ver, i) => (
        <VersionRow
          key={ver.id}
          v={ver}
          all={v.versions}
          names={names}
          now={i === 0}
          shared={v.shared}
          picked={picked.includes(ver.id)}
          picking={picked.length > 0}
          onPick={() => set({ picked: picked.includes(ver.id) ? picked.filter((id) => id !== ver.id) : [...picked, ver.id].slice(-2) })}
          onCompare={() => set({ view: "compare", from: ver.id, to: "live", current: 0, picked: [] })}
          onRestore={() => void restore(ver)}
        />
      ))}
    </div>
  );
}

// ── the compare and the review ───────────────────────────────────────

/** Too narrow for two sides of 420px: one column, whatever was chosen. 0 is a body not yet measured. */
const tooNarrow = (width: number): boolean => width > 0 && width < SIDE_BY_SIDE_FROM;

/** The layout shown: the person's choice where both sides fit, else side by side once there is room. */
export const layoutOf = (state: HistoryState | undefined, width: number): Layout => (tooNarrow(width) ? "one" : (state?.layout ?? (width >= SIDE_BY_SIDE_FROM ? "sxs" : "one")));

function useLayoutEntry(shell: CanvasShell, layout: Layout, set: (patch: Partial<HistoryState>) => void, extra: MoreEntry[], width: number) {
  const narrow = tooNarrow(width);
  useEffect(() => {
    shell.more?.([
      layout === "one"
        ? { id: "sxs", label: "Side by side", icon: PanelRight, disabled: narrow, run: () => set({ layout: "sxs" }) }
        : { id: "one", label: "One column", icon: FileText, run: () => set({ layout: "one" }) },
      ...extra,
    ]);
    return () => shell.more?.(null);
    // `set` and `extra` are rebuilt each render; the entries follow the layout, the room and the sides.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shell, layout, narrow, extra.map((e) => e.id).join()]);
}

function CompareView({ env, source, item, state, setState, shell }: CanvasBodyProps<HistoryState>) {
  const [ref, width] = useWidth();
  const from = state?.from ?? null;
  const to = state?.to ?? null;
  const compare = useCompare(env, source, from, to);
  const versions = useVersions(env, source);
  const layout = layoutOf(state, width);
  const set = (patch: Partial<HistoryState>) => setState({ ...state, ...patch });
  const current = state?.current ?? 0;
  const actions = useMemo(() => historyActions(env, source), [env, source]);
  const older = from && from !== "live" ? versions.value?.versions.find((v) => v.id === from) : undefined;
  useLayoutEntry(
    shell,
    layout,
    set,
    older
      ? [
          {
            id: "restore",
            label: "Restore the older version",
            icon: History,
            run: () => restoreTo(older, actions, shell, set),
          },
        ]
      : [],
    width,
  );
  // The diff's failure first; a diff drawn without its versions (no pickers, no names) says that on the same line.
  useEffect(() => {
    shell.statusLine(
      compare.error
        ? { tone: "failed", word: "The compare did not load", detail: compare.error, action: { label: "Retry", run: compare.retry } }
        : versions.error
          ? { tone: "failed", word: "The versions did not load", detail: versions.error, action: { label: "Retry", run: versions.retry } }
          : null,
    );
  }, [shell, compare.error, compare.retry, versions.error, versions.retry]);
  useEffect(() => bringIntoView(ref.current, current), [ref, current, layout, compare.value]);
  useEffect(() => {
    if (state?.shown !== layout) setState({ ...state, shown: layout });
  }, [layout, state, setState]);
  const diff = compare.value?.diff;
  const v = versions.value;
  return (
    <div ref={ref} className="flex min-h-full flex-col">
      {layout === "sxs" && v ? (
        // Side by side, each version is named over its own column.
        <div className="sticky top-0 z-10 grid h-7 grid-cols-2 border-b border-border bg-background text-xs text-muted-foreground">
          <div className="flex min-w-0 items-center px-2">
            <Picker label="Older" value={from ?? "live"} versions={v.versions} names={v.names} onPick={(id) => set({ from: id, current: 0 })} />
          </div>
          <div className="flex min-w-0 items-center border-s border-border px-2">
            <Picker label="Newer" value={to ?? "live"} versions={v.versions} names={v.names} onPick={(id) => set({ to: id, current: 0 })} />
          </div>
        </div>
      ) : null}
      {!diff ? (
        compare.error ? null : (
          <CompareSkeleton layout={layout} />
        )
      ) : diff.rows.length === 0 && !diff.page?.length ? (
        <Empty className="min-h-[240px]">
          <EmptyHeader>
            <EmptyTitle>No differences</EmptyTitle>
          </EmptyHeader>
        </Empty>
      ) : (
        <CompareDoc diff={diff} layout={layout} current={current} title={item.title} />
      )}
    </div>
  );
}

function ReviewView({ env, source, item, state, setState, shell }: CanvasBodyProps<HistoryState>) {
  const [ref, width] = useWidth();
  const branches = useBranches(env, source);
  const branch = branches.value?.branches.find((b) => b.id === state?.branchId) ?? null;
  const layout = layoutOf(state, width);
  const set = (patch: Partial<HistoryState>) => setState({ ...state, ...patch });
  const count = (branch?.diff.rows.length ?? 0) + Number(!!branch?.diff.page?.length);
  const current = Math.min(state?.current ?? 0, Math.max(0, count - 1));
  const actions = useMemo(() => historyActions(env, source), [env, source]);
  useLayoutEntry(shell, layout, set, [], width);
  useEffect(() => {
    shell.statusLine(branches.error ? { tone: "failed", word: "The suggestions did not load", detail: branches.error, action: { label: "Retry", run: branches.retry } } : null);
  }, [shell, branches.error, branches.retry]);
  // A branch that is done (accepted or rejected whole) leaves the list.
  useEffect(() => {
    if (branches.value && !branch) setState({ ...state, view: "list", branchId: undefined });
  }, [branches.value, branch, state, setState]);
  useEffect(() => {
    if (!branch) return shell.review(null);
    const rows = branch.diff.rows.map((row) => row.id);
    if (branch.diff.page?.length) rows.push(PAGE_CHANGE_ID);
    const decide = async (which: number | { group: string } | "all", accept: boolean) => {
      const ids = typeof which === "number" ? [rows[which]!] : "all";
      await actions.decide(branch.id, ids, accept, branch.editedAt);
    };
    shell.review({
      groups: [{ id: branch.id, label: branch.label.startsWith("Restore") ? "Restore" : whoWords(branch.authors, branches.value?.names ?? {}), by: (branch.authors[0] ?? "owner") as never, count: rows.length }],
      index: current,
      count: rows.length,
      step: (to) => set({ current: Math.max(0, Math.min(rows.length - 1, to)) }),
      accept: (which) => decide(which, true),
      reject: (which) => decide(which, false),
    });
    return () => shell.review(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shell, branch, current]);
  useEffect(() => bringIntoView(ref.current, current), [ref, current, layout, branch]);
  return (
    <div ref={ref} className="flex min-h-full flex-col">
      {branch ? <CompareDoc diff={branch.diff} layout={layout} current={current} title={item.title} /> : branches.error ? null : <CompareSkeleton layout={layout} />}
    </div>
  );
}

export function Body(props: CanvasBodyProps<HistoryState>) {
  const view = props.state?.view ?? "list";
  return (
    <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto">
      {view === "compare" ? <CompareView {...props} /> : view === "review" ? <ReviewView {...props} /> : <List {...props} />}
    </div>
  );
}

// ── the bar ──────────────────────────────────────────────────────────

function Picker({ value, versions, names, onPick, label }: { value: string; versions: readonly HistoryVersion[]; names: Record<string, string>; onPick(id: string): void; label: string }) {
  const shown = value === "live" ? "Now" : (() => {
    const v = versions.find((x) => x.id === value);
    return v ? dayTime(v.at) : "A version";
  })();
  return (
    <RowsMenu
      label={label}
      align="start"
      rows={[
        { kind: "item" as const, id: "live", label: "Now", checked: value === "live" },
        ...versions.map((v) => ({ kind: "item" as const, id: v.id, label: dayTime(v.at), hint: whoWords(v.by, names), checked: v.id === value })),
      ]}
      onPick={onPick}
      trigger={
        <Button variant="ghost" size="xs" className="shrink-0 font-normal text-muted-foreground tabular-nums">
          {shown}
          <ChevronDown />
        </Button>
      }
    />
  );
}

function Step({ label, disabled, onClick, children }: { label: string; disabled: boolean; onClick(): void; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<Button variant="ghost" size="icon-xs" aria-label={label} disabled={disabled} onClick={onClick} />}>{children}</TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

export function Bar({ env, source, state, setState }: CanvasBodyProps<HistoryState>) {
  const view = state?.view ?? "list";
  const versions = useVersions(env, source);
  const compare = useCompare(env, source, view === "compare" ? (state?.from ?? null) : null, view === "compare" ? (state?.to ?? null) : null);
  const branches = useBranches(env, source);
  const set = (patch: Partial<HistoryState>) => setState({ ...state, ...patch });
  const back = (
    <Button variant="ghost" size="xs" className="shrink-0 font-normal text-muted-foreground" onClick={() => set({ view: "list" })}>
      <History />
      History
    </Button>
  );
  if (view === "list") {
    const picked = state?.picked ?? [];
    const list = versions.value?.versions ?? [];
    // There from the first frame, so ticking a version never pushes the list down; waiting for two ticks. Gone only when there are not two versions to compare.
    if (versions.value && list.length < 2) return null;
    // The older of the two on the left.
    const [a, b] = [...picked].sort((x, y) => list.findIndex((v) => v.id === y) - list.findIndex((v) => v.id === x));
    return (
      <Button variant="secondary" size="xs" className="ms-auto" disabled={picked.length !== 2} onClick={() => set({ view: "compare", from: a, to: b, current: 0, picked: [] })}>
        Compare
      </Button>
    );
  }
  if (view === "review") {
    const branch = branches.value?.branches.find((b) => b.id === state?.branchId);
    const restoring = branch?.label.match(/^Restore (\d+)$/);
    const what = !branch ? null : restoring ? `Restoring the ${dayTime(Number(restoring[1]))} version` : `Suggested by ${whoWords(branch.authors, branches.value?.names ?? {})}`;
    return (
      <>
        {back}
        {what ? <span className="min-w-0 truncate">{what}</span> : null}
      </>
    );
  }
  const v = versions.value;
  const names = { ...v?.names, ...compare.value?.names };
  const rows = compare.value?.diff.rows ?? [];
  const count = rows.length + Number(!!compare.value?.diff.page?.length);
  const current = Math.min(state?.current ?? 0, Math.max(0, count - 1));
  const by = rows[current]?.by;
  return (
    <>
      {back}
      {v && state?.shown !== "sxs" ? (
        <span className="flex shrink-0 items-center gap-1">
          <Picker label="Older" value={state?.from ?? "live"} versions={v.versions} names={names} onPick={(id) => set({ from: id, current: 0 })} />
          <span>to</span>
          <Picker label="Newer" value={state?.to ?? "live"} versions={v.versions} names={names} onPick={(id) => set({ to: id, current: 0 })} />
        </span>
      ) : null}
      {count > 0 ? (
        <div role="toolbar" aria-label="Step through the changes" className="ms-auto flex min-w-0 items-center gap-1">
          {by?.length ? <span className="min-w-0 truncate pe-1">{whoWords(by, names)}</span> : null}
          <Step label="Previous change" disabled={current <= 0} onClick={() => set({ current: current - 1 })}>
            <ChevronLeft />
          </Step>
          <span className="min-w-6 text-center text-foreground tabular-nums select-none">
            {current + 1}/{count}
          </span>
          <Step label="Next change" disabled={current >= count - 1} onClick={() => set({ current: current + 1 })}>
            <ChevronRight />
          </Step>
        </div>
      ) : null}
    </>
  );
}
