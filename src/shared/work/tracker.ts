import { OUTCOME_TONES, type ThreadOutcome } from './threadRecord'

/**
 * The tracker (docs/agents/work-tracker.md): every job's open projects, one row a project, with what a person
 * deciding needs: the next step, who owes him and since when, what its threads are doing, done of all, the target.
 * A host answers its own jobs (`work.projects.overview`); the window merges hosts. These are the shapes and the rules.
 */

/** The open states a tracker row is drawn for; done and dropped are LifeOS's finished ones and are not listed. */
export const OPEN_PROJECT_STATES = ['backlog', 'active', 'paused'] as const
export type OpenProjectState = (typeof OPEN_PROJECT_STATES)[number]

/** A project's live thread: the most pressing of its mirror's root threads. */
export interface TrackerThread {
  sessionId: string
  title: string
  outcome: ThreadOutcome | null
  updatedAt: number
}

/** One project's row. The facts are LifeOS's `projects:facts`; a project it gave none for reads as no facts. */
export interface TrackerProject {
  /** the LifeOS project */
  id: string
  name: string
  state: OpenProjectState
  /** the start of the target day here, ms; null for none */
  targetDate: number | null
  next: { taskId: string; key: string; title: string; due?: number } | null
  late: number
  dueToday: number
  waiting: { taskId: string; name: string; since: number } | null
  done: number
  total: number
  /** the mirror that holds its threads on this host; null until a thread or its settings made one */
  mirrorId: string | null
  /** how many root threads its mirror holds */
  threads: number
  /** the most pressing of them, or null */
  lead: TrackerThread | null
}

/** One job of a host: its projects, or why LifeOS could not be read for it. */
export interface TrackerJob {
  workspaceId: string
  name: string
  sector: string
  projects: TrackerProject[]
  /** LifeOS did not answer for this job: the words why; `projects` is then empty */
  down?: string
}

export interface TrackerOverview {
  jobs: TrackerJob[]
}

const TONE_RANK = new Map<string, number>(OUTCOME_TONES.map((tone, i) => [tone, i]))

/** Threads most pressing first (a question, a failure, a held act, live work, a file made, an act done, nothing), then newest. */
export function byPressing(a: TrackerThread, b: TrackerThread): number {
  const rank = (t: TrackerThread): number => (t.outcome ? (TONE_RANK.get(t.outcome.tone) ?? OUTCOME_TONES.length) : OUTCOME_TONES.length)
  return rank(a) - rank(b) || b.updatedAt - a.updatedAt
}

/** Rows by target date so a row never jumps when a thread starts or ends; no target last, then by name. */
export function byTarget(a: Pick<TrackerProject, 'targetDate' | 'name'>, b: Pick<TrackerProject, 'targetDate' | 'name'>): number {
  if (a.targetDate !== b.targetDate) {
    if (a.targetDate === null) return 1
    if (b.targetDate === null) return -1
    return a.targetDate - b.targetDate
  }
  return a.name.localeCompare(b.name)
}

/**
 * The "Waiting on you" filter: a project with a held act, a question or a failure among its threads, a late task, or
 * one due today. Held counts here though it is drawn muted: this filter is where held reads as urgent.
 */
export function waitsOnHim(p: Pick<TrackerProject, 'lead' | 'late' | 'dueToday'>): boolean {
  const tone = p.lead?.outcome?.tone
  return tone === 'asks' || tone === 'failed' || tone === 'held' || p.late > 0 || p.dueToday > 0
}
