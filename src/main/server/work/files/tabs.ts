import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { besideSeatId, type FilePage, type FilesTabs, type FileTab } from '@shared/contract-work-files'
import { filesPaneOf, filesPaneWorkspace, type CanvasItem, type CanvasKind, type CanvasSource } from '@shared/work'
import { refKey } from '@shared/work/files'
import type { WorkCtx } from '../modules'

/**
 * The open tabs of a workspace's Files place (docs/agents/work-files.md "A tab"): one ordered list of page tabs
 * and file tabs, kept on the workspace's host so it is there after a restart, in a second window and on every
 * client. It changes by one verb a change, each one transaction under a workspace-wide revision. A file tab's
 * canvas item (owned by the workspace's Files pane) is opened and closed inside the same transaction, so the
 * two can never disagree; `check` at boot drops a tab whose item is gone and an item whose tab is gone.
 *
 * A window's Beside seat is kept here too, as a row of kind `seat` that is no tab: it is in no list and holds no
 * position. It keeps the one item a window shows at the right of a folder drawn as Beside, re-pointed from file
 * to file, so the item is the pane's own and goes when the seat does.
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
  /** the tab shows a copy made here of a file on that host */
  copyOf?: { host: string; path: string; vm?: boolean }
  /** a second file at the tab's side: its item, key and name */
  side?: { itemId: string; key: string; name: string }
}

const sideOf = (p: FilePageJson | undefined): FilePageJson['side'] | null => (p?.side && typeof p.side.itemId === 'string' && typeof p.side.key === 'string' && typeof p.side.name === 'string' ? p.side : null)

const pageOf = (json: string): FilePageJson | undefined => {
  try {
    return JSON.parse(json) as FilePageJson
  } catch {
    return undefined
  }
}

const SAVEPOINT = 'work_files_tab'
/** The most Beside seats a workspace keeps: a window that never said it closed leaves one, and the oldest goes first. */
export const SEATS_MOST = 8

