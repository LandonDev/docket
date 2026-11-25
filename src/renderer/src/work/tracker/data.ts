import { useCallback, useEffect, useMemo, useState } from "react";
import { byPressing, byTarget, type TrackerOverview, type TrackerProject, type TrackerThread } from "@shared/work/tracker";
import { registry } from "../../lib/connection";
import { nameInLine } from "../../lib/hostWords";
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

export type HostAnswer = { environmentId: string; overview: TrackerOverview | null; error: string | null };

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

/** How often the page reads again while it is on screen: a thread's state moves, and a target he set elsewhere. */
export const TRACKER_AGAIN_MS = 60_000;

export type TrackerView = {
  jobs: MergedJob[];
  loading: boolean;
  errors: string[];
  /** a Work host has not answered yet: no all-clear stands until it has */
  pending: boolean;
  /** ask every host again (a down job's Retry) */
  reload: () => void;
};

/** The last answers, kept for the window's life: a visit draws them at once and reads again behind them. */
let kept: HostAnswer[] | null = null;
/** Nothing kept (tests). */
export const resetTracker = (): void => void (kept = null);

/** Every host with Work on: an open link is asked, one that is not open answers its line. */
export function askHosts(ask: (environmentId: string) => Promise<TrackerOverview>, hosts: Iterable<string> = workSwitch.hosts()): Promise<HostAnswer[]> {
  return Promise.all(
    [...hosts].map((environmentId): Promise<HostAnswer> => {
      const transport = registry.statusOf(environmentId).transport;
      if (transport !== "open") return Promise.resolve({ environmentId, overview: null, error: closedWords(hostIn(environmentId), transport) });
      return ask(environmentId).then(
        (overview) => ({ environmentId, overview: plain(overview, environmentId), error: null }),
        (err: unknown) => ({ environmentId, overview: null, error: hostWords(err, environmentId) }),
      );
    }),
  );
}

const askOverview = (environmentId: string): Promise<TrackerOverview> => registry.linkOf(environmentId).request<TrackerOverview>("work.projects.overview", {});

/**
 * The kept answers as a visit opens on them, held to the Work hosts there are now: a host whose link is not open says
 * its line at once, a host that is new (or was not asked) is pending, and a host no longer a Work host goes. A visit
 * after a host dropped never opens on an all-clear that host can no longer vouch for. Pure.
 */
export function reconcileKept(kept: readonly HostAnswer[] | null, hosts: Iterable<string>, transportOf: (environmentId: string) => string): HostAnswer[] | null {
  if (!kept) return null;
  const by = new Map(kept.map((a) => [a.environmentId, a]));
  return [...hosts].map((environmentId): HostAnswer => {
    const transport = transportOf(environmentId);
    if (transport !== "open") return { environmentId, overview: null, error: closedWords(hostIn(environmentId), transport) };
    return by.get(environmentId) ?? { environmentId, overview: null, error: null };
  });
}

/** The answers with each host whose link is no longer open saying its line at once; the other hosts' groups stand. Pure. */
export function withClosed(answers: readonly HostAnswer[], closed: ReadonlyMap<string, string>): HostAnswer[] {
  return answers.map((a) => (closed.has(a.environmentId) ? { environmentId: a.environmentId, overview: null, error: closed.get(a.environmentId)! } : a));
}

/** Every host with Work on, asked once on show, again on focus, each minute while shown, and when a host's link opens or drops. */
export function useTracker(): TrackerView {
  const [answers, setAnswers] = useState<HostAnswer[] | null>(() => reconcileKept(kept, workSwitch.hosts(), (id) => registry.statusOf(id).transport));
  const [asked, setAsked] = useState(0);
  const reload = useCallback(() => setAsked((n) => n + 1), []);
  useEffect(() => {
    let alive = true;
    // Only the newest read lands: an older one that answers late never replaces a newer answer.
    let latest = 0;
    const show = (got: HostAnswer[]): void => {
      kept = got;
      if (alive) setAnswers(got);
    };
    const read = (): void => {
      const n = ++latest;
      void askHosts(askOverview).then((got) => {
        if (n === latest) show(got);
      });
    };
    read();
    // A Work host whose link opens (the window started before the box's link was up), or a linked host whose Work
    // comes on, is asked then, not a minute later. One whose link drops says so at once, so no all-clear stands on
    // an answer it can no longer vouch for, and the hosts are asked again behind it.
    const open = (): Set<string> => new Set([...workSwitch.hosts()].filter((id) => registry.statusOf(id).transport === "open"));
    let wasOpen = open();
    const moved = (): void => {
      const now = open();
      const opened = [...now].some((id) => !wasOpen.has(id));
      const closed = new Map([...wasOpen].filter((id) => !now.has(id) && workSwitch.hosts().has(id)).map((id) => [id, closedWords(hostIn(id), registry.statusOf(id).transport)]));
      wasOpen = now;
      if (closed.size && kept) {
        latest++;
        show(withClosed(kept, closed));
      }
      if (opened || closed.size) read();
    };
    const offs = [registry.subscribe(moved), workSwitch.subscribe(moved)];
    const timer = setInterval(read, TRACKER_AGAIN_MS);
    window.addEventListener("focus", read);
    return () => {
      alive = false;
      for (const off of offs) off();
      clearInterval(timer);
      window.removeEventListener("focus", read);
    };
  }, [asked]);
  const jobs = useMemo(() => (answers ? mergeOverviews(answers) : []), [answers]);
  const errors = useMemo(() => (answers ?? []).flatMap((a) => (a.error ? [a.error] : [])), [answers]);
  const pending = (answers ?? []).some((a) => !a.overview && !a.error);
  return { jobs, loading: answers === null, errors, pending, reload };
}
