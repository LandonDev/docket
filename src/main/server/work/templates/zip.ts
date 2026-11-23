import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib'

/**
 * A zip as an Office file is one (docs/agents/work-templates.md "The
 * fill"): read whole, and written back with only the parts a fill changed
 * deflated again. Every other part keeps its compressed bytes, its order
 * and its name; its header is written fresh from the directory's own
 * numbers. No zip64: an Office part over 4 GiB is no template.
 */

export interface ZipEntry {
  name: string
  /** 0 stored, 8 deflated */
  method: number
  crc: number
  size: number
  /** the part's bytes as the file holds them */
  packed: Uint8Array
  /** DOS time and date, as the directory says */
  time: number
  date: number
}

const view = (b: Uint8Array): DataView => new DataView(b.buffer, b.byteOffset, b.byteLength)
const LOCAL = 0x04034b50
const CENTRAL = 0x02014b50
const END = 0x06054b50

export class NotZipError extends Error {}

/** Every part of a zip, in the directory's order. Throws `NotZipError` for bytes that are none. */
export function readZip(buf: Uint8Array): ZipEntry[] {
  const v = view(buf)
  let end = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65_535); i--) {
    if (v.getUint32(i, true) === END) {
      end = i
      break
    }
  }
  if (end < 0) throw new NotZipError('This file is not a zip.')
  const count = v.getUint16(end + 10, true)
  let p = v.getUint32(end + 16, true)
  if (count === 0xffff || p === 0xffffffff) throw new NotZipError('This file is too large to read.')
  const names = new TextDecoder()
  const out: ZipEntry[] = []
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || v.getUint32(p, true) !== CENTRAL) throw new NotZipError('This file is cut short.')
    if (v.getUint16(p + 8, true) & 1) throw new NotZipError('This file is locked with a password.')
    const method = v.getUint16(p + 10, true)
    const time = v.getUint16(p + 12, true)
    const date = v.getUint16(p + 14, true)
    const crc = v.getUint32(p + 16, true)
    const packedSize = v.getUint32(p + 20, true)
    const size = v.getUint32(p + 24, true)
    const nameLen = v.getUint16(p + 28, true)
    const extraLen = v.getUint16(p + 30, true)
    const commentLen = v.getUint16(p + 32, true)
    const local = v.getUint32(p + 42, true)
    if (packedSize === 0xffffffff || size === 0xffffffff || local === 0xffffffff) throw new NotZipError('This file is too large to read.')
    if (method !== 0 && method !== 8) throw new NotZipError('This file is packed in a way that cannot be read.')
    const name = names.decode(buf.subarray(p + 46, p + 46 + nameLen))
    if (local + 30 > buf.length || v.getUint32(local, true) !== LOCAL) throw new NotZipError('This file is cut short.')
    const data = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true)
    if (data + packedSize > buf.length) throw new NotZipError('This file is cut short.')
    out.push({ name, method, crc, size, packed: buf.subarray(data, data + packedSize), time, date })
    p += 46 + nameLen + extraLen + commentLen
  }
  return out
}

/** A part's bytes, unpacked. */
export function partBytes(entry: ZipEntry): Uint8Array {
  if (entry.method === 0) return entry.packed
  // A part that claims more than it holds is refused before it is unpacked: no zip bomb fills the memory.
  return inflateRawSync(entry.packed, { maxOutputLength: Math.max(entry.size, 1) })
}

const decoder = new TextDecoder()
export const partText = (entry: ZipEntry): string => decoder.decode(partBytes(entry))

/** The zip again, with the named parts' bytes replaced. A name it does not hold is not added. */
export function writeZip(entries: readonly ZipEntry[], changed: ReadonlyMap<string, Uint8Array> = new Map()): Uint8Array {
  const names = new TextEncoder()
  const parts: Uint8Array[] = []
  const directory: Uint8Array[] = []
  let offset = 0
  for (const entry of entries) {
    const fresh = changed.get(entry.name)
    const e: ZipEntry = fresh ? { ...entry, method: 8, crc: crc32(fresh) >>> 0, size: fresh.length, packed: deflateRawSync(fresh, { level: 6 }) } : entry
    const name = names.encode(e.name)
    // Bit 11: the name is UTF-8. No data descriptor: the sizes are in the header.
    const head = new Uint8Array(30 + name.length)
    const h = view(head)
    h.setUint32(0, LOCAL, true)
    h.setUint16(4, 20, true)
    h.setUint16(6, 0x0800, true)
    h.setUint16(8, e.method, true)
    h.setUint16(10, e.time, true)
    h.setUint16(12, e.date, true)
    h.setUint32(14, e.crc, true)
    h.setUint32(18, e.packed.length, true)
    h.setUint32(22, e.size, true)
    h.setUint16(26, name.length, true)
    head.set(name, 30)
    const central = new Uint8Array(46 + name.length)
    const c = view(central)
    c.setUint32(0, CENTRAL, true)
    c.setUint16(4, 20, true)
    c.setUint16(6, 20, true)
    c.setUint16(8, 0x0800, true)
    c.setUint16(10, e.method, true)
    c.setUint16(12, e.time, true)
    c.setUint16(14, e.date, true)
    c.setUint32(16, e.crc, true)
    c.setUint32(20, e.packed.length, true)
    c.setUint32(24, e.size, true)
    c.setUint16(28, name.length, true)
    c.setUint32(42, offset, true)
    central.set(name, 46)
    parts.push(head, e.packed)
    directory.push(central)
    offset += head.length + e.packed.length
  }
  const directorySize = directory.reduce((n, d) => n + d.length, 0)
  const end = new Uint8Array(22)
  const t = view(end)
  t.setUint32(0, END, true)
  t.setUint16(8, entries.length, true)
  t.setUint16(10, entries.length, true)
  t.setUint32(12, directorySize, true)
  t.setUint32(16, offset, true)
  const out = new Uint8Array(offset + directorySize + 22)
  let at = 0
  for (const piece of [...parts, ...directory, end]) {
    out.set(piece, at)
    at += piece.length
  }
  return out
}

/** A zip of new parts, each deflated: what a test and the starters' sheet writer make a file with. */
export function makeZip(files: Readonly<Record<string, Uint8Array | string>>): Uint8Array {
  const names = new TextEncoder()
  const entries: ZipEntry[] = Object.entries(files).map(([name, data]) => {
    const bytes = typeof data === 'string' ? names.encode(data) : data
    // 1980-01-01, the zip epoch: a starter built twice is the same file.
    return { name, method: 8, crc: crc32(bytes) >>> 0, size: bytes.length, packed: deflateRawSync(bytes, { level: 6 }), time: 0, date: 0x21 }
  })
  return writeZip(entries)
}
