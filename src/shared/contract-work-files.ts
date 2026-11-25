import { z } from 'zod'
import { CanvasKindSchema, CanvasSourceSchema, type CanvasItem, type CanvasSource } from './work/canvas'
import { COPY_ACROSS_MAX, ENTRY_KINDS, FILE_SORTS, FILE_TEXT_MAX, MAKE_KINDS, type FileEntry, type FilePlace, type FolderRef } from './work/files'
import type { TeamsPlace } from './contract-work-office'
import { EDITED_WITHIN, type FindSpec } from './work/docFind'
import { SAVE_AS_IDS } from './work/saveAs'
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

/**
 * What a search may be narrowed by. `who`: `me`, `agent`, or a name as the file's store says it. `within`: changed
 * in a span before now, kept as its word so a saved search stays current; `after` and `before` are fixed times.
 */
export const FileSearchFilterSchema = z.object({
  kinds: z.array(z.enum(ENTRY_KINDS)).max(ENTRY_KINDS.length).optional(),
  places: z.array(z.string().max(200)).max(50).optional(),
  project: z.string().max(200).optional(),
  who: z.string().max(200).optional(),
  within: z.enum(EDITED_WITHIN).optional(),
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
  z.object({
    from: z.literal('window'),
    /** his Undo of a move: each thing as the move left it (its key and version, by the order of the refs); the host that moves it back finds each the same or leaves it */
    things: z.array(z.object({ key: z.string().max(5000), version: z.string().max(200) })).max(100).optional()
  }),
  z.object({
    from: z.literal('act'),
    id: z.string().min(1).max(200),
    digest: z.string().min(16).max(128),
    /** each thing the card named, by the order of the refs, as it was held (its key, version and, where the card said it, who could open it): the host that writes checks them as it acts */
    things: z.array(z.object({ key: z.string().max(5000), version: z.string().max(200), shared: z.boolean().optional() })).max(100).optional(),
    /** the folder a move or copy was held to go to, by its key */
    into: z.string().max(5000).optional(),
    /** who could open that folder as the card said it: a Drive move holds each thing's move to it */
    intoShared: z.boolean().optional()
  })
])
export type FileOrigin = z.infer<typeof FileOriginSchema>

/**
 * `asked` on a change: his window asked its one question for it (`questionFor`, src/shared/work/files.ts) and
 * he said yes. The host refuses a window's change that others will see without it; it is not read from a thread.
 */

/** What New makes. */
export const FILE_MAKE_KINDS = MAKE_KINDS
export type FileMakeKind = (typeof FILE_MAKE_KINDS)[number]

/** The verbs a thread's change in a place others can open is held as (`file.act`): a delete there too, which his press sends to the computer's own bin. */
export const FILE_ACT_VERBS = ['make', 'rename', 'move', 'copy', 'trash'] as const
export type FileActVerb = (typeof FILE_ACT_VERBS)[number]

/**
 * One thing a held file act names, as it was when the act was held: its key, its name, its version
 * (`size:changed:`) and whether others could open it (`shared`, as its place said; absent in an act held before it
 * was bound). The press finds each the same or does nothing.
 */
const FileActThing = z.object({ key: z.string().max(5000), name: Name, version: z.string().max(200), shared: z.boolean().optional() })
/** Where a thing is or goes, in words: the place's id and name, and the folders inside it. */
const FileActWhere = z.object({ place: z.string().max(200), name: z.string().max(500), trail: z.array(z.string().max(500)).max(64) })

/**
 * A held `file.act` (docs/agents/work-files.md "Agents"): a thread's change to a file others can open, exactly
 * as it will run on his press. `request` is what the verb is sent (its digest is `digest`, `changeDigest` in
 * files/policy.ts, so the file's own host runs exactly this change for a peer); `things` and `into` bind each
 * file's and the destination's identity and version, and the press finds them so again or does nothing.
 */
