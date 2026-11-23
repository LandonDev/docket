import { useEffect, useLayoutEffect, useMemo, useRef, useState, type FocusEvent, type KeyboardEvent } from "react";
import { BusyLabel, Button } from "../../components/ui/button";
import { ItemButton } from "../../components/ui/item";
import { Skeleton } from "../../components/ui/skeleton";
import { StatusMark } from "../../components/ui/status";
import { useRovingList } from "../../hooks/useRovingList";
import { useEnvironments } from "../../lib/connection";
import { cn } from "../../lib/cn";
import { EmptyState } from "../../surfaces/SurfaceSkeleton";
import type { WorkPlaceProps } from "../places/registry";
import { sectorName } from "../shell/actions";
import { openConnections } from "../shell/open";
import { useMinute } from "../tasks/minute";
import { useTodayEnv } from "./env";
import { HeldSheet } from "./HeldSheet";
import { page, type ShownSection, type TodayPage } from "./model";
import { openAddWorkspace } from "./open";
import { fedOf, keepScroll, scrollOfToday, unfold, useTodayState } from "./store";
import { ROW_GRID, ROW_SLOT, TITLE_EDGE, TodayRowSlot, type RowPhase } from "./TodayRow";
import type { TodayFailure } from "./types";
import { noteOpened, pageOpen, SourceRuns } from "./warm";

/**
 * Today (docs/DESIGN.md "Today", docs/agents/work-today.md): one column
 * under the place's header that lists, for every job on every host, what
 * waits on his press, today's meetings, what is due, mail no one answered
 * and files others changed. Each section is a source (sources.ts); the page
 * merges what they answer (model.ts) and draws it. Nothing waits for the
 * whole page: a section that has never answered draws its own bones.
 */

const dateLine = new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric" });

/** The header's end: the date, which turns at midnight. */
export function Head(_props: WorkPlaceProps) {
  const now = useMinute();
  return <time className="text-xs tabular-nums text-muted-foreground">{dateLine.format(now)}</time>;
}

export function View(_props: WorkPlaceProps) {
  const { env, reach, retryLifeos } = useTodayEnv();
  const state = useTodayState();
  const environments = useEnvironments();
  const model = useMemo(() => page(fedOf(state), { jobs: env.workspaces, lifeos: reach, folds: state.folds, gone: state.gone }), [state, env.workspaces, reach]);
  const hostName = (id: string): string => environments.find((e) => e.id === id)?.name ?? "A host";
  // He comes back to where he was: the scroll is kept with the folds. The scroller keeps its strip, so the column
  // does not move when the list first overflows or a sheet takes the pointer.
  const scroller = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (scroller.current) scroller.current.scrollTop = scrollOfToday();
  }, []);
  // While it is open the page runs its sources itself; closed, they run on for ten minutes (warm.tsx).
  useLayoutEffect(() => {
    pageOpen(true);
    noteOpened();
    return () => pageOpen(false);
  }, []);
  return (
    <div ref={scroller} data-today onScroll={(event) => keepScroll(event.currentTarget.scrollTop)} className="flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto [scrollbar-gutter:stable]">
      <SourceRuns env={env} />
      <TodayPageView
        model={model}
        hostName={hostName}
        hasFiles={state.sources.some((s) => s.source.section?.id === "files")}
        onRetryLifeos={retryLifeos}
        leaving={state.leaving}
        closing={state.closing}
        landsOnOpen
      />
      <HeldSheet />
    </div>
  );
}

const NO_KEYS: ReadonlySet<string> = new Set();

/**
 * The page drawn from its model: the preview and the tests hand it one.
 * Every row on it is one list to the keyboard, in page order: one tab stop,
 * ↑ ↓ Home End move, Enter opens the row, Space ticks a task. When the page
 * opens, focus lands on its first row.
 */
