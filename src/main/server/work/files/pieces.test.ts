import { createHash, randomBytes } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import type { Caller } from '../modules'
import { PIECES_AT_ONCE, resetStaged, stagePiece, STAGED_LIFE_MS, STAGED_MOST, stagedWrites, takePieces, WRITE_PIECE, writeBackInPieces, type PieceRef } from './pieces'

/**
 * A copy sent back to another host of his goes in pieces (perf M9): never one frame of the whole file. The far host
 * keeps a write's pieces for that write alone, from that host alone, and hands its door the same bytes.
 */

const PEER: Caller = { kind: 'remote', caps: ['read', 'operate'], peer: 'env_box' }
const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex')

/** The far host's side of the peer link: each call's params as JSON (its frame), and the bytes its door was handed. */
function farHost(o: { old?: boolean } = {}) {
  const frames: Array<{ method: string; chars: number; base64: number }> = []
  let wrote: Buffer | null = null
  let flying = 0
  let most = 0
  const call = async (method: 'writeBackPiece' | 'writeBack', params: Record<string, unknown>): Promise<unknown> => {
    frames.push({ method, chars: JSON.stringify(params).length, base64: String(params.data ?? '').length })
    flying++
    most = Math.max(most, flying)
    await new Promise((r) => setTimeout(r, 1))
    flying--
    if (method === 'writeBackPiece') {
      if (o.old) throw new Error('unknown method work.files.writeBackPiece')
      return stagePiece(PEER, params as never)
    }
    const p = params as { workspaceId: string; data: string; pieces?: PieceRef }
    wrote = p.pieces ? takePieces(PEER, p.workspaceId, p.pieces) : Buffer.from(p.data, 'base64')
    return { version: 'v2' }
  }
  return { call, frames, wrote: () => wrote, most: () => most }
}

afterEach(resetStaged)

describe('a copy sent back to its own host', () => {
  it('a 10 MB copy goes in at least three pieces, none over a piece, two at once, and comes out the same by SHA', async () => {
    const data = randomBytes(10 * 1024 * 1024)
    const far = farHost()
    expect(await writeBackInPieces(far.call, { workspaceId: 'w1', ref: { at: 'file', host: 'env_mac', path: '/T/Plan.xlsx' }, version: 'v1' }, data)).toEqual({ version: 'v2' })
    const pieces = far.frames.filter((f) => f.method === 'writeBackPiece')
    expect(pieces.length).toBeGreaterThanOrEqual(3)
    // No frame carries a base64 field over a piece's base64.
    expect(Math.max(...far.frames.map((f) => f.base64))).toBeLessThanOrEqual(4 * Math.ceil(WRITE_PIECE / 3))
    expect(far.most()).toBeLessThanOrEqual(PIECES_AT_ONCE)
    expect(far.frames.at(-1)!.method).toBe('writeBack')
    expect(sha(far.wrote()!)).toBe(sha(data))
    expect(stagedWrites()).toBe(0)
  })

  it('a copy of one piece or less goes whole, as before', async () => {
    const data = randomBytes(1024)
    const far = farHost()
    await writeBackInPieces(far.call, { workspaceId: 'w1' }, data)
    expect(far.frames.map((f) => f.method)).toEqual(['writeBack'])
    expect(sha(far.wrote()!)).toBe(sha(data))
  })

  it('a host a release behind, with no piece verb, takes the whole file as before', async () => {
    const data = randomBytes(9 * 1024 * 1024)
    const far = farHost({ old: true })
    await writeBackInPieces(far.call, { workspaceId: 'w1' }, data)
    expect(far.frames.at(-1)!.method).toBe('writeBack')
    expect(sha(far.wrote()!)).toBe(sha(data))
  })
})

describe("the far host's pieces", () => {
  const piece = (upload: string, index: number, bytes: Buffer, workspaceId = 'w1') => ({ workspaceId, upload, index, data: bytes.toString('base64') })
  const U = '00000000-0000-4000-8000-000000000001'

  it('come from another host of his alone, for one workspace', () => {
    expect(() => stagePiece({ kind: 'local', caps: [] }, piece(U, 0, Buffer.from('a')))).toThrow(/workspace's own host/)
    expect(() => stagePiece({ kind: 'remote', caps: ['operate'] }, piece(U, 0, Buffer.from('a')))).toThrow(/workspace's own host/)
    stagePiece(PEER, piece(U, 0, Buffer.from('a')))
    expect(() => stagePiece({ ...PEER, peer: 'env_other' }, piece(U, 1, Buffer.from('b')))).toThrow(/workspace's own host/)
    expect(() => stagePiece(PEER, piece(U, 1, Buffer.from('b'), 'w2'))).toThrow(/workspace's own host/)
  })

  it('are refused for a write whose pieces did not all come, or not as they were sent, and are kept no longer', () => {
    stagePiece(PEER, piece(U, 0, Buffer.from('ab')))
    expect(() => takePieces(PEER, 'w1', { upload: U, count: 2, sha256: sha(Buffer.from('ab')) })).toThrow(/did not all come/)
    expect(stagedWrites()).toBe(0)
    stagePiece(PEER, piece(U, 0, Buffer.from('ab')))
    expect(() => takePieces(PEER, 'w1', { upload: U, count: 1, sha256: sha(Buffer.from('xx')) })).toThrow(/not come as they were sent/)
  })

  it(`hold at most ${STAGED_MOST} writes, each for ${STAGED_LIFE_MS / 60_000} minutes after its last piece`, () => {
    for (let i = 0; i < STAGED_MOST; i++) stagePiece(PEER, piece(`00000000-0000-4000-8000-00000000001${i}`, 0, Buffer.from('a')), 0)
    expect(() => stagePiece(PEER, piece(U, 0, Buffer.from('a')), 0)).toThrow(/Too many/)
    stagePiece(PEER, piece(U, 0, Buffer.from('a')), STAGED_LIFE_MS + 1)
    expect(stagedWrites()).toBe(1)
  })
})