export const FileActSchema = z.object({
  workspaceId: Workspace,
  /** the host whose disk holds the file: the press runs the verb there */
  host: z.string().min(1).max(200),
  verb: z.enum(FILE_ACT_VERBS),
  /** the operation id the verb runs under */
  op: Op,
  request: z.object({
    refs: z.array(FileRefSchema).min(1).max(100),
    to: FolderRefSchema.optional(),
    name: Name.optional(),
    kind: z.enum(FILE_MAKE_KINDS).optional()
  }),
  digest: z.string().min(16).max(128),
  /** for make, the folder it is made in; for the rest, the things changed */
  things: z.array(FileActThing).min(1).max(100),
  /** where they are now */
  from: FileActWhere,
  /** where a move or copy puts them, that folder's key and whether others could open it: the press finds the same folder, shared the same, or does nothing */
  into: FileActWhere.extend({
    key: z.string().max(5000),
    shared: z.boolean().optional(),
    /** a Drive folder's: the keys of the folders above it, top first; a folder Drive moved keeps its id, not these */
    parents: z.array(z.string().max(5000)).max(20).optional()
  }).optional(),
  /** who else can open the result: `audienceOf`'s sentence */
  audience: z.string().max(300)
})
export type FileAct = z.infer<typeof FileActSchema>

/** The most base64 one copy sent back carries: a copy is made of a file of 48 MB at most (`COPY_ACROSS_MAX`). */
export const COPY_DATA_MAX = Math.ceil((COPY_ACROSS_MAX * 4) / 3) + 4

/**
 * What a window may ask of a desktop it has no link to, through the workspace's own host: the listing, and on his own
 * press a delete to that desktop's own bin, its Put back, and a rename or a move inside that desktop (files/across.ts).
 * Opening a file there is a copy (`work.files.open`).
 */
export const FILES_ACROSS = ['work.files.places', 'work.files.list', 'work.files.stat', 'work.files.trash', 'work.files.restore', 'work.files.rename', 'work.files.move'] as const
export type FilesAcross = (typeof FILES_ACROSS)[number]

/** The edge of a picture a thumbnail is asked at: the grid's three tile sizes, at twice their pixels. */
export const THUMB_SIZES = [192, 288, 416] as const

