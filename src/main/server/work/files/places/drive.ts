import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { FileCrumb, FilesListing } from '@shared/contract-work-files'
import { compareEntries, DEFAULT_SORT, kindOfEntry, refKey, type EntryKind, type FileEntry, type FilePlace, type FileSort, type FileVerb, type FolderRef } from '@shared/work/files'
import type { WorkCtx } from '../../modules'
import { DRIVE_ROOT, driveOf, type DriveItem } from '../../google/drive'
import { cutPage, type DiskRow } from './disk'

/**
 * A Google Drive as a place (docs/agents/work-files.md "Google Drive"): one place per Google account the
 * workspace has, read through the google pillar's `drive.file` tokens. So a place lists only what TempCode may
 * see, the files LifeOS's client made and the ones he picked (Add from Drive is the Picker). The place itself is
 * his own (`shared: false`); each entry says by its own sharing whether others can open it, and a folder others
 * can open makes what is in it shared too.
 */

/** The verbs a Drive place carries out: New, rename, move within it, and Drive's own bin with its Put back. */
export const DRIVE_CAN: FileVerb[] = ['make', 'rename', 'move', 'trash', 'restore']
/** What New offers in a Drive: Google's types and a folder. A text file is not offered. */
export const DRIVE_NEW = ['document', 'sheet', 'deck', 'folder'] as const

export const DRIVE_PREFIX = 'drive:'
export const drivePlaceId = (account: string): string => `${DRIVE_PREFIX}${account.toLowerCase()}`
/** The account a Drive place's id names, or null for any other place. */
export const accountOfPlace = (id: string): string | null => (id.startsWith(DRIVE_PREFIX) && id.length > DRIVE_PREFIX.length ? id.slice(DRIVE_PREFIX.length) : null)
export const driveTop = (account: string): FolderRef => ({ at: 'drive', account: account.toLowerCase(), folderId: DRIVE_ROOT })

export function drivePlace(env: string, account: string): FilePlace {
  return { id: drivePlaceId(account), kind: 'drive', name: account.toLowerCase(), host: '', env, shared: false, can: [...DRIVE_CAN], state: { state: 'ok' }, root: driveTop(account), web: 'https://drive.google.com/drive/my-drive', makes: [...DRIVE_NEW] }
}

// ── which accounts a workspace has ────────────────────────────────────

/** How long LifeOS's list of accounts answers before it is read again behind the answer. */
export const DRIVE_ACCOUNTS_FRESH_MS = 60_000
/** How long `places` waits for a first read of the accounts; past it the place is left out and the read lands later. */
export const DRIVE_ACCOUNTS_WAIT_MS = 1_500

interface AccountRow {
  account?: unknown
  sector?: unknown
  files?: unknown
}
interface Held {
  at: number
  /** account → its sector, for each account that allowed Drive files */
  rows: { account: string; sector: string | null }[]
  reading?: Promise<void>
}
const accounts = new WeakMap<DatabaseSync, Held>()

/** A workspace's Google accounts: the ones LifeOS files under its sector that allowed Drive files. An account with no sector belongs to no workspace. */
const ofSector = (held: Held | undefined, sector: string | null): string[] => (sector && held ? held.rows.filter((r) => r.sector === sector).map((r) => r.account) : [])

/** The accounts as last read, at once: what `locate` checks a Drive ref against. A host that never read them holds none, and every Drive ref is refused. */
export const accountsHeld = (db: DatabaseSync, sector: string | null): string[] => ofSector(accounts.get(db), sector)

/**
 * A workspace's Google accounts, read from LifeOS (`calendarOps:accounts`) at most once a minute. A first read is
 * waited for `wait` ms at most; a later one goes on behind the answer. LifeOS down or signed out answers what was
 * read before, or none: Files never fails for it, the Drive place is only absent.
 */
