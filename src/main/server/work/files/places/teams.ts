import type { FileCrumb } from '@shared/contract-work-files'
import type { TeamsEntry, TeamsLibrary, TeamsPlace } from '@shared/contract-work-office'
import { compareEntries, DEFAULT_SORT, kindOfEntry, refKey, type FileEntry, type FileSort, type PlaceState } from '@shared/work/files'
import { placesIn, type LibraryPlace } from '@shared/work/filePlaces'
import type { Caller, WorkCtx } from '../../modules'
import { foldersPlace } from '../../office/files/library'
import { guestWithin, lastReadFailure, readVmBehind, storedStatus, vmList, vmPlace, vmVerbs } from '../../office/vm/files'
import { VmAsleep } from '../../office/vm/link'
import { vmState } from '../../office/vm/office'
import { vmFor } from '../policy'
import { cutPage, entryOfRow, type DiskPage, type DiskRow } from './disk'
import { librariesHere, vmLibrariesHere } from './libraries'
import { forgetAllKept, forgetKept, keptKey, keptList, readList, VM_LIST_FRESH_MS, wakingFor, type KeptList } from './vmKept'

/**
 * Teams and OneDrive as places (docs/agents/work-files.md "Each place"), over the office pillar's own finding
 * of what OneDrive syncs on this host and in the Windows VM it keeps. A place is one thing he would name: a
 * team's channel, a site's library, his own OneDrive, a folder he added. One library of a team's Documents is
 * therefore several places, one per channel. Everyone in the team can open what is in a library, so every
 * place here is shared.
 */

export { LIBRARY_CAN, placesIn, type LibraryPlace } from '@shared/work/filePlaces'

const sepOf = (path: string): string => (path.includes('\\') && !path.includes('/') ? '\\' : '/')
const joinIn = (dir: string, name: string): string => `${dir.replace(/[\\/]+$/, '')}${sepOf(dir)}${name}`

const VM_FRESH_MS = 15_000

/** The state every place in the VM shares: asleep with the list kept from before, being read, or as the office pillar's own place says. */
function vmStateOf(ctx: Pick<WorkCtx, 'db'>): PlaceState {
  const state = vmState()
  const stored = storedStatus(ctx.db)
  const place = vmPlace(ctx.db, state)
  if (!place) return { state: 'not-set-up' }
  if (place.state === 'ok' || place.state === 'no-libraries') return state?.state === 'awake' ? { state: 'ok', ...(stored ? { at: stored.at } : {}) } : { state: 'asleep', ...(stored ? { at: stored.at } : {}) }
  return { state: place.state, ...(place.detail ? { detail: place.detail } : {}), ...(stored ? { at: stored.at } : {}) }
}

export interface TeamsPlaces {
  places: LibraryPlace[]
  /** what stands between each source of Teams files and him: OneDrive's folders on this host, OneDrive in its VM (the office pillar's own `TeamsPlace`) */
  sources: TeamsPlace[]
}

/**
 * This host's Teams and OneDrive places for a caller, at once: the VM's are what was kept, and it is read
 * behind the answer when what was kept is stale (a change is pushed). Nothing here waits on a VM.
 */
export function teamsPlaces(ctx: Pick<WorkCtx, 'db' | 'host' | 'log' | 'push' | 'scopeOf' | 'settings'>, by: Caller): TeamsPlaces {
  const own = librariesHere(ctx)
  // A folder on a drive that is not there now (the VPN down) is listed as not reachable, as a host out of reach is.
  const places = own.flatMap((l) => placesIn(l, l.away ? { state: 'unreachable' } : { state: 'ok' }))
  const folders = foldersPlace(ctx.host)
  const sources: TeamsPlace[] = folders ? [own.some((l) => l.kind !== 'mine') && folders.state !== 'ok' ? { ...folders, state: 'ok' } : folders] : []
  if (vmFor(ctx, by)) {
    const state = vmState()
    const source = vmPlace(ctx.db, state)
    if (source) sources.push(source)
    if (state && !state.cannot && state.state !== 'none' && state.state !== 'setting-up') {
      const stored = storedStatus(ctx.db)
      const stale = !!stored && state.state === 'awake' && (lastReadFailure(ctx.db) !== null || Date.now() - stored.at > VM_FRESH_MS)
      // A read behind the answer: one never read is woken for its first, an awake one whose list is old is read again.
      if (!stored || stale) void readVmBehind(ctx, { wake: !stored })
      const vm = vmStateOf(ctx)
      const verbs = vmVerbs(ctx.db)
      places.push(...vmLibrariesHere(ctx).flatMap((l) => placesIn(l, vm, verbs)))
    }
  }
  return { places, sources }
}

