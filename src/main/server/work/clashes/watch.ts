import type { DatabaseSync } from 'node:sqlite'
import { tellWords } from '@shared/work/clashes'
import { errorText } from '@shared/work/ids'
import type { WorkCtx } from '../modules'
import { clashOf, homesOf, type LifeosClash, type LifeosRange } from './read'
import { hostZone, sameDay, startOfDay, zoneOf } from './zone'

/**
 * The watcher: the next fourteen days of clashes, live from LifeOS. Each
 * change is pushed (`work.clashes`) and each new clash told once through
 * the digest, from the host that holds the earlier event's job.
 */

const DAY = 86_400_000
export const SPAN_DAYS = 14
/** How often the watcher looks whether his day has turned. */
const ROLL_MS = 5 * 60_000

export function ensureClashes(db: DatabaseSync): void {
  db.exec('CREATE TABLE IF NOT EXISTS work_clashes_told (key TEXT PRIMARY KEY, stamp TEXT NOT NULL, told_at INTEGER NOT NULL)')
}

export const tellKey = (id: string): string => `clash:${id}`

/** What a clash is told at: both events' times and place text. A moved event tells again. */
export const stampOf = (c: LifeosClash): string => JSON.stringify([c.a.startsAt, c.a.endsAt, c.a.location ?? '', c.b.startsAt, c.b.endsAt, c.b.location ?? ''])

/**
 * Tells each clash not yet told at its stamp through the digest's
 * `ctx.tell`, and takes back each told one that is gone (passed, moved
 * apart, or fine by him).
 */
export function tellClashes(ctx: WorkCtx, clashes: readonly LifeosClash[], zone: string, now: number): void {
  const homes = homesOf(ctx)
  const told = new Map((ctx.db.prepare('SELECT key, stamp FROM work_clashes_told').all() as { key: string; stamp: string }[]).map((r) => [r.key, r.stamp]))
  const record = ctx.db.prepare('INSERT INTO work_clashes_told (key, stamp, told_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET stamp = excluded.stamp, told_at = excluded.told_at')
  const seen = new Set<string>()
  for (const c of clashes) {
    const key = tellKey(c.id)
    seen.add(key)
    // The earlier event's job tells, on a host that holds it; the key is the same on each such host.
    const workspaceId = homes.get(c.a.sector)
    const stamp = stampOf(c)
    if (!workspaceId || told.get(key) === stamp) continue
    const words = tellWords(clashOf(c, homes), { timeZone: zone })
    try {
      ctx.tell({
        kind: 'clashes.new',
        workspaceId,
        ...words,
        open: { view: 'agenda', workspaceId, at: c.a.eventId },
        // Today's clash cannot wait for the next digest; a later day's can.
        ...(sameDay(c.b.startsAt, now, zone) ? { by: c.b.startsAt } : {}),
        key
      })
    } catch (err) {
      ctx.log(`clashes: a clash was not told: ${errorText(err)}`)
      continue
    }
    record.run(key, stamp, now)
  }
  const drop = ctx.db.prepare('DELETE FROM work_clashes_told WHERE key = ?')
  for (const key of told.keys()) {
    if (seen.has(key)) continue
    try {
      ctx.tell.done(key)
    } catch (err) {
      ctx.log(`clashes: a gone clash was not taken back: ${errorText(err)}`)
      continue
    }
    drop.run(key)
  }
}

/** Starts the watcher; its return stops it. `now` is for a test. */
export function watchClashes(ctx: WorkCtx, now: () => number = Date.now): () => void {
  let zone = hostZone()
  let from = startOfDay(now(), zone)
  let generation = 0
  let off: (() => void) | null = null
  let last = ''
  let chain: Promise<void> = Promise.resolve()
  let stopped = false

  const onRange = async (range: LifeosRange | null, mine: number): Promise<void> => {
    if (stopped || mine !== generation || !ctx.enabled() || !range || !Array.isArray(range.clashes)) return
    const seen = JSON.stringify(range)
    if (seen !== last) {
      last = seen
      ctx.push({ push: 'work.clashes' }, { need: 'read' })
    }
    zone = await zoneOf(ctx)
    if (stopped || mine !== generation) return
    tellClashes(ctx, range.clashes, zone, now())
    roll()
  }
  const subscribe = (): void => {
    off?.()
    const mine = ++generation
    off = ctx.lifeos.subscribe<LifeosRange | null>('clashes:range', { from, to: from + SPAN_DAYS * DAY }, (range) => {
      chain = chain.then(() => onRange(range, mine)).catch((err: unknown) => ctx.log(`clashes: the watch failed: ${errorText(err)}`))
    })
  }
  /** A new day of his reads a new fourteen days. */
  const roll = (): void => {
    if (stopped) return
    const day = startOfDay(now(), zone)
    if (day === from) return
    from = day
    subscribe()
  }

  subscribe()
  void zoneOf(ctx).then((z) => {
    zone = z
    roll()
  })
  const timer = setInterval(roll, ROLL_MS)
  timer.unref?.()
  return () => {
    stopped = true
    clearInterval(timer)
    off?.()
    off = null
  }
}
