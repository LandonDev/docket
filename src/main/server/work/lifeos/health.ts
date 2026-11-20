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

/** A source with no sync for longer than this reads as broken. */
export const SOURCE_STALE_MS = 6 * 60 * 60_000
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
  error?: string
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
  const row = { id: `lifeos.source:${s._id}`, pillar: 'lifeos', group: 'Mail and calendar', title: s.label || s.accountName || s.account, shared: true, ...(s.sector ? { sector: s.sector } : { personal: true as const }) } as const
  if (s.status === 'error') return { ...row, state: 'broken', line: s.error ? redact(s.error) : 'The last sync failed' }
  if (!s.lastSyncAt) return { ...row, state: 'broken', line: 'Never synced' }
  if (now - s.lastSyncAt > SOURCE_STALE_MS) return { ...row, state: 'broken', line: `No sync since ${whenWords(s.lastSyncAt, now)}` }
  return { ...row, state: 'working', line: `Synced ${whenWords(s.lastSyncAt, now)}` }
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
