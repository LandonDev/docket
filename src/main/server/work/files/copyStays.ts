import { fileDocName } from 'work-kit/collab-server'
import { existsSync, realpathSync, rmSync } from 'node:fs'
import { dirname, extname } from 'node:path'
import type { FileTab } from '@shared/contract-work-files'
import { filesPaneWorkspace, type CanvasItem, type CanvasKind, type CanvasSource } from '@shared/work'
import { copySavesBack } from '@shared/work/files'
import type { WorkCtx } from '../modules'
import { stayEdited, timeOf, type StayRow } from './copyKept'

/**
 * A copy that saves nowhere (docs/agents/work-files.md "A copy that saves nowhere"): a Files tab's copy of another
 * computer's file whose kind edits it but whose edits have no way back to the file. A .doc, .rtf or .odt opens as a
 * document made of the copy (an import's `.tcdoc` beside it); a workbook or deck whose computer named no version (a
 * build behind) is edited in the copy itself. Its edits stay in the tab. The record holds the copy as it was made, so
 * its edits are known by its file's size and time (the document's, once it is made), and the copy is never let go
 * while it holds any: a close keeps it for the file's next open, and only his Discard drops it. No version is ever
 * made up for it: it never becomes a copy that saves back.
 */


/**
 * Whether a copy that saves nowhere is edited in this kind: a document made of it (a .doc, .rtf, .odt, or a Word file
 * read with no version), or the bytes of a workbook or deck that would save back had its computer named a version. A
 * text file's copy with no version is read only (handle.ts `readCopy`), and a .csv's sheet is not of these.
 */
const edits = (kind: CanvasKind, name: string): boolean => kind === 'document' || ((kind === 'sheet' || kind === 'slides') && copySavesBack(kind, name))

