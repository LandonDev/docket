import { randomUUID } from 'node:crypto'
import { mkdirSync, rmSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { CanvasPush } from '@shared/contract-work-canvas'
import type { PushTo } from '../modules'
import type { SessionMeta } from '@shared/events'
import { CanvasKindSchema, CanvasSourceSchema, canvasSourcePath, mailPaneWorkspace, sessionScopeOf, type CanvasItem, type CanvasKind, type CanvasSource } from '@shared/work'

/**
 * A thread's canvas items (`work_canvas_items`, docs/agents/work-canvas.md
 * "The store"): the rows, the tab order and the folders of the items a
 * thread makes. The module's methods, `ctx.canvas` and the tools all go
 * through one store per database (`canvasStoreOf`), and every change pushes
 * the thread's open list.
 */

/** Open items a thread may hold at once. */
export const CANVAS_OPEN_MAX = 32

/** Ids that name a folder: the alphabet session.create allows, nothing else. */
const SAFE_ID = /^[A-Za-z0-9_-]+$/
const safeId = (id: string): string => {
  if (!SAFE_ID.test(id)) throw new Error(`canvas: bad id ${JSON.stringify(id)}`)
  return id
}

/** `<dataDir>/canvas/<sessionId>`: every folder a thread's items own. */
export const canvasDirOf = (dataDir: string, sessionId: string): string => join(dataDir, 'canvas', safeId(sessionId))
/** `<dataDir>/canvas/<sessionId>/<itemId>`: the folder of an item whose source is `{ at: 'thread' }`. */
export const canvasItemDir = (dataDir: string, sessionId: string, itemId: string): string => join(canvasDirOf(dataDir, sessionId), safeId(itemId))

export function ensureCanvasTables(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS work_canvas_items (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL, workspace_id TEXT, kind TEXT NOT NULL,
    title TEXT NOT NULL, source TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'open',
    position INTEGER NOT NULL, rev INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`)
  db.exec(`CREATE INDEX IF NOT EXISTS work_canvas_items_by_session ON work_canvas_items (session_id, state, position)`)
}

interface Row {
  id: string
  session_id: string
  workspace_id: string | null
  kind: string
  title: string
  source: string
  state: string
  position: number
  rev: number
  created_at: number
  updated_at: number
}

export interface CanvasStoreDeps {
  db: DatabaseSync
  dataDir: string
  /** The thread's row (the session registry's `get`). */
  session(id: string): Pick<SessionMeta, 'id' | 'workspaceId' | 'scope' | 'parentId'> | null
  /** Whether this host has a Work workspace by this id: a Mail view's pane (`mailPaneOf`) owns items only for one. */
  workWorkspace?(id: string): boolean
  push(p: CanvasPush, to?: PushTo): void
  /** Whether a remote key could name this path (the listener's fence, `ctx.reaches`); absent, it names none. */
  remoteReaches?(path: string): boolean
  log(line: string): void
}

/** An item as a caller the path fence does not admit sees it: its source's path cut to the file's name. */
export function fencedItem(item: CanvasItem, reaches: (path: string) => boolean): CanvasItem {
  const path = canvasSourcePath(item.source)
  if (path === null || reaches(path)) return item
  const s = item.source
  const source: CanvasSource = s.at === 'file' ? { ...s, path: basename(path) } : s.at === 'microsoft' ? { ...s, ref: { kind: 'path', path: basename(path) } } : s
  return { ...item, source }
}

/** What an open asks: a known item again, or a kind, source and title. */
export interface CanvasOpen {
  itemId?: string
  kind?: CanvasKind
  source?: CanvasSource
  title?: string
}

export class CanvasStore {
  /** Rows already said to be broken, so each is logged once. */
  private readonly broken = new Set<string>()
  constructor(private readonly deps: CanvasStoreDeps) {}

  private get db(): DatabaseSync {
    return this.deps.db
  }

  /** A row as the wire's item; null (logged once) when its kind or source no longer parses. */
  private item(row: Row): CanvasItem | null {
    let source: unknown
    try {
      source = JSON.parse(row.source)
    } catch {
      source = null
    }
    const kind = CanvasKindSchema.safeParse(row.kind)
    const parsed = CanvasSourceSchema.safeParse(source)
    if (!kind.success || !parsed.success || (row.state !== 'open' && row.state !== 'closed')) {
      if (!this.broken.has(row.id)) {
        this.broken.add(row.id)
        this.deps.log(`canvas: skipped item ${row.id} of ${row.session_id}: its kind, source or state does not parse`)
      }
      return null
    }
    return {
      id: row.id,
      sessionId: row.session_id,
      workspaceId: row.workspace_id,
      kind: kind.data,
      title: row.title,
      source: parsed.data,
      state: row.state,
      position: row.position,
      rev: row.rev,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }
  }

  private items(rows: Row[]): CanvasItem[] {
    return rows.flatMap((r) => this.item(r) ?? [])
  }

  /** The thread's open items, in tab order. */
  list(sessionId: string): CanvasItem[] {
    return this.items(this.db.prepare(`SELECT * FROM work_canvas_items WHERE session_id = ? AND state = 'open' ORDER BY position, created_at`).all(sessionId) as unknown as Row[])
  }

  get(itemId: string): CanvasItem | null {
    const row = this.db.prepare(`SELECT * FROM work_canvas_items WHERE id = ?`).get(itemId) as Row | undefined
    return row ? this.item(row) : null
  }

  /** A workspace's items, open and closed, newest change first (the Docs view's finding, docs/find.ts). */
  forWorkspace(workspaceId: string, opts: { open?: boolean; most?: number } = {}): CanvasItem[] {
    const open = opts.open ? ` AND state = 'open'` : ''
    return this.items(this.db.prepare(`SELECT * FROM work_canvas_items WHERE workspace_id = ?${open} ORDER BY updated_at DESC LIMIT ?`).all(workspaceId, opts.most ?? 1000) as unknown as Row[])
  }

  /** Every row of these threads, open and closed. */
  rowsFor(ids: readonly string[]): CanvasItem[] {
    const q = this.db.prepare(`SELECT * FROM work_canvas_items WHERE session_id = ? ORDER BY state DESC, position`)
    return ids.flatMap((id) => this.items(q.all(id) as unknown as Row[]))
  }

  /**
   * The thread whose pane a thread's items show in: its root. A subagent
   * has no pane the person looks at, so what it opens shows beside the
   * thread he reads; a thread with no parent is its own.
   */
  paneOf(sessionId: string): string {
    let id = sessionId
    // Bounded: a chain of parents is a few deep, and a loop in bad data must not hang the host.
    for (let depth = 0; depth < 32; depth++) {
      const parent = this.deps.session(id)?.parentId
      if (!parent) break
      id = parent
    }
    return id
  }

  /** The owner's row: a Work thread, or a Work workspace's Mail pane (an attachment opened beside the mail). */
  private workThread(sessionId: string): Pick<SessionMeta, 'id' | 'workspaceId'> {
    const pane = mailPaneWorkspace(sessionId)
    if (pane !== null && !this.deps.session(sessionId)) {
      if (!this.deps.workWorkspace?.(pane)) throw new Error(`not a Work workspace: ${pane}`)
      return { id: sessionId, workspaceId: pane }
    }
    const session = this.deps.session(sessionId)
    if (!session) throw new Error(`unknown thread: ${sessionId}`)
    if (sessionScopeOf(session) !== 'work') throw new Error(`not a Work thread: ${sessionId}`)
    return session
  }

  private nextPosition(sessionId: string): number {
    const row = this.db.prepare(`SELECT max(position) AS n FROM work_canvas_items WHERE session_id = ? AND state = 'open'`).get(sessionId) as { n: number | null }
    return row.n === null ? 0 : row.n + 1
  }

  /** Pushes the thread's open list (a thread that moved here says its items this way), split for remote keys as every change is. */
  announce(sessionId: string, opened?: string): CanvasItem[] {
    const items = this.list(sessionId)
    const p: CanvasPush = { push: 'work.canvas', sessionId, items, ...(opened ? { opened } : {}) }
    // A remote key sees the paths its fence admits; the rest are cut to file names, in a push of their own.
    const reaches = this.deps.remoteReaches ?? (() => false)
    const remote = items.map((i) => fencedItem(i, reaches))
    if (remote.every((i, k) => i === items[k])) this.deps.push(p)
    else {
      this.deps.push(p, { only: 'local' })
      this.deps.push({ ...p, items: remote }, { only: 'remote' })
    }
    return items
  }

  /**
   * Opens an item last in the thread's tab row. With `itemId`, that item of
   * the thread again; else the thread's item of the same kind and source
   * (never for `{ at: 'thread' }`), else a new one.
   */
  open(sessionId: string, o: CanvasOpen): CanvasItem {
    const session = this.workThread(sessionId)
    let existing: CanvasItem | null = null
    if (o.itemId !== undefined) {
      existing = this.get(o.itemId)
      if (!existing || existing.sessionId !== sessionId) throw new Error(`no canvas item ${o.itemId} in thread ${sessionId}`)
    } else if (!o.kind || !o.source || !o.title) {
      throw new Error('an open names an item, or its kind, source and title')
    }
    const source = existing ? existing.source : CanvasSourceSchema.parse(o.source)
    const sourceJson = JSON.stringify(source)
    if (!existing && source.at !== 'thread') {
      const row = this.db.prepare(`SELECT * FROM work_canvas_items WHERE session_id = ? AND kind = ? AND source = ? ORDER BY created_at LIMIT 1`).get(sessionId, o.kind!, sourceJson) as Row | undefined
      existing = row ? this.item(row) : null
    }
    if (existing?.state !== 'open') {
      const open = (this.db.prepare(`SELECT count(*) AS n FROM work_canvas_items WHERE session_id = ? AND state = 'open'`).get(sessionId) as { n: number }).n
      if (open >= CANVAS_OPEN_MAX) throw new Error(`This thread already has ${CANVAS_OPEN_MAX} items open; close one first.`)
    }
    const now = Date.now()
    // An item already open keeps its place in the row: opening it again only shows it. A closed one comes back last.
    const position = existing?.state === 'open' ? existing.position : this.nextPosition(sessionId)
    let id: string
    if (existing) {
      id = existing.id
      const title = o.title ?? existing.title
      if (existing.state !== 'open' || title !== existing.title)
        this.db.prepare(`UPDATE work_canvas_items SET state = 'open', position = ?, title = ?, rev = rev + 1, updated_at = ? WHERE id = ?`).run(position, title, now, id)
    } else {
      id = randomUUID()
      this.db
        .prepare(
          `INSERT INTO work_canvas_items (id, session_id, workspace_id, kind, title, source, state, position, rev, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'open', ?, 0, ?, ?)`
        )
        .run(id, sessionId, session.workspaceId ?? null, o.kind!, o.title!, sourceJson, position, now, now)
    }
    if (source.at === 'thread') mkdirSync(canvasItemDir(this.deps.dataDir, sessionId, id), { recursive: true, mode: 0o700 })
    this.announce(sessionId, id)
    return this.get(id)!
  }

  /** The item leaves the tab row; its row and its folder stay. */
  close(itemId: string): void {
    const row = this.db.prepare(`SELECT session_id, state FROM work_canvas_items WHERE id = ?`).get(itemId) as { session_id: string; state: string } | undefined
    if (!row) throw new Error(`no canvas item ${itemId}`)
    if (row.state === 'closed') return
    this.db.prepare(`UPDATE work_canvas_items SET state = 'closed', rev = rev + 1, updated_at = ? WHERE id = ?`).run(Date.now(), itemId)
    this.announce(row.session_id)
  }

  /** The tab order: `order` first, then the open items it left out, in their order; ids that are not open items of the thread are ignored. */
  reorder(sessionId: string, order: readonly string[]): CanvasItem[] {
    if (!this.deps.session(sessionId) && !(mailPaneWorkspace(sessionId) && this.deps.workWorkspace?.(mailPaneWorkspace(sessionId)!))) throw new Error(`unknown thread: ${sessionId}`)
    const open = this.db.prepare(`SELECT id, position FROM work_canvas_items WHERE session_id = ? AND state = 'open' ORDER BY position, created_at`).all(sessionId) as { id: string; position: number }[]
    const ids = new Set(open.map((r) => r.id))
    const listed = [...new Set(order)].filter((id) => ids.has(id))
    const next = [...listed, ...open.map((r) => r.id).filter((id) => !listed.includes(id))]
    const was = new Map(open.map((r) => [r.id, r.position]))
    const now = Date.now()
    const st = this.db.prepare(`UPDATE work_canvas_items SET position = ?, rev = rev + 1, updated_at = ? WHERE id = ?`)
    next.forEach((id, position) => {
      if (was.get(id) !== position) st.run(position, now, id)
    })
    return this.announce(sessionId)
  }

  /** Deleted threads: their rows and their folders go. */
  removeSessions(ids: readonly string[]): void {
    const st = this.db.prepare(`DELETE FROM work_canvas_items WHERE session_id = ?`)
    for (const id of ids) {
      st.run(id)
      if (SAFE_ID.test(id)) rmSync(canvasDirOf(this.deps.dataDir, id), { recursive: true, force: true })
    }
  }
}

/** One store per database, set up by the part (canvas/ctx.ts), which has the host's handles; the module reaches it through `ctx.db`. */
const stores = new WeakMap<DatabaseSync, CanvasStore>()
export const setCanvasStore = (db: DatabaseSync, store: CanvasStore): void => void stores.set(db, store)
export function canvasStoreOf(db: DatabaseSync): CanvasStore {
  const store = stores.get(db)
  if (!store) throw new Error('work: canvas/ctx.ts did not start')
  return store
}
