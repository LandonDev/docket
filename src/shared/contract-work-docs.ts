import { z } from 'zod'
import { CanvasSourceSchema } from './work/canvas'
import { EDITED_WITHIN, FIND_BY, FIND_GROUPS, FIND_KINDS, FIND_SORTS, FIND_WHERE, type FindEntry } from './work/docFind'
import { request, type CapsOf, type RelayOf } from './work/wire'

/**
 * The docs pillar's wire (docs/agents/work-docs.md): a document open in a
 * canvas or the Docs view, its live socket carried over the host's own link,
 * its comment threads, and who the agent writes as. Its methods are
 * `work.docs.<verb>` and its push `work.docs`; src/shared/work/wire.ts has
 * the helpers and the rules.
 *
 * A source is a LifeOS document (`{ at: 'lifeos', table: 'docs' }`), a
 * LifeOS project note that is a document (`table: 'projectDocs'`), or a
 * `.tcdoc` on this host. Every method names the source, not a canvas item, so
 * the Docs view opens a document with no thread.
 */

/** How the agent's own ideas land: written with Undo, or waiting as suggestions. A shared document always suggests. */
export type DocMode = 'suggests' | 'writes'

/** The last direct write an agent made, for the "Wrote 2 sections, 2:04 PM" line and its Undo. */
export interface DocWritten {
  text: string
  at: number
  /** the version cut just before the write: its Undo restores it (`work.history.restore`) */
  versionId: string
}

export interface DocOpen {
  /** the Work service's name for it: a LifeOS doc id, or `file:<hash>` for a `.tcdoc` */
  doc: string
  /** the source to name in later calls: a project note resolves to its document */
  source: z.infer<typeof CanvasSourceSchema>
  title: string
  /** edit, or view for a caller that may only read */
  role: 'edit' | 'view'
  /** others can edit it: the agent's own ideas wait as suggestions */
  shared: boolean
  mode: DocMode
  written: DocWritten | null
  /** this caller's principal, as the document's comment rows name it */
  me: string
  /** words for each principal the document's rows name, as history's answers carry */
  names: Record<string, string>
}

export interface DocToken {
  token: string
  /** ms since the epoch */
  expiresAt: number
}

/** A thread row as the shared editor reads it (work-kit `ThreadRow`); ids are the store's own. */
export interface DocThreadRow {
  thread: {
    publicId: string
    quote?: string
    resolved: boolean
    resolvedAt: number | null
    resolvedByMemberId: string | null
    createdAt: number
    updatedAt: number
    deletedAt: number | null
  }
  comments: Array<{
    publicId: string
    body: string
    authorMemberId: string
    reactions: Array<{ emoji: string; createdAt: number; memberIds: string[] }>
    createdAt: number
    updatedAt: number
    deletedAt: number | null
  }>
}

/** A change to a document's threads, one of the shared editor's writes (`ThreadWriteApi`). */
export const DocThreadOpSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('create'), body: z.string().min(1).max(40_000), quote: z.string().max(2000).optional() }),
  z.object({ op: z.literal('reply'), threadId: z.string().min(1).max(64), body: z.string().min(1).max(40_000) }),
  z.object({ op: z.literal('edit'), commentId: z.string().min(1).max(64), body: z.string().min(1).max(40_000) }),
  z.object({ op: z.literal('deleteComment'), commentId: z.string().min(1).max(64) }),
  z.object({ op: z.literal('deleteThread'), threadId: z.string().min(1).max(64) }),
  z.object({ op: z.literal('resolve'), threadId: z.string().min(1).max(64), resolved: z.boolean() }),
  z.object({ op: z.literal('react'), commentId: z.string().min(1).max(64), emoji: z.string().min(1).max(16), reacted: z.boolean() })
])
export type DocThreadOp = z.infer<typeof DocThreadOpSchema>

/** What `work.docs.find` answers (main/server/work/docs/find.ts). */
export interface FindAnswer {
  entries: FindEntry[]
  projects: { id: string; name: string }[]
  /** text matches for `query`: an entry's key and the words around its first match */
  hits: { key: string; snippet: string }[]
  /** false when a place held more than was read */
  complete: boolean
  /** why LifeOS's part is missing, when it is */
  lifeos?: string
}

const id = z.string().min(1).max(200)
const list = <T extends readonly [string, ...string[]]>(values: T) => z.array(z.enum(values)).max(values.length).optional()

