import { z } from 'zod'
import { ActKindSchema, HeldItemSchema, HeldRefSchema, type ActKind, type ActResult, type HeldItem, type HeldRef, type UndoSpec } from './work/acts'
import { request, type CapsOf, type RelayOf } from './work/wire'

/**
 * The outbox pillar's wire (docs/agents/work-outbox.md): the hold. Every
 * outward act of a Work thread waits here for the owner's press. A screen
 * reads one list per host (`work.outbox.list`: this host's held rows and
 * the LifeOS-held mail and calendar acts this host's threads made) and
 * merges hosts as it merges threads. Every press goes through the host:
 * `send`, `discard` and `edit` need `approve`; a standing grant and a
 * tool's rule need `admin`. No agent can call any of them: a thread reaches
 * the app only through its tools, and none of these is a tool.
 */

/** Why an act is held: the tool's rule says Held, the add-on's tools were never reviewed, the host read the screen as a send, the model flagged it, or LifeOS holds its own drafts. */
export const HELD_WHYS = ['rule', 'unreviewed', 'screen', 'flag', 'lifeos', 'pillar'] as const
export type HeldWhy = (typeof HELD_WHYS)[number]

/**
 * What LifeOS says of a mail or calendar act the host stored as sent: still `queued` there (its undo time, or until the
 * calendar takes it), `confirmed` (LifeOS's row reads sent, a calendar act's done), back in its `drafts` (he took it
 * back), or `gone` from LifeOS. Read only: it changes no state and no press.
 */
export const LIFEOS_SAID = ['queued', 'confirmed', 'drafts', 'gone'] as const
export type LifeosSaid = (typeof LIFEOS_SAID)[number]

/**
 * A held item as a screen lists it: `HeldItem` (src/shared/work/acts.ts) and
 * what the Outbox shows beside it.
 */
export interface OutboxItem extends HeldItem {
  /** this host's number for the row, the one the thread was told ("Held as item 12"); null for a LifeOS-held item nobody decided yet */
  n: number | null
  why: HeldWhy
  /** the grant that released it, when one did */
  grantId: string | null
  /** why it failed or went stale, in words a person reads */
  error: string | null
  /** what carrying it out left behind */
  result: ActResult | null
  /** the routine run that made it, if one did */
  routineRunId: string | null
  /** an agent's rewrite waits in a LifeOS draft (`outbox.proposed`) */
  proposed?: boolean
  /** a failed send whose end nobody knows: it may have gone, so the screen asks him to check Sent and offers "Send again" (`send({again: true})`), never a plain Send */
  outcomeUnknown?: boolean
  /** a mail he scheduled (state `sending` until it goes): when it goes, and the IANA zone he picked the time in */
  scheduledFor?: number
  scheduledZone?: string
  /** a mail or calendar act stored `sent`: what LifeOS last said of it for this attempt, `queued` short of its word (absent: an act LifeOS does not hold, or one sent before this host asked) */
  lifeos?: LifeosSaid
  /** what a press does, in one sentence ("Goes from landon@purdue.edu to Dana Lee after your undo time.") */
  effect?: string
  /** what would go differs from what the thread first wrote: when, and whose words it is now. `get` adds `first`, the words as first written, for Show changes. */
  changed?: OutboxChanged
  /** a mail whose conversation got a newer message from someone else after it was made (`get` only) */
  replied?: OutboxReplied
  /** why he discarded it, for the thread */
  reason?: string
  /** where the press was made: `outbox`, `today`, `phone`, `mail`, `scheduled`, or `request:<id>` for a thread's request he answered */
  via?: string
  /** an item that went out of date and that he put away: it no longer waits */
  dismissedAt?: number
  /** its kind may be sent later (Send's menu offers Send later) */
  later?: true
  updatedAt: number
}
export interface OutboxChanged {
  at: number
  by: 'thread' | 'you'
  first?: unknown
}
export interface OutboxReplied {
  from: string
  at: number
  /** the first line of what they wrote */
  line: string
}
export const OutboxItemSchema = HeldItemSchema.extend({
  n: z.number().int().nullable(),
  why: z.enum(HELD_WHYS),
  grantId: z.string().nullable(),
  error: z.string().nullable(),
  result: z.object({ summary: z.string(), ref: z.unknown().optional() }).nullable(),
  routineRunId: z.string().nullable(),
  proposed: z.boolean().optional(),
  outcomeUnknown: z.boolean().optional(),
  /** a mail he scheduled: when it goes, and the IANA zone he picked the time in */
  scheduledFor: z.number().int().optional(),
  scheduledZone: z.string().optional(),
  lifeos: z.enum(LIFEOS_SAID).optional(),
  effect: z.string().optional(),
  changed: z.object({ at: z.number().int(), by: z.enum(['thread', 'you']), first: z.unknown().optional() }).optional(),
  replied: z.object({ from: z.string(), at: z.number().int(), line: z.string() }).optional(),
  reason: z.string().optional(),
  via: z.string().optional(),
  dismissedAt: z.number().int().optional(),
  later: z.literal(true).optional(),
  updatedAt: z.number().int()
})

