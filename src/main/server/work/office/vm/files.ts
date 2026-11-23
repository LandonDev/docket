import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import {
  teamsAppOf,
  teamsExtsOf,
  teamsKindOf,
  teamsKnownExts,
  type OfficeApp,
  type TeamsEntry,
  type TeamsFileKind,
  type TeamsLibrary,
  type TeamsPlace,
  type VmOfficeStatus,
  type VmSyncLibrary
} from '@shared/contract-work-office'
import { BYTES_MAX, FETCH_MS, libraryId, noText, readText, SEARCH_MAX, splitLibraryName, TEXT_MAX } from '../files/library'
import { vmCall, VmAsleep } from './link'

/**
 * Teams files in the Windows VM this host keeps (docs/agents/work-files.md "The Windows VM"):
 * Microsoft's own OneDrive in the guest, signed in as him, files on demand, read through the helper
 * that runs as tcuser (link.ts). A library there is a library of this host with `vm: true` and the
 * guest's path; every `work.office.files*` verb takes it as it takes a folder of the host's own disk.
 *
 * What OneDrive syncs there is read while the machine is awake and kept (`vm:status`), so the list
 * shows without waking it; a folder, a search, a read or an open wakes it.
 */

interface GuestMount {
  path: string
  type: 'mine' | 'team'
  web: string | null
}
interface GuestStatus {
  onedrive: { installed: boolean; running: boolean; account: string | null }
  mounts: GuestMount[]
  office: { installed: boolean; version: string | null; apps: OfficeApp[]; account: string | null; licensed: boolean | null }
}
interface GuestEntry {
  name: string
  path: string
  dir: boolean
  size: number
  modified: number
  local: boolean
  link: boolean
  root?: string
}
/** What the guest said the last time it was read, and each team mount's top folders. */
interface Stored {
  at: number
  status: GuestStatus
  tops: Record<string, string[]>
}

