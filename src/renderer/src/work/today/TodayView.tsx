import { useEffect, useLayoutEffect, useMemo, useRef, useState, type FocusEvent, type KeyboardEvent } from "react";
import { BusyLabel, Button } from "../../components/ui/button";
import { ItemButton } from "../../components/ui/item";
import { Skeleton } from "../../components/ui/skeleton";
import { StatusMark } from "../../components/ui/status";
import { useRovingList } from "../../hooks/useRovingList";
import type { SectorKey } from "@shared/work";
import { useEnvironments } from "../../lib/connection";
import { cn } from "../../lib/cn";
import { registerToastAnchor } from "../../lib/toastAnchor";
import { EmptyState } from "../../surfaces/SurfaceSkeleton";
import type { WorkPlaceProps } from "../places/registry";
import { sectorName } from "../shell/actions";
import { openConnections } from "../shell/open";
import { useMinute } from "../tasks/minute";
import { useTodayEnv } from "./env";
import { HeldSheet } from "./HeldSheet";
import { foldKey, foldOf, page, type ShownSection, type TodayPage } from "./model";
import { openAddWorkspace } from "./open";
import { TIMED_OUT } from "./read";
import { fedOf, focusOfToday, keepFocus, keepScroll, scrollOfToday, unfold, useTodayState } from "./store";
import { ROW_GRID, ROW_SLOT, TITLE_EDGE, TODAY_COLUMN, TODAY_INSET, TodayRowSlot, type RowPhase } from "./TodayRow";
import type { TodayFailure, TodaySection } from "./types";
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
  // A job has one name everywhere: its workspace's, as the rail and the held sheet say it.
  const jobName = (sector: SectorKey): string => env.workspaceOf(sector)?.name ?? sectorName(sector);
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
        jobName={jobName}
        onRetryLifeos={retryLifeos}
        leaving={state.leaving}
        closing={state.closing}
        sheetOpen={state.held !== null}
        landsOnOpen
      />
      <HeldSheet />
    </div>
  );
}

const NO_KEYS: ReadonlySet<string> = new Set();

/**
 * The page drawn from its model: the preview and the tests hand it one.
 * Every row on it, and every fold line between them, is one list to the
 * keyboard, in page order: one tab stop, ↑ ↓ Home End move, Enter opens the
 * row or the fold, Space ticks a task. When the page opens, focus lands
 * where it was when he left, else on the first row.
 */
