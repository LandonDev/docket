import { describe, expect, it } from 'vitest'
import { inflateSync } from 'node:zlib'
import { ICNS_SLOTS, icns, ico, png, type Pixels } from './iconFiles'

/** A size × size image: top-left pixel red and clear, the rest opaque blue. */
function image(size: number): Pixels {
  const rgba = new Uint8Array(size * size * 4)
  for (let i = 0; i < size * size; i++) rgba.set(i === 0 ? [255, 0, 0, 0] : [0, 0, 255, 255], i * 4)
  return { size, rgba }
}

function chunks(buf: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>()
  for (let p = 8; p < buf.length; ) {
    const len = buf.readUInt32BE(p)
    out.set(buf.toString('ascii', p + 4, p + 8), buf.subarray(p + 8, p + 8 + len))
    p += 12 + len
  }
  return out
}

describe('png', () => {
  it('writes RGBA, or RGB with no alpha channel when opaque', () => {
    for (const [opaque, type, channels] of [
      [false, 6, 4],
      [true, 2, 3]
    ] as const) {
      const c = chunks(png(image(4), opaque))
      expect(c.get('IHDR')!.readUInt32BE(0)).toBe(4)
      expect(c.get('IHDR')![9]).toBe(type)
      const rows = inflateSync(c.get('IDAT')!)
      expect(rows.length).toBe(4 * (4 * channels + 1))
      expect([...rows.subarray(1, 1 + channels)]).toEqual(opaque ? [255, 0, 0] : [255, 0, 0, 0])
      expect(c.has('IEND')).toBe(true)
    }
  })
})

describe('ico', () => {
  it('holds a bitmap below 256 px and a PNG at 256, each where its entry points', () => {
    const file = ico([image(16), image(256)])
    expect(file.readUInt16LE(2)).toBe(1)
    expect(file.readUInt16LE(4)).toBe(2)
    const entry = (i: number): { size: number; bytes: number; offset: number } => ({
      size: file[6 + 16 * i] || 256,
      bytes: file.readUInt32LE(6 + 16 * i + 8),
      offset: file.readUInt32LE(6 + 16 * i + 12)
    })
    const small = entry(0)
    expect(small.size).toBe(16)
    expect(file.readUInt32LE(small.offset)).toBe(40)
    expect(file.readInt32LE(small.offset + 8)).toBe(32)
    // The top-left pixel is the last row's first, as BGRA, and its mask bit is set.
    const lastRow = small.offset + 40 + 15 * 16 * 4
    expect([...file.subarray(lastRow, lastRow + 4)]).toEqual([0, 0, 255, 0])
    expect(file[small.offset + 40 + 16 * 16 * 4 + 15 * 4]).toBe(0x80)
    const big = entry(1)
    expect(big.size).toBe(256)
    expect(file.subarray(big.offset, big.offset + 4).toString('latin1')).toBe('\x89PNG')
    expect(big.offset + big.bytes).toBe(file.length)
  })
})

describe('icns', () => {
  it('fills every slot with a PNG of its size and states the whole length', () => {
    const bySize = new Map([16, 32, 64, 128, 256, 512, 1024].map((s) => [s, image(s)]))
    const file = icns(bySize)
    expect(file.toString('ascii', 0, 4)).toBe('icns')
    expect(file.readUInt32BE(4)).toBe(file.length)
    const seen: string[] = []
    for (let p = 8; p < file.length; p += file.readUInt32BE(p + 4)) {
      const type = file.toString('ascii', p, p + 4)
      seen.push(type)
      expect(file.readUInt32BE(p + 24)).toBe(ICNS_SLOTS.find(([t]) => t === type)![1])
    }
    expect(seen).toEqual(ICNS_SLOTS.map(([t]) => t))
  })

  it('refuses a missing size', () => {
    expect(() => icns(new Map([[16, image(16)]]))).toThrow(/32 px/)
  })
})
