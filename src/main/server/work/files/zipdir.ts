import { lstat, open, type FileHandle } from 'node:fs/promises'
import { inflateRawSync } from 'node:zlib'
import { ARCHIVE_ENTRIES_MAX, type FileArchive } from '@shared/contract-work-files'
import { extOf } from '@shared/work/files'
import { bytesHere } from './places/disk'
import { admitPath, type WriteFence } from './write'

/**
 * A zip's central directory, read from the file's end (docs/agents/work-files.md "An archive's listing"): the
 * names, sizes and folders of its entries without extracting anything, and one named entry's bytes for a
 * preview (an Office file's own thumbnail, a `.tcdoc`'s first lines). ZIP64 counts, offsets and sizes are read.
 * `zipListing` never reads an entry's local header or its data, so a zip whose entry data is garbage still lists.
 */

const EOCD = 0x06054b50
const EOCD64 = 0x06064b50
const EOCD64_LOCATOR = 0x07064b50
const CENTRAL = 0x02014b50
const LOCAL = 0x04034b50
/** The end record (22 bytes) and the longest comment a zip may carry. */
const TAIL_MAX = 22 + 0xffff
/** The directory is read in parts this big, and only as far as the entries asked for. */
const CHUNK = 64 * 1024

export interface ZipEntry {
  name: string
  /** its size once extracted */
  size: number
  dir: boolean
}
interface Directory {
  count: number
  at: number
  size: number
}
interface Found extends ZipEntry {
  method: number
  packed: number
  local: number
}

export class ZipUnreadable extends Error {
  constructor() {
    super('This zip could not be read.')
  }
}

async function readAt(file: FileHandle, at: number, length: number): Promise<Buffer> {
  const buf = Buffer.alloc(length)
  let got = 0
  while (got < length) {
    const { bytesRead } = await file.read(buf, got, length - got, at + got)
    if (!bytesRead) break
    got += bytesRead
  }
  return buf.subarray(0, got)
}

/** Where the central directory lies and how many entries it holds, from the end record (and ZIP64's, where the plain one is full). */
async function directoryOf(file: FileHandle, size: number): Promise<Directory> {
  const tailLength = Math.min(size, TAIL_MAX)
  const tail = await readAt(file, size - tailLength, tailLength)
  let end = -1
  for (let i = tail.length - 22; i >= 0; i--)
    if (tail.readUInt32LE(i) === EOCD) {
      end = i
      break
    }
  if (end < 0) throw new ZipUnreadable()
  let count = tail.readUInt16LE(end + 10)
  let dirSize = tail.readUInt32LE(end + 12)
  let dirAt = tail.readUInt32LE(end + 16)
  if ((count === 0xffff || dirSize === 0xffffffff || dirAt === 0xffffffff) && end >= 20 && tail.readUInt32LE(end - 20) === EOCD64_LOCATOR) {
    const recordAt = Number(tail.readBigUInt64LE(end - 20 + 8))
    const record = await readAt(file, recordAt, 56)
    if (record.length < 56 || record.readUInt32LE(0) !== EOCD64) throw new ZipUnreadable()
    count = Number(record.readBigUInt64LE(32))
    dirSize = Number(record.readBigUInt64LE(40))
    dirAt = Number(record.readBigUInt64LE(48))
  }
  if (dirAt + dirSize > size) throw new ZipUnreadable()
  return { count, at: dirAt, size: dirSize }
}

/** ZIP64's extra field: the sizes and offset the fixed fields left at their full value, in that order. */
function zip64(extra: Buffer, e: { size: number; packed: number; local: number }): void {
  for (let at = 0; at + 4 <= extra.length; ) {
    const id = extra.readUInt16LE(at)
    const length = extra.readUInt16LE(at + 2)
    if (id === 0x0001) {
      let p = at + 4
      const next = (): number => {
        const v = p + 8 <= at + 4 + length ? Number(extra.readBigUInt64LE(p)) : -1
        p += 8
        return v
      }
      if (e.size === 0xffffffff) e.size = next()
      if (e.packed === 0xffffffff) e.packed = next()
      if (e.local === 0xffffffff) e.local = next()
      return
    }
    at += 4 + length
  }
}

