import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { canvasSourcePath, type CanvasItem, type CanvasKind, type CanvasSource } from '@shared/work'
import { refKey } from '@shared/work/files'
import { tableMoveModule, type MoveModule } from '../../sessionMove'

/**
 * Marks kept by the file, not by the item (docs/agents/work-files.md "Marks kept by the file"). A pillar that
 * keeps rows over an item's file (the PDF's fields and highlights, a video's notes) adds a `file_key` column to
 * each of its tables: the item's workspace and its file's `refKey`. Two items of one workspace on one file (a
 * Files tab's and a thread's) then read and write one set of rows, kept under one of them, the keeper. An item
 * with no file, or no workspace, keeps its rows by its own id as before (`file_key` is '').
 *
 * The key only finds rows: every read still comes through an item the caller may open, and the key holds the
 * workspace, so an item of another workspace on the same file never finds them.
 */

/** A pillar's tables: `items` has one row per item (`item_id` its key), `rows` the rest. Each has `item_id`, `session_id` and `file_key`. */
export interface FileKeyed {
  kind: CanvasKind
  items: string
  rows: readonly string[]
  /** Gives a row of a table whose rows have ids of their own new ids (`fresh`), for a copy that leaves while the rows stay. */
  renumber?: Record<string, (row: Row, fresh: (old: string) => string) => Row>
}
type Row = Record<string, string | number | null>
const tablesOf = (spec: FileKeyed): string[] => [spec.items, ...spec.rows]

/** The key an item's rows are found by: its workspace and its file's `refKey`; null for an item with no file or no workspace. */
export function fileKeyOf(item: Pick<CanvasItem, 'workspaceId' | 'source'>): string | null {
  if (!item.workspaceId || canvasSourcePath(item.source) === null) return null
  return JSON.stringify([item.workspaceId, refKey(item.source)])
}

/** The same for a `work_canvas_items` row. */
function keyOfRow(row: { workspace_id: string | null; source: string }): string | null {
  try {
    return fileKeyOf({ workspaceId: row.workspace_id, source: JSON.parse(row.source) as CanvasSource })
  } catch {
    return null
  }
}

const hasTable = (db: DatabaseSync, table: string): boolean => (db.prepare(`SELECT count(*) AS n FROM pragma_table_info(?)`).get(table) as { n: number }).n > 0
const hasColumn = (db: DatabaseSync, table: string, column: string): boolean => (db.prepare(`SELECT count(*) AS n FROM pragma_table_info(?) WHERE name = ?`).get(table, column) as { n: number }).n > 0

/**
 * Adds `file_key` to each table, and fills it where it is still empty (rows from before it, or from an older
 * build): from the item's row in the canvas, '' when the item names no file or is gone. When that leaves two
 * items keeping rows for one file, the newest keeps the file's and the others keep theirs apart, by item, as
 * before. Only adds: an older build reads the tables as it did.
 */
export function ensureFileKeys(db: DatabaseSync, spec: FileKeyed): void {
  for (const table of tablesOf(spec)) {
    if (!hasColumn(db, table, 'file_key')) db.exec(`ALTER TABLE ${table} ADD COLUMN file_key TEXT`)
    db.exec(`CREATE INDEX IF NOT EXISTS ${table}_by_file ON ${table} (file_key)`)
  }
  if (!hasTable(db, 'work_canvas_items')) return
  const canvas = db.prepare(`SELECT workspace_id, source FROM work_canvas_items WHERE id = ?`)
  const filled = new Set<string>()
  for (const table of tablesOf(spec)) {
    const set = db.prepare(`UPDATE ${table} SET file_key = ? WHERE item_id = ? AND file_key IS NULL`)
    for (const { item_id } of db.prepare(`SELECT DISTINCT item_id FROM ${table} WHERE file_key IS NULL`).all() as { item_id: string }[]) {
      const row = canvas.get(item_id) as { workspace_id: string | null; source: string } | undefined
      const key = row ? keyOfRow(row) : null
      set.run(key ?? '', item_id)
      if (key) filled.add(key)
    }
  }
  for (const key of filled) {
    const holders = db.prepare(`SELECT item_id FROM ${spec.items} WHERE file_key = ? ORDER BY rowid DESC`).all(key) as { item_id: string }[]
    for (const { item_id } of holders.slice(1)) for (const table of tablesOf(spec)) db.prepare(`UPDATE ${table} SET file_key = '' WHERE item_id = ?`).run(item_id)
  }
}

