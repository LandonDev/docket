import { createHash } from 'node:crypto'
import { constants, createReadStream, type Stats } from 'node:fs'
import { link, lstat, mkdir, open, readdir, realpath, rename, rm, rmdir, stat, unlink } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { nameProblem } from '@shared/work/files'

/**
 * The one way the Files place changes a disk on this host (docs/agents/work-files.md). Every verb that makes,
 * renames, moves, copies, trashes, restores or uploads comes through here, so three rules hold in one place:
 * a name is one path component, both ends of a change lie inside the fence by their real paths, and nothing
 * is ever written over. Node has no `openat` and no no-replace rename, so each write resolves its folder
 * just before it writes, and checks where the result really landed just after.
 */

export type RefusedCode = 'name' | 'taken' | 'outside' | 'link' | 'gone' | 'too-big' | 'busy'

/** A refusal a person reads: thrown for a name that is not allowed, a taken name, a path that left its root. */
export class FileRefused extends Error {
  constructor(
    readonly code: RefusedCode,
    message: string
  ) {
    super(message)
    this.name = 'FileRefused'
  }
}

/** The roots a change may touch: real paths of folders on this host (the workspace's folder, a library). */
export interface WriteFence {
  roots: readonly string[]
}

/**
 * Test seams, set only from write.test.ts. `beforeWrite` runs after a target is admitted and just before it
 * is written, so a test can swap a folder for a link there. `beforeCheck` runs after a copy is synced and
 * before it is read back, so a test can spoil it. `across` makes every move take the path between volumes.
 */
export const writeSeams: { beforeWrite?: (to: string) => Promise<void> | void; beforeCheck?: (copy: string) => Promise<void> | void; across?: boolean } = {}

/** A file at most this big is checked by its sha256; a bigger one by its size alone. */
const HASH_MAX = 64 * 1024 * 1024
/** The most a folder may hold to be moved to another volume, where a move is a copy. */
const FOLDER_ACROSS_MAX = 2 * 1024 * 1024 * 1024
const WEEK = 7 * 24 * 60 * 60 * 1000
// Windows has no O_NOFOLLOW; there a link is still caught by the lstat the walk does first.
const NOFOLLOW = constants.O_NOFOLLOW ?? 0

const codeOf = (e: unknown): string | undefined => (e as NodeJS.ErrnoException | null)?.code
const within = (path: string, dir: string): boolean => {
  const r = relative(dir, path)
  return r === '' || (r !== '..' && !r.startsWith(`..${sep}`) && !r.startsWith(sep) && !/^[a-zA-Z]:/.test(r))
}
const gone = (): FileRefused => new FileRefused('gone', 'That file or folder is not there any more.')
const isLink = (): FileRefused => new FileRefused('link', 'That is a link to somewhere else, so it cannot be changed here.')
const changed = (): FileRefused => new FileRefused('outside', 'The folder changed while this ran, so nothing was put there.')

/** The sentence for a taken name, naming what is there. */
async function taken(name: string, at: string): Promise<FileRefused> {
  const folder = await lstat(at).then(
    (s) => s.isDirectory(),
    () => false
  )
  return new FileRefused('taken', `A ${folder ? 'folder' : 'file'} named "${name}" is already there.`)
}

async function realRoots(fence: WriteFence): Promise<string[]> {
  const roots = await Promise.all(fence.roots.map((r) => realpath(r).catch(() => null)))
  return roots.filter((r): r is string => r !== null)
}

/** Throws FileRefused('name') with nameProblem's sentence when `name` is not one path component a place takes. */
export function checkName(name: string): void {
  const problem = nameProblem(name)
  if (problem) throw new FileRefused('name', problem)
}

/**
 * The real path of `path` when it lies in one of the fence's roots, resolved now, links followed only to
 * check them: a path whose real spelling leaves every root, or whose last component is a symbolic link, is
 * refused ('outside' / 'link'). `must: 'exist'` (default) for a source; `must: 'parent'` for a target that
 * does not exist yet: its parent folder must exist, be a real folder in a root, and the answer is
 * `<real parent>/<name>`.
 */
export async function admitPath(fence: WriteFence, path: string, must: 'exist' | 'parent' = 'exist'): Promise<string> {
  const at = resolve(path)
  if (must === 'parent') {
    const name = basename(at)
    checkName(name)
    const to = join(await admitFolder(fence, dirname(at), true), name)
    if ((await lstat(to).catch(() => null))?.isSymbolicLink()) throw isLink()
    return to
  }
  const info = await lstat(at).catch((e) => {
    throw codeOf(e) === 'ENOENT' || codeOf(e) === 'ENOTDIR' ? gone() : e
  })
  if (info.isSymbolicLink()) throw isLink()
  const real = await realpath(at)
  if (!(await realRoots(fence)).some((root) => within(real, root))) throw new FileRefused('outside', 'That is outside the places this can change.')
  return real
}

