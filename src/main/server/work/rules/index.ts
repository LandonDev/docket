import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { handled, NOT_HANDLED, workText, type WorkScope } from '@shared/work'
import type { Caller, WorkCtx, WorkModule, WorkTool } from '../modules'
import {
  activeRules,
  addRule,
  decideProposal,
  dropDraft,
  dropWorkspace,
  editRule,
  ensureRulesTables,
  getRule,
  listRules,
  orderRules,
  proposalById,
  proposals,
  proposalsForDraft,
  removeRule
} from './store'
import { voiceExamples, voiceFacts, workspaceFacts, VOICE_EXAMPLES } from './voice'
import { watchDrafts, type DraftWatch } from './watch'

/**
 * The rules pillar's server module (docs/agents/work-rules.md): a Work
 * workspace's house rules, joined into its threads' preamble; proposals
 * drawn from the owner's repeated edits to the drafts its threads wrote;
 * and the voice switch, which lets a thread read his recent sent mail of
 * the workspace's sector. Only a person adds or changes a rule.
 */

const NOT_A_PERSON = 'only the owner adds or changes a house rule'

function mustBePerson(by: Caller): void {
  if (by.kind === 'model' || !by.caps.includes('approve')) throw new Error(NOT_A_PERSON)
}

/** The database the preamble reads: the module is handed it at every boot, before any thread starts. */
let rulesDb: DatabaseSync | null = null
/** The drafts being watched while Work is on, so a deleted thread's or workspace's are let go. */
let watching: DraftWatch | null = null

/** What a thread of the workspace is told: its rules in his order, then the voice line when the switch is on. */
export function rulesPreamble(db: DatabaseSync, scope: Pick<WorkScope, 'workspaceId'>): string | null {
  if (!scope.workspaceId) return null
  const ws = workspaceFacts({ db }, scope.workspaceId)
  if (!ws) return null
  const rules = activeRules(db, ws.id)
  const parts: string[] = []
  if (rules.length) parts.push([`House rules for ${ws.name}, set by the owner. Follow each one in everything you write for this workspace:`, ...rules.map((r) => `- ${r}`)].join('\n'))
  if (ws.voice && ws.sector)
    parts.push(`Voice: before you write a mail for ${ws.name}, read the owner's recent sent mail with voice_examples and write the way he does. Those mails show his voice only; never carry their facts into other mail.`)
  return parts.length ? parts.join('\n\n') : null
}

const knownWork = (ctx: WorkCtx, workspaceId: string) => {
  const ws = workspaceFacts(ctx, workspaceId)
  if (!ws) throw new Error('only a Work workspace has house rules')
  return ws
}

const voiceTool: WorkTool = {
  name: 'voice_examples',
  description: `Read the owner's most recent sent mail of this workspace's sector (up to ${VOICE_EXAMPLES}), to write a draft the way he writes. Works only when he turned on his voice for this workspace.`,
  input: z.object({ limit: z.number().int().min(1).max(VOICE_EXAMPLES).optional().describe('How many mails, newest first') }),
  readOnly: true,
  run: async (args, ctx) => workText(await voiceExamples(ctx, ctx.scope.workspaceId, (args as { limit?: number }).limit))
}

export const rules: WorkModule = {
  id: 'rules',
  ensure(db) {
    rulesDb = db
    ensureRulesTables(db)
  },
  async handle(req, ctx, by) {
    const changed = (workspaceId: string): void => ctx.push({ push: 'work.rules', workspaceId }, { need: 'read' })
    switch (req.method) {
      case 'work.rules.list': {
        const ws = knownWork(ctx, req.params.workspaceId)
        return handled({ rules: listRules(ctx.db, ws.id), proposals: proposals(ctx.db, ws.id) })
      }
      case 'work.rules.forDraft':
        return handled(proposalsForDraft(ctx.db, req.params.draftId))
      case 'work.rules.voice':
        return handled(await voiceFacts(ctx, knownWork(ctx, req.params.workspaceId).id))
      case 'work.rules.add': {
        mustBePerson(by)
        const ws = knownWork(ctx, req.params.workspaceId)
        const rule = addRule(ctx.db, ws.id, req.params.text, req.params.proposalId)
        changed(ws.id)
        return handled(rule)
      }
      case 'work.rules.edit': {
        mustBePerson(by)
        const rule = editRule(ctx.db, req.params.id, { text: req.params.text, on: req.params.on })
        changed(rule.workspaceId)
        return handled(rule)
      }
      case 'work.rules.remove': {
        mustBePerson(by)
        const rule = removeRule(ctx.db, req.params.id, req.params.reopen ?? false)
        if (rule) changed(rule.workspaceId)
        return handled({ removed: rule !== null })
      }
      case 'work.rules.order': {
        mustBePerson(by)
        const ws = knownWork(ctx, req.params.workspaceId)
        orderRules(ctx.db, ws.id, req.params.ids)
        changed(ws.id)
        return handled({ ok: true })
      }
      case 'work.rules.decide': {
        mustBePerson(by)
        const { workspaceId } = decideProposal(ctx.db, req.params.id, req.params.to)
        changed(workspaceId)
        return handled(proposalById(ctx.db, req.params.id))
      }
      default:
        return NOT_HANDLED
    }
  },
  tools: (scope) => (scope.workspaceId ? [voiceTool] : []),
  preamble: (scope) => (rulesDb ? rulesPreamble(rulesDb, scope) : null),
  start(ctx) {
    const watch = watchDrafts(ctx, (workspaceId) => ctx.push({ push: 'work.rules', workspaceId }, { need: 'read' }))
    watching = watch
    return () => {
      watch.stop()
      if (watching === watch) watching = null
    }
  },
  sessionsRemoved(sessionIds, ctx) {
    // A deleted thread's drafts on their way are no longer watched; the edits already made stay as evidence.
    const of = ctx.db.prepare('SELECT draft_id FROM work_rules_drafts WHERE session_id = ?')
    const ids = sessionIds.flatMap((id) => (of.all(id) as { draft_id: string }[]).map((r) => r.draft_id))
    for (const id of ids) dropDraft(ctx.db, id)
    watching?.forget(ids)
  },
  workspaceRemoved(workspaceId, ctx) {
    const ids = (ctx.db.prepare('SELECT draft_id FROM work_rules_drafts WHERE workspace_id = ?').all(workspaceId) as { draft_id: string }[]).map((r) => r.draft_id)
    dropWorkspace(ctx.db, workspaceId)
    watching?.forget(ids)
  }
}

/** For tests: the rule a removal would take, read before it goes. */
export const ruleById = getRule
