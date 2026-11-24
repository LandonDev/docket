import { rmSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import type { FileTab, WordBack, WordSaved } from '@shared/contract-work-files'
import { filesPaneWorkspace, type CanvasItem } from '@shared/work'
import { extOf } from '@shared/work/files'
import type { Caller, WorkCtx } from '../modules'
import { workspaceHere } from './policy'
import { admitOwner, deliver, NOT_SAVING } from './copies'
import { filesState } from './handle'

/**
 * A Word file from another computer (docs/agents/work-files.md "A Word file from another computer"; the owner's ruling
 * of 2026-11-23). A .docx of a library on another host of his, or in this host's Windows VM, opens in a Files tab as
 * the document made of it, and that document is kept in the workspace's own folder, so his edits are never thrown
 * away: opening the Word file again shows the same document. The Word file itself changes only by his Save as Word,
 * our Word export written over it by the version it was read at, after a confirm in his window, or beside it under the
 * keep-both name. A document he only looked at goes when its tab closes.
 */

export interface WordRow {
  workspace_id: string
  host: string
  path: string
  vm: number
  name: string
  version: string
  doc: string | null
  doc_at: number | null
  saved_at: number | null
  saved_doc_at: number | null
  at: number
}

/** His window: what the workspace's host itself sends as when the press was his. */
const LOCAL: Caller = { kind: 'local', caps: ['read', 'operate', 'approve'] }
const mtime = (path: string): number | null => {
  try {
    return Math.round(statSync(path).mtimeMs)
  } catch {
    return null
  }
}

export const isWordFile = (name: string): boolean => extOf(name) === 'docx'

export const wordRow = (ctx: Pick<WorkCtx, 'db'>, workspaceId: string, host: string, path: string): WordRow | null =>
  (ctx.db.prepare(`SELECT * FROM work_files_word WHERE workspace_id = ? AND host = ? AND path = ?`).get(workspaceId, host, path) as WordRow | undefined) ?? null

/** The document kept for this Word file, if it is still where it was put. */
export function keptDoc(ctx: Pick<WorkCtx, 'db'>, workspaceId: string, host: string, path: string): WordRow | null {
  const r = wordRow(ctx, workspaceId, host, path)
  return r?.doc && mtime(r.doc) !== null ? r : null
}

/** A Word file read into a copy at `version`: what Save as Word will write over, until it is made again. */
export function recordWord(ctx: Pick<WorkCtx, 'db'>, w: { workspaceId: string; host: string; path: string; vm: boolean; name: string; version: string }): void {
  ctx.db
    .prepare(
      `INSERT INTO work_files_word (workspace_id, host, path, vm, name, version, doc, doc_at, saved_at, saved_doc_at, at) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?)
       ON CONFLICT (workspace_id, host, path) DO UPDATE SET vm = excluded.vm, name = excluded.name, version = excluded.version, doc = NULL, doc_at = NULL, saved_at = NULL, saved_doc_at = NULL, at = excluded.at`
    )
    .run(w.workspaceId, w.host, w.path, w.vm ? 1 : 0, w.name, w.version, Date.now())
}

/** The Files tab whose item is this one, if it shows a Word file's copy. */
function wordTab(ctx: WorkCtx, itemId: string | undefined, workspaceId: string): FileTab | null {
  if (!itemId) return null
  const tab = filesState(ctx).tabs.list(workspaceId).tabs.find((t) => t.itemId === itemId)
  return tab?.copyOf && isWordFile(tab.copyOf.path.replaceAll('\\', '/')) ? tab : null
}

/**
 * Where the document made of a Word file's copy goes (files/hooks.ts `registerImportPlace`): the workspace's own folder,
 * for a copy in a Files pane whose tab shows a Word file of another computer; null for anything else.
 */
export function wordImportPlace(ctx: WorkCtx, original: string, itemId: string | undefined): string | null {
  const item = itemId ? ctx.canvas.get(itemId) : null
  const workspaceId = item ? filesPaneWorkspace(item.sessionId) : null
  if (!item || !workspaceId || item.source.at !== 'file' || dirname(item.source.path) !== dirname(original)) return null
  const tab = wordTab(ctx, itemId, workspaceId)
  if (!tab || !wordRow(ctx, workspaceId, tab.copyOf!.host, tab.copyOf!.path)) return null
  return workspaceHere(ctx.db, workspaceId)?.path ?? null
}

/** A Word file's copy became its document (`CanvasStore.replace`): the record names the document, as made. */
export function wordFollowed(ctx: WorkCtx, old: CanvasItem, next: CanvasItem): void {
  const workspaceId = filesPaneWorkspace(old.sessionId)
  if (!workspaceId || next.kind !== 'document' || next.source.at !== 'file') return
  const tab = wordTab(ctx, old.id, workspaceId)
  if (!tab) return
  ctx.db
    .prepare(`UPDATE work_files_word SET doc = ?, doc_at = ? WHERE workspace_id = ? AND host = ? AND path = ? AND doc IS NULL`)
    .run(next.source.path, mtime(next.source.path), workspaceId, tab.copyOf!.host, tab.copyOf!.path)
}

/** Each Word file of the workspace opened as its document, by where it lies (`host\0path`), as its tab says it. */
export function wordBacksOf(ctx: Pick<WorkCtx, 'db'>, workspaceId: string): Map<string, WordBack> {
  const rows = ctx.db.prepare(`SELECT * FROM work_files_word WHERE workspace_id = ? AND doc IS NOT NULL`).all(workspaceId) as unknown as WordRow[]
  return new Map(rows.flatMap((r) => {
    const back = wordBackOf(r)
    return back ? [[`${r.host}\0${r.path}`, back] as const] : []
  }))
}

/**
 * At start: a Word file a build before this one opened in a Files tab became a document in its copy's own folder, with
 * no record, and that folder went with the tab. Each such open tab's document is taken as the Word file's kept
 * document where it lies: never deleted with its tab (`copyKeptIn`, `wordsLeft` with no `doc_at`), opened again for
 * the Word file, and saved as Word only by his press. The version it was read at is not known (`''`), so Save as Word
 * meets the file as changed and offers Keep Both, never a write over it.
 */
export function adoptWordCopies(ctx: Pick<WorkCtx, 'db' | 'canvas'>, tabs: (workspaceId: string) => FileTab[]): number {
  let adopted = 0
  const panes = ctx.db.prepare(`SELECT DISTINCT workspace_id FROM work_files_tabs WHERE kind = 'file'`).all() as { workspace_id: string }[]
  for (const { workspace_id: workspaceId } of panes) {
    for (const tab of tabs(workspaceId)) {
      if (!tab.copyOf || !tab.itemId || !isWordFile(tab.copyOf.path.replaceAll('\\', '/'))) continue
      const item = ctx.canvas.get(tab.itemId)
      if (!item || item.kind !== 'document' || item.source.at !== 'file' || !item.source.path.endsWith('.tcdoc')) continue
      if (wordRow(ctx, workspaceId, tab.copyOf.host, tab.copyOf.path)) continue
      const name = tab.copyOf.path.slice(Math.max(tab.copyOf.path.lastIndexOf('/'), tab.copyOf.path.lastIndexOf('\\')) + 1)
      ctx.db
        .prepare(`INSERT INTO work_files_word (workspace_id, host, path, vm, name, version, doc, doc_at, saved_at, saved_doc_at, at) VALUES (?, ?, ?, ?, ?, '', ?, NULL, NULL, NULL, ?)`)
        .run(workspaceId, tab.copyOf.host, tab.copyOf.path, tab.copyOf.vm ? 1 : 0, name, item.source.path, Date.now())
      adopted++
    }
  }
  return adopted
}

/** How the Word file stands, as its tab says it. */
export function wordBackOf(r: WordRow): WordBack | null {
  if (!r.doc) return null
  const now = mtime(r.doc)
  const since = r.saved_at === null || (now !== null && now !== r.saved_doc_at)
  return { ...(r.saved_at ? { at: r.saved_at } : {}), since }
}

/**
 * Items of a Files pane went: a document made of a Word file that he never changed goes with its record (he only
 * looked); one he changed is kept with its record, for the Word file's next open.
 */
export function wordsLeft(ctx: Pick<WorkCtx, 'db' | 'canvas'>, items: readonly CanvasItem[]): void {
  for (const item of items) {
    if (item.kind !== 'document' || item.source.at !== 'file') continue
    const r = ctx.db.prepare(`SELECT * FROM work_files_word WHERE doc = ?`).get(item.source.path) as WordRow | undefined
    if (!r || ctx.canvas.forSession(item.sessionId).some((open) => open.id !== item.id && open.source.at === 'file' && open.source.path === r.doc)) continue
    const now = mtime(r.doc!)
    if (now !== null && now !== r.doc_at) continue
    ctx.db.prepare(`DELETE FROM work_files_word WHERE workspace_id = ? AND host = ? AND path = ?`).run(r.workspace_id, r.host, r.path)
    if (now !== null) rmSync(r.doc!, { force: true })
  }
}

/** `work.files.wordSave`: Save as Word, over the file by its version, or beside it with `keep`. */
export async function wordSave(ctx: WorkCtx, by: Caller, p: { workspaceId: string; tabId: string; keep?: boolean }): Promise<WordSaved> {
  const tab = filesState(ctx).tabs.list(p.workspaceId).tabs.find((t) => t.id === p.tabId)
  const r = tab?.copyOf ? keptDoc(ctx, p.workspaceId, tab.copyOf.host, tab.copyOf.path) : null
  if (!tab || !r) throw new Error(NOT_SAVING)
  admitOwner(by, r)
  const { exportDoc } = await import('../formats/exporter')
  const out = await exportDoc(ctx, LOCAL, { source: { at: 'file', host: ctx.host, path: r.doc! }, format: 'docx' })
  const docAt = mtime(r.doc!)
  const got = await deliver(ctx, { workspace_id: r.workspace_id, host: r.host, path: r.path, vm: r.vm, name: r.name, version: r.version }, Buffer.from(out.data, 'base64'), !!p.keep)
  if ('conflict' in got) return { conflict: 'gone' in got.conflict ? { gone: true } : { changed: got.conflict.changed } }
  if ('copy' in got) return { copy: { name: got.copy.name } }
  const at = Date.now()
  ctx.db.prepare(`UPDATE work_files_word SET version = ?, saved_at = ?, saved_doc_at = ? WHERE workspace_id = ? AND host = ? AND path = ?`).run(got.version, at, docAt, r.workspace_id, r.host, r.path)
  filesState(ctx).tabs.touch(p.workspaceId)
  return { at }
}