/** A folder to write in, admitted: its real path. A verb's folder may not be a link; a target path's parent, spelled through one, may (`follow`). */
async function admitFolder(fence: WriteFence, dir: string, follow = false): Promise<string> {
  const real = follow ? await admitPath(fence, await realpath(dir).catch(() => dir)) : await admitPath(fence, dir)
  if (!(await stat(real)).isDirectory()) throw new FileRefused('gone', 'That folder is not there any more.')
  return real
}

/**
 * Every entry under `dir`, a real path, walked without following a link. Each entry's own lstat decides
 * what it is, so a path built from a real folder and names that are not links is a real path itself.
 * A socket, a pipe or a device is left out.
 */
async function walk(dir: string, most: number): Promise<{ files: string[]; dirs: string[]; links: string[]; bytes: number }> {
  const tree = { files: [] as string[], dirs: [] as string[], links: [] as string[], bytes: 0 }
  const queue = [dir]
  for (let i = 0; i < queue.length; i++) {
    const names = await readdir(queue[i])
    if (tree.files.length + tree.dirs.length + tree.links.length + names.length > most) throw new FileRefused('too-big', `This folder holds more than ${most.toLocaleString('en')} things.`)
    const infos = await Promise.all(names.map((name) => lstat(join(queue[i], name)).catch(() => null)))
    names.forEach((name, n) => {
      const info = infos[n]
      const path = join(queue[i], name)
      if (!info) return
      if (info.isSymbolicLink()) tree.links.push(path)
      else if (info.isDirectory()) {
        tree.dirs.push(path)
        queue.push(path)
      } else if (info.isFile()) {
        tree.files.push(path)
        tree.bytes += info.size
      }
    })
  }
  return tree
}

/** Every file and folder under `dir`, admitted one by one (links are never followed and are reported, not walked). Bounded: more than `most` entries (default 50_000) is refused 'too-big'. Folders come before what they hold. */
export async function admitTree(fence: WriteFence, dir: string, most = 50_000): Promise<{ files: string[]; dirs: string[]; links: string[]; bytes: number }> {
  return walk(await admitFolder(fence, dir), most)
}

/**
 * Checks that what was written at `to` really sits in `parent`, the folder admitted just before. When a
 * folder on the way was swapped for a link, it landed somewhere else: `undo` takes it away from where it
 * really is, and the change is refused.
 */
async function landed(parent: string, to: string, undo: (real: string) => Promise<unknown>): Promise<void> {
  const real = await realpath(to).catch(() => null)
  if (real !== null && dirname(real) === parent) return
  if (real !== null) await undo(real).catch(() => {})
  throw changed()
}

/** An undo that removes only the very thing that was made (same inode), wherever it really is. */
const removeIfSame =
  (made: Pick<Stats, 'ino' | 'dev'>) =>
  async (real: string): Promise<void> => {
    const now = await lstat(real)
    if (now.ino !== made.ino || now.dev !== made.dev) return
    await (now.isDirectory() ? rm(real, { recursive: true, force: true }) : unlink(real))
  }

/** The admitted folder a change writes in and the path it writes, resolved just before the write. */
async function targetOf(fence: WriteFence, dir: string, name: string): Promise<{ parent: string; to: string }> {
  checkName(name)
  const parent = await admitFolder(fence, dir)
  const to = join(parent, name)
  await writeSeams.beforeWrite?.(to)
  return { parent, to }
}

/**
 * Copies one file to `to`, which must not exist (EEXIST is the caller's to name), syncs it to disk and reads
 * it back: its size, and its sha256 when it is 64 MB or less, must match what was read. A copy that fails is
 * removed. `nofollow`: a source that is a link is refused, not followed.
 */
