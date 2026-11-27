import { memo, useCallback, useMemo, useState, useSyncExternalStore, type ComponentType } from "react";
import type { SectorKey } from "@shared/work";
import { unsaidWait, waitsOnHim, type TrackerThread } from "@shared/work/tracker";
import { dueTone, ProjectFactsBones, ProjectFactsFold, ProjectFactsHeader, ProjectFactsRow, ProjectFactsTable } from "work-kit/projects";
import "work-kit/projects/styles.css";
import "../projects/projects.css";
import { Plus } from "../../chrome/icons";
import { SectorDot } from "../../chrome/WorkspaceGlyph";
import { Tip } from "../../components/tip";
import { BusyLabel, Button } from "../../components/ui/button";
import { reveal } from "../../components/ui/reveal";
import { Toggle } from "../../components/ui/toggle";
import { cn } from "../../lib/cn";
import { useMinuteClock } from "../../lib/turnClock";
import { DownLine } from "../shell/DownLine";
import { useLifeosSession } from "../shell/lifeos";
import { downOf } from "../shell/lifeosDown";
import { OutcomeMark } from "../threads/mark";
import type { WorkPlaceProps } from "../places/registry";
import { useTracker, type MergedJob, type MergedProject } from "./data";
import { openNewProject, openProjectPage, openTrackerThread } from "./open";
import { KitWaits } from "../kitWaits";

/**
 * The Projects place (docs/agents/work-tracker.md "The page", docs/DESIGN.md "The tracker"): every job's open
 * projects, a group a job (its dot and name), one row a project with the facts a decision needs (Next, Waiting on,
 * Threads, Done, Target), drawn with work-kit's own row parts, so a row here is a row of the job's Projects list. Rows
 * stand by target date and never move because their work did; paused and backlog fold under each job. One filter,
 * Waiting on you, in the header. A lazy chunk of its own (work/places/registry.ts), never in the first paint.
 */

// ── the filter, shared by the header and the page, kept for the window's life ──

let waitingOnly = false;
const filterListeners = new Set<() => void>();
const subscribeFilter = (listener: () => void): (() => void) => (filterListeners.add(listener), () => void filterListeners.delete(listener));
export function setWaitingOnly(next: boolean): void {
  if (waitingOnly === next) return;
  waitingOnly = next;
  for (const listener of filterListeners) listener();
}
export const useWaitingOnly = (): boolean => useSyncExternalStore(subscribeFilter, () => waitingOnly, () => waitingOnly);

/** The header's end: the one filter, a quiet toggle with its hairline, so at rest it reads as a press (docs/DESIGN.md: nothing beside the page's name). */
export function Head(_props: WorkPlaceProps) {
  const on = useWaitingOnly();
  return (
    <Toggle variant="outline" size="sm" className="px-2 font-normal" pressed={on} onPressedChange={setWaitingOnly}>
      Waiting on you
    </Toggle>
  );
}

export function View(_props: WorkPlaceProps) {
  const { jobs, loading, errors, pending, reload } = useTracker();
  return <TrackerBody jobs={jobs} loading={loading} errors={errors} pending={pending} waitingOnly={useWaitingOnly()} onRetry={reload} />;
}

/** The paused-and-backlog fold a job, kept for the window's life. */
const RESTING = new Map<string, boolean>();
/** Every fold closed again (tests). */
export const resetTrackerFolds = (): void => RESTING.clear();

/** "1 paused, 2 in backlog". */
export const restWords = (rest: readonly Pick<MergedProject, "state">[]): string => {
  const paused = rest.filter((p) => p.state === "paused").length;
  const backlog = rest.filter((p) => p.state === "backlog").length;
  return [paused ? `${paused} paused` : null, backlog ? `${backlog} in backlog` : null].filter(Boolean).join(", ");
};

export type TrackerBodyProps = {
  jobs: readonly MergedJob[];
  loading: boolean;
  /** hosts with Work on that did not answer or are not linked, a sentence each: the page says no all-clear while any is */
  errors: readonly string[];
  /** a host has not answered yet (a visit opened on kept answers): no all-clear until it has */
  pending?: boolean;
  waitingOnly: boolean;
  onRetry: () => void | Promise<void>;
  /** the minute the due words and ages are reckoned at; left out, now and each minute after */
  now?: number;
  /** a job no host could read, in its group's place (a preview draws it with no host to ask) */
  Down?: ComponentType<{ job: MergedJob; onRetry: () => void | Promise<void> }>;
};

