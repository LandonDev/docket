import { closeSync, fstatSync, openSync, readSync } from 'node:fs'
import { inflateRawSync } from 'node:zlib'

/**
 * Reads named entries of a zip file (an Office file is one) without reading the rest: the central
 * directory from the file's end, then each entry asked for. Stored and deflated entries only; an
 * entry past `max` bytes, or any damage, answers null.
 */

const EOCD = 0x06054b50
const CENTRAL = 0x02014b50
const LOCAL = 0x04034b50

function readAt(fd: number, at: number, length: number): Buffer {
  const buf = Buffer.alloc(length)
  const got = readSync(fd, buf, 0, length, at)
  return buf.subarray(0, got)
}

/** Each name asked for, as text, or null where it is missing or could not be read. */
export function zipEntries(file: string, names: readonly string[] | ((name: string) => boolean), max = 8 * 1024 * 1024): Map<string, string> {
  const out = new Map<string, string>()
  let fd: number
  try {
    fd = openSync(file, 'r')
  } catch {
    return out
  }
  try {
    const size = fstatSync(fd).size
    const tailLength = Math.min(size, 65_557)
    const tail = readAt(fd, size - tailLength, tailLength)
    let end = -1
    for (let i = tail.length - 22; i >= 0; i--)
      if (tail.readUInt32LE(i) === EOCD) {
        end = i
        break
      }
    if (end < 0) return out
    const count = tail.readUInt16LE(end + 10)
    const dirSize = tail.readUInt32LE(end + 12)
    const dirAt = tail.readUInt32LE(end + 16)
    if (dirAt + dirSize > size) return out
    const dir = readAt(fd, dirAt, dirSize)
    const wanted = typeof names === 'function' ? names : (n: string) => names.includes(n)
    for (let at = 0, i = 0; i < count && at + 46 <= dir.length; i++) {
      if (dir.readUInt32LE(at) !== CENTRAL) break
      const method = dir.readUInt16LE(at + 10)
      const packed = dir.readUInt32LE(at + 20)
      const unpacked = dir.readUInt32LE(at + 24)
      const nameLength = dir.readUInt16LE(at + 28)
      const extra = dir.readUInt16LE(at + 30)
      const comment = dir.readUInt16LE(at + 32)
      const local = dir.readUInt32LE(at + 42)
      const name = dir.subarray(at + 46, at + 46 + nameLength).toString('utf8')
      at += 46 + nameLength + extra + comment
      if (!wanted(name) || unpacked > max || packed > max) continue
      const head = readAt(fd, local, 30)
      if (head.length < 30 || head.readUInt32LE(0) !== LOCAL) continue
      const data = readAt(fd, local + 30 + head.readUInt16LE(26) + head.readUInt16LE(28), packed)
      try {
        // The size an entry declares is the maker's word: inflating stops at `max` whatever it says.
        const bytes = method === 0 ? data : method === 8 ? inflateRawSync(data, { maxOutputLength: max }) : null
        if (bytes) out.set(name, bytes.toString('utf8'))
      } catch {
        // A damaged entry is one we could not read.
      }
    }
    return out
  } finally {
    closeSync(fd)
  }
}