export function TodayPageView({
  model,
  hostName,
  hasFiles = false,
  onRetryLifeos,
  leaving = NO_KEYS,
  closing = NO_KEYS,
  landsOnOpen = false,
}: {
  model: TodayPage;
  hostName: (environmentId: string) => string;
  /** The Files section is on the page, so an offline host's line names its files too. */
  hasFiles?: boolean;
  onRetryLifeos?: (() => void | Promise<void>) | undefined;
  /** Rows on their way out by his own act: fading, then their place closing. */
  leaving?: ReadonlySet<string>;
  closing?: ReadonlySet<string>;
  /** Focus lands on the first row when the page first has one. */
  landsOnOpen?: boolean;
}) {
  const shown = model.kind === "day" ? model.keys : NONE;
  // A row on its way out is no longer one the arrows stop on.
  const keys = useMemo(() => (leaving.size || closing.size ? shown.filter((key) => !leaving.has(key) && !closing.has(key)) : shown), [shown, leaving, closing]);
  const [focused, setFocused] = useState<string | null>(null);
  const roving = useRovingList<HTMLDivElement>({ keys, selected: focused, onSelect: setFocused });
  const stop = focused !== null && keys.includes(focused) ? focused : (keys[0] ?? null);
  const focusRow = (key: string): void => roving.listRef.current?.querySelector<HTMLElement>(`[data-roving-key="${CSS.escape(key)}"]`)?.focus({ preventScroll: true });
  // The page opened: focus lands on the first row, once, unless he is already somewhere in it.
  const landed = useRef(!landsOnOpen);
  const first = keys[0];
  useEffect(() => {
    if (landed.current || first === undefined) return;
    landed.current = true;
    const at = document.activeElement;
    if (!at || at === document.body || !roving.listRef.current?.contains(at)) focusRow(first);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, when the first row is there
  }, [first]);
  // The row the arrows were on left by his own act: the row that takes its place takes the focus it dropped.
  const order = useRef(shown);
  useEffect(() => {
    const before = order.current;
    order.current = shown;
    if (focused === null || keys.includes(focused)) return;
    const next = [...before.slice(before.indexOf(focused) + 1), ...before.slice(0, Math.max(0, before.indexOf(focused))).reverse()].find((key) => keys.includes(key)) ?? keys[0] ?? null;
    setFocused(next);
    const at = document.activeElement;
    if (next && (!at || at === document.body)) focusRow(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- when the rows change under the focus
  }, [keys]);
  if (model.kind === "no-jobs") return <EmptyState title="No jobs yet" line="Add a Work workspace to see its day here." action={{ label: "Add workspace", onClick: openAddWorkspace }} />;
  if (model.kind === "clear") return <EmptyState title="All clear" line="Nothing needs you today." />;
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if ((event.target as HTMLElement).hasAttribute("data-row-open")) roving.onRowKeyDown(event);
  };
  const onFocus = (event: FocusEvent<HTMLDivElement>): void => {
    const key = (event.target as HTMLElement).closest("[data-today-row]")?.getAttribute("data-today-row");
    if (key && key !== focused) setFocused(key);
  };
  const phaseOf = (key: string): RowPhase => (closing.has(key) ? "closing" : leaving.has(key) ? "leaving" : undefined);
  return (
    <div ref={roving.listRef} onKeyDown={onKeyDown} onFocus={onFocus} className="mx-auto flex w-full max-w-[720px] flex-col px-6 py-6">
      {model.blocks.map((block) =>
        block.kind === "section" ? (
          <Section key={block.section.id} section={block.section} hostName={hostName} phaseOf={phaseOf} stop={stop} />
        ) : (
          <div key="lifeos" data-today-lifeos={block.reach} className="mt-6 first:mt-0">
            {block.reach === "signed-out" ? (
              <StateLine word="Not signed in to LifeOS" action={{ label: "Sign in", run: openConnections }} />
            ) : (
              <StateLine failed word="LifeOS did not answer" action={onRetryLifeos ? { label: "Retry", run: onRetryLifeos } : undefined} />
            )}
          </div>
        ),
      )}
      {model.offline.length > 0 ? (
        <div className="mt-6 flex flex-col gap-1 px-3 text-xs leading-4 text-muted-foreground">
          {model.offline.map((id) => (
            <p key={id} data-today-offline={id}>
              {hostName(id)} is offline. Its {hasFiles ? "held items and files" : "held items"} show when it is back.
            </p>
          ))}
        </div>
      ) : null}
    </div>
  );
}

const NONE: string[] = [];

