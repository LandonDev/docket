import { createHash } from 'node:crypto'
import { fileDocName } from 'work-kit/collab-server'
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { FileTab, WordBack, WordSaved } from '@shared/contract-work-files'
import { filesPaneOf, filesPaneWorkspace, type CanvasItem } from '@shared/work'
import { extOf, freeName, splitName } from '@shared/work/files'
import type { Caller, WorkCtx } from '../modules'
import type { DocRevision } from '../service/wire'
import { blankOf } from './make'
import { workspaceHere } from './policy'
import { admitOwner, deliver, freshBytes, freshVersion, NOT_SAVING, unreachable } from './copies'
import { filesState } from './handle'
import { sameBody } from './body'
import { wordStore } from './wordStore'

/**
 * A Word file from another computer (docs/agents/work-files.md "A Word file from another computer"; the owner's ruling
 * of 2026-11-23). A .docx of a library on another host of his, or in this host's Windows VM, opens in a Files tab as
 * the document made of it, and that document is kept in the workspace's hidden Word store under this host's data
 * (wordStore.ts: never his folder), so his edits are never thrown away: opening the Word file again shows the same document. The Word file itself changes only by his Save as Word,
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
  /** the Word file as it was before TempCode's first write over it, kept in the workspace's hidden Word store (wordStore.ts) */
  original: string | null
  auto: number | null
  stopped: number | null
  /** the version of the change an autosave stopped at */
  stopped_version?: string | null
  /** the sha256 of the last export sent whose answer never came */
  tried_sha?: string | null
  /** the document's live revision last written to the Word file, and as it stood when made of the file */
  saved_rev: string | null
  base_rev: string | null
}

/**
 * The document's live revision as the Work service holds it now (its `/internal/docs/rev`): it moves with every edit
 * he types, while the `.tcdoc` file on disk is written only now and then. Autosave and the header follow it.
 */
export async function liveRev(ctx: WorkCtx, doc: string): Promise<string> {
  const { serviceTarget } = await import('../docs/target')
  const target = { at: 'file' as const, doc, path: doc, source: { at: 'file' as const, host: ctx.host, path: doc } }
  return ((await ctx.service.internal('/internal/docs/rev', serviceTarget(target, false, 'all'))) as { rev: string }).rev
}
/**
 * Whether every word of a Word file's document is in the Word file, asked now and never from what the autosave saw last: the Work service's live revision, where his words are
 * as he types, against the one last written to the Word file or read from it. With no revision to compare, or no
 * service that answers, the document's file is all there is: unchanged since it was made, or since its last save.
 * A caller that deletes the document asks this first (office/live/switch.ts).
 */
export async function wordsAllInFile(ctx: WorkCtx, r: WordRow): Promise<boolean> {
  if (!r.doc) return true
  const written = r.saved_rev ?? r.base_rev
  if (written !== null) {
    try {
      return (await liveRev(ctx, r.doc)) === written
    } catch {
      // The service does not answer: whatever it held is gone with it, and the file says the rest.
    }
  }
  const at = r.saved_at !== null ? r.saved_doc_at : r.doc_at
  return at !== null && mtime(r.doc) === at
}
/** The live revision each kept document was last seen at, and since when, by its record's key. */
const seenRevs = new Map<string, { doc: string; rev: string; at: number }>()
const keyOf = (r: Pick<WordRow, 'workspace_id' | 'host' | 'path'>): string => `${r.workspace_id}\0${r.host}\0${r.path}`
function seenWord(r: WordRow): { doc: string; rev: string; at: number } | undefined {
  const seen = seenRevs.get(keyOf(r))
  return seen?.doc === r.doc ? seen : undefined
}

