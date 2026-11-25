import { existsSync } from 'node:fs'
import { basename, dirname, extname, join, relative, isAbsolute } from 'node:path'
import { fileDocName } from 'work-kit/collab-server'
import { canvasSourcePath, type CanvasItem, type CanvasSource } from '@shared/work'
import { FenceError } from '../../remote/fence'
import type { Caller, WorkCtx } from '../modules'
import { canonicalPath } from '../service/ctx'
import { fetchedFile } from '../canvas/fetch'
import { importsRoot, wordStoreRoot } from '../files/imports'
import { MAIL_NEEDS_APPROVE, sharedOf } from '../files/policy'
import { fileLinked } from '../guests/store'

/**
 * What a source names, as the Work service and LifeOS know it
 * (docs/agents/work-docs.md "Sources"). A LifeOS project note resolves to the
 * document it is (`projectDocs:open`, null while LifeOS keeps it as markdown);
 * a `.tcdoc` must be on this host and inside the caller's path fence; a
 * Google Doc is its mirror on this host (work/google), outside any fence
 * since no caller names that path.
 */
export type DocTarget =
  | { at: 'lifeos'; doc: string; docId: string; source: Extract<CanvasSource, { at: 'lifeos' }> }
  | { at: 'file'; doc: string; path: string; source: Extract<CanvasSource, { at: 'file' }>; shown?: Extract<CanvasSource, { at: 'mail' }> }

/** A LifeOS document's row as `docs:get` answers the owner (M17). */
export interface LifeosDocRow {
  _id: string
  title: string
  sector: string
  shared: boolean
  projectId?: string
  editedAt?: number
}

/**
 * The document a mail's or a chat's attachment was read into (`attachmentDoc`), found by its ITEM: the window names
 * the attachment's own source and the item that shows it, and this host finds the file itself, so no path of its data
 * directory crosses the wire (a remote key could not name one past the fence, and must not). The item must be open
 * here, fetched, and show this very source, as `importAttachment` asks; the document must have been read already.
 */
export function attachmentPathOf(ctx: Pick<WorkCtx, 'dataDir' | 'canvas'>, by: Caller, source: Extract<CanvasSource, { at: 'mail' }>, itemId: string | undefined): string {
  // His mail's bytes are read by a key that may approve, as fetching them is (`work.canvas.fetch`, files/policy.ts).
  if (by.kind === 'remote' && !by.caps.includes('approve')) throw new Error(MAIL_NEEDS_APPROVE)
  const item = itemId ? ctx.canvas.get(itemId) : null
  if (item?.source?.at !== 'mail' || JSON.stringify(item.source) !== JSON.stringify(source)) throw new Error("that attachment is not this item's")
  // A thread reads an attachment of its own canvas alone.
  if (by.kind === 'model' && by.sessionId !== item.sessionId) throw new Error("that attachment is not this item's")
  const path = attachmentDoc(ctx, item)
  if (!path) throw new Error(`${item.title} has not been read as a document yet.`)
  return canonicalPath(path)
}

/**
 * `itemId`: the canvas item that shows a mail's attachment, when `source` is that attachment (`attachmentPathOf`).
 * The target then keeps the attachment as its `shown` source: what the window names in later calls.
 */
export async function targetOf(ctx: WorkCtx, by: Caller, method: string, source: CanvasSource, itemId?: string): Promise<DocTarget> {
  if (source.at === 'mail') {
    const path = attachmentPathOf(ctx, by, source, itemId)
    return { at: 'file', doc: fileDocName(path), path, source: { at: 'file', host: ctx.host, path }, shown: source }
  }
  if (source.at === 'lifeos' && source.table === 'docs') return { at: 'lifeos', doc: source.id, docId: source.id, source }
  if (source.at === 'lifeos' && source.table === 'projectDocs') {
    const docId = await ctx.lifeos.owner().mutation<string | null>('projectDocs:open', { id: source.id })
    if (!docId) throw new Error('LifeOS keeps this note as text for now; it opens as a document once block documents are on.')
    return { at: 'lifeos', doc: docId, docId, source: { at: 'lifeos', table: 'docs', id: docId } }
  }
  if (source.at === 'file' && source.path.toLowerCase().endsWith('.tcdoc')) {
    // A source names its host by environment id, or as this host saw it when it was opened.
    if (source.host !== ctx.host && !existsSync(source.path)) throw new Error('that document is on another host; open it there')
    if (!ctx.reaches(by, source.path)) throw new FenceError(method)
    const path = canonicalPath(source.path)
    // A Google Doc's mirror is reached only through its item: a thread naming the file would write past Google's suggestions.
    if (by.kind === 'model' && ctx.dataDir && isInside(path, join(ctx.dataDir, 'google'))) throw new Error('That file is a Google Doc: read it with google_doc_read and change it with google_doc_suggest.')
    return { at: 'file', doc: fileDocName(path), path, source: { at: 'file', host: ctx.host, path } }
  }
  // A Google Doc opens on its mirror, read from Google when it moved (work/google/docs.ts).
  if (source.at === 'google') {
    const { docMirror } = await import('../google/docs')
    const { googleOf } = await import('../google/google')
    // Google is asked whether the Doc moved only when the item opens; every other call takes the mirror there is.
    const path = await docMirror(ctx, googleOf(ctx), source, method === 'work.docs.open')
    return { at: 'file', doc: fileDocName(path), path, source: { at: 'file', host: ctx.host, path } }
  }
  throw new Error('a document is a LifeOS document, a .tcdoc or a Google Doc')
}

