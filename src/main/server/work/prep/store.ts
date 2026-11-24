import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { emptyPrepDoc, PrepDocSchema, type PrepDoc } from '@shared/contract-work-prep'

/**
 * The prep pillar's rows (docs/agents/work-prep.md "The store"): one page per
 * event per workspace, on the workspace's host. A page belongs to the event,
 * not to a thread: it has no session column of its own and stays when a
 * thread is deleted (only the two thread ids are cleared). A row is made the
 * first time something must be kept; reading a page writes nothing.
 */
export function ensurePrepTables(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS work_prep_pages (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    event_id TEXT NOT NULL,
    series TEXT,
    title TEXT NOT NULL,
    starts_at INTEGER NOT NULL,
    ends_at INTEGER,
    people_keys TEXT NOT NULL DEFAULT '[]',
    doc TEXT NOT NULL,
    rev INTEGER NOT NULL DEFAULT 1,
    brief_session_id TEXT,
    brief_at INTEGER,
    follow_session_id TEXT,
    follow_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    suggestion_seq INTEGER NOT NULL DEFAULT 0,
    UNIQUE (workspace_id, event_id)
  )`)
  if (!db.prepare("SELECT 1 FROM pragma_table_info('work_prep_pages') WHERE name = 'suggestion_seq'").get()) {
    db.exec('ALTER TABLE work_prep_pages ADD COLUMN suggestion_seq INTEGER NOT NULL DEFAULT 0')
  }
  // The threads a later press put another in the place of, as `brief:<id>` and `follow:<id>`: their late writes are refused.
  if (!db.prepare("SELECT 1 FROM pragma_table_info('work_prep_pages') WHERE name = 'superseded'").get()) {
    db.exec("ALTER TABLE work_prep_pages ADD COLUMN superseded TEXT NOT NULL DEFAULT '[]'")
  }
  // The notes version the follow-up thread was told to write again from: until it writes with that version, an
  // outcome from its older turn is refused.
  if (!db.prepare("SELECT 1 FROM pragma_table_info('work_prep_pages') WHERE name = 'notes_owed'").get()) {
    db.exec('ALTER TABLE work_prep_pages ADD COLUMN notes_owed INTEGER')
  }
  db.exec('CREATE INDEX IF NOT EXISTS work_prep_pages_by_series ON work_prep_pages (workspace_id, series, starts_at)')
  // The Prepare-ahead routine a workspace's switch made, so the switch reads it again (and finds it gone).
  db.exec(`CREATE TABLE IF NOT EXISTS work_prep_ahead (
    workspace_id TEXT PRIMARY KEY,
    routine_id TEXT NOT NULL
  )`)
}

export interface PageRow {
  id: string
  workspaceId: string
  eventId: string
  series: string | null
  title: string
  startsAt: number
  endsAt: number | null
  /** `personKey` of everyone on the meeting when the row was last written: how a meeting with no series finds its last time */
  peopleKeys: string[]
  doc: PrepDoc
  rev: number
  suggestionSeq: number
  briefSessionId: string | null
  briefAt: number | null
  followSessionId: string | null
  followAt: number | null
  /** the brief and follow-up threads a later press replaced, `brief:<id>` and `follow:<id>`, newest last */
  superseded: string[]
  /** the notes version the follow-up thread was sent to write again from, until it has; null when none is owed */
  notesOwed: number | null
  createdAt: number
  updatedAt: number
}

/** How many replaced threads a page remembers. */
const SUPERSEDED_MAX = 40

/** Whether a later press put another thread in this one's place for that part of the page: its write is not his latest ask. */
export const supersededOn = (row: Pick<PageRow, 'superseded'> | null, kind: 'brief' | 'follow', sessionId: string): boolean => !!row?.superseded.includes(`${kind}:${sessionId}`)

/** The event as a row keeps it: enough to list the page and find its series with no LifeOS call. */
export interface PageEvent {
  id: string
  series: string | null
  title: string
  startsAt: number
  endsAt: number | null
  peopleKeys: string[]
}

export interface PageWriteOptions {
  brief?: string | null
  follow?: string | null
  suggestionSeq?: number
  /** the notes version owed by the follow-up thread (null: none); left out, it stays, unless the follow-up thread changes */
  notesOwed?: number | null
}

type Raw = {
  id: string
  workspace_id: string
  event_id: string
  series: string | null
  title: string
  starts_at: number
  ends_at: number | null
  people_keys: string
  doc: string
  rev: number
  suggestion_seq: number
  brief_session_id: string | null
  brief_at: number | null
  follow_session_id: string | null
  follow_at: number | null
  superseded: string
  notes_owed: number | null
  created_at: number
  updated_at: number
}

function json<T>(text: string, fallback: T): T {
  try {
    return JSON.parse(text) as T
  } catch {
    return fallback
  }
}

/** A stored doc, or an empty one when the row no longer parses: a page never fails to open over its own row. */
function docOf(text: string): PrepDoc {
  const parsed = PrepDocSchema.safeParse(json<unknown>(text, null))
  return parsed.success ? (parsed.data as PrepDoc) : emptyPrepDoc()
}

const rowOf = (r: Raw): PageRow => ({
  id: r.id,
  workspaceId: r.workspace_id,
  eventId: r.event_id,
  series: r.series,
  title: r.title,
  startsAt: r.starts_at,
  endsAt: r.ends_at,
  peopleKeys: json<string[]>(r.people_keys, []),
  doc: docOf(r.doc),
  rev: r.rev,
  suggestionSeq: r.suggestion_seq,
  briefSessionId: r.brief_session_id,
  briefAt: r.brief_at,
  followSessionId: r.follow_session_id,
  followAt: r.follow_at,
  superseded: json<string[]>(r.superseded, []),
  notesOwed: r.notes_owed ?? null,
  createdAt: r.created_at,
  updatedAt: r.updated_at
})

export class PrepStore {
  constructor(private readonly db: DatabaseSync) {}

  byId(id: string): PageRow | null {
    const r = this.db.prepare('SELECT * FROM work_prep_pages WHERE id = ?').get(id) as Raw | undefined
    return r ? rowOf(r) : null
  }

  get(workspaceId: string, eventId: string): PageRow | null {
    const r = this.db.prepare('SELECT * FROM work_prep_pages WHERE workspace_id = ? AND event_id = ?').get(workspaceId, eventId) as Raw | undefined
    return r ? rowOf(r) : null
  }

  /** A workspace's pages of meetings that began before `before`, newest first: where last time is looked for. */
  earlier(workspaceId: string, before: number, limit = 400): PageRow[] {
    const rows = this.db.prepare('SELECT * FROM work_prep_pages WHERE workspace_id = ? AND starts_at < ? ORDER BY starts_at DESC LIMIT ?').all(workspaceId, before, limit) as Raw[]
    return rows.map(rowOf)
  }

  /**
   * The pages of these workspaces whose meeting begins in [from, to), and each workspace's `limit` pages before
   * `from` (where a new page's last time is looked for), in one list newest first: a bounded read however many
   * meetings he has prepared.
   */
  around(workspaceIds: readonly string[], from: number, to: number, limit = 400): PageRow[] {
    if (!workspaceIds.length) return []
    const marks = workspaceIds.map(() => '?').join(', ')
    const inside = this.db.prepare(`SELECT * FROM work_prep_pages WHERE workspace_id IN (${marks}) AND starts_at >= ? AND starts_at < ?`).all(...workspaceIds, from, to) as Raw[]
    const before = workspaceIds.flatMap((id) => this.db.prepare('SELECT * FROM work_prep_pages WHERE workspace_id = ? AND starts_at < ? ORDER BY starts_at DESC LIMIT ?').all(id, from, limit) as Raw[])
    return [...inside, ...before].map(rowOf).sort((a, b) => b.startsAt - a.startsAt)
  }

  /**
   * Keeps a change to a page, making its row the first time: `start` is the
   * doc a new row begins with, `change` what this write does to it. The
   * event's own facts are written each time, so a meeting that moved is
   * listed where it is now. Bumps `rev`.
   */
  write(workspaceId: string, event: PageEvent, start: () => PrepDoc, change: (doc: PrepDoc) => PrepDoc, now: number, options: PageWriteOptions = {}): PageRow {
    const before = this.get(workspaceId, event.id)
    const doc = PrepDocSchema.parse(change(before ? before.doc : start())) as PrepDoc
    const brief = options.brief !== undefined ? { id: options.brief, at: options.brief ? now : null } : { id: before?.briefSessionId ?? null, at: before?.briefAt ?? null }
    const follow = options.follow !== undefined ? { id: options.follow, at: options.follow ? now : null } : { id: before?.followSessionId ?? null, at: before?.followAt ?? null }
    const sequence = options.suggestionSeq ?? before?.suggestionSeq ?? 0
    // A thread put out of its place by this write (a new one started, or the page let go of it) is remembered.
    const replaced = (['brief', 'follow'] as const).flatMap((kind) => {
      const was = kind === 'brief' ? before?.briefSessionId : before?.followSessionId
      const next = options[kind]
      return was && next !== undefined && next !== was ? [`${kind}:${was}`] : []
    })
    const owed = options.notesOwed !== undefined ? options.notesOwed : follow.id === (before?.followSessionId ?? null) ? (before?.notesOwed ?? null) : null
    const superseded = JSON.stringify([...(before?.superseded ?? []).filter((id) => !replaced.includes(id)), ...replaced].slice(-SUPERSEDED_MAX))
    if (before) {
      this.db
        .prepare(
          `UPDATE work_prep_pages SET series = ?, title = ?, starts_at = ?, ends_at = ?, people_keys = ?, doc = ?, rev = rev + 1,
           brief_session_id = ?, brief_at = ?, follow_session_id = ?, follow_at = ?, updated_at = ?, suggestion_seq = ?, superseded = ?, notes_owed = ? WHERE id = ?`
        )
        .run(event.series, event.title, event.startsAt, event.endsAt, JSON.stringify(event.peopleKeys), JSON.stringify(doc), brief.id, brief.at, follow.id, follow.at, now, sequence, superseded, owed, before.id)
    } else {
      this.db
        .prepare(
          `INSERT INTO work_prep_pages (id, workspace_id, event_id, series, title, starts_at, ends_at, people_keys, doc, rev, brief_session_id, brief_at, follow_session_id, follow_at, created_at, updated_at, suggestion_seq)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(`prep_${randomUUID()}`, workspaceId, event.id, event.series, event.title, event.startsAt, event.endsAt, JSON.stringify(event.peopleKeys), JSON.stringify(doc), brief.id, brief.at, follow.id, follow.at, now, now, sequence)
    }
    return this.get(workspaceId, event.id)!
  }

  /** Threads were deleted: their pages stay, without the thread. Answers the pages that changed. */
  clearSessions(sessionIds: readonly string[], now: number): PageRow[] {
    if (!sessionIds.length) return []
    const marks = sessionIds.map(() => '?').join(', ')
    const touched = this.db.prepare(`SELECT * FROM work_prep_pages WHERE brief_session_id IN (${marks}) OR follow_session_id IN (${marks})`).all(...sessionIds, ...sessionIds) as Raw[]
    if (!touched.length) return []
    this.db.prepare(`UPDATE work_prep_pages SET brief_session_id = NULL, brief_at = NULL, rev = rev + 1, updated_at = ? WHERE brief_session_id IN (${marks})`).run(now, ...sessionIds)
    this.db.prepare(`UPDATE work_prep_pages SET follow_session_id = NULL, follow_at = NULL, rev = rev + 1, updated_at = ? WHERE follow_session_id IN (${marks})`).run(now, ...sessionIds)
    return touched.map((r) => this.get(r.workspace_id, r.event_id)!)
  }

  removeWorkspace(workspaceId: string): void {
    this.db.prepare('DELETE FROM work_prep_pages WHERE workspace_id = ?').run(workspaceId)
    this.db.prepare('DELETE FROM work_prep_ahead WHERE workspace_id = ?').run(workspaceId)
  }
}
