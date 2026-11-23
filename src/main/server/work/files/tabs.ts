import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { FilePage, FilesTabs, FileTab } from '@shared/contract-work-files'
import { filesPaneOf, filesPaneWorkspace, type CanvasItem, type CanvasKind, type CanvasSource } from '@shared/work'
import type { CanvasStore } from '../canvas/store'

/**
 * The open tabs of a workspace's Files place (docs/agents/work-files.md "A tab"): one ordered list of page tabs
 * and file tabs, kept on the workspace's host so it is there after a restart, in a second window and on every
 * client. It changes by one verb a change, each one transaction under a workspace-wide revision. A file tab's
 * canvas item (owned by the workspace's Files pane) is opened and closed inside the same transaction, so the
 * two can never disagree; `check` at boot drops a tab whose item is gone and an item whose tab is gone.
 */

interface Row {
  workspace_id: string
  id: string
  position: number
  kind: string
  page: string
  item_id: string | null
  opener: string | null
}

/** What a file tab keeps beside its item: the words its tab says, and the file's key (never twice). */
interface FilePageJson {
  name: string
  key: string
}

const SAVEPOINT = 'work_files_tab'

export class TabStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly canvas: CanvasStore,
    /** said once a change has landed, with the workspace's new revision */
    private readonly changed: (workspaceId: string, rev: number) => void = () => {}
  ) {}

  /** One change: everything `fn` writes lands or none of it does, the canvas's pushes wait for it, and the revision moves once. */
  private change<T>(workspaceId: string, fn: () => T): T {
    this.db.exec(`SAVEPOINT ${SAVEPOINT}`)
    let out: T
    let rev: number
    try {
      // The canvas says nothing of an item until the tab that holds it is written.
      out = this.canvas.inside(() => {
        const made = fn()
        rev = this.bump(workspaceId)
        this.db.exec(`RELEASE ${SAVEPOINT}`)
        return made
      })
    } catch (err) {
      try {
        this.db.exec(`ROLLBACK TO ${SAVEPOINT}`)
        this.db.exec(`RELEASE ${SAVEPOINT}`)
      } catch {
        // The savepoint was released before the fault (a push's listener threw): what was written stands.
      }
      throw err
    }
    this.changed(workspaceId, rev!)
    return out
  }

  private bump(workspaceId: string): number {
    this.db.prepare(`INSERT INTO work_files_revs (workspace_id, rev) VALUES (?, 1) ON CONFLICT (workspace_id) DO UPDATE SET rev = rev + 1`).run(workspaceId)
    return this.rev(workspaceId)
  }

  rev(workspaceId: string): number {
    return (this.db.prepare(`SELECT rev FROM work_files_revs WHERE workspace_id = ?`).get(workspaceId) as { rev: number } | undefined)?.rev ?? 0
  }

  private rows(workspaceId: string): Row[] {
    return this.db.prepare(`SELECT workspace_id, id, position, kind, page, item_id, opener FROM work_files_tabs WHERE workspace_id = ? ORDER BY position, updated_at`).all(workspaceId) as unknown as Row[]
  }

  private tab(row: Row): FileTab | null {
    let page: unknown
    try {
      page = JSON.parse(row.page)
    } catch {
      return null
    }
    if (row.kind === 'page') {
      const p = page as FilePage
      return p && typeof p.name === 'string' && p.at ? { id: row.id, kind: 'page', name: p.name, page: p, ...(row.opener ? { opener: row.opener } : {}) } : null
    }
    if (row.kind === 'file' && row.item_id) {
      const p = page as FilePageJson
      return { id: row.id, kind: 'file', name: typeof p?.name === 'string' ? p.name : '', itemId: row.item_id, key: typeof p?.key === 'string' ? p.key : '', ...(row.opener ? { opener: row.opener } : {}) }
    }
    return null
  }

  /** The workspace's tabs, in order. */
  list(workspaceId: string): FilesTabs {
    return { rev: this.rev(workspaceId), tabs: this.rows(workspaceId).flatMap((row) => this.tab(row) ?? []) }
  }

  /** Makes room at a position: `after`'s place plus one, or the end. */
  private slot(workspaceId: string, after?: string | null): number {
    const rows = this.rows(workspaceId)
    const at = after ? rows.findIndex((r) => r.id === after) : -1
    if (at < 0) return rows.length ? rows.at(-1)!.position + 1 : 0
    const position = rows[at]!.position + 1
    this.db.prepare(`UPDATE work_files_tabs SET position = position + 1 WHERE workspace_id = ? AND position >= ?`).run(workspaceId, position)
    return position
  }

  private insert(workspaceId: string, tab: { kind: 'page' | 'file'; page: unknown; itemId?: string; opener?: string | null }, after?: string | null): string {
    const id = randomUUID().replace(/-/g, '').slice(0, 16)
    const position = this.slot(workspaceId, after)
    this.db
      .prepare(`INSERT INTO work_files_tabs (workspace_id, id, position, kind, page, item_id, opener, rev, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`)
      .run(workspaceId, id, position, tab.kind, JSON.stringify(tab.page), tab.itemId ?? null, tab.opener ?? null, Date.now())
    return id
  }

  /** A new page tab, after `after` (last when absent or unknown). */
  tabOpen(workspaceId: string, page: FilePage, after?: string): FilesTabs & { tabId: string } {
    const tabId = this.change(workspaceId, () => this.insert(workspaceId, { kind: 'page', page, opener: after ?? null }, after))
    return { ...this.list(workspaceId), tabId }
  }

  /** Where a page tab stands now. A tab that is gone, or a file tab, is refused. */
  tabSet(workspaceId: string, tabId: string, page: FilePage): FilesTabs {
    this.change(workspaceId, () => {
      const done = this.db.prepare(`UPDATE work_files_tabs SET page = ?, updated_at = ? WHERE workspace_id = ? AND id = ? AND kind = 'page'`).run(JSON.stringify(page), Date.now(), workspaceId, tabId)
      if (!done.changes) throw new Error('That tab is closed.')
    })
    return this.list(workspaceId)
  }

  /** Moves a tab before `before` (last when null or unknown). */
  tabMove(workspaceId: string, tabId: string, before: string | null): FilesTabs {
    this.change(workspaceId, () => {
      const ids = this.rows(workspaceId).map((r) => r.id)
      if (!ids.includes(tabId)) throw new Error('That tab is closed.')
      const rest = ids.filter((id) => id !== tabId)
      const at = before && before !== tabId ? rest.indexOf(before) : -1
      rest.splice(at < 0 ? rest.length : at, 0, tabId)
      const set = this.db.prepare(`UPDATE work_files_tabs SET position = ? WHERE workspace_id = ? AND id = ?`)
      rest.forEach((id, position) => set.run(position, workspaceId, id))
    })
    return this.list(workspaceId)
  }

  /**
   * Closes a tab; a file tab's item goes with it, with what every kind kept for it. Closing one that is already
   * closed is nothing (another window closed it first). `last`: the page the row becomes when the last tab closes,
   * so the place is never left with none.
   */
  tabClose(workspaceId: string, tabId: string, last?: FilePage): FilesTabs {
    const row = this.db.prepare(`SELECT kind, item_id FROM work_files_tabs WHERE workspace_id = ? AND id = ?`).get(workspaceId, tabId) as { kind: string; item_id: string | null } | undefined
    if (!row) return this.list(workspaceId)
    this.change(workspaceId, () => {
      this.db.prepare(`DELETE FROM work_files_tabs WHERE workspace_id = ? AND id = ?`).run(workspaceId, tabId)
      // A tab opened from this one returns to nothing now, not to a closed tab.
      this.db.prepare(`UPDATE work_files_tabs SET opener = NULL WHERE workspace_id = ? AND opener = ?`).run(workspaceId, tabId)
      if (row.item_id) this.canvas.remove([row.item_id])
      if (last && !this.rows(workspaceId).length) this.insert(workspaceId, { kind: 'page', page: last })
    })
    return this.list(workspaceId)
  }

  /** The tab that holds a file, by its key. */
  tabOf(workspaceId: string, key: string): FileTab | null {
    if (!key) return null
    const row = this.db.prepare(`SELECT workspace_id, id, position, kind, page, item_id, opener FROM work_files_tabs WHERE workspace_id = ? AND kind = 'file' AND json_extract(page, '$.key') = ?`).get(workspaceId, key) as Row | undefined
    return row ? this.tab(row) : null
  }

  /**
   * Opens a file in a tab of its own, beside `opener`, or answers the tab that already holds it: never twice. The
   * item is made on the workspace's Files pane in the same transaction; a 33rd is refused in the canvas's sentence
   * and nothing is written.
   */
  openFile(workspaceId: string, file: { key: string; name: string; kind: CanvasKind; source: CanvasSource }, opener?: string): { tabId: string; item: CanvasItem } {
    const held = this.tabOf(workspaceId, file.key)
    const item = held?.itemId ? this.canvas.get(held.itemId) : null
    if (held && item) return { tabId: held.id, item }
    return this.change(workspaceId, () => {
      // A tab whose item went missing is replaced, not left dangling beside the new one.
      if (held) this.db.prepare(`DELETE FROM work_files_tabs WHERE workspace_id = ? AND id = ?`).run(workspaceId, held.id)
      const made = this.canvas.open(filesPaneOf(workspaceId), { kind: file.kind, source: file.source, title: file.name })
      const page: FilePageJson = { name: file.name, key: file.key }
      return { tabId: this.insert(workspaceId, { kind: 'file', page, itemId: made.id, opener: opener ?? null }, opener), item: made }
    })
  }

  /** An item took another's place in the pane (a Word file became the document made of it): the tab that showed the old one shows the new. */
  follow(old: CanvasItem, next: CanvasItem): void {
    const workspaceId = filesPaneWorkspace(old.sessionId)
    if (!workspaceId) return
    const row = this.db.prepare(`SELECT id, page FROM work_files_tabs WHERE workspace_id = ? AND item_id = ?`).get(workspaceId, old.id) as { id: string; page: string } | undefined
    if (!row) return
    let page: FilePageJson
    try {
      page = JSON.parse(row.page) as FilePageJson
    } catch {
      page = { name: next.title, key: '' }
    }
    // The key stays the file he opened: opening that file again selects this tab, which now shows its document.
    this.db.prepare(`UPDATE work_files_tabs SET item_id = ?, page = ?, updated_at = ? WHERE workspace_id = ? AND id = ?`).run(next.id, JSON.stringify({ ...page, name: next.title }), Date.now(), workspaceId, row.id)
    const rev = this.bump(workspaceId)
    this.changed(workspaceId, rev)
  }

  /**
   * At boot: a tab whose item is gone is dropped, and so is a Files pane's item no tab holds (a crash between the
   * two can leave neither, since they are one transaction; this mends rows from a database restored or edited
   * by hand). Answers how many of each went.
   */
  check(): { tabs: number; items: number } {
    const lost = this.db
      .prepare(`SELECT t.workspace_id AS workspace_id, t.id AS id FROM work_files_tabs t WHERE t.kind = 'file' AND (t.item_id IS NULL OR NOT EXISTS (SELECT 1 FROM work_canvas_items i WHERE i.id = t.item_id AND i.state = 'open'))`)
      .all() as { workspace_id: string; id: string }[]
    const drop = this.db.prepare(`DELETE FROM work_files_tabs WHERE workspace_id = ? AND id = ?`)
    for (const row of lost) drop.run(row.workspace_id, row.id)
    const stray = this.db
      .prepare(`SELECT i.id AS id FROM work_canvas_items i WHERE i.session_id LIKE 'filespane\\_%' ESCAPE '\\' AND NOT EXISTS (SELECT 1 FROM work_files_tabs t WHERE t.item_id = i.id)`)
      .all() as { id: string }[]
    if (stray.length) this.canvas.remove(stray.map((r) => r.id))
    for (const workspaceId of new Set(lost.map((r) => r.workspace_id))) this.bump(workspaceId)
    return { tabs: lost.length, items: stray.length }
  }

  /** A deleted workspace: its tabs and its revision go (the canvas drops the pane's items itself). */
  removeWorkspace(workspaceId: string): void {
    this.db.prepare(`DELETE FROM work_files_tabs WHERE workspace_id = ?`).run(workspaceId)
    this.db.prepare(`DELETE FROM work_files_revs WHERE workspace_id = ?`).run(workspaceId)
  }
}
