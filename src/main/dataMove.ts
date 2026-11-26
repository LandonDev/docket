/**
 * The move to Docket's names (docs/agents/docket-data-move.md). boot.ts runs
 * it first, before the database opens, before the single-instance lock and
 * Chromium's profile, before the staged code is picked. One rule for every
 * part: the thing moves to its new name and a link at the old name points to
 * it. Nothing stored is rewritten, so an older build still finds everything
 * by the old names, and nothing is ever copied: a move that cannot be one
 * rename on one disk is left undone, the app runs on the old names, and the
 * reason is said in the log and in doctor.get (`held`).
 *
 * - The data folder, `<appData>/temp-code` (on Windows
 *   `%LOCALAPPDATA%\temp-code`), becomes `<appData>/Docket`. Only the
 *   installed app's own folder moves: an override (TEMP_CODE_USER_DATA, a
 *   bundle's baked harness folder) is the caller's, never moved.
 * - `~/.temp-code` (worktrees, attachments) becomes `~/.docket`, with the
 *   data folder and under the same conditions. The code keeps the old
 *   spelling: stored paths and git's worktree records name it.
 * - In whichever folder the launch runs on, `temp-code.db` becomes
 *   `docket.db` and `temp-code-cold.db` `docket-cold.db`, with their -wal,
 *   -shm and -journal. SQLite names those from the real file behind a link,
 *   so the old name opens the same database and the same WAL. Not on
 *   Windows: a file link there needs a privilege, and a hard link would give
 *   each name its own WAL, so the old names stay.
 *
 * Every step is a rename or a link, ordered so a crash between any two
 * leaves a state the next launch finishes, and an older build reads right.
 * A folder another live process holds (its Chromium SingletonLock) is left
 * for a later launch. Two real folders, or two real databases, are never
 * merged: the one with the live data is used and nothing changes.
 *
 * boot.ts imports this file and nothing index.ts imports does; the app reads
 * the outcome from `globalThis.__tempcodeDataMove` (dataMoveBoot.ts).
 */
import {
  closeSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeSync,
  type Stats
} from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

export const OLD_DATA = 'temp-code'
export const NEW_DATA = 'Docket'
export const OLD_HOME = '.temp-code'
export const NEW_HOME = '.docket'
export const OLD_DB = 'temp-code.db'
export const NEW_DB = 'docket.db'
/** Each database's old and new name; db.ts names the cold file from the main one. */
export const DB_NAMES = [
  [OLD_DB, NEW_DB],
  ['temp-code-cold.db', 'docket-cold.db']
] as const
/** A launch's claim on a move in progress, `{pid, at}`. It travels with a folder that moves. */
export const MARK = '.docket-move'
/** The -shm is an index SQLite rebuilds when it opens alone; the -journal and -wal hold data, the -wal moved last. */
const SIDECARS = ['-shm', '-journal', '-wal'] as const
/** Names only this app leaves, which make a folder at the new name ours to finish. */
const DATA_KNOWN = [OLD_DB, NEW_DB]
const HOME_KNOWN = ['worktrees', 'attachments']
/** How long a launch waits for another launch's move, and when a mark is too old to be one. */
const WAIT_MS = 5_000
const STALE_MS = 60_000

/** What the move changes on disk: tests stand in for one to refuse a rename or stop dead after a step. */
export interface MoveOps {
  rename(from: string, to: string): void
  symlink(target: string, path: string, type?: 'junction'): void
  link(existing: string, path: string): void
  unlink(path: string): void
  mkdir(path: string): void
  /** Make `path` holding `text`; EEXIST when it is there. */
  create(path: string, text: string): void
}

export const nodeOps: MoveOps = {
  rename: (from, to) => renameSync(from, to),
  symlink: (target, path, type) => symlinkSync(target, path, type),
  link: (existing, path) => linkSync(existing, path),
  unlink: (path) => unlinkSync(path),
  mkdir: (path) => void mkdirSync(path, { recursive: true }),
  create: (path, text) => {
    const fd = openSync(path, 'wx')
    try {
      writeSync(fd, text)
    } finally {
      closeSync(fd)
    }
  }
}

