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
  updatedAt: number
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

const ListParams = z
  .object({
    /** `waiting` (the default): held, live, sending and failed. `decided`: sent, discarded and stale, newest first. */
    show: z.enum(['waiting', 'decided', 'all']).optional(),
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
  request('work.outbox.send', z.object({ ref: HeldRefSchema, rev: z.number().int().optional(), /** he checked Sent and chose Send again on an item whose last send may have gone */ again: z.boolean().optional() })),
  /** → OutboxItem: the act will never go */
  request('work.outbox.discard', z.object({ ref: HeldRefSchema })),
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

export const OUTBOX_CAPS = {
  'work.outbox.list': 'read',
  'work.outbox.get': 'read',
  'work.outbox.send': 'approve',
  'work.outbox.discard': 'approve',
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