/** A standing grant: made only from a held item, by a person; listed per workspace; removable. */
export interface OutboxGrant {
  id: string
  /** the workspace it fits, or `"~work"` for Work Chats */
  workspaceId: string
  kind: ActKind
  /** the kind's own matcher: what must be the same for a later act to fit */
  matcher: unknown
  label: string
  madeFrom: HeldRef
  /** set when made from a held act of that routine: it then fits only that routine's runs */
  routineId: string | null
  createdAt: number
  removedAt: number | null
}

/**
 * A grant he has earned (docs/agents/work-outbox.md "Offered grants"): he
 * sent several held acts of one narrow kind himself, each as the thread
 * wrote it, and the host offers that grant once, beside the item whose press
 * completed the run. The matcher stays on the host: taking the offer makes
 * the grant the host worked out, from that item.
 */
export interface GrantOffer {
  id: string
  workspaceId: string
  kind: ActKind
  /** the grant's name: "Mail to Sam Ortiz" */
  label: string
  /** set when a routine's runs earned it: the grant would fit that routine's runs alone */
  routineId: string | null
  /** the item whose press completed the run, and that the grant is made from */
  from: HeldRef
  /** the sends in a row that earned it */
  count: number
  createdAt: number
}

export const ToolRuleSchema = z.enum(['runs', 'held', 'off'])
export const ToolHintsSchema = z.object({
  readOnly: z.boolean().optional(),
  destructive: z.boolean().optional(),
  openWorld: z.boolean().optional(),
  idempotent: z.boolean().optional(),
  title: z.string().optional()
})

/** One tool of an add-on on the rules card. */
export interface ToolRuleRow {
  tool: string
  /** the tool in words: the server's own title, else its name spelled out */
  words: string
  description: string
  /** what the server says of its own tool: shown, never trusted */
  hints: z.infer<typeof ToolHintsSchema>
  /** the class the hints suggest: what the card preselects */
  suggested: 'runs' | 'held'
  /** the rule the owner set and that still stands; null: none, so the tool is held */
  rule: z.infer<typeof ToolRuleSchema> | null
  /** a rule he set no longer stands: the add-on's server or this tool's own definition changed since */
  changed: boolean
}

/** The one card that lists an add-on's tools with the class its hints suggest. Until the owner answers it, every tool of the add-on is held in Work threads. */
export interface ToolRulesCard {
  addonId: string
  name: string
  /** null: a global add-on, which Work threads see only when marked for Work */
  workspaceId: string | null
  forWork: boolean
  /** the row the app made for LifeOS: never held by the host, and its rules are not the owner's to set */
  lifeos: boolean
  /** tools with no standing rule */
  unreviewed: number
  tools: ToolRuleRow[]
}

/**
 * A Result: what a thread changed that lasts (`work_results`), with its way
 * back. A write on his own files and a send that left both make one; the
 * thread's right panel lists them, and the return from Away lists the
 * writes made while he was away.
 */
