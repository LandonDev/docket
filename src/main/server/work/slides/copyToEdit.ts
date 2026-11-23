import { realpathSync } from 'node:fs'
import { basename, dirname } from 'node:path'
import { filesPaneWorkspace, paneWorkspace, type CanvasItem, type CanvasSource } from '@shared/work'
import { splitName } from '@shared/work/files'
import type { Caller, WorkCtx } from '../modules'
import { NEEDS_APPROVE, within, workspaceHere } from '../files/policy'
import { FileRefused, makeFile } from '../files/write'
import { copyWhole, sourcePath } from '../pdf/file'
import { deckPath, filePathOf, nameOf, OWN_FILE, readOnlyWhy, serial, sharedDeck } from './view'

export const COPY_HIS_PRESS = 'Only the owner makes a copy to edit, from his own window.'

/** The copy's name: the deck's own with `.pptx` for its ending, "Pitch.ppt" → "Pitch.pptx". */
const copyName = (item: CanvasItem): string => {
  // A Google deck's title has no ending to drop; a file's name has one.
  const name = nameOf(item, filePathOf(item.source))
  const stem = (item.source.at === 'google' ? name : splitName(name).stem).replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').trim().slice(0, 120)
  return `${stem || 'Slides'}.pptx`
}

/** Where the copy goes in the workspace's own folder: beside the original when it lies there and is his own, else at the top. */
function folderFor(ctx: Pick<WorkCtx, 'db' | 'host' | 'dataDir'>, item: CanvasItem, root: string): string {
  const path = filePathOf(item.source)
  // A library linked inside his folder is others' place: the copy never lands in it.
  if (!path || sharedDeck(ctx, item)) return root
  try {
    const dir = realpathSync(dirname(path))
    return within(dir, realpathSync(root)) ? dir : root
  } catch {
    return root
  }
}

/** Written through the Files door, never over a file: a taken name tries "Name 2.pptx", "Name 3.pptx". */
async function writeFresh(root: string, dir: string, name: string, from: string): Promise<string> {
  const { stem, ext } = splitName(name)
  for (let n = 1; n < 1000; n++) {
    try {
      return await makeFile({ roots: [root] }, dir, n === 1 ? name : `${stem} ${n}${ext}`, { from })
    } catch (err) {
      if (!(err instanceof FileRefused) || err.code !== 'taken') throw err
    }
  }
  throw new Error(`No free name for ${name} in that folder.`)
}

/**
 * "Make a copy to edit" (docs/agents/work-slides.md "Every format in"): a `.pptx` of a read-only deck (an import's
 * snapshot, a Google deck's mirror) that he can see in Files, opened in the same seat. In a Work workspace's pane
 * (a Files tab, a Work thread) it is a new file in the workspace's own folder, which is never a place others can
 * open; in a chat outside every workspace it is the thread's own deck and goes with the thread. His press only:
 * his window here or one of his own remote windows; never a thread, never another host's call.
 */
export async function copyToEdit(ctx: WorkCtx, by: Caller, item: CanvasItem): Promise<CanvasItem> {
  if (by.kind === 'model' || (by.kind === 'remote' && by.peer)) throw new Error(COPY_HIS_PRESS)
  if (!readOnlyWhy(item)) throw new Error('This deck can be edited as it is.')
  // Files' own rule for his hand: a key without approve takes nothing out of a place others can open.
  if (by.kind === 'remote' && sharedDeck(ctx, item) && !by.caps.includes('approve')) throw new Error(NEEDS_APPROVE)
  const name = copyName(item)
  const workspaceId = item.workspaceId ?? paneWorkspace(item.sessionId) ?? ctx.scopeOf(item.sessionId)?.workspaceId ?? null
  const workspace = workspaceId ? workspaceHere(ctx.db, workspaceId) : null
  return serial(ctx, item, async () => {
    const from = await deckPath(ctx, item)
    if (workspace) {
      const path = await writeFresh(workspace.path, folderFor(ctx, item, workspace.path), name, from)
      const source: CanvasSource = { at: 'file', host: ctx.host, path }
      return filesPaneWorkspace(item.sessionId) !== null ? ctx.canvas.replace(item.sessionId, item.id, 'slides', source, basename(path)) : ctx.canvas.open(item.sessionId, 'slides', source, basename(path))
    }
    const own = ctx.canvas.open(item.sessionId, 'slides', { at: 'thread' }, name)
    try {
      copyWhole(from, await sourcePath(ctx, own, OWN_FILE))
    } catch (err) {
      ctx.canvas.remove([own.id])
      throw err
    }
    return own
  })
}
