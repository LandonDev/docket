import { z } from 'zod'
import { CanvasKindSchema, CanvasSourceSchema, type CanvasItem, type CanvasSource } from './work/canvas'
import { ENTRY_KINDS, FILE_SORTS, type FileEntry, type FilePlace, type FolderRef } from './work/files'
import { request, type CapsOf, type RelayOf } from './work/wire'

/**
 * The files pillar's wire (docs/agents/work-files.md "The wire"): the Files place of a Work workspace. Every
 * place a file can live in is listed through one grammar (src/shared/work/files.ts), the open tabs belong to
 * the workspace and are kept on its host, and every change goes through one door on the host (files/policy.ts).
 *
 * Verbs are one word, so `ctx.peer` carries them to another host of his. A file is named by a `CanvasSource`
 * and a folder by a `FolderRef`; a folder on a disk is `{ at: 'file', host, path }`, the tag the listener's
 * path fence reads wherever it sits, so no method here has a param named `path`.
 */

const Workspace = z.string().min(1).max(200)
/** The id of one change: a retry after a lost answer names the same one, and the host answers what the first did. */
const Op = z.string().min(8).max(100)
const Name = z.string().min(1).max(500)

export const FolderRefSchema = z.discriminatedUnion('at', [
  z.object({ at: z.literal('file'), host: z.string().max(200), path: z.string().min(1).max(4096) }),
  z.object({ at: z.literal('drive'), account: z.string().min(1).max(320), folderId: z.string().min(1).max(200) }),
  z.object({ at: z.literal('project'), id: z.string().min(1).max(200) }),
  z.object({ at: z.literal('place'), id: z.string().min(1).max(200) })
])
/** A file or a folder, for a verb that takes either: a folder on a disk and a file on one are the same words, and the host looks. */
export const FileRefSchema = z.union([CanvasSourceSchema, FolderRefSchema])
export type FileRef = CanvasSource | FolderRef

export const FileSortSchema = z.object({ by: z.enum(FILE_SORTS), dir: z.enum(['asc', 'desc']) })

/** Where a page tab stands: a folder or a lens, the words its tab says, and the search it shows when it is one. */
export const FilePageSchema = z.object({ at: FolderRefSchema, name: z.string().max(500), query: z.string().max(200).optional() })
export type FilePage = z.infer<typeof FilePageSchema>

/** What a search may be narrowed by. `who`: `me`, `agent`, or a name as the file's store says it. */
export const FileSearchFilterSchema = z.object({
  kinds: z.array(z.enum(ENTRY_KINDS)).max(ENTRY_KINDS.length).optional(),
  places: z.array(z.string().max(200)).max(50).optional(),
  project: z.string().max(200).optional(),
  who: z.string().max(200).optional(),
  after: z.number().int().nonnegative().optional(),
  before: z.number().int().nonnegative().optional(),
  shared: z.boolean().optional(),
  review: z.boolean().optional()
})
export type FileSearchFilter = z.infer<typeof FileSearchFilterSchema>

/**
 * Where a change began, for one that reaches this host from another host of his (`ctx.peer`): his own press in
 * a window there, which that host admitted, or a held act he pressed (its id, and the digest of exactly this
 * change). A peer's change with no origin is refused; from any other caller the field is not read.
 */
export const FileOriginSchema = z.discriminatedUnion('from', [
  z.object({ from: z.literal('window') }),
  z.object({ from: z.literal('act'), id: z.string().min(1).max(200), digest: z.string().min(16).max(128) })
])
export type FileOrigin = z.infer<typeof FileOriginSchema>

/**
 * `asked` on a change: his window asked its one question for it (`questionFor`, src/shared/work/files.ts) and
 * he said yes. The host refuses a window's change that others will see without it; it is not read from a thread.
 */

/** What New makes. */
export const FILE_MAKE_KINDS = ['document', 'sheet', 'deck', 'text', 'folder'] as const
export type FileMakeKind = (typeof FILE_MAKE_KINDS)[number]

/** The edge of a picture a thumbnail is asked at: the grid's three tile sizes, at twice their pixels. */
export const THUMB_SIZES = [192, 288, 416] as const

