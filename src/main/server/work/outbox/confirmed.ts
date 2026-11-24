import type { DatabaseSync } from 'node:sqlite'
import type { LifeosSaid } from '@shared/contract-work-outbox'
import { errorText } from '@shared/work'
import type { WorkCtx } from '../modules'
import { refOfRow, type HeldRow } from './store'

/**
 * What LifeOS says became of a mail or calendar act the host stored as sent
 * (docs/agents/work-outbox.md "Sent, and what LifeOS says of it"). The host's
 * row is `sent` the moment LifeOS takes the act, as it always was; LifeOS then
 * holds a mail for its undo time and a calendar act until the calendar takes
 * it. This file only reads LifeOS's own row (`compose:get`, `calendarOps:get`)
 * and keeps the answer beside the row, so the screens can say "Queued in
 * LifeOS" until LifeOS says `sent` (a calendar act's `done`). It never sends,
 * never runs an act, never claims or settles a row: the hold's rows and states
 * are store.ts's alone, and nothing here is read by a press.
 */

export const SAID_TABLE = 'work_outbox_lifeos_said'

/** How each pass reads: a deadline a read, at most `rows` rows, rows decided within a day; often while one is young. */
export const SAID_LIMITS = { readMs: 10_000, rows: 20, dayMs: 86_400_000, youngMs: 2 * 60_000, youngEveryMs: 5_000, everyMs: 30_000 }