const isInside = (path: string, dir: string): boolean => {
  const r = relative(dir, path)
  return r !== '' && !r.startsWith('..') && !isAbsolute(r)
}

/** The row LifeOS keeps for a document, or null for a file. */
export async function lifeosRow(ctx: WorkCtx, t: DocTarget): Promise<LifeosDocRow | null> {
  if (t.at !== 'lifeos') return null
  const row = await ctx.lifeos.owner().query<LifeosDocRow | null>('docs:get', { id: t.docId })
  if (!row) throw new Error('LifeOS has no such document')
  return row
}

/**
 * Whether a document is, or was made from, a file others can open: a source
 * `sharedOf` says is shared (a Teams or OneDrive library, the cloud folder,
 * another host, the Windows VM), the `.tcdoc` the importer wrote under
 * `work-files/imports` for a file in a library (it writes there for no
 * other), or the document kept for a Word file of another computer
 * (files/word.ts): by its record wherever it lies, and by where it lies for
 * anything in the hidden Word store (files/wordStore.ts), record or none.
 * That Word file is a library's, and
 * Save as Word and the autosave carry this document's live text to it. An
 * agent only suggests on such a document, and what is made of it (a
 * converted copy, a preview's render) never leaves this host.
 */
export function madeFromShared(ctx: Pick<WorkCtx, 'db' | 'host' | 'dataDir'>, source: CanvasSource): boolean {
  if (sharedOf(ctx, source)) return true
  const path = canvasSourcePath(source)
  if (!path) return false
  return isInside(path, importsRoot(ctx.dataDir)) || isInside(path, wordStoreRoot(ctx.dataDir)) || keptForWord(ctx, path)
}

/**
 * Whether a Word file's record names this `.tcdoc` as its kept document (`work_files_word.doc`), by its real path.
 * Read here by name, as files/moved.ts reads the docs tables; a database without the table (a test's) keeps none.
 */
function keptForWord(ctx: Pick<WorkCtx, 'db'>, path: string): boolean {
  if (!ctx.db || !path.toLowerCase().endsWith('.tcdoc')) return false
  if (!(ctx.db.prepare(`SELECT count(*) AS n FROM pragma_table_info('work_files_word')`).get() as { n: number }).n) return false
  const docs = ctx.db.prepare(`SELECT doc FROM work_files_word WHERE doc IS NOT NULL`).all() as { doc: string }[]
  // By name first (a Windows disk ignores its case), so a workspace's many records cost no real path each.
  const name = basename(path).toLowerCase()
  const near = docs.filter((r) => basename(r.doc).toLowerCase() === name)
  if (!near.length) return false
  const at = canonicalPath(path)
  return near.some((r) => r.doc === path || canonicalPath(r.doc) === at)
}

/**
 * Whether a document is linked by Save As (`work_files_links.doc`, files/saveAs.ts): the host writes each of its edits
 * to the linked file again after a pause, so what it holds reaches a file others can open with no press of his.
 */
export function linkedOut(ctx: Pick<WorkCtx, 'db'>, path: string): boolean {
  if (!ctx.db || !path.toLowerCase().endsWith('.tcdoc')) return false
  if (linking.has(canonicalPath(path))) return true
  if (!(ctx.db.prepare(`SELECT count(*) AS n FROM pragma_table_info('work_files_links')`).get() as { n: number }).n) return false
  const docs = ctx.db.prepare(`SELECT DISTINCT doc FROM work_files_links`).all() as { doc: string }[]
  const name = basename(path).toLowerCase()
  const near = docs.filter((r) => basename(r.doc).toLowerCase() === name)
  if (!near.length) return false
  const at = canonicalPath(path)
  return near.some((r) => r.doc === path || canonicalPath(r.doc) === at)
}

