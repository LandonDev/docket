import { existsSync } from 'node:fs'
import { basename } from 'node:path'
import { fileDocName } from 'work-kit/collab-server'
import type { CanvasSource } from '@shared/work'
import { FenceError } from '../../remote/fence'
import type { Caller, WorkCtx } from '../modules'
import { canonicalPath } from '../service/ctx'

/**
 * What a source names, as the Work service and LifeOS know it
 * (docs/agents/work-docs.md "Sources"). A LifeOS project note resolves to the
 * document it is (`projectDocs:open`, null while LifeOS keeps it as markdown);
 * a `.tcdoc` must be on this host and inside the caller's path fence.
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
    return { at: 'file', doc: fileDocName(path), path, source: { at: 'file', host: ctx.host, path } }
  }
  throw new Error('a document is a LifeOS document or a .tcdoc')
}

/** The row LifeOS keeps for a document, or null for a file. */
export async function lifeosRow(ctx: WorkCtx, t: DocTarget): Promise<LifeosDocRow | null> {
  if (t.at !== 'lifeos') return null
  const row = await ctx.lifeos.owner().query<LifeosDocRow | null>('docs:get', { id: t.docId })
  if (!row) throw new Error('LifeOS has no such document')
  return row
}

/** Its title: LifeOS's, or the file's name without `.tcdoc`. */
export const titleOf = (t: DocTarget, row: LifeosDocRow | null): string => row?.title ?? basename(t.at === 'file' ? t.path : t.doc).replace(/\.tcdoc$/i, '')

/** What the Work service is told a target is: a LifeOS id, or a resolved path with whether others share it. */
export const serviceTarget = (t: DocTarget, shared: boolean): Record<string, unknown> =>
  t.at === 'lifeos' ? { docId: t.docId, fence: { sectors: 'all' } } : { file: t.path, shared, fence: { sectors: 'all' } }

/** A file document's path, for a push only callers who could name it receive. */
export const pathOf = (t: DocTarget): string | undefined => (t.at === 'file' ? t.path : undefined)
