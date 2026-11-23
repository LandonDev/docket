import type { CanvasKind, CanvasSource, ContextChip } from './canvas'

/**
 * The Files place's grammar (docs/agents/work-files.md): what a place, a folder and a file are, which canvas
 * kind opens a file, what each place lets a hand do, and the sentence said when it does not. Pure and zod-free:
 * the host, the window and the phone's generated contract all read these rules, so a menu never offers what
 * the host will refuse, and a first-paint file may import it.
 */

// ── what a file is ────────────────────────────────────────────────────

/** Text a person writes: a thread's canvas still opens these as a document (`threadCanvasOf`), and a Files tab offers Open as a document. */
export const PROSE_EXTS = ['md', 'markdown', 'txt'] as const

/** What a row is, as its glyph and its kind's word say it. */
export const ENTRY_KINDS = ['folder', 'document', 'sheet', 'deck', 'pdf', 'picture', 'video', 'audio', 'text', 'archive', 'other'] as const
export type EntryKind = (typeof ENTRY_KINDS)[number]
export const ENTRY_KIND_WORDS: Record<EntryKind, string> = {
  folder: 'Folder',
  document: 'Document',
  sheet: 'Sheet',
  deck: 'Deck',
  pdf: 'PDF',
  picture: 'Picture',
  video: 'Video',
  audio: 'Audio',
  text: 'Text',
  archive: 'Archive',
  other: 'File'
}

/**
 * The one table of file types: an extension's kind, and the canvas kind that shows it (null: it has no viewer
 * of its own). Every other lookup reads this: the canvas registry (`kindForFile`, held to it by
 * registry.test.ts), the Docs finder (`kindOfFile`), the Teams view (`teamsCanvasOf`). The `file` kind edits
 * text in place and lists an archive; in a Files tab it also seats what has no viewer, as its facts (`seatOf`).
 */
const BY_EXT = new Map<string, { kind: EntryKind; canvas: CanvasKind | null }>()
const row = (kind: EntryKind, canvas: CanvasKind | null, exts: string): void => exts.split(' ').forEach((ext) => void BY_EXT.set(ext, { kind, canvas }))
row('document', 'document', 'tcdoc docx doc odt rtf')
row('document', null, 'docm')
row('sheet', 'sheet', 'tcsheet xlsx xlsm csv')
row('sheet', null, 'xlsb xls ods')
row('deck', 'slides', 'pptx ppt pps ppsx odp key')
row('deck', null, 'pptm')
row('pdf', 'pdf', 'pdf')
row('picture', 'media', 'png jpg jpeg gif webp avif heic heif tif tiff bmp psd')
row('picture', null, 'svg ico')
row('video', 'media', 'mp4 m4v mov webm mkv mxf avi mts m2ts ogv')
row('audio', 'meeting', 'wav mp3 m4a aac flac ogg opus wma aiff amr')
row('text', 'file', `${PROSE_EXTS.join(' ')} json xml html htm log tsv yaml yml toml ini css js jsx ts tsx py rb go rs java c h cpp sh sql`)
row('archive', 'file', 'zip tar gz tgz 7z rar')