export function TodayPageView({
  model,
  hostName,
  jobName = sectorName,
  onRetryLifeos,
  leaving = NO_KEYS,
  closing = NO_KEYS,
  sheetOpen = false,
  landsOnOpen = false,
}: {
  model: TodayPage;
  hostName: (environmentId: string) => string;
  /** A row's job, as the rail names it. */
  jobName?: (sector: SectorKey) => string;
  onRetryLifeos?: (() => void | Promise<void>) | undefined;
  /** Rows on their way out by his own act: fading, then their place closing. */
  leaving?: ReadonlySet<string>;
  closing?: ReadonlySet<string>;
  /** The held sheet is over the page: the toasts go back to the window's corner, behind it, as under any sheet. */
  sheetOpen?: boolean;
  /** The live page: focus lands when the page first has a row, and where it stands is kept for his return. */
  landsOnOpen?: boolean;
}) {
  const shown = model.kind === "day" ? model.keys : NONE;
  // A row on its way out is no longer one the arrows stop on.
  const keys = useMemo(() => (leaving.size || closing.size ? shown.filter((key) => !leaving.has(key) && !closing.has(key)) : shown), [shown, leaving, closing]);
  const [focused, setFocused] = useState<string | null>(() => (landsOnOpen ? focusOfToday() : null));
  const roving = useRovingList<HTMLDivElement>({ keys, selected: focused, onSelect: setFocused });
  const stop = focused !== null && keys.includes(focused) ? focused : (keys[0] ?? null);
  const focusRow = (key: string): void => roving.listRef.current?.querySelector<HTMLElement>(`[data-roving-key="${CSS.escape(key)}"]`)?.focus({ preventScroll: true });
  // The page opened: focus lands where it stood when he left, else on the first row; once, unless he is already somewhere in it.
  const landed = useRef(!landsOnOpen);
  useEffect(() => {
    if (landed.current || stop === null) return;
    landed.current = true;
    const at = document.activeElement;
    if (!at || at === document.body || !roving.listRef.current?.contains(at)) focusRow(stop);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, when the first row is there
  }, [stop === null]);
  useEffect(() => {
    if (landsOnOpen && focused !== null) keepFocus(focused);
  }, [landsOnOpen, focused]);
  // The stop the arrows were on is gone. A fold he opened hands its focus to the first row it showed; a row that left
  // by his own act hands it to the row that takes its place.
  const order = useRef(shown);
  useEffect(() => {
    const before = order.current;
    order.current = shown;
    if (focused === null || keys.includes(focused)) return;
    const was = new Set(before);
    const at = before.indexOf(focused);
    const next =
      (foldOf(focused) ? keys.find((key) => !was.has(key)) : undefined) ??
      [...before.slice(at + 1), ...before.slice(0, Math.max(0, at)).reverse()].find((key) => keys.includes(key)) ??
      keys[0] ??
      null;
    setFocused(next);
    const on = document.activeElement;
    if (next && (!on || on === document.body)) focusRow(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- when the stops change under the focus
  }, [keys]);
  if (model.kind === "no-jobs") return <EmptyState title="No jobs yet" line="Add a Work workspace to see its day here." action={{ label: "Add workspace", onClick: openAddWorkspace }} />;
  if (model.kind === "clear") return <EmptyState title="All clear" line={model.line ?? "Nothing needs you today."} />;
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if ((event.target as HTMLElement).hasAttribute("data-roving-key")) roving.onRowKeyDown(event);
  };
  const onFocus = (event: FocusEvent<HTMLDivElement>): void => {
    const at = event.target as HTMLElement;
    const key = at.closest("[data-today-row]")?.getAttribute("data-today-row") ?? at.getAttribute("data-roving-key");
    if (key && key !== focused) setFocused(key);
  };
  const phaseOf = (key: string): RowPhase => (closing.has(key) ? "closing" : leaving.has(key) ? "leaving" : undefined);
  return (
    <div className={cn("flex flex-1 flex-col", TODAY_COLUMN)}>
      <div ref={roving.listRef} onKeyDown={onKeyDown} onFocus={onFocus} className={cn("flex flex-col py-6", TODAY_INSET)}>
      {model.blocks.map((block) =>
        block.kind === "section" ? (
          <Section key={block.section.id} section={block.section} hostName={hostName} jobName={jobName} phaseOf={phaseOf} stop={stop} />
        ) : (
          <div key="lifeos" data-today-lifeos={block.reach} className="mt-6 first:mt-0">
            {block.reach === "signed-out" ? (
              <PageLine word="Not signed in to LifeOS" action={{ label: "Sign in", run: openConnections }} />
            ) : (
              <PageLine failed word="LifeOS did not answer" action={onRetryLifeos ? { label: "Retry", run: onRetryLifeos } : undefined} />
            )}
          </div>
        ),
      )}
      {model.offline.length > 0 ? (
        <div className="mt-6 flex flex-col gap-1 px-3 text-xs leading-4 text-muted-foreground">
          {model.offline.map((id) => (
            <p key={id} data-today-offline={id}>
              {hostName(id)} is offline.
            </p>
          ))}
        </div>
      ) : null}
      </div>
      {/* Where a toast sits (lib/toastAnchor.ts): at the page's foot over the titles, clear of the ticks before them and
          the verbs after. In a narrow column there is no such room, and it takes the row's width. Not while the held
          sheet is open: a sheet lies over the toasts, and one seated here would show cut by its edge. */}
      <div aria-hidden className="pointer-events-none sticky bottom-0 mt-auto">
        <div className={TODAY_INSET}>
          <div className={cn("px-3", ROW_GRID)}>
            <span />
            <span ref={sheetOpen ? undefined : registerToastAnchor} data-today-toasts className="h-0 @max-[30rem]/today:col-span-3" />
          </div>
        </div>
      </div>
    </div>
  );
}

const NONE: string[] = [];

function Section({
  section,
  hostName,
  jobName,
  phaseOf,
  stop,
}: {
  section: ShownSection;
  hostName: (environmentId: string) => string;
  jobName: (sector: SectorKey) => string;
  phaseOf: (key: string) => RowPhase;
  stop: string | null;
}) {
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
        <Bones label={section.title} shape={section.bones} />
      ) : section.state === "empty" ? (
        unknown || !section.empty ? null : <p className={cn("flex h-8 items-center pe-3 text-[13px] text-muted-foreground", TITLE_EDGE)}>{section.empty}</p>
      ) : (
        // Each row carries the 2px under it, and the list gives the last one's back.
        <div role="list" className="-mb-0.5 flex flex-col">
          {section.earlier > 0 ? <FoldLine which="earlier" section={section.id} label={`${section.earlier} earlier`} stop={stop} /> : null}
          {section.rows.map((row) => (
            <TodayRowSlot key={row.key} row={row} job={row.sector ? jobName(row.sector) : null} phase={phaseOf(row.key)} lands={lands(row.key)} current={row.key === stop} />
          ))}
          {section.more > 0 ? <FoldLine which="more" section={section.id} label={`${section.more} more`} stop={stop} /> : null}
        </div>
      )}
      {section.note ? <p className={cn("flex min-h-8 items-center pe-3 text-[13px] text-muted-foreground", TITLE_EDGE)}>{section.note}</p> : null}
    </section>
  );
}