export interface MoveInput {
  platform: NodeJS.Platform
  home: string
  /** Electron's own userData for this build: `<appData>/temp-code`. */
  defaultUserData: string
  /** TEMP_CODE_USER_DATA, else the bundle's baked harness folder: never moved. */
  override: string | null
  /** %LOCALAPPDATA%: where Windows keeps the data folder (windowFrame.ts localUserData). */
  localAppData?: string
  /** Only an installed app moves its folders; a dev build touches nothing without an override. */
  packaged: boolean
  pid: number
  /** Whether a process holds `pid`: any program, since a dev build may run on the same data. */
  alive?: (pid: number) => boolean
  ops?: MoveOps
  sleep?: (ms: number) => void
  now?: () => number
}

/** What boot.ts leaves on `globalThis.__tempcodeDataMove` for the app. */
export interface DataMove {
  v: 1
  /** The folder this launch runs on. */
  userData: string
  /** boot.ts sets userData to `userData`: the installed app's own folder, at whichever name holds it. */
  setPath: boolean
  /** The main database's file name in `userData`. */
  db: string
  /** What this launch changed, a line each. Empty once everything has moved. */
  did: string[]
  /** What stays on the old names, and why. */
  held: string[]
}

interface Ctx {
  ops: MoveOps
  pid: number
  alive: (pid: number) => boolean
  sleep: (ms: number) => void
  now: () => number
  junction: boolean
  did: string[]
  held: string[]
}

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return code(err) === 'EPERM'
  }
}

/** A blocking sleep: boot runs before anything could wait on a promise. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

export function moveData(input: MoveInput): DataMove {
  const c: Ctx = {
    ops: input.ops ?? nodeOps,
    pid: input.pid,
    alive: input.alive ?? processAlive,
    sleep: input.sleep ?? sleepSync,
    now: input.now ?? Date.now,
    junction: input.platform === 'win32',
    did: [],
    held: []
  }
  const windows = input.platform === 'win32'
  const own =
    windows && input.localAppData ? join(input.localAppData, basename(input.defaultUserData)) : input.defaultUserData
  let userData = input.override ?? own
  const setPath = !input.override && input.packaged
  // A dev build without an override refuses to run (index.ts): it never touches the installed app's data.
  if (!setPath && !input.override) return { v: 1, userData, setPath, db: pickDb(userData, windows), did: [], held: [] }
  const step = <T>(fallback: () => T, run: () => T): T => {
    try {
      return run()
    } catch (err) {
      c.held.push(`the move stopped (${errorLine(err)}); the next launch tries again`)
      return fallback()
    }
  }
  if (!input.override && basename(own) === OLD_DATA) {
    const neu = join(dirname(own), NEW_DATA)
    userData = step(
      () => (lstatOf(own) ? own : neu),
      () => moveFolder(own, neu, DATA_KNOWN, c)
    )
    // The rest follows only a finished move. A held one, or two folders, leave everything as it is.
    if (userData !== neu || !lstatOf(own)?.isSymbolicLink()) {
      return { v: 1, userData, setPath, db: pickDb(userData, userData !== neu), did: c.did, held: c.held }
    }
    step(
      () => null,
      () => moveFolder(join(input.home, OLD_HOME), join(input.home, NEW_HOME), HOME_KNOWN, c)
    )
  }
  const db = step(
    () => pickDb(userData, windows),
    () => (windows ? pickDb(userData, true) : moveDbs(userData, c))
  )
  return { v: 1, userData, setPath, db, did: c.did, held: c.held }
}

/** One folder to its new name. Returns the folder to run on. */
function moveFolder(old: string, neu: string, known: readonly string[], c: Ctx): string {
  const o = lstatOf(old)
  const n = lstatOf(neu)
  if (o?.isSymbolicLink()) {
    if (!pointsAt(old, neu)) {
      c.held.push(`${old} is a link to somewhere else; it stays as it is`)
      return old
    }
    if (!n) {
      // The link waits for a folder: a fresh install's, or one someone removed.
      c.ops.mkdir(neu)
      c.did.push(`made ${neu} for the link at ${old}`)
    } else dropStaleMark(neu, c)
    return neu
  }
  if (n?.isSymbolicLink()) {
    c.held.push(`${neu} is a link; ${old} keeps its name`)
    return o ? old : neu
  }
  if (o && !o.isDirectory()) {
    c.held.push(`${old} is not a folder; nothing moved`)
    return old
  }
  if (o && n?.isDirectory()) {
    // Never merged. A move cut off before its link leaves its mark in the new folder.
    const use = readMark(neu) || (ours(neu, known) && newer(neu, old)) ? neu : old
    c.held.push(`both ${old} and ${neu} exist; running on ${use}, nothing merged`)
    return use
  }
  if (n && !n.isDirectory()) {
    c.held.push(`${neu} is not a folder; nothing moved`)
    return old
  }
  if (!o) {
    if (n && !ours(neu, known)) {
      c.held.push(`${neu} belongs to something else; running on ${old}`)
      return old
    }
    // A fresh install, or a move cut off before its link: the folder first, then the link.
    if (!n) c.ops.mkdir(neu)
    const use = linkFolder(old, neu, c)
    if (use === neu) c.did.push(n ? `linked ${old} to ${neu}` : `made ${neu} with a link at ${old}`)
    return use
  }
  // The old folder alone: the move itself.
  const holder = liveHolder(old, c)
  if (holder) {
    c.held.push(`${old} is in use by process ${holder}; it moves at a later launch`)
    return old
  }
  const claim = takeMark(old, c)
  if (claim === 'again') return moveFolder(old, neu, known, c)
  if (claim === 'busy') return lstatOf(old)?.isDirectory() ? old : neu
  try {
    c.ops.rename(old, neu)
  } catch (err) {
    dropMark(old, c)
    c.held.push(`${old} could not be renamed (${errorLine(err)}); running on it`)
    return old
  }
  const use = linkFolder(old, neu, c)
  if (use === neu) c.did.push(`moved ${old} to ${neu}, with a link at the old name`)
  return use
}