export const FilesRequestSchemas = [
  /** → FilesPlaces: this host's places for the workspace and each one's state. Never waits on a Windows VM. */
  request('work.files.places', z.object({ workspaceId: Workspace })),
  /** → FilesListing: one folder or lens, a page at a time (`LIST_PAGE_MAX` entries, `LIST_PAGE_BYTES`). `cursor` is the last answer's `next`; a folder that changed between pages answers `stale`, and the window lists again. */
  request('work.files.list', z.object({ workspaceId: Workspace, at: FolderRefSchema, cursor: z.string().max(4000).optional(), sort: FileSortSchema.optional(), foldersOnly: z.boolean().optional() })),
  /** → { entries: (FileEntry | null)[] }: the rows again with what a list leaves out (who last saved it), for the rows on screen; null for one that is gone or out of reach. */
  request('work.files.stat', z.object({ workspaceId: Workspace, refs: z.array(FileRefSchema).min(1).max(100) })),
  /** → FilesHome: Waiting on you, Starred, Recent. */
  request('work.files.home', z.object({ workspaceId: Workspace })),
  /** → { entries: FileEntry[] }: Go to's list as he types: names this host has seen, recents first. */
  request('work.files.names', z.object({ workspaceId: Workspace, text: z.string().max(200) })),
  /** → FilesListing: names in every place of this host, and text where a place has it. */
  request('work.files.search', z.object({ workspaceId: Workspace, query: z.string().max(200), filter: FileSearchFilterSchema.optional(), cursor: z.string().max(4000).optional() })),
  /** → { searches: SavedFileSearch[] } */
  request('work.files.searches', z.object({ workspaceId: Workspace })),
  /** → { threads: { sessionId, itemId, source }[] }: the workspace's threads whose open items show this file, newest first. */
  request('work.files.threads', z.object({ workspaceId: Workspace, ref: CanvasSourceSchema })),
  /** → { entry }: downloads a file its place keeps in the cloud, on its own host, and answers it as it is now. */
  request('work.files.fetch', z.object({ workspaceId: Workspace, ref: CanvasSourceSchema })),
  /** → { data, size, version, end }: base64 bytes of a file in the workspace's own folder only, for the phone's Open the original. `version` is the one the first call answered: a file that changed since fails as stale. */
  request('work.files.read', z.object({ workspaceId: Workspace, ref: CanvasSourceSchema, offset: z.number().int().nonnegative(), length: z.number().int().positive().max(4 * 1024 * 1024), version: z.string().max(200).optional() })),
  /** → FilePreview: one page of a file as a PNG, made on the file's own host. */
  request('work.files.preview', z.object({ workspaceId: Workspace, ref: CanvasSourceSchema, page: z.number().int().min(1).max(20).optional(), width: z.number().int().min(64).max(2048) })),
  /** → { thumbs: (string | null)[] }: a small picture of each file, base64 PNG; null where there is none to show. */
  request('work.files.thumbs', z.object({ workspaceId: Workspace, refs: z.array(CanvasSourceSchema).min(1).max(40), size: z.union([z.literal(THUMB_SIZES[0]), z.literal(THUMB_SIZES[1]), z.literal(THUMB_SIZES[2])]) })),
  /** → FilesTabs: the workspace's open tabs, in order. */
  request('work.files.tabs', z.object({ workspaceId: Workspace })),
  /**
   * → FilesOpened: opens a file in a tab of its own, beside `opener` (the tab it came from), or selects the tab
   * that already holds it: never twice. The host picks the canvas kind by the file's name (`as` overrules it:
   * Open as a document). `beside`: the file goes in that window's Beside seat instead, which is no tab.
   */
  request('work.files.open', z.object({ workspaceId: Workspace, ref: CanvasSourceSchema, name: Name.optional(), as: CanvasKindSchema.optional(), opener: z.string().max(100).optional(), beside: z.string().min(1).max(64).optional() })),
  /** → FilesTabs: a new page tab, after `after` (last when absent). */
  request('work.files.tabOpen', z.object({ workspaceId: Workspace, page: FilePageSchema, after: z.string().max(100).optional() })),
  /** → FilesTabs: closes a tab; a file tab's item goes with it, in the same transaction. */
  request('work.files.tabClose', z.object({ workspaceId: Workspace, tabId: z.string().max(100) })),
  /** → FilesTabs: moves a tab before `before` (last when null). */
  request('work.files.tabMove', z.object({ workspaceId: Workspace, tabId: z.string().max(100), before: z.string().max(100).nullable() })),
  /** → FilesTabs: where a page tab stands now. */
  request('work.files.tabSet', z.object({ workspaceId: Workspace, tabId: z.string().max(100), page: FilePageSchema })),
  /** → { starred } */
  request('work.files.star', z.object({ workspaceId: Workspace, ref: FileRefSchema, name: Name, on: z.boolean() })),
  /** → null: he opened it: it is recent, and no longer new from a thread. */
  request('work.files.seen', z.object({ workspaceId: Workspace, ref: CanvasSourceSchema, name: Name })),
  /** → SavedFileSearch */
  request('work.files.saveSearch', z.object({ workspaceId: Workspace, id: z.string().max(100).optional(), name: z.string().min(1).max(200), query: z.string().max(200), filter: FileSearchFilterSchema.optional() })),
  /** → null */
  request('work.files.dropSearch', z.object({ workspaceId: Workspace, id: z.string().max(100) })),
  /** → FileDone: makes a new thing in the folder (a lens: the workspace's folder), named for its kind unless `name` says; `from` copies a template. */
  request('work.files.make', z.object({ workspaceId: Workspace, at: FolderRefSchema, kind: z.enum(FILE_MAKE_KINDS), name: Name.optional(), from: CanvasSourceSchema.optional(), op: Op, origin: FileOriginSchema.optional(), asked: z.boolean().optional() })),
  /** → FileDone */
  request('work.files.rename', z.object({ workspaceId: Workspace, ref: FileRefSchema, name: Name, op: Op, origin: FileOriginSchema.optional() })),
  /** → FileDone: inside one place a move is one rename; across places a copy, a check, then the source to Trash. */
  request('work.files.move', z.object({ workspaceId: Workspace, refs: z.array(FileRefSchema).min(1).max(100), to: FolderRefSchema, op: Op, origin: FileOriginSchema.optional(), asked: z.boolean().optional() })),
  /** → FileDone */
  request('work.files.copy', z.object({ workspaceId: Workspace, refs: z.array(FileRefSchema).min(1).max(100), to: FolderRefSchema, op: Op, origin: FileOriginSchema.optional(), asked: z.boolean().optional() })),
  /** → FileDone */
  request('work.files.trash', z.object({ workspaceId: Workspace, refs: z.array(FileRefSchema).min(1).max(100), op: Op, origin: FileOriginSchema.optional(), asked: z.boolean().optional() })),
  /** → FileDone: puts Trash rows back where they were. */
  request('work.files.restore', z.object({ workspaceId: Workspace, ids: z.array(z.string().max(100)).min(1).max(100), op: Op })),
  /** → { uploadId }: a file from a desktop or a phone into a folder; its bytes then go as `attachment.chunk`, `attachment.commit` or `attachment.abort` on that id. */
  request('work.files.upload', z.object({ workspaceId: Workspace, at: FolderRefSchema, name: Name, size: z.number().int().nonnegative(), sha256: z.string().regex(/^[0-9a-f]{64}$/), op: Op, asked: z.boolean().optional() })),
  /** → { purged }: Empty Trash, for the workspace; `ids`: only those rows. */
  request('work.files.purge', z.object({ workspaceId: Workspace, ids: z.array(z.string().max(100)).max(1000).optional() }))
] as const