export function ensureSaidTable(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS ${SAID_TABLE} (held_id TEXT PRIMARY KEY, said TEXT NOT NULL, read_at INTEGER NOT NULL)`)
}

/** LifeOS's own status of a row, as one of the words the screens say; null while it says nothing of an end (queued, sending, failed, unknown). */
function saidOf(table: 'outbox' | 'calendarOps', row: { status?: unknown } | null): LifeosSaid | null {
  if (!row) return 'gone'
  if (row.status === (table === 'outbox' ? 'sent' : 'done')) return 'confirmed'
  if (row.status === 'draft') return 'drafts'
  if (row.status === 'queued' || row.status === 'sending') return 'queued'
  // A failed one comes back through the watcher (`failSent`): nothing is said of it here.
  return null
}

/** A row a pass asks about. */
type Asked = { id: string; n: number; runKey: string; decidedAt: number }

export interface SentFact {
  lifeos: LifeosSaid
  /** while queued: when LifeOS last said so (the decision, before it was first read) */
  queuedAsOf?: number
}

export class LifeosConfirmations {
  private pending: Promise<void> | null = null
  private more = false
  private next: ReturnType<typeof setTimeout> | null = null
  private on = false
  /** rows whose last read has not come back: never asked twice at once, so a hung read holds one row, not the pass */
  private readonly asking = new Set<string>()

  /** `changed`: the row's words changed; the screens are told (the Outbox's push). */
  constructor(private readonly deps: { ctx: WorkCtx; changed(id: string): void }) {}

  start(): void {
    this.on = true
    void this.pass()
  }

  stop(): void {
    this.on = false
    if (this.next) clearTimeout(this.next)
    this.next = null
  }

  /**
   * What LifeOS says of a LifeOS-stored row the host stored as sent; undefined for any other row, and for one decided
   * more than a day ago that was never read (a send from before this was asked: it reads as it always did).
   */
  fact(row: HeldRow): SentFact | undefined {
    if (row.state !== 'sent' || !row.runKey.startsWith('lifeos:') || row.decidedAt === null) return undefined
    let kept: { said: LifeosSaid; read_at: number } | undefined
    try {
      kept = this.deps.ctx.db.prepare(`SELECT said, read_at FROM ${SAID_TABLE} WHERE held_id = ?`).get(row.id) as typeof kept
    } catch {
      return undefined
    }
    if (!kept) return Date.now() - row.decidedAt < SAID_LIMITS.dayMs ? { lifeos: 'queued', queuedAsOf: row.decidedAt } : undefined
    return kept.said === 'queued' ? { lifeos: 'queued', queuedAsOf: Number(kept.read_at) } : { lifeos: kept.said }
  }

  /** One read of each row still unconfirmed, newest first, at most `rows`, each under its deadline. One pass at a time. */
  pass(): Promise<void> {
    if (this.pending) {
      this.more = true
      return this.pending
    }
    const run = async (): Promise<void> => {
      do {
        this.more = false
        await this.once()
      } while (this.more && this.on)
    }
    this.pending = run()
      .catch((err: unknown) => this.deps.ctx.log(`outbox: what LifeOS says of sent acts was not read: ${errorText(err)}`))
      .finally(() => {
        this.pending = null
        this.schedule()
      })
    return this.pending
  }

  /**
   * The rows a pass asks about: LifeOS-stored, stored sent within a day, not yet confirmed. Those never read come first,
   * newest first (a press is read at once); then the least lately read, so rows stuck queued never starve the rest.
   */
  private unconfirmed(limit: number): Asked[] {
    const rows = this.deps.ctx.db
      .prepare(
        `SELECT h.rowid AS n, h.id, h.run_key, h.decided_at FROM work_held_acts h LEFT JOIN ${SAID_TABLE} s ON s.held_id = h.id
         WHERE h.state = 'sent' AND h.run_key LIKE 'lifeos:%' AND h.decided_at >= ? AND (s.said IS NULL OR s.said != 'confirmed')
         ORDER BY s.read_at IS NOT NULL, s.read_at, h.decided_at DESC LIMIT ?`
      )
      .all(Date.now() - SAID_LIMITS.dayMs, limit) as { n: number; id: string; run_key: string; decided_at: number }[]
    return rows.map((r) => ({ id: r.id, n: Number(r.n), runKey: r.run_key, decidedAt: Number(r.decided_at) }))
  }

  private async once(): Promise<void> {
    const rows = this.unconfirmed(SAID_LIMITS.rows).filter((row) => !this.asking.has(row.id))
    await Promise.all(rows.map((row) => this.ask(row)))
  }

  private async ask(row: Asked): Promise<void> {
    const ref = refOfRow(row)
    if (ref.at !== 'lifeos') return
    const owner = this.deps.ctx.lifeos.owner()
    this.asking.add(row.id)
    const read = (async () => {
      try {
        const now =
          ref.table === 'outbox'
            ? ((await owner.query<{ row?: { status?: unknown } } | null>('compose:get', { id: ref.id }))?.row ?? null)
            : await owner.query<{ status?: unknown } | null>('calendarOps:get', { id: ref.id })
        return { said: saidOf(ref.table, now) }
      } catch (err) {
        // Out of reach, or a word LifeOS did not explain: what it last said stands.
        this.deps.ctx.log(`outbox: could not ask LifeOS what became of item ${row.n}: ${errorText(err)}`)
        return null
      } finally {
        this.asking.delete(row.id)
      }
    })()
    let timer: ReturnType<typeof setTimeout> | null = null
    const late = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), SAID_LIMITS.readMs)
      ;(timer as { unref?: () => void }).unref?.()
    })
    const answer = await Promise.race([read, late])
    if (timer) clearTimeout(timer)
    if (!answer?.said) return
    this.keep(row, answer.said)
  }

  /** Keep what LifeOS said, and tell the screens when the words change: queued by the minute of its age, or an end. */
  private keep(row: Asked, said: LifeosSaid): void {
    const before = this.deps.ctx.db.prepare(`SELECT said, read_at FROM ${SAID_TABLE} WHERE held_id = ?`).get(row.id) as { said: string; read_at: number } | undefined
    const at = Date.now()
    this.deps.ctx.db.prepare(`INSERT INTO ${SAID_TABLE} (held_id, said, read_at) VALUES (?, ?, ?) ON CONFLICT(held_id) DO UPDATE SET said = excluded.said, read_at = excluded.read_at`).run(row.id, said, at)
    const minute = (readAt: number) => Math.floor((readAt - row.decidedAt) / 60_000)
    if (before?.said === said && (said !== 'queued' || minute(Number(before.read_at)) === minute(at))) return
    this.deps.changed(row.id)
  }

  private schedule(): void {
    if (this.next) clearTimeout(this.next)
    this.next = null
    if (!this.on) return
    let rows: Asked[]
    try {
      rows = this.unconfirmed(SAID_LIMITS.rows)
    } catch (err) {
      // The hold's tables are not on this host: nothing to ask.
      return void this.deps.ctx.log(`outbox: what LifeOS says of sent acts was not read: ${errorText(err)}`)
    }
    if (!rows.length) return
    const young = rows.some((row) => Date.now() - row.decidedAt < SAID_LIMITS.youngMs)
    this.next = setTimeout(() => void this.pass(), young ? SAID_LIMITS.youngEveryMs : SAID_LIMITS.everyMs)
    ;(this.next as { unref?: () => void }).unref?.()
  }
}
