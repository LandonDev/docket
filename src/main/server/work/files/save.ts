import { createHash, randomBytes } from 'node:crypto'
import { chmod, lstat, open, readdir, readFile as readBytes, rename, stat, unlink } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { freeName, splitName } from '@shared/work/files'
import { bytesHere } from './places/disk'
import { admitPath, FileRefused, makeFile, versionOf, withFileLocks, type WriteFence } from './write'

/**
 * A file's own bytes, read and replaced where it lies (docs/agents/work-files.md "Saving"). The other verbs of
 * write.ts never write over anything; this is the one that does, for an editor's save alone, and only while the
 * file is still the version the editor read: a file that changed since is answered as a conflict and left as it
 * is, and one that is gone is never made again under its old name. The new bytes are written beside the file
 * under a hidden name, synced, and renamed over it, so a reader sees the old file or the new one, never half.
 */

/**
 * Whoever hears that `saveFile` replaced a file, by its real path (a Files tab's copy that saves back, copies.ts).
 * Told after the file holds the new bytes; a listener's fault never fails the save.
 */
const savedListeners = new Set<(path: string) => void>()
export function onFileSaved(fn: (path: string) => void): () => void {
  savedListeners.add(fn)
  return () => void savedListeners.delete(fn)
}

/**
 * A whole file's bytes and its version from one look: its size and change time before and after the read must
 * agree with each other and with what was read, and the version's hash is of those very bytes, so the version a
 * save later names is the version of exactly these bytes. A file that changed while it was read is read once more.
 */
export async function readWhole(path: string, max: number): Promise<{ data: Buffer; version: string; sha256: string }> {
  for (let tries = 0; ; tries++) {
    const before = await stat(path)
    if (!before.isFile()) throw new FileRefused('gone', NOT_A_FILE)
    if (before.size > max) throw new FileRefused('too-big', `${basename(path)} is over ${Math.round(max / 1024 / 1024)} MB.`)
    const data = await readBytes(path)
    const after = await stat(path)
    if (data.length === after.size && after.size === before.size && after.mtimeMs === before.mtimeMs && after.ino === before.ino) {
      const sha256 = createHash('sha256').update(data).digest('hex')
      return { data, sha256, version: versionWord({ size: after.size, mtimeMs: after.mtimeMs, sha256 }) }
    }
    if (tries) throw new Error(`${basename(path)} changed while it was read. Try again.`)
  }
}

/** The most one read answers. */
export const READ_MAX = 4 * 1024 * 1024

type Version = Awaited<ReturnType<typeof versionOf>>
/** A version as one word a client keeps and hands back: its size, its change time and, where it has one, its sha256. */
export const versionWord = (v: Version): string => `${v.size}:${Math.round(v.mtimeMs)}:${v.sha256 ?? ''}`

export interface FileBytes {
  /** base64 */
  data: string
  /** the whole file's size */
  size: number
  version: string
  /** epoch ms the file last changed */
  changed: number
  /** this read reached the file's end */
  end: boolean
}

/** What a save that could not be made says: the file as it is now, or that it is gone. */
export type SaveConflict = { version: string; changed: number } | { gone: true }
export type Saved = { version: string; changed: number } | { conflict: SaveConflict }

const CLOUD_ONLY = 'This file is kept in the cloud. Download it first.'
const NOT_A_FILE = 'That is not a file.'
const tempOf = (path: string): string => join(dirname(path), `.${basename(path)}.${randomBytes(6).toString('hex')}.tmp`)

/**
 * Up to `length` bytes of a file from `offset`. `version`, when given, is the one an earlier read answered: a
 * file that changed since is refused as stale, so a read in parts is of one file. A file whose bytes are not
 * on this disk is never read (that would download it).
 */
export async function readFile(fence: WriteFence, path: string, offset: number, length: number, version?: string): Promise<FileBytes> {
  const real = await admitPath(fence, path)
  const info = await lstat(real)
  if (!info.isFile()) throw new FileRefused('gone', NOT_A_FILE)
  if (!bytesHere(info)) throw new Error(CLOUD_ONLY)
  const now = await versionOf(real)
  const word = versionWord(now)
  if (version !== undefined && version !== word) throw new Error('That file changed while it was read. Open it again.')
  const want = Math.max(0, Math.min(length, READ_MAX, now.size - offset))
  const buf = Buffer.alloc(want)
  let got = 0
  if (want) {
    const file = await open(real, 'r')
    try {
      while (got < want) {
        const { bytesRead } = await file.read(buf, got, want - got, offset + got)
        if (!bytesRead) break
        got += bytesRead
      }
    } finally {
      await file.close()
    }
  }
  return { data: buf.subarray(0, got).toString('base64'), size: now.size, version: word, changed: Math.round(now.mtimeMs), end: offset + got >= now.size }
}

/**
 * Replaces a file's bytes, when it is still `expect` (a `versionWord`). Answers its new version, or the
 * conflict: what the file is now, or that it is gone. One save of a file at a time (`key` is its `refKey`).
 */
export async function saveFile(fence: WriteFence, key: string, path: string, data: Uint8Array, expect: string): Promise<Saved> {
  return withFileLocks([key], async () => {
    let real: string
    try {
      real = await admitPath(fence, path)
    } catch (e) {
      if (e instanceof FileRefused && e.code === 'gone') return { conflict: { gone: true } }
      throw e
    }
    const info = await lstat(real)
    if (!info.isFile()) throw new FileRefused('gone', NOT_A_FILE)
    const before = await versionOf(real)
    if (versionWord(before) !== expect) return { conflict: { version: versionWord(before), changed: Math.round(before.mtimeMs) } }
    const temp = tempOf(real)
    const out = await open(temp, 'wx', info.mode & 0o777)
    try {
      try {
        await out.writeFile(data)
        await out.sync()
      } finally {
        await out.close()
      }
      await chmod(temp, info.mode & 0o777).catch(() => {})
      // The file is looked at once more just before it is replaced, by its whole version (its hash where it has one,
      // so a rewrite of the same size that kept its time is seen): a writer that came while ours was written wins.
      const last = await lstat(real).catch(() => null)
      if (!last) return { conflict: { gone: true } }
      const now = await versionOf(real)
      if (last.ino !== info.ino || versionWord(now) !== expect) return { conflict: { version: versionWord(now), changed: Math.round(now.mtimeMs) } }
      await rename(temp, real)
    } finally {
      await unlink(temp).catch(() => {})
    }
    const dir = await open(dirname(real), 'r').catch(() => null)
    await dir?.sync().catch(() => {})
    await dir?.close()
    const after = await versionOf(real)
    for (const fn of savedListeners) {
      try {
        fn(real)
      } catch {
        // a listener's fault is its own
      }
    }
    return { version: versionWord(after), changed: Math.round(after.mtimeMs) }
  })
}

/** His edits kept beside a file that changed under them: a new file "Name (mine).ext" in the same folder, never over anything. Returns its path. */
export async function saveCopy(fence: WriteFence, path: string, data: Uint8Array): Promise<string> {
  const dir = dirname(path)
  const names = new Set((await readdir(await admitPath(fence, dir))).map((n) => n.toLowerCase()))
  const { stem, ext } = splitName(basename(path))
  const name = freeName(`${stem} (mine)${ext}`, (n) => names.has(n.toLowerCase()))
  return makeFile(fence, dir, name, data)
}
