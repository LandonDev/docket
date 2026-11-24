import type { FileOrigin, SavedAsWord, WrittenBack } from '@shared/contract-work-files'
import { canvasSourcePath, filesPaneOf, type CanvasSource } from '@shared/work'
import { refKey, type FolderRef } from '@shared/work/files'
import { attachmentDocPathOf } from '../docs/target'
import type { Caller, WorkCtx } from '../modules'
import { admitOwner } from './copies'
import { admitChange, HELD_BY_TOOLS, THREADS_BY_TOOLS } from './handle'
import { admitCaller } from './policy'
import { makeBytes, makeFolderRef } from './verbs'
import { runOp } from './write'

/**
 * Save as Word to… (docs/agents/work-files.md "Save as Word to a folder"; the owner's ask of 2026-11-24): any document
 * he has open, written as a NEW .docx into a folder he picks: the workspace's own folder, a Teams or OneDrive library
 * on this host or in its Windows VM, or a library on another computer of his. The Word file is the Work service's
 * export of the live text (`exportDoc`); it lands under a free name, never over anything, through Files' one door as
 * a `make` in that folder. His press alone: his window, or a key that may approve where others can open the folder;
 * a thread is refused at the wire (`CHANGES`), a read key by its capability.
 */

const NOT_A_FOLDER_HERE = 'A Word file is saved into a folder on a computer: the workspace\'s folder, Teams or OneDrive.'
const DOC_ELSEWHERE = 'That document is on another host: save it as Word there.'
const NOT_OPEN_HERE = 'That document is not open in this workspace.'

/**
 * Whether a document is the workspace's own to export: an open item of it (a Files tab, a pane's, a thread's) shows it,
 * or it is the document a mail's attachment open there was read into. A document of another job is never written here.
 */
function openIn(ctx: WorkCtx, workspaceId: string, source: CanvasSource): boolean {
  const key = refKey(source)
  const path = canvasSourcePath(source)
  return ctx.canvas.forWorkspace(workspaceId, { open: true, panes: true }).some((item) => refKey(item.source) === key || (path !== null && item.source.at === 'mail' && attachmentDocPathOf(ctx.dataDir, item) === path))
}

/** The export's own name, or his, as a Word file's name. */
function wordName(name: string): string {
  const trimmed = name.trim()
  return /\.docx$/i.test(trimmed) ? trimmed : `${trimmed}.docx`
}

export async function saveAsWord(ctx: WorkCtx, by: Caller, p: { workspaceId: string; source: CanvasSource; at: FolderRef; name?: string; op: string }, method: string): Promise<SavedAsWord> {
  if (by.kind === 'model') throw new Error(THREADS_BY_TOOLS)
  admitCaller(ctx, by, p.workspaceId)
  if (by.kind === 'remote' && !by.caps.includes('operate')) throw new Error('This key may not change files.')
  if (p.source.at === 'file' && p.source.host !== ctx.host) throw new Error(DOC_ELSEWHERE)
  if (!openIn(ctx, p.workspaceId, p.source)) throw new Error(NOT_OPEN_HERE)
  const at = makeFolderRef(ctx, by, p.at)
  if (at.at === 'drive' || at.at === 'project') throw new Error(NOT_A_FOLDER_HERE)
  const far = at.at === 'file' && at.host !== ctx.host ? at : null
  // The door before anything is exported: a folder here as New's, one on another computer as his own edit there.
  if (far) admitOwner(by, { name: 'that folder', host: far.host })
  else if (admitChange(ctx, by, 'make', { workspaceId: p.workspaceId, refs: [at] }, method) === 'hold') throw new Error(HELD_BY_TOOLS)
  return runOp(ctx.db, { id: p.op, workspaceId: p.workspaceId, verb: 'saveAsWord', refs: { source: p.source, at, name: p.name ?? null } }, async () => {
    const { exportDoc } = await import('../formats/exporter')
    const out = await exportDoc(ctx, by, { source: p.source, format: 'docx' })
    const name = wordName(p.name?.trim() || out.name)
    const data = Buffer.from(out.data, 'base64')
    if (!far) {
      const done = await makeBytes(ctx, by, { workspaceId: p.workspaceId, at, name, data, op: p.op }, method)
      const ref = done.entries[0]?.ref
      if (!ref) throw new Error('The Word file was not made.')
      return { name: done.entries[0]!.name, ref }
    }
    // A library on another computer of his: that host makes the file in its folder through its own door (`writeBack` with `into`).
    const origin: FileOrigin = { from: 'window' }
    const peer = ctx.peer.call({ scope: { sessionId: filesPaneOf(p.workspaceId), workspaceId: p.workspaceId } } as never, far.host)
    const ref: CanvasSource = { at: 'file', host: far.host, path: `${far.path.replace(/[\\/]+$/, '')}/${name}` }
    const got = (await peer.call('files', 'writeBack', { workspaceId: p.workspaceId, ref, data: out.data, version: '', origin, into: true })) as WrittenBack
    if (!('copy' in got)) throw new Error('The Word file was not made.')
    return { name: got.copy.name, ref: { at: 'file', host: far.host, path: got.copy.path } }
  })
}