/** The page from what the hosts answered: a preview and a test hand it jobs. */
export function TrackerBody({ jobs, loading, errors, pending = false, waitingOnly, onRetry, now: fixed, Down = DownJob }: TrackerBodyProps) {
  // The minute, so a due date turns late and an age grows while the page stands: the window's one minute clock.
  const minute = useMinuteClock(fixed === undefined);
  const now = fixed ?? minute;
  // Under the filter a job shows only what waits on him; one with none goes, a job LifeOS could not read stays (it may).
  const shown = waitingOnly ? jobs.filter((job) => job.down || job.projects.some(waitsOnHim)) : jobs;
  return (
    <KitWaits>
      <div className="tc-projects h-full min-h-0 overflow-x-hidden overflow-y-auto">
        <ProjectFactsTable threads className="mx-auto w-full max-w-(--pk-list-column) px-2 pt-4 pb-10">
          {errors.map((words) => (
            <p key={words} data-host-silent className="mx-2 flex min-h-8 items-center px-2 text-(length:--pk-meta) text-muted-foreground">
              {words}
            </p>
          ))}
          {/* Bones while it reads, and while a pending host leaves the page empty: it says nothing until it knows. */}
          {loading || (pending && shown.length === 0) ? (
            <>
              <ProjectFactsHeader threads />
              <ProjectFactsBones rows={6} />
            </>
          ) : shown.length === 0 ? (
            // An all-clear only when every host answered: a host missing may hold the job that waits.
            errors.length || pending ? null : <p className="mx-2 flex min-h-8 items-center px-2 text-(length:--pk-text) text-muted-foreground">{waitingOnly ? "Nothing waits on you" : "No jobs yet"}</p>
          ) : (
            <>
              <ProjectFactsHeader threads />
              {shown.map((job) => (
                <JobGroup key={job.sector} job={job} waitingOnly={waitingOnly} now={now} onRetry={onRetry} Down={Down} />
              ))}
            </>
          )}
        </ProjectFactsTable>
      </div>
    </KitWaits>
  );
}

function JobGroup({ job, waitingOnly, now, onRetry, Down }: { job: MergedJob; waitingOnly: boolean; now: number; onRetry: () => void | Promise<void>; Down: NonNullable<TrackerBodyProps["Down"]> }) {
  const [resting, setResting] = useState(() => RESTING.get(job.sector) ?? false);
  const active = useMemo(() => job.projects.filter((p) => p.state === "active"), [job.projects]);
  const rest = useMemo(() => job.projects.filter((p) => p.state !== "active"), [job.projects]);
  const waiting = useMemo(() => job.projects.filter(waitsOnHim), [job.projects]);
  const empty = !job.down && job.projects.length === 0;
  const toggle = (): void =>
    setResting((was) => {
      RESTING.set(job.sector, !was);
      return !was;
    });
  const row = (project: MergedProject) => <TrackerRow key={project.id} project={project} workspaceId={job.at.workspaceId} now={now} waitingOnly={waitingOnly} />;
  return (
    <section aria-label={job.name} data-job={job.sector} className="mt-3 first-of-type:mt-1">
      <h2 className="group/item relative mx-2 flex h-8 items-center px-2 text-(length:--pk-text) text-muted-foreground">
        {/* The dot hangs in the gutter, so the job's name starts where its projects' names do. */}
        <SectorDot sector={job.sector} className="absolute -start-3" />
        <span className="min-w-0 truncate">{job.name}</span>
        {empty || job.down ? null : (
          <span className={cn("ms-auto flex", reveal("item"))}>
            <Tip label={`New project in ${job.name}`}>
              <Button variant="ghost" size="icon-xs" aria-label={`New project in ${job.name}`} onClick={() => openNewProject(job.at.workspaceId)}>
                <Plus />
              </Button>
            </Tip>
          </span>
        )}
      </h2>
      {job.down ? (
        <Down job={job} onRetry={onRetry} />
      ) : empty ? (
        <Button variant="ghost" size="sm" className="mx-2 px-2 font-normal text-muted-foreground hover:text-foreground" onClick={() => openNewProject(job.at.workspaceId)}>
          <Plus />
          New project
        </Button>
      ) : waitingOnly ? (
        <ul aria-label={`${job.name}: waiting on you`}>{waiting.map(row)}</ul>
      ) : (
        <>
          {active.length ? <ul aria-label={job.name}>{active.map(row)}</ul> : null}
          {rest.length ? <ProjectFactsFold words={restWords(rest)} open={resting} onToggle={toggle} /> : null}
          {resting && rest.length ? <ul aria-label={`${job.name}: paused and backlog`}>{rest.map(row)}</ul> : null}
        </>
      )}
    </section>
  );
}