const real = (path: string): string => {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

const rowOf = (ctx: Pick<WorkCtx, 'db'>, workspaceId: string, host: string, path: string): StayRow | null =>
  (ctx.db.prepare(`SELECT * FROM work_files_stays WHERE workspace_id = ? AND host = ? AND path = ?`).get(workspaceId, host, path) as StayRow | undefined) ?? null

/** A copy made for a Files tab whose edits go nowhere: recorded as made, when its kind edits it. */
export function recordStay(ctx: Pick<WorkCtx, 'db'>, c: { workspaceId: string; host: string; path: string; copy: string; kind: CanvasKind; name: string }): void {
  if (!edits(c.kind, c.name)) return
  const copy = real(c.copy)
  const made = timeOf(copy)
  if (!made) return
  ctx.db
    .prepare(
      `INSERT INTO work_files_stays (workspace_id, host, path, copy, dir, size, mtime, kind, doc, doc_at, closed, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 0, ?)
       ON CONFLICT (workspace_id, host, path) DO UPDATE SET copy = excluded.copy, dir = excluded.dir, size = excluded.size, mtime = excluded.mtime, kind = excluded.kind, doc = NULL, doc_at = NULL, closed = 0, at = excluded.at`
    )
    .run(c.workspaceId, c.host, c.path, copy, dirname(copy), made.size, made.mtime, c.kind, Date.now())
}

/**
 * A copy that saves nowhere, kept with his edits when its tab closed, opened again for its file: the tab shows it as he
 * left it (the document made of it, or the copy), never read over from the file. One with no edits goes, and the file
 * is copied afresh. Answers what the tab shows, or null.
 */
export function reopenStay(ctx: Pick<WorkCtx, 'db' | 'host'>, workspaceId: string, file: { host: string; path: string }): { kind: CanvasKind; source: CanvasSource } | null {
  const r = rowOf(ctx, workspaceId, file.host, file.path)
  if (!r) return null
  const shown = r.doc ?? r.copy
  if (!stayEdited(r) || !existsSync(shown)) {
    ctx.db.prepare(`DELETE FROM work_files_stays WHERE workspace_id = ? AND host = ? AND path = ?`).run(workspaceId, file.host, file.path)
    return null
  }
  ctx.db.prepare(`UPDATE work_files_stays SET closed = 0 WHERE workspace_id = ? AND host = ? AND path = ?`).run(workspaceId, file.host, file.path)
  return { kind: r.doc ? 'document' : r.kind, source: { at: 'file', host: ctx.host, path: shown } }
}

/** The copy's document was made (`CanvasStore.replace`, an import beside it): the record names it, as made. */
export function stayFollowed(ctx: Pick<WorkCtx, 'db'>, old: CanvasItem, next: CanvasItem): void {
  if (!filesPaneWorkspace(old.sessionId) || old.source.at !== 'file' || next.source.at !== 'file' || extname(next.source.path) !== '.tcdoc') return
  const copy = real(old.source.path)
  const doc = real(next.source.path)
  if (dirname(doc) !== dirname(copy)) return
  ctx.db.prepare(`UPDATE work_files_stays SET doc = ?, doc_at = ? WHERE copy = ?`).run(doc, timeOf(doc)?.mtime ?? null, copy)
}

/** How each copy that saves nowhere stands, by where its file lies (`host\0path`), for the tabs. */
export function staysOf(ctx: Pick<WorkCtx, 'db'>, workspaceId: string): Map<string, NonNullable<FileTab['stays']>> {
  const rows = ctx.db.prepare(`SELECT * FROM work_files_stays WHERE workspace_id = ?`).all(workspaceId) as unknown as StayRow[]
  return new Map(rows.map((r) => [`${r.host}\0${r.path}`, { edited: stayEdited(r) }]))
}

/** Whether a tab shows a copy that saves nowhere (its Discard drops his edits, his press alone). */
export const isStay = (ctx: Pick<WorkCtx, 'db'>, workspaceId: string, tab: FileTab | undefined): boolean => !!tab?.copyOf && !!rowOf(ctx, workspaceId, tab.copyOf.host, tab.copyOf.path)

/** His Discard as the tab closes: the copy, the document made of it and the record go now. */
export function stayDiscarded(ctx: Pick<WorkCtx, 'db'>, workspaceId: string, tab: FileTab | undefined): void {
  const r = tab?.copyOf ? rowOf(ctx, workspaceId, tab.copyOf.host, tab.copyOf.path) : null
  if (!r) return
  ctx.db.prepare(`DELETE FROM work_files_stays WHERE workspace_id = ? AND host = ? AND path = ?`).run(r.workspace_id, r.host, r.path)
  rmSync(r.dir, { recursive: true, force: true })
}

/**
 * Items of a Files pane went, however they went. A copy that saves nowhere goes with its record only when it holds no
 * edits; one that does is kept for the file's next open. A document's last words are stored first, so its file's time
 * says them; a service that does not answer keeps it.
 */
export async function staysLeft(ctx: Pick<WorkCtx, 'db' | 'canvas' | 'service' | 'log'>, items: readonly CanvasItem[]): Promise<void> {
  const find = ctx.db.prepare(`SELECT * FROM work_files_stays WHERE copy = ? OR doc = ?`)
  for (const item of items) {
    if (item.source.at !== 'file') continue
    const at = real(item.source.path)
    const r = find.get(at, at) as StayRow | undefined
    if (!r) continue
    const shown = (): boolean => ctx.canvas.forSession(item.sessionId).some((open) => open.id !== item.id && open.source.at === 'file' && [r.copy, r.doc].includes(real(open.source.path)))
    if (shown()) continue
    let stored = true
    if (r.doc) {
      try {
        await ctx.service.internal('/internal/docs/stored', { name: fileDocName(r.doc), fence: { sectors: 'all' } })
      } catch (err) {
        stored = false
        ctx.log(`files: a copy's document is kept: the service could not store it (${err instanceof Error ? err.message : String(err)})`)
      }
    }
    // Asked again after the wait: opened again meanwhile, it stays as it is.
    const now = find.get(at, at) as StayRow | undefined
    if (!now || shown()) continue
    if (!stored || stayEdited(now)) {
      ctx.db.prepare(`UPDATE work_files_stays SET closed = 1 WHERE workspace_id = ? AND host = ? AND path = ?`).run(now.workspace_id, now.host, now.path)
      continue
    }
    ctx.db.prepare(`DELETE FROM work_files_stays WHERE workspace_id = ? AND host = ? AND path = ?`).run(now.workspace_id, now.host, now.path)
    rmSync(now.dir, { recursive: true, force: true })
  }
}