async function copyOne(from: string, to: string, nofollow: boolean, signal?: AbortSignal): Promise<number> {
  const input = await open(from, constants.O_RDONLY | (nofollow ? NOFOLLOW : 0)).catch((e) => {
    throw codeOf(e) === 'ELOOP' ? isLink() : codeOf(e) === 'ENOENT' ? gone() : e
  })
  try {
    const info = await input.stat()
    if (!info.isFile()) throw new FileRefused('gone', 'That is not a file.')
    const hash = info.size <= HASH_MAX ? createHash('sha256') : null
    const out = await open(to, 'wx')
    try {
      let size = 0
      try {
        const buf = Buffer.allocUnsafe(1024 * 1024)
        for (;;) {
          signal?.throwIfAborted()
          const { bytesRead } = await input.read(buf, 0, buf.length, null)
          if (!bytesRead) break
          hash?.update(buf.subarray(0, bytesRead))
          for (let at = 0; at < bytesRead; ) at += (await out.write(buf, at, bytesRead - at)).bytesWritten
          size += bytesRead
        }
        await out.sync()
      } finally {
        await out.close()
      }
      await writeSeams.beforeCheck?.(to)
      const back = await versionOf(to)
      if (back.size !== size || (hash && back.sha256 !== hash.digest('hex'))) throw new Error('The copy did not match what it came from, so it was removed.')
      return size
    } catch (e) {
      await unlink(to).catch(() => {})
      throw e
    }
  } finally {
    await input.close()
  }
}

/** Fills `to`, a new empty folder, with a copy of `tree` (walked from `from`), and checks it whole. Links are left out. */
async function fillFolder(tree: Awaited<ReturnType<typeof walk>>, from: string, to: string, signal?: AbortSignal): Promise<void> {
  for (const dir of tree.dirs) {
    signal?.throwIfAborted()
    await mkdir(join(to, relative(from, dir)))
  }
  for (const file of tree.files) await copyOne(file, join(to, relative(from, file)), true, signal)
  const copy = await walk(to, tree.files.length + tree.dirs.length + 1)
  if (copy.files.length !== tree.files.length || copy.dirs.length !== tree.dirs.length || copy.links.length || copy.bytes !== tree.bytes) throw new Error('The copy did not match what it came from, so it was removed.')
}

/** A new empty folder `to`, made exclusively: a taken name is refused, never merged into. Its stats, to undo by. */
async function makeEmpty(name: string, to: string): Promise<Stats> {
  await mkdir(to).catch(async (e) => {
    throw codeOf(e) === 'EEXIST' ? await taken(name, to) : e
  })
  return lstat(to)
}

/** A new empty folder `name` in `dir`: exclusive (a taken name is refused 'taken', never merged into). Returns its path. */
export async function makeFolder(fence: WriteFence, dir: string, name: string): Promise<string> {
  const { parent, to } = await targetOf(fence, dir, name)
  const made = await makeEmpty(name, to)
  await landed(parent, to, removeIfSame(made))
  return to
}

/** A new file `name` in `dir` holding `data` (bytes, or a path of this host to copy from, which need not be in the fence: a staged upload or a blank file shipped with the app). Exclusive create: never replaces. Written to disk (fsync) before it answers. Returns its path. */
export async function makeFile(fence: WriteFence, dir: string, name: string, data: Uint8Array | { from: string }): Promise<string> {
  const { parent, to } = await targetOf(fence, dir, name)
  try {
    if (data instanceof Uint8Array) {
      const out = await open(to, 'wx')
      try {
        await out.writeFile(data)
        await out.sync()
      } catch (e) {
        await unlink(to).catch(() => {})
        throw e
      } finally {
        await out.close()
      }
    } else await copyOne(data.from, to, false)
  } catch (e) {
    throw codeOf(e) === 'EEXIST' ? await taken(name, to) : e
  }
  await landed(parent, to, removeIfSame(await lstat(to)))
  return to
}

/**
 * Renames or moves a file or folder to `<toDir>/<name>`, never over anything: a taken name is refused
 * 'taken'. Inside one volume it is one step; across volumes it is a copy, synced and read back (size and
 * sha256 for a file of 64 MB or less, size alone above), then the source removed. A folder across volumes
 * over 2 GB, or holding a link (a copy leaves links out), is refused. Returns the new path.
 */
