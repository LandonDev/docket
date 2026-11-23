import { Component, memo, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { BusyLabel, Button } from "../../components/ui/button";
import { ItemButton } from "../../components/ui/item";
import { Skeleton } from "../../components/ui/skeleton";
import { StatusMark } from "../../components/ui/status";
import { useEnvironments } from "../../lib/connection";
import { cn } from "../../lib/cn";
import { EmptyState } from "../../surfaces/SurfaceSkeleton";
import type { WorkPlaceProps } from "../places/registry";
import { sectorName } from "../shell/actions";
import { reopenLifeos } from "../shell/lifeos";
import { openConnections } from "../shell/open";
import { useMinute } from "../tasks/minute";
import { useTodayEnv } from "./env";
import { HeldSheet } from "./HeldSheet";
import { page, type ShownSection, type TodayPage } from "./model";
import { openAddWorkspace } from "./open";
import { dropSource, fedOf, keepScroll, putAnswer, scrollOfToday, unfold, useTodayState } from "./store";
import { ROW_GRID, TITLE_EDGE, TodayRowView } from "./TodayRow";
import type { TodayEnv, TodayFailure, TodaySource } from "./types";

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
  const { env, reach, lifeosHost } = useTodayEnv();
  const state = useTodayState();
  const environments = useEnvironments();
  const model = useMemo(() => page(fedOf(state), { jobs: env.workspaces, lifeos: reach, folds: state.folds }), [state, env.workspaces, reach]);
  const hostName = (id: string): string => environments.find((e) => e.id === id)?.name ?? "A host";
  // He comes back to where he was: the scroll is kept with the folds.
  const scroller = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (scroller.current) scroller.current.scrollTop = scrollOfToday();
  }, []);
  return (
    <div ref={scroller} data-today onScroll={(event) => keepScroll(event.currentTarget.scrollTop)} className="flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto">
      {state.sources.map(({ id, source }) => (
        <SourceBoundary key={id} id={id}>
          <SourceRun source={source} env={env} />
        </SourceBoundary>
      ))}
      <TodayPageView model={model} hostName={hostName} hasFiles={state.sources.some((s) => s.source.section?.id === "files")} onRetryLifeos={lifeosHost ? () => reopenLifeos(lifeosHost, null) : undefined} />
      <HeldSheet />
    </div>
  );
}

/** One source, run as a hook of its own component, so one that throws takes only itself out. */
const SourceRun = memo(function SourceRun({ source, env }: { source: TodaySource; env: TodayEnv }) {
  // `use` is a hook under a method's name: the compiler must not cache the call as a plain one.
  "use no memo";
  const answer = source.use(env);
  // Before paint: the rows a source has at mount are in the first frame.
  useLayoutEffect(() => putAnswer(source.id, answer), [source.id, answer]);
  return null;
});

class SourceBoundary extends Component<{ id: string; children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }
  override componentDidCatch(error: unknown): void {
    dropSource(this.props.id, error);
  }
  override render(): ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}

/** The page drawn from its model: the preview and the tests hand it one. */
export function TodayPageView({
  model,
  hostName,
  hasFiles = false,
  onRetryLifeos,
}: {
  model: TodayPage;
  hostName: (environmentId: string) => string;
  /** The Files section is on the page, so an offline host's line names its files too. */
  hasFiles?: boolean;
  onRetryLifeos?: () => void | Promise<void>;
}) {
  if (model.kind === "no-jobs") return <EmptyState title="No jobs yet" line="Add a Work workspace to see its day here." action={{ label: "Add workspace", onClick: openAddWorkspace }} />;
  if (model.kind === "clear") return <EmptyState title="All clear" line="Nothing needs you today." />;
  return (
    <div className="mx-auto flex w-full max-w-[720px] flex-col px-6 py-6">
      {model.blocks.map((block) =>
        block.kind === "section" ? (
          <Section key={block.section.id} section={block.section} hostName={hostName} />
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

function Section({ section, hostName }: { section: ShownSection; hostName: (environmentId: string) => string }) {
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
        <div role="list" className="flex flex-col gap-0.5">
          {section.earlier > 0 ? <FoldLine label={`${section.earlier} earlier`} onOpen={() => unfold("earlier", section.id)} /> : null}
          {section.rows.map((row) => (
            <TodayRowView key={row.key} row={row} job={row.sector ? sectorName(row.sector) : null} />
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
    <ItemButton size="xs" aria-expanded={false} onClick={onOpen} className={cn("h-7 rounded-md border-0 py-0 pe-3 text-xs text-muted-foreground transition-none hover:bg-foreground/5 hover:text-foreground", TITLE_EDGE)}>
      {label}
    </ItemButton>
  );
}

/** A section that has never answered: three rows in the shape of what is coming. */
function Bones({ label }: { label: string }) {
  return (
    <div role="status" aria-label={`Loading ${label}`} aria-busy className="flex flex-col gap-0.5">
      {["w-1/2", "w-2/5", "w-3/5"].map((width) => (
        <div key={width} className={cn("min-h-8 items-center px-3 py-1.5", ROW_GRID)}>
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
