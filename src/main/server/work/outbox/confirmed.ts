import type { DatabaseSync } from 'node:sqlite'
import type { LifeosSaid } from '@shared/contract-work-outbox'
import { errorText } from '@shared/work'
import type { WorkCtx } from '../modules'
import { refOfRow, type HeldRow } from './store'

/**
 * What LifeOS says became of a mail or calendar act the host stored as sent
 * (docs/agents/work-outbox.md "Sent, and what LifeOS says of it"). The host's
 * row is `sent` the moment LifeOS takes the act, as it always was; LifeOS then
 * holds a mail for his undo time and a calendar act until the calendar takes
 * it. This file only reads LifeOS's own row (`compose:get`, `calendarOps:get`)
 * and keeps the answer beside the row, for the attempt it was read for, so the
 * screens say "Queued in LifeOS" until LifeOS says `sent` (a calendar act's
 * `done`). It never sends, never runs an act, never claims or settles a row:
 * the hold's rows and states are store.ts's alone, and nothing here is read by
 * a press, a grant or a tell.
 */

export const READS_TABLE = 'work_outbox_lifeos_reads'
/** The reads table's own row: when this host first asked. A send decided before it was never asked about. */
const SINCE = '~since'

/**
 * How the reads go: a deadline a read; at most `rows` rows a pass and `maxOut` reads out at once; rows decided within
 * `dayMs`; every `youngEveryMs` while one is under `youngMs` old, else every `everyMs`.
 */
export const SAID_LIMITS = { readMs: 10_000, rows: 20, maxOut: 100, dayMs: 86_400_000, youngMs: 2 * 60_000, youngEveryMs: 5_000, everyMs: 30_000 }

export function ensureSaidTable(db: DatabaseSync, now = Date.now()): void {
  db.exec(`CREATE TABLE IF NOT EXISTS ${READS_TABLE} (held_id TEXT PRIMARY KEY, attempt INTEGER NOT NULL, said TEXT, read_at INTEGER NOT NULL)`)
  db.prepare(`INSERT OR IGNORE INTO ${READS_TABLE} (held_id, attempt, said, read_at) VALUES (?, 0, NULL, ?)`).run(SINCE, now)
}

/** LifeOS's own status of a row, as one of the words the screens say; null when it says nothing of an end (failed, an unknown status). */
function saidOf(table: 'outbox' | 'calendarOps', row: { status?: unknown } | null): LifeosSaid | null {
  if (!row) return 'gone'
  if (row.status === (table === 'outbox' ? 'sent' : 'done')) return 'confirmed'
  if (row.status === 'draft') return 'drafts'
  if (row.status === 'queued' || row.status === 'sending') return 'queued'
  // A failed one comes back through the watcher (`failSent`): nothing is said of it here.
  return null
}

/** A row a pass asks about, with the attempt it is asked for (`attempts`: one more for each claim). */
type Asked = { id: string; n: number; runKey: string; decidedAt: number; attempts: number }

export interface SentFact {
  lifeos: LifeosSaid
}

const TIMED_OUT = Symbol('timed out')

export class LifeosConfirmations {
  private pending: Promise<void> | null = null
  private again = false
  private next: ReturnType<typeof setTimeout> | null = null
  private on = false
  /** bumped by `stop`: an answer read under an earlier one writes nothing */
  private generation = 0
  /** rows whose read has not come back, deadline or not: never asked twice at once, and left out before a batch is picked */
  private readonly asking = new Set<string>()

  /** `changed`: the row's words changed; the screens are told (the Outbox's push). */
  constructor(private readonly deps: { ctx: WorkCtx; changed(id: string): void }) {}

  start(): void {
    this.on = true
    void this.pass()
  }

  stop(): void {
    this.on = false
    this.generation++
    if (this.next) clearTimeout(this.next)
    this.next = null
  }

  /**
   * What LifeOS says of a LifeOS-stored row the host stored as sent; undefined for any other row, and for one decided
   * before this host first asked (it reads as it always did). Anything short of LifeOS's own word that it went reads
   * queued: no answer yet, an answer for an earlier attempt, a row past the day's asking, a table that cannot be read.
   */
  fact(row: HeldRow): SentFact | undefined {
    if (row.state !== 'sent' || !row.runKey.startsWith('lifeos:') || row.decidedAt === null) return undefined
    try {
      const since = this.deps.ctx.db.prepare(`SELECT read_at FROM ${READS_TABLE} WHERE held_id = ?`).get(SINCE) as { read_at: number } | undefined
      if (since && row.decidedAt < Number(since.read_at)) return undefined
      const kept = this.deps.ctx.db.prepare(`SELECT attempt, said FROM ${READS_TABLE} WHERE held_id = ?`).get(row.id) as { attempt: number; said: LifeosSaid | null } | undefined
      return { lifeos: (kept && Number(kept.attempt) === row.attempts ? kept.said : null) ?? 'queued' }
    } catch {
      return { lifeos: 'queued' }
    }
  }