/**
 * The link at `old`, then the mark dropped. When no link can be made the
 * folder goes back to its old name; only if that fails too does the app run
 * at `neu`, which an older build cannot find.
 */
function linkFolder(old: string, neu: string, c: Ctx): string {
  try {
    // Relative off Windows: the pair sits side by side, and the link survives the parent's move. A junction needs a full path.
    c.ops.symlink(c.junction ? resolve(neu) : basename(neu), old, c.junction ? 'junction' : undefined)
  } catch (err) {
    try {
      c.ops.rename(neu, old)
      dropMark(old, c)
      c.held.push(`no link could be made at ${old} (${errorLine(err)}); it keeps its name`)
      return old
    } catch {
      c.held.push(`no link could be made at ${old} (${errorLine(err)}); running on ${neu}, which an older build cannot find`)
      return neu
    }
  }
  dropMark(neu, c)
  return neu
}

/** Whether `a`'s newest database file changed after `b`'s. A tie keeps `b`. */
function newer(a: string, b: string): boolean {
  const stamp = (dir: string): number =>
    Math.max(-1, ...safeList(dir).filter((name) => /\.db(-wal)?$/.test(name)).map((name) => mtimeOf(join(dir, name))))
  return stamp(a) > stamp(b)
}

/** Ours to finish: our mark, one of the names only this app leaves, or nothing at all. */
function ours(dir: string, known: readonly string[]): boolean {
  const names = safeList(dir)
  return names.length === 0 || names.includes(MARK) || known.some((name) => names.includes(name))
}

/** The pid in a folder's Chromium SingletonLock (`host-pid`), when that process is alive and is not this one. */
function liveHolder(dir: string, c: Ctx): number | null {
  const target = readlinkOf(join(dir, 'SingletonLock'))
  if (target === null) return null
  const pid = Number(target.slice(target.lastIndexOf('-') + 1))
  return isLive(pid, c) ? pid : null
}

function isLive(pid: number, c: Ctx): boolean {
  return Number.isInteger(pid) && pid > 0 && pid !== c.pid && c.alive(pid)
}

/**
 * Claim a folder's move. `taken`: this launch owns it. `again`: another
 * launch finished while this one waited, look again. `busy`: another live
 * launch still holds it.
 */