export const FilesRequestSchemas = [
  /** → FilesPlaces: this host's places for the workspace and each one's state. Never waits on a Windows VM. */
  request('work.files.places', z.object({ workspaceId: Workspace })),
  /**
   * → FilesListing: one folder or lens, a page at a time (`LIST_PAGE_MAX` entries, `LIST_PAGE_BYTES`). `cursor` is the last answer's `next`; a folder that changed between pages answers `stale`, and the window lists again.
   * `wake`: his press for this folder, which may wake the Windows VM behind the answer; false for a list he did not press for (a restored tab, a refetch). Absent, a window's first page wakes it, a next page (a `cursor`) never does, and a thread's list never does.
   */
  request('work.files.list', z.object({ workspaceId: Workspace, at: FolderRefSchema, cursor: z.string().max(4000).optional(), sort: FileSortSchema.optional(), foldersOnly: z.boolean().optional(), wake: z.boolean().optional() })),
  /** → { entries: (FileEntry | null)[] }: the rows again with what a list leaves out (who last saved it), for the rows on screen; null for one that is gone or out of reach, and for each row on a mapped or network drive or in the Windows VM when several are asked at once (each look is round trips over the link, or a call in the guest, which names no one who saved). */
  request('work.files.stat', z.object({ workspaceId: Workspace, refs: z.array(FileRefSchema).min(1).max(100) })),
  /**
   * → what `host` answers to `method` (places, a folder's page, the rows on screen): a desktop of his the window has
   * no link to (a PC that links only to the box), asked of the workspace's own host, which asks it over its host
   * link. Only for a desktop the workspace may use and whose binding is live; the desktop answers under its bridge
   * policy for this host, as it answers any host of his. Places come with `name`, the desktop as he names it.
   */
  request('work.files.across', z.object({ workspaceId: Workspace, host: z.string().min(1).max(200), method: z.enum(FILES_ACROSS), params: z.record(z.string(), z.unknown()) })),
  /** → FilesHome: Waiting on you, Starred, Recent. */
  request('work.files.home', z.object({ workspaceId: Workspace })),
  /** → { entries: FileEntry[] }: Go to's list as he types: names this host has seen, recents first. */
  request('work.files.names', z.object({ workspaceId: Workspace, text: z.string().max(200) })),
  /**
   * → FilesListing: names in every place of this host, and text where a place has it. The first page answers with
   * what has come (the names this host holds at once, then each place as it answers): `pending` names the places
   * still searched and `parts` how many have answered, for a caller that sends `seen` (0 the first time); asked again
   * with the `parts` it saw, it answers once more have. Without `seen` the first page is the whole search.
   * `replaces`: the words of the search this one takes the place of in the same tab, whose walks stop now.
   */
  request('work.files.search', z.object({ workspaceId: Workspace, query: z.string().max(200), filter: FileSearchFilterSchema.optional(), cursor: z.string().max(4000).optional(), seen: z.number().int().min(0).max(64).optional(), replaces: z.string().max(200).optional() })),
  /** → { searches: SavedFileSearch[] } */
  request('work.files.searches', z.object({ workspaceId: Workspace })),
  /** → { threads: { sessionId, itemId, source }[] }: the workspace's threads whose open items show this file, newest first. */
  request('work.files.threads', z.object({ workspaceId: Workspace, ref: CanvasSourceSchema })),
  /** → { entry }: downloads a file its place keeps in the cloud, on its own host, and answers it as it is now. */
  request('work.files.fetch', z.object({ workspaceId: Workspace, ref: CanvasSourceSchema })),
  /**
   * → FileBytes: bytes of a file whose bytes are on its host's disk, for the `file` kind's text and the phone's
   * Open the original: one in the workspace's own folder for every caller, one in a library of this host for his
   * own window alone. `version` is the one the first call answered: a file that changed since fails as stale.
   * `itemId`: the read is of a Files tab's own copy of a file on another computer (`ref` is that item's source),
   * for his own window alone.
   */
  request('work.files.read', z.object({ workspaceId: Workspace, ref: CanvasSourceSchema, offset: z.number().int().nonnegative(), length: z.number().int().positive().max(4 * 1024 * 1024), version: z.string().max(200).optional(), itemId: z.string().max(100).optional() })),
  /** → FilePreview: one page of a file as a PNG, made on the file's own host. */
  request('work.files.preview', z.object({ workspaceId: Workspace, ref: CanvasSourceSchema, page: z.number().int().min(1).max(20).optional(), width: z.number().int().min(64).max(2048) })),
  /** → { thumbs: (string | null)[] }: a small picture of each file, base64 PNG; null where there is none to show. */
  request('work.files.thumbs', z.object({ workspaceId: Workspace, refs: z.array(CanvasSourceSchema).min(1).max(40), size: z.union([z.literal(THUMB_SIZES[0]), z.literal(THUMB_SIZES[1]), z.literal(THUMB_SIZES[2])]) })),
  /**
   * → FileArchive: the entries of a `.zip` as its central directory names them, the first `ARCHIVE_ENTRIES_MAX`
   * in its order; nothing is extracted and no entry's bytes are read. Read as `read` is: a file of the workspace's
   * folder for every caller that may read, a shared library's for his own window alone. Another archive type
   * answers no entries, and nothing of it is read.
   */
  request('work.files.archive', z.object({ workspaceId: Workspace, ref: CanvasSourceSchema })),
  /** → FilesTabs: the workspace's open tabs, in order. */
  request('work.files.tabs', z.object({ workspaceId: Workspace })),
  /**
   * → FilesOpened: opens a file in a tab of its own, beside `opener` (the tab it came from), or selects the tab
   * that already holds it: never twice. The host picks the canvas kind by the file's name (`as` overrules it:
   * Open as a document). `beside`: the file goes in that window's Beside seat instead, which is no tab. `side`: it
   * goes at the side of that file tab instead.
   * A file on another host of his, or in the Windows VM, is no file of this disk: it opens as a copy made here
   * (`copyOf` on its tab), where the workspace's Copy Teams files allows one, and is refused otherwise. A copy whose
   * kind edits its bytes saves back to the file by version; any other keeps his changes to itself.
   */
  request(
    'work.files.open',
    z.object({
      workspaceId: Workspace,
      ref: CanvasSourceSchema,
      name: Name.optional(),
      as: CanvasKindSchema.optional(),
      opener: z.string().max(100).optional(),
      beside: z.string().min(1).max(64).optional(),
      /** Open to the Side: the file goes at the side of this file tab, in the same tab; a file a tab of its own holds moves there with its item */
      side: z.string().min(1).max(100).optional(),
      /** the file's key as its listing gave it, for a file this host cannot key itself (one on another host of his): opening it again then answers its tab */
      key: z.string().min(1).max(2000).optional()
    })
  ),
  /** → FilesTabs: a new page tab, after `after` (last when absent). `first`: only while the workspace has no tab at all, so two windows that open an empty place at once make one tab between them. */
  request('work.files.tabOpen', z.object({ workspaceId: Workspace, page: FilePageSchema, after: z.string().max(100).optional(), first: z.boolean().optional() })),
  /**
   * → FilesTabs: closes a tab; a file tab's item goes with it, in the same transaction. A copy whose changes have
   * not reached its file is kept, and sent, until they have; `discard` drops them with the tab.
   */
  request('work.files.tabClose', z.object({ workspaceId: Workspace, tabId: z.string().max(100), /** only the file at the tab's side goes; the tab stays */ side: z.boolean().optional(), discard: z.boolean().optional() })),
  /**
   * → CopyBack: a copy tab's kind saved: the host reads the copy as it lies and sends it to the file it is a copy
   * of when its bytes differ from what that file holds (docs/agents/work-files.md "A copy saves back"). His own
   * edit of that file: his window, or a key that may approve. Answers how sending stands once this send is done.
   */
  request('work.files.copyBack', z.object({ workspaceId: Workspace, tabId: z.string().max(100) })),
  /**
   * → FilesTabs: files of another host his window renamed or moved there; the workspace's copies of them (a tab's
   * `copyOf`, the copy's, Word's and Save As's records) follow to where each now lies. His own act: his window, or a
   * key that may approve. Nothing is read or written on a disk.
   */
  request('work.files.copiesMoved', z.object({ workspaceId: Workspace, moves: z.array(z.object({ from: FileRefSchema, to: FileRefSchema })).min(1).max(100) })),
  /**
   * → FilesTabs: the file as it is on its computer now, in the copy's place; what was not sent is dropped. `writes`: the
   * copy's writes the question he answered showed (`CopyBack.writes`); a copy written since keeps what it holds.
   */
  request('work.files.copyReload', z.object({ workspaceId: Workspace, tabId: z.string().max(100), writes: z.number().int().min(0).optional() })),
  /** → FilesTabs: his copy saved beside the file that changed, under the keep-both name, and the tab shows that file now. */
  request('work.files.copyKeep', z.object({ workspaceId: Workspace, tabId: z.string().max(100) })),
  /**
   * → WordSaved: Save as Word. The document a Word file of another computer became is written as Word over that
   * file by the version it was read at, never over a file that changed there; `keep` puts it beside the file under
   * the keep-both name instead. His own edit of that file: his window, or a key that may approve.
   */
  request('work.files.wordSave', z.object({ workspaceId: Workspace, tabId: z.string().max(100), keep: z.boolean().optional(), /** his press on Replace over a file that changed there */ replace: z.boolean().optional(), /** the change time the Replace dialog named (a window a release behind; it alone is asked again) */ seen: z.number().int().optional(), /** the file's version the Replace named (its conflict's `version`): Replace writes over that version alone, and none named is asked again */ version: z.string().max(200).optional(), /** the window's own save after a pause in his typing */ auto: z.boolean().optional() })),
  /** → FilesTabs: his choice for a Word file opened as its document: save it by itself (`on`), or ask each time. */
  request('work.files.wordAuto', z.object({ workspaceId: Workspace, tabId: z.string().max(100), on: z.boolean() })),
  /**
   * → WrittenBack: a copy's bytes, sent by the workspace's host to the file's own host (its peer verb, never a
   * window's or a key's): written over the file by `version` alone, through the same door as his own save there,
   * or with `copy` beside it under the keep-both name. `origin` is his window's press on the workspace's host.
   */
  /** → FileUploaded: whether OneDrive here has uploaded a file of a library here as it lies; the workspace's host asks after its write (files/uploads.ts). */
  /** `refs`: every file one sweep asks of this host at once, answered `{ results: FileUploaded[] }` in their order (`ref` then stands for the first). */
  request('work.files.uploaded', z.object({ workspaceId: Workspace, ref: CanvasSourceSchema, refs: z.array(CanvasSourceSchema).min(1).max(50).optional() })),
  /** `pieces`: the bytes came before it as `work.files.writeBackPiece` (`data` is then empty), named by `upload`, their count and the whole's SHA-256 */
  request('work.files.writeBack', z.object({ workspaceId: Workspace, ref: CanvasSourceSchema, data: z.string().max(COPY_DATA_MAX), pieces: z.object({ upload: z.string().uuid(), count: z.number().int().min(1).max(64), sha256: z.string().regex(/^[0-9a-f]{64}$/) }).optional(), version: z.string().max(200), /** the version the copy was made of, when `version` is a later one read since (a Word file's save): a move there after it is followed (files/moved.ts `movedAway`) */ base: z.string().max(200).optional(), copy: z.boolean().optional(), /** Save as Word to… a folder there: `ref` names the new file, made under a free name, never over anything */ into: z.boolean().optional(), /** with `into` (Save As) or `copy` (Keep Both): the press's operation id, so the same press sent again answers the file it made */ op: Op.optional(), origin: FileOriginSchema })),
  /** → { ok: true }: one piece (at most 4 MiB) of the bytes a `work.files.writeBack` names next, from the workspace's host alone (its peer verb), kept for that write */
  request('work.files.writeBackPiece', z.object({ workspaceId: Workspace, upload: z.string().uuid(), index: z.number().int().min(0).max(63), data: z.string().max(Math.ceil((4 * 1024 * 1024 * 4) / 3) + 4) })),
  /**
   * → SavedAsWord: Save as Word to…: the document `source` (a .tcdoc, a LifeOS document, a Google Doc) exported as
   * Word from its live text and written as a NEW file into the folder `at` (the workspace's folder, a library here or
   * in its Windows VM, or a library on another host of his), under a free name, never over anything. Through Files'
   * door as New there; his own press: his window, or a key that may approve where others can open the folder.
   */
  request('work.files.saveAsWord', z.object({ workspaceId: Workspace, source: CanvasSourceSchema, at: FolderRefSchema, name: Name.optional(), op: Op })),
  /**
   * → SavedAs: Save As… (files/saveAs.ts): the document `source` written from its live text in `format` into the folder
   * `at`, named `name`. A file of that name there is never written over unasked: the answer is `exists` until his
   * `exists` choice says Replace (over it by the version read now) or Keep Both (a free name). Linked unless `link`
   * is false: each later edit is written to the file again by the host. `place` and `computer` are the names the
   * header says it by. His press alone, through Files' door as New there.
   */
  request('work.files.saveAs', z.object({ workspaceId: Workspace, source: CanvasSourceSchema, at: FolderRefSchema, name: Name.optional(), format: z.enum(SAVE_AS_IDS), link: z.boolean().optional(), place: Name.optional(), computer: Name.optional(), exists: z.enum(['replace', 'keep']).optional(), /** with Replace: the version its question named (`exists.version`); none, or a newer file there, is asked again */ version: z.string().max(200).optional(), op: Op })),
  /** → DocLink[]: the files a document is linked to, oldest first, with how each stands. */
  request('work.files.links', z.object({ workspaceId: Workspace, source: CanvasSourceSchema })),
  /** → DocLink[]: his press on a linked file: Unlink, Retry, Replace (over a change made there) or Keep Both. */
  request('work.files.linkAct', z.object({ workspaceId: Workspace, id: z.string().max(100), act: z.enum(['unlink', 'retry', 'replace', 'keep']), /** with Replace: the version the link showed changed (`DocLink.version`); none, or a newer one there, is asked again */ version: z.string().max(200).optional() })),
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
  request('work.files.trash', z.object({ workspaceId: Workspace, refs: z.array(FileRefSchema).min(1).max(100), op: Op, origin: FileOriginSchema.optional(), asked: z.boolean().optional(), /** his yes to a delete for good, on a drive with no bin (`FilePlace.bin`) */ forGood: z.boolean().optional(), /** the writes his question showed of each open copy, by the key of its file: a copy written since keeps its changes */ writes: z.record(z.string(), z.number().int().nonnegative()).optional() })),
  /** → FileDone: puts Trash rows back where they were. */
  request('work.files.restore', z.object({ workspaceId: Workspace, ids: z.array(z.string().max(160)).min(1).max(100), op: Op, origin: FileOriginSchema.optional() })),
  /** → { uploadId }: a file from a desktop or a phone into a folder; its bytes then go as `attachment.chunk`, `attachment.commit` or `attachment.abort` on that id. */
  request(
    'work.files.upload',
    z.object({
      workspaceId: Workspace,
      at: FolderRefSchema,
      name: Name,
      size: z.number().int().nonnegative(),
      sha256: z.string().regex(/^[0-9a-f]{64}$/),
      op: Op,
      asked: z.boolean().optional(),
      /** Save to TempCode: a place of his own alone; a folder others can open is refused at begin and at commit */
      own: z.boolean().optional()
    })
  ),
  /**
   * → FileSaved: replaces a text file's bytes where it lies, when it is still `version` (a read's); a file that
   * changed since is answered as the conflict and left as it is, and one that is gone is never made again.
   * `copy`: his text is kept beside the file as "Name (mine)" instead, and the file is left alone.
   */
  request('work.files.write', z.object({ workspaceId: Workspace, ref: CanvasSourceSchema, text: z.string().max(FILE_TEXT_MAX), version: z.string().max(200), /** the sha256 of this editor's earlier saves on `version` whose answer never came: a file holding one is written over as his own */ tried: z.array(z.string().regex(/^[0-9a-f]{64}$/)).max(8).optional(), copy: z.boolean().optional(), origin: FileOriginSchema.optional() })),
  /**
   * → { projects: { id, name }[] }: Add to a project… (`on`) and Take out of this project. A LifeOS document or
   * sheet moves into the project (or out of it, to LifeOS's top); any other file is linked to it in LifeOS
   * (`projectItems`), or its link taken away. Passes the door as an edit of the file's place. Answers the file's
   * projects after the change.
   */
  request('work.files.project', z.object({ workspaceId: Workspace, ref: FileRefSchema, projectId: z.string().min(1).max(200), on: z.boolean() })),
  /** → { purged }: Empty Trash, for the workspace; `ids`: only those rows. */
  request('work.files.purge', z.object({ workspaceId: Workspace, ids: z.array(z.string().max(100)).max(1000).optional() }))
] as const