  /** One pass now. A call during a pass asks for one more pass after it, never more than one. */
  pass(): Promise<void> {
    if (!this.on) return Promise.resolve()
    if (this.pending) {
      this.again = true
      return this.pending
    }
    this.again = false
    this.pending = (async () => {
      await this.once()
      if (this.again && this.on) {
        this.again = false
        await this.once()
      }
    })()
      .catch((err: unknown) => this.deps.ctx.log(`outbox: what LifeOS says of sent acts was not read: ${errorText(err)}`))
      .finally(() => {
        this.pending = null
        this.again = false
        this.schedule()
      })
    return this.pending
  }

  /**
   * The rows a pass asks about, at most `limit`: LifeOS-stored, stored sent within a day and after this host first
   * asked, not confirmed for their current attempt, and not being asked now. Those never read for their attempt come
   * first, newest first (a press is read at once); then the least lately read.
   */
  private unconfirmed(limit: number): Asked[] {
    if (limit <= 0) return []
    const cutoff = Date.now() - SAID_LIMITS.dayMs
    const out = [...this.asking]
    const rows = this.deps.ctx.db
      .prepare(
        `SELECT h.rowid AS n, h.id, h.run_key, h.decided_at, h.attempts FROM work_held_acts h
         LEFT JOIN ${READS_TABLE} r ON r.held_id = h.id AND r.attempt = h.attempts
         WHERE h.state = 'sent' AND h.updated_at >= ? AND h.run_key LIKE 'lifeos:%' AND h.decided_at >= ?
           AND h.decided_at >= COALESCE((SELECT read_at FROM ${READS_TABLE} WHERE held_id = ?), 0)
           AND (r.said IS NULL OR r.said != 'confirmed')
           ${out.length ? `AND h.id NOT IN (${out.map(() => '?').join(', ')})` : ''}
         ORDER BY r.read_at IS NOT NULL, r.read_at, h.decided_at DESC LIMIT ?`
      )
      .all(cutoff, cutoff, SINCE, ...out, limit) as { n: number; id: string; run_key: string; decided_at: number; attempts: number }[]
    return rows.map((r) => ({ id: r.id, n: Number(r.n), runKey: r.run_key, decidedAt: Number(r.decided_at), attempts: Number(r.attempts) }))
  }

  private async once(): Promise<void> {
    const rows = this.unconfirmed(Math.min(SAID_LIMITS.rows, SAID_LIMITS.maxOut - this.asking.size))
    await Promise.all(rows.map((row) => this.ask(row)))
  }

  private async ask(row: Asked): Promise<void> {
    const ref = refOfRow(row)
    if (ref.at !== 'lifeos') return
    const generation = this.generation
    const owner = this.deps.ctx.lifeos.owner()
    this.asking.add(row.id)
    const read = (async (): Promise<LifeosSaid | null> => {
      try {
        const now =
          ref.table === 'outbox'
            ? ((await owner.query<{ row?: { status?: unknown } } | null>('compose:get', { id: ref.id }))?.row ?? null)
            : await owner.query<{ status?: unknown } | null>('calendarOps:get', { id: ref.id })
        return saidOf(ref.table, now)
      } catch (err) {
        // Out of reach, or a word LifeOS did not explain: no answer, so what it last said stands.
        this.deps.ctx.log(`outbox: could not ask LifeOS what became of item ${row.n}: ${errorText(err)}`)
        return null
      } finally {
        this.asking.delete(row.id)
      }
    })()
    let timer: ReturnType<typeof setTimeout> | null = null
    const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
      timer = setTimeout(() => resolve(TIMED_OUT), SAID_LIMITS.readMs)
      ;(timer as { unref?: () => void }).unref?.()
    })
    // Only what comes back inside the deadline counts: a read that outlives it writes nothing and tells no one.
    const answer = await Promise.race([read, deadline])
    if (timer) clearTimeout(timer)
    this.keep(row, generation, answer === TIMED_OUT ? null : answer)
  }

  /**
   * Keep that the row was read, on every outcome (an answer, an error, an unknown status, a timeout), so the order
   * rotates; and what LifeOS said, when it said something. Only for the attempt it was read for, while that attempt is
   * still the row's and still sent, and only under the generation it was read in. The screens hear of a change of word.
   */
  private keep(row: Asked, generation: number, said: LifeosSaid | null): void {
    if (!this.on || generation !== this.generation) return
    const db = this.deps.ctx.db
    const now = db.prepare(`SELECT state, attempts FROM work_held_acts WHERE id = ?`).get(row.id) as { state: string; attempts: number } | undefined
    if (now?.state !== 'sent' || Number(now.attempts) !== row.attempts) return
    const before = db.prepare(`SELECT attempt, said FROM ${READS_TABLE} WHERE held_id = ?`).get(row.id) as { attempt: number; said: LifeosSaid | null } | undefined
    const kept = before && Number(before.attempt) === row.attempts ? before.said : null
    const next = said ?? kept
    db.prepare(
      `INSERT INTO ${READS_TABLE} (held_id, attempt, said, read_at) VALUES (?, ?, ?, ?) ON CONFLICT(held_id) DO UPDATE SET attempt = excluded.attempt, said = excluded.said, read_at = excluded.read_at`
    ).run(row.id, row.attempts, next, Date.now())
    if (next !== kept) this.deps.changed(row.id)
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
