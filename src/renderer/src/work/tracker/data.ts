import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { byPressing, byTarget, type TrackerOverview, type TrackerProject, type TrackerThread } from "@shared/work/tracker";
import { registry } from "../../lib/connection";
import { DEGRADED_GRACE_MS, degradedNow } from "../../lib/connection/degraded";
import { nameInLine } from "../../lib/hostWords";
import { quietPoll } from "../../lib/quietPoll";
import { workErrorWords } from "../../lib/workErrorWords";
import { workSwitch } from "../../lib/workSwitch";

/**
 * The tracker as the page reads it (docs/agents/work-tracker.md "The window"): each linked host with Work on answers
 * `work.projects.overview` for its own jobs, and the answers merge here by sector. LifeOS's projects are the same from
 * every host of a sector, so a project's facts come from the first host that read them; its threads live on each host,
 * so they add up and the most pressing lead wins. A job every host failed to read says why, in plain words; a host
 * with Work on that did not answer, or whose link is not open, is one line, never the page's failure. The last answer
 * is kept for the window's life, so a visit draws it at once while the hosts are asked again.
 */

/** `closed`: the error is the host's link not being open, not an answer: when the link opens again the host is pending. */
export type HostAnswer = { environmentId: string; overview: TrackerOverview | null; error: string | null; closed?: true };

/** A project as the page draws it: its row, and the host whose lead thread it shows. */
export type MergedProject = TrackerProject & { leadHost: string | null };

export interface MergedJob {
  sector: string;
  name: string;
  /** where the job's pages open: the first host that read it, and its workspace there */
  at: { environmentId: string; workspaceId: string };
  projects: MergedProject[];
  /** every host that holds the job failed to read it: why */
  down?: string;
}

/** The hosts' answers as one list of jobs, in the order the first host listed them. Pure: a test hands it answers. */
export function mergeOverviews(answers: readonly HostAnswer[]): MergedJob[] {
  const jobs = new Map<string, MergedJob>();
  for (const { environmentId, overview } of answers) {
    for (const job of overview?.jobs ?? []) {
      const known = jobs.get(job.sector);
      if (!known) {
        jobs.set(job.sector, {
          sector: job.sector,
          name: job.name,
          at: { environmentId, workspaceId: job.workspaceId },
          projects: job.projects.map((p) => ({ ...p, leadHost: p.lead ? environmentId : null })),
          ...(job.down ? { down: job.down } : {}),
        });
        continue;
      }
      if (job.down) continue;
      // The first host failed and this one read LifeOS: its rows stand.
      if (known.down) {
        jobs.set(job.sector, { sector: known.sector, name: known.name, at: { environmentId, workspaceId: job.workspaceId }, projects: job.projects.map((p) => ({ ...p, leadHost: p.lead ? environmentId : null })) });
        continue;
      }
      const theirs = new Map(job.projects.map((p) => [p.id, p]));
      known.projects = known.projects.map((mine) => {
        const other = theirs.get(mine.id);
        if (!other) return mine;
        const lead = pressing(mine.lead, other.lead);
        return { ...mine, threads: mine.threads + other.threads, lead, leadHost: lead === mine.lead ? mine.leadHost : environmentId };
      });
    }
  }
  return [...jobs.values()].map((job) => ({ ...job, projects: [...job.projects].sort(byTarget) }));
}

const pressing = (a: TrackerThread | null, b: TrackerThread | null): TrackerThread | null => (!a ? b : !b ? a : byPressing(a, b) <= 0 ? a : b);

const hostIn = (environmentId: string): string => nameInLine(registry.environment(environmentId)?.name ?? "A host");
const capital = (words: string): string => `${words.charAt(0).toUpperCase()}${words.slice(1)}`;

/** Why a host's jobs did not come, as a sentence. */
function hostWords(err: unknown, environmentId: string): string {
  const host = hostIn(environmentId);
  return workErrorWords(err, { host }) || `${capital(host)} did not answer.`;
}

