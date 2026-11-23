import { lstatSync, readdirSync } from 'node:fs'
import { basename, join, relative } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { fileDocName } from 'work-kit/collab-server'
import type { CanvasSource } from '@shared/work'
import type { WorkCtx } from '../modules'
import { fileMovedHooks } from './hooks'

/**
 * Rename and move carry what hangs on a file (docs/agents/work-files.md "New, rename, move and copy"). A file's
 * canvas items, his star, its recent and its tab, a document's comments and mode, and every row a kind's pillar
 * keeps by the file's path follow it to its new name, in one step: all of it lands or none does. A rename made
 * outside TempCode carries none of this.
 *
 * The caller moves the file on disk first and calls `fileMoved` second; when this throws, the database is as it
 * was and the caller moves the file back.
 */

/** One end of a move: the path on this host and the key Files keeps it by (`refKey`, a library's key for a file in one). */
export interface MovedEnd {
  path: string
  key: string
}

/** What a move changed, to say once it has landed. */
export interface MovedResult {
  /** canvas owners (threads, a Files pane) whose items were re-pointed */
  owners: string[]
  /** workspaces whose tabs changed, with their new revision */
  tabs: { workspaceId: string; rev: number }[]
}

const SAVEPOINT = 'work_files_moved'
/** The most files under a renamed folder whose own rows are carried one by one (a document's comments, a pillar's hook). */
const FOLDER_FILES_MAX = 50_000

const hasTable = (db: DatabaseSync, table: string): boolean => (db.prepare(`SELECT count(*) AS n FROM pragma_table_info(?)`).get(table) as { n: number }).n > 0

/** The separator a path's children are written with: a guest path in the Windows VM uses `\`. */
const sepOf = (path: string): string => (path.includes('\\') && !path.includes('/') ? '\\' : '/')
/** A key's children are the key and a separator: a library's key is the place and a path inside it written with `/`. */
const keySep = (key: string, path: string): string => (key.startsWith('lib:') ? '/' : sepOf(path))

/** `value` re-pointed from `from` to `to` when it is `from` or under it; null when it is neither. */
function under(value: string, from: string, to: string, sep: string): string | null {
  if (value === from) return to
  return value.startsWith(`${from}${sep}`) ? `${to}${value.slice(from.length)}` : null
}

/** A source re-pointed when it names the moved thing or something under it, on this host; null when it names neither. */
export function movedSource(source: CanvasSource, host: string, from: string, to: string): CanvasSource | null {
  const sep = sepOf(from)
  if (source.at === 'file' && source.host === host) {
    const path = under(source.path, from, to, sep)
    return path === null ? null : { ...source, path }
  }
  if (source.at === 'microsoft' && source.host === host && source.ref.kind === 'path') {
    const path = under(source.ref.path, from, to, sep)
    if (path === null) return null
    // The file itself was renamed: the name it is shown by follows.
    return { ...source, ...(source.ref.path === from ? { name: basename(to) } : {}), ref: { kind: 'path', path } }
  }
  return null
}

/** The files under a moved folder, each as its old and new path: what is keyed one file at a time. Links are not followed. */
function filesUnder(from: string, to: string): [string, string][] {
  const out: [string, string][] = []
  const queue = [to]
  for (let i = 0; i < queue.length && out.length < FOLDER_FILES_MAX; i++) {
    for (const entry of readdirSync(queue[i], { withFileTypes: true })) {
      const path = join(queue[i], entry.name)
      if (entry.isDirectory()) queue.push(path)
      else if (entry.isFile()) out.push([join(from, relative(to, path)), path])
    }
  }
  return out
}

/** Every row of `table` whose `source` JSON names the moved thing, re-pointed. Answers the ids it changed with each row's owner, where the table says one. */
function repointSources(db: DatabaseSync, table: string, id: string, host: string, from: string, to: string, extra: { title?: boolean; rev?: boolean; owner?: string } = {}): { id: string; owner: string | null }[] {
  if (!hasTable(db, table)) return []
  const changed: { id: string; owner: string | null }[] = []
  // A cheap first cut: the path's last name in the JSON text; each row is then parsed and compared whole.
  const hint = `%${JSON.stringify(basename(from)).slice(1, -1).replace(/[%_\\]/g, (c) => `\\${c}`)}%`
  const rows = db.prepare(`SELECT ${id} AS id, source${extra.title ? ', title' : ''}${extra.owner ? `, ${extra.owner} AS owner` : ''} FROM ${table} WHERE source LIKE ? ESCAPE '\\'`).all(hint) as { id: string; source: string | null; title?: string; owner?: string }[]
  const now = Date.now()
  for (const row of rows) {
    let source: CanvasSource
    try {
      source = JSON.parse(row.source ?? 'null') as CanvasSource
    } catch {
      continue
    }
    if (!source || typeof source !== 'object') continue
    const next = movedSource(source, host, from, to)
    if (!next) continue
    const sets = ['source = ?']
    const args: (string | number)[] = [JSON.stringify(next)]
    if (extra.title && canvasPath(source) === from && row.title === basename(from)) {
      sets.push('title = ?')
      args.push(basename(to))
    }
    if (extra.rev) sets.push('rev = rev + 1', `updated_at = ${now}`)
    db.prepare(`UPDATE ${table} SET ${sets.join(', ')} WHERE ${id} = ?`).run(...args, row.id)
    changed.push({ id: row.id, owner: row.owner ?? null })
  }
  return changed
}

