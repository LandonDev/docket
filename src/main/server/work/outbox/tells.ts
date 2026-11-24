import type { GrantOffer, OutboxItem } from '@shared/contract-work-outbox'
import { errorText, type HeldRef } from '@shared/work'
import type { Tell, TellKind } from '@shared/work/tell'
import type { ActKindDef, WorkCtx } from '../modules'
import { heldNotice } from './words'

/**
 * What the Outbox tells him, through `ctx.tell` and nothing else
 * (docs/agents/work-digest.md): a held item waits for the digest unless it
 * has a clock (an invite for an event that starts before the next one); a
 * send that failed interrupts, since he believes it went; a grant he has
 * earned waits. The Outbox raises no notice of its own.
 */

export const OUTBOX_TELLS: TellKind[] = [
  { kind: 'outbox.held', group: 'held', name: 'A held item is waiting' },
  { kind: 'outbox.failed', group: 'held', name: 'A send failed' },
  { kind: 'outbox.offer', group: 'system', name: 'A grant is offered' }
]

/** A failure older than this is no longer news he must hear at once: it waits for the digest. */
const FRESH_MS = 24 * 3_600_000

const refKey = (ref: HeldRef): string => (ref.at === 'host' ? `host:${ref.id}` : `lifeos:${ref.table}:${ref.id}`)
export const heldKey = (ref: HeldRef): string => `held:${refKey(ref)}`
/**
 * A failed send, by attempt: a press stamps the item's `decidedAt`, so a retry that fails again is a new failure he
 * hears of, and the sync retires the last attempt's row. A LifeOS item has no press here, and keeps one key.
 */
export const failedKey = (ref: HeldRef, decidedAt: number | null = null): string => `unsent:${refKey(ref)}${decidedAt != null ? `@${decidedAt}` : ''}`
export const offerKey = (id: string): string => `offer:${id}`