export class TabStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly canvas: WorkCtx['canvas'],
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
    return this.db.prepare(`SELECT workspace_id, id, position, kind, page, item_id, opener FROM work_files_tabs WHERE workspace_id = ? AND kind != 'seat' ORDER BY position, updated_at`).all(workspaceId) as unknown as Row[]
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
      return { id: row.id, kind: 'file', name: typeof p?.name === 'string' ? p.name : '', itemId: row.item_id, key: typeof p?.key === 'string' ? p.key : '', ...(row.opener ? { opener: row.opener } : {}), ...(p?.copyOf && typeof p.copyOf.host === 'string' && typeof p.copyOf.path === 'string' ? { copyOf: p.copyOf } : {}), ...(sideOf(p) ? { side: sideOf(p)! } : {}) }
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

  /** A new page tab, after `after` (last when absent or unknown). `first`: only while there is no tab at all; else the first tab is answered and nothing is written. */
  tabOpen(workspaceId: string, page: FilePage, after?: string, first = false): FilesTabs & { tabId: string } {
    if (first) {
      const was = this.rows(workspaceId)[0]
      if (was) return { ...this.list(workspaceId), tabId: was.id }
    }
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
  tabClose(workspaceId: string, tabId: string, last?: FilePage, side = false): FilesTabs {
    const row = this.db.prepare(`SELECT kind, item_id, page FROM work_files_tabs WHERE workspace_id = ? AND id = ?`).get(workspaceId, tabId) as { kind: string; item_id: string | null; page: string } | undefined
    if (!row) return this.list(workspaceId)
    const beside = row.kind === 'file' ? sideOf(pageOf(row.page)) : null
    // Only the file at its side goes: the tab stays as it was before it took one.
    if (side) {
      if (beside) this.change(workspaceId, () => void this.dropSide(workspaceId, tabId, true))
      return this.list(workspaceId)
    }
    this.change(workspaceId, () => {
      if (beside) this.canvas.remove([beside.itemId])
      this.db.prepare(`DELETE FROM work_files_tabs WHERE workspace_id = ? AND id = ?`).run(workspaceId, tabId)
      // A tab opened from this one returns to nothing now, not to a closed tab.
      this.db.prepare(`UPDATE work_files_tabs SET opener = NULL WHERE workspace_id = ? AND opener = ?`).run(workspaceId, tabId)
      // A seat's item may be another window's seat too: it goes with the last row that shows it.
      if (row.item_id && !this.db.prepare(`SELECT 1 FROM work_files_tabs WHERE workspace_id = ? AND item_id = ?`).get(workspaceId, row.item_id)) this.canvas.remove([row.item_id])
      if (row.kind !== 'seat' && last && !this.rows(workspaceId).length) this.insert(workspaceId, { kind: 'page', page: last })
    })
    return this.list(workspaceId)
  }

  /** Something a tab says changed outside the tabs (how a copy's send stands, files/copies.ts): the revision moves, so every window asks for the list again. */
  touch(workspaceId: string): void {
    this.changed(workspaceId, this.bump(workspaceId))
  }

  /** A copy's tab shows another file of the same computer now (Keep Both made it): its name, its key and where that file lies. */
  repoint(workspaceId: string, tabId: string, file: { name: string; copyOf: { host: string; path: string; vm?: boolean } }): void {
    const row = this.db.prepare(`SELECT page FROM work_files_tabs WHERE workspace_id = ? AND id = ? AND kind = 'file'`).get(workspaceId, tabId) as { page: string } | undefined
    const page = row ? pageOf(row.page) : undefined
    if (!page) return
    const next: FilePageJson = { ...page, name: file.name, key: refKey({ at: 'file', host: file.copyOf.host, path: file.copyOf.path }), copyOf: file.copyOf }
    this.change(workspaceId, () => void this.db.prepare(`UPDATE work_files_tabs SET page = ?, updated_at = ? WHERE workspace_id = ? AND id = ?`).run(JSON.stringify(next), Date.now(), workspaceId, tabId))
  }

  /** The tab that holds a file, by its key. */
  tabOf(workspaceId: string, key: string): FileTab | null {
    if (!key) return null
    const row = this.db.prepare(`SELECT workspace_id, id, position, kind, page, item_id, opener FROM work_files_tabs WHERE workspace_id = ? AND kind = 'file' AND json_extract(page, '$.key') = ?`).get(workspaceId, key) as Row | undefined
    return row ? this.tab(row) : null
  }

  /** The tab that shows a file at its side, by the file's key. */
  private sideTabOf(workspaceId: string, key: string): FileTab | null {
    const row = this.db.prepare(`SELECT workspace_id, id, position, kind, page, item_id, opener FROM work_files_tabs WHERE workspace_id = ? AND kind = 'file' AND json_extract(page, '$.side.key') = ?`).get(workspaceId, key) as Row | undefined
    return row ? this.tab(row) : null
  }

  /** Takes the file at a tab's side out of it; `gone`: its item goes too (false when the item is taken somewhere else, or is gone already). */
  private dropSide(workspaceId: string, tabId: string, gone: boolean): void {
    const row = this.db.prepare(`SELECT page FROM work_files_tabs WHERE workspace_id = ? AND id = ?`).get(workspaceId, tabId) as { page: string } | undefined
    const page = row ? pageOf(row.page) : undefined
    const side = sideOf(page)
    if (!page || !side) return
    const { side: _was, ...rest } = page
    this.db.prepare(`UPDATE work_files_tabs SET page = ?, updated_at = ? WHERE workspace_id = ? AND id = ?`).run(JSON.stringify(rest), Date.now(), workspaceId, tabId)
    if (gone) this.canvas.remove([side.itemId])
  }

  /** An item that is gone from the pane by another way than its tab: the tab that showed it at its side shows it no more. Answers whether one did. */
  sideGone(itemId: string): boolean {
    const row = this.db.prepare(`SELECT workspace_id, id FROM work_files_tabs WHERE kind = 'file' AND json_extract(page, '$.side.itemId') = ?`).get(itemId) as { workspace_id: string; id: string } | undefined
    if (!row) return false
    this.change(row.workspace_id, () => void this.dropSide(row.workspace_id, row.id, false))
    return true
  }

  /** The tabs that show this file, or anything under this folder, at their side let go of it (it went to Trash). */
  sidesDrop(workspaceId: string, key: string, sep: string): void {
    for (const tab of this.list(workspaceId).tabs) if (tab.side && (tab.side.key === key || tab.side.key.startsWith(`${key}${sep}`))) this.tabClose(workspaceId, tab.id, undefined, true)
  }

  /**
   * Open to the Side: the file goes at the side of a file tab, in the same tab. Never twice: a file a tab of its
   * own holds moves there with its item and that tab goes; one at another tab's side, or in a Beside seat, moves
   * too. The file the tab had at its side before goes. A tab's own file is not put beside itself.
   */
  openSide(workspaceId: string, tabId: string, file: { key: string; name: string; kind: CanvasKind; source: CanvasSource }): { tabId: string; item: CanvasItem } {
    const target = this.list(workspaceId).tabs.find((t) => t.id === tabId && t.kind === 'file')
    const main = target?.itemId ? this.canvas.get(target.itemId) : null
    if (!target || !main) throw new Error('That tab is closed.')
    if (target.key === file.key) return { tabId, item: main }
    const shown = target.side?.key === file.key ? this.canvas.get(target.side.itemId) : null
    if (shown) return { tabId, item: shown }
    return this.change(workspaceId, () => {
      const own = this.tabOf(workspaceId, file.key)
      const elsewhere = this.sideTabOf(workspaceId, file.key)
      let item = own?.itemId ? this.canvas.get(own.itemId) : elsewhere?.side ? this.canvas.get(elsewhere.side.itemId) : this.seatOf(workspaceId, file.key)
      // Wherever it was shown lets go of it, and keeps the item for here.
      if (own) {
        if (own.side) this.canvas.remove([own.side.itemId])
        this.db.prepare(`DELETE FROM work_files_tabs WHERE workspace_id = ? AND id = ?`).run(workspaceId, own.id)
        this.db.prepare(`UPDATE work_files_tabs SET opener = NULL WHERE workspace_id = ? AND opener = ?`).run(workspaceId, own.id)
      }
      if (elsewhere) this.dropSide(workspaceId, elsewhere.id, false)
      if (item) this.db.prepare(`DELETE FROM work_files_tabs WHERE workspace_id = ? AND kind = 'seat' AND item_id = ?`).run(workspaceId, item.id)
      this.dropSide(workspaceId, tabId, true)
      item ??= this.canvas.open(filesPaneOf(workspaceId), file.kind, file.source, file.name)
      const row = this.db.prepare(`SELECT page FROM work_files_tabs WHERE workspace_id = ? AND id = ?`).get(workspaceId, tabId) as { page: string }
      const page: FilePageJson = { ...(pageOf(row.page) ?? { name: target.name, key: target.key ?? '' }), side: { itemId: item.id, key: file.key, name: file.name } }
      this.db.prepare(`UPDATE work_files_tabs SET page = ?, updated_at = ? WHERE workspace_id = ? AND id = ?`).run(JSON.stringify(page), Date.now(), workspaceId, tabId)
      return { tabId, item }
    })
  }

  /**
   * Opens a file in a tab of its own, beside `opener`, or answers the tab that already holds it: never twice. The
   * item is made on the workspace's Files pane in the same transaction; a 33rd is refused in the canvas's sentence
   * and nothing is written.
   */
  openFile(workspaceId: string, file: { key: string; name: string; kind: CanvasKind; source: CanvasSource; copyOf?: { host: string; path: string; vm?: boolean } }, opener?: string): { tabId: string; item: CanvasItem } {
    const held = this.tabOf(workspaceId, file.key)
    const item = held?.itemId ? this.canvas.get(held.itemId) : null
    if (held && item) return { tabId: held.id, item }
    // A file at a tab's side is there already: that tab is answered.
    const beside = held ? null : this.sideTabOf(workspaceId, file.key)
    const besideItem = beside?.side ? this.canvas.get(beside.side.itemId) : null
    if (beside && besideItem) return { tabId: beside.id, item: besideItem }
    // A file a Beside seat shows gets its tab with the item it has: the seat's rows go, the item stays.
    const seated = held ? null : this.seatOf(workspaceId, file.key)
    if (seated)
      return this.change(workspaceId, () => {
        this.db.prepare(`DELETE FROM work_files_tabs WHERE workspace_id = ? AND kind = 'seat' AND item_id = ?`).run(workspaceId, seated.id)
        const page: FilePageJson = { name: file.name, key: file.key, ...(file.copyOf ? { copyOf: file.copyOf } : {}) }
        return { tabId: this.insert(workspaceId, { kind: 'file', page, itemId: seated.id, opener: opener ?? null }, opener), item: seated }
      })
    return this.change(workspaceId, () => {
      // A tab whose item went missing is replaced, not left dangling beside the new one.
      if (held) this.db.prepare(`DELETE FROM work_files_tabs WHERE workspace_id = ? AND id = ?`).run(workspaceId, held.id)
      const made = this.canvas.open(filesPaneOf(workspaceId), file.kind, file.source, file.name)
      const page: FilePageJson = { name: file.name, key: file.key, ...(file.copyOf ? { copyOf: file.copyOf } : {}) }
      return { tabId: this.insert(workspaceId, { kind: 'file', page, itemId: made.id, opener: opener ?? null }, opener), item: made }
    })
  }

  /** The item a Beside seat of the workspace shows for a file, by its key. */
  private seatOf(workspaceId: string, key: string): CanvasItem | null {
    const row = this.db.prepare(`SELECT item_id FROM work_files_tabs WHERE workspace_id = ? AND kind = 'seat' AND json_extract(page, '$.key') = ?`).get(workspaceId, key) as { item_id: string | null } | undefined
    return row?.item_id ? this.canvas.get(row.item_id) : null
  }

  /**
   * A window's Beside seat shows this file now: the tab that already holds it (its item is answered with the tab's
   * id and no seat is kept), else an item of the seat's own, made here; the file the seat showed before goes. Never
   * twice: a file another window's seat shows is answered as that one item.
   */
  seat(workspaceId: string, window: string, file: { key: string; name: string; kind: CanvasKind; source: CanvasSource }): { item: CanvasItem; tabId?: string } {
    const id = besideSeatId(window)
    const own = this.tabOf(workspaceId, file.key)
    const atSide = own ? null : this.sideTabOf(workspaceId, file.key)
    const tab = own ?? atSide
    const tabItem = own?.itemId ? this.canvas.get(own.itemId) : atSide?.side ? this.canvas.get(atSide.side.itemId) : null
    const mine = this.db.prepare(`SELECT page, item_id FROM work_files_tabs WHERE workspace_id = ? AND id = ?`).get(workspaceId, id) as { page: string; item_id: string | null } | undefined
    if (tab && tabItem) {
      if (mine) this.tabClose(workspaceId, id)
      return { item: tabItem, tabId: tab.id }
    }
    const shown = this.seatOf(workspaceId, file.key)
    if (shown && mine?.item_id === shown.id) return { item: shown }
    return this.change(workspaceId, () => {
      if (mine) {
        this.db.prepare(`DELETE FROM work_files_tabs WHERE workspace_id = ? AND id = ?`).run(workspaceId, id)
        if (mine.item_id && !this.db.prepare(`SELECT 1 FROM work_files_tabs WHERE workspace_id = ? AND item_id = ?`).get(workspaceId, mine.item_id)) this.canvas.remove([mine.item_id])
      }
      // The oldest seats past the bound go, each with its item where no other row shows it.
      const seats = this.db.prepare(`SELECT id, item_id FROM work_files_tabs WHERE workspace_id = ? AND kind = 'seat' ORDER BY updated_at DESC`).all(workspaceId) as { id: string; item_id: string | null }[]
      for (const old of seats.slice(SEATS_MOST - 1)) {
        this.db.prepare(`DELETE FROM work_files_tabs WHERE workspace_id = ? AND id = ?`).run(workspaceId, old.id)
        if (old.item_id && !this.db.prepare(`SELECT 1 FROM work_files_tabs WHERE workspace_id = ? AND item_id = ?`).get(workspaceId, old.item_id)) this.canvas.remove([old.item_id])
      }
      const item = shown ?? this.canvas.open(filesPaneOf(workspaceId), file.kind, file.source, file.name)
      const page: FilePageJson = { name: file.name, key: file.key }
      this.db
        .prepare(`INSERT INTO work_files_tabs (workspace_id, id, position, kind, page, item_id, opener, rev, updated_at) VALUES (?, ?, -1, 'seat', ?, ?, NULL, 0, ?)`)
        .run(workspaceId, id, JSON.stringify(page), item.id, Date.now())
      return { item }
    })
  }

  /** The Beside seats that show this file, or anything under this folder, let go of it (it went to Trash). */
  seatsDrop(workspaceId: string, key: string, sep: string): void {
    const rows = this.db.prepare(`SELECT id, page FROM work_files_tabs WHERE workspace_id = ? AND kind = 'seat'`).all(workspaceId) as { id: string; page: string }[]
    for (const row of rows) {
      let held = ''
      try {
        held = (JSON.parse(row.page) as FilePageJson).key ?? ''
      } catch {
        // A row that cannot be read holds nothing to compare.
      }
      if (held === key || held.startsWith(`${key}${sep}`)) this.tabClose(workspaceId, row.id)
    }
  }

  /** An item took another's place in the pane (a Word file became the document made of it): the tab that showed the old one shows the new. */
  follow(old: CanvasItem, next: CanvasItem): void {
    const workspaceId = filesPaneWorkspace(old.sessionId)
    if (!workspaceId) return
    const row = this.db.prepare(`SELECT id, page FROM work_files_tabs WHERE workspace_id = ? AND item_id = ?`).get(workspaceId, old.id) as { id: string; page: string } | undefined
    if (!row) {
      // The file at a tab's side became another item: the side shows the new one, under the key he opened.
      const beside = this.db.prepare(`SELECT id, page FROM work_files_tabs WHERE workspace_id = ? AND kind = 'file' AND json_extract(page, '$.side.itemId') = ?`).get(workspaceId, old.id) as { id: string; page: string } | undefined
      const page = beside ? pageOf(beside.page) : undefined
      const side = sideOf(page)
      if (!beside || !page || !side) return
      this.db.prepare(`UPDATE work_files_tabs SET page = ?, updated_at = ? WHERE workspace_id = ? AND id = ?`).run(JSON.stringify({ ...page, side: { ...side, itemId: next.id, name: next.title } }), Date.now(), workspaceId, beside.id)
      this.changed(workspaceId, this.bump(workspaceId))
      return
    }
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
    // A seat is a window's, and no window outlives the host's start: each goes, its item with the strays below.
    this.db.prepare(`DELETE FROM work_files_tabs WHERE kind = 'seat'`).run()
    const lost = this.db
      .prepare(`SELECT t.workspace_id AS workspace_id, t.id AS id FROM work_files_tabs t WHERE t.kind = 'file' AND (t.item_id IS NULL OR NOT EXISTS (SELECT 1 FROM work_canvas_items i WHERE i.id = t.item_id AND i.state = 'open'))`)
      .all() as { workspace_id: string; id: string }[]
    const drop = this.db.prepare(`DELETE FROM work_files_tabs WHERE workspace_id = ? AND id = ?`)
    for (const row of lost) drop.run(row.workspace_id, row.id)
    // A tab whose side lost its item shows its own file alone again.
    const sides = this.db.prepare(`SELECT workspace_id, id, page FROM work_files_tabs WHERE kind = 'file' AND json_extract(page, '$.side.itemId') IS NOT NULL`).all() as { workspace_id: string; id: string; page: string }[]
    for (const row of sides) {
      const side = sideOf(pageOf(row.page))
      if (side && this.db.prepare(`SELECT 1 FROM work_canvas_items WHERE id = ? AND state = 'open'`).get(side.itemId)) continue
      this.dropSide(row.workspace_id, row.id, false)
    }
    const stray = this.db
      .prepare(
        `SELECT i.id AS id FROM work_canvas_items i WHERE i.session_id LIKE 'filespane\\_%' ESCAPE '\\' AND NOT EXISTS (SELECT 1 FROM work_files_tabs t WHERE t.item_id = i.id OR json_extract(t.page, '$.side.itemId') = i.id)`
      )
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
