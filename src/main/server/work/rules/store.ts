import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { DraftEdit, EditOp, HouseRule, ProposalState, RuleProposal } from '@shared/contract-work-rules'
import { editOps, evidenceOps, habitsOf, type Habit } from './habits'

/**
 * The rules pillar's tables (docs/agents/work-rules.md "Tables"): a
 * workspace's rules in order, the drafts its threads made that are still
 * on their way, the edits he made to those he sent, and the proposals those
 * edits add up to. A proposal is one row per habit per workspace, so a
 * habit he dismissed is never offered again, however often he repeats it.
 */

/** Two sent drafts with the same habit make a proposal. */
export const PROPOSE_AT = 2
/** The edits a workspace keeps as evidence, newest first. */
const KEEP_EDITS = 200

export function ensureRulesTables(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS work_rules (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    text TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    position INTEGER NOT NULL,
    proposal_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`)
  db.exec('CREATE INDEX IF NOT EXISTS work_rules_by_workspace ON work_rules (workspace_id, position)')
  // A draft a thread made, from the moment the host first saw it until it is sent or gone: what the agent wrote is the edit's left side.
  db.exec(`CREATE TABLE IF NOT EXISTS work_rules_drafts (
    draft_id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    agent_text TEXT NOT NULL,
    proposed_text TEXT,
    seen_at INTEGER NOT NULL
  )`)
  db.exec(`CREATE TABLE IF NOT EXISTS work_rules_edits (
    draft_id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    recipient TEXT NOT NULL,
    subject TEXT NOT NULL,
    sent_at INTEGER NOT NULL,
    ops TEXT NOT NULL,
    habits TEXT NOT NULL
  )`)
  db.exec('CREATE INDEX IF NOT EXISTS work_rules_edits_by_workspace ON work_rules_edits (workspace_id, sent_at)')
  db.exec(`CREATE TABLE IF NOT EXISTS work_rules_proposals (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    habit TEXT NOT NULL,
    state TEXT NOT NULL,
    rule_id TEXT,
    updated_at INTEGER NOT NULL,
    UNIQUE (workspace_id, habit)
  )`)
}

// ── rules ───────────────────────────────────────────────────────────────

interface RuleRow {
  id: string
  workspace_id: string
  text: string
  enabled: number
  position: number
  proposal_id: string | null
  created_at: number
  updated_at: number
}

const ruleOf = (r: RuleRow): HouseRule => ({
  id: r.id,
  workspaceId: r.workspace_id,
  text: r.text,
  on: r.enabled === 1,
  proposalId: r.proposal_id,
  createdAt: r.created_at,
  updatedAt: r.updated_at
})

export function listRules(db: DatabaseSync, workspaceId: string): HouseRule[] {
  return (db.prepare('SELECT * FROM work_rules WHERE workspace_id = ? ORDER BY position, created_at').all(workspaceId) as unknown as RuleRow[]).map(ruleOf)
}

export function getRule(db: DatabaseSync, id: string): HouseRule | null {
  const row = db.prepare('SELECT * FROM work_rules WHERE id = ?').get(id) as unknown as RuleRow | undefined
  return row ? ruleOf(row) : null
}

/** The rules a thread of the workspace is told, in his order. */
export const activeRules = (db: DatabaseSync, workspaceId: string): string[] => listRules(db, workspaceId).filter((r) => r.on).map((r) => r.text)

/** Adds a rule at the end. From a proposal, the proposal is settled as added in the same step. */
export function addRule(db: DatabaseSync, workspaceId: string, text: string, proposalId?: string, now = Date.now()): HouseRule {
  const id = randomUUID()
  db.exec('SAVEPOINT work_rules_add')
  try {
    if (proposalId) {
      const p = proposalRow(db, proposalId)
      if (!p || p.workspace_id !== workspaceId) throw new Error('no such proposal in this workspace')
      if (p.state === 'added') throw new Error('this proposal is already a rule')
      db.prepare("UPDATE work_rules_proposals SET state = 'added', rule_id = ?, updated_at = ? WHERE id = ?").run(id, now, proposalId)
    }
    const { top } = db.prepare('SELECT COALESCE(MAX(position), -1) AS top FROM work_rules WHERE workspace_id = ?').get(workspaceId) as { top: number }
    db.prepare('INSERT INTO work_rules (id, workspace_id, text, enabled, position, proposal_id, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?, ?, ?)').run(
      id,
      workspaceId,
      text,
      top + 1,
      proposalId ?? null,
      now,
      now
    )
    db.exec('RELEASE work_rules_add')
  } catch (err) {
    db.exec('ROLLBACK TO work_rules_add')
    db.exec('RELEASE work_rules_add')
    throw err
  }
  return getRule(db, id)!
}

export function editRule(db: DatabaseSync, id: string, patch: { text?: string; on?: boolean }, now = Date.now()): HouseRule {
  const rule = getRule(db, id)
  if (!rule) throw new Error('no such rule')
  db.prepare('UPDATE work_rules SET text = ?, enabled = ?, updated_at = ? WHERE id = ?').run(patch.text ?? rule.text, (patch.on ?? rule.on) ? 1 : 0, now, id)
  return getRule(db, id)!
}

/** Deletes a rule. `reopen`, the Undo after an add, puts the proposal it came from back as open. */
export function removeRule(db: DatabaseSync, id: string, reopen = false, now = Date.now()): HouseRule | null {
  const rule = getRule(db, id)
  if (!rule) return null
  db.prepare('DELETE FROM work_rules WHERE id = ?').run(id)
  if (reopen && rule.proposalId) db.prepare("UPDATE work_rules_proposals SET state = 'open', rule_id = NULL, updated_at = ? WHERE id = ? AND rule_id = ?").run(now, rule.proposalId, id)
  return rule
}

/** Puts the workspace's rules in this order: every rule of the workspace, once. */
export function orderRules(db: DatabaseSync, workspaceId: string, ids: readonly string[]): void {
  const have = listRules(db, workspaceId).map((r) => r.id)
  if (ids.length !== have.length || new Set(ids).size !== ids.length || !ids.every((id) => have.includes(id))) throw new Error('the order must name every rule of the workspace once')
  const set = db.prepare('UPDATE work_rules SET position = ? WHERE id = ?')
  ids.forEach((id, i) => set.run(i, id))
}

// ── drafts on their way ─────────────────────────────────────────────────

export interface TrackedDraft {
  draftId: string
  workspaceId: string
  sessionId: string
  agentText: string
  proposedText: string | null
}

export function trackDraft(db: DatabaseSync, d: Omit<TrackedDraft, 'proposedText'>, now = Date.now()): boolean {
  // An edit already recorded for this draft is final: a draft is read once.
  if (db.prepare('SELECT 1 FROM work_rules_edits WHERE draft_id = ?').get(d.draftId)) return false
  return (
    db.prepare('INSERT OR IGNORE INTO work_rules_drafts (draft_id, workspace_id, session_id, agent_text, seen_at) VALUES (?, ?, ?, ?, ?)').run(d.draftId, d.workspaceId, d.sessionId, d.agentText, now)
      .changes > 0
  )
}

export function trackedDraft(db: DatabaseSync, draftId: string): TrackedDraft | null {
  const r = db.prepare('SELECT * FROM work_rules_drafts WHERE draft_id = ?').get(draftId) as
    | { draft_id: string; workspace_id: string; session_id: string; agent_text: string; proposed_text: string | null }
    | undefined
  return r ? { draftId: r.draft_id, workspaceId: r.workspace_id, sessionId: r.session_id, agentText: r.agent_text, proposedText: r.proposed_text } : null
}

export const trackedDraftIds = (db: DatabaseSync): string[] => (db.prepare('SELECT draft_id FROM work_rules_drafts').all() as { draft_id: string }[]).map((r) => r.draft_id)

/**
 * A draft as LifeOS holds it now. An agent's waiting rewrite is noted; once
 * he takes it (the draft's words become the rewrite's), the rewrite is the
 * agent's words too, so what he changes after it is still his edit.
 */
export function noteDraft(db: DatabaseSync, draftId: string, text: string, proposedText: string | null): void {
  const d = trackedDraft(db, draftId)
  if (!d) return
  if (d.proposedText !== null && text === d.proposedText) db.prepare('UPDATE work_rules_drafts SET agent_text = ?, proposed_text = ? WHERE draft_id = ?').run(text, proposedText, draftId)
  else if (proposedText !== d.proposedText) db.prepare('UPDATE work_rules_drafts SET proposed_text = ? WHERE draft_id = ?').run(proposedText, draftId)
}

export const dropDraft = (db: DatabaseSync, draftId: string): void => void db.prepare('DELETE FROM work_rules_drafts WHERE draft_id = ?').run(draftId)

// ── edits and proposals ─────────────────────────────────────────────────

export interface SentDraft {
  draftId: string
  recipient: string
  subject: string
  sentAt: number
  text: string
}

interface EditRow {
  draft_id: string
  workspace_id: string
  recipient: string
  subject: string
  sent_at: number
  ops: string
  habits: string
}

interface ProposalRow {
  id: string
  workspace_id: string
  habit: string
  state: ProposalState
  rule_id: string | null
  updated_at: number
}

const proposalRow = (db: DatabaseSync, id: string): ProposalRow | undefined => db.prepare('SELECT * FROM work_rules_proposals WHERE id = ?').get(id) as unknown as ProposalRow | undefined

/**
 * A tracked draft was sent: what he sent against what the agent wrote is
 * one edit, kept with the habits it shows, and each habit now seen in
 * `PROPOSE_AT` sent drafts is a proposal (or, put off with Not now, offered
 * again). Answers the workspace whose proposals changed, or null.
 */
export function recordSent(db: DatabaseSync, sent: SentDraft, now = Date.now()): string | null {
  const d = trackedDraft(db, sent.draftId)
  if (!d) return null
  dropDraft(db, sent.draftId)
  const habits = habitsOf(d.agentText, sent.text)
  if (habits.length === 0) return null
  const ops = evidenceOps(editOps(d.agentText, sent.text))
  db.prepare('INSERT OR IGNORE INTO work_rules_edits (draft_id, workspace_id, session_id, recipient, subject, sent_at, ops, habits) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
    sent.draftId,
    d.workspaceId,
    d.sessionId,
    sent.recipient,
    sent.subject,
    sent.sentAt,
    JSON.stringify(ops),
    JSON.stringify(habits)
  )
  db.prepare(
    'DELETE FROM work_rules_edits WHERE workspace_id = ? AND draft_id NOT IN (SELECT draft_id FROM work_rules_edits WHERE workspace_id = ? ORDER BY sent_at DESC LIMIT ?)'
  ).run(d.workspaceId, d.workspaceId, KEEP_EDITS)
  const edits = editRows(db, d.workspaceId)
  for (const h of habits) {
    const seen = edits.filter((e) => e.habits.some((x) => x.key === h.key)).length
    if (seen < PROPOSE_AT) continue
    const row = db.prepare('SELECT * FROM work_rules_proposals WHERE workspace_id = ? AND habit = ?').get(d.workspaceId, h.key) as unknown as ProposalRow | undefined
    if (!row) db.prepare("INSERT INTO work_rules_proposals (id, workspace_id, habit, state, updated_at) VALUES (?, ?, ?, 'open', ?)").run(randomUUID(), d.workspaceId, h.key, now)
    // He did it again after Not now: offer it again. Dismissed and added stay as they are.
    else if (row.state === 'later' || row.state === 'open') db.prepare("UPDATE work_rules_proposals SET state = 'open', updated_at = ? WHERE id = ?").run(now, row.id)
  }
  return d.workspaceId
}

const editRows = (db: DatabaseSync, workspaceId: string): (Omit<EditRow, 'ops' | 'habits'> & { ops: EditOp[]; habits: Habit[] })[] =>
  (db.prepare('SELECT * FROM work_rules_edits WHERE workspace_id = ? ORDER BY sent_at DESC').all(workspaceId) as unknown as EditRow[]).map((r) => ({
    ...r,
    ops: JSON.parse(r.ops) as EditOp[],
    habits: JSON.parse(r.habits) as Habit[]
  }))

/**
 * The workspace's proposals in the given states, each with its edits,
 * newest first. A broad habit whose every edit a narrower proposal already
 * holds (a greeting cut that is always the same phrase) is not offered:
 * the narrower one says it better, and a dismissed one keeps it quiet too.
 */
export function proposals(db: DatabaseSync, workspaceId: string, states: readonly ProposalState[] = ['open', 'later']): RuleProposal[] {
  const edits = editRows(db, workspaceId)
  const rows = db.prepare('SELECT * FROM work_rules_proposals WHERE workspace_id = ?').all(workspaceId) as unknown as ProposalRow[]
  const all = rows.map((row) => {
    const of = edits.filter((e) => e.habits.some((h) => h.key === row.habit))
    const habit = of[0]?.habits.find((h) => h.key === row.habit)
    return { row, of, habit, set: new Set(of.map((e) => e.draft_id)) }
  })
  const out: RuleProposal[] = []
  for (const p of all) {
    if (!p.habit || !states.includes(p.row.state)) continue
    const covered = all.some((q) => q !== p && q.habit && q.habit.rank > p.habit!.rank && [...p.set].every((id) => q.set.has(id)))
    if (covered) continue
    const edit = (e: (typeof edits)[number]): DraftEdit => ({ draftId: e.draft_id, to: e.recipient, subject: e.subject, sentAt: e.sent_at, ops: e.ops })
    out.push({ id: p.row.id, workspaceId, text: p.habit.rule, line: p.habit.line, state: p.row.state, ruleId: p.row.rule_id, edits: p.of.map(edit), updatedAt: p.row.updated_at })
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt)
}

/** The open proposals a sent draft's edit is evidence for: the line under that mail. */
export function proposalsForDraft(db: DatabaseSync, draftId: string): { workspaceId: string | null; proposals: RuleProposal[] } {
  const row = db.prepare('SELECT workspace_id FROM work_rules_edits WHERE draft_id = ?').get(draftId) as { workspace_id: string } | undefined
  if (!row) return { workspaceId: null, proposals: [] }
  // Open and added: the line keeps its "Added" state (and Undo) after he adds from it.
  const list = proposals(db, row.workspace_id, ['open', 'added']).filter((p) => p.edits.some((e) => e.draftId === draftId))
  return { workspaceId: row.workspace_id, proposals: list }
}

/** Not now, Dismiss, or back to open (Undo). An added proposal is settled by its rule. */
export function decideProposal(db: DatabaseSync, id: string, to: 'open' | 'later' | 'dismissed', now = Date.now()): { workspaceId: string; state: ProposalState } {
  const row = proposalRow(db, id)
  if (!row) throw new Error('no such proposal')
  if (row.state === 'added') throw new Error('this proposal is already a rule')
  db.prepare('UPDATE work_rules_proposals SET state = ?, updated_at = ? WHERE id = ?').run(to, now, id)
  return { workspaceId: row.workspace_id, state: to }
}

export function proposalById(db: DatabaseSync, id: string): RuleProposal | null {
  const row = proposalRow(db, id)
  if (!row) return null
  return proposals(db, row.workspace_id, ['open', 'later', 'dismissed', 'added']).find((p) => p.id === id) ?? null
}

/** A workspace was deleted: its rules, drafts, edits and proposals go with it. */
export function dropWorkspace(db: DatabaseSync, workspaceId: string): void {
  for (const table of ['work_rules', 'work_rules_drafts', 'work_rules_edits', 'work_rules_proposals']) db.prepare(`DELETE FROM ${table} WHERE workspace_id = ?`).run(workspaceId)
}