/** The place a located library path lies in: the one whose top holds it (a file at a team library's own top, outside every channel, is in none). */
export function placeOfPath(places: readonly LibraryPlace[], library: TeamsLibrary, path: string): LibraryPlace | null {
  const inside = (top: string): boolean => (library.vm ? guestWithin(path, top) : path === top || path.startsWith(`${top.replace(/[\\/]+$/, '')}${sepOf(top)}`))
  return places.filter((p) => p.library.id === library.id && inside(p.top)).sort((a, b) => b.top.length - a.top.length)[0] ?? null
}

/** A file's or folder's key in a library place: the place and the path inside it, whichever computer answers. */
export const libraryKey = (at: LibraryPlace, path: string): string => refKey({ at: 'file', host: at.library.host, path }, { key: at.place.key ?? at.place.id, path: at.top })

/** A row of a library folder as the wire's entry. An Office file in place names its app, so opening it stands the real Excel, Word or PowerPoint behind the canvas. */
export function libraryEntry(at: LibraryPlace, dir: string, row: DiskRow): FileEntry {
  const path = joinIn(dir, row.name)
  return { ...entryOfRow(row, at.library.host, path, libraryKey(at, path)), shared: true }
}

/** The trail to a folder of a library place: the place, then each folder below its top. */
export function libraryTrail(at: LibraryPlace, path: string): FileCrumb[] {
  const parts = path.slice(at.top.length).split(/[\\/]/).filter(Boolean)
  let dir = at.top
  return [{ name: at.place.name, at: at.place.root }, ...parts.map((name) => ({ name, at: { at: 'file' as const, host: at.library.host, path: (dir = joinIn(dir, name)) } }))]
}

export const rowOfGuest = (e: TeamsEntry): DiskRow => ({ name: e.name, dir: e.kind === 'folder', kind: e.kind === 'folder' ? 'folder' : kindOfEntry(e.name).kind, changed: e.modified, ...(e.kind === 'folder' ? {} : { size: e.size, local: e.local }), stated: true })

/** One page of a VM folder, and what stands in for the guest's answer when it sleeps: when the rows kept were read, and whether it is waking. */
export interface VmPage extends DiskPage {
  /** the rows are what was kept from this time (the machine sleeps) */
  asOf?: number
  /** the machine sleeps: `waking` while a wake for this folder (or any) goes on, its rows pushed once they land */
  sleeping?: 'asleep' | 'waking'
}

/** The windows to tell when a folder's woken read lands: workspace and the folder's key, one push each however many asked. */
const owed = new Map<string, Map<string, string>>()

const raced = <T>(p: Promise<T>, signal?: AbortSignal): Promise<T> =>
  !signal
    ? p
    : signal.aborted
      ? Promise.reject(new Error('cancelled'))
      : new Promise<T>((resolve, reject) => {
          const off = (): void => reject(new Error('cancelled'))
          signal.addEventListener('abort', off, { once: true })
          p.then(resolve, reject).finally(() => signal.removeEventListener('abort', off))
        })

const guestRows = (library: TeamsLibrary, dir: string, wake: boolean) => async (): Promise<DiskRow[]> => (await vmList(library, dir, undefined, wake)).map(rowOfGuest)