/** A name's extension, lower case, no dot; '' when it has none (a leading dot is a hidden file's name, not an extension). */
export function extOf(name: string): string {
  const base = name.slice(Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\')) + 1)
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : ''
}

const OFFICE_MIME = 'application/vnd.openxmlformats-officedocument.'
function byMime(mime: string): { kind: EntryKind; canvas: CanvasKind | null } | null {
  const m = mime.toLowerCase()
  if (m === 'application/vnd.google-apps.document' || m === `${OFFICE_MIME}wordprocessingml.document`) return { kind: 'document', canvas: 'document' }
  if (m === 'application/vnd.google-apps.spreadsheet' || m === `${OFFICE_MIME}spreadsheetml.sheet` || m === 'application/vnd.ms-excel.sheet.macroenabled.12' || m === 'text/csv') return { kind: 'sheet', canvas: 'sheet' }
  if (m === 'application/vnd.google-apps.presentation' || m === `${OFFICE_MIME}presentationml.presentation`) return { kind: 'deck', canvas: 'slides' }
  if (m === 'application/vnd.google-apps.folder') return { kind: 'folder', canvas: null }
  if (m === 'application/pdf') return { kind: 'pdf', canvas: 'pdf' }
  if (m.startsWith('image/')) return { kind: 'picture', canvas: 'media' }
  if (m.startsWith('video/')) return { kind: 'video', canvas: 'media' }
  if (m.startsWith('audio/')) return { kind: 'audio', canvas: 'meeting' }
  if (m.startsWith('text/')) return { kind: 'text', canvas: 'file' }
  if (m === 'application/zip') return { kind: 'archive', canvas: 'file' }
  return null
}

/**
 * What a file is and which canvas kind opens it. The name's extension decides; the type a desktop, a mail or a
 * provider gave is only a guess from the name (a `.ts` script comes as `video/mp2t`, a `.csv` from Windows as
 * `application/vnd.ms-excel`), so it is read only for a name with no extension.
 */
export function kindOfEntry(name: string, mime?: string): { kind: EntryKind; canvas: CanvasKind | null } {
  const ext = extOf(name)
  if (ext) return BY_EXT.get(ext) ?? { kind: 'other', canvas: null }
  return (mime ? byMime(mime) : null) ?? { kind: 'other', canvas: null }
}

/** What a Files tab seats a file as: its kind's viewer, else the `file` kind, which shows any file (text to edit, its facts for the rest). Every file opens. */
export const seatOf = (name: string, mime?: string): CanvasKind => kindOfEntry(name, mime).canvas ?? 'file'

/**
 * What a thread's canvas opens a file as. Only the Files pane makes `file` items until a thread has the tools
 * for them (F5): till then text a person writes opens beside a thread as a document, as it always has, and
 * nothing else the `file` kind shows opens there.
 */
export function threadCanvasOf(name: string, mime?: string): CanvasKind | null {
  const { canvas } = kindOfEntry(name, mime)
  if (canvas !== 'file') return canvas
  return (PROSE_EXTS as readonly string[]).includes(extOf(name)) ? 'document' : null
}

/** Every extension the table knows for a kind (the guest's search filters by them). */
export const extsOfKind = (kind: EntryKind): string[] => [...BY_EXT].filter(([, v]) => v.kind === kind).map(([ext]) => ext)
/** Every extension a canvas kind opens: what the registry's `opens.ext` must equal. */
export const extsOfCanvas = (canvas: CanvasKind): string[] => [...BY_EXT].filter(([, v]) => v.canvas === canvas).map(([ext]) => ext)

// ── places and folders ────────────────────────────────────────────────

/**
 * A place a file can live in (the first five), or a lens that shows files from several places and is never a
 * home (the rest).
 */
export const PLACE_KINDS = ['folder', 'lifeos', 'onedrive', 'teams', 'drive', 'home', 'recent', 'starred', 'project', 'mail', 'made', 'trash', 'search'] as const
export type PlaceKind = (typeof PLACE_KINDS)[number]
const HOMES: readonly PlaceKind[] = ['folder', 'lifeos', 'onedrive', 'teams', 'drive']
export const isHome = (kind: PlaceKind): boolean => HOMES.includes(kind)

/** The ids of the places and lenses every workspace has; a library's is its own (`<host>~<hash>`), a Drive's `drive:<account>`, a project's `project:<id>`, a saved search's `search:<id>`. */
export const PLACE = { folder: 'folder', lifeos: 'lifeos', home: 'home', recent: 'recent', starred: 'starred', mail: 'mail', made: 'made', trash: 'trash' } as const

/** What a hand may ask of a place. `edit` is a file's own bytes replaced where it lies: an editor's save. */
export const FILE_VERBS = ['make', 'upload', 'rename', 'move', 'copy', 'edit', 'trash', 'restore', 'purge'] as const
export type FileVerb = (typeof FILE_VERBS)[number]

/**
 * A folder, or a lens, to list. `file`'s tag is the one the listener's path fence reads wherever it sits, so
 * no method needs a param named `path`; a Drive folder and a LifeOS project are named by their ids; `place` is
 * a place's top or a lens.
 */
export type FolderRef = { at: 'file'; host: string; path: string } | { at: 'drive'; account: string; folderId: string } | { at: 'project'; id: string } | { at: 'place'; id: string }

/**
 * What stands between a place and him. `ok`: listed. `reading`: its first read is under way. `asleep`: its
 * machine sleeps and the list is the one kept at `at`. `signed-out`, `no-onedrive`, `no-libraries`,
 * `not-set-up`: as the Teams view names them. `not-allowed`: the workspace may not use that computer.
 * `unreachable`: its computer or service did not answer. `error`: it answered a fault; `detail` says it.
 */
export const PLACE_STATES = ['ok', 'reading', 'asleep', 'signed-out', 'no-onedrive', 'no-libraries', 'not-set-up', 'not-allowed', 'unreachable', 'error'] as const
export type PlaceStateWord = (typeof PLACE_STATES)[number]
export interface PlaceState {
  state: PlaceStateWord
  detail?: string
  /** when what is shown was read, for a list kept from before */
  at?: number
}

export interface FilePlace {
  id: string
  kind: PlaceKind
  /** as the sidebar says it: the workspace's name, "LifeOS", a channel's or library's name, an account */
  name: string
  /** the computer it is on, as he names it; '' for a place on no computer of his (LifeOS, Google) */
  host: string
  /** the host that answers for it */
  env: string
  /** other people can open what is in it */
  shared: boolean
  /** the verbs its adapter carries out; the rules below still decide whether one is offered */
  can: FileVerb[]
  state: PlaceState
  /** its top folder */
  root: FolderRef
  /** one place two computers hold has one key (`placeKey`): the sidebar draws it once */
  key?: string
  /** the team or site a library belongs to: its sidebar group */
  group?: string
  /** it lies in the Windows VM its host keeps */
  vm?: boolean
  /** its address on the web, where he gave one */
  web?: string | null
  /** how many files a lens holds, where its row says (From mail) */
  count?: number
  /** what New offers here, as its host says it: only what opens ready to edit in this place */
  makes?: MakeKind[]
}

/** What New makes. */
export const MAKE_KINDS = ['document', 'sheet', 'deck', 'text', 'folder'] as const
export type MakeKind = (typeof MAKE_KINDS)[number]
export const MAKE_WORDS: Record<MakeKind, string> = { document: 'Document', sheet: 'Sheet', deck: 'Deck', text: 'Text file', folder: 'Folder' }

/** The one state a row shows, at most: its bytes are in the cloud, suggestions wait, someone is in it, a thread is writing it. */
export type EntryState = { is: 'cloud' } | { is: 'suggestions'; count: number } | { is: 'present'; who: string } | { is: 'writing' }

export interface FileEntry {
  /** stable for the file wherever it is read from (`refKey`): what a star, a recent, a tab and a selection hold */
  key: string
  /** the file, to open; null for a folder */
  ref: CanvasSource | null
  /** the folder this row is, to list; null for a file */
  folder: FolderRef | null
  name: string
  kind: EntryKind
  size?: number
  /** epoch ms */
  changed?: number
  /** who last changed it, where its store says */
  by?: string
  /** false: its bytes are in the cloud until it is opened */
  local?: boolean
  shared?: boolean
  state?: EntryState
  /** in a lens: the place it lives in and the folders down to it */
  where?: { place: string; name: string; trail: string[] }
  project?: { id: string; name: string }
  /** the thread that made it */
  madeBy?: string
  /** a thread made it and he has not opened it */
  fresh?: boolean
  starred?: boolean
  /** Home's Waiting on you: a thread's change to it waits in the Outbox for his press (a held `file.act`); the row opens that item */
  held?: { id: string; verb: 'make' | 'rename' | 'move' | 'copy' }
}

/** One place two computers may both hold: a team or site and a folder or library of it, as either OneDrive layout names it ("RecWell-TeamRecWell" on a Mac is "RecWell" + "Team RecWell" under Windows). */
export const placeKey = (team: string, label = ''): string => `${team}${/^(shared )?documents$/i.test(label) ? '' : label}`.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')

const innerPath = (top: string, path: string): string =>
  path
    .slice(top.length)
    .split(/[\\/]+/)
    .filter(Boolean)
    .join('/')
    .normalize('NFC')

/**
 * A part of a key that is not its last: its `:` (and the `%` that writes it) is written out, so the part ends
 * where the key's own `:` stands and no two refs share a key (a host named `a:b` with a path can never spell
 * another host's file). A host's id, a place's key and a table's name hold neither, so their keys read as before.
 */
const word = (part: string): string => part.replaceAll('%', '%25').replaceAll(':', '%3A')

/**
 * The one stable key of a file or folder. For a file in a library two computers hold (`lib`: the library's
 * place key and its path on the answering computer) it is the place and the path inside it, so a star is one
 * star whichever copy answers. `{ at: 'thread' }` names no file: an item made in a thread is keyed by its item.
 */
export function refKey(ref: CanvasSource | FolderRef, lib?: { key: string; path: string }): string {
  switch (ref.at) {
    case 'file':
      return lib ? `lib:${word(lib.key)}:${innerPath(lib.path, ref.path)}` : `file:${word(ref.host)}:${ref.path}`
    case 'microsoft':
      if (ref.ref.kind === 'url') return `web:${ref.ref.url}`
      return lib ? `lib:${word(lib.key)}:${innerPath(lib.path, ref.ref.path)}` : `file:${word(ref.host)}:${ref.ref.path}`
    case 'lifeos':
      return `lifeos:${word(ref.table)}:${ref.id}`
    case 'google':
      return `google:${ref.fileId}`
    case 'drive':
      // Drive's word for the top of My Drive is every account's: the top is keyed by its account.
      return ref.folderId === 'root' ? `google:root:${word(ref.account.toLowerCase())}` : `google:${ref.folderId}`
    case 'mail':
      return `mail:${word(ref.messageId)}:${ref.partId}`
    case 'frameio':
      return `frameio:${word(ref.account)}:${ref.fileId}`
    case 'browser':
      return `browser:${ref.host}:${ref.sessionId}`
    case 'project':
      return `project:${ref.id}`
    case 'place':
      return `place:${ref.id}`
    case 'thread':
      return 'thread'
  }
}

// ── names ─────────────────────────────────────────────────────────────

const RESERVED_WINDOWS = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i
/** The longest name a place takes: the common limit of APFS, NTFS and ext4 is 255 bytes; SharePoint's own is shorter and counted in characters. */
export const NAME_MAX = 200

/**
 * Why a name cannot be a file's or folder's, or null. A name is one path component on every computer a place
 * may be on: no separator, no step up, no control character, nothing Windows reserves or cannot end a name with.
 */
export function nameProblem(name: string): string | null {
  if (name.trim() === '') return 'A name needs at least one letter.'
  if (name.length > NAME_MAX) return `A name can be ${NAME_MAX} characters at most.`
  if (name === '.' || name === '..') return 'That name is not allowed.'
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) return 'A name cannot hold a line break or a control character.'
  const bad = /[\\/:*?"<>|]/.exec(name)
  if (bad) return `A name cannot hold ${bad[0]}`
  if (/[. ]$/.test(name) || /^ /.test(name)) return 'A name cannot start with a space or end with a space or a dot.'
  if (RESERVED_WINDOWS.test(name)) return 'Windows keeps that name for itself.'
  return null
}

/** A name's stem and its extension with the dot: "Budget.final.xlsx" is "Budget.final" and ".xlsx"; a folder or a name with none has ''. */
export function splitName(name: string): { stem: string; ext: string } {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? { stem: name.slice(0, dot), ext: name.slice(dot) } : { stem: name, ext: '' }
}

/**
 * A name no file there has: the name itself, else "Name 2", "Name 3" before its extension. `taken` answers
 * for the folder (a disk that reads names case-blind answers so). `tail` is said before the number starts:
 * a file put back beside one of its name is "Name (restored)", then "Name (restored) 2".
 */
export function freeName(name: string, taken: (name: string) => boolean, tail = ''): string {
  if (!taken(name)) return name
  const { stem, ext } = splitName(name)
  const base = `${stem}${tail}`
  if (tail && !taken(`${base}${ext}`)) return `${base}${ext}`
  for (let n = 2; n < 10_000; n++) {
    const next = `${base} ${n}${ext}`
    if (!taken(next)) return next
  }
  throw new Error(`No free name for ${name} in that folder.`)
}

/** What New names a thing before he types: "Untitled document". */
export const UNTITLED: Record<'document' | 'sheet' | 'deck' | 'text' | 'folder', string> = {
  document: 'Untitled document',
  sheet: 'Untitled sheet',
  deck: 'Untitled deck',
  text: 'Untitled',
  folder: 'Untitled folder'
}

// ── sort and group ────────────────────────────────────────────────────

export const FILE_SORTS = ['name', 'changed', 'size', 'kind'] as const
export type FileSortBy = (typeof FILE_SORTS)[number]
export interface FileSort {
  by: FileSortBy
  /** `desc`: Z to A, newest first, largest first */
  dir: 'asc' | 'desc'
}
export const DEFAULT_SORT: FileSort = { by: 'name', dir: 'asc' }

/** Names as a finder orders them: case-blind, a number in a name by its value ("Budget 2" before "Budget 10"). One fixed locale, so the host's pages and the window's order agree. */
const NAMES = new Intl.Collator('en', { numeric: true, sensitivity: 'base' })
export const compareNames = (a: string, b: string): number => NAMES.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0)