/** What `work.files.places` answers. `rev` is the tabs' revision, so a window knows whether its tabs are current. */
export interface FilesPlaces {
  host: string
  places: FilePlace[]
  rev: number
}

/** One step of a folder's trail: the place first, then each folder down to the one shown. */
export interface FileCrumb {
  name: string
  at: FolderRef
}

export interface FilesListing {
  entries: FileEntry[]
  /** the next page's cursor; absent at the end */
  next?: string
  /** the folder changed since the cursor's page: list it again from the top (`entries` is empty) */
  stale?: true
  /** with the first page: the place it is in and the trail to it */
  place?: string
  trail?: FileCrumb[]
  /** when what is listed was read, for a list kept from before (a machine asleep) */
  asOf?: number
  /** a search stopped before the end of what it could look through */
  more?: true
}

/** One open tab. A page tab stands on a folder or a lens; a file tab holds one canvas item of the workspace's Files pane (`filesPaneOf`). */
export interface FileTab {
  id: string
  kind: 'page' | 'file'
  /** as the tab says it: the folder's or the file's name ('' where the caller may not know the file) */
  name: string
  /** a page tab: where it stands */
  page?: FilePage
  /** a file tab: its item, and the file's key */
  itemId?: string
  key?: string
  /** the tab it was opened from: closing it returns there */
  opener?: string
}
export interface FilesTabs {
  rev: number
  tabs: FileTab[]
}
export interface FilesOpened extends FilesTabs {
  /** the tab that holds the file now (absent for the Beside seat) */
  tabId?: string
  item: CanvasItem
}

