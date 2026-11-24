import { describe, expect, it } from 'vitest'
import { FAR_FIRST, FAR_PIECE, farBytes, type FarPiece } from './handle'

/** Another host's file copied here a piece at a time (handle.ts `farBytes`): once over the link, its progress said. */

const MB = 1024 * 1024
const fileOf = (size: number): Buffer => Buffer.from(Array.from({ length: size }, (_, i) => i % 251))

/** A host that answers pieces of `file`, at the version `versionAt(n)` for its nth answer; it counts what it was asked. */
function host(file: Buffer, versionAt: (n: number) => string = () => '9:1:') {
  const asked: number[] = []
  let open = 0
  let most = 0
  const ask = async ({ offset, length }: { offset: number; length: number }): Promise<FarPiece> => {
    const n = asked.push(offset)
    open++
    most = Math.max(most, open)
    await new Promise((next) => setTimeout(next, 1))
    open--
    const data = file.subarray(offset, offset + length)
    return { name: 'Deck.pptx', data: data.toString('base64'), size: file.length, version: versionAt(n), end: offset + data.length >= file.length }
  }
  return { ask, asked, most: () => most }
}

describe('a copy of another computer’s file', () => {
  it('crosses the link once, in pieces, two asked at once, its progress said after each', async () => {
    const file = fileOf(10 * MB + 5)
    const h = host(file)
    const said: number[] = []
    const got = await farBytes(h.ask, (done, total) => (expect(total).toBe(file.length), said.push(done)))
    expect(got.bytes.equals(file)).toBe(true)
    expect(got.version).toBe('9:1:')
    // A small first piece, so the row says how far it has got after one round trip.
    expect(h.asked).toEqual([0, FAR_FIRST, FAR_FIRST + FAR_PIECE, FAR_FIRST + 2 * FAR_PIECE])
    expect(h.most()).toBeLessThanOrEqual(2)
    expect(said).toEqual([FAR_FIRST, FAR_FIRST + FAR_PIECE, FAR_FIRST + 2 * FAR_PIECE, file.length])
  })

  it('is read once more when the file changed while it was read, then refused', async () => {
    const file = fileOf(9 * MB)
    // The second answer is of another version: the read starts over and then holds.
    const once = host(file, (n) => (n === 2 ? '9:2:' : '9:1:'))
    expect((await farBytes(once.ask)).bytes.equals(file)).toBe(true)
    expect(once.asked[0]).toBe(0)
    expect(once.asked.filter((o) => o === 0)).toHaveLength(2)
    const always = host(file, (n) => `9:${n}:`)
    await expect(farBytes(always.ask)).rejects.toThrow('Deck.pptx changed while it was read')
  })

  it('takes the whole file from a host a build behind, which answers no size', async () => {
    const file = fileOf(3 * MB)
    const got = await farBytes(async () => ({ name: 'Big.docx', data: file.toString('base64'), version: '3:1:abc' }))
    expect(got.bytes.equals(file)).toBe(true)
    expect(got.version).toBe('3:1:abc')
  })

  it("says a piece's failure", async () => {
    await expect(farBytes(async ({ offset }) => (offset ? Promise.reject(new Error('TC-WIN11 is not reachable now.')) : { name: 'x', data: fileOf(FAR_FIRST).toString('base64'), size: 3 * FAR_PIECE, version: 'v' }))).rejects.toThrow('not reachable')
  })
})
