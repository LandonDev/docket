import { createHash } from 'node:crypto'
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { FileTab, WordBack, WordSaved } from '@shared/contract-work-files'
import { filesPaneOf, filesPaneWorkspace, type CanvasItem } from '@shared/work'
import { extOf, freeName, splitName } from '@shared/work/files'
import type { Caller, WorkCtx } from '../modules'
import { blankOf } from './make'
import { workspaceHere } from './policy'
import { admitOwner, deliver, freshBytes, NOT_SAVING } from './copies'
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
  /** the sha256 of the bytes the copy was read with; null for a document an older build made (`adoptWordCopies`) */
  sha: string | null
  /** the Word file as it was before TempCode's first write over it, kept in the workspace's folder */
  original: string | null
  auto: number | null
  stopped: number | null
  /** the document's live revision last written to the Word file, and as it stood when made of the file */
  saved_rev: string | null
  base_rev: string | null
}

/**
 * The document's live revision as the Work service holds it now (its `/internal/docs/rev`): it moves with every edit
 * he types, while the `.tcdoc` file on disk is written only now and then. Autosave and the header follow it.
 */
async function liveRev(ctx: WorkCtx, doc: string): Promise<string> {
  const { serviceTarget } = await import('../docs/target')
  const target = { at: 'file' as const, doc, path: doc, source: { at: 'file' as const, host: ctx.host, path: doc } }
  return ((await ctx.service.internal('/internal/docs/rev', serviceTarget(target, false, 'all'))) as { rev: string }).rev
}
/** The live revision each kept document was last seen at, and since when, by its record's key. */
const seenRevs = new Map<string, { rev: string; at: number }>()
const keyOf = (r: Pick<WordRow, 'workspace_id' | 'host' | 'path'>): string => `${r.workspace_id}\0${r.host}\0${r.path}`
/** Whether the document holds edits the Word file has not: by its live revision once seen, never by the file's time. */
function editsSince(r: WordRow): boolean {
  const seen = seenRevs.get(keyOf(r))?.rev
  const written = r.saved_rev ?? r.base_rev
  // A document an older build made (no base) holds his edits until its first save; one not yet seen is not called changed.
  if (written === null) return r.doc_at === null
  return seen !== undefined && seen !== written
}