/**
 * "4 more", "2 earlier": one muted line on the titles' edge that unfolds its
 * rows in place. It is a stop of the page's one list, in its place among
 * the rows, so the arrows reach it and Enter opens it.
 */
function FoldLine({ which, section, label, stop }: { which: "more" | "earlier"; section: string; label: string; stop: string | null }) {
  const key = foldKey(which, section);
  return (
    <div className={ROW_SLOT}>
      <ItemButton
        size="xs"
        aria-expanded={false}
        data-roving-key={key}
        tabIndex={key === stop ? 0 : -1}
        onClick={() => unfold(which, section)}
        className={cn("h-7 rounded-md border-0 py-0 pe-3 text-xs text-muted-foreground transition-none hover:bg-foreground/5 hover:text-foreground", TITLE_EDGE)}
      >
        {label}
      </ItemButton>
    </div>
  );
}

/** A section that has never answered: three rows in the shape of what is coming, so nothing under it moves when it answers. */
function Bones({ label, shape }: { label: string; shape?: TodaySection["bones"] }) {
  return (
    <div role="status" aria-label={`Loading ${label}`} aria-busy className="-mb-0.5 flex flex-col">
      {["w-1/2", "w-2/5", "w-3/5"].map((width) => (
        <div key={width} data-today-bone={shape ?? "line"} className={cn("mb-0.5 items-start px-3 py-1.5", ROW_GRID)}>
          <span className="flex h-5 items-center justify-center">{shape === "tick" ? <Skeleton className="size-4 rounded-full" /> : null}</span>
          <span className="flex min-w-0 flex-col">
            <span className="flex h-5 items-center">
              <Skeleton className={cn("h-3.5", width)} />
            </span>
            {shape === "lines" ? (
              <span className="flex h-4 items-center">
                <Skeleton className="h-3 w-1/3" />
              </span>
            ) : null}
          </span>
          <span className="flex h-5 items-center">
            <Skeleton className="h-3 w-14" />
          </span>
          <span className="flex h-5 items-center justify-end">
            <Skeleton className="h-3 w-12" />
          </span>
        </div>
      ))}
    </div>
  );
}

/**
 * A read that did not come back, said in the section it feeds. "Did not
 * answer" is the wait running out; any other cause is said beside it, and a
 * read the host is not at fault for has its own words (`said`).
 */
function HostLine({ failure, name }: { failure: TodayFailure; name: string }) {
  const detail = failure.said || failure.error === TIMED_OUT ? undefined : failure.error;
  return <PageLine failed word={failure.said ?? `${name} did not answer`} detail={detail} action={failure.retry ? { label: "Retry", run: failure.retry } : undefined} />;
}

/**
 * The state line's shape inside the column (docs/DESIGN.md "The state
 * line"), on the rows' own grid: 32px, the failed mark in the lead, the
 * words on the titles' edge with a muted detail, one action whose label
 * ends on the facts' edge. A fault leads with the mark; a sign-in that is
 * only missing is plain muted words.
 */
function PageLine({ word, detail, failed = false, action }: { word: string; detail?: string; failed?: boolean; action?: { label: string; run: () => void | Promise<void> } }) {
  const [running, setRunning] = useState(false);
  return (
    <div data-view-state={failed ? "failed" : "needs"} role="status" className={cn("min-h-8 items-center px-3 leading-5", ROW_GRID)}>
      <span className="flex h-5 items-center justify-center">{failed ? <StatusMark state="failed" word={false} aria-hidden /> : null}</span>
      {failed ? <StatusMark state="failed" glyph={false} word={word} detail={detail} className="min-w-0" /> : <span className="min-w-0 truncate text-xs text-muted-foreground">{word}</span>}
      <span className="col-span-2 flex justify-end">
        {action ? (
          <Button
            variant="ghost"
            size="xs"
            // The label, not the button's box, ends on the facts' edge.
            className="-me-2"
            disabled={running}
            onClick={() => {
              setRunning(true);
              void Promise.resolve(action.run())
                .catch(() => {})
                .finally(() => setRunning(false));
            }}
          >
            <BusyLabel busy={running} label={action.label} align="end" />
          </Button>
        ) : null}
      </span>
    </div>
  );
}
