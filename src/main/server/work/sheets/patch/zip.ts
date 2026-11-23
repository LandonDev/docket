// Minimal ZIP reader/writer for OOXML packages.
// Untouched entries are copied raw (local header + compressed bytes + data descriptor),
// so their compressed stream, timestamps, extra fields and order stay byte-identical.
// Only entries the caller replaces are re-deflated. No zip64 (OOXML parts over 4 GiB are out of scope).
import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib'

export interface Entry {
  name: string
  method: number
  flags: number
  crc: number
  compSize: number
  size: number
  localOffset: number
  central: Uint8Array // the original central-directory record, verbatim
}

export interface Zip {
  buf: Uint8Array
  entries: Entry[]
  byName: Map<string, Entry>
  comment: Uint8Array
}

const dv = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength)

export function readZip(buf: Uint8Array): Zip {
  const v = dv(buf)
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (v.getUint32(i, true) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('not a zip: no end-of-central-directory record')
  const count = v.getUint16(eocd + 10, true)
  const cdSize = v.getUint32(eocd + 12, true)
  const cdOff = v.getUint32(eocd + 16, true)
  const commentLen = v.getUint16(eocd + 20, true)
  if (count === 0xffff || cdOff === 0xffffffff) throw new Error('zip64 packages are not supported')
  const entries: Entry[] = []
  let p = cdOff
  const dec = new TextDecoder()
  for (let i = 0; i < count; i++) {
    if (v.getUint32(p, true) !== 0x02014b50) throw new Error(`bad central directory record at ${p}`)
    const flags = v.getUint16(p + 8, true)
    const method = v.getUint16(p + 10, true)
    const crc = v.getUint32(p + 16, true)
    const compSize = v.getUint32(p + 20, true)
    const size = v.getUint32(p + 24, true)
    const nl = v.getUint16(p + 28, true),
      xl = v.getUint16(p + 30, true),
      cl = v.getUint16(p + 32, true)
    const localOffset = v.getUint32(p + 42, true)
    if (compSize === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff)
      throw new Error('zip64 entries are not supported')
    const name = dec.decode(buf.subarray(p + 46, p + 46 + nl))
    entries.push({
      name,
      method,
      flags,
      crc,
      compSize,
      size,
      localOffset,
      central: buf.subarray(p, p + 46 + nl + xl + cl)
    })
    p += 46 + nl + xl + cl
  }
  if (p !== cdOff + cdSize) throw new Error('central directory size mismatch')
  return {
    buf,
    entries,
    byName: new Map(entries.map((e) => [e.name, e])),
    comment: buf.subarray(eocd + 22, eocd + 22 + commentLen)
  }
}

/** Byte span of an entry's local record: header, name, extra, compressed data and data descriptor if any. */
function localSpan(z: Zip, e: Entry): [number, number, number] {
  const v = dv(z.buf)
  const o = e.localOffset
  if (v.getUint32(o, true) !== 0x04034b50) throw new Error(`bad local header for ${e.name}`)
  const dataStart = o + 30 + v.getUint16(o + 26, true) + v.getUint16(o + 28, true)
  let end = dataStart + e.compSize
  if (e.flags & 8) end += v.getUint32(end, true) === 0x08074b50 ? 16 : 12
  return [o, dataStart, end]
}

/** The most one part may unpack to: a small hostile file that would unpack to gigabytes is refused, not read. */
export const ENTRY_MAX_BYTES = 512 * 1024 * 1024

export function readEntry(z: Zip, name: string, max = ENTRY_MAX_BYTES): Uint8Array {
  const e = z.byName.get(name)
  if (!e) throw new Error(`no part ${name}`)
  const [, start] = localSpan(z, e)
  const raw = z.buf.subarray(start, start + e.compSize)
  if (e.method === 0) return raw
  if (e.method === 8) {
    try {
      return inflateRawSync(raw, { maxOutputLength: max })
    } catch (err) {
      if (err instanceof RangeError || (err as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE')
        throw new Error(`${name} unpacks past ${max >= 1024 * 1024 ? `${Math.round(max / 1024 / 1024)} MiB` : `${Math.round(max / 1024)} KiB`}: this file is refused`)
      throw err
    }
  }
  throw new Error(`unsupported compression method ${e.method} in ${name}`)
}

export const readText = (z: Zip, name: string) => new TextDecoder().decode(readEntry(z, name))

export interface WriteOpts {
  level?: number
}

/**
 * Write a new package: `replace` maps part name → new bytes (re-deflated), `remove` drops parts,
 * `add` appends new parts at the end. Every other entry is copied raw, in its original order.
 */
export function writeZip(
  z: Zip,
  replace: Map<string, Uint8Array>,
  remove: Set<string>,
  add: Map<string, Uint8Array>,
  opts: WriteOpts = {}
): Uint8Array {
  const chunks: Uint8Array[] = []
  const central: Uint8Array[] = []
  let off = 0
  const enc = new TextEncoder()
  const push = (b: Uint8Array) => {
    chunks.push(b)
    off += b.length
  }

  const writeNew = (name: string, data: Uint8Array, orig?: Entry) => {
    const comp = deflateRawSync(data, { level: opts.level ?? 6 })
    const crc = crc32(data) >>> 0
    const nameB = enc.encode(name)
    const flags = (orig ? orig.flags & ~0x0008 : 0) | (0x0800 * (/[^\x00-\x7f]/.test(name) ? 1 : 0))
    // keep the original record's time/date and version fields when replacing
    const ov = orig ? dv(orig.central) : null
    const time = ov ? ov.getUint16(12, true) : 0,
      date = ov ? ov.getUint16(14, true) : 0x21 // 1980-01-01
    const lh = new Uint8Array(30 + nameB.length)
    const l = dv(lh)
    l.setUint32(0, 0x04034b50, true)
    l.setUint16(4, 20, true)
    l.setUint16(6, flags, true)
    l.setUint16(8, 8, true)
    l.setUint16(10, time, true)
    l.setUint16(12, date, true)
    l.setUint32(14, crc, true)
    l.setUint32(18, comp.length, true)
    l.setUint32(22, data.length, true)
    l.setUint16(26, nameB.length, true)
    lh.set(nameB, 30)
    const cd = new Uint8Array(46 + nameB.length)
    const c = dv(cd)
    c.setUint32(0, 0x02014b50, true)
    c.setUint16(4, ov ? ov.getUint16(4, true) : 20, true)
    c.setUint16(6, 20, true)
    c.setUint16(8, flags, true)
    c.setUint16(10, 8, true)
    c.setUint16(12, time, true)
    c.setUint16(14, date, true)
    c.setUint32(16, crc, true)
    c.setUint32(20, comp.length, true)
    c.setUint32(24, data.length, true)
    c.setUint16(28, nameB.length, true)
    c.setUint32(38, ov ? ov.getUint32(38, true) : 0, true)
    c.setUint32(42, off, true)
    cd.set(nameB, 46)
    central.push(cd)
    push(lh)
    push(comp)
  }

  for (const e of z.entries) {
    if (remove.has(e.name)) continue
    const nb = replace.get(e.name)
    if (nb) {
      writeNew(e.name, nb, e)
      continue
    }
    const [s, , end] = localSpan(z, e)
    const cd = new Uint8Array(e.central) // copy, then patch the local header offset
    dv(cd).setUint32(42, off, true)
    central.push(cd)
    push(z.buf.subarray(s, end))
  }
  for (const [name, data] of add) writeNew(name, data)

  const cdStart = off
  for (const c of central) push(c)
  const eocd = new Uint8Array(22 + z.comment.length)
  const e = dv(eocd)
  e.setUint32(0, 0x06054b50, true)
  e.setUint16(8, central.length, true)
  e.setUint16(10, central.length, true)
  e.setUint32(12, off - cdStart, true)
  e.setUint32(16, cdStart, true)
  e.setUint16(20, z.comment.length, true)
  eocd.set(z.comment, 22)
  push(eocd)
  const out = new Uint8Array(off)
  let p = 0
  for (const ch of chunks) {
    out.set(ch, p)
    p += ch.length
  }
  return out
}
