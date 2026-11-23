import type { DatabaseSync } from 'node:sqlite'
import { ReviewBodySchema, type ReviewKept } from '@shared/contract-work-review'
import type { ReviewBody } from '@shared/work/review'

/**
 * The weekly review's tables (docs/agents/work-review.md "What is kept"), each additive.
 *
 *  - `work_review_weeks`: one row a week, keyed by the week's first moment. `body` is this host's part as it last
 *    answered it (`ReviewBody`, JSON). `routine_at` is when the Friday routine made it, and `seen_at` when he opened
 *    it since: a row with the first and not the second is the one `work.review.ready` names.
 *  - `work_review_marks`: his "Next week" on a held item or a meeting, and "None needed" on a meeting: the row is
 *    left out of what slipped until `until` (null: for good). A task or a waiting mail needs no mark; its own date moves.
 *  - `work_review_setup`: one row a host. `seeded_at` says the Friday routine was made once, so one he removed is
 *    never made again; `routine_id` and `workspace_id` name it for the menu's row.
 */
export function ensureReviewTables(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS work_review_weeks (
    from_at INTEGER PRIMARY KEY, to_at INTEGER NOT NULL, tz TEXT NOT NULL,
    made_at INTEGER NOT NULL, made_by TEXT NOT NULL, body TEXT NOT NULL,
    routine_at INTEGER, seen_at INTEGER)`)
  db.exec(`CREATE TABLE IF NOT EXISTS work_review_marks (
    key TEXT PRIMARY KEY, how TEXT NOT NULL, until INTEGER, at INTEGER NOT NULL)`)
  db.exec(`CREATE TABLE IF NOT EXISTS work_review_setup (
    id INTEGER PRIMARY KEY CHECK (id = 1), seeded_at INTEGER, routine_id TEXT, workspace_id TEXT)`)
}

export const REVIEW_TABLES = ['work_review_weeks', 'work_review_marks', 'work_review_setup'] as const

/** Weeks `work.review.list` answers at most. */
export const KEPT_MOST = 120

type WeekRow = { from_at: number; to_at: number; tz: string; made_at: number; made_by: string; body: string; routine_at: number | null; seen_at: number | null }

/** The kept body of the week that starts at `from`; null when there is none or it no longer parses. */
export function keptWeek(db: DatabaseSync, from: number): ReviewBody | null {
  const row = db.prepare('SELECT body FROM work_review_weeks WHERE from_at = ?').get(from) as Pick<WeekRow, 'body'> | undefined
  if (!row) return null
  try {
    const parsed = ReviewBodySchema.safeParse(JSON.parse(row.body))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

/** Keeps a week, over the one it had. `routine`: the Friday routine made it, so it is ready and not yet seen. */
export function keepWeek(db: DatabaseSync, body: ReviewBody, routine = false): void {
  db.prepare(
    `INSERT INTO work_review_weeks (from_at, to_at, tz, made_at, made_by, body, routine_at, seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
     ON CONFLICT (from_at) DO UPDATE SET to_at = excluded.to_at, tz = excluded.tz, made_at = excluded.made_at, made_by = excluded.made_by, body = excluded.body,
       routine_at = COALESCE(excluded.routine_at, routine_at), seen_at = CASE WHEN excluded.routine_at IS NULL THEN seen_at ELSE NULL END`
  ).run(body.from, body.to, body.tz, body.madeAt, body.by, JSON.stringify(body), routine ? body.madeAt : null)
}

export function keptWeeks(db: DatabaseSync): ReviewKept[] {
  const rows = db.prepare('SELECT from_at, to_at, tz, made_at, made_by FROM work_review_weeks ORDER BY from_at DESC LIMIT ?').all(KEPT_MOST) as unknown as WeekRow[]
  return rows.map((r) => ({ from: r.from_at, to: r.to_at, tz: r.tz, madeAt: r.made_at, by: r.made_by === 'routine' ? 'routine' : 'owner' }))
}

/** The newest week the routine made that he has not opened. */
export function readyWeek(db: DatabaseSync): { from: number; madeAt: number } | null {
  const row = db.prepare('SELECT from_at, routine_at FROM work_review_weeks WHERE routine_at IS NOT NULL AND seen_at IS NULL ORDER BY from_at DESC LIMIT 1').get() as Pick<WeekRow, 'from_at' | 'routine_at'> | undefined
  return row ? { from: row.from_at, madeAt: row.routine_at! } : null
}

/** He opened the week: true when that changed anything. Every older week the routine made is seen with it. */
export function seeWeek(db: DatabaseSync, from: number, now: number): boolean {
  return Number(db.prepare('UPDATE work_review_weeks SET seen_at = ? WHERE from_at <= ? AND routine_at IS NOT NULL AND seen_at IS NULL').run(now, from).changes) > 0
}

export type Mark = { key: string; how: 'later' | 'drop'; until: number | null }

/** How long a meeting put off to next week is brought back for, once its day has come. */
export const CARRIED_FOR_MS = 14 * 24 * 60 * 60_000

/**
 * The keys a mark hides at `now`. A held item's mark whose day has come is dropped as it is read: the item still
 * waits, so it is listed again by itself. A meeting's is kept a while longer (`carriedMeetings`): the meeting ended
 * in a week that is over, and nothing else would bring it back.
 */
export function hiddenKeys(db: DatabaseSync, now: number): Set<string> {
  db.prepare(`DELETE FROM work_review_marks WHERE until IS NOT NULL AND until <= ? AND (key NOT LIKE 'meeting:%' OR until <= ?)`).run(now, now - CARRIED_FOR_MS)
  return new Set((db.prepare('SELECT key FROM work_review_marks WHERE until IS NULL OR until > ?').all(now) as { key: string }[]).map((r) => r.key))
}

/** The events of the meetings he put off to "next week" whose day has come: this week's review lists them again. */
export function carriedMeetings(db: DatabaseSync, now: number): string[] {
  const rows = db.prepare(`SELECT key FROM work_review_marks WHERE key LIKE 'meeting:%' AND how = 'later' AND until IS NOT NULL AND until <= ? AND until > ?`).all(now, now - CARRIED_FOR_MS) as { key: string }[]
  return rows.map((r) => r.key.slice('meeting:'.length))
}

export function setMark(db: DatabaseSync, mark: Mark, now: number): void {
  db.prepare('INSERT INTO work_review_marks (key, how, until, at) VALUES (?, ?, ?, ?) ON CONFLICT (key) DO UPDATE SET how = excluded.how, until = excluded.until, at = excluded.at').run(mark.key, mark.how, mark.until, now)
}

/** A mark as it stands, for an undo that must put it back whole (a put-off meeting's `until` and `at` are what bring it back). */
export function markOf(db: DatabaseSync, key: string): (Mark & { at: number }) | null {
  const row = db.prepare('SELECT key, how, until, at FROM work_review_marks WHERE key = ?').get(key) as (Mark & { at: number }) | undefined
  return row ?? null
}

export function dropMark(db: DatabaseSync, key: string): void {
  db.prepare('DELETE FROM work_review_marks WHERE key = ?').run(key)
}

export type Setup = { seededAt: number | null; routineId: string | null; workspaceId: string | null }

export function setupOf(db: DatabaseSync): Setup {
  const row = db.prepare('SELECT seeded_at, routine_id, workspace_id FROM work_review_setup WHERE id = 1').get() as { seeded_at: number | null; routine_id: string | null; workspace_id: string | null } | undefined
  return { seededAt: row?.seeded_at ?? null, routineId: row?.routine_id ?? null, workspaceId: row?.workspace_id ?? null }
}

export function setSeeded(db: DatabaseSync, at: number, routineId: string, workspaceId: string): void {
  db.prepare('INSERT INTO work_review_setup (id, seeded_at, routine_id, workspace_id) VALUES (1, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET seeded_at = excluded.seeded_at, routine_id = excluded.routine_id, workspace_id = excluded.workspace_id').run(at, routineId, workspaceId)
}
