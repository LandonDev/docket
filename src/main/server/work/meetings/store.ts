import { statSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { Meeting, MeetingAction, MeetingNote, MeetingProgress, MeetingSpeaker, MeetingStatus } from '@shared/contract-work-meetings'
import { MEETING_STATUSES } from '@shared/contract-work-meetings'
import { CanvasSourceSchema, type CanvasSource } from '@shared/work'
import { attachmentDir } from '../../attachmentDir'
import type { DocSegment } from './merge'

/**
 * A meeting's row (`work_meetings`, docs/agents/work-meetings.md "What is
 * kept"). One per canvas item of kind `meeting`, named by the item's id.
 * The transcript, the speakers and the notes are one JSON document in the
 * row; the small copy the player plays is a file in the thread's
 * attachment directory, named here by its file name.
 */

/** The notes as kept: the wire's notes without what is worked out when they are read. */
export interface StoredNotes {
  summary: MeetingNote[]
  decisions: MeetingNote[]
  questions: MeetingNote[]
  actions: MeetingAction[]
  writtenAt: number
}

/** The document in a meeting's row. */
export interface MeetingDoc {
  speakers: Omit<MeetingSpeaker, 'suggested'>[]
  segments: DocSegment[]
  notes: StoredNotes | null
  /** The notes before the agent's last write, for Undo; absent when there is nothing to put back. */
  before?: { notes: StoredNotes | null }
}

export const emptyDoc = (): MeetingDoc => ({ speakers: [], segments: [], notes: null })

export interface MeetingRow {
  itemId: string
  sessionId: string
  workspaceId: string | null
  title: string
  status: MeetingStatus
  /** the file it was made from, on this host */
  source: Extract<CanvasSource, { at: 'file' }> | null
  origin: 'recording' | 'transcript' | null
  mediaKind: 'audio' | 'video' | null
  durationSec: number
  progress: MeetingProgress | null
  error: string | null
  engine: string | null
  peaks: number[]
  /** the playback copy's file name in the thread's attachment directory */
  audio: string | null
  doc: MeetingDoc
  rev: number
  createdAt: number
  updatedAt: number
  transcribedAt: number | null
}

interface Raw {
  item_id: string
  session_id: string
  workspace_id: string | null
  title: string
  status: string
  source: string | null
  origin: string | null
  media_kind: string | null
  duration: number
  progress: string | null
  error: string | null
  engine: string | null
  peaks: string | null
  audio: string | null
  doc: string
  rev: number
  created_at: number
  updated_at: number
  transcribed_at: number | null
}

export function ensureMeetingTables(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS work_meetings (
    item_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, workspace_id TEXT,
    title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'empty',
    source TEXT, origin TEXT, media_kind TEXT, duration REAL NOT NULL DEFAULT 0,
    progress TEXT, error TEXT, engine TEXT, peaks TEXT, audio TEXT,
    doc TEXT NOT NULL DEFAULT '{}',
    rev INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, transcribed_at INTEGER)`)
  db.exec(`CREATE INDEX IF NOT EXISTS work_meetings_by_session ON work_meetings (session_id)`)
}

const json = <T>(text: string | null, fallback: T): T => {
  if (!text) return fallback
  try {
    return JSON.parse(text) as T
  } catch {
    return fallback
  }
}

function rowOf(raw: Raw): MeetingRow {
  const source = CanvasSourceSchema.safeParse(json<unknown>(raw.source, null))
  const doc = json<Partial<MeetingDoc>>(raw.doc, {})
  return {
    itemId: raw.item_id,
    sessionId: raw.session_id,
    workspaceId: raw.workspace_id,
    title: raw.title,
    status: (MEETING_STATUSES as readonly string[]).includes(raw.status) ? (raw.status as MeetingStatus) : 'failed',
    source: source.success && source.data.at === 'file' ? source.data : null,
    origin: raw.origin === 'recording' || raw.origin === 'transcript' ? raw.origin : null,
    mediaKind: raw.media_kind === 'audio' || raw.media_kind === 'video' ? raw.media_kind : null,
    durationSec: raw.duration ?? 0,
    progress: json<MeetingProgress | null>(raw.progress, null),
    error: raw.error,
    engine: raw.engine,
    peaks: json<number[]>(raw.peaks, []),
    audio: raw.audio,
    doc: { speakers: doc.speakers ?? [], segments: doc.segments ?? [], notes: doc.notes ?? null, ...(doc.before ? { before: doc.before } : {}) },
    rev: raw.rev,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
    transcribedAt: raw.transcribed_at
  }
}

/** What a write may change. */
export type MeetingPatch = Partial<Omit<MeetingRow, 'itemId' | 'sessionId' | 'rev' | 'createdAt' | 'updatedAt'>>

const COLUMN: Record<keyof MeetingPatch, [column: string, toSql: (v: never) => string | number | null]> = {
  workspaceId: ['workspace_id', (v: string | null) => v],
  title: ['title', (v: string) => v],
  status: ['status', (v: string) => v],
  source: ['source', (v: unknown) => (v ? JSON.stringify(v) : null)],
  origin: ['origin', (v: string | null) => v],
  mediaKind: ['media_kind', (v: string | null) => v],
  durationSec: ['duration', (v: number) => v],
  progress: ['progress', (v: unknown) => (v ? JSON.stringify(v) : null)],
  error: ['error', (v: string | null) => v],
  engine: ['engine', (v: string | null) => v],
  peaks: ['peaks', (v: number[]) => JSON.stringify(v)],
  audio: ['audio', (v: string | null) => v],
  doc: ['doc', (v: MeetingDoc) => JSON.stringify(v)],
  transcribedAt: ['transcribed_at', (v: number | null) => v]
}

export class MeetingStore {
  constructor(private readonly db: DatabaseSync) {}

  get(itemId: string): MeetingRow | null {
    const raw = this.db.prepare(`SELECT * FROM work_meetings WHERE item_id = ?`).get(itemId) as Raw | undefined
    return raw ? rowOf(raw) : null
  }

  /** The meeting of an item, made empty when it has none. */
  ensure(item: { id: string; sessionId: string; workspaceId: string | null; title: string }): MeetingRow {
    const now = Date.now()
    this.db
      .prepare(`INSERT OR IGNORE INTO work_meetings (item_id, session_id, workspace_id, title, status, doc, rev, created_at, updated_at) VALUES (?, ?, ?, ?, 'empty', ?, 0, ?, ?)`)
      .run(item.id, item.sessionId, item.workspaceId, item.title, JSON.stringify(emptyDoc()), now, now)
    return this.get(item.id)!
  }

  /** One write: the named fields, `rev` up by one. Answers the row after it; null when the meeting is gone. */
  patch(itemId: string, patch: MeetingPatch): MeetingRow | null {
    const sets: string[] = []
    const values: (string | number | null)[] = []
    for (const [key, value] of Object.entries(patch) as [keyof MeetingPatch, never][]) {
      if (value === undefined) continue
      const [column, toSql] = COLUMN[key]
      sets.push(`${column} = ?`)
      values.push(toSql(value))
    }
    this.db.prepare(`UPDATE work_meetings SET ${[...sets, 'rev = rev + 1', 'updated_at = ?'].join(', ')} WHERE item_id = ?`).run(...values, Date.now(), itemId)
    return this.get(itemId)
  }

  /** Meetings left mid-transcription by a process that is gone. */
  transcribing(): MeetingRow[] {
    return (this.db.prepare(`SELECT * FROM work_meetings WHERE status = 'transcribing'`).all() as unknown as Raw[]).map(rowOf)
  }

  forSessions(ids: readonly string[]): MeetingRow[] {
    const q = this.db.prepare(`SELECT * FROM work_meetings WHERE session_id = ?`)
    return ids.flatMap((id) => (q.all(id) as unknown as Raw[]).map(rowOf))
  }

  removeSessions(ids: readonly string[]): void {
    const st = this.db.prepare(`DELETE FROM work_meetings WHERE session_id = ?`)
    for (const id of ids) st.run(id)
  }

  removeItems(itemIds: readonly string[]): void {
    const st = this.db.prepare(`DELETE FROM work_meetings WHERE item_id = ?`)
    for (const id of itemIds) st.run(id)
  }
}

/** Where a meeting's playback copy sits: the thread's own attachment directory, which a move carries and the path fence admits. */
export function audioPathOf(row: Pick<MeetingRow, 'sessionId' | 'audio'>): string | null {
  if (!row.audio || /[\\/]/.test(row.audio)) return null
  try {
    return join(attachmentDir(row.sessionId), row.audio)
  } catch {
    return null
  }
}

/** The meeting as a client reads it. `suggested` names a voice's guess per speaker id; the words' times and the undo copy stay here. */
export function meetingOf(row: MeetingRow, host: string, suggested: ReadonlyMap<string, string> = new Map()): Meeting {
  const audioPath = audioPathOf(row)
  let audio: { path: string; bytes: number } | undefined
  if (audioPath) {
    try {
      audio = { path: audioPath, bytes: statSync(audioPath).size }
    } catch {
      /* gone: the transcript still reads */
    }
  }
  const notes = row.doc.notes
  return {
    itemId: row.itemId,
    sessionId: row.sessionId,
    title: row.title,
    status: row.status,
    rev: row.rev,
    from: row.origin,
    ...(row.status === 'transcribing' && row.progress ? { progress: row.progress } : {}),
    ...(row.status === 'failed' ? { error: row.error ?? 'It stopped before it finished.' } : {}),
    durationSec: row.durationSec,
    ...(row.mediaKind ? { media: { kind: row.mediaKind, host, ...(audio ? { audio } : {}) } } : {}),
    peaks: row.peaks,
    speakers: row.doc.speakers.map((s) => ({ ...s, ...(s.name === null && suggested.has(s.id) ? { suggested: suggested.get(s.id)! } : {}) })),
    segments: row.doc.segments.map(({ id, speaker, start, end, text }) => ({ id, speaker, start, end, text })),
    notes: notes ? { ...notes, canUndo: row.doc.before !== undefined } : null,
    ...(row.transcribedAt ? { transcribedAt: row.transcribedAt } : {})
  }
}
