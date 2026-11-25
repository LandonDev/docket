import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { BYTES_UNDEFLATED, carriesBytes } from './wire'

/** A frame that carries a file's bytes goes with no deflate (perf M9); every other frame as the socket was set up. */

const bytes = (n: number): string => randomBytes(n).toString('base64')
const frame = (value: unknown): [unknown, string] => [value, JSON.stringify(value)]

describe("a frame's bytes and its deflate", () => {
  it("are found in an answer's data, a peer piece's, a reply's chunk", () => {
    expect(carriesBytes(...frame({ id: 'r1', ok: true, result: { data: bytes(4 * 1024 * 1024), size: 9, rev: 2 } }))).toBe(true)
    expect(carriesBytes(...frame({ push: 'peer.call', params: { method: 'files.writeBackPiece', params: { upload: 'u', index: 0, data: bytes(1024 * 1024) } } }))).toBe(true)
    expect(carriesBytes(...frame({ callId: 'c', index: 1, data: bytes(BYTES_UNDEFLATED) }))).toBe(true)
  })

  it("are not found in words, however long, nor in a short frame", () => {
    expect(carriesBytes(...frame({ push: 'events', sessionId: 's', rows: [{ text: 'All good. '.repeat(100_000) }] }))).toBe(false)
    expect(carriesBytes(...frame({ id: 'r2', ok: true, result: { data: bytes(1024) } }))).toBe(false)
    expect(carriesBytes(...frame({ id: 'r3', ok: true, result: { markdown: `# Plan\n\n${'Meet at 9. '.repeat(60_000)}` } }))).toBe(false)
  })
})