/**
 * The hold's race (C1): a Save As link makes its document shared before anything is exported, not once its file is
 * made. `reserveLink` counts the document linked from his press (`linkedOut`), so an agent's write or format whose
 * verdict is read after it only suggests. One whose verdict was read while the document was still private registers
 * in the same turn (`privateWrite`, docs/tools.ts), and the press waits for it (`settlePrivateWrites`): if it wrote
 * straight into the document, Save As stops until he has looked at it, so the link never carries an agent's words he
 * did not see.
 */
const linking = new Map<string, number>()
const privateWrites = new Map<string, Set<{ direct: boolean; done: Promise<void> }>>()

/** The document counted linked until the returned release: called once the link's row is written, or the press failed. */
export function reserveLink(path: string): () => void {
  const key = canonicalPath(path)
  linking.set(key, (linking.get(key) ?? 0) + 1)
  let held = true
  return () => {
    if (!held) return
    held = false
    const n = (linking.get(key) ?? 1) - 1
    if (n > 0) linking.set(key, n)
    else linking.delete(key)
  }
}

/** An agent's write to a document it found private, from its verdict to its answer: `end(true)` once it wrote straight in. */
export function privateWrite(path: string): { end: (direct?: boolean) => void } {
  const key = canonicalPath(path)
  let settle!: () => void
  const w = { direct: false, done: new Promise<void>((r) => (settle = r)) }
  const set = privateWrites.get(key) ?? new Set()
  set.add(w)
  privateWrites.set(key, set)
  return {
    end(direct = false) {
      w.direct ||= direct
      set.delete(w)
      if (!set.size && privateWrites.get(key) === set) privateWrites.delete(key)
      settle()
    }
  }
}

/** Whether a private write on its way when this was asked wrote straight into the document; one that does not answer in time counts as one that did. */
export async function settlePrivateWrites(path: string, ms = 20_000): Promise<boolean> {
  const ws = [...(privateWrites.get(canonicalPath(path)) ?? [])]
  if (!ws.length) return false
  let timer: ReturnType<typeof setTimeout> | undefined
  const settled = await Promise.race([Promise.all(ws.map((w) => w.done)).then(() => true), new Promise<false>((r) => (timer = setTimeout(() => r(false), ms)))])
  clearTimeout(timer)
  return !settled || ws.some((w) => w.direct)
}

/**
 * Whether anyone but the owner can open it: its LifeOS row is shared (a guest link), a guest link names the file, the file lies where others reach
 * it, or Save As links it to a file that does: an agent only suggests on it, so the link carries no word of an agent's
 * before his accept.
 */
export const othersOpen = (ctx: Pick<WorkCtx, 'db' | 'host' | 'dataDir'>, t: DocTarget, row: LifeosDocRow | null): boolean =>
  !!row?.shared || (t.at === 'file' && (madeFromShared(ctx, t.source) || linkedOut(ctx, t.path) || fileLinked(ctx.db, t.path)))

/** Its title: LifeOS's, or the file's name without `.tcdoc`. */
export const titleOf = (t: DocTarget, row: LifeosDocRow | null): string => row?.title ?? basename(t.at === 'file' ? t.path : t.doc).replace(/\.tcdoc$/i, '')

/**
 * What the Work service is told a target is: a LifeOS id under the caller's sectors (the service holds
 * the row to them again, `docIn`), or a resolved path with whether others share it. A file is the
 * host's own, read unfenced once main's path fence let it through.
 */
export const serviceTarget = (t: DocTarget, shared: boolean, sectors: readonly string[] | 'all' = 'all'): Record<string, unknown> =>
  t.at === 'lifeos' ? { docId: t.docId, fence: { sectors } } : { file: t.path, shared, fence: { sectors: 'all' } }

/** The source the window names this document by: a mail's attachment by its own, never the copy's path here. */
export const shownSource = (t: DocTarget): CanvasSource => (t.at === 'file' && t.shown ? t.shown : t.source)

/** A file document's path, for a push only callers who could name it receive. */
export const pathOf = (t: DocTarget): string | undefined => (t.at === 'file' ? t.path : undefined)

/** What a document read from a mail says to a write: it is his only once he keeps it. */
export const ATTACHMENT_READ_ONLY = "This document is a mail's attachment, read only: the person keeps it as a document of his own (Keep as document) before it can change."

/** The document a mail's attachment was read into: `<name>.tcdoc` beside the fetched file in the item's folder (formats/importer.ts). */
export const attachmentDocPathOf = (dataDir: string, item: CanvasItem): string => {
  const file = fetchedFile(dataDir, item)
  return join(dirname(file), `${basename(file, extname(file))}.tcdoc`)
}

/** That document, when the pane has opened the attachment; null before. */
export function attachmentDoc(ctx: Pick<WorkCtx, 'dataDir'>, item: CanvasItem): string | null {
  const path = attachmentDocPathOf(ctx.dataDir, item)
  return existsSync(path) ? path : null
}
