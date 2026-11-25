import { useEffect, useState } from "react";
import { byPressing, byTarget, type TrackerOverview, type TrackerProject, type TrackerThread } from "@shared/work/tracker";
import { registry } from "../../lib/connection";
import { nameInLine } from "../../lib/hostWords";
import { workErrorWords } from "../../lib/workErrorWords";
import { workSwitch } from "../../lib/workSwitch";

/**
 * The tracker as the page reads it (docs/agents/work-tracker.md "The window"): each linked host with Work on answers
 * `work.projects.overview` for its own jobs, and the answers merge here by sector. LifeOS's projects are the same from
 * every host of a sector, so a project's facts come from the first host that read them; its threads live on each host,
 * so they add up and the most pressing lead wins. A job every host failed to read says why; a host that did not answer
 * is one line, never the page's failure.
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

/** Why a host's jobs did not come, as a sentence. */
function hostWords(err: unknown, environmentId: string): string {
  const host = nameInLine(registry.environment(environmentId)?.name ?? "A host");
  const words = workErrorWords(err, { host });
  return words || `${host.charAt(0).toUpperCase()}${host.slice(1)} did not answer.`;
}

/** How often the page reads again while it is on screen: a thread's state moves, and a target he set elsewhere. */
export const TRACKER_AGAIN_MS = 60_000;

export type TrackerView = { jobs: MergedJob[]; loading: boolean; errors: string[] };

/** Every linked host with Work on, asked once on show, again on focus and each minute while shown. */
export function useTracker(): TrackerView {
  const [answers, setAnswers] = useState<HostAnswer[] | null>(null);
  useEffect(() => {
    let alive = true;
    const read = (): void => {
      const hosts = [...workSwitch.hosts()].filter((id) => registry.statusOf(id).transport === "open");
      void Promise.all(
        hosts.map((environmentId) =>
          registry
            .linkOf(environmentId)
            .request<TrackerOverview>("work.projects.overview", {})
            .then(
              (overview): HostAnswer => ({ environmentId, overview, error: null }),
              (err: unknown): HostAnswer => ({ environmentId, overview: null, error: hostWords(err, environmentId) }),
            ),
        ),
      ).then((got) => {
        if (alive) setAnswers(got);
      });
    };
    read();
    const timer = setInterval(read, TRACKER_AGAIN_MS);
    window.addEventListener("focus", read);
    return () => {
      alive = false;
      clearInterval(timer);
      window.removeEventListener("focus", read);
    };
  }, []);
  return { jobs: answers ? mergeOverviews(answers) : [], loading: answers === null, errors: (answers ?? []).flatMap((a) => (a.error ? [a.error] : [])) };
}