export interface FilesHome {
  waiting: FileEntry[]
  starred: FileEntry[]
  recent: FileEntry[]
}

export interface SavedFileSearch {
  id: string
  name: string
  query: string
  filter?: FileSearchFilter
}

/** A preview page, or why there is none (`none`: one sentence for the tile's place). */
export type FilePreview = { png: string; pages: number; width: number; height: number } | { none: string }

/** What a change did, and how to take it back. */
export interface FileDone {
  /** the things as they are now: what was made, renamed, moved or copied */
  entries: FileEntry[]
  /** what could not be done, each with its one sentence; the rest was done */
  refused: { name: string; text: string }[]
  /** Trash rows a delete made: Put back restores them */
  trashed?: string[]
  /** the same change again answers this, and does nothing twice */
  op: string
}

/**
 * Something of a workspace's Files changed on this host: a folder's listing (`at`: its key, `refKey`), the open
 * tabs (`tabs`: their new revision), or the places and their states. A window re-asks what it shows. A push
 * about a folder goes only to callers that could name it.
 */
export type FilesPush = { push: 'work.files'; workspaceId: string; at?: string; tabs?: number; places?: true }

export const FILES_CAPS = {
  'work.files.places': 'read',
  'work.files.list': 'read',
  'work.files.stat': 'read',
  'work.files.home': 'read',
  'work.files.names': 'read',
  'work.files.search': 'read',
  'work.files.searches': 'read',
  'work.files.threads': 'read',
  'work.files.fetch': 'read',
  'work.files.read': 'read',
  'work.files.preview': 'read',
  'work.files.thumbs': 'read',
  'work.files.tabs': 'read',
  'work.files.open': 'operate',
  'work.files.tabOpen': 'operate',
  'work.files.tabClose': 'operate',
  'work.files.tabMove': 'operate',
  'work.files.tabSet': 'operate',
  'work.files.star': 'operate',
  'work.files.seen': 'operate',
  'work.files.saveSearch': 'operate',
  'work.files.dropSearch': 'operate',
  // Each change needs `approve` too where others can open the place: the host's one door decides (files/policy.ts).
  'work.files.make': 'operate',
  'work.files.rename': 'operate',
  'work.files.move': 'operate',
  'work.files.copy': 'operate',
  'work.files.trash': 'operate',
  'work.files.restore': 'operate',
  'work.files.upload': 'operate',
  'work.files.purge': 'approve'
} satisfies CapsOf<typeof FilesRequestSchemas>

// A file's bytes, a picture of it and every change are carried to a far host only while its screen is unlocked,
// as `work.canvas.fetch` is; emptying Trash is never carried.
export const FILES_RELAY = {
  'work.files.fetch': 'screen',
  'work.files.read': 'screen',
  'work.files.preview': 'screen',
  'work.files.thumbs': 'screen',
  'work.files.make': 'screen',
  'work.files.rename': 'screen',
  'work.files.move': 'screen',
  'work.files.copy': 'screen',
  'work.files.trash': 'screen',
  'work.files.restore': 'screen',
  'work.files.upload': 'screen',
  'work.files.purge': 'never'
} satisfies RelayOf<typeof FilesRequestSchemas>
