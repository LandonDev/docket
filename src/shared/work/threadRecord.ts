import { z } from 'zod'
import type { OutboxItem } from '../contract-work-outbox'
import type { ActKind } from './acts'
import type { CanvasSource } from './canvas'

/**
 * What a Work thread left him (docs/agents/work.md "What a thread left him"): the one record the thread's head, the
 * column's outcome line, a project's log and the tracker all read. The host builds it from records that exist
 * (src/main/server/work/threads/record.ts); these are its shapes and its words.
 */

/** How pressing an outcome is, most first: a question or approval, a failure, a held act, live work, a file made, an act done. */
export const OUTCOME_TONES = ['asks', 'failed', 'held', 'working', 'made', 'done'] as const
export type OutcomeTone = (typeof OUTCOME_TONES)[number]

/** The column's line under a thread ("1 mail to send") and the mark's tone; folded into the session summary (`SessionMeta.workOutcome`). */
export const ThreadOutcomeSchema = z.object({ words: z.string(), tone: z.enum(OUTCOME_TONES) })
export type ThreadOutcome = z.infer<typeof ThreadOutcomeSchema>

/** Where a made or changed thing opens: a Files tab of the workspace, a page on the web, or a LifeOS project's page. */
export type RecordOpen =
  | { at: 'files'; workspaceId: string; ref: CanvasSource; name: string }
  | { at: 'url'; url: string }
  | { at: 'project'; workspaceId: string; projectId: string }

/** What waits on him, most pressing first. */
export type RecordWait =
  /** a question or an approval the thread (or one of its subagents) asks */
  | { kind: 'asks'; sessionId: string }
  /** the turn stopped on a failure: what happened, and the likely cause */
  | { kind: 'failed'; sessionId: string; words: string; cause: string | null }
  /** a thread's request for his press (outbox_request), open */
  | { kind: 'request'; id: string; n: number; head: string; at: number }
  /** a held act that waits on him (`needsHim`), oldest first */
  | { kind: 'held'; item: OutboxItem }

/** A LifeOS record the thread works on (its `workLinks`), with a task's state where LifeOS answered. */
export interface RecordWork {
  table: 'tasks' | 'mailThreads' | 'events' | 'chats'
  id: string
  title: string
  /** the link's own state: a task that closed reads `done` */
  state: 'open' | 'done'
  at: number
  task?: { status: string; due: number | null; projectId: string | null; waitingOn: { name: string; since: number | null } | null }
}

/** A thing the thread (or a subagent) made or changed that lasts, from its Results. */
export interface RecordMade {
  /** the Result's id */
  id: string
  sessionId: string
  kind: string
  /** "Made", "Saved", "Linked" */
  verb: string
  /** the thing's own name, else the Result's summary */
  name: string
  summary: string
  at: number
  undone: boolean
  open: RecordOpen | null
}

/**
 * A thing a project's threads made or changed, as `work.projects.files` answers it for a mirror: the record's made
 * row, with the root thread it is of, the source it names (`key`: one row however often the thing was written) and the
 * LifeOS item it is, where the write says.
 */
export interface ProjectMadeFile extends RecordMade {
  rootId: string
  key: string
  itemId?: string
}

export interface ThreadRecord {
  /** the root thread the record is of; a subagent's waits and writes are its root's */
  sessionId: string
  /** the job the thread is in, where its task opens; null for a Work Chat */
  workspaceId: string | null
  waits: RecordWait[]
  works: RecordWork[]
  made: RecordMade[]
  outcome: ThreadOutcome | null
  /** LifeOS could not be read for the links, in words: `works` is empty for that reason, not because there are none */
  worksDown?: string
}

// ── words ───────────────────────────────────────────────────────────────

/** A held act's noun and what his press does to it, for the outcome line. */
const HELD_NOUN: Record<ActKind, readonly [one: string, many: string, verb: string]> = {
  'mail.send': ['mail', 'mails', 'send'],
  'office.mail.send': ['mail', 'mails', 'send'],
  'chat.reply': ['message', 'messages', 'send'],
  'teams.post': ['message', 'messages', 'send'],
  'calendar.op': ['calendar change', 'calendar changes', 'approve'],
  'office.calendar.op': ['calendar change', 'calendar changes', 'approve'],
  'office.edit': ['file change', 'file changes', 'approve'],
  'google.edit': ['file change', 'file changes', 'approve'],
  'file.act': ['file change', 'file changes', 'approve'],
  'share.guestLink': ['share', 'shares', 'approve'],
  'share.google': ['share', 'shares', 'approve'],
  'form.publish': ['form', 'forms', 'publish'],
  'msform.publish': ['form', 'forms', 'publish'],
  'msform.make': ['form', 'forms', 'approve'],
  'frameio.post': ['comment', 'comments', 'post'],
  'portal.submit': ['form', 'forms', 'submit'],
  'computer.act': ['step', 'steps', 'approve'],
  'addon.call': ['action', 'actions', 'approve']
}

/** "1 mail to send", "2 file changes to approve", "3 items to approve" when the kinds differ; null for none. */
export function heldWords(items: readonly Pick<OutboxItem, 'kind'>[]): string | null {
  if (!items.length) return null
  const nouns = new Set(items.map((i) => (HELD_NOUN[i.kind] ?? HELD_NOUN['addon.call']).join('|')))
  const [one, many, verb] = nouns.size === 1 ? (HELD_NOUN[items[0]!.kind] ?? HELD_NOUN['addon.call']) : (['item', 'items', 'approve'] as const)
  return `${items.length} ${items.length === 1 ? one : many} to ${verb}`
}

/** A thread's open requests for his press (`outbox_request`), as the outcome line says them: "1 request to approve"; null for none. */
export const requestWords = (n: number): string | null => (n > 0 ? `${n} ${n === 1 ? 'request' : 'requests'} to approve` : null)

/** A turn's failure as the outcome line says it: a sign-in first, since that is his to fix. */
export function failedWords(kind: string | null | undefined): string {
  switch (kind) {
    case 'oauth_expired':
    case 'token_expired':
    case 'account_unknown':
    case 'key_invalid':
      return "Couldn't sign in"
    case 'rate_limited':
    case 'quota':
      return 'Out of usage'
    case 'network':
      return "Couldn't reach the model"
    default:
      return 'Stopped on an error'
  }
}

/** A send that left, as the outcome line says it. */
const DONE_WORDS: Partial<Record<string, string>> = {
  'mail.send': 'Mail sent',
  'office.mail.send': 'Mail sent',
  'chat.reply': 'Message sent',
  'teams.post': 'Message sent',
  'frameio.post': 'Comment posted',
  'portal.submit': 'Form submitted',
  'form.publish': 'Form published',
  'msform.publish': 'Form published'
}

export const doneWords = (kind: string, summary: string): string => DONE_WORDS[kind] ?? summary

/** Results kinds that are a thing made or changed (a file, a document, a link into a project); the rest are acts done. */
export function isMadeKind(kind: string): boolean {
  return kind.startsWith('file.') || kind.startsWith('docs.') || kind.startsWith('sheets.') || kind.startsWith('google.') || kind === 'windows.put' || kind === 'projects.link'
}

/** The made outcome: "Made Seat map.xlsx", "Saved Budget FY27.xlsx". */
export const madeWords = (made: Pick<RecordMade, 'verb' | 'name'>): string => `${made.verb} ${made.name}`

/** A Work thread's live line, as the column says it: what it is doing, else Working. */
export const workingWords = (detail: string | null | undefined): string => detail?.trim() || 'Working'