/**
 * What `work.files.places` answers. `rev` is the tabs' revision, so a window knows whether its tabs are current.
 * `sources`: what stands between each source of Teams files on this host and him (OneDrive's folders, OneDrive in
 * the Windows VM), for the one line that says why a place he expects is not listed.
 */
export interface FilesPlaces {
  host: string
  /** the host as he names it: said by the host that asked it for him (`work.files.across`), for a window with no link to it */
  name?: string
  places: FilePlace[]
  rev: number
  sources: TeamsPlace[]
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
  /** a search left these places out, by name, because their machine sleeps and only his press wakes it (the Windows VM) */
  asleep?: string[]
  /** a search matched these places' files by name alone, never the words inside them (a library has no content index here) */
  byName?: string[]
  /** a search's first page: the places still being searched, by name (their rows join as each answers) */
  pending?: string[]
  /** a search's first page: how many of its places have answered (`seen` on the next ask) */
  parts?: number
  /**
   * the folder's machine sleeps (the Windows VM): the rows are what was kept (`asOf`), or none. `waking`: a wake goes on
   * (his press, this one or another), and a `work.files` push names the folder once its rows land; `asleep`: only his
   * press wakes it.
   */
  sleeping?: 'asleep' | 'waking'
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
  /** a file tab that shows a copy made on this host: the host the file itself is on (`vm`: in that host's Windows VM) and its path there. Changes stay in the copy unless `back` is set. */
  copyOf?: { host: string; path: string; vm?: boolean }
  /** a copy whose kind saves: its changes go back to the file (`copyOf`), and this is how that stands */
  back?: CopyBack
  /** a Word file of another computer opened as the document made of it, kept in the workspace's folder: how that file stands */
  word?: WordBack
  /**
   * a copy whose edits go nowhere (a .doc, .rtf or .odt, or a workbook or deck whose computer named no version): they
   * stay in this tab, kept on close for the file's next open until he discards them. `edited`: it holds some.
   */
  stays?: { edited: boolean }
  /** a file in a folder OneDrive syncs (a Teams or OneDrive library), once a save of ours wrote it: whether OneDrive has uploaded it */
  cloud?: CloudBack
  /** a file tab with a second file at its side (Open to the Side): that file's item, key and name. It is in no tab of its own. */
  side?: { itemId: string; key: string; name: string }
}
/**
 * How sending a copy back stands (docs/agents/work-files.md "A copy saves back"):
 *  - `ok`: no send is under way or refused; `at`: when the file was last known to hold the copy (absent: not since it was read)
 *  - `sending`: a send is on its way
 *  - `changed`: the file changed on its computer since the copy was read or last sent; `at`: when it changed
 *  - `gone`: the file was moved or deleted there
 *  - `away`: its computer did not answer; the changes wait here and are sent when it does
 *  - `refused`: its computer refused the save; `detail` is its sentence
 */
