import type { ContextChip } from './canvas'
import type { SectorKey } from './ids'
import { mentionExcerptAt } from './mentions'

/**
 * Work search's names (docs/agents/work-search.md): one field that finds a
 * person, a mail, a task, a file or a thread in any of his jobs. Pure: no
 * zod and no node import, so the window's first paint may read a type from
 * here; the wire's zod is in src/shared/contract-work-search.ts.
 */

/** What a hit is. The kinds `SEARCH_ORDER` names have a heading of their own; a later pillar may bring any other. */
export type SearchKind = string

/** How the window opens a hit in place. */
export type SearchOpen =
  /** `openWorkView({ workspaceId, view, ...with })` */
  | { to: 'view'; view: string; with?: Record<string, unknown> }
  | { to: 'thread'; sessionId: string; seq?: number }
  /** Files' own ref, handed back to `work.files.open` untouched */
  | { to: 'file'; ref: unknown; name: string }
  /** a hit that came through a mention source: opened as its chip is from a sent message */
  | { to: 'chip'; chip: ContextChip }

export interface SearchHit {
  /** one thing, one key, whichever source or host found it: `lifeos:mailThreads:<id>`, `thread:<sessionId>`, `file:<refKey>` */
  key: string
  kind: SearchKind
  title: string
  /** the row's one muted fact: a sender, a place, a due date */
  detail?: string
  /** the matched words in their line, at most `SEARCH_SNIPPET` characters; drawn in the fact's place */
  snippet?: string
  at?: number
  /** the job; null: Work Chats */
  workspaceId: string | null
  open: SearchOpen
  /** when the thing can be a thread's context */
  chip?: ContextChip
  /** a file kept in the cloud alone, as Files marks one */
  cloud?: true
  /** on a Recent row alone: when he opened it, so Recent is one list across hosts */
  openedAt?: number
}

/** Where one search may look: the jobs of this host it may read, and whether Work Chats are among them. */
export interface SearchReach {
  workspaces: { id: string; sector: SectorKey | null; name: string }[]
  chats: boolean
  /** the thread that asks (its own pane's items are in reach); null: his window */
  sessionId: string | null
}

/** One source's rows for one kind. */
export interface SearchGroup {
  /** `<pillar>.<kind>` */
  source: string
  kind: SearchKind
  label: string
  hits: SearchHit[]
  /** the source had more than were asked for */
  more: boolean
}

/** One thing that could not be searched, in words. A cause is said once however many kinds it feeds. */
export interface SearchQuiet {
  cause: string
  line: string
}

export interface SearchAnswer {
  groups: SearchGroup[]
  /** the network sources the window asks next, each on its own */
  pending: { source: string; kind: SearchKind }[]
  quiet: SearchQuiet[]
  /** how many sources searched and answered for this call, with or without rows; 0: none could (the window then says only why) */
  searched?: number
  /** kinds with more to search when asked alone (Files' own search of every place and of text): the window offers "All files for …" for each, with or without a row of the kind */
  deeper?: SearchKind[]
}

/** The order the kinds' groups stand in; a kind not named here follows them, in the order it came. */
export const SEARCH_ORDER: readonly SearchKind[] = ['person', 'mail', 'message', 'chat', 'task', 'event', 'file', 'doc', 'project', 'thread', 'item', 'held', 'routine', 'card']

/** A group's heading: the `@` list's own words. */
export const SEARCH_LABELS: Readonly<Record<string, string>> = {
  person: 'People',
  mail: 'Mail',
  message: 'Messages',
  chat: 'Conversations',
  task: 'Tasks',
  event: 'Agenda',
  file: 'Files',
  doc: 'Documents',
  project: 'Projects',
  thread: 'Threads',
  item: 'Items',
  held: 'Outbox',
  routine: 'Routines',
  card: 'Cards',
  money: 'Money',
  recent: 'Recent'
}

/** A kind in the row that opens all of it: "All mail for …". */
export const SEARCH_NOUNS: Readonly<Record<string, string>> = {
  person: 'people',
  mail: 'mail',
  message: 'messages',
  chat: 'conversations',
  task: 'tasks',
  event: 'events',
  file: 'files',
  doc: 'documents',
  project: 'projects',
  thread: 'threads',
  item: 'items',
  held: 'held items',
  routine: 'routines',
  card: 'cards',
  money: 'ledger rows'
}

/** Rows a kind shows among the others. */
export const SEARCH_PER_GROUP = 4
/** Rows a kind shows alone. */
export const SEARCH_ALL = 30
/** Recent results shown before he types; 0 turns them off. */
export const SEARCH_RECENTS = 8
/** Recent results a host keeps. */
export const SEARCH_RECENTS_KEPT = 50
/** A source that has not answered by then is one quiet line. */
export const SEARCH_WAIT_MS = 4000
export const SEARCH_TEXT_MAX = 200
export const SEARCH_SNIPPET = 160
/** The kind of the group that holds what he opened last. */
export const RECENT_KIND = 'recent'

export const searchRank = (kind: SearchKind): number => {
  const at = SEARCH_ORDER.indexOf(kind)
  return at < 0 ? SEARCH_ORDER.length : at
}
export const searchLabel = (kind: SearchKind, fallback?: string): string => SEARCH_LABELS[kind] ?? fallback ?? kind
export const searchNoun = (kind: SearchKind, label?: string): string => SEARCH_NOUNS[kind] ?? (label ?? searchLabel(kind)).toLowerCase()

export const lifeosKey = (table: string, id: string): string => `lifeos:${table}:${id}`
export const threadKey = (sessionId: string): string => `thread:${sessionId}`
export const fileKey = (refKey: string): string => `file:${refKey}`
/** The key of a thing a chip names: a LifeOS row's is the same whichever source found it. */
export function chipKey(chip: ContextChip): string {
  const ref = chip.ref
  if (ref.at === 'lifeos') return lifeosKey(ref.table, ref.id)
  if (ref.at === 'item') return `item:${ref.id}`
  if (ref.at === 'work') return `work:${ref.pillar}:${ref.id}`
  return `chip:${chip.kind}:${JSON.stringify(ref)}`
}

/** Whether a hit lies inside a reach: its job is one of the reach's, or it is a Work Chats thing and the reach has them. */
export const inReach = (reach: SearchReach, workspaceId: string | null): boolean => (workspaceId === null ? reach.chats : reach.workspaces.some((w) => w.id === workspaceId))
/** The job of a LifeOS row, by its sector: one Work workspace a sector a host. */
export const workspaceOfSector = (reach: SearchReach, sector: string | null | undefined): string | undefined => (sector ? reach.workspaces.find((w) => w.sector === sector)?.id : undefined)
/** The sectors a reach reads. */
export const reachSectors = (reach: SearchReach): SectorKey[] => [...new Set(reach.workspaces.flatMap((w) => (w.sector ? [w.sector] : [])))]

/** A matched line cut to a row's worth, on one line: round the first of the words asked that it holds, when the start would not show it. */
export function searchSnippet(text: string | null | undefined, query = '', max = SEARCH_SNIPPET): string | undefined {
  return mentionExcerptAt(text, query, max)
}