type Sortable = Pick<FileEntry, 'name' | 'kind' | 'changed' | 'size'>

/** Folders first, then the sort, then the name: a total order, so a page's last row is a cursor. */
export function compareEntries(a: Sortable, b: Sortable, sort: FileSort = DEFAULT_SORT): number {
  const folders = Number(b.kind === 'folder') - Number(a.kind === 'folder')
  if (folders) return folders
  const flip = sort.dir === 'desc' ? -1 : 1
  let by = 0
  if (sort.by === 'changed') by = (a.changed ?? 0) - (b.changed ?? 0)
  else if (sort.by === 'size') by = (a.size ?? 0) - (b.size ?? 0)
  else if (sort.by === 'kind') by = compareNames(ENTRY_KIND_WORDS[a.kind], ENTRY_KIND_WORDS[b.kind])
  else by = compareNames(a.name, b.name)
  // The name breaks a tie the same way whichever way the sort runs.
  return by ? by * flip : sort.by === 'name' ? 0 : compareNames(a.name, b.name)
}
export const sortEntries = <E extends Sortable>(entries: readonly E[], sort: FileSort = DEFAULT_SORT): E[] => [...entries].sort((a, b) => compareEntries(a, b, sort))

export const FILE_GROUPS = ['none', 'kind', 'date', 'place', 'project'] as const
export type FileGroupBy = (typeof FILE_GROUPS)[number]
export interface FileGroup<E> {
  /** '' for the one group of `none` */
  label: string
  entries: E[]
}

