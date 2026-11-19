import type { DatabaseSync } from 'node:sqlite'
import { errorText } from '@shared/work'
import type { WorkCtx, WorkModule } from '../modules'
import { calendarWords, CalendarOpPayloadSchema } from '../outbox/lifeosHeld'

/**
 * The agenda pillar's server module (docs/agents/work-agenda.md). The Agenda
 * view reads LifeOS itself; `calendar.op` is held and sent by the hold
 * (outbox/lifeosHeld.ts). What is left here: a hold on his own calendar that
 * invites no one runs at once in LifeOS (`plain: true`, milestone 24), so it
 * is never held, and this module records it as a Result of the thread that
 * made it, once.
 */

/** The row that holds when this host first watched: acts made before it are not this module's to record. */
const SINCE = '~since'

/** Plain acts already recorded: LifeOS lists an act again on every change. */
export function ensureAgenda(db: DatabaseSync): void {
  db.exec('CREATE TABLE IF NOT EXISTS work_agenda_results (op_id TEXT PRIMARY KEY, at INTEGER NOT NULL)')
  db.prepare('INSERT OR IGNORE INTO work_agenda_results (op_id, at) VALUES (?, ?)').run(SINCE, Date.now())
}

interface OpRow {
  _id: string
  _creationTime?: number
  plain?: boolean
  status?: string
  origin?: { host?: string; threadId?: string }
  [key: string]: unknown
}

/** Records each plain act this host's threads made as a Result of its thread; true for each one recorded now. */
export function recordPlain(ctx: WorkCtx, rows: readonly OpRow[]): string[] {
  const done: string[] = []
  const known = ctx.db.prepare('SELECT 1 FROM work_agenda_results WHERE op_id = ?')
  const mark = ctx.db.prepare('INSERT OR IGNORE INTO work_agenda_results (op_id, at) VALUES (?, ?)')
  const since = (ctx.db.prepare('SELECT at FROM work_agenda_results WHERE op_id = ?').get(SINCE) as { at: number } | undefined)?.at ?? 0
  for (const row of rows) {
    // Only once it went: a plain hold sits queued until Google takes it, and a queued one may yet fail.
    if (row.plain !== true || row.status !== 'done') continue
    if (typeof row._creationTime === 'number' && row._creationTime < since) continue
    const threadId = row.origin?.threadId
    // Only this host's own threads, and only one it still has: a Result belongs to a thread here.
    if (row.origin?.host !== ctx.host || !threadId || !ctx.scopeOf(threadId)) continue
    if (known.get(row._id)) continue
    const payload = CalendarOpPayloadSchema.safeParse({ ...row, id: row._id })
    if (!payload.success) continue
    const summary = calendarWords(payload.data).summary.replace(/^Add /, 'Added ')
    ctx.results.add({
      sessionId: threadId,
      kind: 'calendar.op',
      summary,
      ...(typeof row.account === 'string' ? { account: row.account } : {}),
      ref: { at: 'lifeos', table: 'calendarOps', id: row._id }
    })
    mark.run(row._id, Date.now())
    done.push(row._id)
  }
  return done
}

export const agenda: WorkModule = {
  id: 'agenda',
  ensure: ensureAgenda,
  start(ctx) {
    // The newest acts as the owner reads them; a plain hold is among them for as long as it matters.
    return ctx.lifeos.subscribe<OpRow[] | null>('calendarOps:list', { limit: 50 }, (rows) => {
      try {
        recordPlain(ctx, rows ?? [])
      } catch (err) {
        ctx.log(`agenda: a plain calendar hold could not be recorded: ${errorText(err)}`)
      }
    })
  }
}
