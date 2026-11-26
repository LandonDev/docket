/**
 * The containers the app's icon ships in, written from raw RGBA pixels
 * (scripts/make-icons.ts draws them): PNG, a Windows .ico (a 32-bit bitmap
 * below 256 px, PNG at 256, the way Windows and NSIS read them best) and a
 * Mac .icns (PNG in every slot).
 */
import { deflateSync } from 'node:zlib'

export interface Pixels {
  size: number
  /** size × size × 4 bytes, RGBA, top row first. */
  rgba: Uint8Array
}

const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (const b of bytes) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Uint8Array): Buffer {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0)
  return Buffer.concat([head, data, crc])
}

/** A PNG of the pixels; `opaque` drops the alpha channel (the App Store refuses an icon that has one). */
export function png({ size, rgba }: Pixels, opaque = false): Buffer {
  const channels = opaque ? 3 : 4
  const rows = Buffer.alloc(size * (size * channels + 1))
  for (let y = 0; y < size; y++) {
    const row = y * (size * channels + 1)
    for (let x = 0; x < size; x++)
      for (let c = 0; c < channels; c++) rows[row + 1 + x * channels + c] = rgba[(y * size + x) * 4 + c]
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr.set([8, opaque ? 2 : 6, 0, 0, 0], 8)
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(rows, { level: 9 })), chunk('IEND', new Uint8Array())])
}

/** An .ico image's bitmap: the header, BGRA rows bottom first, then the AND mask (set where a pixel is clear). */
function dib({ size, rgba }: Pixels): Buffer {
  const maskRow = Math.ceil(size / 32) * 4
  const out = Buffer.alloc(40 + size * size * 4 + maskRow * size)
  out.writeUInt32LE(40, 0)
  out.writeInt32LE(size, 4)
  out.writeInt32LE(size * 2, 8)
  out.writeUInt16LE(1, 12)
  out.writeUInt16LE(32, 14)
  out.writeUInt32LE(size * size * 4 + maskRow * size, 20)
  const mask = 40 + size * size * 4
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const from = (y * size + x) * 4
      const to = 40 + ((size - 1 - y) * size + x) * 4
      out.set([rgba[from + 2], rgba[from + 1], rgba[from], rgba[from + 3]], to)
      if (rgba[from + 3] === 0) out[mask + (size - 1 - y) * maskRow + (x >> 3)] |= 0x80 >> (x & 7)
    }
  return out
}

export function ico(images: Pixels[]): Buffer {
  const head = Buffer.alloc(6 + 16 * images.length)
  head.writeUInt16LE(1, 2)
  head.writeUInt16LE(images.length, 4)
  const bodies = images.map((p) => (p.size >= 256 ? png(p) : dib(p)))
  let offset = head.length
  images.forEach((p, i) => {
    const at = 6 + 16 * i
    head[at] = p.size >= 256 ? 0 : p.size
    head[at + 1] = p.size >= 256 ? 0 : p.size
    head.writeUInt16LE(1, at + 4)
    head.writeUInt16LE(32, at + 6)
    head.writeUInt32LE(bodies[i].length, at + 8)
    head.writeUInt32LE(offset, at + 12)
    offset += bodies[i].length
  })
  return Buffer.concat([head, ...bodies])
}

/** Every .icns slot and the pixel size it holds (the @2x slots hold twice their point size). */
export const ICNS_SLOTS = [
  ['icp4', 16],
  ['icp5', 32],
  ['ic11', 32],
  ['ic12', 64],
  ['ic07', 128],
  ['ic13', 256],
  ['ic08', 256],
  ['ic14', 512],
  ['ic09', 512],
  ['ic10', 1024]
] as const

export function icns(bySize: Map<number, Pixels>): Buffer {
  const parts = ICNS_SLOTS.map(([type, size]) => {
    const pixels = bySize.get(size)
    if (!pixels) throw new Error(`no ${size} px image for ${type}`)
    const data = png(pixels)
    const head = Buffer.alloc(8)
    head.write(type, 0, 'ascii')
    head.writeUInt32BE(8 + data.length, 4)
    return Buffer.concat([head, data])
  })
  const head = Buffer.alloc(8)
  head.write('icns', 0, 'ascii')
  head.writeUInt32BE(8 + parts.reduce((n, p) => n + p.length, 0), 4)
  return Buffer.concat([head, ...parts])
}
