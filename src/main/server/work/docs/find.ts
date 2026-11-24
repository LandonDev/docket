import type { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { basename } from 'node:path'
import { fileDocName } from 'work-kit/collab-server'
import type { CanvasItem, CanvasSource } from '@shared/work'
import { FIND_KINDS, kindOfFile, kindOfMime, queryTerms, snippetOf, type FindBy, type FindEntry, type FindKind, type FindSpec, type SavedFindView } from '@shared/work/docFind'
import type { FindAnswer } from '@shared/contract-work-docs'
import type { Caller, WorkCtx } from '../modules'
import { GuestStore } from '../guests/store'
import { madeFromShared } from './target'
import { HELD_TABLE } from '../outbox/store'
import { canonicalPath } from '../service/ctx'
import { fileRows } from './threads'

/**
 * Finding documents (docs/agents/work-docs.md "Finding documents"): one list
 * of what a Work workspace holds, for the agent's `doc_find`, a project's
 * link picker and anyone who wants a document by name. Three places, each searched where
 * its text lives:
 *
 * - LifeOS: its `catalog:list` (documents and sheets of the sector with who
 *   last changed each, open threads and waiting suggestions) and
 *   `catalog:search` (Convex's full-text index over a document's plain text).
 * - The workspace's folder: walked by Files' own walk (`walkNames`), its
 *   files' kinds by extension; a `.tcdoc`'s text read through the Work
 *   service and a `.csv`'s from disk, kept in memory by path and change time.
 * - The canvas items of the workspace's threads that live elsewhere: Google,
 *   Microsoft, and what a thread made (forms, dashboards). Titles only.
 *
 * Titles are matched by the caller over the entries (`findIn`); `hits` are
 * the text matches with the words around each.
 */

/** How many files' text a search reads, and how much of each. */
const TEXT_MOST = 200
const TEXT_BYTES = 512 * 1024
/** A folder walk is kept this long, so typing does not walk it again. */
const WALK_FRESH_MS = 10_000
/** The text kept for searches, at most, across the host's folders; the least read goes first. */
const TEXT_CACHE_BYTES = 32 * 1024 * 1024
/** LifeOS's catalog is kept this long; a window asks afresh (`refresh`) when it opens a list. */
const CATALOG_FRESH_MS = 30_000
/** Rows of each LifeOS table the host reads, a page at a time. */
const CATALOG_MOST = 300
const CATALOG_PAGE = 50

export interface CatalogRow {
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
type Walk = { files: FileRow[]; complete: boolean }
const walks = new WeakMap<object, Map<string, { at: number; walk: Promise<Walk> }>>()
const texts = new WeakMap<object, Map<string, { mtime: number; text: string }>>()
const catalogs = new WeakMap<object, Map<string, { at: number; read: Promise<{ rows: CatalogRow[]; complete: boolean }> }>>()
const cacheOf = <T>(map: WeakMap<object, Map<string, T>>, key: object): Map<string, T> => {
  let m = map.get(key)
  if (!m) map.set(key, (m = new Map()))
  return m
}

/**
 * The files under the workspace's folder whose kind a canvas opens, found by Files' own walk (`walkNames`,
 * files/search.ts): the same caps, hidden names and links left out as a listing leaves them, a link never
 * followed. A fresh one is kept, and one already on its way shared, so two asks walk once.
 */
function folderFiles(ctx: WorkCtx, root: string): Promise<Walk> {
  const cache = cacheOf(walks, ctx.db)
  const kept = cache.get(root)
  if (kept && Date.now() - kept.at < WALK_FRESH_MS) return kept.walk
  const walk = (async (): Promise<Walk> => {
    const { walkNames } = await import('../files/search')
    const walked = await walkNames(root, [])
    const found = walked.names.flatMap(({ path, row }) => {
      const kind = row.dir ? null : kindOfFile(row.name)
      return kind ? [{ path, kind }] : []
    })
    const files: FileRow[] = []
    for (let i = 0; i < found.length; i += 64) {
      const looked = await Promise.all(
        found.slice(i, i + 64).map(async (f): Promise<FileRow | null> => {
          try {
            const s = await stat(f.path)
            return { ...f, editedAt: Math.round(s.mtimeMs), createdAt: Math.round(s.birthtimeMs || s.ctimeMs) }
          } catch {
            // Gone between the walk and the look: not there.
            return null
          }
        })
      )
      for (const f of looked) if (f) files.push(f)
    }
    return { files, complete: !walked.more }
  })()
  cache.set(root, { at: Date.now(), walk })
  walk.catch(() => cache.delete(root))
  return walk
}

/** Keeps a read text, dropping the least read past the cap. A Map keeps insertion order: a hit goes to the end. */
export function keepText(cache: Map<string, { mtime: number; text: string }>, path: string, entry: { mtime: number; text: string }, most = TEXT_CACHE_BYTES): void {
  cache.delete(path)
  cache.set(path, entry)
  let bytes = 0
  for (const v of cache.values()) bytes += v.text.length
  for (const [key, v] of cache) {
    if (bytes <= most) break
    cache.delete(key)
    bytes -= v.text.length
  }
}

/** A sector's LifeOS catalog, read a page at a time up to its cap; kept a short while, and shared while on its way. */
export function lifeosCatalog(ctx: WorkCtx, sector: string, refresh: boolean): Promise<{ rows: CatalogRow[]; complete: boolean }> {
  const cache = cacheOf(catalogs, ctx.db)
  const kept = cache.get(sector)
  if (kept && !refresh && Date.now() - kept.at < CATALOG_FRESH_MS) return kept.read
  const read = (async () => {
    const rows: CatalogRow[] = []
    let complete = true
    for (const table of ['docs', 'sheets'] as const) {
      let cursor: string | null = null
      let got = 0
      for (;;) {
        const page: { rows: CatalogRow[]; isDone: boolean; continueCursor: string } = await ctx.lifeos
          .owner()
          .query('catalog:list', { sector, table, paginationOpts: { numItems: CATALOG_PAGE, cursor } })
        rows.push(...page.rows)
        got += page.rows.length
        if (page.isDone) break
        if (got >= CATALOG_MOST) {
          complete = false
          break
        }
        cursor = page.continueCursor
      }
    }
    return { rows: rows.sort((a, b) => b.editedAt - a.editedAt), complete }
  })()
  cache.set(sector, { at: Date.now(), read })
  read.catch(() => cache.delete(sector))
  return read
}

/** A file's text for a search: a `.tcdoc` through the Work service, a `.csv` from disk; '' for any other kind or a read that failed. */
async function fileText(ctx: WorkCtx, f: FileRow): Promise<string> {
  const ext = f.path.slice(f.path.lastIndexOf('.') + 1).toLowerCase()
  if (ext !== 'tcdoc' && ext !== 'csv') return ''
  const cache = cacheOf(texts, ctx.db)
  const kept = cache.get(f.path)
  if (kept && kept.mtime === f.editedAt) {
    keepText(cache, f.path, kept)
    return kept.text
  }
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
  keepText(cache, f.path, { mtime: f.editedAt, text })
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

/**
 * What a source keys to, so a file the folder walk found and the same file open in a thread are
 * one entry: a path as its real path, and one on another host with that host.
 */
export function keyOf(source: CanvasSource, itemId?: string, host?: string): string {
  if (source.at === 'lifeos') return `lifeos:${source.table}:${source.id}`
  if (source.at === 'file') return source.host === host || host === undefined ? `file:${canonicalPathOr(source.path) ?? source.path}` : `file:${source.host}:${source.path}`
  if (source.at === 'google') return `google:${source.fileId}`
  if (source.at === 'microsoft') return `microsoft:${source.ref.kind === 'path' ? source.ref.path : source.ref.url}`
  return `item:${itemId ?? ''}`
}

/** An item a thread holds that lives outside LifeOS and the folder, as an entry; a file outside the folder counts as the thread's. */
function itemEntry(item: CanvasItem, host: string): FindEntry | null {
  const s = item.source
  if (!(FIND_KINDS as readonly string[]).includes(item.kind)) return null
  if (s.at !== 'google' && s.at !== 'microsoft' && s.at !== 'thread' && s.at !== 'file') return null
  const kind = (s.at === 'google' ? kindOfMime(s.mime) : null) ?? (item.kind as FindKind)
  return {
    key: keyOf(s, item.id, host),
    title: item.title,
    kind,
    where: s.at === 'file' ? 'thread' : s.at,
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

/** Held acts that name an entry: an act still waiting (or failed) whose payload holds its id, path or file id as a whole value. */
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
    const value = s.at === 'lifeos' ? s.id : s.at === 'file' ? s.path : s.at === 'google' ? s.fileId : s.at === 'microsoft' && s.ref.kind === 'path' ? s.ref.path : null
    // Quoted, so /a/b.pdf does not count an act naming /a/b.pdf.bak.
    const needle = value ? JSON.stringify(value) : null
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
 * A remote key that cannot reach the folder is shown none of its files. `view`: the window's list
 * (`work.docs.find`: a project's link picker, and a window a release behind that still has the Docs
 * view), which leaves the folder's files and Teams files to the Files place; `doc_find` asks for all.
 */
export async function findDocs(ctx: WorkCtx, by: Caller, o: { workspaceId: string; query?: string; refresh?: boolean; view?: boolean }): Promise<FindAnswer> {
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
        lifeosCatalog(ctx, sector, !!o.refresh),
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
    // The window's list holds no file of the workspace's folder: the Files place shows them, and nothing is listed twice.
    if (o.view) return
    if (!folder || !ctx.reaches(by, folder)) return
    const all = await folderFiles(ctx, folder)
    complete &&= all.complete
    // The fence's denied folders lie inside its roots: each file is judged, not the folder alone.
    const walked = { files: by.kind === 'local' ? all.files : all.files.filter((f) => ctx.reaches(by, f.path)) }
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
        // Shared as the document tools read it (docs/target.ts): a library's, the cloud folder's, a Word file's kept document.
        shared: madeFromShared(ctx, { at: 'file', host: ctx.host, path: f.path }),
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
    const e = itemEntry(item, ctx.host)
    if (!e || entries.has(e.key)) continue
    // Nor, for the view, a file a thread holds from the folder or from Teams (in place, or its copy): Files shows those too.
    if (o.view && (item.source.at === 'file' || item.source.at === 'microsoft')) continue
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