export interface CopyBack {
  is: 'ok' | 'sending' | 'changed' | 'gone' | 'away' | 'refused'
  at?: number
  detail?: string
  /** how many times an editor replaced the copy's bytes (absent from an older host) */
  writes?: number
  /** the last of those writes the file holds: Saved is said only when it is `writes`, of a write made after his edit began */
  held?: number
}
/**
 * What OneDrive has done with a file our save wrote into a folder it syncs (docs/agents/work-files.md "Saved is not
 * uploaded"): the computer holding the bytes is not the file in Teams.
 *  - `uploading`: the computer holds them; OneDrive has not uploaded them yet. `at`: when they were written
 *  - `uploaded`: OneDrive marked the file in sync with the cloud; `at`: when that was seen
 *  - `late`: still not uploaded a while after the write; `why`: what is known of it (the VM asleep, OneDrive not running
 *    or signed out; absent: OneDrive may be paused). `at`: when they were written
 *  - `unknown`: the computer cannot say (a Mac, an older VM helper); `at`: when they were written
 */
export interface CloudBack {
  is: 'uploading' | 'uploaded' | 'late' | 'unknown'
  at: number
  why?: 'asleep' | 'stopped' | 'signed-out'
}
/**
 * A Word file opened as a document (docs/agents/work-files.md "A Word file from another computer"): his edits are
 * kept in the document; the Word file changes only by his Save as Word. `at`: when that last went; `since`: the
 * document holds edits the Word file has not (always, before the first save).
 */