export async function moveNoReplace(fence: WriteFence, from: string, toDir: string, name: string): Promise<string> {
  checkName(name)
  const src = await admitPath(fence, from)
  if ((await realRoots(fence)).includes(src)) throw new FileRefused('outside', 'A place itself cannot be moved.')
  const info = await lstat(src)
  const { parent, to } = await targetOf(fence, toDir, name)
  // The same thing under another spelling: a case change on a disk that reads names case-blind.
  const same = await lstat(to).then(
    (s) => s.ino === info.ino && s.dev === info.dev,
    () => false
  )
  if (same) {
    await rename(src, to)
    return to
  }
  if (!info.isDirectory()) {
    try {
      if (writeSeams.across) throw Object.assign(new Error('across'), { code: 'EXDEV' })
      await link(src, to)
    } catch (e) {
      if (codeOf(e) === 'EEXIST') throw await taken(name, to)
      // No hard link here (another volume, or a disk without them): copy, check, then remove the source.
      if (!['EXDEV', 'EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EMLINK'].includes(codeOf(e) ?? '')) throw e
      await copyOne(src, to, true).catch(async (e) => {
        throw codeOf(e) === 'EEXIST' ? await taken(name, to) : e
      })
      await landed(parent, to, removeIfSame(await lstat(to)))
      await unlink(src)
      return to
    }
    await landed(parent, to, removeIfSame(info))
    await unlink(src)
    return to
  }

  if (within(parent, src)) throw new FileRefused('outside', 'A folder cannot go inside itself.')
  const made = await makeEmpty(name, to)
  await landed(parent, to, removeIfSame(made))
  if (!writeSeams.across && info.dev === made.dev) {
    try {
      // POSIX lets a folder be renamed onto an empty one, and refuses when something appeared inside it since.
      // Windows does not, so there the empty folder goes first and another writer may take the name in that gap.
      if (process.platform === 'win32') await rmdir(to)
      await rename(src, to)
    } catch (e) {
      if (process.platform !== 'win32') await rmdir(to).catch(() => {})
      if (['ENOTEMPTY', 'EEXIST', ...(process.platform === 'win32' ? ['EPERM'] : [])].includes(codeOf(e) ?? '')) throw await taken(name, to)
      if (codeOf(e) !== 'EXDEV' || process.platform === 'win32') throw e
      // A bind mount on one device still answers EXDEV: copy instead, into a fresh empty folder.
      return moveAcross(fence, src, parent, to, await makeEmpty(name, to))
    }
    await landed(parent, to, (real) => rename(real, src))
    return to
  }
  return moveAcross(fence, src, parent, to, made)
}

/** A folder moved to another volume: copied into `to` (new and empty), checked, then the source removed. */
async function moveAcross(fence: WriteFence, src: string, parent: string, to: string, made: Stats): Promise<string> {
  const undo = removeIfSame(made)
  try {
    const tree = await walk(src, 50_000)
    if (tree.bytes > FOLDER_ACROSS_MAX) throw new FileRefused('too-big', 'This folder is over 2 GB, too big to move to another disk.')
    if (tree.links.length) throw new FileRefused('link', 'This folder holds a link, which cannot be moved to another disk.')
    await fillFolder(tree, src, to)
    await landed(parent, to, undo)
  } catch (e) {
    await undo(to).catch(() => {})
    throw e
  }
  // The source is removed only where it still really is.
  if ((await admitPath(fence, src)) !== src) throw changed()
  await rm(src, { recursive: true })
  return to
}

/** Copies a file or a whole folder to `<toDir>/<name>`, never over anything; links inside a folder are neither followed nor copied; the copy is checked whole (count and bytes, and sha256 per file of 64 MB or less) before it answers, and a copy that fails half way is removed. Returns the new path. */
export async function copyNoReplace(fence: WriteFence, from: string, toDir: string, name: string, opts: { signal?: AbortSignal } = {}): Promise<string> {
  checkName(name)
  const src = await admitPath(fence, from)
  const info = await lstat(src)
  const tree = info.isDirectory() ? await walk(src, 50_000) : null
  const { parent, to } = await targetOf(fence, toDir, name)
  if (!tree) {
    await copyOne(src, to, true, opts.signal).catch(async (e) => {
      throw codeOf(e) === 'EEXIST' ? await taken(name, to) : e
    })
    await landed(parent, to, removeIfSame(await lstat(to)))
    return to
  }
  const made = await makeEmpty(name, to)
  const undo = removeIfSame(made)
  await landed(parent, to, undo)
  try {
    await fillFolder(tree, src, to, opts.signal)
    await landed(parent, to, undo)
  } catch (e) {
    await undo(to).catch(() => {})
    throw e
  }
  return to
}

/** A file's version, for "is it still the one shown": its size, its change time and, for a file of 64 MB or less, its sha256. */
export async function versionOf(path: string): Promise<{ size: number; mtimeMs: number; sha256?: string }> {
  const { size, mtimeMs } = await stat(path)
  if (size > HASH_MAX) return { size, mtimeMs }
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
  return { size, mtimeMs, sha256: hash.digest('hex') }
}

type Version = Awaited<ReturnType<typeof versionOf>>
/** Whether two versions are one: by sha256 when both have it, else by size and time. */
export const sameVersion = (a: Version, b: Version): boolean => (a.sha256 && b.sha256 ? a.sha256 === b.sha256 : a.size === b.size && a.mtimeMs === b.mtimeMs)

// ── locks ─────────────────────────────────────────────────────────────