/** A host with Work on whose link is not open, as its one line: connecting, or not connected. */
export function closedWords(host: string, transport: string): string {
  return transport === "connecting" ? `${capital(host)} is connecting.` : `${capital(host)} is not connected.`;
}

/** A job a host could not read LifeOS for, in plain words: the host's own words where they are a person's, else one line. */
export function downWords(down: string, host: string, job: string): string {
  return workErrorWords(down, { host }) || `${capital(host)} could not read ${job}'s projects from LifeOS.`;
}

/** A host's answer with each down job's words made plain. */
const plain = (overview: TrackerOverview, environmentId: string): TrackerOverview => ({
  jobs: overview.jobs.map((job) => (job.down ? { ...job, down: downWords(job.down, hostIn(environmentId), job.name) } : job)),
});

/**
 * How often the page reads again while it is on screen: a thread's state moves, and a target he set elsewhere. It is
 * also the quiet spell a focus waits out: a focus reads only when no read began this long ago (perf M11).
 */
export const TRACKER_AGAIN_MS = 60_000;

export type TrackerView = {
  jobs: MergedJob[];
  loading: boolean;
  errors: string[];
  /** a Work host has not answered yet: no all-clear stands until it has */
  pending: boolean;
  /** ask every host again (a down job's Retry): settles when that read has answered */
  reload: () => Promise<void>;
};

/** The last answers, kept for the window's life: a visit draws them at once and reads again behind them. */
let kept: HostAnswer[] | null = null;
/** Nothing kept (tests). */
export const resetTracker = (): void => void (kept = null);

/** A link not open that is still inside its grace (lib/connection/degraded.ts): a cold window's first connect, a drop
 *  under 1.5 s old. Its host is pending, its page's bones stand, and nothing says it is down yet. */
const inGraceNow = (environmentId: string): boolean => degradedNow(environmentId) === null;

/** Every host with Work on: an open link is asked, one inside its grace is pending, one past it answers its line. */
export function askHosts(ask: (environmentId: string) => Promise<TrackerOverview>, hosts: Iterable<string> = workSwitch.hosts(), inGrace: (environmentId: string) => boolean = inGraceNow): Promise<HostAnswer[]> {
  return Promise.all(
    [...hosts].map((environmentId): Promise<HostAnswer> => {
      const transport = registry.statusOf(environmentId).transport;
      if (transport !== "open" && inGrace(environmentId)) return Promise.resolve({ environmentId, overview: null, error: null });
      if (transport !== "open") return Promise.resolve({ environmentId, overview: null, error: closedWords(hostIn(environmentId), transport), closed: true });
      return ask(environmentId).then(
        (overview) => ({ environmentId, overview: plain(overview, environmentId), error: null }),
        (err: unknown) => ({ environmentId, overview: null, error: hostWords(err, environmentId) }),
      );
    }),
  );
}

/** A read that changes nothing: asked again when the socket is not open yet or drops (a window's cold open), never failed on the spot. */
const askOverview = (environmentId: string): Promise<TrackerOverview> => registry.linkOf(environmentId).request<TrackerOverview>("work.projects.overview", {}, { retry: true });

/**
 * The kept answers as a visit opens on them, held to the Work hosts there are now: a host whose link is not open says
 * its line at once, a host that is new (or was not asked) is pending, and a host no longer a Work host goes. A visit
 * after a host dropped never opens on an all-clear that host can no longer vouch for. Pure.
 */
export function reconcileKept(kept: readonly HostAnswer[] | null, hosts: Iterable<string>, transportOf: (environmentId: string) => string, inGrace: (environmentId: string) => boolean = () => false): HostAnswer[] | null {
  if (!kept) return null;
  const by = new Map(kept.map((a) => [a.environmentId, a]));
  return [...hosts].map((environmentId): HostAnswer => {
    const transport = transportOf(environmentId);
    const old = by.get(environmentId);
    if (transport !== "open" && !inGrace(environmentId)) {
      const error = closedWords(hostIn(environmentId), transport);
      // The same line as before is the same answer: a roster that did not move is not new.
      return old && !old.overview && old.error === error ? old : { environmentId, overview: null, error, closed: true };
    }
    // A host whose link is open again is pending: its closed line says nothing of it now.
    return old && !old.closed ? old : { environmentId, overview: null, error: null };
  });
}

