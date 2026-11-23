import { describe, expect, test } from 'vitest'
import { readEntry, readText, readZip, writeZip } from './zip'

/** The zip reader's cap on what one part unpacks to (readEntry). */
describe('the cap on a part', () => {
  const zipOf = (body: Uint8Array): ReturnType<typeof readZip> => {
    // A package of one part, written by the zip writer itself (a new entry is deflated).
    const empty = readZip(new Uint8Array([0x50, 0x4b, 0x05, 0x06, ...new Array(18).fill(0)]))
    return readZip(writeZip(empty, new Map(), new Set(), new Map([['xl/big.xml', body]])))
  }

  test('reads a part under the cap', () => {
    const z = zipOf(new TextEncoder().encode('<a/>'.repeat(10)))
    expect(readText(z, 'xl/big.xml')).toBe('<a/>'.repeat(10))
  })

  test('refuses a small part that unpacks past the cap, in words', () => {
    // 1 MiB of one byte deflates to about a kilobyte: past a 64 KiB cap it is refused, never unpacked whole.
    const z = zipOf(new Uint8Array(1024 * 1024).fill(0x41))
    expect(z.entries[0].compSize).toBeLessThan(8 * 1024)
    expect(() => readEntry(z, 'xl/big.xml', 64 * 1024)).toThrow('xl/big.xml unpacks past 64 KiB: this file is refused')
    expect(readEntry(z, 'xl/big.xml', 2 * 1024 * 1024).length).toBe(1024 * 1024)
  })
})