const canvasPath = (s: CanvasSource): string | null => (s.at === 'file' ? s.path : s.at === 'microsoft' && s.ref.kind === 'path' ? s.ref.path : null)

/** A path inside a mark's or tab's JSON re-pointed: `{ file: source }`, `{ folder: FolderRef }`, or a page `{ at: FolderRef }`. */
function movedJson(json: string, host: string, from: string, to: string): string | null {
  let value: { file?: CanvasSource; folder?: { at: string; host?: string; path?: string }; at?: { at: string; host?: string; path?: string }; name?: string }
  try {
    value = JSON.parse(json)
  } catch {
    return null
  }
  if (!value || typeof value !== 'object') return null
  const sep = sepOf(from)
  if (value.file) {
    const next = movedSource(value.file, host, from, to)
    return next ? JSON.stringify({ ...value, file: next }) : null
  }
  for (const k of ['folder', 'at'] as const) {
    const ref = value[k]
    if (ref && ref.at === 'file' && ref.host === host && typeof ref.path === 'string') {
      const path = under(ref.path, from, to, sep)
      if (path === null) return null
      return JSON.stringify({ ...value, [k]: { ...ref, path }, ...(k === 'at' && ref.path === from && value.name === basename(from) ? { name: basename(to) } : {}) })
    }
  }
  return null
}

/** His marks follow: a star and a recent are one row by the file's key, re-keyed with what they point at. */
function moveMarks(db: DatabaseSync, host: string, from: MovedEnd, to: MovedEnd): void {
  const sep = keySep(from.key, from.path)
  const rows = db.prepare(`SELECT workspace_id, ref_key, ref, name FROM work_files_marks WHERE ref_key = ? OR substr(ref_key, 1, ?) = ?`).all(from.key, from.key.length + 1, `${from.key}${sep}`) as { workspace_id: string; ref_key: string; ref: string; name: string }[]
  for (const row of rows) {
    const key = under(row.ref_key, from.key, to.key, sep)!
    const ref = movedJson(row.ref, host, from.path, to.path) ?? row.ref
    const name = row.ref_key === from.key && row.name === basename(from.path) ? basename(to.path) : row.name
    // A row already under the new key (a mark on a file since gone from there) gives way to the one that moved.
    if (key !== row.ref_key) db.prepare(`DELETE FROM work_files_marks WHERE workspace_id = ? AND ref_key = ?`).run(row.workspace_id, key)
    db.prepare(`UPDATE work_files_marks SET ref_key = ?, ref = ?, name = ? WHERE workspace_id = ? AND ref_key = ?`).run(key, ref, name, row.workspace_id, row.ref_key)
  }
}

/** The tabs follow: a file tab's key and its name, a page tab that stands in or on the moved folder. Answers the workspaces whose tabs changed. */
function moveTabs(db: DatabaseSync, host: string, from: MovedEnd, to: MovedEnd): string[] {
  const sep = keySep(from.key, from.path)
  const changed = new Set<string>()
  const rows = db.prepare(`SELECT workspace_id, id, kind, page FROM work_files_tabs`).all() as { workspace_id: string; id: string; kind: string; page: string }[]
  const set = db.prepare(`UPDATE work_files_tabs SET page = ?, updated_at = ? WHERE workspace_id = ? AND id = ?`)
  for (const row of rows) {
    let next: string | null = null
    if (row.kind === 'file') {
      let page: { key?: string; name?: string; side?: { itemId: string; key: string; name: string } }
      try {
        page = JSON.parse(row.page)
      } catch {
        continue
      }
      const key = typeof page?.key === 'string' ? under(page.key, from.key, to.key, sep) : null
      // The file at the tab's side follows the same way.
      const sideKey = typeof page?.side?.key === 'string' ? under(page.side.key, from.key, to.key, sep) : null
      if (key === null && sideKey === null) continue
      next = JSON.stringify({
        ...page,
        ...(key !== null ? { key, ...(page.key === from.key && page.name === basename(from.path) ? { name: basename(to.path) } : {}) } : {}),
        ...(sideKey !== null && page.side ? { side: { ...page.side, key: sideKey, ...(page.side.key === from.key && page.side.name === basename(from.path) ? { name: basename(to.path) } : {}) } } : {})
      })
    } else next = movedJson(row.page, host, from.path, to.path)
    if (next === null || next === row.page) continue
    set.run(next, Date.now(), row.workspace_id, row.id)
    changed.add(row.workspace_id)
  }
  return [...changed]
}