function takeMark(dir: string, c: Ctx): 'taken' | 'again' | 'busy' {
  const path = join(dir, MARK)
  const text = JSON.stringify({ pid: c.pid, at: c.now() })
  try {
    c.ops.create(path, text)
    return 'taken'
  } catch (err) {
    if (code(err) !== 'EEXIST') throw err
  }
  if (markLive(dir, c)) {
    const until = c.now() + WAIT_MS
    while (c.now() < until) {
      c.sleep(50)
      if (!lstatOf(path)) return 'again'
    }
    c.held.push(`another launch is moving ${dir}`)
    return 'busy'
  }
  // A launch that died mid-move: this one takes its place.
  c.ops.unlink(path)
  c.ops.create(path, text)
  return 'taken'
}

function readMark(dir: string): { pid: number; at: number } | null {
  if (!lstatOf(join(dir, MARK))) return null
  try {
    const raw = JSON.parse(readFileSync(join(dir, MARK), 'utf8')) as { pid?: unknown; at?: unknown }
    return { pid: typeof raw.pid === 'number' ? raw.pid : 0, at: typeof raw.at === 'number' ? raw.at : 0 }
  } catch {
    return { pid: 0, at: 0 }
  }
}

/** A mark another launch, alive now, made within the last minute: a move takes milliseconds. */
function markLive(dir: string, c: Ctx): boolean {
  const mark = readMark(dir)
  return !!mark && isLive(mark.pid, c) && c.now() - mark.at < STALE_MS
}

function dropMark(dir: string, c: Ctx): void {
  try {
    c.ops.unlink(join(dir, MARK))
  } catch {
    // gone already, or the next launch drops it
  }
}

/** A mark left by a launch that died after its last step. */
function dropStaleMark(dir: string, c: Ctx): void {
  if (readMark(dir) && !markLive(dir, c)) dropMark(dir, c)
}

type DbPlan = 'done' | 'move' | { use: string; why: string }

/**
 * Both databases in `dir` to their new names; returns the main one's name
 * to open. Planned first and moved only when neither pair is in doubt, so
 * the cold file, which db.ts names from the main one, always sits beside it.
 */
function moveDbs(dir: string, c: Ctx): string {
  // Followed: the box names its data by a link (/srv/agents/temp-code-data, once docket-move.sh ran).
  if (!statOf(dir)?.isDirectory()) return NEW_DB
  const holder = liveHolder(dir, c)
  if (holder) {
    c.held.push(`the databases in ${dir} are in use by process ${holder}; they move at a later launch`)
    return pickDb(dir, false)
  }
  const plans = DB_NAMES.map(([oldName, newName]) => dbPlan(dir, oldName, newName))
  const doubts = plans.filter((plan): plan is { use: string; why: string } => typeof plan === 'object')
  if (doubts.length > 0) {
    for (const doubt of doubts) c.held.push(doubt.why)
    const main = plans[0]
    return typeof main === 'object' ? main.use : main === 'done' ? NEW_DB : OLD_DB
  }
  if (plans.every((plan) => plan === 'done')) {
    dropStaleMark(dir, c)
    return NEW_DB
  }
  const claim = takeMark(dir, c)
  if (claim === 'again') return moveDbs(dir, c)
  if (claim === 'busy') return pickDb(dir, false)
  DB_NAMES.forEach(([oldName, newName], i) => {
    if (plans[i] === 'move') moveDb(dir, oldName, newName, c)
  })
  dropMark(dir, c)
  return NEW_DB
}

/** What one database's names say, without changing anything. */
function dbPlan(dir: string, oldName: string, newName: string): DbPlan {
  const oldPath = join(dir, oldName)
  const newPath = join(dir, newName)
  const o = lstatOf(oldPath)
  const n = lstatOf(newPath)
  const twice = (): string | null => {
    const s = SIDECARS.find((s) => s !== '-shm' && isFile(lstatOf(oldPath + s)) && lstatOf(newPath + s))
    return s ? `${oldName + s} and ${newName + s} both exist in ${dir}` : null
  }
  if (o?.isSymbolicLink()) {
    if (readlinkOf(oldPath) !== newName) {
      return { use: oldName, why: `${oldName} in ${dir} is a link to somewhere else; it stays as it is` }
    }
    const both = twice()
    if (both) return { use: newName, why: `${both}; ${newName}'s is used, the other left alone` }
    return SIDECARS.some((s) => isFile(lstatOf(oldPath + s))) ? 'move' : 'done'
  }
  if (n?.isSymbolicLink()) return { use: oldName, why: `${newName} in ${dir} is a link; ${oldName} keeps its name` }
  if ((o && !o.isFile()) || (n && !n.isFile())) {
    return { use: oldName, why: `${oldName} or ${newName} in ${dir} is not a file; nothing moved` }
  }
  if (o && n && !sameFile(o, n)) {
    const stamp = (path: string): number => Math.max(mtimeOf(path), mtimeOf(path + '-wal'))
    const use = stamp(newPath) > stamp(oldPath) ? newName : oldName
    return { use, why: `${oldName} and ${newName} are two databases in ${dir}; running on ${use}, nothing merged` }
  }
  const both = o ? twice() : null
  if (both) return { use: oldName, why: `${both}; ${oldName} keeps its name, nothing merged` }
  return 'move'
}