/** A view's filters (shared/work/docFind.ts `FindFilter`). */
export const FindFilterSchema = z.object({
  projects: z.array(z.string().max(64)).max(200).optional(),
  kinds: list(FIND_KINDS),
  where: list(FIND_WHERE),
  shared: z.boolean().optional(),
  by: list(FIND_BY),
  within: z.enum(EDITED_WITHIN).optional(),
  after: z.number().int().optional(),
  before: z.number().int().optional(),
  review: z.boolean().optional(),
  held: z.boolean().optional()
})
/** What a saved view keeps (`FindSpec`). */
export const FindSpecSchema = z.object({
  query: z.string().max(500),
  filter: FindFilterSchema,
  group: z.enum(FIND_GROUPS),
  sort: z.enum(FIND_SORTS),
  layout: z.enum(['list', 'table'])
})

/** One relayed socket's frames, each a Hocuspocus message in base64. */
const frames = z.array(z.string().max(6_000_000)).max(200)
const socketId = z.string().regex(/^[A-Za-z0-9_-]{16,64}$/)

export const DocsRequestSchemas = [
  /** → DocOpen */
  request('work.docs.open', z.object({ source: CanvasSourceSchema })),
  /** → DocToken: a collaboration token for the document, as this caller (edit, or view for a read-only key) */
  request('work.docs.token', z.object({ source: CanvasSourceSchema })),
  /** → { socket }: a socket to the document on the host that serves it, relayed over this link */
  request('work.docs.connect', z.object({ source: CanvasSourceSchema })),
  /** → { ok: true }: frames for the relayed socket, in order */
  request('work.docs.send', z.object({ socket: socketId, frames })),
  /** → { frames, closed? }: what the socket received since the last ask; waits up to 20 s for something */
  request('work.docs.recv', z.object({ socket: socketId })),
  /** → { ok: true } */
  request('work.docs.close', z.object({ socket: socketId })),
  /** → { rows: DocThreadRow[]; names }: names for each author a row holds */
  request('work.docs.threads', z.object({ source: CanvasSourceSchema })),
  /** → the row made (create), the comment made (reply), or { ok: true } */
  request('work.docs.thread', z.object({ source: CanvasSourceSchema, change: DocThreadOpSchema })),
  /** → DocOpen: how the agent's own ideas land on this document */
  request('work.docs.mode', z.object({ source: CanvasSourceSchema, mode: z.enum(['suggests', 'writes']) })),
  /** → { ok: true }: a LifeOS document's new title (a .tcdoc is named by its file) */
  request('work.docs.rename', z.object({ source: CanvasSourceSchema, title: z.string().trim().min(1).max(200) })),
  /** → { ok: true }: the agent's last write is settled; the bar stops offering its Undo */
  request('work.docs.dismiss', z.object({ source: CanvasSourceSchema })),
  /** → { source, title }: a new LifeOS document in the sector, or in a project */
  request('work.docs.create', z.object({ sector: z.string().min(1).max(32), projectId: z.string().min(1).max(64).optional(), title: z.string().min(1).max(200) })),
  /** → FindAnswer (main/server/work/docs/find.ts): what a Work workspace lists, and with `query` the text matches */
  request('work.docs.find', z.object({ workspaceId: id, query: z.string().max(500).optional() })),
  /** → { views: SavedFindView[] } */
  request('work.docs.views', z.object({ workspaceId: id })),
  /** → SavedFindView: a new view, or one renamed and rewritten */
  request('work.docs.saveView', z.object({ workspaceId: id, id: id.optional(), name: z.string().trim().min(1).max(80), spec: FindSpecSchema })),
  /** → { ok: true } */
  request('work.docs.dropView', z.object({ workspaceId: id, id }))
] as const

/** Something changed on a document a screen may hold: its threads, its pending suggestions, or the agent's last write. */
export type DocsPush = { push: 'work.docs'; doc: string; threads?: true; branches?: true; written?: DocWritten | null; mode?: DocMode }

export const DOCS_CAPS = {
  'work.docs.open': 'read',
  'work.docs.token': 'read',
  'work.docs.connect': 'read',
  'work.docs.send': 'read',
  'work.docs.recv': 'read',
  'work.docs.close': 'read',
  'work.docs.threads': 'read',
  'work.docs.thread': 'operate',
  'work.docs.mode': 'operate',
  'work.docs.rename': 'operate',
  'work.docs.dismiss': 'operate',
  'work.docs.create': 'operate',
  'work.docs.find': 'read',
  'work.docs.views': 'read',
  'work.docs.saveView': 'operate',
  'work.docs.dropView': 'operate'
} satisfies CapsOf<typeof DocsRequestSchemas>
export const DOCS_RELAY = {} satisfies RelayOf<typeof DocsRequestSchemas>