/** Each held key's last waiter: the next caller waits for it. */
const queues = new Map<string, Promise<void>>()

/** Runs `fn` with these keys held, one caller at a time per key (keys are `refKey`s; taken in sorted order so two callers never deadlock). In this process only. */
export async function withFileLocks<T>(keys: readonly string[], fn: () => Promise<T>): Promise<T> {
  const releases: (() => void)[] = []
  try {
    for (const key of [...new Set(keys)].sort()) {
      const before = queues.get(key) ?? Promise.resolve()
      let release!: () => void
      const mine = new Promise<void>((r) => (release = r))
      const tail = before.then(() => mine)
      queues.set(key, tail)
      releases.push(() => {
        release()
        if (queues.get(key) === tail) queues.delete(key)
      })
      await before
    }
    return await fn()
  } finally {
    for (const release of releases) release()
  }
}

/** Whether a key is held now (a save in flight): a rename answers "A thread is writing in this file" from it. */
export const fileLocked = (key: string): boolean => queues.has(key)

// ── the journal ───────────────────────────────────────────────────────

const inFlight = new Map<string, Promise<unknown>>()
const failedRow = (e: unknown): string => JSON.stringify({ message: e instanceof Error ? e.message : String(e), code: e instanceof FileRefused ? e.code : undefined })
const kept = (result: string | null): Error => {
  const { message, code } = JSON.parse(result ?? '{}') as { message?: string; code?: RefusedCode }
  return code ? new FileRefused(code, message ?? '') : new Error(message)
}

/**
 * The journal behind operation ids (`work_files_ops`). `run` answers what `fn` answers and keeps it under
 * `op.id`; the same id again answers the kept result and does not call `fn` (a retry after a lost answer
 * does nothing twice). `fn` must answer something JSON holds: a later call gets it back through JSON
 * (undefined comes back as null). An id seen with another workspace, verb or refs is refused. A run that
 * threw is kept as failed with its sentence, and the same id again throws that sentence without running
 * (the caller mints a new id to try again). While one is running, the same id again waits for it in this
 * process.
 */
export function runOp<T>(db: DatabaseSync, op: { id: string; workspaceId: string; verb: string; refs: unknown }, fn: () => Promise<T>): Promise<T> {
  const refs = JSON.stringify(op.refs ?? null)
  // One statement decides who runs it: the caller whose row went in.
  const mine = Number(db.prepare(`INSERT INTO work_files_ops (id, workspace_id, verb, refs, state, at) VALUES (?, ?, ?, ?, 'running', ?) ON CONFLICT (id) DO NOTHING`).run(op.id, op.workspaceId, op.verb, refs, Date.now()).changes) === 1
  if (!mine) {
    const row = db.prepare(`SELECT workspace_id, verb, refs, state, result FROM work_files_ops WHERE id = ?`).get(op.id) as { workspace_id: string; verb: string; refs: string; state: string; result: string | null }
    if (row.workspace_id !== op.workspaceId || row.verb !== op.verb || row.refs !== refs) return Promise.reject(new Error('That operation id was used for another change.'))
    if (row.state === 'done') return Promise.resolve(JSON.parse(row.result ?? 'null') as T)
    if (row.state === 'failed') return Promise.reject(kept(row.result))
    return (inFlight.get(op.id) as Promise<T> | undefined) ?? Promise.reject(new FileRefused('busy', 'This change is still under way.'))
  }
  // `fn` starts on the next tick, so the run is in the map before anything of it can finish.
  const run = Promise.resolve()
    .then(fn)
    .then(
      (value) => {
        db.prepare(`UPDATE work_files_ops SET state = 'done', result = ? WHERE id = ?`).run(JSON.stringify(value ?? null), op.id)
        return value
      },
      (e: unknown) => {
        db.prepare(`UPDATE work_files_ops SET state = 'failed', result = ? WHERE id = ?`).run(failedRow(e), op.id)
        throw e
      }
    )
    .finally(() => inFlight.delete(op.id))
  inFlight.set(op.id, run)
  return run
}

/** At boot: rows left `running` by a process that died are marked failed ("The app stopped before this finished."). Returns how many. */
export function settleOps(db: DatabaseSync): number {
  return Number(db.prepare(`UPDATE work_files_ops SET state = 'failed', result = ? WHERE state = 'running'`).run(failedRow(new Error('The app stopped before this finished.'))).changes)
}

/** Drops rows older than a week. */
export function pruneOps(db: DatabaseSync, now = Date.now()): number {
  return Number(db.prepare(`DELETE FROM work_files_ops WHERE at < ? AND state != 'running'`).run(now - WEEK).changes)
}