export interface WorkResult {
  id: string
  sessionId: string
  /** the thread whose panel lists it: the root of the writer's tree */
  rootId: string
  /** null: a Work Chat */
  workspaceId: string | null
  /** the pillar's own word for what it did ("task", "cells", or an act kind for a send) */
  kind: string
  /** "Added Dietary needs" */
  summary: string
  /** where it was written, in a person's words ("Spring LAN registration") */
  account: string | null
  /** JSON: what to open */
  ref: unknown
  /** the inverse call; null: it cannot be taken back */
  undo: UndoSpec | null
  undoneAt: number | null
  createdAt: number
}

/** Where a press was made, as the client says it (Done's words); a thread's request is the host's own to record. */
export const PressViaSchema = z.enum(['outbox', 'today', 'phone', 'mail'])

/** One item of one press: what to do with it, and the revision he saw (`updatedAt` as his screen read it). `later` takes the time it goes (`at`) and the zone he picked it in. `reason` rides a discard. */
export const DecisionSchema = z.object({
  ref: HeldRefSchema,
  do: z.enum(['send', 'discard', 'later']),
  rev: z.number().int().optional(),
  at: z.number().int().optional(),
  zone: z.string().max(80).optional(),
  again: z.boolean().optional(),
  reason: z.string().max(500).optional(),
  /** a LifeOS mail sent later: LifeOS drops the send when someone writes back first */
  cancelIfReply: z.boolean().optional()
})
export type Decision = z.infer<typeof DecisionSchema>
/** What became of one item of a press: `item` as it stands after, or why it did not go. */
export interface DecisionResult {
  ref: HeldRef
  ok: boolean
  item?: OutboxItem
  error?: string
}

/**
 * A thread's request for his press (docs/agents/work-outbox.md "A thread asks for his press"): the items its thread
 * asked about, each with what it would do and, while it is open, the receipt his press names for a row drawn as asked.
 */
export interface OutboxRequest {
  id: string
  /** this host's number for it, the one the thread was told ("request 3") */
  n: number
  sessionId: string
  workspaceId: string | null
  sector: string | null
  /** his own words the thread quoted */
  quote: string
  /** "Send 4 items and discard 1" */
  head: string
  state: 'open' | 'answered' | 'declined' | 'void'
  /** why it is void */
  why?: string
  createdAt: number
  expiresAt: number
  answeredBy: string | null
  answeredAt: number | null
  rows: OutboxRequestRow[]
}
export interface OutboxRequestRow {
  ref: HeldRef
  do: 'send' | 'discard' | 'later'
  at?: number
  /** the item as it stands now; absent when this host no longer has it */
  item?: OutboxItem
  /** it changed since the thread asked: it starts unticked, and opening it (`request.view`) gives a fresh receipt */
  changed: boolean
  /** it still waits on him */
  open: boolean
  /** what his press names for this row, as drawn now; absent: he cannot press it from the card as it stands */
  receipt?: string
  /** what became of it on his press */
  result?: { ok: boolean; error?: string; state?: string }
}

export const OutboxRequestRowSchema = z.object({
  ref: HeldRefSchema,
  do: z.enum(['send', 'discard', 'later']),
  at: z.number().int().optional(),
  item: OutboxItemSchema.optional(),
  changed: z.boolean(),
  open: z.boolean(),
  receipt: z.string().optional(),
  result: z.object({ ok: z.boolean(), error: z.string().optional(), state: z.string().optional() }).optional()
})
export const OutboxRequestSchema = z.object({
  id: z.string(),
  n: z.number().int(),
  sessionId: z.string(),
  workspaceId: z.string().nullable(),
  sector: z.string().nullable(),
  quote: z.string(),
  head: z.string(),
  state: z.enum(['open', 'answered', 'declined', 'void']),
  why: z.string().optional(),
  createdAt: z.number().int(),
  expiresAt: z.number().int(),
  answeredBy: z.string().nullable(),
  answeredAt: z.number().int().nullable(),
  rows: z.array(OutboxRequestRowSchema)
})

const ListParams = z
  .object({
    /** `waiting` (the default): held, live, sending, failed, and stale until he discards it. `done` (or `decided`): sent, discarded, and stale he put away, newest first. */
    show: z.enum(['waiting', 'done', 'decided', 'all']).optional(),
    workspaceId: z.string().optional(),
    sessionId: z.string().optional(),
    limit: z.number().int().min(1).max(500).optional()
  })
  .optional()