export interface WordBack {
  at?: number
  since: boolean
  /** saves by itself after a pause in his typing: true; asks each time: false; not asked yet: absent */
  auto?: boolean
  /** an autosave met a change made there at this time: nothing is written until his Replace or Keep Both */
  stopped?: number
  /** the version of that change: his Replace writes over it alone */
  stoppedVersion?: string
  /** the last autosave was refused, in the holder's words (a policy, a fence): no save has landed since */
  refused?: string
}
/** What Save as Word answers: written over the file, the file changed there or went (nothing written), or kept beside it. */
export type WordSaved = { at: number } | { conflict: { changed: number; version?: string } | { gone: true } } | { copy: { name: string } }
/** What a copy's own host answers a send back: the file's version after it, the conflict, or the keep-both file it made. */
/** Save as Word to…: the Word file made, by its name and where it lies. */
export interface SavedAsWord {
  name: string
  ref: CanvasSource
}
/**
 * `uploaded`: OneDrive here has the file as it lies (true), not yet (false), or cannot say on this computer (null).
 * `outside`: the file lies in no folder OneDrive syncs here; there is no upload to tell of.
 */
export interface FileUploaded {
  uploaded: boolean | null
  outside?: boolean
}
export type WrittenBack = { version: string; changed: number } | { conflict: { version: string; changed: number } | { gone: true; /** the file was renamed or moved there after the copy's version: where it lies now, under the same door */ movedTo?: string } } | { copy: { path: string; name: string; version: string; changed: number } }