/** One project, a press opening its page in its job; the Threads cell opens its lead thread. */
const TrackerRow = memo(function TrackerRow({ project, workspaceId, now, waitingOnly }: { project: MergedProject; workspaceId: string; now: number; waitingOnly: boolean }) {
  const onOpen = useCallback(() => openProjectPage(workspaceId, project.id), [workspaceId, project.id]);
  const next = useMemo(() => {
    const shown = project.next ? { title: project.next.title, ...(project.next.due !== undefined ? { due: project.next.due } : {}) } : null;
    if (!waitingOnly) return shown;
    // Under Waiting on you, a row its facts do not explain (a late or due waiting task) says its count where Next stands.
    const said = unsaidWait(project, shown?.due !== undefined && dueTone(shown.due, now) !== "later");
    return said ? { title: said } : shown;
  }, [project, waitingOnly, now]);
  return (
    <ProjectFactsRow
      id={project.id}
      name={project.name}
      state={project.state}
      targetDate={project.targetDate ?? undefined}
      next={next}
      waiting={project.waiting}
      done={project.done}
      total={project.total}
      threads={project.lead?.outcome ? <ThreadCell lead={project.lead} /> : undefined}
      now={now}
      onOpen={onOpen}
    />
  );
});

/** The words of the lead thread's tip: its title and what it left him, the fact a narrow cell cuts short. */
export const threadTip = (lead: Pick<TrackerThread, "title" | "outcome">): string => [lead.title, lead.outcome?.words].filter(Boolean).join(": ");

/** The lead thread: its mark and what it left him, a press opening it (the row's own press stays the project's). */
function ThreadCell({ lead }: { lead: TrackerThread }) {
  return (
    <>
      <span className="flex size-4 shrink-0 items-center justify-center">
        <OutcomeMark tone={lead.outcome?.tone} />
      </span>
      <Tip label={threadTip(lead)}>
        <button
          type="button"
          data-thread={lead.sessionId}
          onClick={(event) => {
            event.stopPropagation();
            openTrackerThread(lead.sessionId);
          }}
          className="block min-h-6 min-w-0 truncate rounded-sm py-0.5 text-start leading-5 hover:underline"
        >
          {lead.outcome?.words}
        </button>
      </Tip>
    </>
  );
}

/**
 * A job no host could read LifeOS for. The window's own session for the job says the state in the shared words with
 * its press (`DownLine`: Retry, Sign in, Open Settings); where that session reads (the host's read failed alone), the
 * host's words with a Retry that asks the hosts again.
 */
function DownJob({ job, onRetry }: { job: MergedJob; onRetry: () => void | Promise<void> }) {
  const session = useLifeosSession(job.at.environmentId, job.sector as SectorKey);
  if (downOf(session)) return <DownLine session={session} className="mx-2 px-2" />;
  return <HostDownLine words={job.down ?? ""} onRetry={onRetry} />;
}

/** The host's own words for a job it could not read, with a Retry that asks the hosts again and spins until they answer. */
export function HostDownLine({ words, onRetry }: { words: string; onRetry: () => void | Promise<void> }) {
  const [retrying, setRetrying] = useState(false);
  return (
    <p data-job-down className="mx-2 flex min-h-8 items-center gap-2 px-2 text-(length:--pk-text) text-muted-foreground">
      <span className="min-w-0 text-pretty">{words}</span>
      <Button
        variant="ghost"
        size="xs"
        className="shrink-0"
        disabled={retrying}
        onClick={() => {
          setRetrying(true);
          void Promise.resolve(onRetry()).finally(() => setRetrying(false));
        }}
      >
        <BusyLabel busy={retrying} label="Retry" />
      </Button>
    </p>
  );
}