export async function driveAccounts(ctx: Pick<WorkCtx, 'db' | 'lifeos' | 'log'>, sector: string | null, o: { wait?: number; now?: number } = {}): Promise<string[]> {
  const now = o.now ?? Date.now()
  let held = accounts.get(ctx.db)
  if (!held || (now - held.at > DRIVE_ACCOUNTS_FRESH_MS && !held.reading)) {
    const was = held
    // What was read before answers while the read is under way; the read, done, puts a fresh row in its place.
    const next: Held = { at: was?.at ?? 0, rows: was?.rows ?? [] }
    accounts.set(ctx.db, next)
    next.reading = (async () => {
      const rows = ctx.lifeos.connected() ? ((await ctx.lifeos.owner().query<AccountRow[]>('calendarOps:accounts', {})) ?? []) : []
      const ok = rows.filter((r) => typeof r.account === 'string' && r.files === true).map((r) => ({ account: (r.account as string).toLowerCase(), sector: typeof r.sector === 'string' ? r.sector : null }))
      accounts.set(ctx.db, { at: Date.now(), rows: ok })
    })().catch((err) => {
      ctx.log(`files: Google accounts were not read: ${err instanceof Error ? err.message : String(err)}`)
      accounts.set(ctx.db, { at: Date.now(), rows: was?.rows ?? [] })
    })
    held = next
  }
  if (held.reading && (!held.at || o.wait)) {
    await Promise.race([held.reading, new Promise((resolve) => setTimeout(resolve, o.wait ?? DRIVE_ACCOUNTS_WAIT_MS).unref?.())])
  }
  return ofSector(accounts.get(ctx.db), sector)
}

/** A test, or a sign-in to LifeOS that changed: the next ask reads the accounts again. */
export const forgetDriveAccounts = (db: DatabaseSync): void => void accounts.delete(db)

// ── what a folder holds ───────────────────────────────────────────────

const FRESH_MS = 5_000
const lists = new Map<string, { at: number; items: DriveItem[]; more: boolean; version: string }>()
const facts = new Map<string, { at: number; item: DriveItem | null }>()
const keyOf = (account: string, id: string): string => `${account.toLowerCase()}\u0000${id}`

/** A test starts with nothing kept. */
export function forgetDriveLists(): void {
  lists.clear()
  facts.clear()
  tops.clear()
}
/** A change in these folders of an account (or a pick that let more be seen): their next listing asks Drive again. The top is always read again, since what it shows hangs on every folder. */
export function forgetDrive(account: string, folders: readonly string[] = []): void {
  for (const id of [DRIVE_ROOT, ...folders]) lists.delete(keyOf(account, id))
  for (const k of [...facts.keys()]) if (k.startsWith(`${account.toLowerCase()}\u0000`)) facts.delete(k)
}

/** One item's facts, kept a few seconds; null when this client may not see it (or it is gone). */
export async function driveFacts(ctx: WorkCtx, account: string, id: string, now = Date.now()): Promise<DriveItem | null> {
  const k = keyOf(account, id)
  const hit = facts.get(k)
  if (hit && now - hit.at < FRESH_MS) return hit.item
  let item: DriveItem | null
  try {
    item = await driveOf(ctx, account).facts(id)
  } catch (err) {
    if ((err as { code?: string }).code !== 'not-found') throw err
    item = null
  }
  facts.set(k, { at: now, item })
  if (facts.size > 512) facts.delete(facts.keys().next().value!)
  return item
}

/**
 * What a folder holds as this client sees it. The top of a place is My Drive's top with every item whose folder
 * TempCode cannot see: a file he picked from a folder of his is listed there, as Drive's own "Shared with me" lists
 * what has no folder of his.
 */