const DAY = 24 * 60 * 60 * 1000
/** The date group a change falls in, as of `now` (both epoch ms, in the reader's own day). */
export function dateGroupOf(changed: number | undefined, now: number): string {
  if (!changed) return 'Earlier'
  const midnight = new Date(now)
  midnight.setHours(0, 0, 0, 0)
  const today = midnight.getTime()
  if (changed >= today) return 'Today'
  if (changed >= today - DAY) return 'Yesterday'
  if (changed >= today - 7 * DAY) return 'Previous 7 days'
  if (changed >= today - 30 * DAY) return 'Previous 30 days'
  return 'Earlier'
}
const DATE_ORDER = ['Today', 'Yesterday', 'Previous 7 days', 'Previous 30 days', 'Earlier']

/**
 * The entries in groups, each group in the order the entries came in. By kind the groups follow `ENTRY_KINDS`;
 * by date, newest first; by place or project, the order each first appears (a file in no project is last,
 * under "No project").
 */
export function groupEntries<E extends Pick<FileEntry, 'kind' | 'changed' | 'where' | 'project'>>(entries: readonly E[], by: FileGroupBy, now = Date.now()): FileGroup<E>[] {
  if (by === 'none') return [{ label: '', entries: [...entries] }]
  const groups = new Map<string, E[]>()
  const put = (label: string, e: E): void => void (groups.get(label) ?? groups.set(label, []).get(label)!).push(e)
  for (const e of entries) {
    if (by === 'kind') put(ENTRY_KIND_WORDS[e.kind], e)
    else if (by === 'date') put(dateGroupOf(e.changed, now), e)
    else if (by === 'place') put(e.where?.name ?? '', e)
    else put(e.project?.name ?? 'No project', e)
  }
  const order = by === 'kind' ? ENTRY_KINDS.map((k) => ENTRY_KIND_WORDS[k]) : by === 'date' ? DATE_ORDER : by === 'project' ? [...[...groups.keys()].filter((k) => k !== 'No project'), 'No project'] : [...groups.keys()]
  return order.flatMap((label) => (groups.has(label) ? [{ label, entries: groups.get(label)! }] : []))
}

