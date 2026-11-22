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
  /** every host that reads it gives the same answer (a LifeOS source, read through LifeOS): the page shows it once */
  shared?: true
  /** its title or line names his accounts, tenants or folders and it has no one sector: a thread of a sector reads its state alone */
  personal?: true
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

/**
 * The only methods a `run` fix may name: the host drops any other from a
 * row (work/health.ts `cleanRow`) and the page never sends one. A fix is a
 * repair; nothing that sends, grants, or turns Work off is ever one.
 */
export const HEALTH_RUN_METHODS: readonly string[] = ['work.lifeos.signOut']

/**
 * The places a `page` fix may open: the LifeOS sign-in dialog, OneDrive's sign-in on the Windows VM the row's host
 * keeps (`work.office.vmSignIn`, then the Computers page on the VM), or one of these Settings pages.
 */
export const HEALTH_PAGES: readonly string[] = ['lifeos-sign-in', 'windows-vm-sign-in', 'settings:work', 'settings:remote', 'settings:connections']

/** Whether a fix is one the host passes on and the page carries out. */
export function fixAllowed(fix: HealthFix): boolean {
  if (fix.kind === 'run') return HEALTH_RUN_METHODS.includes(fix.method)
  if (fix.kind === 'open') return /^https:\/\/[^\s]+$/.test(fix.url)
  return HEALTH_PAGES.includes(fix.page)
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

/** "Ends today, 3:10 PM", "Ends tomorrow, 1:22 AM", "Ends Feb 17, 1:22 AM", "Ended Feb 17": a lapse in his words, in local time. */
export function lapseLine(until: number, now: number): string {
  const end = new Date(until)
  const sameYear = end.getFullYear() === new Date(now).getFullYear()
  const date = end.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) })
  if (until <= now) return `Ended ${date}`
  const time = end.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  const dayOf = (t: number): number => {
    const d = new Date(t)
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  }
  const days = Math.round((dayOf(until) - dayOf(now)) / DAY)
  if (days === 0) return `Ends today, ${time}`
  if (days === 1) return `Ends tomorrow, ${time}`
  return `Ends ${date}, ${time}`
}

/**
 * The rows a thread may read: its own sector's, and every row of no sector,
 * a personal one cut to its group and state (no account, tenant or folder
 * of another sector reaches it); `'all'` (a Work Chat, which reads every
 * sector) reads them all whole.
 */
export function rowsForSector(rows: readonly HealthRow[], sector: SectorKey | null | 'all'): HealthRow[] {
  if (sector === 'all') return [...rows]
  return rows
    .filter((row) => !row.sector || row.sector === sector)
    .map((row) => (row.personal && !row.sector ? { id: row.id, pillar: row.pillar, group: row.group, title: row.group, state: row.state, ...(row.until ? { until: row.until } : {}) } : row))
}

/** Worst first, then the order the host gave: what needs a press leads its group. */
export const HEALTH_ORDER: Record<HealthState, number> = { broken: 0, 'needs-you': 1, working: 2 }
