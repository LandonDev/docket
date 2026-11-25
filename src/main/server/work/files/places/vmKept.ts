import type { DiskRow } from './disk'

/**
 * What the box keeps of the Windows VM's folder lists (docs/agents/work-teams-files.md "A folder in the VM"): the
 * rows the guest last answered for each folder, so a list answers at once while the machine sleeps or wakes. Names,
 * sizes and times only (no byte of any file), in memory alone, for `VM_LIST_KEEP_MS` and `VM_LIST_KEEP_MOST` folders,
 * dropped by a change through Files, a library OneDrive no longer syncs, and Work turned off. Who may see them is the
 * fence's to say on every call (`locate`, before a kept row is served); nothing here names a caller.
 */

/** How long kept rows are served at all: past it a sleeping folder says its state alone. */
export const VM_LIST_KEEP_MS = 2 * 60_000
/** The most folders kept; the one used longest ago goes first. */
export const VM_LIST_KEEP_MOST = 64
/** Kept rows this young are the answer, the guest not asked again (the pages of one scroll, a push's refetch). */
export const VM_LIST_FRESH_MS = 5_000

export interface KeptList {
  /** when the guest answered them */
  at: number
  version: string
  rows: DiskRow[]
}

const kept = new Map<string, KeptList & { library: string; dir: string }>()
/** A folder's read under way: every list of it joins the one guest call. `wakes`: it may wake the machine. */
const reading = new Map<string, { read: Promise<KeptList>; wakes: boolean; dir: string }>()
/**
 * Moves each time a folder's rows are dropped (and `epoch` when all are): a read begun before the drop answers its own
 * callers, but keeps nothing, and no list after the drop joins it.
 */
const drops = new Map<string, number>()
let epoch = 0
const stampOf = (key: string): string => `${epoch}:${drops.get(key) ?? 0}`
function drop(key: string): void {
  drops.set(key, (drops.get(key) ?? 0) + 1)
  kept.delete(key)
  reading.delete(key)
}

export const keptKey = (libraryId: string, dir: string): string => `${libraryId}\u0000${dir.replace(/\\+$/, '').toLowerCase()}`

/** The rows kept for a folder within their life, else null (and older ones are dropped). */
export function keptList(key: string, now: number): KeptList | null {
  const got = kept.get(key)
  if (!got) return null
  if (now - got.at > VM_LIST_KEEP_MS) {
    kept.delete(key)
    return null
  }
  // Used now: it goes to the end of the line.
  kept.delete(key)
  kept.set(key, got)
  return got
}

function keep(key: string, library: string, dir: string, list: KeptList): void {
  kept.delete(key)
  kept.set(key, { ...list, rows: list.rows.map(bare), library, dir })
  while (kept.size > VM_LIST_KEEP_MOST) kept.delete(kept.keys().next().value!)
}

/** A row as kept: what a listing says of it, and nothing it was read with. */
const bare = (r: DiskRow): DiskRow => ({ name: r.name, dir: r.dir, kind: r.kind, ...(r.changed !== undefined ? { changed: r.changed } : {}), ...(r.size !== undefined ? { size: r.size } : {}), ...(r.local !== undefined ? { local: r.local } : {}), ...(r.stated !== undefined ? { stated: r.stated } : {}) })

/**
 * The guest's rows for a folder, read once however many lists ask at the same time, and kept. A list that may not
 * wake the machine joins any read; one that may joins only a read that may too, else it reads again after it.
 */
export function readList(key: string, at: { library: string; dir: string }, wake: boolean, read: () => Promise<DiskRow[]>, now: () => number = Date.now): Promise<KeptList> {
  const under = reading.get(key)
  if (under && (under.wakes || !wake)) return under.read
  const stamp = stampOf(key)
  const go = (async () => {
    if (under) await under.read.catch(() => undefined)
    const rows = await read()
    // The guest gives no change time for the folder itself: its names and their times stand in for a version.
    const list: KeptList = { at: now(), version: `${rows.length}:${rows.reduce((n, r) => (n + (r.changed ?? 0)) % 2_147_483_647, 0)}`, rows }
    // Only a read begun since the folder was last dropped fills it: one from before brings back no rows a change took.
    if (stampOf(key) === stamp) keep(key, at.library, at.dir, list)
    return list
  })()
  const entry = { read: go, wakes: wake, dir: at.dir }
  reading.set(key, entry)
  void go.then(
    () => reading.get(key) === entry && reading.delete(key),
    () => reading.get(key) === entry && reading.delete(key)
  )
  return go
}

/** Whether a read of the folder that may wake the machine is under way. */
export const wakingFor = (key: string): boolean => reading.get(key)?.wakes === true

/** A folder that changed through Files: the next list asks the guest again, never joining a read from before. */
export const forgetKept = (key: string): void => drop(key)

/** The guest was read again: what was kept of a folder in a library OneDrive no longer syncs there goes, read or reading. */
export function keepOnlyWhere(still: (dir: string) => boolean): void {
  for (const [key, list] of [...kept]) if (!still(list.dir)) drop(key)
  for (const [key, read] of [...reading]) if (!still(read.dir)) drop(key)
}

/** Work off, or a test's start: nothing kept, no read joined, and no read under way keeps anything. */
export function forgetAllKept(): void {
  epoch++
  drops.clear()
  kept.clear()
  reading.clear()
}

/** How many folders are kept (tests). */
export const keptCount = (): number => kept.size