/**
 * Every host with Work on, asked once on show, then through `quietPoll`: a minute after the last read, never while the
 * window is hidden (once as it shows again, when one came due), on a focus at most once a minute, and at once when a
 * host's link opens or drops.
 */
export function useTracker(): TrackerView {
  const [answers, setAnswers] = useState<HostAnswer[] | null>(() => reconcileKept(kept, workSwitch.hosts(), (id) => registry.statusOf(id).transport, inGraceNow));
  const [asked, setAsked] = useState(0);
  // Each Retry waits for the read it starts: `show` settles every one asked before it.
  const waiting = useRef<(() => void)[]>([]);
  const reload = useCallback(
    () =>
      new Promise<void>((done) => {
        waiting.current.push(done);
        setAsked((n) => n + 1);
      }),
    [],
  );
  useEffect(() => {
    let alive = true;
    // Only the newest read lands: an older one that answers late never replaces a newer answer.
    // On an object, not a let: the React Compiler does not lower `++` on a variable a closure holds.
    const reads = { latest: 0 };
    // Only the mounted page publishes: an answer that lands after its visit ended never overwrites a newer one.
    const show = (got: HostAnswer[]): void => {
      if (!alive) return;
      kept = got;
      setAnswers(got);
    };
    // When the last read began: a focus inside a minute of it asks nothing.
    const last = { at: 0 };
    // A link inside its grace is pending; when the grace ends with the link still not open, its line is due.
    const graceEnd = { timer: 0 };
    const read = (): void => {
      reads.latest += 1;
      const n = reads.latest;
      last.at = Date.now();
      poll.heard();
      window.clearTimeout(graceEnd.timer);
      if ([...workSwitch.hosts()].some((id) => registry.statusOf(id).transport !== "open" && inGraceNow(id))) graceEnd.timer = window.setTimeout(read, DEGRADED_GRACE_MS + 1);
      void askHosts(askOverview).then((got) => {
        if (n !== reads.latest) return;
        show(got);
        if (alive) for (const done of waiting.current.splice(0)) done();
      });
    };
    const poll = quietPoll(read, TRACKER_AGAIN_MS);
    read();
    const focused = (): void => {
      if (!document.hidden && Date.now() - last.at >= TRACKER_AGAIN_MS) read();
    };
    // The roster follows the hosts as they move while the page is open, by the rule a visit opens on
    // (`reconcileKept`): a host whose link drops says so at once, a host that joins Work or whose link opens is
    // pending (so no all-clear stands without it), a host that leaves Work goes; then every host is asked again.
    // The roster is the Work hosts and whether each link is open, tracked from the first read on: any change (a host
    // joins or leaves Work, a link drops or opens again) drops the read in flight, shows the roster at once (from the
    // answers on screen, or none yet) and asks it again.
    const rosterKey = (): string => [...workSwitch.hosts()].sort().map((id) => `${id}:${registry.statusOf(id).transport === "open"}`).join(",");
    let was = rosterKey();
    const moved = (): void => {
      const now = rosterKey();
      if (now === was) return;
      was = now;
      reads.latest += 1;
      show(reconcileKept(kept ?? [], workSwitch.hosts(), (id) => registry.statusOf(id).transport, inGraceNow)!);
      read();
    };
    const offs = [registry.subscribe(moved), workSwitch.subscribe(moved)];
    window.addEventListener("focus", focused);
    return () => {
      alive = false;
      window.clearTimeout(graceEnd.timer);
      for (const off of offs) off();
      poll.stop();
      window.removeEventListener("focus", focused);
    };
  }, [asked]);
  const jobs = useMemo(() => (answers ? mergeOverviews(answers) : []), [answers]);
  const errors = useMemo(() => (answers ?? []).flatMap((a) => (a.error ? [a.error] : [])), [answers]);
  const pending = (answers ?? []).some((a) => !a.overview && !a.error);
  return { jobs, loading: answers === null, errors, pending, reload };
}
