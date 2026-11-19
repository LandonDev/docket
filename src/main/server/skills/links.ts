import { copyFileSync, mkdirSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'

/**
 * The directory links of the skills views and scope pointers. Off Windows a
 * symlink with a relative target, as always. On win32 a junction, the one
 * directory link a standard user may make (a symlink needs a privilege): its
 * target is absolute, so it reads back as an absolute path, and the readers
 * here hand it back relative to the link's folder, as a symlink's reads.
 */
export const JUNCTIONS = process.platform === 'win32'

/** A link at `path` to `target` (relative to the link's folder). */
export function linkDir(target: string, path: string, junction = JUNCTIONS): void {
  if (junction) symlinkSync(resolve(dirname(path), target), path, 'junction')
  else symlinkSync(target, path)
}

/** The link's target as `linkDir` was given it; throws as readlinkSync does. */
export function readDirLink(path: string, junction = JUNCTIONS): string {
  const target = readlinkSync(path)
  return junction ? relative(dirname(path), target) : target
}

/** Rename the link at `tmp` over `link`; a junction that Windows will not rename over another is put in its place after it. */
export function swapDirLink(tmp: string, link: string, junction = JUNCTIONS, rename: (from: string, to: string) => void = renameSync): void {
  try {
    rename(tmp, link)
  } catch (err) {
    if (!junction) throw err
    rmSync(link, { force: true })
    rename(tmp, link)
  }
}

/** A link's target as read back, comparable with the path it was made to: a junction reads back absolute, sometimes with `\\?\` before it and a separator after. */
export function linkTargetOf(read: string | null): string | null {
  if (read === null) return null
  return read.replace(/^\\\\\?\\/, '').replace(/[\\/]+$/, '')
}

/** What a root's copies were when last in step, by name: the copy's mtime and size, and the person's file's mtime. */
type CopyStamps = Record<string, { mtimeMs: number; size: number; theirs: number }>
export const COPY_STAMPS = '.tc-copies.json'

function statOrNull(path: string): { mtimeMs: number; size: number } | null {
  try {
    const st = statSync(path)
    return st.isFile() ? { mtimeMs: st.mtimeMs, size: st.size } : null
  } catch {
    return null
  }
}

function readStamps(dir: string): CopyStamps {
  try {
    return JSON.parse(readFileSync(join(dir, COPY_STAMPS), 'utf8')) as CopyStamps
  } catch {
    return {}
  }
}

/**
 * Windows' stand-in for a file link: `path` is a copy of the person's
 * `target`, kept in step both ways. A standard user may not make a file
 * symlink, and a hard link would part from the person's file the first time
 * the CLI replaces it by rename (settings.json, .credentials.json, auth.json).
 * So the file is copied in; when the copy changed since the last pass (the
 * CLI rewrote it) it is copied back, unless the person's changed later still;
 * when only the person's changed it is copied in again. A person's file that
 * is gone takes the copy with it, once it was in step. `.tc-copies.json`
 * beside the copies keeps what each was when last in step.
 */
export function syncCopy(path: string, target: string): 'in' | 'back' | 'same' | 'none' {
  const dir = dirname(path)
  const name = basename(path)
  const stamps = readStamps(dir)
  const rec = stamps[name]
  const mine = statOrNull(path)
  const theirs = statOrNull(target)
  let did: 'in' | 'back' | 'same' | 'none' = 'same'
  const changedHere = !!mine && (!rec || mine.mtimeMs !== rec.mtimeMs || mine.size !== rec.size)
  const changedThere = !!theirs && (!rec || theirs.mtimeMs !== rec.theirs)
  if (!theirs && !mine) did = 'none'
  else if (!theirs) {
    if (rec && !changedHere) {
      rmSync(path, { force: true })
      delete stamps[name]
      writeStamps(dir, stamps)
      return 'none'
    }
    did = 'back'
  } else if (!mine) did = 'in'
  else if (changedHere && rec && (!changedThere || mine.mtimeMs >= theirs.mtimeMs)) did = 'back'
  else if (changedThere || !rec) did = 'in'
  if (did === 'none') return did
  if (did === 'in') copyFileSync(target, path)
  if (did === 'back') {
    mkdirSync(dirname(target), { recursive: true })
    copyFileSync(path, target)
  }
  const a = statOrNull(path)
  const b = statOrNull(target)
  if (a && b) stamps[name] = { mtimeMs: a.mtimeMs, size: a.size, theirs: b.mtimeMs }
  writeStamps(dir, stamps)
  return did
}

/** The names a root holds as copies. */
export function copiedNames(dir: string): string[] {
  return Object.keys(readStamps(dir))
}

function writeStamps(dir: string, stamps: CopyStamps): void {
  const file = join(dir, COPY_STAMPS)
  const tmp = `${file}.${process.pid}`
  writeFileSync(tmp, JSON.stringify(stamps))
  renameRetry(tmp, file)
}

/**
 * renameSync, retried on Windows while another process has the file open
 * (EPERM, EACCES, EBUSY: an antivirus scan or the CLI reading it), for up to
 * about a second; elsewhere once.
 */
export function renameRetry(from: string, to: string, platform: NodeJS.Platform = process.platform, rename: (a: string, b: string) => void = renameSync): void {
  for (let attempt = 0; ; attempt++) {
    try {
      rename(from, to)
      return
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (platform !== 'win32' || attempt >= 10 || !['EPERM', 'EACCES', 'EBUSY'].includes(code ?? '')) throw err
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 * (attempt + 1))
    }
  }
}

/** A link at `path` to the absolute `target`: a symlink off win32; on win32 a junction to a directory and a copy in step (syncCopy) of a file. */
export function linkEntry(target: string, path: string, copies = JUNCTIONS): void {
  if (!copies) symlinkSync(target, path)
  else if (statSync(target, { throwIfNoEntry: false })?.isDirectory()) symlinkSync(target, path, 'junction')
  else syncCopy(path, target)
}
