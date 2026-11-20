import type { LifeosStatus } from '@shared/contract-work-lifeos'
import { errorText, WORK_HOME, type HealthRow, type SectorKey } from '@shared/work'
import type { HealthSource } from '../modules'
import type { LifeosClient } from './ctx'
import { lifeosHostOf } from './ctx'
import { redact } from './transport'

/**
 * The lifeos pillar's connections (docs/agents/work-connections.md): this
 * host's sign-in, whether LifeOS answers now (`health:ping`), a sector key
 * that failed, and each mail and calendar source LifeOS reads
 * (`sources:list`). Two queries at most, and none while signed out: a host
 * that is not signed in shows the one sign-in row and nothing that hangs
 * on it. LifeOS gives a device session no end, so nothing here lapses.
 */

/**
 * How long a source may go without checking in before its row says so, by
 * kind, as LifeOS's own health rule judges it (packages/shared/src/health.ts
 * `SOURCE_SILENT_MINUTES`): only a kind that checks in on every poll has
 * one. Gmail reports ok at least once a minute (gmail/sync.ts), so ten
 * minutes leaves room for the worker's start; an ICS feed stamps every poll,
 * which may be up to 24 hours apart, and its row does not say how far, so a
 * day and an hour. A Google calendar reports only when its state changes
 * (calendar/google.ts: "on change only, so a quiet minute writes nothing"),
 * so its times say when the worker last started, not whether it syncs: it is
 * judged by its status and error alone.
 */
export const SOURCE_SILENT_MS: Readonly<Record<string, number>> = { email: 10 * 60_000, ics: 25 * 60 * 60_000 }
/** The word that says what a source is, after its name: mail or a calendar. */
const KIND_WORD: Readonly<Record<string, string>> = { email: 'mail', gcal: 'calendar', ics: 'calendar' }
/** The kinds that are his mail and calendars; chat and the rest have rows of their own elsewhere, or none. */
const MAIL_AND_CALENDAR = new Set(['email', 'gcal', 'ics'])

/** A LifeOS `sources` row, as much of it as a row needs. */
export interface LifeosSource {
  _id: string
  kind: string
  account: string
  accountName?: string
  label: string
  sector?: SectorKey
  enabled: boolean
  status: 'idle' | 'ok' | 'error'
  lastSyncAt?: number
  /** when it last checked in, ok or not (LifeOS's `reportedAt`) */
  reportedAt?: number
  error?: string
}

/** "Cosmic mail", "landon@cosmic.games calendar": its name, then what it is, unless the name says it already ("Hypixel Calendar"). */
export function sourceTitle(s: Pick<LifeosSource, 'kind' | 'label' | 'accountName' | 'account'>): string {
  const name = s.label || s.accountName || s.account
  const word = KIND_WORD[s.kind]
  return !word || name.toLowerCase().includes(word) ? name : `${name} ${word}`
}

