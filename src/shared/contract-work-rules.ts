import { z } from 'zod'
import { request, type CapsOf, type RelayOf } from './work/wire'

/**
 * The rules pillar's wire (docs/agents/work-rules.md): a Work workspace's
 * house rules, the proposals drawn from the owner's repeated edits to the
 * drafts its threads wrote, and the facts behind the voice switch. Methods
 * are `work.rules.<verb>`, the push `work.rules`.
 *
 * Only a person adds or changes a rule: every write needs `approve` and is
 * refused to a thread's own call. A thread never proposes through this
 * wire; proposals come from the host's reading of his edits.
 */

const Id = z.string().min(1).max(64)
/** One line: what a thread is told. */
export const RULE_TEXT_MAX = 300
const RuleText = z.string().trim().min(1).max(RULE_TEXT_MAX)

export const RulesRequestSchemas = [
  /** → RulesPage: the workspace's rules in order, and the proposals still open, each with its edits. */
  request('work.rules.list', z.object({ workspaceId: Id })),
  /** → DraftProposals: the open proposals a sent draft's edit is evidence for (the line under the sent mail). */
  request('work.rules.forDraft', z.object({ draftId: Id })),
  /** → VoiceFacts: how many sent mails of the workspace's sector a thread would read, and from when. */
  request('work.rules.voice', z.object({ workspaceId: Id })),
  /** → HouseRule: adds a rule at the end; from a proposal, the proposal is settled as added. */
  request('work.rules.add', z.object({ workspaceId: Id, text: RuleText, proposalId: Id.optional() })),
  /** → HouseRule: rewords a rule, or turns it on or off. */
  request('work.rules.edit', z.object({ id: Id, text: RuleText.optional(), on: z.boolean().optional() })),
  /** → { removed: boolean }: deletes a rule; `reopen` (Undo after an add) puts its proposal back. */
  request('work.rules.remove', z.object({ id: Id, reopen: z.boolean().optional() })),
  /** → { ok: true }: the workspace's rules in this order (every id, once). */
  request('work.rules.order', z.object({ workspaceId: Id, ids: z.array(Id).max(500) })),
  /** → RuleProposal: Not now (`later`), Dismiss (`dismissed`, never offered again), or back to open (`open`, Undo). */
  request('work.rules.decide', z.object({ id: Id, to: z.enum(['open', 'later', 'dismissed']) }))
] as const

export interface HouseRule {
  id: string
  workspaceId: string
  text: string
  on: boolean
  /** the proposal it was added from, if any */
  proposalId: string | null
  createdAt: number
  updatedAt: number
}

/** A run of a word diff: kept, taken out, put in. Long kept stretches are cut to `…`. */
export interface EditOp {
  op: '=' | '-' | '+'
  text: string
}

/** One sent draft he changed: what it was, to whom, when, and the change. */
export interface DraftEdit {
  draftId: string
  /** "Sam Ortiz", or "Sam Ortiz and 2 others" */
  to: string
  subject: string
  sentAt: number
  ops: EditOp[]
}

export type ProposalState = 'open' | 'later' | 'dismissed' | 'added'

export interface RuleProposal {
  id: string
  workspaceId: string
  /** the sentence a rule would say */
  text: string
  /** the line under a sent mail: what he did again, and the offer */
  line: string
  /** `open`: offered under the sent mail and on the page; `later`: on the page only */
  state: ProposalState
  /** the edits it was drawn from, newest first */
  edits: DraftEdit[]
  updatedAt: number
}

export interface RulesPage {
  rules: HouseRule[]
  proposals: RuleProposal[]
}

export interface DraftProposals {
  workspaceId: string | null
  proposals: RuleProposal[]
}

export interface VoiceFacts {
  on: boolean
  /** sent mails of the sector in the window a thread reads */
  count: number
  /** the oldest of them, or null when there are none */
  since: number | null
  /** the addresses they were sent from */
  from: string[]
}

export type RulesPush = { push: 'work.rules'; workspaceId: string }

export const RULES_CAPS = {
  'work.rules.list': 'read',
  'work.rules.forDraft': 'read',
  'work.rules.voice': 'read',
  'work.rules.add': 'approve',
  'work.rules.edit': 'approve',
  'work.rules.remove': 'approve',
  'work.rules.order': 'approve',
  'work.rules.decide': 'approve'
} satisfies CapsOf<typeof RulesRequestSchemas>
export const RULES_RELAY = {} satisfies RelayOf<typeof RulesRequestSchemas>