/** The item whose rows an item reads and writes, with the session they are kept under and the key a new row of it takes. */
export interface Kept {
  id: string
  sessionId: string
  fileKey: string
}

/**
 * Where an item's rows are kept: its own, when it has rows (an item with no file, or one kept apart since before
 * the key); else the keeper's of its file; else its own, made with the file's key on first write.
 */
export function keptOf(db: DatabaseSync, spec: FileKeyed, item: Pick<CanvasItem, 'id' | 'sessionId' | 'workspaceId' | 'source'>): Kept {
  const own = db.prepare(`SELECT session_id, file_key FROM ${spec.items} WHERE item_id = ?`).get(item.id) as { session_id: string; file_key: string | null } | undefined
  if (own) return { id: item.id, sessionId: own.session_id, fileKey: own.file_key ?? '' }
  const key = fileKeyOf(item)
  if (!key) return { id: item.id, sessionId: item.sessionId, fileKey: '' }
  const keeper = db.prepare(`SELECT item_id, session_id FROM ${spec.items} WHERE file_key = ? ORDER BY rowid DESC LIMIT 1`).get(key) as { item_id: string; session_id: string } | undefined
  return keeper ? { id: keeper.item_id, sessionId: keeper.session_id, fileKey: key } : { id: item.id, sessionId: item.sessionId, fileKey: key }
}

/** An item of the canvas that shares the file's rows and is none of `gone`: open ones first, the newest first. One that keeps rows of its own is passed over. */
function heirOf(db: DatabaseSync, spec: FileKeyed, key: string, gone: { items: Set<string>; sessions: Set<string> }): { id: string; sessionId: string } | null {
  if (!hasTable(db, 'work_canvas_items')) return null
  const [workspaceId] = JSON.parse(key) as [string, string]
  const rows = db.prepare(`SELECT id, session_id, workspace_id, source FROM work_canvas_items WHERE workspace_id = ? AND kind = ? ORDER BY state = 'open' DESC, updated_at DESC`).all(workspaceId, spec.kind) as { id: string; session_id: string; workspace_id: string | null; source: string }[]
  const owns = db.prepare(`SELECT 1 FROM ${spec.items} WHERE item_id = ?`)
  for (const row of rows) {
    if (gone.items.has(row.id) || gone.sessions.has(row.session_id) || keyOfRow(row) !== key || owns.get(row.id)) continue
    return { id: row.id, sessionId: row.session_id }
  }
  return null
}

/**
 * Items that went (a tab closed, a thread deleted or moved away): the rows each kept for its file pass to another
 * item of the workspace on that file, else they go; then whatever else these threads kept goes. Answers the
 * items whose rows went.
 */
export function dropKept(db: DatabaseSync, spec: FileKeyed, gone: { items?: readonly string[]; sessions?: readonly string[] }): string[] {
  const g = { items: new Set(gone.items ?? []), sessions: new Set(gone.sessions ?? []) }
  const of = db.prepare(`SELECT item_id, file_key FROM ${spec.items} WHERE item_id = ?`)
  const bySession = db.prepare(`SELECT item_id, file_key FROM ${spec.items} WHERE session_id = ?`)
  const keepers = [...[...g.items].flatMap((id) => (of.get(id) as { item_id: string; file_key: string | null } | undefined) ?? []), ...[...g.sessions].flatMap((sid) => bySession.all(sid) as { item_id: string; file_key: string | null }[])]
  const dropped: string[] = []
  for (const k of keepers) {
    const heir = k.file_key ? heirOf(db, spec, k.file_key, g) : null
    for (const table of tablesOf(spec)) {
      if (heir) db.prepare(`UPDATE ${table} SET item_id = ?, session_id = ? WHERE item_id = ?`).run(heir.id, heir.sessionId, k.item_id)
      else db.prepare(`DELETE FROM ${table} WHERE item_id = ?`).run(k.item_id)
    }
    if (!heir) dropped.push(k.item_id)
  }
  // Rows of these items or threads with no row in `items` (none is made that way now; an older build made some).
  for (const table of tablesOf(spec)) {
    for (const id of g.items) db.prepare(`DELETE FROM ${table} WHERE item_id = ?`).run(id)
    for (const sid of g.sessions) db.prepare(`DELETE FROM ${table} WHERE session_id = ?`).run(sid)
  }
  return dropped
}

