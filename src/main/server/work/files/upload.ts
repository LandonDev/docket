import { lstatSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { CommittedAttachment } from '@shared/contract-attachments'
import { digestFile } from '../../attachmentUploads'
import type { FileRef } from '@shared/contract-work-files'
import { freeName, refKey, type FileEntry } from '@shared/work/files'
import type { Caller, WorkCtx } from '../modules'
import { filesState } from './handle'
import type { Located } from './policy'
import { amendOp, checkName, FileRefused, makeFile, runOp, withFileLocks, type WriteFence } from './write'

/**
 * An upload into a folder of the Files place (docs/agents/work-files.md "Upload"): a file from a desktop or a
 * phone. `work.files.upload` locates the folder for the caller, passes the door and checks the name, then begins
 * one of the host's chunked uploads (attachmentUploads.ts `beginInto`) whose bytes are staged under
 * `<dataDir>/work-files/staging/<uploadId>/`, never in the place. The caller sends them as `attachment.chunk` and
 * `attachment.commit` on that id; at commit, once the size and sha256 are checked, the same door is passed again
 * for the same caller, the name checked again, and the file made in the folder under a name nobody has.
 */

/** What the wire gives an upload: the door and the place's own row for a path, so this file needs neither. */
export interface UploadInto {
  /** locates the folder for the caller and passes the door; throws its sentence. Called at begin and again at commit. */
  into(): Located
  /** the folder's row for a path, as `stat` answers it */
  entryOf(path: string): Promise<FileEntry | null>
}

export interface UploadAsk {
  workspaceId: string
  at: FileRef
  name: string
  size: number
  sha256: string
  op: string
}

/** What an upload's commit answers: the attachment as every upload answers it, and the row it made. */
export type UploadLanded = CommittedAttachment & { entry: FileEntry }

export const stagingRoot = (dataDir: string): string => join(dataDir, 'work-files', 'staging')

/** The upload's owner as `attachment.*` reads it: a key's id, or this host's window. */
function ownerOf(by: Caller): string {
  if (by.kind === 'local') return 'local'
  if (by.kind === 'remote' && !by.peer && by.keyId) return `key:${by.keyId}`
  throw new Error('Only his own window or a paired key uploads into Files.')
}

/** The folder a located thing names, and the fence a write there keeps to. */
function targetOf(at: Located): { dir: string; fence: WriteFence } {
  if (at.in === 'place' || at.in === 'drive') throw new Error('Pick a folder to put it in.')
  if (at.in === 'library' && at.library.vm) throw new Error('Files in the Windows VM cannot be changed from here yet. Open it there.')
  if (!statSync(at.path).isDirectory()) throw new Error('Pick a folder to put it in.')
  return { dir: at.path, fence: { roots: [at.in === 'folder' ? at.root : at.library.path] } }
}

/** What an upload's op row keeps: its id, where its file is about to be made (`landing`), and once it is made, `landed`. */
type UploadRow = { uploadId: string; landing?: string; landed?: true }

/**
 * `work.files.upload`: answers the id the bytes go on. The same `op` again answers the same id, and once that upload's
 * file has landed, `landed: true` too: the answer is kept on the op's row (`amendOp`), so a commit whose answer was
 * lost, before or across a restart of this host, is never saved a second time. The path is written on the row before
 * the file is made (`landing`); a row that names one and not `landed` (the host stopped between the two) is settled
 * when the op is asked again: the file there with the upload's sha256 is the one it made.
 */
export async function beginUpload(ctx: WorkCtx, by: Caller, p: UploadAsk, how: UploadInto): Promise<{ uploadId: string; landed?: true }> {
  checkName(p.name)
  targetOf(how.into())
  const owner = ownerOf(by)
  const uploads = ctx.uploads
  if (!uploads) throw new Error('This host takes no uploads.')
  const row = await runOp<UploadRow>(ctx.db, { id: p.op, workspaceId: p.workspaceId, verb: 'upload', refs: [p.at, p.name, p.size, p.sha256] }, async () => {
    const { uploadId } = await uploads.beginInto(owner, { name: p.name, size: p.size, sha256: p.sha256 }, (id) => ({
      dir: join(stagingRoot(ctx.dataDir), id),
      land: (staged) => land(ctx, p, how, staged, id)
    }))
    return { uploadId }
  })
  if (row.landed) return { uploadId: row.uploadId, landed: true }
  if (row.landing && (await madeHere(row.landing, p.sha256))) {
    amendOp(ctx.db, p.op, { uploadId: row.uploadId, landed: true })
    return { uploadId: row.uploadId, landed: true }
  }
  return { uploadId: row.uploadId }
}

/** The file at a recorded landing is the upload's own: there, and its bytes the sha256 the begin declared. */
async function madeHere(path: string, sha256: string): Promise<boolean> {
  if (!exists(path)) return false
  return (await digestFile(path).catch(() => null))?.sha256 === sha256
}

/** The commit: the caller, the folder and the name are checked again, and the staged file is made in the folder, never over anything. */
async function land(ctx: WorkCtx, p: UploadAsk, how: UploadInto, staged: string, uploadId: string): Promise<UploadLanded> {
  checkName(p.name)
  const { dir, fence } = targetOf(how.into())
  const path = await withFileLocks([refKey({ at: 'file', host: ctx.host, path: dir })], async () => {
    for (let tries = 0; ; tries++) {
      const name = freeName(p.name, (n) => exists(join(dir, n)))
      // Where it goes, on the op's row before the file is made: a stop between the two is settled from it.
      amendOp(ctx.db, p.op, { uploadId, landing: join(dir, name) } satisfies UploadRow)
      try {
        return await makeFile(fence, dir, name, { from: staged })
      } catch (e) {
        // Another writer took the name between the look and the write: look again.
        if (!(e instanceof FileRefused && e.code === 'taken' && tries < 3)) throw e
      }
    }
  })
  // Made: said on the row at once, before anything else is awaited.
  amendOp(ctx.db, p.op, { uploadId, landed: true } satisfies UploadRow)
  const state = filesState(ctx)
  state.lister.forget(dir)
  try {
    ctx.push({ push: 'work.files', workspaceId: p.workspaceId, at: refKey({ at: 'file', host: ctx.host, path: dir }) }, { need: 'read', path: dir })
  } catch (err) {
    ctx.log(`files: an upload's push failed: ${err instanceof Error ? err.message : String(err)}`)
  }
  const name = path.slice(dir.length + 1)
  const entry = (await how.entryOf(path)) ?? { key: refKey({ at: 'file', host: ctx.host, path }), ref: { at: 'file', host: ctx.host, path }, folder: null, name, kind: 'other' }
  return { path, name, kind: 'file', size: p.size, entry }
}

const exists = (path: string): boolean => {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}