export const OutboxRequestSchemas = [
  /** → { items: OutboxItem[], waiting: number }: this host's held rows and its LifeOS-held items, as one list. A computer act's picture is left out here. */
  request('work.outbox.list', ListParams),
  /** → OutboxItem with its whole payload, a computer act's picture included (`payload.picture.data`, base64) */
  request('work.outbox.get', z.object({ ref: HeldRefSchema })),
  /** → OutboxItem: the owner's press. Runs the act once: a second press, another client's press and a restart never run it again. */
  /** `rev`: the item's `updatedAt` as the screen read it. Required for an item LifeOS holds, so what goes is what was shown; for a host row a press on a stale view is refused when given. */
  request('work.outbox.send', z.object({ ref: HeldRefSchema, rev: z.number().int().optional(), /** he checked Sent and chose Send again on an item whose last send may have gone */ again: z.boolean().optional(), /** one of several sent by one press (a group's Send N, ticked rows): it earns no offered grant */ many: z.boolean().optional(), via: PressViaSchema.optional() })),
  /** → OutboxItem: the act will never go. `reason`: his words for the thread. An item that went out of date is put away the same way. */
  request('work.outbox.discard', z.object({ ref: HeldRefSchema, reason: z.string().max(500).optional(), via: PressViaSchema.optional() })),
  /** → { results: DecisionResult[] }: one press on one or many items of this host, each run as its own press would be, four at a time, each answering its own result in the order asked. More than one item earns no offered grant. A desktop press across hosts sends one of these to each host. */
  /** With `request` and `receipts` in place of `items`: his Send on a thread's request card, for exactly the ticked rows' receipts (→ { request: OutboxRequest }). */
  request('work.outbox.decide', z.object({ items: z.array(DecisionSchema).min(1).max(100).optional(), via: PressViaSchema.optional(), /** one press of his across hosts: each host's part is many even when it holds one item */ many: z.boolean().optional(), request: z.string().optional(), receipts: z.array(z.string()).min(1).max(100).optional() })),
  /** → { requests: OutboxRequest[] }: the open requests, oldest first */
  request('work.outbox.requests', z.object({ sessionId: z.string().optional() }).optional()),
  /** → OutboxRequest: one request as its card draws it, with a receipt for each row he may press as drawn */
  request('work.outbox.request.get', z.object({ id: z.string() })),
  /** → OutboxRequestRow: he opened a row that changed since the ask; a fresh receipt at what he sees now */
  request('work.outbox.request.view', z.object({ id: z.string(), ref: HeldRefSchema })),
  /** → OutboxRequest: Not now; the items still wait in his Outbox */
  request('work.outbox.decline', z.object({ request: z.string() })),
  /** → OutboxItem: a scheduled item waits on him again as held (a LifeOS mail only once LifeOS took it back) */
  request('work.outbox.cancelSend', z.object({ ref: HeldRefSchema, /** the item's `updatedAt` as his screen read it */ rev: z.number().int().optional() })),
  /** → OutboxItem: a scheduled item goes now, on its own claim */
  request('work.outbox.sendNow', z.object({ ref: HeldRefSchema, rev: z.number().int().optional() })),
  /** → { back: boolean, item? }: Undo on a press's toast. A LifeOS mail LifeOS still holds in its undo time goes back to held; false once it went. */
  request('work.outbox.undoSend', z.object({ ref: HeldRefSchema })),
  /** → OutboxItem: an item that went out of date, put away with "out of date", and its thread asked to draft it again from what is true now */
  request('work.outbox.askAgain', z.object({ ref: HeldRefSchema })),
  /** → OutboxItem: change exactly what will go, while it waits. `payload` is the kind's own shape. */
  request('work.outbox.edit', z.object({ ref: HeldRefSchema, payload: z.unknown() })),
  /** → OutboxGrant: let later acts like this one go without a press. Only from a held item, only by a person with admin. `routine`: for the routine whose run made the item, and no other thread. */
  request('work.outbox.grant', z.object({ from: HeldRefSchema, matcher: z.unknown(), label: z.string().max(200).optional(), routine: z.boolean().optional() })),
  /** → { grants: OutboxGrant[] }: the standing ones; `all` adds the removed */
  request('work.outbox.grants', z.object({ workspaceId: z.string().optional(), all: z.boolean().optional() }).optional()),
  /** → OutboxGrant: removed; acts it would have fit are held again */
  request('work.outbox.ungrant', z.object({ id: z.string() })),
  /** → { offers: GrantOffer[] }: the grants he has earned and not yet decided */
  request('work.outbox.offers', z.object({ workspaceId: z.string().optional() }).optional()),
  /** → OutboxGrant: make the grant an offer names, from its item, as `grant` would. Only by a person with admin. */
  request('work.outbox.takeOffer', z.object({ id: z.string() })),
  /** → GrantOffer: never offered again */
  request('work.outbox.dismissOffer', z.object({ id: z.string() })),
  /** → { addons: ToolRulesCard[] }: each add-on a Work thread can reach, with its tools, their hints and their rules */
  request('work.outbox.rules', z.object({ addonId: z.string().optional(), workspaceId: z.string().optional() }).optional()),
  /** → ToolRulesCard: the owner's answer to the card. A tool left out keeps its rule. */
  request('work.outbox.setRules', z.object({ addonId: z.string(), rules: z.record(z.string(), ToolRuleSchema) })),
  /** → ToolRulesCard: mark a global add-on for Work threads, or take the mark off */
  request('work.outbox.setForWork', z.object({ addonId: z.string(), forWork: z.boolean() })),
  /** → { results: WorkResult[] }: a thread's Results (its subagents' with it), or every one since a time (the return from Away), newest first */
  request('work.outbox.results', z.object({ sessionId: z.string().optional(), since: z.number().int().optional(), limit: z.number().int().min(1).max(500).optional() })),
  /** → WorkResult: run its way back, once. A second press, or a press on one that cannot be taken back, is refused. */
  request('work.outbox.undo', z.object({ id: z.string() }))
] as const