// ── what a place lets a hand do ───────────────────────────────────────

/** The most a file may be to be copied from another computer of his. */
export const COPY_ACROSS_MAX = 48 * 1024 * 1024
/** The most open file seats a workspace's Files pane holds (the canvas's own cap; a split counts two). */
export const FILE_SEATS_MAX = 32
export const SEATS_FULL = `${FILE_SEATS_MAX} files are open. Close one to open another.`

/** The one press a refusal offers. The window knows what each does; the host only names it. */
export const REFUSAL_PRESSES = ['keep', 'open-here', 'open-web', 'export', 'retry', 'open-copies'] as const
export type RefusalPress = (typeof REFUSAL_PRESSES)[number]
export const PRESS_WORDS: Record<RefusalPress, string> = {
  keep: 'Keep',
  'open-here': 'Open it here',
  'open-web': 'Open on the web',
  export: 'Export…',
  retry: 'Retry',
  'open-copies': 'Open copies here'
}
export interface Refusal {
  /** one sentence */
  text: string
  press?: RefusalPress
}

/** The service a shared place belongs to, as its refusals name it. */
const serviceOf = (place: Pick<FilePlace, 'kind'>): string => (place.kind === 'teams' ? 'Teams' : place.kind === 'onedrive' ? 'OneDrive' : place.kind === 'drive' ? 'Google Drive' : 'that place')