/** Whether the document holds edits the Word file has not: by its live revision once seen. */
function editsSince(r: WordRow): boolean {
  const seen = seenWord(r)?.rev
  const written = r.saved_rev ?? r.base_rev
  if (written === null && r.doc_at === null) return true
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
       ON CONFLICT (workspace_id, host, path) DO UPDATE SET vm = excluded.vm, name = excluded.name, version = excluded.version, sha = excluded.sha, doc = NULL, doc_at = NULL, saved_at = NULL, saved_doc_at = NULL, saved_rev = NULL, base_rev = NULL, stopped = NULL, stopped_version = NULL, tried_sha = NULL, at = excluded.at`
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
 * Where the document made of a Word file's copy goes (files/hooks.ts `registerImportPlace`): the workspace's hidden Word
 * store under this host's data (wordStore.ts), never his folder, for a copy in a Files pane whose tab shows a Word file
 * of another computer; null for anything else.
 */
export function wordImportPlace(ctx: WorkCtx, original: string, itemId: string | undefined): string | null {
  const item = itemId ? ctx.canvas.get(itemId) : null
  const workspaceId = item ? filesPaneWorkspace(item.sessionId) : null
  if (!item || !workspaceId || item.source.at !== 'file' || dirname(item.source.path) !== dirname(original)) return null
  const tab = wordTab(ctx, itemId, workspaceId)
  if (!tab || !wordRow(ctx, workspaceId, tab.copyOf!.host, tab.copyOf!.path) || !workspaceHere(ctx.db, workspaceId)) return null
  return wordStore(ctx.dataDir, workspaceId)
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
  // A refusal stands until a save lands after it: the line never sits at Saving over one.
  const refused = refusedWords.get(keyOf(r))
  const stands = refused && !(r.saved_at && r.saved_at >= refused.at)
  return { ...(r.saved_at ? { at: r.saved_at } : {}), since, ...(r.auto === null ? {} : { auto: r.auto === 1 }), ...(r.stopped ? { stopped: r.stopped, ...(r.stopped_version ? { stoppedVersion: r.stopped_version } : {}) } : {}), ...(stands ? { refused: refused.words } : {}) }
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
 * looked); one he changed is kept with its record, for the Word file's next open. Never changed is asked at the close:
 * the service first stores what a window sent it, then its live revision must still be the one the document was made
 * at. What the autosave saw last only rules a document out; a service that does not answer keeps it.
 */
export async function wordsLeft(ctx: Pick<WorkCtx, 'db' | 'canvas' | 'service' | 'host' | 'log'>, items: readonly CanvasItem[]): Promise<void> {
  for (const item of items) {
    if (item.kind !== 'document' || item.source.at !== 'file') continue
    const r = ctx.db.prepare(`SELECT * FROM work_files_word WHERE doc = ?`).get(item.source.path) as WordRow | undefined
    if (!r || shownElsewhere(ctx, item, r.doc!)) continue
    const now = mtime(r.doc!)
    if (now !== null && now !== r.doc_at) continue
    // The file's time alone does not say he typed nothing, nor does the autosave's last look: his words are in the
    // service as he types, and the last of them may have come after that look.
    const seen = seenWord(r)?.rev
    if (r.saved_rev !== null || r.base_rev === null || seen === undefined || seen !== r.base_rev) continue
    let live: string
    try {
      await ctx.service.internal('/internal/docs/stored', { name: fileDocName(r.doc!), fence: { sectors: 'all' } })
      live = await liveRev(ctx as WorkCtx, r.doc!)
    } catch (err) {
      ctx.log(`files: ${r.name}'s document is kept: the service could not say it is unchanged (${err instanceof Error ? err.message : String(err)})`)
      continue
    }
    // Asked again after the wait: opened again meanwhile, saved, or written since, it stays.
    const after = ctx.db.prepare(`SELECT * FROM work_files_word WHERE workspace_id = ? AND host = ? AND path = ?`).get(r.workspace_id, r.host, r.path) as WordRow | undefined
    if (live !== r.base_rev || !after || after.doc !== r.doc || after.saved_rev !== null || mtime(r.doc!) !== now || shownElsewhere(ctx, item, r.doc!)) continue
    ctx.db.prepare(`DELETE FROM work_files_word WHERE workspace_id = ? AND host = ? AND path = ?`).run(r.workspace_id, r.host, r.path)
    seenRevs.delete(keyOf(r))
    if (now !== null) rmSync(r.doc!, { force: true })
  }
}
/** Whether another open item shows this document: in the same pane, or in any thread's or pane's of any workspace. */
function shownElsewhere(ctx: Pick<WorkCtx, 'canvas' | 'db'>, item: CanvasItem, doc: string): boolean {
  if (ctx.canvas.forSession(item.sessionId).some((open) => open.id !== item.id && open.source.at === 'file' && open.source.path === doc)) return true
  const hint = `%${JSON.stringify(basename(doc)).slice(1, -1).replace(/[%_\\]/g, (c) => `\\${c}`)}%`
  const rows = ctx.db.prepare(`SELECT source FROM work_canvas_items WHERE state = 'open' AND id != ? AND source LIKE ? ESCAPE '\\'`).all(item.id, hint) as { source: string }[]
  return rows.some((r) => {
    try {
      const source = JSON.parse(r.source) as CanvasItem['source']
      return source.at === 'file' && source.path === doc
    } catch {
      return false
    }
  })
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
/** The sha256 a version word (`size:mtime:sha`) carries: the holder's digest of the bytes of that version; null when it gives none. */
const digestOf = (version: string): string | null => {
  const sha = version.split(':')[2] ?? ''
  return /^[0-9a-f]{64}$/.test(sha) ? sha : null
}
/**
 * Whether bytes of this digest are the ones TempCode itself last wrote to the Word file: the export its last save
 * wrote (`sha` once `saved_at` is set), one whose answer was lost (`tried_sha`), or our own blank New made there.
 * Nothing of anyone's to keep is in them.
 */
const ourBytes = (r: WordRow, digest: string | null): boolean =>
  digest !== null && ((digest === r.sha && (r.saved_at !== null || bornHere(digest))) || digest === r.tried_sha)
/** When a version word (`size:mtime:sha`, the helper's and the door's alike) says the file last changed. */
const changedOf = (version: string): number => Number(version.split(':')[1]) || Date.now()

/** The Word file as it was before TempCode's first write over it, kept once in the workspace's Word store beside his document. */
function keepOriginal(ctx: WorkCtx, r: WordRow, data: Buffer): void {
  if (r.original || !workspaceHere(ctx.db, r.workspace_id)) return
  const folder = wordStore(ctx.dataDir, r.workspace_id)
  const { stem, ext } = splitName(r.name)
  const name = freeName(`${stem} (before TempCode saved it)${ext}`, (n) => existsSync(join(folder, n)))
  writeFileSync(join(folder, name), data, { flag: 'wx' })
  ctx.db.prepare(`UPDATE work_files_word SET original = ? WHERE workspace_id = ? AND host = ? AND path = ?`).run(join(folder, name), r.workspace_id, r.host, r.path)
}

/**
 * `work.files.wordSave`: Save as Word. The file as it is there now is read first: unchanged since it was read (by
 * version, or when only its version moved, by its bytes' hash: a sync's touch, an older build's copy with no version
 * on record), it is written over; changed there, the answer says when, and only `replace` (his press on Replace) writes
 * over it. Before the first write over the file its bytes are kept in the workspace's Word store. `keep` puts his
 * version beside the file instead.
 */
export async function wordSave(ctx: WorkCtx, by: Caller, p: { workspaceId: string; tabId: string; keep?: boolean; replace?: boolean; seen?: number; version?: string; auto?: boolean }): Promise<WordSaved> {
  const r = recordOfWordTab(ctx, p.workspaceId, p.tabId)
  admitOwner(by, r)
  return (await saveRow(ctx, r, p))!
}

/** One save of a Word file's document as Word, as `wordSave` and the host's autosave run it. */
async function saveRow(ctx: WorkCtx, r: WordRow, p: { workspaceId: string; keep?: boolean; replace?: boolean; seen?: number; version?: string; auto?: boolean }, observed?: { rev: string; current: () => boolean }): Promise<WordSaved | undefined> {
  const row = { workspace_id: r.workspace_id, host: r.host, path: r.path, vm: r.vm, name: r.name, version: r.version }
  let version = r.version
  if (!p.keep) {
    // The file's version first, with one byte of it; the whole file is pulled only when it must be: its version moved
    // (only its bytes tell SharePoint's touch from an edit), its host names no version, or its original is still owed
    // a copy in the workspace's Word store (the first save over it).
    const gone = (err: unknown): boolean => /not there any more|gone|not found|No file/i.test(err instanceof Error ? err.message : String(err))
    let seen: string | null
    try {
      seen = await freshVersion(ctx, row)
    } catch (err) {
      if (gone(err)) return { conflict: { gone: true } }
      throw err
    }
    // Owed no copy while the holder's digest for the version it names proves the file is still TempCode's own bytes.
    const owed = !r.original && !!workspaceHere(ctx.db, r.workspace_id) && !(seen !== null && ourBytes(r, digestOf(seen)))
    let now: { data: Buffer; version: string } | null = null
    if (seen === null || seen !== r.version || owed) {
      try {
        now = await freshBytes(ctx, row)
      } catch (err) {
        if (gone(err)) return { conflict: { gone: true } }
        throw err
      }
    }
    if (observed && !observed.current()) return
    const nowVersion = now?.version ?? seen!
    // the same version, the same bytes, or only SharePoint's own rewrite of them after an upload (body.ts)
    // An export of his whose answer was lost (`tried_sha`) found there is his own write, not a change made there.
    const same = nowVersion === r.version || (!!now && ((knownSha(r) !== null && shaOf(now.data) === knownSha(r)) || (!!r.tried_sha && shaOf(now.data) === r.tried_sha) || sameBody(ctx, r, now.data)))
    // His Replace covers the change its dialog named by its version, never one made there after he read it, even in
    // the same millisecond; a Replace that names none (a window a release behind) is asked again.
    if (!same && (!p.replace || p.version !== nowVersion)) {
      // An autosave that meets a change made there stops for this file until his press: never a silent overwrite. A
      // stopped file that changed again says the newer change, which his next Replace names.
      if (p.auto || r.stopped) {
        ctx.db.prepare(`UPDATE work_files_word SET stopped = ?, stopped_version = ? WHERE workspace_id = ? AND host = ? AND path = ?`).run(changedOf(nowVersion), nowVersion, r.workspace_id, r.host, r.path)
        filesState(ctx).tabs.touch(p.workspaceId)
      }
      return { conflict: { changed: changedOf(nowVersion), version: nowVersion } }
    }
    // An autosave goes only where he chose it and nothing stopped it.
    if (p.auto && (r.auto !== 1 || r.stopped)) return { conflict: { changed: r.stopped ?? changedOf(nowVersion), version: r.stopped_version ?? nowVersion } }
    // Written over by the version just seen: the write itself is checked against it there (deliver), so a change made
    // between this look and the write is a conflict, never a silent overwrite.
    version = nowVersion
    // A file still exactly our blank, or the bytes TempCode last wrote there, holds nothing of anyone's to keep.
    if (now && !bornHere(shaOf(now.data)) && !ourBytes(r, shaOf(now.data))) keepOriginal(ctx, r, now.data)
  }
  // The revision written is the one read before the export: an edit after it keeps the file behind, and is saved next.
  // Read after, an edit landing during the export would be marked saved with words the file never got.
  const docAt = mtime(r.doc!)
  const writtenRev = observed?.rev ?? await liveRev(ctx, r.doc!).catch(() => null)
  const { exportDoc } = await import('../formats/exporter')
  if (observed && !observed.current()) return
  const out = await exportDoc(ctx, LOCAL, { source: { at: 'file', host: ctx.host, path: r.doc! }, format: 'docx' })
  const data = Buffer.from(out.data, 'base64')
  // Kept until the answer: a send whose answer is lost is known as his own on the next press.
  if (!p.keep) ctx.db.prepare(`UPDATE work_files_word SET tried_sha = ? WHERE workspace_id = ? AND host = ? AND path = ?`).run(shaOf(data), r.workspace_id, r.host, r.path)
  const got = await deliver(ctx, { ...row, version }, data, !!p.keep)
  if ('conflict' in got) return { conflict: 'gone' in got.conflict ? { gone: true } : { changed: got.conflict.changed, version: got.conflict.version } }
  if ('copy' in got) return { copy: { name: got.copy.name } }
  const at = Date.now()
  ctx.db.prepare(`UPDATE work_files_word SET version = ?, sha = ?, saved_at = ?, saved_doc_at = ?, saved_rev = ?, stopped = NULL, stopped_version = NULL, tried_sha = NULL WHERE workspace_id = ? AND host = ? AND path = ?`).run(got.version, shaOf(data), at, docAt, writtenRev, r.workspace_id, r.host, r.path)
  filesState(ctx).tabs.touch(p.workspaceId)
  return { at }
}

/** `pause`: how long his document must be still before the host saves it as Word by itself; `read`: a live revision's wait. */
export const wordTiming = { pause: 3000, read: 2000 }
const saving = new Set<string>()
/** The last autosave's refusal of each record, and when (`wordBackOf`): kept in memory, the next look tries again. */
const refusedWords = new Map<string, { words: string; at: number }>()

function wordRows(ctx: WorkCtx, doc: string): WordRow[] {
  return ctx.db.prepare(`SELECT * FROM work_files_word WHERE doc = ?`).all(doc) as unknown as WordRow[]
}

function observeWord(ctx: WorkCtx, r: WordRow, rev: string, now: number, baseline: boolean): void {
  const was = seenWord(r)
  if (was?.rev === rev) return
  const dirty = editsSince(r)
  seenRevs.set(keyOf(r), { doc: r.doc!, rev, at: now })
  if (baseline && r.base_rev === null && r.saved_rev === null && r.doc_at !== null && !was && mtime(r.doc!) === r.doc_at) {
    ctx.db.prepare(`UPDATE work_files_word SET base_rev = ? WHERE workspace_id = ? AND host = ? AND path = ?`).run(rev, r.workspace_id, r.host, r.path)
    r.base_rev = rev
  }
  if (dirty !== editsSince(r)) filesState(ctx).tabs.touch(r.workspace_id)
}

export function noteWordRevision(ctx: WorkCtx, { doc, rev, loaded }: DocRevision, now: number): boolean {
  let dirty = false
  for (const row of wordRows(ctx, doc)) {
    observeWord(ctx, row, rev, now, !!loaded)
    if (row.auto === 1 && !row.stopped && editsSince(row)) dirty = true
  }
  return dirty
}

export async function saveWordRevision(ctx: WorkCtx, doc: string, now: number, active: () => boolean): Promise<void> {
  await saveDueWords(ctx, wordRows(ctx, doc), now, active)
}

/** The backstop also drops Word records whose document is gone and outside Files' Trash. */
export async function autosaveWords(ctx: WorkCtx, now = Date.now(), found?: (notice: DocRevision) => void): Promise<void> {
  if (looking) return
  looking = true
  const looked: WordRow[] = []
  try {
    const rows = ctx.db.prepare(`SELECT * FROM work_files_word WHERE doc IS NOT NULL`).all() as unknown as WordRow[]
    for (const r of rows) {
      if (!existsSync(r.doc!)) {
        // By where it was first (an index answers); only a row that names the document some other way is looked for by a scan.
        const trashed =
          ctx.db.prepare(`SELECT 1 FROM work_files_trash WHERE was_at = ? LIMIT 1`).get(r.doc) ??
          ctx.db.prepare(`SELECT 1 FROM work_files_trash WHERE instr(ref, ?) > 0 LIMIT 1`).get(r.doc)
        if (!trashed) {
          ctx.db.prepare(`DELETE FROM work_files_word WHERE workspace_id = ? AND host = ? AND path = ?`).run(r.workspace_id, r.host, r.path)
          seenRevs.delete(keyOf(r))
        }
        continue
      }
      const shown = ctx.canvas.forSession(filesPaneOf(r.workspace_id)).some((i) => i.source.at === 'file' && i.source.path === r.doc)
      if (!shown && (r.auto !== 1 || (!found && seenWord(r) && !editsSince(r)))) continue
      looked.push(r)
    }
    await Promise.all(looked.map(async (r) => {
      const before = seenWord(r)
      const rev = await withinWait(liveRev(ctx, r.doc!), wordTiming.read).catch(() => null)
      if (rev === null || before !== seenWord(r)) return
      if (found) found({ doc: r.doc!, rev, loaded: true })
      else observeWord(ctx, r, rev, now, true)
    }))
  } finally {
    looking = false
  }
  if (!found) await saveDueWords(ctx, looked, now)
}
let looking = false

async function saveDueWords(ctx: WorkCtx, rows: WordRow[], now: number, active = () => true): Promise<void> {
  await Promise.all(rows.map(async (r) => {
    const key = keyOf(r)
    const seen = seenWord(r)
    if (!seen || now - seen.at < wordTiming.pause || r.auto !== 1 || r.stopped || saving.has(key) || !editsSince(r)) return
    saving.add(key)
    try {
      await saveRow(ctx, r, { workspaceId: r.workspace_id, auto: true }, {
        rev: seen.rev,
        current: () => {
          if (!active() || seen !== seenWord(r)) return false
          const latest = wordRow(ctx, r.workspace_id, r.host, r.path)
          return latest?.doc === r.doc && latest.version === r.version && latest.auto === 1 && !latest.stopped
        }
      })
      // Answered: a refusal before it no longer stands.
      if (refusedWords.delete(key)) filesState(ctx).tabs.touch(r.workspace_id)
    } catch (err) {
      const words = err instanceof Error ? err.message : String(err)
      // A computer or drive that did not answer is tried again on the next look, the line still saving; anything else
      // is a refusal his line says, in its own words, until a save lands.
      const before = refusedWords.get(key)?.words
      if (unreachable(err)) refusedWords.delete(key)
      else refusedWords.set(key, { words: words.slice(0, 300), at: Date.now() })
      if (before !== refusedWords.get(key)?.words) filesState(ctx).tabs.touch(r.workspace_id)
      ctx.log(`files: a Word file was not saved by itself: ${words}`)
    } finally {
      saving.delete(key)
    }
  }))
}

/** A read that has not answered in `ms` is no answer this look. */
const withinWait = <T>(p: Promise<T>, ms: number): Promise<T> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no answer in time')), ms)
    p.then((v) => (clearTimeout(timer), resolve(v)), (e) => (clearTimeout(timer), reject(e)))
  })