/** "2:02 PM" today, "Nov 17" before: his US words, in the host's local time. */
export function whenWords(at: number, now: number): string {
  const d = new Date(at)
  if (d.toDateString() === new Date(now).toDateString()) return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

const SIGN_IN = { kind: 'page', label: 'Sign in…', page: 'lifeos-sign-in' } as const
const SIGN_OUT = { kind: 'run', label: 'Sign out', method: 'work.lifeos.signOut' } as const

/** The sign-in row: what Settings → Work showed, with its button. Null when Work is off here. */
export function signInRow(state: LifeosStatus['lifeos'], now: number): HealthRow | null {
  const row = { id: 'lifeos.signin', pillar: 'lifeos', group: 'LifeOS', title: 'LifeOS' } as const
  switch (state.state) {
    case 'off':
      return null
    case 'connected':
      return { ...row, state: 'working', line: 'Signed in', fix: SIGN_OUT }
    case 'pairing':
      return { ...row, state: 'needs-you', line: 'A sign-in waits for your approval in LifeOS', fix: { kind: 'page', label: 'Show code…', page: 'lifeos-sign-in' } }
    case 'signed-out':
      return { ...row, state: 'needs-you', line: 'Not signed in on this host', fix: SIGN_IN }
    case 'refused':
      return { ...row, state: 'needs-you', line: "LifeOS refused this host's sign-in. Sign in again.", fix: SIGN_IN }
    // Signed in but not answering: Sign out stays, so a host stuck on a wrong address can sign in again. No retry method: the session tries again on its own steps.
    case 'connecting':
      return { ...row, state: 'broken', line: 'Still connecting', fix: SIGN_OUT }
    case 'unreachable':
      return { ...row, state: 'broken', line: `No answer since ${whenWords(state.since, now)}; it keeps trying`, fix: SIGN_OUT }
  }
}

/** One mail or calendar source, or null for a kind or a source that has no row. */
export function sourceRow(s: LifeosSource, now: number): HealthRow | null {
  if (!s.enabled || !MAIL_AND_CALENDAR.has(s.kind)) return null
  // Every signed-in host reads the same source through LifeOS: shared, so the page shows it once. One with no sector names an account of his: personal.
  const row = { id: `lifeos.source:${s._id}`, pillar: 'lifeos', group: 'Mail and calendar', title: sourceTitle(s), shared: true, ...(s.sector ? { sector: s.sector } : { personal: true as const }) } as const
  if (s.status === 'error') return { ...row, state: 'broken', line: s.error ? redact(s.error) : 'The last sync failed' }
  // Idle with a reason: LifeOS stopped reading it (the account was disconnected); only he can connect it again there.
  if (s.status === 'idle' && s.error) return { ...row, state: 'needs-you', line: `Stopped in LifeOS: ${redact(s.error)}` }
  const silent = SOURCE_SILENT_MS[s.kind]
  if (silent === undefined) return { ...row, state: 'working', line: 'Syncing' }
  const seen = s.reportedAt ?? s.lastSyncAt
  if (!seen) return { ...row, state: 'broken', line: 'Never synced' }
  if (now - seen > silent) return { ...row, state: 'broken', line: `No sync since ${whenWords(seen, now)}` }
  return { ...row, state: 'working', line: `Synced ${whenWords(seen, now)}` }
}

/** Every row, from the host's status and, while signed in, its owner's client. */
export async function lifeosRows(o: { status: LifeosStatus; owner: LifeosClient; workspaceName: (id: string) => string | undefined; now: number }): Promise<HealthRow[]> {
  const signIn = signInRow(o.status.lifeos, o.now)
  if (!signIn) return []
  const rows: HealthRow[] = [signIn]
  if (o.status.lifeos.state !== 'connected') return rows
  for (const key of o.status.keys) {
    if (key.state !== 'failed') continue
    const title = key.workspaceId === WORK_HOME ? 'Work Chats' : (o.workspaceName(key.workspaceId) ?? key.workspaceId)
    rows.push({ id: `lifeos.key:${key.workspaceId}`, pillar: 'lifeos', group: 'LifeOS', title: `${title} key`, state: 'broken', line: key.error ? redact(key.error) : 'The key was not made; the next pass tries again', ...(key.sectors.length === 1 ? { sector: key.sectors[0] } : { personal: true as const }) })
  }
  const [ping, sources] = await Promise.allSettled([o.owner.query('health:ping', {}), o.owner.query<LifeosSource[]>('sources:list', {})])
  if (ping.status === 'rejected') {
    rows.push({ id: 'lifeos.answers', pillar: 'lifeos', group: 'LifeOS', title: 'LifeOS answers', state: 'broken', line: `Did not answer: ${redact(errorText(ping.reason))}` })
    return rows
  }
  if (sources.status === 'rejected') {
    rows.push({ id: 'lifeos.sources', pillar: 'lifeos', group: 'Mail and calendar', title: 'Mail and calendar', state: 'broken', line: `LifeOS did not list them: ${redact(errorText(sources.reason))}` })
    return rows
  }
  for (const s of sources.value ?? []) {
    const row = sourceRow(s, o.now)
    if (row) rows.push(row)
  }
  return rows
}

export const lifeosHealth: HealthSource = {
  async check(ctx) {
    const host = lifeosHostOf(ctx)
    if (!host) return []
    const names = new Map(host.workspaces().map((w) => [w.id, w.name]))
    return lifeosRows({ status: host.status(false), owner: ctx.lifeos.owner(), workspaceName: (id) => names.get(id), now: Date.now() })
  }
}
