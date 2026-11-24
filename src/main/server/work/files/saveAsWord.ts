import type { SavedAsWord } from '@shared/contract-work-files'
import type { CanvasSource } from '@shared/work'
import type { FolderRef } from '@shared/work/files'
import type { Caller, WorkCtx } from '../modules'
import { saveAs } from './saveAs'

/**
 * Save as Word to… as the wire had it before Save As… (saveAs.ts), for a window of an older build: a NEW .docx under a
 * free name, never over anything, and not linked. Today's windows open Save As… with Word chosen.
 */
export async function saveAsWord(ctx: WorkCtx, by: Caller, p: { workspaceId: string; source: CanvasSource; at: FolderRef; name?: string; op: string }, method: string): Promise<SavedAsWord> {
  const got = await saveAs(ctx, by, { ...p, format: 'docx', link: false, exists: 'keep' }, method)
  if (!('saved' in got)) throw new Error('The Word file was not made.')
  return { name: got.saved.name, ref: got.saved.ref }
}
