import type { CanvasKind } from '@shared/work'
import type { WorkCtx } from '../modules'
import { GOOGLE_MIME, GoogleError, type GoogleApi } from './client'
import type { GoogleSource } from './docs'
import { googleOf } from './google'
import { watch } from './poll'

/**
 * Google Drive as the Files place reads and changes it (docs/agents/work-google.md "Drive in Files"), over the
 * pillar's own `drive.file` tokens. TempCode sees only the files LifeOS's Google client made or he picked, so a
 * listing is what that permission lets it see; Add from Drive is the Picker (`work.google.pick`). No call here
 * asks for a wider scope. Every verb is one Drive call: `files.create` for a Doc, a Sheet, a deck or a folder,
 * `files.update` for a rename, a move (`addParents`, `removeParents`) and the bin (`trashed`).
 */

export const DRIVE_FOLDER = 'application/vnd.google-apps.folder'
/** Drive's own word for the top of his My Drive: where New at a Drive place's top puts a thing. */
export const DRIVE_ROOT = 'root'
/** The most items one folder is read as: ten pages of Drive's thousand. Past that the listing says `more`. */
export const DRIVE_LIST_MOST = 10_000
const PAGE = 1000

const FIELDS = 'id,name,mimeType,parents,modifiedTime,size,version,shared,ownedByMe,driveId,trashed,webViewLink,lastModifyingUser(displayName,me)'

/** One item of a Drive, as the Files place reads it. */
export interface DriveItem {
  id: string
  name: string
  mimeType: string
  parents: string[]
  folder: boolean
  /** epoch ms */
  changed?: number
  /** Google's own types have none */
  size?: number
  /** Drive's counter, moved by every change */
  version?: string
  /** who last changed it, by Google's name for them */
  by?: string
  /** others can open it (`othersCan`) */
  shared: boolean
  trashed?: boolean
  web?: string
}

interface RawItem {
  id: string
  name: string
  mimeType: string
  parents?: string[]
  modifiedTime?: string
  size?: string
  version?: string
  shared?: boolean
  ownedByMe?: boolean
  driveId?: string
  trashed?: boolean
  webViewLink?: string
  lastModifyingUser?: { displayName?: string; me?: boolean }
}

/**
 * Whether people other than him can open an item, by its own facts: Drive says it was shared, it lies in a shared
 * drive (whose members all can), or someone else owns it. Facts that do not say (no `shared` at all) count as
 * shared: the host cannot tell.
 */
export const othersCan = (raw: Pick<RawItem, 'shared' | 'driveId' | 'ownedByMe'>): boolean => raw.shared !== false || !!raw.driveId || raw.ownedByMe === false

export function itemOf(raw: RawItem): DriveItem {
  const changed = raw.modifiedTime ? Date.parse(raw.modifiedTime) : NaN
  const size = raw.size !== undefined ? Number(raw.size) : NaN
  return {
    id: raw.id,
    name: raw.name,
    mimeType: raw.mimeType,
    parents: raw.parents ?? [],
    folder: raw.mimeType === DRIVE_FOLDER,
    ...(Number.isFinite(changed) ? { changed } : {}),
    ...(Number.isFinite(size) ? { size } : {}),
    ...(raw.version ? { version: raw.version } : {}),
    ...(raw.lastModifyingUser?.displayName ? { by: raw.lastModifyingUser.displayName } : {}),
    shared: othersCan(raw),
    ...(raw.trashed !== undefined ? { trashed: raw.trashed } : {}),
    ...(raw.webViewLink ? { web: raw.webViewLink } : {})
  }
}

/** What New makes in a Drive, by the Files place's word for it: Google's own types and a folder. A text file is not offered. */
export const DRIVE_MAKES = { document: GOOGLE_MIME.doc, sheet: GOOGLE_MIME.sheet, deck: GOOGLE_MIME.slides, folder: DRIVE_FOLDER } as const
export type DriveMakeKind = keyof typeof DRIVE_MAKES

/** A Google file's canvas kind and the google pillar's word for it; anything else Drive holds opens in Drive itself. */
export const GOOGLE_SEATS: Record<string, { canvas: CanvasKind; kind: 'doc' | 'sheet' | 'slides' }> = {
  [GOOGLE_MIME.doc]: { canvas: 'document', kind: 'doc' },
  [GOOGLE_MIME.sheet]: { canvas: 'sheet', kind: 'sheet' },
  [GOOGLE_MIME.slides]: { canvas: 'slides', kind: 'slides' }
}

/** A Drive id as Drive writes one; anything else is refused before it reaches a query. */
const ID = /^[A-Za-z0-9_-]{1,200}$/
function idOf(id: string): string {
  if (!ID.test(id)) throw new GoogleError('That is not a Drive id.', 'bad-request')
  return encodeURIComponent(id)
}

/** One account's Drive. */
export class Drive {
  constructor(private api: GoogleApi) {}

  get account(): string {
    return this.api.account
  }