/**
 * Something in the Outbox changed on this host: how many wait now, and the
 * item that changed (its payload without a picture). `rules`: how many
 * add-on tools a Work thread can reach have no rule yet.
 */
export type OutboxPush =
  | { push: 'work.outbox'; waiting: number; unreviewed: number; failed?: number; item?: OutboxItem }
  /** A Result was made or undone. */
  | { push: 'work.outbox.result'; result: WorkResult }
  /** A thread's request was made, answered, declined or ran out (to keys with approve alone). */
  | { push: 'work.outbox.request'; request: OutboxRequest }

export const OUTBOX_CAPS = {
  'work.outbox.list': 'read',
  'work.outbox.get': 'read',
  'work.outbox.send': 'approve',
  'work.outbox.discard': 'approve',
  'work.outbox.askAgain': 'approve',
  'work.outbox.decide': 'approve',
  'work.outbox.requests': 'approve',
  'work.outbox.request.get': 'approve',
  'work.outbox.request.view': 'approve',
  'work.outbox.decline': 'approve',
  'work.outbox.cancelSend': 'approve',
  'work.outbox.sendNow': 'approve',
  'work.outbox.undoSend': 'approve',
  'work.outbox.edit': 'approve',
  'work.outbox.grant': 'admin',
  'work.outbox.grants': 'read',
  'work.outbox.ungrant': 'admin',
  'work.outbox.offers': 'approve',
  'work.outbox.takeOffer': 'admin',
  'work.outbox.dismissOffer': 'admin',
  'work.outbox.rules': 'read',
  'work.outbox.setRules': 'admin',
  'work.outbox.setForWork': 'admin',
  'work.outbox.results': 'read',
  'work.outbox.undo': 'approve'
} satisfies CapsOf<typeof OutboxRequestSchemas>
export const OUTBOX_RELAY = {} satisfies RelayOf<typeof OutboxRequestSchemas>

export const OutboxKindSchema = ActKindSchema