async function folderOf(ctx: WorkCtx, account: string, folderId: string, signal?: AbortSignal): Promise<{ items: DriveItem[]; more: boolean; version: string }> {
  const k = keyOf(account, folderId)
  const hit = lists.get(k)
  if (hit && Date.now() - hit.at < FRESH_MS) return hit
  const drive = driveOf(ctx, account)
  let got: { items: DriveItem[]; more: boolean }
  if (folderId === DRIVE_ROOT) {
    const seen = await drive.seen(signal)
    const folders = new Set(seen.items.filter((i) => i.folder).map((i) => i.id))
    got = { items: seen.items.filter((i) => !i.parents.some((p) => folders.has(p))), more: seen.more }
  } else got = await drive.children(folderId, signal)
  // The names, ids and times stand in for a version: a cursor cut from another state of the folder is stale.
  const version = createHash('sha1')
    .update(got.items.map((i) => `${i.id}/${i.name}/${i.changed ?? 0}`).join('\n'))
    .digest('hex')
    .slice(0, 16)
  const kept = { at: Date.now(), items: got.items, more: got.more, version }
  lists.set(k, kept)
  if (lists.size > 64) lists.delete(lists.keys().next().value!)
  return kept
}

const GOOGLE_TYPE = 'application/vnd.google-apps.'
/**
 * A Drive item's kind: Google's own types by their type alone (a Doc named "Plan v1.2" has no extension). Anything
 * else (a picked .xlsx or .pdf) opens only in Google Drive (`googleSeatOf` says so in one sentence), so it is
 * listed as `other`, never as a kind an editor here shows.
 */
export const kindOfItem = (item: Pick<DriveItem, 'name' | 'mimeType' | 'folder'>): EntryKind => (item.folder ? 'folder' : item.mimeType.startsWith(GOOGLE_TYPE) ? kindOfEntry('', item.mimeType).kind : 'other')

/** An item as the wire's entry. `inShared`: it lies in a folder others can open, so others can open it too. */
export function driveEntry(account: string, item: DriveItem, inShared = false): FileEntry {
  const a = account.toLowerCase()
  const folder: FolderRef | null = item.folder ? { at: 'drive', account: a, folderId: item.id } : null
  const ref = item.folder ? null : ({ at: 'google', account: a, fileId: item.id, mime: item.mimeType } as const)
  return {
    key: refKey(folder ?? ref!),
    ref,
    folder,
    name: item.name,
    kind: kindOfItem(item),
    ...(item.size !== undefined ? { size: item.size } : {}),
    ...(item.changed !== undefined ? { changed: item.changed } : {}),
    ...(item.by ? { by: item.by } : {}),
    shared: item.shared || inShared
  }
}

/** Whether others can open what is in a folder: the folder's own sharing; the top of a place is his own. A folder this client cannot see counts as shared. */
export async function folderShared(ctx: WorkCtx, account: string, folderId: string): Promise<boolean> {
  if (folderId === DRIVE_ROOT) return false
  return (await driveFacts(ctx, account, folderId))?.shared ?? true
}

/**
 * Whether others can open an item: its own sharing, or the sharing of a folder it lies in. A folder this client
 * cannot see counts as shared, as in `folderShared`: the host cannot tell. My Drive's own top is his.
 */
export async function itemShared(ctx: WorkCtx, account: string, item: DriveItem): Promise<boolean> {
  if (item.shared) return true
  for (const parent of item.parents) {
    const p = await driveFacts(ctx, account, parent)
    if (p ? p.shared : parent !== (await topIdOf(ctx, account))) return true
  }
  return false
}

const tops = new Map<string, string>()
/**
 * The id Drive gives My Drive's top, which `drive.file` cannot read the facts of: learned from what lies there (every
 * item listed under `root` names it as its folder) and kept. Null while nothing TempCode sees lies there.
 */
async function topIdOf(ctx: WorkCtx, account: string): Promise<string | null> {
  const a = account.toLowerCase()
  const kept = tops.get(a)
  if (kept) return kept
  const { items } = await driveOf(ctx, account).children(DRIVE_ROOT)
  const id = items[0]?.parents.find((p) => items.every((i) => i.parents.includes(p))) ?? null
  if (id) tops.set(a, id)
  return id
}

