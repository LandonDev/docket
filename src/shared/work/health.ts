import type { PillarId, SectorKey } from './ids'

/**
 * Connections (docs/agents/work-connections.md): every sign-in and helper
 * Work leans on, as one host answers for it. Each pillar answers for its
 * own through `WorkModule.health`; `work.health` gathers this host's rows
 * and the `work_connections` tool reads them for a thread. No row ever
 * carries a password, a token or a cookie: it says signed in or not, and
 * as whom.
 */

/** working: nothing to do. broken: it should work and does not. needs-you: only he can make it work (a sign-in, a consent, an install). */
export type HealthState = 'working' | 'broken' | 'needs-you'

/**
 * What the button beside a row does. Nothing runs by itself: each is his press.
 *  - `run`: a Work method on the row's host (`work.<pillar>.<verb>`), under his window's capabilities.
 *  - `open`: a page in his browser (a sign-in, a consent screen).
 *  - `page`: a place in the app: `lifeos-sign-in` (the sign-in dialog), or a Settings page by its id.
 * A row whose fix is something he must do by hand says it in `line` and has no fix.
 */
export type HealthFix =
  | { kind: 'run'; label: string; method: `work.${string}`; params?: Record<string, unknown> }
  | { kind: 'open'; label: string; url: string }
  | { kind: 'page'; label: string; page: string }

export interface HealthRow {
  /** stable within the host: `<pillar>.<thing>[:<which>]` */
  id: string
  pillar: PillarId
  /** the heading it sits under, in the order rows come: "LifeOS", "Office", "Browser", … */
  group: string
  /** what it is: "Excel", "purdue@… mail", "Outlook on the web" */
  title: string
  state: HealthState
  /** one line: as whom, or why not, or what he must do. Never more. */
  line?: string
  fix?: HealthFix
  /** when it lapses (epoch ms): a session's or a token's known end, the Windows evaluation */
  until?: number
  /** the row is one sector's (a LifeOS source, a Google consent): a thread of another sector is not shown it */
  sector?: SectorKey
}

/** One host's answer to `work.health`. */
export interface HealthReport {
  host: string
  at: number
  rows: HealthRow[]
}

/** A thing with a known end, as `health.lapses` answers it: read from what the host holds, never from the network. */
export interface Lapse {
  id: string
  pillar: PillarId
  title: string
  until: number
}

/** Days before a lapse that the app first says so, and again the day before. */
export const LAPSE_NOTICE_DAYS = [14, 1] as const

const DAY = 86_400_000

/** Which notice a lapse is due, if any: the index into `LAPSE_NOTICE_DAYS` of the nearest stage it has reached, or null when it is further off. A lapse already past is stage of the last day. */
export function lapseStage(until: number, now: number): number | null {
  const left = until - now
  let stage: number | null = null
  LAPSE_NOTICE_DAYS.forEach((days, i) => {
    if (left <= days * DAY) stage = i
  })
  return stage
}

/** "ends on 17 Feb", "ends tomorrow", "ended on 17 Feb": a lapse in his words. */
export function lapseLine(until: number, now: number): string {
  const date = new Date(until).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', ...(new Date(until).getFullYear() !== new Date(now).getFullYear() ? { year: 'numeric' } : {}) })
  if (until <= now) return `Ended on ${date}`
  const days = Math.ceil((until - now) / DAY)
  if (days <= 1) return 'Ends tomorrow'
  return `Ends on ${date}`
}

/** The rows a thread may read: every row of no sector, and its own sector's; `'all'` (a Work Chat, which reads every sector) reads them all. */
export function rowsForSector(rows: readonly HealthRow[], sector: SectorKey | null | 'all'): HealthRow[] {
  return sector === 'all' ? [...rows] : rows.filter((row) => !row.sector || row.sector === sector)
}

/** Worst first, then the order the host gave: what needs a press leads its group. */
export const HEALTH_ORDER: Record<HealthState, number> = { broken: 0, 'needs-you': 1, working: 2 }