/** Walks the directory's records in order, reading it in parts; `take` answers false to stop. */
async function walk(file: FileHandle, dir: Directory, take: (e: Found) => boolean): Promise<void> {
  let buf: Buffer = Buffer.alloc(0)
  let read = 0
  for (let i = 0; i < dir.count; i++) {
    // Each record is 46 bytes and its name, extra and comment: more of the directory is read when one runs past what is held.
    const need = async (n: number): Promise<boolean> => {
      while (buf.length < n && read < dir.size) {
        const part = await readAt(file, dir.at + read, Math.min(CHUNK, dir.size - read))
        if (!part.length) break
        read += part.length
        buf = buf.length ? Buffer.concat([buf, part]) : part
      }
      return buf.length >= n
    }
    if (!(await need(46)) || buf.readUInt32LE(0) !== CENTRAL) throw new ZipUnreadable()
    const nameLength = buf.readUInt16LE(28)
    const extraLength = buf.readUInt16LE(30)
    const commentLength = buf.readUInt16LE(32)
    const whole = 46 + nameLength + extraLength + commentLength
    if (!(await need(whole))) throw new ZipUnreadable()
    const flags = buf.readUInt16LE(8)
    const raw = buf.subarray(46, 46 + nameLength)
    // Bit 11 says UTF-8; an old zip's names are code page 437, read here as Latin-1, which keeps ASCII right.
    const name = raw.toString(flags & 0x800 ? 'utf8' : 'latin1')
    const e: Found = { name, size: buf.readUInt32LE(24), packed: buf.readUInt32LE(20), local: buf.readUInt32LE(42), method: buf.readUInt16LE(10), dir: name.endsWith('/') }
    zip64(buf.subarray(46 + nameLength, 46 + nameLength + extraLength), e)
    buf = buf.subarray(whole)
    if (!take(e)) return
  }
}

/** The first `max` entries of a zip, in the directory's order, and whether it holds more. Reads the end record and the directory alone. */
export async function zipListing(path: string, max: number): Promise<{ entries: ZipEntry[]; more: boolean }> {
  const file = await open(path, 'r')
  try {
    const size = (await file.stat()).size
    const dir = await directoryOf(file, size)
    const entries: ZipEntry[] = []
    await walk(file, dir, (e) => {
      if (entries.length >= max) return false
      entries.push({ name: e.name, size: e.size, dir: e.dir })
      return true
    })
    return { entries, more: dir.count > entries.length }
  } finally {
    await file.close()
  }
}

/** One named entry's bytes, stored or deflated, at most `max` once extracted; null where it is missing, too big or damaged. */
export async function zipEntry(path: string, name: string, max: number): Promise<Buffer | null> {
  const file = await open(path, 'r')
  try {
    const size = (await file.stat()).size
    let dir: Directory
    try {
      dir = await directoryOf(file, size)
    } catch {
      return null
    }
    let found: Found | null = null
    try {
      await walk(file, dir, (e) => {
        if (e.name === name) found = e
        return !found
      })
    } catch {
      return null
    }
    const e = found as Found | null
    if (!e || e.dir || e.size > max || e.packed > max) return null
    const head = await readAt(file, e.local, 30)
    if (head.length < 30 || head.readUInt32LE(0) !== LOCAL) return null
    const data = await readAt(file, e.local + 30 + head.readUInt16LE(26) + head.readUInt16LE(28), e.packed)
    try {
      // The size a zip declares is its maker's word: inflating stops at `max` whatever it says.
      return e.method === 0 ? data : e.method === 8 ? inflateRawSync(data, { maxOutputLength: max }) : null
    } catch {
      return null
    }
  } finally {
    await file.close()
  }
}

const CLOUD_ONLY = 'This file is kept in the cloud. Download it first.'

/**
 * `work.files.archive`: a zip's entries, its directory alone read, within the roots the caller may read. Another
 * archive type answers no entries and is not opened; a file whose bytes are in the cloud is refused, not fetched.
 */
export async function archiveListing(fence: WriteFence, path: string): Promise<FileArchive> {
  if (extOf(path) !== 'zip') return { entries: [], more: false }
  const real = await admitPath(fence, path)
  const info = await lstat(real)
  if (!info.isFile()) throw new Error('That is not a file.')
  if (!bytesHere(info)) throw new Error(CLOUD_ONLY)
  return zipListing(real, ARCHIVE_ENTRIES_MAX)
}
