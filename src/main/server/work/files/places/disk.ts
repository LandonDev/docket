import { createHash } from 'node:crypto'
import { watch, type FSWatcher, type Stats } from 'node:fs'
import { lstat, opendir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { compareEntries, DEFAULT_SORT, kindOfEntry, LIST_PAGE_BYTES, LIST_PAGE_MAX, type EntryKind, type FileEntry, type FileSort } from '@shared/work/files'

/**
 * One folder of a disk as a sorted list, a page at a time (docs/agents/work-files.md "Performance"): what the
 * workspace's folder and a library on this host are both listed through.
 *
 * A folder is read as a stream of names (`opendir`, never a sync read of the whole folder) and kept for a few
 * seconds, so the pages of one scroll and the rows' own questions walk it once. Sorted by name or kind, only
 * the rows of the page asked for are looked at closer (`lstat`); sorted by time or size, every row is, in
 * batches. Nothing here reads a file's bytes: a file a cloud app keeps elsewhere is listed by its name and
 * size, and stays where it is.
 *
 * A link is never followed and never listed: what it points at may lie outside the place.
 */

export interface DiskRow {
  name: string
  dir: boolean
  kind: EntryKind
  size?: number
  /** epoch ms */
  changed?: number
  /** false: its bytes are in the cloud */
  local?: boolean
  /** looked at closer already */
  stated?: boolean
}

/** Names no list shows: dot files, Office's lock files, a desktop's own bookkeeping. */
export const hiddenName = (name: string): boolean => name.startsWith('.') || name.startsWith('~$') || name === 'Icon\r' || name === 'desktop.ini' || name === 'Thumbs.db' || name.endsWith('.tmp')

/** Whether a file's bytes are on this disk: a cloud-only file (macOS's "dataless") has its full size and no blocks. */
export const bytesHere = (s: Pick<Stats, 'size' | 'blocks'>): boolean => s.size === 0 || s.blocks > 0

/** How many rows are looked at closer at once. */
const STAT_BATCH = 64

async function stateRows(dir: string, rows: DiskRow[], signal?: AbortSignal): Promise<void> {
  const todo = rows.filter((r) => !r.stated)
  for (let i = 0; i < todo.length; i += STAT_BATCH) {
    if (signal?.aborted) throw new Error('cancelled')
    await Promise.all(
      todo.slice(i, i + STAT_BATCH).map(async (row) => {
        try {
          const s = await lstat(join(dir, row.name))
          row.changed = Math.round(s.mtimeMs)
          if (!row.dir) {
            row.size = s.size
            row.local = bytesHere(s)
          }
        } catch {
          // Gone between the listing and the look: the row keeps its name and says nothing more.
        }
        row.stated = true
      })
    )
  }
}

interface Snapshot {
  at: number
  /** changes when a name is added, removed or renamed in the folder */
  version: string
  rows: DiskRow[]
  /** the order the rows are in now */
  sorted: string
  reading?: Promise<void>
}

const tagOf = (dir: string): string => createHash('sha1').update(dir).digest('hex').slice(0, 10)
const sortTag = (sort: FileSort): string => `${sort.by}:${sort.dir}`

interface Cursor {
  /** the folder's tag and its version when the page before was cut */
  t: string
  v: string
  s: string
  /** the last row of that page */
  n: string
  d: boolean
  c?: number
  z?: number
}
const encode = (c: Cursor): string => Buffer.from(JSON.stringify(c)).toString('base64url')
function decode(cursor: string): Cursor | null {
  try {
    const c = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Cursor
    return c && typeof c.t === 'string' && typeof c.v === 'string' && typeof c.n === 'string' && typeof c.s === 'string' ? c : null
  } catch {
    return null
  }
}

export interface DiskPage {
  rows: DiskRow[]
  next?: string
  /** the folder changed since the cursor's page, or the cursor is another folder's or another order's */
  stale?: true
}

const cursorFits = (cursor: string, tag: string, sort: FileSort): boolean => {
  const from = decode(cursor)
  return !!from && from.t === tagOf(tag) && from.s === sortTag(sort)
}

/**
 * One page of rows already in `sort`'s order: the rows after the cursor's last row, `max` at most (`LIST_PAGE_MAX`)
 * and fewer when the page is heavy enough (`LIST_PAGE_BYTES`), with the cursor for the page after it. `tag` names
 * the list and `version` what it held: a cursor cut from another list, another order or another version is
 * `stale`, and the caller lists again from the top.
 */
export function cutPage(rows: readonly DiskRow[], o: { tag: string; version: string; sort: FileSort; cursor?: string; max?: number }): DiskPage {
  const { sort } = o
  const max = Math.min(o.max ?? LIST_PAGE_MAX, LIST_PAGE_MAX)
  const tag = tagOf(o.tag)
  const from = o.cursor ? decode(o.cursor) : null
  if (o.cursor && (!from || from.t !== tag || from.s !== sortTag(sort) || from.v !== o.version)) return { rows: [], stale: true }
  let start = 0
  if (from) {
    // A kind sort compares kinds, which the cursor's row does not carry: it finds the row by its name.
    if (sort.by === 'kind') start = rows.findIndex((r) => r.name === from.n && r.dir === from.d) + 1
    else {
      const last = { name: from.n, kind: (from.d ? 'folder' : 'other') as EntryKind, changed: from.c, size: from.z }
      let lo = 0
      let hi = rows.length
      while (lo < hi) {
        const mid = (lo + hi) >> 1
        if (compareEntries(rows[mid]!, last, sort) <= 0) lo = mid + 1
        else hi = mid
      }
      start = lo
    }
  }
  // A page is cut by its weight too: a folder of very long names must not make one answer huge.
  let bytes = 0
  let n = 0
  for (; n < max && start + n < rows.length; n++) {
    bytes += rows[start + n]!.name.length * 2 + 200
    if (bytes > LIST_PAGE_BYTES && n > 0) break
  }
  const out = rows.slice(start, start + n)
  const end = out.at(-1)
  const more = start + out.length < rows.length
  return { rows: out, ...(more && end ? { next: encode({ t: tag, v: o.version, s: sortTag(sort), n: end.name, d: end.dir, c: end.changed, z: end.size }) } : {}) }
}

export interface DiskListerOptions {
  /** how long a folder's names answer without being read again */
  freshMs?: number
  /** how many folders are kept */
  most?: number
  now?: () => number
}

export class DiskLister {
  private readonly kept = new Map<string, Snapshot>()
  private readonly watched = new Map<string, { watcher: FSWatcher; seenAt: number; timer: ReturnType<typeof setTimeout> | null }>()
  private readonly freshMs: number
  private readonly most: number
  private readonly now: () => number
  /** how many folders were read from the disk: what a test counts */
  reads = 0

  constructor(opts: DiskListerOptions = {}) {
    this.freshMs = opts.freshMs ?? 5_000
    this.most = opts.most ?? 64
    this.now = opts.now ?? Date.now
  }

  private async read(dir: string, signal?: AbortSignal): Promise<Snapshot> {
    this.reads++
    const before = await stat(dir)
    if (!before.isDirectory()) throw new Error('That is a file, not a folder.')
    const rows: DiskRow[] = []
    const handle = await opendir(dir, { bufferSize: 256 })
    try {
      for await (const d of handle) {
        if (signal?.aborted) throw new Error('cancelled')
        if (hiddenName(d.name) || d.isSymbolicLink()) continue
        const isDir = d.isDirectory()
        if (!isDir && !d.isFile()) continue
        rows.push({ name: d.name, dir: isDir, kind: isDir ? 'folder' : kindOfEntry(d.name).kind })
      }
    } finally {
      // `for await` closes the handle when it ends; a throw mid-way may leave it open.
      await handle.close().catch(() => undefined)
    }
    return { at: this.now(), version: `${Math.round(before.mtimeMs)}:${rows.length}`, rows, sorted: '' }
  }

  private async snapshot(dir: string, signal?: AbortSignal): Promise<Snapshot> {
    const was = this.kept.get(dir)
    if (was && this.now() - was.at < this.freshMs) {
      // A Map keeps insertion order: a folder asked for again goes to the end, so the least used goes first.
      this.kept.delete(dir)
      this.kept.set(dir, was)
      return was
    }
    const snap = await this.read(dir, signal)
    this.kept.delete(dir)
    this.kept.set(dir, snap)
    for (const key of this.kept.keys()) {
      if (this.kept.size <= this.most) break
      this.kept.delete(key)
    }
    return snap
  }

  /** One page of a folder: `max` rows at most, fewer when the page is heavy enough. */
  async page(dir: string, o: { sort?: FileSort; cursor?: string; foldersOnly?: boolean; max?: number; signal?: AbortSignal } = {}): Promise<DiskPage> {
    const sort = o.sort ?? DEFAULT_SORT
    // A cursor of another folder or another order is told apart before the disk is touched.
    if (o.cursor && !cursorFits(o.cursor, dir, sort)) return { rows: [], stale: true }
    const snap = await this.snapshot(dir, o.signal)
    // Two pages of one folder asked at once sort it once.
    while (snap.reading) await snap.reading
    if (snap.sorted !== sortTag(sort)) {
      snap.reading = (async () => {
        // Time and size are facts of each file: every row is looked at before the order is known.
        if (sort.by === 'changed' || sort.by === 'size') await stateRows(dir, snap.rows, o.signal)
        snap.rows.sort((a, b) => compareEntries(a, b, sort))
        snap.sorted = sortTag(sort)
      })().finally(() => void (snap.reading = undefined))
      await snap.reading
    }
    const cut = cutPage(o.foldersOnly ? snap.rows.filter((r) => r.dir) : snap.rows, { tag: dir, version: snap.version, sort, cursor: o.cursor, max: o.max })
    await stateRows(dir, cut.rows, o.signal)
    return cut
  }

  /** One row again, looked at now: null when it is gone, a link, or hidden. */
  async row(path: string): Promise<DiskRow | null> {
    try {
      const s = await lstat(path)
      const name = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)
      if (s.isSymbolicLink() || (!s.isDirectory() && !s.isFile())) return null
      const dir = s.isDirectory()
      return { name, dir, kind: dir ? 'folder' : kindOfEntry(name).kind, changed: Math.round(s.mtimeMs), ...(dir ? {} : { size: s.size, local: bytesHere(s) }), stated: true }
    } catch {
      return null
    }
  }

  /** What was kept of a folder is dropped: the next ask reads it again. */
  forget(dir?: string): void {
    if (dir === undefined) this.kept.clear()
    else this.kept.delete(dir)
  }

  /**
   * Watches a folder a tab shows and calls `changed` (once per burst) when a name in it is added, removed or
   * renamed, dropping what was kept of it. A folder nobody listed for `idleMs` stops being watched, and at most
   * `most` are watched at once. Where the disk gives no watch (some cloud folders), nothing is said: the window
   * lists again when it comes back.
   */
  watch(dir: string, changed: () => void, o: { idleMs?: number; most?: number; settleMs?: number } = {}): void {
    const now = this.now()
    const was = this.watched.get(dir)
    if (was) return void (was.seenAt = now)
    for (const [key, w] of this.watched) {
      if (now - w.seenAt > (o.idleMs ?? 10 * 60_000)) this.unwatch(key)
    }
    if (this.watched.size >= (o.most ?? 64)) {
      const oldest = [...this.watched].sort((a, b) => a[1].seenAt - b[1].seenAt)[0]
      if (oldest) this.unwatch(oldest[0])
    }
    try {
      const entry = { watcher: null as unknown as FSWatcher, seenAt: now, timer: null as ReturnType<typeof setTimeout> | null }
      entry.watcher = watch(dir, { persistent: false }, () => {
        this.kept.delete(dir)
        if (entry.timer) return
        entry.timer = setTimeout(() => {
          entry.timer = null
          changed()
        }, o.settleMs ?? 200)
        entry.timer.unref?.()
      })
      entry.watcher.on('error', () => this.unwatch(dir))
      this.watched.set(dir, entry)
    } catch {
      // No watch on this disk.
    }
  }

  private unwatch(dir: string): void {
    const w = this.watched.get(dir)
    if (!w) return
    if (w.timer) clearTimeout(w.timer)
    try {
      w.watcher.close()
    } catch {
      // Already closed.
    }
    this.watched.delete(dir)
  }

  /** Stops every watch and drops everything kept. */
  close(): void {
    for (const dir of [...this.watched.keys()]) this.unwatch(dir)
    this.kept.clear()
  }
}

/** A row as the wire's entry, for a file or folder at `path` on `host`; the caller adds what its place knows (the key, the cloud mark). */
export function entryOfRow(row: DiskRow, host: string, path: string, key: string): FileEntry {
  const here = { at: 'file' as const, host, path }
  return {
    key,
    ref: row.dir ? null : here,
    folder: row.dir ? here : null,
    name: row.name,
    kind: row.kind,
    ...(row.size !== undefined ? { size: row.size } : {}),
    ...(row.changed !== undefined ? { changed: row.changed } : {}),
    ...(row.local !== undefined ? { local: row.local } : {}),
    ...(row.local === false ? { state: { is: 'cloud' as const } } : {})
  }
}