type AskedOf = Pick<FilePlace, 'id' | 'kind' | 'name' | 'host' | 'env' | 'shared' | 'can' | 'state' | 'vm'>
type AskedEntry = Pick<FileEntry, 'name' | 'size' | 'state' | 'kind' | 'shared'>

/**
 * Why `place` does not do `verb`, or null when it does: the verbs table of docs/agents/work-files.md as code.
 * `place` is where the thing lives now (for `make` and `upload`, where it is to be made); `to` is the place a
 * `move` or `copy` lands in, absent or the same place for one inside it. A hand's question before a change
 * that others see is `questionFor`, not a refusal.
 */
export function refusal(place: AskedOf, verb: FileVerb, entry?: AskedEntry | null, to?: AskedOf | null): Refusal | null {
  const across = !!to && to.id !== place.id
  // A lens holds nothing of its own: the caller asks of the place the file lives in.
  if (place.kind === 'mail') {
    // Keep is the one thing a mail's file does: a copy into the workspace's folder.
    if (verb === 'copy' && across && to!.kind === 'folder') return null
    return { text: "A mail's file is read only. Keep it first.", press: 'keep' }
  }
  if (!isHome(place.kind)) return { text: `${place.name} only shows files. Change one where it lives.` }
  for (const p of across ? [place, to!] : [place]) {
    if (p.state.state === 'unreachable') return { text: `${p.host || p.name} is out of reach.`, press: 'retry' }
  }
  if (entry?.state?.is === 'writing' && (verb === 'rename' || verb === 'move' || verb === 'trash')) return { text: 'A thread is writing in this file. Try when it is done.' }

  if (across && (verb === 'move' || verb === 'copy')) {
    if (!isHome(to!.kind)) return { text: `${to!.name} only shows files. Pick a folder to put it in.` }
    // Out of a shared place: a lasting copy of what a team holds is refused until he rules on it, and a move out is never offered.
    if (place.shared && place.kind !== 'drive') return { text: `${serviceOf(place)} files stay in ${serviceOf(place)}.`, press: 'open-here' }
    if (place.kind === 'lifeos') return { text: 'A LifeOS document lives in LifeOS. Export a copy instead.', press: 'export' }
    if (to!.kind === 'lifeos') return { text: 'Only a LifeOS document lives in LifeOS. Make one there instead.' }
    if (place.kind === 'drive' || to!.kind === 'drive') {
      if (place.kind !== to!.kind) return { text: 'A Google file lives in Google Drive. Export a copy instead.', press: 'export' }
    }
    if (place.env !== to!.env && (entry?.size ?? 0) > COPY_ACROSS_MAX) return { text: `This file is over ${COPY_ACROSS_MAX / 1024 / 1024} MB, too big to copy from ${place.host || place.name}.` }
    if (!to!.can.includes('copy')) return cannot(to!, 'copy')
    // A move across places is a copy, a check, then the source to Trash: the source's place must take the delete.
    if (verb === 'move' && !place.can.includes('trash')) return cannot(place, 'move')
    return null
  }

  if (verb === 'trash' || verb === 'restore' || verb === 'purge') {
    // A delete in a place others see is the provider's own, and stays off until its bin is proven to hold what is deleted.
    if ((place.shared || entry?.shared) && !place.can.includes(verb)) return { text: `Delete it in ${serviceOf(place)}.`, press: 'open-web' }
    if (place.kind === 'lifeos' && !place.can.includes(verb)) return { text: 'LifeOS cannot put a document back yet. Delete it in LifeOS.' }
  }
  if (!place.can.includes(verb)) return cannot(place, verb)
  return null
}