/** The sha256 of our own blank Word file (resources/work-files/blank/blank.docx): a file still exactly that was born here. */
let blankSha: string | null | undefined
function bornHere(sha: string): boolean {
  if (blankSha === undefined) {
    try {
      blankSha = createHash('sha256').update(readFileSync(blankDocx())).digest('hex')
    } catch {
      blankSha = null
    }
  }
  return blankSha === sha
}
const blankDocx = (): string => (blankOf('docx') as { from: string }).from

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
export function recordWord(ctx: Pick<WorkCtx, 'db'>, w: { workspaceId: string; host: string; path: string; vm: boolean; name: string; version: string; sha: string }): void {
  ctx.db
    .prepare(
      `INSERT INTO work_files_word (workspace_id, host, path, vm, name, version, sha, doc, doc_at, saved_at, saved_doc_at, at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?)
       ON CONFLICT (workspace_id, host, path) DO UPDATE SET vm = excluded.vm, name = excluded.name, version = excluded.version, sha = excluded.sha, doc = NULL, doc_at = NULL, saved_at = NULL, saved_doc_at = NULL, stopped = NULL, at = excluded.at`
    )
    .run(w.workspaceId, w.host, w.path, w.vm ? 1 : 0, w.name, w.version, w.sha, Date.now())
  // A Word file still exactly our blank (New → Document) holds only what our editor makes: it saves by itself, unasked.
  if (bornHere(w.sha)) ctx.db.prepare(`UPDATE work_files_word SET auto = 1 WHERE workspace_id = ? AND host = ? AND path = ? AND auto IS NULL`).run(w.workspaceId, w.host, w.path)
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
  // The tab may already have followed to the document (TabStore.follow hears the replace too, in either order).
  const tab = wordTab(ctx, old.id, workspaceId) ?? wordTab(ctx, next.id, workspaceId)
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

/**
 * The Word record a tab shows: by the Word file the tab names (`copyOf`), else by the document its item shows, so a
 * tab whose address and record were written by different builds still finds its file. Refused in words that say why.
 */
function recordOfWordTab(ctx: WorkCtx, workspaceId: string, tabId: string): WordRow {
  const tab = filesState(ctx).tabs.list(workspaceId).tabs.find((t) => t.id === tabId)
  if (!tab) throw new Error('That tab is closed.')
  const byFile = tab.copyOf ? keptDoc(ctx, workspaceId, tab.copyOf.host, tab.copyOf.path) : null
  if (byFile) return byFile
  const item = tab.itemId ? ctx.canvas.get(tab.itemId) : null
  const path = item?.source.at === 'file' ? item.source.path : null
  const byDoc = path ? ((ctx.db.prepare(`SELECT * FROM work_files_word WHERE workspace_id = ? AND doc = ?`).get(workspaceId, path) as WordRow | undefined) ?? null) : null
  if (byDoc && mtime(byDoc.doc!) !== null) return byDoc
  throw new Error(NOT_SAVING)
}

/** How the Word file stands, as its tab says it. */
export function wordBackOf(r: WordRow): WordBack | null {
  if (!r.doc) return null
  const since = editsSince(r)
  return { ...(r.saved_at ? { at: r.saved_at } : {}), since, ...(r.auto === null ? {} : { auto: r.auto === 1 }), ...(r.stopped ? { stopped: r.stopped } : {}) }
}

/** `work.files.wordAuto`: his choice for the file, kept on its record: save by itself, or ask each time. */
export function wordAuto(ctx: WorkCtx, by: Caller, p: { workspaceId: string; tabId: string; on: boolean }): void {
  const r = recordOfWordTab(ctx, p.workspaceId, p.tabId)
  admitOwner(by, r)
  ctx.db.prepare(`UPDATE work_files_word SET auto = ? WHERE workspace_id = ? AND host = ? AND path = ?`).run(p.on ? 1 : 0, r.workspace_id, r.host, r.path)
  filesState(ctx).tabs.touch(p.workspaceId)
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

/** The sha256 of the bytes the Word file was read with: recorded at its open, or the copy an older build left beside the document. */
function knownSha(r: WordRow): string | null {
  if (r.sha) return r.sha
  if (!r.doc) return null
  try {
    return createHash('sha256').update(readFileSync(join(dirname(r.doc), r.name))).digest('hex')
  } catch {
    return null
  }
}
const shaOf = (data: Buffer): string => createHash('sha256').update(data).digest('hex')
/** When a version word (`size:mtime:sha`, the helper's and the door's alike) says the file last changed. */
const changedOf = (version: string): number => Number(version.split(':')[1]) || Date.now()

/** The Word file as it was before TempCode's first write over it, kept once in the workspace's folder beside his document. */
function keepOriginal(ctx: WorkCtx, r: WordRow, data: Buffer): void {
  const folder = workspaceHere(ctx.db, r.workspace_id)?.path
  if (r.original || !folder) return
  const { stem, ext } = splitName(r.name)
  const name = freeName(`${stem} (before TempCode saved it)${ext}`, (n) => existsSync(join(folder, n)))
  writeFileSync(join(folder, name), data, { flag: 'wx' })
  ctx.db.prepare(`UPDATE work_files_word SET original = ? WHERE workspace_id = ? AND host = ? AND path = ?`).run(join(folder, name), r.workspace_id, r.host, r.path)
}

/**
 * `work.files.wordSave`: Save as Word. The file as it is there now is read first: unchanged since it was read (by
 * version, or when only its version moved, by its bytes' hash: a sync's touch, an older build's copy with no version
 * on record), it is written over; changed there, the answer says when, and only `replace` (his press on Replace) writes
 * over it. Before the first write over the file its bytes are kept in the workspace's folder. `keep` puts his
 * version beside the file instead.
 */
export async function wordSave(ctx: WorkCtx, by: Caller, p: { workspaceId: string; tabId: string; keep?: boolean; replace?: boolean; auto?: boolean }): Promise<WordSaved> {
  const r = recordOfWordTab(ctx, p.workspaceId, p.tabId)
  admitOwner(by, r)
  return saveRow(ctx, r, p)
}

/** One save of a Word file's document as Word, as `wordSave` and the host's autosave run it. */
async function saveRow(ctx: WorkCtx, r: WordRow, p: { workspaceId: string; keep?: boolean; replace?: boolean; auto?: boolean }): Promise<WordSaved> {
  const row = { workspace_id: r.workspace_id, host: r.host, path: r.path, vm: r.vm, name: r.name, version: r.version }
  let version = r.version
  if (!p.keep) {
    let now: { data: Buffer; version: string }
    try {
      now = await freshBytes(ctx, row)
    } catch (err) {
      if (/not there any more|gone|not found|No file/i.test(err instanceof Error ? err.message : String(err))) return { conflict: { gone: true } }
      throw err
    }
    const same = now.version === r.version || (knownSha(r) !== null && shaOf(now.data) === knownSha(r))
    if (!same && !p.replace) {
      // An autosave that meets a change made there stops for this file until his press: never a silent overwrite.
      if (p.auto) {
        ctx.db.prepare(`UPDATE work_files_word SET stopped = ? WHERE workspace_id = ? AND host = ? AND path = ?`).run(changedOf(now.version), r.workspace_id, r.host, r.path)
        filesState(ctx).tabs.touch(p.workspaceId)
      }
      return { conflict: { changed: changedOf(now.version) } }
    }
    // An autosave goes only where he chose it and nothing stopped it.
    if (p.auto && (r.auto !== 1 || r.stopped)) return { conflict: { changed: r.stopped ?? changedOf(now.version) } }
    version = now.version
    // A file still exactly our blank holds nothing of anyone's to keep.
    if (!bornHere(shaOf(now.data))) keepOriginal(ctx, r, now.data)
  }
  const { exportDoc } = await import('../formats/exporter')
  const out = await exportDoc(ctx, LOCAL, { source: { at: 'file', host: ctx.host, path: r.doc! }, format: 'docx' })
  const data = Buffer.from(out.data, 'base64')
  const docAt = mtime(r.doc!)
  // The revision written is the one read before the export: an edit after it keeps the file behind, and is saved next.
  const writtenRev = await liveRev(ctx, r.doc!).catch(() => null)
  const got = await deliver(ctx, { ...row, version }, data, !!p.keep)
  if ('conflict' in got) return { conflict: 'gone' in got.conflict ? { gone: true } : { changed: got.conflict.changed } }
  if ('copy' in got) return { copy: { name: got.copy.name } }
  const at = Date.now()
  ctx.db.prepare(`UPDATE work_files_word SET version = ?, sha = ?, saved_at = ?, saved_doc_at = ?, saved_rev = ?, stopped = NULL WHERE workspace_id = ? AND host = ? AND path = ?`).run(got.version, shaOf(data), at, docAt, writtenRev, r.workspace_id, r.host, r.path)
  filesState(ctx).tabs.touch(p.workspaceId)
  return { at }
}

/** How long his document must be still before the host saves it as Word by itself. */
export const wordTiming = { pause: 3000 }
const saving = new Set<string>()

/**
 * The host's autosave (the owner's order of 2026-11-23): every Word file he chose to save automatically, or one born
 * here, whose document changed since its last save and has been still for a pause, is exported and written to its
 * file by version, with no ask of any window. A change made there stops it for that file (`stopped`) until his press.
 * Only his own document's live text is written: an agent's change to it waits as a suggestion until his press.
 */
export async function autosaveWords(ctx: WorkCtx, now = Date.now()): Promise<void> {
  const rows = ctx.db.prepare(`SELECT * FROM work_files_word WHERE doc IS NOT NULL`).all() as unknown as WordRow[]
  for (const r of rows) {
    // Only a document a tab shows, or one that saves by itself, is looked at: each look reads the service.
    const shown = ctx.canvas.forSession(filesPaneOf(r.workspace_id)).some((i) => i.source.at === 'file' && i.source.path === r.doc)
    if (!shown && r.auto !== 1) continue
    const key = keyOf(r)
    let rev: string
    try {
      rev = await liveRev(ctx, r.doc!)
    } catch {
      continue
    }
    const was = seenRevs.get(key)
    if (was?.rev !== rev) {
      seenRevs.set(key, { rev, at: now })
      // A document made of the Word file: what it held when first seen is what the file holds.
      if (r.base_rev === null && r.saved_rev === null && r.doc_at !== null && !was) {
        ctx.db.prepare(`UPDATE work_files_word SET base_rev = ? WHERE workspace_id = ? AND host = ? AND path = ?`).run(rev, r.workspace_id, r.host, r.path)
        r.base_rev = rev
      }
      filesState(ctx).tabs.touch(r.workspace_id)
    }
    if (r.auto !== 1 || r.stopped || saving.has(key) || !editsSince(r)) continue
    // His typing has paused: the revision on screen has held still for the pause.
    if (now - seenRevs.get(key)!.at < wordTiming.pause) continue
    saving.add(key)
    try {
      await saveRow(ctx, r, { workspaceId: r.workspace_id, auto: true })
    } catch (err) {
      ctx.log(`files: a Word file was not saved by itself: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      saving.delete(key)
    }
  }
}