export interface FilesTabs {
  rev: number
  tabs: FileTab[]
}
/** The id of a window's Beside seat on the workspace's host: what `tabClose` takes to let the seat go. It is no tab and is in no list. */
export const besideSeatId = (window: string): string => `seat:${window}`

export interface FilesOpened extends FilesTabs {
  /** the tab that holds the file now (absent for the Beside seat, and when a thread holds it) */
  tabId?: string
  item?: CanvasItem
  /**
   * A thread of the workspace already shows this file, and its kind keeps its marks by item (a deck's; a PDF's
   * or a video's when the tab would be a copy of another computer's file): no second seat is made, and the window
   * shows that thread's item instead. A PDF or a video on this computer keeps its marks by the file, so it opens
   * in a tab and shares them with the thread.
   */
  held?: { sessionId: string; itemId: string }
}

export interface FilesHome {
  waiting: FileEntry[]
  starred: FileEntry[]
  recent: FileEntry[]
}

/**
 * A saved search: one row of the docs pillar's saved views (`work_docs_views`), read through the mapping in
 * src/shared/work/fileSearch.ts. `docs` is that view's own spec as Docs keeps it, so its grouping, order,
 * layout and the filters only Docs can say are kept when Files saves the search again.
 */
export interface SavedFileSearch {
  id: string
  name: string
  query: string
  filter?: FileSearchFilter
  docs?: FindSpec
}