const VERB_WORDS: Record<FileVerb, string> = { make: 'made', upload: 'uploaded', rename: 'renamed', move: 'moved', copy: 'copied', edit: 'changed', trash: 'deleted', restore: 'put back', purge: 'deleted for good' }
function cannot(place: Pick<FilePlace, 'name' | 'vm' | 'can'>, verb: FileVerb): Refusal {
  // A helper in the VM that changes nothing (one built before it could) is the VM's own sentence; one that does says what it does not.
  if (place.vm && !place.can.length) return { text: 'Files in the Windows VM cannot be changed from here yet. Open it there.', press: 'open-here' }
  return { text: `Nothing can be ${VERB_WORDS[verb]} in ${place.name} from here.` }
}

/** Whether `place` does `verb` (`refusal` is null). */
export const canDo = (place: AskedOf, verb: FileVerb, entry?: AskedEntry | null, to?: AskedOf | null): boolean => refusal(place, verb, entry, to) === null

/** Who can open what is put in a shared place, as its question says it; `named`: the team or folder by its name, as a held act's sentence says it. */
export function audienceOf(place: Pick<FilePlace, 'kind' | 'name' | 'group'>, named = false): string {
  if (place.kind === 'teams') return named ? `Everyone in ${place.group ?? place.name} can open it.` : 'Everyone in that team can open it.'
  if (place.kind === 'onedrive') return named ? `Whoever you shared ${place.name} with can open it.` : 'Whoever you shared that folder with can open it.'
  if (place.kind === 'drive') return named ? `Whoever ${place.name} is shared with can open it.` : 'Whoever that folder is shared with can open it.'
  return 'Others can open it.'
}

