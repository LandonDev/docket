import type { FileCrumb } from '@shared/contract-work-files'
import type { TeamsEntry, TeamsLibrary, TeamsPlace } from '@shared/contract-work-office'
import { compareEntries, DEFAULT_SORT, kindOfEntry, placeKey, refKey, type FileEntry, type FilePlace, type FileSort, type PlaceState } from '@shared/work/files'
import type { Caller, WorkCtx } from '../../modules'
import { foldersPlace } from '../../office/files/library'
import { guestWithin, lastReadFailure, readVmBehind, storedStatus, vmList, vmPlace } from '../../office/vm/files'
import { vmState } from '../../office/vm/office'
import { vmFor } from '../policy'
import { cutPage, entryOfRow, type DiskPage, type DiskRow } from './disk'
import { librariesHere, vmLibrariesHere } from './libraries'

/**
 * Teams and OneDrive as places (docs/agents/work-files.md "Each place"), over the office pillar's own finding
 * of what OneDrive syncs on this host and in the Windows VM it keeps. A place is one thing he would name: a
 * team's channel, a site's library, his own OneDrive, a folder he added. One library of a team's Documents is
 * therefore several places, one per channel. Everyone in the team can open what is in a library, so every
 * place here is shared.
 */

/** A place and where it lies: the library and the folder in it that is the place's top. */
export interface LibraryPlace {
  place: FilePlace
  library: TeamsLibrary
  top: string
}

const sepOf = (path: string): string => (path.includes('\\') && !path.includes('/') ? '\\' : '/')
const joinIn = (dir: string, name: string): string => `${dir.replace(/[\\/]+$/, '')}${sepOf(dir)}${name}`

/** The verbs a library's adapter carries out today: none until F2, and none in the Windows VM until F8. */
export const LIBRARY_CAN: FilePlace['can'] = []

/** The places one library holds: a team's channels, else the library as one place. */
export function placesIn(library: TeamsLibrary, state: PlaceState): LibraryPlace[] {
  const base = { host: library.vm ? 'Windows VM' : '', env: library.host, shared: true, can: [...LIBRARY_CAN], state, web: library.web, ...(library.vm ? { vm: true } : {}) }
  const one = (id: string, kind: FilePlace['kind'], name: string, top: string, key: string, group?: string): LibraryPlace => ({
    place: { ...base, id, kind, name, root: { at: 'file', host: library.host, path: top }, key, ...(group ? { group } : {}) },
    library,
    top
  })
  if (library.kind === 'mine') return [one(library.id, 'onedrive', 'My OneDrive', library.path, 'mine')]
  if (library.kind === 'folder') return [one(library.id, 'teams', library.library ? `${library.team} ${library.library}` : library.team, library.path, `folder:${library.id}`)]
  if (library.kind === 'channels' && library.channels.length) return library.channels.map((channel) => one(`${library.id}/${channel}`, 'teams', channel, joinIn(library.path, channel), placeKey(library.team, channel), library.team))
  // A team's Documents is named so; a library OneDrive named only as one word (its newer layout on a Mac) keeps that name.
  return [one(library.id, 'teams', library.library ?? (library.kind === 'channels' ? 'Documents' : library.team), library.path, placeKey(library.team, library.library ?? ''), library.team)]
}

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
  const places = own.flatMap((l) => placesIn(l, { state: 'ok' }))
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
      places.push(...vmLibrariesHere(ctx).flatMap((l) => placesIn(l, vm)))
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

const rowOfGuest = (e: TeamsEntry): DiskRow => ({ name: e.name, dir: e.kind === 'folder', kind: e.kind === 'folder' ? 'folder' : kindOfEntry(e.name).kind, changed: e.modified, ...(e.kind === 'folder' ? {} : { size: e.size, local: e.local }), stated: true })

/** A folder in the VM is listed whole by the guest's helper; what it said is kept a few seconds and cut into pages here. */
const vmKept = new Map<string, { at: number; version: string; rows: DiskRow[] }>()
const VM_LIST_FRESH_MS = 5_000

/** One page of a folder in the Windows VM. It wakes the VM, as opening a folder there always has. */
export async function vmPage(library: TeamsLibrary, dir: string, o: { sort?: FileSort; cursor?: string; foldersOnly?: boolean; signal?: AbortSignal; now?: number } = {}): Promise<DiskPage> {
  const now = o.now ?? Date.now()
  const key = `${library.id}\u0000${dir.toLowerCase()}`
  let kept = vmKept.get(key)
  if (!kept || now - kept.at > VM_LIST_FRESH_MS) {
    const rows = (await vmList(library, dir, o.signal)).map(rowOfGuest)
    // The guest gives no change time for the folder itself: its names and their times stand in for a version.
    kept = { at: now, version: `${rows.length}:${rows.reduce((n, r) => (n + (r.changed ?? 0)) % 2_147_483_647, 0)}`, rows }
    vmKept.set(key, kept)
    if (vmKept.size > 32) vmKept.delete(vmKept.keys().next().value!)
  }
  const sort = o.sort ?? DEFAULT_SORT
  const rows = [...(o.foldersOnly ? kept.rows.filter((r) => r.dir) : kept.rows)].sort((a, b) => compareEntries(a, b, sort))
  return cutPage(rows, { tag: key, version: kept.version, sort, cursor: o.cursor })
}

/** A test starts with nothing kept. */
export const forgetVmLists = (): void => vmKept.clear()