/** His press on a sleeping VM: the folder is read with a wake behind the answer already given, and each window that asked hears `work.files` once it lands. */
function wakeBehind(ctx: Pick<WorkCtx, 'log' | 'push'>, key: string, library: TeamsLibrary, dir: string, tell?: { workspaceId: string; at: string }): void {
  const first = !wakingFor(key)
  if (tell) {
    const to = owed.get(key) ?? new Map<string, string>()
    to.set(tell.workspaceId, tell.at)
    owed.set(key, to)
  }
  const read = readList(key, { library: library.id, dir }, true, guestRows(library, dir, true))
  if (!first) return
  void read
    .then(
      () => true,
      (err) => {
        ctx.log(`files: the Windows VM did not wake for a folder: ${err instanceof Error ? err.message : String(err)}`)
        return false
      }
    )
    .then((woke) => {
      const to = owed.get(key)
      owed.delete(key)
      try {
        // A woken read or a failed one: either way the folder is asked again, and says what is true now.
        for (const [workspaceId, at] of to ?? []) ctx.push({ push: 'work.files', workspaceId, at }, { need: 'read' })
        // Awake now: the places say so.
        if (woke) ctx.push({ push: 'work.office.files' }, { need: 'read' })
      } catch (err) {
        ctx.log(`files: a woken folder's push failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    })
}

/**
 * One page of a folder in the Windows VM (docs/agents/work-teams-files.md "A folder in the VM"). Awake, the guest is
 * asked, one call however many lists of the folder come at once. Asleep, the answer is at once: the rows kept from
 * before (`asOf`), else none, with the machine's state; `wake` (his press) wakes it behind that answer and `tell`
 * names the window's folder for the push when the rows land. Without `wake` nothing is asked of a sleeping machine.
 * The caller has located the folder for its caller (the fence) before this is asked.
 */
export async function vmPage(
  ctx: Pick<WorkCtx, 'log' | 'push'>,
  library: TeamsLibrary,
  dir: string,
  o: { sort?: FileSort; cursor?: string; foldersOnly?: boolean; signal?: AbortSignal; now?: number; wake?: boolean; tell?: { workspaceId: string; at: string } } = {}
): Promise<VmPage> {
  const now = o.now ?? Date.now()
  const key = keptKey(library.id, dir)
  const sort = o.sort ?? DEFAULT_SORT
  const pageOf = (list: KeptList): DiskPage => {
    const rows = [...(o.foldersOnly ? list.rows.filter((r) => r.dir) : list.rows)].sort((a, b) => compareEntries(a, b, sort))
    return cutPage(rows, { tag: key, version: list.version, sort, cursor: o.cursor })
  }
  const kept = keptList(key, now)
  if (kept && now - kept.at <= VM_LIST_FRESH_MS) return pageOf(kept)
  if (vmState()?.state === 'awake') {
    try {
      return pageOf(await raced(readList(key, { library: library.id, dir }, false, guestRows(library, dir, false)), o.signal))
    } catch (err) {
      // It went to sleep since: answered as a sleeping machine is.
      if (!(err instanceof VmAsleep)) throw err
    }
  }
  if (o.wake) wakeBehind(ctx, key, library, dir, o.tell)
  const sleeping = wakingFor(key) || vmState()?.state === 'waking' ? 'waking' : 'asleep'
  const still = keptList(key, now)
  return still ? { ...pageOf(still), asOf: still.at, sleeping } : { rows: [], sleeping }
}

/** Whether a VM folder as last listed holds a file of this name (no guest call: false when it was not listed). */
export function vmHas(library: TeamsLibrary, dir: string, name: string, now = Date.now()): boolean {
  const low = name.toLowerCase()
  return !!keptList(keptKey(library.id, dir), now)?.rows.some((r) => !r.dir && r.name.toLowerCase() === low)
}

/** A test starts with nothing kept; Work off drops it all. */
export const forgetVmLists = (): void => {
  forgetAllKept()
  owed.clear()
}
/** A folder in the VM that changed: the next page of it asks the guest again. */
export const forgetVmList = (libraryId: string, dir: string): void => forgetKept(keptKey(libraryId, dir))
