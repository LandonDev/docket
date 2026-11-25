import type { MergedJob, MergedProject } from "./data";

/**
 * Five jobs as the tracker reads them, for the preview page and the page's tests: rows by target date, a late next
 * step, a wait with its age, a held mail, a question, live work, paused and backlog under one line, an empty job and
 * a job LifeOS could not be read for.
 */

/** Mon Nov 23 2026, 10:00 here. */
export const NOW = new Date(2026, 10, 23, 10, 0).getTime();
const day = (n: number, hour = 9): number => new Date(2026, 10, 23 + n, hour, 0).getTime();
const midnight = (n: number): number => new Date(2026, 10, 23 + n).getTime();

const project = (id: string, name: string, over: Partial<MergedProject> = {}): MergedProject => ({
  id,
  name,
  state: "active",
  targetDate: null,
  next: null,
  late: 0,
  dueToday: 0,
  waiting: null,
  done: 0,
  total: 0,
  mirrorId: null,
  threads: 0,
  lead: null,
  leadHost: null,
  ...over,
});

const at = (workspaceId: string) => ({ environmentId: "env_box", workspaceId });

export const JOBS: MergedJob[] = [
  {
    sector: "purdue",
    name: "Purdue Esports",
    at: at("ws-purdue"),
    projects: [
      project("p-budget", "FY27 budget", {
        targetDate: midnight(19),
        next: { taskId: "t-travel", key: "PUR-12", title: "Travel lines", due: day(-2) },
        late: 1,
        done: 3,
        total: 6,
        mirrorId: "m-budget",
        threads: 1,
        lead: { sessionId: "t-fill", title: "Fill the travel lines", updatedAt: day(0, 9), outcome: { words: "Editing Budget FY27.xlsx", tone: "working" } },
        leadHost: "env_box",
      }),
      project("p-lan", "Spring LAN", {
        targetDate: midnight(83),
        next: { taskId: "t-stage", key: "PUR-41", title: "Stage and casters", due: day(0, 15) },
        dueToday: 1,
        waiting: { taskId: "t-switches", name: "Sam Ortiz", since: day(-6) },
        done: 2,
        total: 7,
        mirrorId: "m-lan",
        threads: 2,
        lead: { sessionId: "t-itap", title: "Ask ITaP for two more switches", updatedAt: day(0, 8), outcome: { words: "1 mail to send", tone: "held" } },
        leadHost: "env_box",
      }),
      project("p-lights", "Arena lighting", { state: "paused", done: 1, total: 4 }),
    ],
  },
  {
    sector: "hypixel",
    name: "Hypixel",
    at: at("ws-hypixel"),
    projects: [
      project("p-trailer", "Winter update trailer", {
        targetDate: midnight(11),
        next: { taskId: "t-music", key: "HYP-8", title: "Music licence", due: day(4) },
        waiting: { taskId: "t-cut", name: "Mia", since: day(-3) },
        done: 1,
        total: 4,
        mirrorId: "m-trailer",
        threads: 1,
        lead: { sessionId: "t-cut", title: "Ask Mia for the rough cut", updatedAt: day(0, 7), outcome: { words: "Asks you", tone: "asks" } },
        leadHost: "env_box",
      }),
      project("p-shorts", "Shorts for the launch", { state: "backlog", done: 0, total: 3 }),
    ],
  },
  {
    sector: "cosmic",
    name: "Cosmic",
    at: at("ws-cosmic"),
    projects: [
      project("p-season", "Prisons season 9 launch", {
        targetDate: midnight(8),
        next: { taskId: "t-notes", key: "COS-6", title: "Patch notes draft", due: day(4) },
        done: 0,
        total: 2,
      }),
    ],
  },
  { sector: "ref", name: "Referee", at: at("ws-ref"), projects: [] },
  { sector: "unify", name: "Unify", at: at("ws-unify"), projects: [], down: "LifeOS did not answer the box." },
];