function Section({ section, hostName, phaseOf, stop }: { section: ShownSection; hostName: (environmentId: string) => string; phaseOf: (key: string) => RowPhase; stop: string | null }) {
  // The rows the list began with, and those his own unfold showed, stand at once; one that arrives while he looks lands.
  // A box of the section's own, read and written while it renders.
  "use no memo";
  const [known] = useState<{ keys: Set<string> | null; folded: number }>(() => ({ keys: null, folded: 0 }));
  const folded = section.more + section.earlier;
  if (section.state !== "rows") known.keys = null;
  else if (known.keys === null || folded < known.folded) known.keys = new Set(section.rows.map((row) => row.key));
  known.folded = folded;
  const lands = (key: string): boolean => known.keys !== null && !known.keys.has(key);
  // A host that did not answer is said, and the section never says "nothing" beside it.
  const unknown = section.failed.length > 0 && section.state !== "rows";
  return (
    <section aria-label={section.title} data-today-section={section.id} className="mt-6 flex flex-col first:mt-0">
      <h2 className="flex h-7 items-center px-3 text-xs font-medium text-muted-foreground">{section.title}</h2>
      {section.failed.map((failure) => (
        <HostLine key={failure.environmentId} failure={failure} name={hostName(failure.environmentId)} />
      ))}
      {section.state === "bones" ? (
        <Bones label={section.title} />
      ) : section.state === "empty" ? (
        unknown || !section.empty ? null : <p className={cn("flex h-8 items-center pe-3 text-[13px] text-muted-foreground", TITLE_EDGE)}>{section.empty}</p>
      ) : (
        // Each row carries the 2px under it, and the list gives the last one's back.
        <div role="list" className="-mb-0.5 flex flex-col">
          {section.earlier > 0 ? <FoldLine label={`${section.earlier} earlier`} onOpen={() => unfold("earlier", section.id)} /> : null}
          {section.rows.map((row) => (
            <TodayRowSlot key={row.key} row={row} job={row.sector ? sectorName(row.sector) : null} phase={phaseOf(row.key)} lands={lands(row.key)} current={row.key === stop} />
          ))}
          {section.more > 0 ? <FoldLine label={`${section.more} more`} onOpen={() => unfold("more", section.id)} /> : null}
        </div>
      )}
      {section.note ? <p className={cn("flex min-h-7 items-center pe-3 text-xs text-muted-foreground", TITLE_EDGE)}>{section.note}</p> : null}
    </section>
  );
}

/** "4 more", "2 earlier": one muted line on the titles' edge that unfolds its rows in place. */
function FoldLine({ label, onOpen }: { label: string; onOpen: () => void }) {
  return (
    <div className={ROW_SLOT}>
      <ItemButton size="xs" aria-expanded={false} onClick={onOpen} className={cn("h-7 rounded-md border-0 py-0 pe-3 text-xs text-muted-foreground transition-none hover:bg-foreground/5 hover:text-foreground", TITLE_EDGE)}>
        {label}
      </ItemButton>
    </div>
  );
}

/** A section that has never answered: three rows in the shape of what is coming. */
function Bones({ label }: { label: string }) {
  return (
    <div role="status" aria-label={`Loading ${label}`} aria-busy className="-mb-0.5 flex flex-col">
      {["w-1/2", "w-2/5", "w-3/5"].map((width) => (
        <div key={width} className={cn("mb-0.5 min-h-8 items-center px-3 py-1.5", ROW_GRID)}>
          <span />
          <Skeleton className={cn("h-3.5", width)} />
          <Skeleton className="h-3 w-14" />
          <Skeleton className="h-3 w-12 justify-self-end" />
        </div>
      ))}
    </div>
  );
}

/** A host that did not answer a section in time, with its Retry. */
function HostLine({ failure, name }: { failure: TodayFailure; name: string }) {
  return <StateLine failed word={`${name} did not answer`} detail={failure.error} action={failure.retry ? { label: "Retry", run: failure.retry } : undefined} />;
}

/**
 * The state line's shape inside the column (docs/DESIGN.md "The state
 * line"): 32px, the word, a muted detail, one action. A fault leads with
 * the failed mark; a sign-in that is only missing is plain muted words.
 */
function StateLine({ word, detail, failed = false, action }: { word: string; detail?: string; failed?: boolean; action?: { label: string; run: () => void | Promise<void> } }) {
  const [running, setRunning] = useState(false);
  return (
    <div data-view-state={failed ? "failed" : "needs"} role="status" className="flex min-h-8 min-w-0 items-center gap-2 px-3 text-[13px] leading-5">
      {failed ? <StatusMark state="failed" word={word} detail={detail} className="min-w-0 flex-1" /> : <span className="min-w-0 flex-1 truncate text-muted-foreground">{word}</span>}
      {action ? (
        <Button
          variant="ghost"
          size="xs"
          disabled={running}
          onClick={() => {
            setRunning(true);
            void Promise.resolve(action.run())
              .catch(() => {})
              .finally(() => setRunning(false));
          }}
        >
          <BusyLabel busy={running} label={action.label} />
        </Button>
      ) : null}
    </div>
  );
}
