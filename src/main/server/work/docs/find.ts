import type { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { fileDocName } from 'work-kit/collab-server'
import type { CanvasItem, CanvasSource } from '@shared/work'
import { FIND_KINDS, kindOfFile, kindOfMime, queryTerms, snippetOf, type FindBy, type FindEntry, type FindKind, type FindSpec, type SavedFindView } from '@shared/work/docFind'
import type { FindAnswer } from '@shared/contract-work-docs'
import type { Caller, WorkCtx } from '../modules'
import { GuestStore } from '../guests/store'
import { HELD_TABLE } from '../outbox/store'
import { canonicalPath } from '../service/ctx'
import { fileRows } from './threads'

/**
 * Finding documents (docs/agents/work-docs.md "Finding documents"): one list
 * of what a Work workspace holds, for the Docs view, the agent's `doc_find`
 * and anyone who wants a document by name. Three places, each searched where
 * its text lives:
 *
 * - LifeOS: its `catalog:list` (documents and sheets of the sector with who
 *   last changed each, open threads and waiting suggestions) and
 *   `catalog:search` (Convex's full-text index over a document's plain text).
 * - The workspace's folder: walked here, its files' kinds by extension; a
 *   `.tcdoc`'s text read through the Work service and a `.csv`'s from disk,
 *   kept in memory by path and change time.
 * - The canvas items of the workspace's threads that live elsewhere: Google,
 *   Microsoft, and what a thread made (forms, dashboards). Titles only.
 *
 * Titles are matched by the caller over the entries (`findIn`); `hits` are
 * the text matches with the words around each.
 */

/** How deep and how wide the folder walk goes. */
const WALK_DEPTH = 4
const WALK_MOST = 2000
/** How many files' text a search reads, and how much of each. */
const TEXT_MOST = 200
const TEXT_BYTES = 512 * 1024
/** A folder walk is kept this long, so typing does not walk it again. */
const WALK_FRESH_MS = 10_000

interface CatalogRow {
  table: 'docs' | 'sheets'
  id: string
  title: string
  projectId?: string
  shared: boolean
  editedAt: number
  createdAt: number
  lastBy?: FindBy
  openThreads: number
  waiting: number
}

interface FileRow {
  path: string
  kind: FindKind
  editedAt: number
  createdAt: number
}

// Keyed by the host's database, as docs/state.ts keeps its state.
const walks = new WeakMap<object, Map<string, { at: number; files: FileRow[]; complete: boolean }>>()
const texts = new WeakMap<object, Map<string, { mtime: number; text: string }>>()
const cacheOf = <T>(map: WeakMap<object, Map<string, T>>, key: object): Map<string, T> => {
  let m = map.get(key)
  if (!m) map.set(key, (m = new Map()))
  return m
}

/** The files under a folder whose kind a canvas opens: hidden folders and dependencies skipped, bounded in depth and count. */
export async function walkFolder(root: string): Promise<{ files: FileRow[]; complete: boolean }> {
  const files: FileRow[] = []
  let complete = true
  const visit = async (dir: string, depth: number): Promise<void> => {
    let names: import('node:fs').Dirent[]
    try {
      names = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of names) {
      if (files.length >= WALK_MOST) {
        complete = false
        return
      }
      if (e.name.startsWith('.') || e.name.startsWith('~$')) continue
      const path = join(dir, e.name)
      if (e.isDirectory()) {
        if (e.name === 'node_modules') continue
        if (depth < WALK_DEPTH) await visit(path, depth + 1)
        continue
      }
      const kind = e.isFile() ? kindOfFile(e.name) : null
      if (!kind) continue
      try {
        const s = await stat(path)
        files.push({ path, kind, editedAt: Math.round(s.mtimeMs), createdAt: Math.round(s.birthtimeMs || s.ctimeMs) })
      } catch {
        // Gone between the listing and the look: not there.
      }
    }
  }
  await visit(root, 0)
  return { files, complete }
}

async function folderFiles(ctx: WorkCtx, root: string): Promise<{ files: FileRow[]; complete: boolean }> {
  const cache = cacheOf(walks, ctx.db)
  const kept = cache.get(root)
  if (kept && Date.now() - kept.at < WALK_FRESH_MS) return kept
  const walked = { at: Date.now(), ...(await walkFolder(root)) }
  cache.set(root, walked)
  return walked
}

/** A file's text for a search: a `.tcdoc` through the Work service, a `.csv` from disk; '' for any other kind or a read that failed. */
async function fileText(ctx: WorkCtx, f: FileRow): Promise<string> {
  const ext = f.path.slice(f.path.lastIndexOf('.') + 1).toLowerCase()
  if (ext !== 'tcdoc' && ext !== 'csv') return ''
  const cache = cacheOf(texts, ctx.db)
  const kept = cache.get(f.path)
  if (kept && kept.mtime === f.editedAt) return kept.text
  let text = ''
  try {
    if (ext === 'csv') text = (await readFile(f.path, 'utf8')).slice(0, TEXT_BYTES)
    else {
      const got = (await ctx.service.internal('/internal/docs/read', { file: f.path, shared: false, fence: { sectors: 'all' } })) as { markdown?: string }
      text = (got.markdown ?? '').slice(0, TEXT_BYTES)
    }
  } catch {
    return ''
  }
  cache.set(f.path, { mtime: f.editedAt, text })
  return text
}

/** Open comment threads of a `.tcdoc`, from the host's own thread rows. */
function fileComments(db: DatabaseSync, path: string): number {
  try {
    return fileRows(db, fileDocName(path)).filter((r) => !r.thread.resolved && r.thread.deletedAt === null).length
  } catch {
    return 0
  }
}

/** What a canvas item's source keys to, so a file the folder walk found and the same file open in a thread are one entry. */
export function keyOf(source: CanvasSource, itemId?: string): string {
  if (source.at === 'lifeos') return `lifeos:${source.table}:${source.id}`
  if (source.at === 'file') return `file:${source.path}`
  if (source.at === 'google') return `google:${source.fileId}`
  if (source.at === 'microsoft') return `microsoft:${source.ref.kind === 'path' ? source.ref.path : source.ref.url}`
  return `item:${itemId ?? ''}`
}

/** An item a thread holds that lives outside LifeOS and the folder, as an entry. */
function itemEntry(item: CanvasItem): FindEntry | null {
  const s = item.source
  if (!(FIND_KINDS as readonly string[]).includes(item.kind)) return null
  if (s.at !== 'google' && s.at !== 'microsoft' && s.at !== 'thread' && s.at !== 'file') return null
  const kind = (s.at === 'google' ? kindOfMime(s.mime) : null) ?? (item.kind as FindKind)
  return {
    key: keyOf(s, item.id),
    title: item.title,
    kind,
    where: s.at === 'file' ? 'folder' : s.at,
    source: s,
    sessionId: item.sessionId,
    editedAt: item.updatedAt,
    createdAt: item.createdAt,
    shared: s.at === 'google' || s.at === 'microsoft',
    guest: false,
    comments: 0,
    waiting: 0,
    held: 0
  }
}

/** Held acts that name an entry: an act still waiting (or failed) whose payload holds its id, path or file id. */
function heldCounts(db: DatabaseSync, workspaceId: string, sector: string | null, entries: FindEntry[]): void {
  let payloads: string[]
  try {
    payloads = (
      db.prepare(`SELECT payload FROM ${HELD_TABLE} WHERE state IN ('held', 'failed') AND (workspace_id = ? OR (sector IS NOT NULL AND sector = ?))`).all(workspaceId, sector ?? '') as { payload: string }[]
    ).map((r) => r.payload)
  } catch {
    return
  }
  if (!payloads.length) return
  for (const e of entries) {
    const s = e.source
    const needle = s.at === 'lifeos' ? s.id : s.at === 'file' ? JSON.stringify(s.path).slice(1, -1) : s.at === 'google' ? s.fileId : null
    if (needle) e.held = payloads.filter((p) => p.includes(needle)).length
  }
}

/** The live guest links' items, as `table:id`. */
function guestKeys(db: DatabaseSync): Set<string> {
  try {
    return new Set(new GuestStore(db).live().map((l) => `lifeos:${l.source.table}:${l.source.id}`))
  } catch {
    return new Set()
  }
}

interface WorkspaceRow {
  path: string
  sector: string | null
  kind: string | null
}

export function workspaceOf(ctx: WorkCtx, workspaceId: string): WorkspaceRow {
  const row = ctx.db.prepare('SELECT path, sector, kind FROM workspaces WHERE id = ?').get(workspaceId) as WorkspaceRow | undefined
  if (!row || row.kind !== 'work') throw new Error('no such Work workspace')
  return row
}

/**
 * Everything a Work workspace lists, and with `query` what is written inside that matches.
 * A remote key that cannot reach the folder is shown none of its files.
 */
export async function findDocs(ctx: WorkCtx, by: Caller, o: { workspaceId: string; query?: string }): Promise<FindAnswer> {
  const ws = workspaceOf(ctx, o.workspaceId)
  const terms = queryTerms(o.query ?? '')
  const entries = new Map<string, FindEntry>()
  const hits: FindAnswer['hits'] = []
  let complete = true
  let projects: FindAnswer['projects'] = []
  let lifeos: string | undefined

  // LifeOS first: its rows are the ones most likely asked for.
  const sector = ws.sector
  const lifeosPart = (async () => {
    if (!sector) return
    if (!ctx.lifeos.connected()) {
      lifeos = 'LifeOS is not signed in on this host'
      return
    }
    try {
      const q = ctx.lifeos.owner()
      const [catalog, list, found] = await Promise.all([
        q.query<{ rows: CatalogRow[]; complete: boolean }>('catalog:list', { sector }),
        q.query<{ _id: string; name: string }[]>('projects:list', { sector }),
        terms.length ? q.query<{ table: 'docs'; id: string; snippet: string }[]>('catalog:search', { sector, text: terms.join(' ') }) : Promise.resolve([])
      ])
      const guests = guestKeys(ctx.db)
      for (const r of catalog.rows) {
        const key = `lifeos:${r.table}:${r.id}`
        entries.set(key, {
          key,
          title: r.title,
          kind: r.table === 'docs' ? 'document' : 'sheet',
          where: 'lifeos',
          source: { at: 'lifeos', table: r.table, id: r.id },
          ...(r.projectId ? { projectId: r.projectId } : {}),
          editedAt: r.editedAt,
          createdAt: r.createdAt,
          shared: r.shared,
          guest: guests.has(key),
          ...(r.lastBy ? { lastBy: r.lastBy } : {}),
          comments: r.openThreads,
          waiting: r.waiting,
          held: 0
        })
      }
      complete &&= catalog.complete
      projects = list.map((p) => ({ id: p._id, name: p.name }))
      for (const h of found) if (h.snippet) hits.push({ key: `lifeos:${h.table}:${h.id}`, snippet: h.snippet })
    } catch (err) {
      lifeos = err instanceof Error ? err.message : String(err)
    }
  })()

  const folder = canonicalPathOr(ws.path)
  const folderPart = (async () => {
    if (!folder || !ctx.reaches(by, folder)) return
    const walked = await folderFiles(ctx, folder)
    complete &&= walked.complete
    for (const f of walked.files) {
      const key = `file:${f.path}`
      entries.set(key, {
        key,
        title: basename(f.path).replace(/\.tcdoc$/i, ''),
        kind: f.kind,
        where: 'folder',
        source: { at: 'file', host: ctx.host, path: f.path },
        editedAt: f.editedAt,
        createdAt: f.createdAt,
        shared: false,
        guest: false,
        comments: f.path.toLowerCase().endsWith('.tcdoc') ? fileComments(ctx.db, f.path) : 0,
        waiting: 0,
        held: 0
      })
    }
    if (!terms.length) return
    const readable = walked.files.filter((f) => /\.(tcdoc|csv)$/i.test(f.path)).sort((a, b) => b.editedAt - a.editedAt).slice(0, TEXT_MOST)
    // Four at a time: the service reads one document per call.
    for (let i = 0; i < readable.length; i += 4) {
      const batch = readable.slice(i, i + 4)
      const read = await Promise.all(batch.map((f) => fileText(ctx, f)))
      batch.forEach((f, j) => {
        const text = read[j]!
        const lower = text.toLowerCase()
        if (text && terms.every((t) => lower.includes(t))) hits.push({ key: `file:${f.path}`, snippet: snippetOf(text, terms) })
      })
    }
  })()

  await Promise.all([lifeosPart, folderPart])

  // Items threads hold that neither place listed. A file outside the folder shows only if this caller could name it.
  for (const item of ctx.canvas.forWorkspace(o.workspaceId)) {
    const e = itemEntry(item)
    if (!e || entries.has(e.key)) continue
    if (item.source.at === 'file' && !ctx.reaches(by, item.source.path)) continue
    entries.set(e.key, e)
  }

  const list = [...entries.values()]
  heldCounts(ctx.db, o.workspaceId, sector, list)
  return { entries: list, projects, hits, complete, ...(lifeos ? { lifeos } : {}) }
}

function canonicalPathOr(path: string): string | null {
  try {
    return canonicalPath(path)
  } catch {
    return null
  }
}

// ── Saved views: a workspace's named searches, kept by the docs pillar ──

export const VIEWS_TABLE = 'work_docs_views'
/** A workspace keeps at most this many. */
export const VIEWS_MOST = 50

export function ensureViewsTable(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS ${VIEWS_TABLE} (
    id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, name TEXT NOT NULL, spec TEXT NOT NULL, created_at INTEGER NOT NULL
  )`)
  db.exec(`CREATE INDEX IF NOT EXISTS ${VIEWS_TABLE}_ws ON ${VIEWS_TABLE} (workspace_id, created_at)`)
}

export function listViews(db: DatabaseSync, workspaceId: string): SavedFindView[] {
  const rows = db.prepare(`SELECT id, name, spec FROM ${VIEWS_TABLE} WHERE workspace_id = ? ORDER BY created_at, id`).all(workspaceId) as { id: string; name: string; spec: string }[]
  return rows.flatMap((r) => {
    try {
      return [{ id: r.id, name: r.name, spec: JSON.parse(r.spec) as FindSpec }]
    } catch {
      return []
    }
  })
}

/** Saves a new view, or renames and rewrites one the workspace has. */
export function saveView(db: DatabaseSync, workspaceId: string, v: { id?: string; name: string; spec: FindSpec }, now = Date.now()): SavedFindView {
  const name = v.name.trim()
  if (v.id) {
    const changed = db.prepare(`UPDATE ${VIEWS_TABLE} SET name = ?, spec = ? WHERE id = ? AND workspace_id = ?`).run(name, JSON.stringify(v.spec), v.id, workspaceId).changes
    if (!Number(changed)) throw new Error('no such saved view')
    return { id: v.id, name, spec: v.spec }
  }
  const n = (db.prepare(`SELECT count(*) AS n FROM ${VIEWS_TABLE} WHERE workspace_id = ?`).get(workspaceId) as { n: number }).n
  if (n >= VIEWS_MOST) throw new Error(`a workspace keeps at most ${VIEWS_MOST} saved views`)
  const id = randomUUID()
  db.prepare(`INSERT INTO ${VIEWS_TABLE} (id, workspace_id, name, spec, created_at) VALUES (?, ?, ?, ?, ?)`).run(id, workspaceId, name, JSON.stringify(v.spec), now)
  return { id, name, spec: v.spec }
}

export function dropView(db: DatabaseSync, workspaceId: string, id: string): void {
  db.prepare(`DELETE FROM ${VIEWS_TABLE} WHERE id = ? AND workspace_id = ?`).run(id, workspaceId)
}

export function dropWorkspaceViews(db: DatabaseSync, workspaceId: string): void {
  try {
    db.prepare(`DELETE FROM ${VIEWS_TABLE} WHERE workspace_id = ?`).run(workspaceId)
  } catch {
    // Never made here.
  }
}
