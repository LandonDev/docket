import { existsSync } from 'node:fs'
import { basename, dirname, extname, join, relative, isAbsolute } from 'node:path'
import { fileDocName } from 'work-kit/collab-server'
import { canvasSourcePath, type CanvasItem, type CanvasSource } from '@shared/work'
import { FenceError } from '../../remote/fence'
import type { Caller, WorkCtx } from '../modules'
import { canonicalPath } from '../service/ctx'
import { fetchedFile } from '../canvas/fetch'
import { importsRoot } from '../files/imports'
import { sharedOf } from '../files/policy'

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
  | { at: 'file'; doc: string; path: string; source: Extract<CanvasSource, { at: 'file' }> }

/** A LifeOS document's row as `docs:get` answers the owner (M17). */
export interface LifeosDocRow {
  _id: string
  title: string
  sector: string
  shared: boolean
  projectId?: string
  editedAt?: number
}

export async function targetOf(ctx: WorkCtx, by: Caller, method: string, source: CanvasSource): Promise<DocTarget> {
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
 * another host, the Windows VM), or the `.tcdoc` the importer wrote under
 * `work-files/imports` for a file in a library (it writes there for no
 * other). An agent only suggests on such a document, and what is made of it
 * (a converted copy, a preview's render) never leaves this host.
 */
export function madeFromShared(ctx: Pick<WorkCtx, 'db' | 'host' | 'dataDir'>, source: CanvasSource): boolean {
  if (sharedOf(ctx, source)) return true
  const path = canvasSourcePath(source)
  if (!path) return false
  return isInside(path, importsRoot(ctx.dataDir))
}

/** Whether anyone but the owner can open it: its LifeOS row is shared (a guest link), or the file lies where others reach it. */
export const othersOpen = (ctx: Pick<WorkCtx, 'db' | 'host' | 'dataDir'>, t: DocTarget, row: LifeosDocRow | null): boolean =>
  !!row?.shared || (t.at === 'file' && madeFromShared(ctx, t.source))

/** Its title: LifeOS's, or the file's name without `.tcdoc`. */
export const titleOf = (t: DocTarget, row: LifeosDocRow | null): string => row?.title ?? basename(t.at === 'file' ? t.path : t.doc).replace(/\.tcdoc$/i, '')

/**
 * What the Work service is told a target is: a LifeOS id under the caller's sectors (the service holds
 * the row to them again, `docIn`), or a resolved path with whether others share it. A file is the
 * host's own, read unfenced once main's path fence let it through.
 */
export const serviceTarget = (t: DocTarget, shared: boolean, sectors: readonly string[] | 'all' = 'all'): Record<string, unknown> =>
  t.at === 'lifeos' ? { docId: t.docId, fence: { sectors } } : { file: t.path, shared, fence: { sectors: 'all' } }

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