/** The steps down to a folder: the place, then each folder above it this client sees (eight at most), then the folder. */
async function trailOf(ctx: WorkCtx, place: FilePlace, account: string, folderId: string): Promise<FileCrumb[]> {
  const head: FileCrumb = { name: place.name, at: place.root }
  if (folderId === DRIVE_ROOT) return [head]
  const chain: DriveItem[] = []
  let at: DriveItem | null = await driveFacts(ctx, account, folderId)
  while (at && chain.length < 8) {
    chain.unshift(at)
    const parent = at.parents[0]
    at = parent ? await driveFacts(ctx, account, parent) : null
  }
  return [head, ...chain.map((f) => ({ name: f.name, at: { at: 'drive' as const, account: account.toLowerCase(), folderId: f.id } }))]
}

type Row = DiskRow & { item: DriveItem }

/** One page of a Drive folder, in the host's order (folders first), cut by the same keyset cursor as a disk's. */
export async function driveList(ctx: WorkCtx, place: FilePlace, account: string, folderId: string, o: { sort?: FileSort; cursor?: string; foldersOnly?: boolean; signal?: AbortSignal } = {}): Promise<FilesListing> {
  const sort = o.sort ?? DEFAULT_SORT
  const folder = await folderOf(ctx, account, folderId, o.signal)
  const inShared = await folderShared(ctx, account, folderId)
  const rows: Row[] = (o.foldersOnly ? folder.items.filter((i) => i.folder) : folder.items).map((item) => ({ name: item.name, dir: item.folder, kind: kindOfItem(item), ...(item.size !== undefined ? { size: item.size } : {}), ...(item.changed !== undefined ? { changed: item.changed } : {}), stated: true, item }))
  rows.sort((a, b) => compareEntries(a, b, sort))
  const page = cutPage(rows, { tag: `drive\u0000${keyOf(account, folderId)}`, version: folder.version, sort, cursor: o.cursor })
  if (page.stale) return { entries: [], stale: true }
  const entries = (page.rows as Row[]).map((r) => driveEntry(account, r.item, inShared))
  return { entries, ...(page.next ? { next: page.next } : {}), ...(folder.more ? { more: true as const } : {}), ...(o.cursor ? {} : { place: place.id, trail: await trailOf(ctx, place, account, folderId) }) }
}

/** One item looked at now, with whether others can open it; null when this client may not see it or it is in the bin. The top of a place is the place's own row. */
export async function driveStat(ctx: WorkCtx, account: string, id: string): Promise<FileEntry | null> {
  if (id === DRIVE_ROOT) return { key: refKey(driveTop(account)), ref: null, folder: driveTop(account), name: account.toLowerCase(), kind: 'folder', shared: false }
  let item: DriveItem
  try {
    item = await driveOf(ctx, account).facts(id)
  } catch (err) {
    if ((err as { code?: string }).code === 'not-found') return null
    throw err
  }
  if (item.trashed) return null
  facts.set(keyOf(account, id), { at: Date.now(), item })
  return driveEntry(account, item, await itemShared(ctx, account, item))
}

/**
 * Folders of an account changed (a verb ran, or Drive's bin took or gave back a file): their listings are read
 * again, and whoever may read the workspace hears of each by its key. The top always: it shows whatever has no
 * folder TempCode sees. A push names a key, never a file.
 */
export function driveChanged(ctx: Pick<WorkCtx, 'push' | 'log'>, workspaceId: string, account: string, folders: readonly string[]): void {
  forgetDrive(account, folders)
  const keys = new Set([refKey(driveTop(account)), refKey({ at: 'place', id: drivePlaceId(account) }), ...folders.map((id) => refKey({ at: 'drive', account: account.toLowerCase(), folderId: id }))])
  for (const at of keys) {
    try {
      ctx.push({ push: 'work.files', workspaceId, at }, { need: 'read' })
    } catch (err) {
      ctx.log(`files: a Drive folder's push failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}