/** What `work.files.read` answers: `data` is base64, `size` the whole file's, `changed` its change time (epoch ms), `end` whether this read reached its end. */
export interface FileBytes {
  data: string
  size: number
  version: string
  changed: number
  end: boolean
  /** why this caller cannot change the file where it lies, in one sentence; absent when a save would be taken */
  locked?: string
}

/** What a save did: the file's new version; the conflict (what the file is now, or that it is gone); or the copy his text was kept as. */
export type FileSaved = { version: string; changed: number } | { conflict: { version: string; changed: number } | { gone: true; /** the file was renamed or moved there after the copy's version: where it lies now, under the same door */ movedTo?: string } } | { copy: FileEntry }

/** The most entries `work.files.archive` answers. */
export const ARCHIVE_ENTRIES_MAX = 2000
/** What `work.files.archive` answers: each entry's path inside the zip, its size once extracted and whether it is a folder; `more`: the zip holds more than were listed. */
export interface FileArchive {
  entries: { name: string; size: number; dir: boolean }[]
  more: boolean
}

/** A preview page, or why there is none (`none`: one sentence for the tile's place). */
/** `version`: the file's version the page is of, as a digest; pages of one file read across a save differ in it. */
export type FilePreview = { png: string; pages: number; width: number; height: number; version?: string } | { none: string; version?: string }

/** What a change did, and how to take it back. */
export interface FileDone {
  /** the things as they are now: what was made, renamed, moved or copied */
  entries: FileEntry[]
  /** what could not be done, each with its one sentence; the rest was done. `unknown`: its disk did not say whether it was done (a mapped drive gone mid-delete) */
  refused: { name: string; text: string; unknown?: boolean }[]
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
/** How far a copy of another computer's file has got, for the row that opened it: `of` is that row's key as `openingTag` makes it, never its path. */
export type FilesOpening = { of: string; done: number; total: number }
/** `marks`: his stars, recents or what threads made changed (Home reads again on it alone). */
export type FilesPush = { push: 'work.files'; workspaceId: string; at?: string; tabs?: number; places?: true; marks?: true; opening?: FilesOpening }

export const FILES_CAPS = {
  'work.files.places': 'read',
  // The far host checks what each method needs again, under its own bridge policy for this one.
  'work.files.across': 'read',
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
  'work.files.archive': 'read',
  'work.files.tabs': 'read',
  'work.files.open': 'operate',
  'work.files.tabOpen': 'operate',
  'work.files.tabClose': 'operate',
  // His own edit of the file the copy is of: `approve` too, since others can open it (files/copies.ts).
  'work.files.copyBack': 'operate',
  'work.files.copiesMoved': 'operate',
  'work.files.copyReload': 'operate',
  'work.files.copyKeep': 'operate',
  'work.files.wordSave': 'operate',
  'work.files.wordAuto': 'operate',
  // Another host of his only: the workspace's host sending a copy back (its origin says his window's press).
  'work.files.writeBack': 'operate',
  'work.files.writeBackPiece': 'operate',
  // Another host of his only: whether OneDrive here uploaded what that write left.
  'work.files.uploaded': 'read',
  'work.files.saveAsWord': 'operate',
  'work.files.saveAs': 'operate',
  'work.files.links': 'read',
  'work.files.linkAct': 'operate',
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
  'work.files.write': 'operate',
  'work.files.project': 'operate',
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
  'work.files.write': 'screen',
  'work.files.copyBack': 'screen',
  'work.files.copyReload': 'screen',
  'work.files.copyKeep': 'screen',
  'work.files.wordSave': 'screen',
  'work.files.wordAuto': 'screen',
  'work.files.writeBack': 'screen',
  'work.files.writeBackPiece': 'screen',
  'work.files.saveAsWord': 'screen',
  'work.files.saveAs': 'screen',
  'work.files.links': 'screen',
  'work.files.linkAct': 'screen',
  'work.files.project': 'screen',
  'work.files.purge': 'never'
} satisfies RelayOf<typeof FilesRequestSchemas>