const getValue = (db: DatabaseSync, key: string): string | null => (db.prepare('SELECT value FROM work_office_files WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? null
const setValue = (db: DatabaseSync, key: string, value: string): void => void db.prepare('INSERT OR REPLACE INTO work_office_files (key, value) VALUES (?, ?)').run(key, value)

export function storedStatus(db: DatabaseSync): Stored | null {
  try {
    const v = JSON.parse(getValue(db, 'vm:status') ?? 'null') as Stored | null
    return v && typeof v.at === 'number' && Array.isArray(v.status?.mounts) ? v : null
  } catch {
    return null
  }
}

export function wantedLibraries(db: DatabaseSync): VmSyncLibrary[] {
  try {
    const v = JSON.parse(getValue(db, 'vm:wanted') ?? '[]') as VmSyncLibrary[]
    return Array.isArray(v) ? v : []
  } catch {
    return []
  }
}
export const setWantedLibraries = (db: DatabaseSync, libraries: readonly VmSyncLibrary[]): void => setValue(db, 'vm:wanted', JSON.stringify(libraries))

const hidden = (name: string): boolean => name.startsWith('.') || name.startsWith('~$') || name === 'desktop.ini' || name.endsWith('.tmp')
const baseOf = (path: string): string => path.slice(path.lastIndexOf('\\') + 1)

/** A guest path: a drive, backslashes, no step up or sideways. The one spelling a VM library's files are named by. */
export const isGuestPath = (path: string): boolean => /^[A-Za-z]:\\/.test(path)
const plain = (path: string): boolean =>
  isGuestPath(path) &&
  !path.includes('/') &&
  path
    .slice(3)
    .split('\\')
    .every((part, i, all) => (part === '' ? i === all.length - 1 : part !== '.' && part !== '..' && !/[. ]$/.test(part)))

/** Whether `path` is `dir` or under it, as NTFS reads names: case-blind. */
export const guestWithin = (path: string, dir: string): boolean => {
  const p = path.replace(/\\+$/, '').toLowerCase()
  const d = dir.replace(/\\+$/, '').toLowerCase()
  return p === d || p.startsWith(`${d}\\`)
}

/** The folder OneDrive names a tenant by: `OneDrive - <Tenant>` is his own files, `<Tenant>\<Site> - <Library>` a library. */
const tenantOf = (m: GuestMount): string | null => {
  const parts = m.path.split('\\')
  if (m.type === 'mine') return /^OneDrive - (.+)$/.exec(parts[parts.length - 1] ?? '')?.[1] ?? null
  return parts.length >= 2 ? parts[parts.length - 2]! : null
}

const TEAM_LIBRARIES = /^(shared )?documents$/i

/** The VM's libraries as this host lists them, from what was last read. */
export function vmLibraries(db: DatabaseSync, host: string): TeamsLibrary[] {
  const stored = storedStatus(db)
  if (!stored) return []
  return stored.status.mounts
    .map((m): TeamsLibrary => {
      const id = libraryId(host, `vm:${m.path.toLowerCase()}`)
      if (m.type === 'mine') return { id, host, path: m.path, team: 'My files', library: null, tenant: tenantOf(m), kind: 'mine', channels: [], web: m.web, found: true, vm: true }
      const { team, library } = splitLibraryName(baseOf(m.path))
      const tops = stored.tops[m.path] ?? []
      // A site's Documents: its top folders are the team's channels, or the folders he synced one by one on a Mac.
      const channels = library === null || TEAM_LIBRARIES.test(library)
      return { id, host, path: m.path, team, library: channels ? null : library, tenant: tenantOf(m), kind: channels ? 'channels' : 'library', channels: channels ? tops : [], web: m.web, found: true, vm: true }
    })
    .sort((a, b) => a.team.localeCompare(b.team) || (a.library ?? '').localeCompare(b.library ?? ''))
}

/** The VM library a guest path lies in, or null: the fence every VM file read and open passes on this side (the helper has its own). */
export function vmLibraryOf(libs: readonly TeamsLibrary[], path: string): { library: TeamsLibrary; path: string } | null {
  if (!plain(path)) return null
  const at = path.replace(/\\+$/, '')
  const library = libs.find((l) => l.vm && guestWithin(at, l.path))
  return library ? { library, path: at } : null
}

export function entryOfGuest(library: string, e: GuestEntry): TeamsEntry {
  return { name: e.name, path: e.path, library, kind: e.dir ? 'folder' : teamsKindOf(e.name), size: e.dir ? 0 : e.size, modified: e.modified, local: e.local, by: null }
}

const shownEntries = (library: string, entries: readonly GuestEntry[]): TeamsEntry[] =>
  entries
    .filter((e) => !hidden(e.name) && !e.link)
    .map((e) => entryOfGuest(library, e))
    .sort((a, b) => Number(b.kind === 'folder') - Number(a.kind === 'folder') || a.name.localeCompare(b.name))

/**
 * Reads what OneDrive and Office are in the guest and keeps it. `wake: false` reads only an awake
 * machine (null while it sleeps). Then, signed in and lacking a wanted library, asks OneDrive to sync it.
 */
export async function refreshVm(db: DatabaseSync, opts: { wake?: boolean; signal?: AbortSignal; now?: () => number } = {}): Promise<Stored | null> {
  let status: GuestStatus
  try {
    status = (await vmCall('guest.status', {}, { wake: opts.wake ?? false, timeoutMs: 30_000, signal: opts.signal })) as GuestStatus
  } catch (err) {
    if (err instanceof VmAsleep) return null
    throw err
  }
  const tops: Record<string, string[]> = {}
  for (const m of status.mounts) {
    if (m.type !== 'team') continue
    try {
      const entries = (await vmCall('files.list', { dir: m.path }, { wake: false, timeoutMs: 30_000, signal: opts.signal })) as GuestEntry[]
      tops[m.path] = entries.filter((e) => e.dir && !e.link && !hidden(e.name)).map((e) => e.name).sort((a, b) => a.localeCompare(b))
    } catch {
      tops[m.path] = storedStatus(db)?.tops[m.path] ?? []
    }
  }
  const stored: Stored = { at: (opts.now ?? Date.now)(), status, tops }
  setValue(db, 'vm:status', JSON.stringify(stored))
  await syncWanted(db, stored, opts.signal).catch(() => undefined)
  return stored
}

/** The folder name OneDrive gives a library under Windows: `<Site> - <Library>`. */
const folderNameOf = (l: VmSyncLibrary): string => `${l.webTitle} - ${l.listTitle}`.toLowerCase()

/** The wanted libraries OneDrive in the guest does not hold yet; empty while it is signed out. */
export function missingLibraries(db: DatabaseSync, stored: Stored | null = storedStatus(db)): VmSyncLibrary[] {
  if (!stored?.status.onedrive.account) return []
  const have = new Set(stored.status.mounts.filter((m) => m.type === 'team').map((m) => baseOf(m.path).toLowerCase()))
  const webs = new Set(stored.status.mounts.map((m) => (m.web ?? '').toLowerCase().replace(/\/+$/, '')).filter(Boolean))
  return wantedLibraries(db).filter((l) => !have.has(folderNameOf(l)) && ![...webs].some((w) => w.startsWith(l.webUrl.toLowerCase().replace(/\/+$/, '')) && w.endsWith(l.listTitle.toLowerCase())))
}

/** When each library was last asked of OneDrive: asked again only after ten minutes, since a first sync takes a while to show its folder. */
const asked = new Map<string, number>()
const ASK_AGAIN_MS = 10 * 60_000
/** Forgets when each library was asked: OneDrive ignores a sync link while its tutorial is open, so the end of that tutorial asks again. */
export const resetSyncAsks = (): void => asked.clear()

/** Asks OneDrive in the guest to sync each wanted library it lacks, as that library's own Sync button would. */
async function syncWanted(db: DatabaseSync, stored: Stored, signal?: AbortSignal, now = Date.now()): Promise<number> {
  const email = stored.status.onedrive.account
  if (!email) return 0
  let n = 0
  for (const l of missingLibraries(db, stored)) {
    if (now - (asked.get(l.listId) ?? 0) < ASK_AGAIN_MS) continue
    asked.set(l.listId, now)
    await vmCall('onedrive.sync', { ...l, email }, { wake: false, timeoutMs: 30_000, signal })
    n++
  }
  return n
}

/** A test starts with nothing asked. */
export const forgetAsked = (): void => asked.clear()

/** What stands between the VM and his Teams files. `vm`: the keeper's state name, or null where this host keeps no VM. */
export function vmPlace(db: DatabaseSync, vm: { state: string; cannot: string | null } | null): TeamsPlace | null {
  if (!vm || vm.cannot) return null
  if (vm.state === 'none' || vm.state === 'setting-up') return { kind: 'vm', state: 'not-set-up', account: null }
  const stored = storedStatus(db)
  if (!stored) return { kind: 'vm', state: 'error', account: null, detail: 'OneDrive in the Windows VM has not been read yet.' }
  const od = stored.status.onedrive
  if (!od.installed) return { kind: 'vm', state: 'no-onedrive', account: null }
  // Signed out is signed out, whatever folders an earlier sign-in left listed: nothing in them is kept in step.
  if (!od.account) return { kind: 'vm', state: 'signed-out', account: null }
  return { kind: 'vm', state: stored.status.mounts.some((m) => m.type === 'team') ? 'ok' : 'no-libraries', account: od.account }
}

export function vmOfficeStatus(db: DatabaseSync, vm: { state: string; cannot: string | null } | null): VmOfficeStatus {
  const stored = storedStatus(db)
  return { office: stored ? stored.status.office : null, onedrive: vmPlace(db, vm) ?? { kind: 'vm', state: 'not-set-up', account: null }, at: stored?.at ?? null }
}

export async function vmList(library: TeamsLibrary, dir: string, signal?: AbortSignal): Promise<TeamsEntry[]> {
  return shownEntries(library.id, (await vmCall('files.list', { dir }, { signal })) as GuestEntry[])
}

export async function vmStat(library: string, path: string, signal?: AbortSignal): Promise<TeamsEntry> {
  return entryOfGuest(library, (await vmCall('files.stat', { path }, { signal })) as GuestEntry)
}

/** Names holding every word, newest first: the guest walks its own disk (names only, nothing downloads). */
export async function vmSearch(libs: readonly TeamsLibrary[], query: string, kind?: TeamsFileKind, signal?: AbortSignal): Promise<{ entries: TeamsEntry[]; more: boolean }> {
  if (!libs.length) return { entries: [], more: false }
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  const filter = !kind ? { only: 'any' } : kind === 'folder' ? { only: 'folder' } : kind === 'other' ? { only: 'other', exts: teamsKnownExts() } : { only: 'exts', exts: teamsExtsOf(kind) }
  const got = (await vmCall('files.search', { roots: libs.map((l) => l.path), words, ...filter, maxDirs: 20_000, maxHits: 1_000, ms: 15_000 }, { timeoutMs: 60_000, signal })) as { hits: GuestEntry[]; more: boolean }
  const hits = got.hits
    .filter((e) => !hidden(e.name) && !e.link)
    .map((e) => entryOfGuest(libs.find((l) => l.path.toLowerCase() === (e.root ?? '').toLowerCase())?.id ?? '', e))
    .filter((e) => e.library)
    .sort((a, b) => b.modified - a.modified)
  return { entries: hits.slice(0, SEARCH_MAX), more: got.more || hits.length > SEARCH_MAX }
}

/** Downloads a file OneDrive keeps in the cloud (the helper reads it to its end as tcuser); answers it as it is now. */
export async function vmFetch(library: string, path: string, signal?: AbortSignal): Promise<TeamsEntry> {
  return entryOfGuest(library, (await vmCall('files.fetch', { path }, { timeoutMs: FETCH_MS, signal })) as GuestEntry)
}

const CHUNK = 4 * 1024 * 1024

/** A file's bytes, read through the helper in pieces; refused past `max` before anything downloads. */
export async function vmBytes(path: string, max = BYTES_MAX, signal?: AbortSignal): Promise<Buffer> {
  const entry = (await vmCall('files.stat', { path }, { signal })) as GuestEntry
  if (entry.dir) throw new Error('That is a folder.')
  if (entry.size > max) throw new Error(`${entry.name} is over ${Math.round(max / 1024 / 1024)} MB: open it in its app.`)
  const parts: Buffer[] = []
  let offset = 0
  for (;;) {
    const got = (await vmCall('files.read', { path, offset, length: CHUNK }, { timeoutMs: FETCH_MS, signal })) as { data: string; size: number; eof: boolean }
    const buf = Buffer.from(got.data, 'base64')
    parts.push(buf)
    offset += buf.length
    if (got.eof || !buf.length) break
    if (offset > max) throw new Error(`${entry.name} grew past ${Math.round(max / 1024 / 1024)} MB while it was read.`)
  }
  return Buffer.concat(parts)
}

/** Sends a file OneDrive downloaded only for this read back to the cloud, so the VM's disk does not fill; one he keeps on the device stays. */
const freeAfter = (path: string, wasLocal: boolean): void => {
  if (!wasLocal) void vmCall('files.free', { path }, { wake: false, timeoutMs: 30_000 }).catch(() => undefined)
}

/** A file's text, as `readText` gives it for a file of this host: read through the helper, a Word file or deck by way of a copy that is deleted at once. */
export async function vmText(path: string, signal?: AbortSignal): Promise<{ text: string; truncated: boolean }> {
  const name = baseOf(path)
  const kind = teamsKindOf(name)
  const before = (await vmCall('files.stat', { path }, { signal })) as GuestEntry
  if (before.dir) throw new Error('That is a folder.')
  try {
    if (kind === 'text' || /\.csv$/i.test(name)) {
      const got = (await vmCall('files.read', { path, offset: 0, length: TEXT_MAX * 4 }, { timeoutMs: FETCH_MS, signal })) as { data: string; size: number; eof: boolean }
      const text = Buffer.from(got.data, 'base64').toString('utf8').replace(/^﻿/, '')
      return { text: text.slice(0, TEXT_MAX), truncated: text.length > TEXT_MAX || !got.eof }
    }
    if (/\.(docx|docm|pptx|pptm)$/i.test(name)) {
      const dir = mkdtempSync(join(tmpdir(), 'tc-teams-'))
      try {
        const copy = join(dir, name.replace(/[\\/]/g, '_'))
        writeFileSync(copy, await vmBytes(path, BYTES_MAX, signal), { mode: 0o600 })
        return await readText(copy)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }
    // The same refusals a file of this host gets, in the same words.
    throw noText(name)
  } finally {
    freeAfter(path, before.local)
  }
}

/** Opens a file in its app on the VM's desktop: an Office file through the VM's carrier (given by the caller), anything else by Windows' own opener. */
export async function vmOpen(path: string, openOffice: ((app: 'excel' | 'word' | 'powerpoint', path: string) => Promise<void>) | null, signal?: AbortSignal): Promise<void> {
  const name = baseOf(path)
  const app = teamsAppOf(teamsKindOf(name), name)
  if (app && openOffice) return openOffice(app, path)
  await vmCall('files.open', { path }, { signal })
}