/**
 * One database to its new name: a hard link at the new name, a link to it
 * made aside, the sidecars renamed, then the old name swapped for that link
 * in one rename. Every state between two steps opens right under both names
 * but one: between the -wal's rename and the swap, the next two calls, an
 * older build would open the old name without its WAL. Only a crash in that
 * instant followed by an older build's launch meets it; this build finishes
 * the move at its next launch.
 */
function moveDb(dir: string, oldName: string, newName: string, c: Ctx): void {
  const oldPath = join(dir, oldName)
  const newPath = join(dir, newName)
  const o = lstatOf(oldPath)
  if (!o) {
    // The link first in a fresh folder, so an older build that opens the old name makes the new file.
    c.ops.symlink(newName, oldPath)
    c.did.push(`linked ${oldName} to ${newName} in ${dir}`)
    return
  }
  const sidecars = (): void => {
    for (const s of SIDECARS) if (isFile(lstatOf(oldPath + s))) c.ops.rename(oldPath + s, newPath + s)
  }
  if (o.isSymbolicLink()) {
    sidecars()
    c.did.push(`moved ${oldName}'s leftover files to ${newName}'s in ${dir}`)
    return
  }
  if (!lstatOf(newPath)) c.ops.link(oldPath, newPath)
  const temp = `${oldPath}.docket-link`
  if (lstatOf(temp)) c.ops.unlink(temp)
  c.ops.symlink(newName, temp)
  sidecars()
  c.ops.rename(temp, oldPath)
  c.did.push(`renamed ${oldName} to ${newName} in ${dir}, with a link at the old name`)
}

/**
 * The database name to open in a folder this launch does not change: the
 * new one unless only the old exists, or, where the old names stay (Windows,
 * a held move), the old one unless only the new exists.
 */
function pickDb(dir: string, preferOld: boolean): string {
  const o = !!lstatOf(join(dir, OLD_DB))
  const n = !!lstatOf(join(dir, NEW_DB))
  if (preferOld) return n && !o ? NEW_DB : OLD_DB
  return o && !n ? OLD_DB : NEW_DB
}

function pointsAt(link: string, target: string): boolean {
  try {
    return realpathSync(link) === realpathSync(target)
  } catch {
    // Dangling: compare the words.
    const to = readlinkOf(link)
    if (to === null) return false
    const plain = (p: string): string =>
      resolve(dirname(link), p.replace(/^\\\\\?\\/, ''))
        .replace(/[\\/]+$/, '')
        .toLowerCase()
    return plain(to) === plain(target)
  }
}

function readlinkOf(path: string): string | null {
  try {
    return readlinkSync(path)
  } catch {
    return null
  }
}

function lstatOf(path: string): Stats | null {
  try {
    return lstatSync(path)
  } catch {
    return null
  }
}

function statOf(path: string): Stats | null {
  try {
    return statSync(path)
  } catch {
    return null
  }
}

function mtimeOf(path: string): number {
  const s = lstatOf(path)
  return s?.isFile() ? s.mtimeMs : -1
}

function isFile(s: Stats | null): boolean {
  return !!s && s.isFile()
}

function sameFile(a: Stats, b: Stats): boolean {
  return a.ino === b.ino && a.dev === b.dev
}

function safeList(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

function code(err: unknown): string {
  return (err as NodeJS.ErrnoException)?.code ?? ''
}

function errorLine(err: unknown): string {
  return code(err) || (err instanceof Error ? err.message : String(err))
}
