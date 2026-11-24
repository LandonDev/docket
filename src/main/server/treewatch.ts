import { watch as fsWatch, statSync, type FSWatcher } from 'fs'
import { readdir } from 'fs/promises'
import { basename, join, relative, sep } from 'path'
import { APP_DIR } from './appDir'
import { guardWatch, noteWatchFailure } from './watchGuard'

/**
 * One watcher per tree, one fd per tree. chokidar 4+ has no FSEvents
 * backend, so on macOS it opens a kqueue fd per FILE — two ~10k-file
 * worktrees exhausted the process fd table (spawn EBADF), and past that
 * limit the kqueue-held vnodes starved the SYSTEM tables (network down,
 * apps unlaunchable, reboot required — 2026-08-17). Node's own
 * fs.watch(root, {recursive}) rides FSEvents / ReadDirectoryChangesW on
 * darwin/win32.
 *
 * Linux has no recursive watch: one inotify watch per folder, never per
 * file (a folder's watch reports its files' writes, creations, removals
 * and renames). Until 2026-11-23 this was chokidar, which watched every
 * FILE as well; with the box's main checkout open it walked into 198
 * worktrees under `.claude/worktrees` and held 1,030,566 of the box's
 * 1,048,576 inotify watches, and every new watch on the box failed with
 * ENOSPC. Now a folder that is its own repository (holds a `.git`, as a
 * worktree or a clone does) is never entered, nor `.claude/worktrees`, nor
 * WATCH_IGNORED, nor a symlink; and the process holds at most
 * WATCH_CEILING folder watches across every tree, saying so once when it
 * stops short (watchStats, in doctor.get).
 */

/** Directory names ignored at any depth (build storms, VCS, app dirs). */
export const WATCH_IGNORED = new Set([
  '.git',
  APP_DIR,
  'node_modules',
  'target',
  'build',
  'dist',
  'out',
  '.gradle',
  '.idea',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.turbo',
  '.vite',
  '.cache',
  '.parcel-cache',
  'coverage',
  '__pycache__',
  '.venv',
  'venv',
  '.pytest_cache',
  '.mypy_cache',
  'DerivedData',
  'Pods'
])

/** `.claude/worktrees`: the agents' worktrees of this checkout, each a tree of its own. */
const isWorktreesDir = (segs: readonly string[], i: number): boolean => segs[i] === 'worktrees' && segs[i - 1] === '.claude'

export function treeIgnored(root: string, abs: string): boolean {
  const rel = relative(root, abs)
  if (!rel || rel.startsWith('..')) return false
  const segs = rel.split(sep)
  return segs.some((seg, i) => WATCH_IGNORED.has(seg) || isWorktreesDir(segs, i))
}

/** Folder watches the whole process may hold on Linux, every tree together. */
export const WATCH_CEILING = 20_000

let held = 0
const roots = new Map<string, { held: number; partial: boolean }>()
let ceiling = WATCH_CEILING
let warn: (line: string) => void = (line) => console.warn(line)

/** What doctor.get shows: folder watches held now, the ceiling, and each tree's share. */
export function watchStats(): { held: number; ceiling: number; roots: { root: string; held: number; partial: boolean }[] } {
  return { held, ceiling, roots: [...roots].map(([root, r]) => ({ root, ...r })) }
}

/** Test seam: a smaller ceiling and a captured log. */
export function setWatchLimitsForTests(o: { ceiling?: number; log?: (line: string) => void } | null): void {
  ceiling = o?.ceiling ?? WATCH_CEILING
  warn = o?.log ?? ((line) => console.warn(line))
}

export type TreeEventKind = 'created' | 'changed' | 'deleted'

export interface TreeWatcher {
  close(): void | Promise<void>
}