const oneLine = (text: string, max: number): string => {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

export interface TellsDeps {
  ctx: Pick<WorkCtx, 'tell' | 'log'>
  kindOf(kind: string): ActKindDef | undefined
  /** this host's workspaces, as the registry lists them */
  workspaces(): readonly { id: string; kind?: string | null; sector?: string | null }[]
  now?(): number
}

/** The job a tell is about: the item's own workspace when this host has one, else the host's Work workspace for its sector. */
function workspaceOf(deps: TellsDeps, item: Pick<OutboxItem, 'workspaceId' | 'sector'>): string | null {
  try {
    const work = deps.workspaces().filter((w) => w.kind === 'work')
    if (item.workspaceId && work.some((w) => w.id === item.workspaceId)) return item.workspaceId
    return (item.sector ? work.find((w) => w.sector === item.sector)?.id : null) ?? null
  } catch {
    return null
  }
}

const openOf = (item: Pick<OutboxItem, 'ref' | 'sessionId'>): Tell['open'] => ({ held: item.ref, ...(item.sessionId ? { thread: item.sessionId } : {}) })

/** When a press on the item is too late, as its kind says; undefined: it keeps. */
function byOf(deps: TellsDeps, item: Pick<OutboxItem, 'kind' | 'payload'>): number | undefined {
  const def = deps.kindOf(item.kind)
  if (!def?.by) return undefined
  try {
    const parsed = def.payload.safeParse(item.payload)
    const by = parsed.success ? def.by(parsed.data) : null
    return typeof by === 'number' && Number.isFinite(by) ? by : undefined
  } catch {
    return undefined
  }
}

/** A new held item: "Held: Send to Dana Lee: Re: budget". */
export function tellHeld(deps: TellsDeps, item: OutboxItem): void {
  if (item.state !== 'held' && item.state !== 'live') return
  const by = byOf(deps, item)
  deps.ctx.tell({ kind: 'outbox.held', workspaceId: workspaceOf(deps, item), title: heldNotice(item.summary), key: heldKey(item.ref), open: openOf(item), ...(by !== undefined ? { by } : {}) })
}

/** A send that failed and still waits on him: at once while it is fresh, in the digest once it is a day old. */
export function tellFailed(deps: TellsDeps, item: OutboxItem): void {
  if (item.state !== 'failed') return
  const at = item.decidedAt ?? item.updatedAt
  const fresh = (deps.now?.() ?? Date.now()) - at < FRESH_MS
  const key = failedKey(item.ref, item.decidedAt)
  // An earlier attempt of the same item is no longer true: it goes first, so the banner names one failure, not two.
  if (item.decidedAt != null) {
    deps.ctx.tell.only(`${failedKey(item.ref)}@`, [key])
    deps.ctx.tell.done(failedKey(item.ref))
  }
  deps.ctx.tell({
    kind: 'outbox.failed',
    workspaceId: workspaceOf(deps, item),
    title: `Not sent: ${oneLine(item.summary, 140)}`,
    ...(item.error ? { detail: oneLine(item.error, 200) } : {}),
    key,
    open: openOf(item),
    ...(fresh ? { by: at } : {})
  })
}

/** A grant he has earned, offered beside the item whose press completed the run. */
export function tellOffer(deps: TellsDeps, offer: GrantOffer): void {
  deps.ctx.tell({
    kind: 'outbox.offer',
    workspaceId: workspaceOf(deps, { workspaceId: offer.workspaceId, sector: null }),
    title: `You could stop holding ${oneLine(offer.label, 140)}`,
    detail: `You sent the last ${offer.count} as written`,
    key: offerKey(offer.id),
    open: { held: offer.from }
  })
}

export interface TellsSource {
  /** every item that waits: held, live, failed, being sent; at most `WAITING_MAX` */
  waiting(): OutboxItem[]
  offers(): GrantOffer[]
  /** which of LifeOS's lists the watcher has read since it began; null: none (Work is off) */
  lifeosLoaded(): { outbox: boolean; calendarOps: boolean } | null
}

/** How many waiting items the sync reads (outbox/ctx.ts asks for 500); a list that long may not be all of them. */
export const WAITING_MAX = 500

/**
 * The ledger made to agree with the Outbox: an item that left (sent,
 * discarded, stale, decided from another device) is done; a held item, a
 * failed send and an offer are told as they stand now (one the ledger
 * already holds in the same words changes nothing, so nothing rings twice;
 * one first read at boot, or edited to an earlier time, is told). What LifeOS
 * holds is pruned only once its watch has answered, and nothing is pruned
 * from a list that may be cut short, so a host never withdraws what still
 * waits.
 */
export function syncTells(deps: TellsDeps, source: TellsSource): void {
  try {
    const waiting = source.waiting()
    const held = waiting.filter((i) => i.state === 'held' || i.state === 'live')
    const failed = waiting.filter((i) => i.state === 'failed')
    for (const item of held) tellHeld(deps, item)
    for (const item of failed) tellFailed(deps, item)
    const offers = source.offers()
    for (const offer of offers) tellOffer(deps, offer)
    deps.ctx.tell.only('offer:', offers.map((o) => offerKey(o.id)))
    if (waiting.length >= WAITING_MAX) return
    const loaded = source.lifeosLoaded()
    const tables: [string, boolean][] = [
      ['host:', true],
      ['lifeos:outbox:', loaded?.outbox === true],
      ['lifeos:calendarOps:', loaded?.calendarOps === true]
    ]
    for (const [table, known] of tables) {
      if (!known) continue
      deps.ctx.tell.only(`held:${table}`, held.map((i) => heldKey(i.ref)))
      deps.ctx.tell.only(`unsent:${table}`, failed.map((i) => failedKey(i.ref, i.decidedAt)))
    }
  } catch (err) {
    deps.ctx.log(`outbox: what it tells was not brought up to date: ${errorText(err)}`)
  }
}