  /** Every item a query finds, a page of a thousand after another, `DRIVE_LIST_MOST` at most (`more`: it holds more). */
  private async all(q: string, signal?: AbortSignal): Promise<{ items: DriveItem[]; more: boolean }> {
    const items: DriveItem[] = []
    let token: string | undefined
    do {
      if (signal?.aborted) throw new Error('cancelled')
      const params = new URLSearchParams({ q, fields: `nextPageToken,files(${FIELDS})`, pageSize: String(PAGE), spaces: 'drive', supportsAllDrives: 'true', includeItemsFromAllDrives: 'true' })
      if (token) params.set('pageToken', token)
      const got = await this.api.driveCall<{ files?: RawItem[]; nextPageToken?: string }>('GET', `/files?${params}`)
      items.push(...(got.files ?? []).map(itemOf))
      token = got.nextPageToken
    } while (token && items.length < DRIVE_LIST_MOST)
    return { items: items.slice(0, DRIVE_LIST_MOST), more: !!token || items.length > DRIVE_LIST_MOST }
  }

  /** A folder's children that `drive.file` lets this client see, out of the bin. */
  children(folderId: string, signal?: AbortSignal): Promise<{ items: DriveItem[]; more: boolean }> {
    idOf(folderId)
    return this.all(`'${folderId}' in parents and trashed = false`, signal)
  }

  /** Everything this client may see in his Drive, out of the bin: the files it made and the ones he picked, with their folders. */
  seen(signal?: AbortSignal): Promise<{ items: DriveItem[]; more: boolean }> {
    return this.all('trashed = false', signal)
  }

  async facts(id: string): Promise<DriveItem> {
    return itemOf(await this.api.driveCall<RawItem>('GET', `/files/${idOf(id)}?fields=${encodeURIComponent(FIELDS)}&supportsAllDrives=true`))
  }

  /** A new, empty Google Doc, Sheet, deck or folder in `parent`. */
  async make(kind: DriveMakeKind, name: string, parent: string): Promise<DriveItem> {
    idOf(parent)
    return itemOf(await this.api.driveCall<RawItem>('POST', `/files?fields=${encodeURIComponent(FIELDS)}&supportsAllDrives=true`, { name, mimeType: DRIVE_MAKES[kind], parents: [parent] }))
  }

  private update(id: string, body: Record<string, unknown>, query = ''): Promise<RawItem> {
    return this.api.driveCall<RawItem>('PATCH', `/files/${idOf(id)}?fields=${encodeURIComponent(FIELDS)}&supportsAllDrives=true${query}`, body)
  }

  async rename(id: string, name: string): Promise<DriveItem> {
    return itemOf(await this.update(id, { name }))
  }

  /** Into `to`, out of every folder in `from`: one call, so the file is never in neither. */
  async move(id: string, from: readonly string[], to: string): Promise<DriveItem> {
    const parents = [to, ...from].map(idOf)
    return itemOf(await this.update(id, {}, `&addParents=${parents[0]}${from.length ? `&removeParents=${parents.slice(1).join(',')}` : ''}`))
  }

  /** To Drive's own bin, which keeps it 30 days and from which `untrash` puts it back where it was. */
  async trash(id: string): Promise<DriveItem> {
    return itemOf(await this.update(id, { trashed: true }))
  }

  async untrash(id: string): Promise<DriveItem> {
    return itemOf(await this.update(id, { trashed: false }))
  }
}

/** An account's Drive on this host. */
export const driveOf = (ctx: WorkCtx, account: string): Drive => new Drive(googleOf(ctx).api(account))

/**
 * A Google file as an item opens it: its canvas kind and source. Refused for what is no Doc, Sheet or deck, unless
 * `facts`: a Files tab shows a picked PDF or workbook, which no editor here reads, as the `file` kind's facts, with
 * Open in Drive.
 */
export async function googleSeatOf(ctx: WorkCtx, account: string, fileId: string, o: { facts?: boolean } = {}): Promise<{ kind: CanvasKind; source: GoogleSource; name: string; version: string }> {
  const f = await googleOf(ctx).api(account).file(fileId)
  const seat = GOOGLE_SEATS[f.mimeType]
  if (!seat && !o.facts) throw new Error(`${f.name} opens in Google Drive: it is not a Doc, a Sheet or a Slides deck.`)
  return { kind: seat?.canvas ?? 'file', source: { at: 'google', account: account.toLowerCase(), fileId: f.id, mime: f.mimeType }, name: f.name, version: f.version }
}

/** An item now shows a Google file: the pillar keeps its row and polls its version while the item is open. A file shown as its facts has neither. */
export function googleSeated(ctx: WorkCtx, seat: { source: GoogleSource; name: string; version: string }, itemId: string): void {
  const g = googleOf(ctx)
  const { source } = seat
  if (!GOOGLE_SEATS[source.mime]) return
  if (!g.files.get(source.account, source.fileId)) g.files.put({ account: source.account, fileId: source.fileId, kind: GOOGLE_SEATS[source.mime]!.kind, name: seat.name, version: seat.version, behind: null, mirror: null, base: null })
  watch(source.account, source.fileId, seat.name, itemId)
}
