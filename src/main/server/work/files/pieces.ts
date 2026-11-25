import { createHash, randomUUID } from 'node:crypto'
import { COPY_ACROSS_MAX } from '@shared/work/files'
import type { Caller } from '../modules'

/**
 * A file's bytes sent to another host of his in pieces (perf M9): `work.files.writeBack` carried the whole file as one
 * base64 string, up to about 64 MB in one frame of the peer link, with every push and token behind it. Now a file over
 * one piece goes as `work.files.writeBackPiece` frames of `WRITE_PIECE` bytes, two in flight, and the write names them
 * (`pieces`); the far host joins them, checks their count and SHA-256, and then writes exactly as before, through its
 * own door. A host a release behind does not know the piece verb: the whole file goes as before.
 *
 * The far host keeps the pieces of a write in its memory alone, for that write: at most `STAGED_MOST` writes, each at
 * most `COPY_ACROSS_MAX` bytes, each gone `STAGED_LIFE_MS` after its last piece or once its write takes it.
 */

/** One piece of a write: base64 then keeps a frame under about 5.6 MB. */
export const WRITE_PIECE = 4 * 1024 * 1024
/** Pieces of one write on their way at once. */
export const PIECES_AT_ONCE = 2
export const STAGED_MOST = 4
export const STAGED_LIFE_MS = 2 * 60_000

export interface PieceRef {
  upload: string
  count: number
  sha256: string
}

type Call = (method: 'writeBackPiece' | 'writeBack', params: Record<string, unknown>) => Promise<unknown>

const sha = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex')
/** A far host a release behind: its files module has no piece verb. */
const unknownVerb = (err: unknown): boolean => /writeBackPiece|unknown method|not built|bad request|invalid request|no such method/i.test(err instanceof Error ? err.message : String(err))

/**
 * Sends `data` with the write's other params: whole when it fits one piece, else in pieces then the write that names
 * them. Answers the far host's answer to the write.
 */
export async function writeBackInPieces(call: Call, params: Record<string, unknown> & { workspaceId: string }, data: Buffer): Promise<unknown> {
  if (data.length <= WRITE_PIECE) return call('writeBack', { ...params, data: data.toString('base64') })
  const upload = randomUUID()
  const count = Math.ceil(data.length / WRITE_PIECE)
  try {
    const out: Promise<unknown>[] = []
    for (let index = 0; index < count; index++) {
      if (out.length >= PIECES_AT_ONCE) await out.shift()
      const sent = call('writeBackPiece', { workspaceId: params.workspaceId, upload, index, data: data.subarray(index * WRITE_PIECE, (index + 1) * WRITE_PIECE).toString('base64') })
      sent.catch(() => undefined)
      out.push(sent)
    }
    for (const sent of out) await sent
  } catch (err) {
    if (!unknownVerb(err)) throw err
    return call('writeBack', { ...params, data: data.toString('base64') })
  }
  return call('writeBack', { ...params, data: '', pieces: { upload, count, sha256: sha(data) } satisfies PieceRef })
}

// ── the far host: one write's pieces, until its write takes them ─────────

interface Staged {
  peer: string
  workspaceId: string
  parts: Map<number, Buffer>
  bytes: number
  at: number
}
const staged = new Map<string, Staged>()

function sweep(now: number): void {
  for (const [upload, s] of staged) if (now - s.at > STAGED_LIFE_MS) staged.delete(upload)
}

const ONLY_PEER = "A copy's pieces come from the workspace's own host."

/** One piece of a write, kept for it: only from another host of his, for one workspace, within the bounds. */
export function stagePiece(by: Caller, p: { workspaceId: string; upload: string; index: number; data: string }, now = Date.now()): { ok: true } {
  if (by.kind !== 'remote' || !by.peer) throw new Error(ONLY_PEER)
  sweep(now)
  let s = staged.get(p.upload)
  if (!s) {
    if (staged.size >= STAGED_MOST) throw new Error('Too many copies are on their way here: try again in a moment.')
    staged.set(p.upload, (s = { peer: by.peer, workspaceId: p.workspaceId, parts: new Map(), bytes: 0, at: now }))
  }
  if (s.peer !== by.peer || s.workspaceId !== p.workspaceId) throw new Error(ONLY_PEER)
  const part = Buffer.from(p.data, 'base64')
  if (part.length > WRITE_PIECE) throw new Error('A piece of a copy is over its size.')
  s.bytes += part.length - (s.parts.get(p.index)?.length ?? 0)
  if (s.bytes > COPY_ACROSS_MAX) {
    staged.delete(p.upload)
    throw new Error(`A copy is over ${COPY_ACROSS_MAX / 1024 / 1024} MB, too big to send back.`)
  }
  s.parts.set(p.index, part)
  s.at = now
  return { ok: true }
}

/** The write's bytes from its pieces, taken (they are kept no longer): each piece there once, and the whole as sent. */
export function takePieces(by: Caller, workspaceId: string, ref: PieceRef): Buffer {
  const s = staged.get(ref.upload)
  staged.delete(ref.upload)
  if (!s || by.kind !== 'remote' || s.peer !== by.peer || s.workspaceId !== workspaceId) throw new Error("A copy's pieces did not all come: it is sent again.")
  const parts: Buffer[] = []
  for (let i = 0; i < ref.count; i++) {
    const part = s.parts.get(i)
    if (!part) throw new Error("A copy's pieces did not all come: it is sent again.")
    parts.push(part)
  }
  const data = Buffer.concat(parts)
  if (s.parts.size !== ref.count || sha(data) !== ref.sha256) throw new Error("A copy's pieces did not come as they were sent: it is sent again.")
  return data
}

/** For tests: what is kept, and none after. */
export const stagedWrites = (): number => staged.size
export function resetStaged(): void {
  staged.clear()
}