/**
 * What his window asks before a change others will see, or null when it asks nothing: a copy or a move into
 * a shared place, and a delete in one. Asked once a change, by his own window; an agent's change there is
 * held instead (the outbox's `file.act`).
 */
export function questionFor(place: AskedOf & Pick<FilePlace, 'group'>, verb: FileVerb, entry?: AskedEntry | null, to?: (AskedOf & Pick<FilePlace, 'group'>) | null): string | null {
  const across = !!to && to.id !== place.id
  if (across && (verb === 'copy' || verb === 'move') && to!.shared) return `${verb === 'copy' ? 'Copy' : 'Move'} to ${to!.name}? ${audienceOf(to!)}`
  if (verb === 'trash' && (place.shared || entry?.shared)) return 'Delete for everyone?'
  return null
}

// ── a file in a message ───────────────────────────────────────────────

/** The most files one message is about: the composer's own most chips. */
export const FILE_CHIPS_MOST = 8
export const TOO_MANY_FILES = `A message can hold ${FILE_CHIPS_MOST} files at most.`
export const NO_FOLDER_CHIPS = 'Only files go in a message, not folders.'

/** A file's path on its host's disk, where its source names one. */
const diskPath = (ref: CanvasSource): string | null => (ref.at === 'file' ? ref.path : ref.at === 'microsoft' && ref.ref.kind === 'path' ? ref.ref.path : null)

/** A file's path inside a place in words (`Events/Poster.png`), from the place's top folder; its name alone where the place has no folder on a disk. */
function pathInPlace(place: Pick<FilePlace, 'root'>, ref: CanvasSource, name: string): string {
  const top = place.root.at === 'file' ? place.root.path.replace(/[\\/]+$/, '') : null
  const path = diskPath(ref)
  if (top === null || path === null || !path.startsWith(top) || !/^[\\/]/.test(path.slice(top.length))) return name
  return path.slice(top.length).split(/[\\/]+/).filter(Boolean).join('/')
}

/**
 * A row as the `file` chip a message is about: its name, its source (what `canvas_open` takes) and, where known, its
 * place and its path inside it in words (what `files_open` takes): the row's own `where` in a lens, else the place
 * its page is in. Nothing from inside the file. A folder, and a thread's own item, are no chip.
 */
export function fileChipOf(entry: FileEntry, place?: Pick<FilePlace, 'id' | 'name' | 'shared' | 'root'> | null): ContextChip | null {
  if (!entry.ref || entry.folder || entry.ref.at === 'thread') return null
  const shared = entry.shared ?? place?.shared
  const where = entry.where
    ? { place: entry.where.place, name: entry.where.name, path: [...entry.where.trail, entry.name].join('/') }
    : place
      ? { place: place.id, name: place.name, path: pathInPlace(place, entry.ref, entry.name) }
      : null
  return { kind: 'file', label: entry.name, ref: entry.ref, ...(where ? { where: { ...where, ...(shared ? { shared: true } : {}) } } : {}) }
}

/** Rows dragged into a composer, or asked about from the selection bar: a chip each, eight at most; a ninth refuses them all in one sentence, and so does a choice of folders alone (a folder among files is left out). */
export function chipsOf(entries: readonly FileEntry[], place?: Pick<FilePlace, 'id' | 'name' | 'shared' | 'root'> | null): { chips: ContextChip[] } | { refused: string } {
  const chips = entries.flatMap((e) => fileChipOf(e, place) ?? [])
  if (chips.length > FILE_CHIPS_MOST) return { refused: TOO_MANY_FILES }
  if (!chips.length) return { refused: NO_FOLDER_CHIPS }
  return { chips }
}

/** The most a text file may be to be edited in place (its bytes, and so the characters a save carries). */
export const FILE_TEXT_MAX = 2 * 1024 * 1024

/** The most entries, and bytes, one page of a listing carries. */
export const LIST_PAGE_MAX = 500
export const LIST_PAGE_BYTES = 512 * 1024