/** The documents pillar's rows by a `.tcdoc`'s path (`fileDocName`): its comment threads and its mode. Read here by name; a table that is not there is skipped. */
const DOCS_TABLES = ['work_docs_threads', 'work_docs_mode'] as const
function moveDocs(db: DatabaseSync, pairs: readonly [string, string][]): void {
  for (const table of DOCS_TABLES) {
    if (!hasTable(db, table)) continue
    const set = db.prepare(`UPDATE OR REPLACE ${table} SET doc = ? WHERE doc = ?`)
    for (const [a, b] of pairs) set.run(fileDocName(b), fileDocName(a))
  }
}

/**
 * Carries everything that hangs on a moved file or folder, in one savepoint: every registered pillar's hook
 * (`registerFileMoved`, once per file: a folder's files each), the documents pillar's rows, the source of every
 * canvas item that names it or lies under it (and a media version's or a meeting's recording), his marks and the
 * tabs. Call it after the disk move; a throw leaves the database as it was, and the caller moves the file back.
 * Once it lands, the owners' canvas lists and the tabs' new revisions are said.
 */
export function fileMoved(ctx: Pick<WorkCtx, 'db' | 'dataDir' | 'host' | 'canvas' | 'push' | 'log'>, from: MovedEnd, to: MovedEnd, guest?: { folder: boolean }): MovedResult {
  const { db, host } = ctx
  // A thing in the Windows VM (`guest`) is no path of this disk: what it is comes from the helper's answer, and a
  // folder's files are carried by their paths' prefix alone (no hook or document row is kept by a file there).
  const folder = guest ? guest.folder : lstatSync(to.path).isDirectory()
  const pairs: [string, string][] = folder ? (guest ? [] : filesUnder(from.path, to.path)) : [[from.path, to.path]]
  const file = (path: string): CanvasSource => ({ at: 'file', host, path })
  db.exec(`SAVEPOINT ${SAVEPOINT}`)
  let result: MovedResult
  try {
    for (const hook of fileMovedHooks()) for (const [a, b] of pairs) hook(file(a), file(b), { db, dataDir: ctx.dataDir, host })
    moveDocs(db, pairs)
    const items = repointSources(db, 'work_canvas_items', 'id', host, from.path, to.path, { title: true, rev: true, owner: 'session_id' })
    repointSources(db, 'work_media_versions', 'id', host, from.path, to.path)
    repointSources(db, 'work_meetings', 'item_id', host, from.path, to.path)
    moveMarks(db, host, from, to)
    // Go to's names for the old key go, in every workspace that listed it; the folder's next listing names it anew.
    if (hasTable(db, 'work_files_names')) {
      const under = `${from.key.replace(/[\\%_]/g, (c) => `\\${c}`)}${keySep(from.key, from.path) === '\\' ? '\\\\' : '/'}%`
      db.prepare(`DELETE FROM work_files_names WHERE ref_key = ? OR ref_key LIKE ? ESCAPE '\\'`).run(from.key, under)
    }
    const tabs = moveTabs(db, host, from, to).map((workspaceId) => {
      db.prepare(`INSERT INTO work_files_revs (workspace_id, rev) VALUES (?, 1) ON CONFLICT (workspace_id) DO UPDATE SET rev = rev + 1`).run(workspaceId)
      return { workspaceId, rev: (db.prepare(`SELECT rev FROM work_files_revs WHERE workspace_id = ?`).get(workspaceId) as { rev: number }).rev }
    })
    result = { owners: [...new Set(items.flatMap((i) => i.owner ?? []))], tabs }
    db.exec(`RELEASE ${SAVEPOINT}`)
  } catch (err) {
    db.exec(`ROLLBACK TO ${SAVEPOINT}`)
    db.exec(`RELEASE ${SAVEPOINT}`)
    throw err
  }
  for (const owner of result.owners) {
    try {
      ctx.canvas.announce(owner)
    } catch (err) {
      ctx.log(`files: a moved file's canvas push failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  for (const { workspaceId, rev } of result.tabs) {
    try {
      ctx.push({ push: 'work.files', workspaceId, tabs: rev }, { need: 'read' })
    } catch (err) {
      ctx.log(`files: the tabs push failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return result
}