/** A file renamed or moved on this host: its rows follow, in every workspace. Rows a gone file left under the new name give way. */
export function moveFileKeys(db: DatabaseSync, spec: FileKeyed, from: CanvasSource, to: CanvasSource): void {
  if (!hasColumn(db, spec.items, 'file_key')) return
  const was = refKey(from)
  const next = refKey(to)
  const tail = JSON.stringify(was).replace(/[\\%_]/g, (c) => `\\${c}`)
  const keys = new Set<string>()
  for (const table of tablesOf(spec)) {
    for (const { file_key } of db.prepare(`SELECT DISTINCT file_key FROM ${table} WHERE file_key LIKE ? ESCAPE '\\'`).all(`%,${tail}]`) as { file_key: string }[]) {
      const [workspaceId, key] = JSON.parse(file_key) as [string, string]
      if (key === was) keys.add(JSON.stringify([workspaceId, next]))
    }
  }
  for (const key of keys) {
    const [workspaceId] = JSON.parse(key) as [string, string]
    for (const table of tablesOf(spec)) {
      db.prepare(`UPDATE ${table} SET file_key = '' WHERE file_key = ?`).run(key)
      db.prepare(`UPDATE ${table} SET file_key = ? WHERE file_key = ?`).run(key, JSON.stringify([workspaceId, was]))
    }
  }
}

/**
 * A pillar's table as a move module (sessionMove.ts): a moving thread takes the rows of its items, its own and
 * those another item keeps for a file it holds too, and once it has gone the rows it kept pass to an item that
 * stays (`dropKept`). A row that stays here as well leaves with new ids (`renumber`), so the two copies never
 * clash if the thread comes back. The key is not carried: the receiver fills it at its next start.
 */
export function fileKeyedMoveModule(id: string, table: string, spec: FileKeyed): MoveModule {
  const base = tableMoveModule(id, table)
  return {
    ...base,
    rows(host, ids) {
      const db = host.db
      const moving = new Set(ids)
      const items = hasTable(db, 'work_canvas_items') ? db.prepare(`SELECT id, session_id, workspace_id, source FROM work_canvas_items WHERE session_id = ? AND kind = ?`) : null
      const own = db.prepare(`SELECT * FROM ${table} WHERE item_id = ?`)
      const out: Row[] = []
      const seen = new Set<string>()
      for (const sid of ids) {
        for (const item of (items?.all(sid, spec.kind) ?? []) as { id: string; session_id: string; workspace_id: string | null; source: string }[]) {
          seen.add(item.id)
          const kept = keptOf(db, spec, { id: item.id, sessionId: item.session_id, workspaceId: item.workspace_id, source: JSON.parse(item.source) as CanvasSource })
          // Rows another moving item keeps ride with that item.
          if (kept.id !== item.id && moving.has(kept.sessionId)) continue
          // A copy stays here when the rows are another's, or when another item on the file will take them.
          const stays = kept.fileKey !== '' && (kept.id !== item.id || heirOf(db, spec, kept.fileKey, { items: new Set(), sessions: moving }) !== null)
          const fresh = (old: string): string => createHash('sha256').update(`${item.id}:${old}`).digest('hex').slice(0, 32)
          for (const row of own.all(kept.id) as Row[]) {
            const moved: Row = { ...row, item_id: item.id, session_id: sid, file_key: null }
            out.push(stays && spec.renumber?.[table] ? spec.renumber[table](moved, fresh) : moved)
          }
        }
      }
      // Rows of these threads that no item of theirs reaches (an item that is gone): as before.
      for (const row of base.rows!(host, ids) as Row[]) if (!seen.has(String(row.item_id))) out.push({ ...row, file_key: null })
      return out
    },
    drop(host, ids) {
      dropKept(host.db, spec, { sessions: ids })
    }
  }
}
