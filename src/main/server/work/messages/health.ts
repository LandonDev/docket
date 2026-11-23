import { errorText, type HealthRow, type SectorKey } from '@shared/work'
import { isChatSource, lastHeard, SOURCE_NAME, staleOf, syncWhen, type ChatSource } from '@shared/work/messages'
import { redactLine } from '../health'
import type { HealthSource, WorkCtx } from '../modules'
import { linkedWorkspaces } from './lifeos'

/**
 * Chat's rows in Connections (docs/agents/work-connections.md): one a chat
 * service and account LifeOS reads for a sector a Work workspace of this
 * host links, from `sources:list` (its rows for a server's channels folded
 * into one, `foldAccounts`). Mail and calendars are the lifeos pillar's rows; a
 * chat source of no linked sector, or one he turned off, has none. Stale is
 * `staleOf`, the one rule the view's sync line also reads.
 */

/** A LifeOS `sources` row, as much of it as a row needs. */
export interface ChatSourceRow {
  _id: string
  kind: string
  account: string
  accountName?: string
  channel?: string
  label: string
  sector?: SectorKey
  enabled: boolean
  status: 'idle' | 'ok' | 'error'
  lastSyncAt?: number
  reportedAt?: number
  error?: string
}

const GROUP = 'Chat'

/** "CosmicGames Slack", "Discord": its name, then its service, unless the name says it already. */
export function chatSourceTitle(s: Pick<ChatSourceRow, 'label' | 'accountName' | 'account'> & { kind: ChatSource }): string {
  const name = (s.label || s.accountName || s.account || '').trim()
  const service = SOURCE_NAME[s.kind]
  return !name ? service : name.toLowerCase().includes(service.toLowerCase()) ? name : `${name} ${service}`
}

/** One chat source of a linked sector, or null for a source that has no row. */
export function chatSourceRow(s: ChatSourceRow, sectors: ReadonlySet<string>, now: number): HealthRow | null {
  if (!s.enabled || !isChatSource(s.kind) || !s.sector || !sectors.has(s.sector)) return null
  const kind = s.kind
  // Every signed-in host reads the same source through LifeOS: shared, so Connections shows it once.
  const row = { id: `messages.source:${s._id}`, pillar: 'messages', group: GROUP, title: chatSourceTitle({ ...s, kind }), shared: true, sector: s.sector } as const
  if (s.status === 'error') return { ...row, state: 'broken', line: s.error ? redactLine(s.error) : 'The last sync failed' }
  // Idle with a reason: LifeOS stopped reading it; only he can connect it again there.
  if (s.status === 'idle' && s.error) return { ...row, state: 'needs-you', line: `Stopped in LifeOS: ${redactLine(s.error)}` }
  const heard = lastHeard(s)
  if (staleOf({ ...s, kind }, now)) return { ...row, state: 'broken', line: heard === undefined ? 'Never synced' : `No sync since ${syncWhen(heard, now)}` }
  return { ...row, state: 'working', line: `Synced ${syncWhen(heard!, now)}` }
}

/** LifeOS's own rule: a chat source with no sector of its own is "everything else". */
const UNMAPPED: SectorKey = 'life'

/**
 * A service's rows for one account and sector as one: a Discord server is a
 * row a channel in LifeOS, and Connections says "Discord" once. In error when
 * any row is, stopped when any was stopped with a reason, else as fresh as
 * the freshest. The account's own row names it; its id is the account's, so
 * it stays the same row as channels come and go.
 */
export function foldAccounts(sources: readonly ChatSourceRow[]): ChatSourceRow[] {
  const groups = new Map<string, ChatSourceRow[]>()
  for (const s of sources) {
    if (!s.enabled || !isChatSource(s.kind)) continue
    const sector = s.sector ?? UNMAPPED
    const key = `${s.kind}:${s.account}:${sector}`
    groups.set(key, [...(groups.get(key) ?? []), { ...s, sector }])
  }
  return [...groups].map(([key, rows]) => {
    const whole = rows.find((r) => r.channel === undefined)
    const failed = rows.find((r) => r.status === 'error')
    const stopped = rows.find((r) => r.status === 'idle' && r.error)
    const newest = (pick: (r: ChatSourceRow) => number | undefined): number | undefined => rows.reduce<number | undefined>((best, r) => (pick(r) === undefined ? best : Math.max(best ?? 0, pick(r)!)), undefined)
    const lastSyncAt = newest((r) => r.lastSyncAt)
    const reportedAt = newest((r) => r.reportedAt)
    const first = rows[0]!
    return {
      _id: key,
      kind: first.kind,
      account: first.account,
      ...(first.accountName ? { accountName: first.accountName } : {}),
      // A channel's own label names the channel, not the service: only the account's row, else the account's name.
      label: whole?.label ?? first.accountName ?? '',
      sector: first.sector,
      enabled: true,
      status: failed ? 'error' : stopped ? 'idle' : rows.some((r) => r.status === 'ok') ? 'ok' : 'idle',
      ...(lastSyncAt !== undefined ? { lastSyncAt } : {}),
      ...(reportedAt !== undefined ? { reportedAt } : {}),
      ...((failed ?? stopped)?.error ? { error: (failed ?? stopped)!.error } : {})
    }
  })
}

export async function chatRows(ctx: Pick<WorkCtx, 'db' | 'lifeos'>, now: number): Promise<HealthRow[]> {
  // Signed out, the lifeos pillar's sign-in row says so: nothing here hangs on it.
  if (!ctx.lifeos.connected()) return []
  const sectors = new Set(linkedWorkspaces(ctx).map((w) => w.sector))
  if (sectors.size === 0) return []
  let sources: ChatSourceRow[]
  try {
    sources = (await ctx.lifeos.owner().query<ChatSourceRow[]>('sources:list', {})) ?? []
  } catch (err) {
    return [{ id: 'messages.sources', pillar: 'messages', group: GROUP, title: 'Chat', state: 'broken', line: `LifeOS did not list them: ${redactLine(errorText(err))}` }]
  }
  return foldAccounts(sources).flatMap((s) => chatSourceRow(s, sectors, now) ?? [])
}

export const messagesHealth: HealthSource = {
  check: (ctx) => chatRows(ctx, Date.now())
}
