import { randomUUID } from 'node:crypto'
import { existsSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { MediaAnchor, MediaNote, MediaProbe, MediaVersion, MediaWrite } from '@shared/contract-work-media'
import type { CanvasSource, Principal } from '@shared/work'
import { workMediaRoot } from '../../media'
import { registerMoveModule, tableMoveModule } from '../../sessionMove'

/**
 * The media pillar's rows (docs/agents/work-media.md, "The store"): one row
 * per media item (its mode and the agent's last direct write), its versions,
 * and its notes. Every table carries `session_id`, so a thread that moves
 * takes them along. What the host makes from a version (proxies, tiles, a
 * HEIC's JPEG, the frame table) is a cache under `mediaCacheDir`, made again
 * wherever it is missing.
 */

export function ensureMediaTables(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS work_media_items (
    item_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    mode TEXT NOT NULL DEFAULT 'writes',
    shared INTEGER NOT NULL DEFAULT 0,
    last_write TEXT,
    rev INTEGER NOT NULL DEFAULT 0
  )`)
  db.exec(`CREATE TABLE IF NOT EXISTS work_media_versions (
    id TEXT PRIMARY KEY,
    item_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    n INTEGER NOT NULL,
    name TEXT NOT NULL,
    source TEXT NOT NULL,
    added_at INTEGER NOT NULL,
    added_by TEXT NOT NULL,
    probe TEXT,
    error TEXT
  )`)
  db.exec(`CREATE INDEX IF NOT EXISTS work_media_versions_item ON work_media_versions (item_id, n)`)
  db.exec(`CREATE TABLE IF NOT EXISTS work_media_notes (
    id TEXT PRIMARY KEY,
    item_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    anchor TEXT NOT NULL,
    body TEXT NOT NULL,
    by TEXT NOT NULL,
    state TEXT NOT NULL,
    resolved INTEGER NOT NULL DEFAULT 0,
    parent_id TEXT,
    external TEXT,
    write_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`)
  db.exec(`CREATE INDEX IF NOT EXISTS work_media_notes_item ON work_media_notes (item_id)`)
  registerMoveModule(db, tableMoveModule('media-items', 'work_media_items'))
  registerMoveModule(db, tableMoveModule('media-versions', 'work_media_versions'))
  registerMoveModule(db, tableMoveModule('media-notes', 'work_media_notes'))
}

/**
 * Where the host keeps what it made from one version: Work's own media root
 * (`<userData>/work-media`, server/media.ts `workMediaRoot`), which the media
 * host serves from, so its URLs need no fence of their own.
 */
export const mediaCacheDir = (dataDir: string, versionId: string): string => join(workMediaRoot(dataDir), versionId.replace(/[^A-Za-z0-9_-]/g, ''))

/**
 * The cache an earlier build kept under the attachments root
 * (`<userData>/attachments/work-media`), moved once to Work's own root, or
 * dropped when that root is already there: it is all made again where it is
 * missing. Out of the attachments, the attachments' retention sweep no
 * longer walks it.
 */
export function moveOldMediaCache(dataDir: string): void {
  const old = join(dataDir, 'attachments', 'work-media')
  if (!existsSync(old)) return
  try {
    if (existsSync(workMediaRoot(dataDir))) rmSync(old, { recursive: true, force: true })
    else renameSync(old, workMediaRoot(dataDir))
  } catch (err) {
    console.error('[work] media: the old cache under attachments did not move:', err)
  }
}

type Row = Record<string, string | number | null>
const json = <T>(s: string | number | null | undefined): T | undefined => (typeof s === 'string' ? (JSON.parse(s) as T) : undefined)

export interface ItemRow {
  itemId: string
  sessionId: string
  mode: 'suggests' | 'writes'
  shared: boolean
  lastWrite?: MediaWrite
  rev: number
}
export interface VersionRow {
  id: string
  itemId: string
  n: number
  name: string
  source: CanvasSource
  addedAt: number
  addedBy: Principal
  probe?: MediaProbe
  error?: string
}
export type NoteInput = { kind?: MediaNote['kind']; anchor: MediaAnchor; body: string; by: Principal; state?: MediaNote['state']; parentId?: string; external?: MediaNote['external']; writeId?: string }

const itemOf = (r: Row): ItemRow => ({
  itemId: String(r.item_id),
  sessionId: String(r.session_id),
  mode: r.mode === 'suggests' ? 'suggests' : 'writes',
  shared: Number(r.shared) === 1,
  ...(r.last_write ? { lastWrite: json<MediaWrite>(r.last_write) } : {}),
  rev: Number(r.rev)
})
const versionOf = (r: Row): VersionRow => ({
  id: String(r.id),
  itemId: String(r.item_id),
  n: Number(r.n),
  name: String(r.name),
  source: json<CanvasSource>(r.source)!,
  addedAt: Number(r.added_at),
  addedBy: String(r.added_by) as Principal,
  ...(r.probe ? { probe: json<MediaProbe>(r.probe) } : {}),
  ...(r.error ? { error: String(r.error) } : {})
})
const noteOf = (r: Row): MediaNote => ({
  id: String(r.id),
  itemId: String(r.item_id),
  kind: r.kind === 'chapter' ? 'chapter' : 'comment',
  anchor: json<MediaAnchor>(r.anchor)!,
  body: String(r.body),
  by: String(r.by) as Principal,
  state: r.state === 'suggested' ? 'suggested' : 'kept',
  resolved: Number(r.resolved) === 1,
  ...(r.parent_id ? { parentId: String(r.parent_id) } : {}),
  ...(r.external ? { external: json<MediaNote['external']>(r.external) } : {}),
  createdAt: Number(r.created_at),
  updatedAt: Number(r.updated_at)
})

/** The rows of one database. Every write bumps the item's `rev`; the caller pushes the new view. */
export class MediaStore {
  constructor(private readonly db: DatabaseSync) {}

  item(itemId: string): ItemRow | null {
    const r = this.db.prepare(`SELECT * FROM work_media_items WHERE item_id = ?`).get(itemId) as Row | undefined
    return r ? itemOf(r) : null
  }

  /** The item's row, made on first sight with its first version: the file the canvas item names. */
  ensureItem(itemId: string, sessionId: string, first: { source: CanvasSource; name: string; by: Principal }): ItemRow {
    const have = this.item(itemId)
    if (have) return have
    this.db.prepare(`INSERT INTO work_media_items (item_id, session_id) VALUES (?, ?)`).run(itemId, sessionId)
    this.addVersion(itemId, first)
    return this.item(itemId)!
  }

  bump(itemId: string): void {
    this.db.prepare(`UPDATE work_media_items SET rev = rev + 1 WHERE item_id = ?`).run(itemId)
  }

  setMode(itemId: string, mode: ItemRow['mode']): void {
    this.db.prepare(`UPDATE work_media_items SET mode = ?, rev = rev + 1 WHERE item_id = ?`).run(mode, itemId)
  }

  setShared(itemId: string, shared: boolean): void {
    this.db.prepare(`UPDATE work_media_items SET shared = ?, rev = rev + 1 WHERE item_id = ?`).run(shared ? 1 : 0, itemId)
  }

  setLastWrite(itemId: string, write: MediaWrite | null): void {
    this.db.prepare(`UPDATE work_media_items SET last_write = ?, rev = rev + 1 WHERE item_id = ?`).run(write ? JSON.stringify(write) : null, itemId)
  }

  versions(itemId: string): VersionRow[] {
    return (this.db.prepare(`SELECT * FROM work_media_versions WHERE item_id = ? ORDER BY n`).all(itemId) as Row[]).map(versionOf)
  }

  version(id: string): VersionRow | null {
    const r = this.db.prepare(`SELECT * FROM work_media_versions WHERE id = ?`).get(id) as Row | undefined
    return r ? versionOf(r) : null
  }

  addVersion(itemId: string, v: { source: CanvasSource; name: string; by: Principal }): VersionRow {
    const item = this.db.prepare(`SELECT session_id FROM work_media_items WHERE item_id = ?`).get(itemId) as Row | undefined
    if (!item) throw new Error(`no media item ${itemId}`)
    const n = Number((this.db.prepare(`SELECT COALESCE(MAX(n), 0) AS n FROM work_media_versions WHERE item_id = ?`).get(itemId) as Row).n) + 1
    const id = randomUUID()
    this.db
      .prepare(`INSERT INTO work_media_versions (id, item_id, session_id, n, name, source, added_at, added_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, itemId, String(item.session_id), n, v.name, JSON.stringify(v.source), Date.now(), v.by)
    this.bump(itemId)
    return this.version(id)!
  }

  /** What ffprobe found, or why it failed (null clears both, for a file that changed). */
  setProbe(versionId: string, probe: MediaProbe | null, error?: string): void {
    this.db.prepare(`UPDATE work_media_versions SET probe = ?, error = ? WHERE id = ?`).run(probe ? JSON.stringify(probe) : null, error ?? null, versionId)
  }

  notes(itemId: string): MediaNote[] {
    return (this.db.prepare(`SELECT * FROM work_media_notes WHERE item_id = ? ORDER BY created_at, rowid`).all(itemId) as Row[]).map(noteOf)
  }

  note(id: string): MediaNote | null {
    const r = this.db.prepare(`SELECT * FROM work_media_notes WHERE id = ?`).get(id) as Row | undefined
    return r ? noteOf(r) : null
  }

  addNote(itemId: string, n: NoteInput): MediaNote {
    const item = this.item(itemId)
    if (!item) throw new Error(`no media item ${itemId}`)
    if (!this.version(n.anchor.versionId) || this.version(n.anchor.versionId)!.itemId !== itemId) throw new Error(`no version ${n.anchor.versionId} of this item`)
    const id = randomUUID()
    const now = Date.now()
    this.db
      .prepare(
        `INSERT INTO work_media_notes (id, item_id, session_id, kind, anchor, body, by, state, parent_id, external, write_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(id, itemId, item.sessionId, n.kind ?? 'comment', JSON.stringify(n.anchor), n.body, n.by, n.state ?? 'kept', n.parentId ?? null, n.external ? JSON.stringify(n.external) : null, n.writeId ?? null, now, now)
    this.bump(itemId)
    return this.note(id)!
  }

  editNote(id: string, patch: { body?: string; resolved?: boolean; state?: MediaNote['state']; by?: Principal }): MediaNote {
    const note = this.note(id)
    if (!note) throw new Error(`no note ${id}`)
    this.db
      .prepare(`UPDATE work_media_notes SET body = ?, resolved = ?, state = ?, by = ?, updated_at = ? WHERE id = ?`)
      .run(patch.body ?? note.body, (patch.resolved ?? note.resolved) ? 1 : 0, patch.state ?? note.state, patch.by ?? note.by, Date.now(), id)
    this.bump(note.itemId)
    return this.note(id)!
  }

  removeNote(id: string): void {
    const note = this.note(id)
    if (!note) return
    this.db.prepare(`DELETE FROM work_media_notes WHERE id = ? OR parent_id = ?`).run(id, id)
    this.bump(note.itemId)
  }

  /** The notes one direct write made: what its Undo takes back. */
  removeWrite(itemId: string, writeId: string): number {
    const made = (this.db.prepare(`SELECT id FROM work_media_notes WHERE item_id = ? AND write_id = ?`).all(itemId, writeId) as Row[]).map((r) => String(r.id))
    for (const id of made) this.db.prepare(`DELETE FROM work_media_notes WHERE parent_id = ?`).run(id)
    const r = this.db.prepare(`DELETE FROM work_media_notes WHERE item_id = ? AND write_id = ?`).run(itemId, writeId)
    this.bump(itemId)
    return Number(r.changes)
  }

  removeSessions(ids: readonly string[]): string[] {
    const versions: string[] = []
    for (const sid of ids) {
      versions.push(...(this.db.prepare(`SELECT id FROM work_media_versions WHERE session_id = ?`).all(sid) as Row[]).map((r) => String(r.id)))
      for (const t of ['work_media_items', 'work_media_versions', 'work_media_notes']) this.db.prepare(`DELETE FROM ${t} WHERE session_id = ?`).run(sid)
    }
    return versions
  }

  /** A closed Files tab's rows; answers its versions, whose prepared copies the caller forgets. */
  removeItems(itemIds: readonly string[]): string[] {
    const versions: string[] = []
    for (const id of itemIds) {
      versions.push(...(this.db.prepare(`SELECT id FROM work_media_versions WHERE item_id = ?`).all(id) as Row[]).map((r) => String(r.id)))
      for (const t of ['work_media_items', 'work_media_versions', 'work_media_notes']) this.db.prepare(`DELETE FROM ${t} WHERE item_id = ?`).run(id)
    }
    return versions
  }
}

/** A version as the wire shows it before the host has looked at the file. */
export const versionWire = (v: VersionRow, rest: Pick<MediaVersion, 'state' | 'plays'> & Partial<MediaVersion>): MediaVersion => ({
  id: v.id,
  n: v.n,
  name: v.name,
  source: v.source,
  addedAt: v.addedAt,
  addedBy: v.addedBy,
  ...(v.probe ? { probe: v.probe } : {}),
  ...rest
})
