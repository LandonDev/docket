import type { DatabaseSync } from 'node:sqlite'
import { tellWords } from '@shared/work/clashes'
import { errorText, type SectorKey } from '@shared/work/ids'
import type { Tell } from '@shared/work/tell'
import type { WorkCtx } from '../modules'
import { clashOf, homesOf, type LifeosClash, type LifeosRange } from './read'
import { hostZone, startOfDay, zoneOf } from './zone'

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
  // The later event's end, kept with the row, so a told clash is taken back at that end with no answer from LifeOS: after a restart, or while LifeOS is away.
  const columns = db.prepare('PRAGMA table_info(work_clashes_told)').all() as { name: string }[]
  if (!columns.some((c) => c.name === 'ends_at')) db.exec('ALTER TABLE work_clashes_told ADD COLUMN ends_at INTEGER')
}

/**
 * Takes back every told clash whose later event has ended, by the end kept with its row: no LifeOS read, and
 * nothing queued behind one, so a digest made after the end never says it. Nothing while Work is off, when the
 * digest takes nothing back: the rows wait for the next look.
 */
export function sweepEnded(ctx: WorkCtx, now: number): void {
  if (!ctx.enabled()) return
  const ended = ctx.db.prepare('SELECT key FROM work_clashes_told WHERE ends_at IS NOT NULL AND ends_at <= ?').all(now) as { key: string }[]
  const drop = ctx.db.prepare('DELETE FROM work_clashes_told WHERE key = ?')
  for (const { key } of ended) {
    try {
      ctx.tell.done(key)
    } catch (err) {
      ctx.log(`clashes: an ended clash was not taken back: ${errorText(err)}`)
      continue
    }
    drop.run(key)
  }
}

export const tellKey = (id: string): string => `clash:${id}`

/**
 * What a clash is told at: the tell itself, every word and field of it (both titles, the minutes short and whether
 * they are measured, the date and time, the jobs, where it opens, its deadline), so anything it says that changes
 * (a rename, a new drive, a move) updates its digest row under the same key, and nothing else tells it again. The
 * digest's own rule decides whether the update interrupts. Under the version of how a tell is made: a build that
 * tells another way raises it, and each kept clash is told once more on its first read.
 */
export const TELL_VERSION = 3
export const stampOf = (tell: Tell): string => JSON.stringify([TELL_VERSION, tell])

/** Longer than a timer waits (setTimeout's 24.8 days): the watcher looks again then, and waits on. */
const MAX_WAIT = 2 ** 31 - 1

/**
 * Where a tell opens: the Agenda on the later event, whose week holds the clash (a block of weeks starts long
 * before it). The Agenda finds the event it names through its own job's session, so the later event is named in
 * its own job's workspace when this host has one; else the earlier event in the telling workspace.
 */
function openOf(c: LifeosClash, workspaceId: string, homes: ReadonlyMap<SectorKey, string>): { view: 'agenda'; workspaceId: string; at: string } {
  const later = homes.get(c.b.sector)
  return later ? { view: 'agenda', workspaceId: later, at: c.b.eventId } : { view: 'agenda', workspaceId, at: c.a.eventId }
}

/**
 * Tells each clash not yet told at its stamp through the digest's
 * `ctx.tell`, and takes back each told one that is gone (passed, moved
 * apart, or fine by him).
 */
export function tellClashes(ctx: WorkCtx, clashes: readonly LifeosClash[], zone: string, now: number): void {
  const homes = homesOf(ctx)
  const told = new Map((ctx.db.prepare('SELECT key, stamp, ends_at AS endsAt FROM work_clashes_told').all() as { key: string; stamp: string; endsAt: number | null }[]).map((r) => [r.key, r]))
  const record = ctx.db.prepare(
    'INSERT INTO work_clashes_told (key, stamp, told_at, ends_at) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET stamp = excluded.stamp, told_at = excluded.told_at, ends_at = excluded.ends_at'
  )
  const setEnd = ctx.db.prepare('UPDATE work_clashes_told SET ends_at = ? WHERE key = ?')
  const seen = new Set<string>()
  for (const c of clashes) {
    // A pair whose later event is over is settled, as the Agenda and Today drop it: never told (its deadline has
    // passed, which the digest would take as at once), and taken back below if it was.
    if (c.b.endsAt <= now) continue
    const key = tellKey(c.id)
    seen.add(key)
    // The earlier event's job tells, on a host that holds it; the key is the same on each such host.
    const workspaceId = homes.get(c.a.sector)
    if (!workspaceId) continue
    const tell: Tell = {
      kind: 'clashes.new',
      workspaceId,
      ...tellWords(clashOf(c, homes), { timeZone: zone }),
      open: openOf(c, workspaceId, homes),
      // Too late once the later event starts. The digest's rule holds a later day's clash for the digest and
      // interrupts once its start comes before the next digest (work-digest.md): on its day, or the night before
      // for one early in the morning, however many days ahead it was found.
      by: c.b.startsAt,
      key
    }
    const stamp = stampOf(tell)
    const prev = told.get(key)
    if (prev?.stamp === stamp) {
      // Told as it is; its end is kept fresh all the same (the tell's words do not say it, a row told by the last build has none).
      if (prev.endsAt !== c.b.endsAt) setEnd.run(c.b.endsAt, key)
      continue
    }
    try {
      ctx.tell(tell)
    } catch (err) {
      ctx.log(`clashes: a clash was not told: ${errorText(err)}`)
      continue
    }
    record.run(key, stamp, now, c.b.endsAt)
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
  let expiry: ReturnType<typeof setTimeout> | null = null

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
    expire()
    roll()
  }
  /**
   * A timer of the watcher's own, set at the first end kept with a told row: the rows that have ended are taken
   * back then (`sweepEnded`), with no answer from LifeOS needed and outside the queue of its reads, so a settings
   * read that hangs holds nothing up.
   */
  const expire = (): void => {
    if (expiry) clearTimeout(expiry)
    expiry = null
    if (stopped) return
    const at = now()
    const next = (ctx.db.prepare('SELECT MIN(ends_at) AS next FROM work_clashes_told WHERE ends_at > ?').get(at) as { next: number | null } | undefined)?.next
    if (next == null) return
    expiry = setTimeout(() => {
      expiry = null
      if (stopped) return
      try {
        sweepEnded(ctx, now())
      } catch (err) {
        ctx.log(`clashes: the watch failed: ${errorText(err)}`)
      }
      expire()
    }, Math.min(next - at, MAX_WAIT))
    expiry.unref?.()
  }
  const subscribe = (): void => {
    off?.()
    const mine = ++generation
    off = ctx.lifeos.subscribe<LifeosRange | null>('clashes:range', { from, to: startOfDay(from + SPAN_DAYS * DAY + DAY / 2, zone) }, (range) => {
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

  // What ended while the host was down goes before anything else, and the rest wait on their timer.
  sweepEnded(ctx, now())
  expire()
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
    if (expiry) clearTimeout(expiry)
    off?.()
    off = null
  }
}