export function watchTree(
  root: string,
  opts: {
    onEvent: (kind: TreeEventKind, abs: string) => void
    /** report directory creations too (deletions are always reported —
     *  a gone path has no stat to tell file from dir) */
    dirs?: boolean
  }
): TreeWatcher {
  if (process.platform === 'darwin' || process.platform === 'win32') {
    const w = guardWatch(`the file tree ${root}`, 'its live file events are off', () => fsWatch(root, { recursive: true }, (event, filename) => {
      if (!filename) return
      const abs = join(root, filename.toString())
      if (treeIgnored(root, abs)) return
      // 'rename' covers create, delete and both ends of a move; 'change'
      // is a content write. Existence disambiguates; a stat race on a
      // vanishing file lands on 'deleted', which is the truth anyway.
      let isDir: boolean | null = null
      try {
        isDir = statSync(abs).isDirectory()
      } catch {
        // FSEvents echoes events about the root itself as the root's
        // basename — which stats as a missing child. Never a real delete.
        if (filename.toString() === basename(root)) return
        opts.onEvent('deleted', abs)
        return
      }
      if (isDir && !opts.dirs) return
      opts.onEvent(event === 'change' ? 'changed' : 'created', abs)
    }))
    if (!w) return { close() {} }
    w.on('error', () => {}) // transient fs races — the next event self-heals
    return w
  }
  return linuxTree(root, opts)
}

/** One inotify watch per folder of the tree (see the file's comment). */
function linuxTree(root: string, opts: { onEvent: (kind: TreeEventKind, abs: string) => void; dirs?: boolean }): TreeWatcher {
  // Per watched folder: its watch and the names in it, so a rename tells a new file from a replaced one.
  const dirs = new Map<string, { watch: FSWatcher; names: Set<string> }>()
  const share = { held: 0, partial: false }
  const key = roots.has(root) ? `${root}#${roots.size}` : root
  roots.set(key, share)
  let closed = false

  const unwatch = (dir: string): void => {
    for (const [path, entry] of dirs) {
      if (path !== dir && !path.startsWith(dir + sep)) continue
      entry.watch.close()
      dirs.delete(path)
      held--
      share.held--
    }
  }

  const add = async (dir: string): Promise<void> => {
    if (closed || dirs.has(dir)) return
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    // A folder that is a repository of its own (a worktree, a clone) is another tree.
    if (dir !== root && entries.some((e) => e.name === '.git')) return
    if (closed || dirs.has(dir)) return
    if (held >= ceiling) {
      if (!share.partial) warn(`[treewatch] ceiling of ${ceiling} watched folders reached: ${root} is watched in part (${share.held} folders)`)
      share.partial = true
      return
    }
    let watch: FSWatcher
    try {
      watch = fsWatch(dir, { persistent: true }, (event, filename) => {
        if (filename) void onChild(dir, event, filename.toString())
      })
    } catch (err) {
      // ENOSPC or EMFILE: the tree is watched in part, said once.
      if (!share.partial) noteWatchFailure(`the file tree ${root}`, `it is watched in part (${share.held} folders)`, err)
      share.partial = true
      return
    }
    watch.on('error', () => unwatch(dir))
    dirs.set(dir, { watch, names: new Set(entries.map((e) => e.name)) })
    held++
    share.held++
    for (const e of entries) {
      // Symlinks are not followed: a linked node_modules or a link out of the tree is not ours to walk.
      if (e.isDirectory() && !e.isSymbolicLink()) {
        const child = join(dir, e.name)
        if (!treeIgnored(root, child)) await add(child)
      }
    }
  }

  const onChild = async (dir: string, event: string, name: string): Promise<void> => {
    const entry = dirs.get(dir)
    if (!entry || closed) return
    const abs = join(dir, name)
    if (treeIgnored(root, abs)) return
    let isDir: boolean
    try {
      const st = statSync(abs, { throwIfNoEntry: false })
      if (!st) throw new Error('gone')
      isDir = st.isDirectory()
    } catch {
      if (!entry.names.delete(name)) return
      unwatch(abs)
      opts.onEvent('deleted', abs)
      return
    }
    const known = entry.names.has(name)
    entry.names.add(name)
    if (isDir) {
      if (!known) {
        if (opts.dirs) opts.onEvent('created', abs)
        await add(abs)
      }
      return
    }
    opts.onEvent(known && (event === 'change' || event === 'rename') ? 'changed' : 'created', abs)
  }

  void add(root)
  return {
    close() {
      closed = true
      unwatch(root)
      for (const [path, entry] of dirs) {
        entry.watch.close()
        dirs.delete(path)
        held--
        share.held--
      }
      roots.delete(key)
    }
  }
}
