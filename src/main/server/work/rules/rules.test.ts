import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import type { ClientRequest } from '@shared/contract'
import type { HouseRule, RuleProposal, RulesPage } from '@shared/contract-work-rules'
import type { WorkScope } from '@shared/work'
import type { Caller, ToolCtx, WorkCtx } from '../modules'
import { modulePreambles, workPreamble, workPreambleHead } from '../preamble'
import { habitsOf } from './habits'
import { rules, rulesPreamble } from '.'
import { watchDrafts } from './watch'

/**
 * House rules on the host (docs/agents/work-rules.md): drafts a Work thread
 * made are watched until sent, his repeated edits become one proposal with
 * the edits as evidence, only a person adds a rule, an added rule reaches
 * the preamble of that workspace's threads alone, a dismissed proposal
 * never returns, and the voice switch gates the sector's sent mail.
 */

const owner: Caller = { kind: 'local', caps: ['read', 'operate', 'approve', 'admin'] }
const model: Caller = { kind: 'model', caps: ['read', 'operate', 'approve'], sessionId: 't1' }
const reader: Caller = { kind: 'remote', caps: ['read', 'operate'] }

type Row = { _id: string; _creationTime?: number; status: string; sector?: string; sentAt?: number; message: Record<string, unknown>; origin?: Record<string, string>; proposed?: { text: string } }

/** LifeOS as the rules module reads it: the held drafts, one draft by id, and sent mail. */
class FakeLifeos {
  rows = new Map<string, Row>()
  private watches = new Set<{ fn: string; args: Record<string, unknown>; on: (v: unknown) => void }>()
  private n = 0
  value(fn: string, args: Record<string, unknown>): unknown {
    if (fn === 'outboxHeld:held') return [...this.rows.values()].filter((r) => (r.status === 'draft' || r.status === 'failed') && r.origin && r.origin.host === args.host)
    if (fn === 'compose:get') {
      const row = this.rows.get(String(args.id))
      return row ? { row } : null
    }
    if (fn === 'outbox:list') return [...this.rows.values()].filter((r) => !args.status || r.status === args.status)
    throw new Error(`no ${fn}`)
  }
  subscribe = (fn: string, args: unknown, on: (v: unknown) => void): (() => void) => {
    const w = { fn, args: args as Record<string, unknown>, on }
    this.watches.add(w)
    on(this.value(fn, w.args))
    return () => void this.watches.delete(w)
  }
  emit(): void {
    for (const w of [...this.watches]) if (this.watches.has(w)) w.on(this.value(w.fn, w.args))
  }
  /** The agent's draft, made by a thread of this host. */
  draft(threadId: string, text: string, host = 'box'): string {
    const id = `d${++this.n}`
    this.rows.set(id, { _id: id, status: 'draft', message: { kind: 'mail', subject: `Mail ${this.n}`, text, to: [{ name: 'Sam Ortiz', address: 'sam@x.test' }] }, origin: { app: 'tempcode', threadId, host } })
    this.emit()
    return id
  }
  /** He edits the draft in the composer and presses Send. */
  send(id: string, text: string, at = Date.now()): void {
    const row = this.rows.get(id)!
    row.message = { ...row.message, text }
    this.emit()
    row.status = 'sent'
    row.sentAt = at
    this.emit()
  }
  get watching(): number {
    return this.watches.size
  }
}

let db: DatabaseSync
let lifeos: FakeLifeos
let pushes: unknown[]
let ctx: WorkCtx

const scopes: Record<string, Pick<WorkScope, 'workspaceId' | 'sector'>> = {
  t1: { workspaceId: 'ws-purdue', sector: 'purdue' },
  t2: { workspaceId: 'ws-purdue', sector: 'purdue' },
  t3: { workspaceId: 'ws-ref', sector: 'ref' },
  chat: { workspaceId: null, sector: null }
}
const scope = (sessionId: string): WorkScope => ({ sessionId, host: 'box', away: false, routineRunId: null, shared: () => false, ...scopes[sessionId]! }) as WorkScope

const call = async <T>(method: string, params: Record<string, unknown>, by: Caller = owner): Promise<T> => {
  const answer = await rules.handle!({ id: 'r', method, params } as unknown as ClientRequest, ctx, by)
  if (!answer.handled) throw new Error(`${method} not handled`)
  return answer.result as T
}
const page = (workspaceId = 'ws-purdue') => call<RulesPage>('work.rules.list', { workspaceId })

const GREETING = 'Hi Sam, I hope this email finds you well. Thursday at 7 works for varsity.\n\nBest,\nLandon'
const CUT = 'Hi Sam, Thursday at 7 works for varsity.\n\nBest,\nLandon'

beforeEach(() => {
  db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT, sector TEXT, work_settings TEXT)')
  db.prepare('INSERT INTO workspaces VALUES (?, ?, ?, ?, ?)').run('ws-purdue', 'Purdue Esports', 'work', 'purdue', null)
  db.prepare('INSERT INTO workspaces VALUES (?, ?, ?, ?, ?)').run('ws-ref', 'Referee', 'work', 'ref', null)
  db.prepare('INSERT INTO workspaces VALUES (?, ?, ?, ?, ?)').run('ws-code', 'temp-code', null, null, null)
  rules.ensure(db)
  lifeos = new FakeLifeos()
  pushes = []
  ctx = {
    db,
    host: 'box',
    log: () => {},
    push: (p: unknown) => void pushes.push(p),
    scopeOf: (id: string) => (scopes[id] ? scope(id) : null),
    lifeos: { connected: () => true, owner: () => ({ query: async (fn: string, args: Record<string, unknown>) => lifeos.value(fn, args) }), subscribe: lifeos.subscribe }
  } as unknown as WorkCtx
})

const flush = () => new Promise((r) => setTimeout(r, 0))

describe('proposals from his edits', () => {
  it('three drafts he edited the same way make one proposal, with the three edits as its evidence', async () => {
    const { stop } = watchDrafts(ctx, () => {})
    for (const [i, thread] of ['t1', 't2', 't1'].entries()) lifeos.send(lifeos.draft(thread, GREETING.replace('Sam', `Sam${i}`)), CUT.replace('Sam', `Sam${i}`), 1000 + i)
    await flush()
    const { proposals } = await page()
    expect(proposals).toHaveLength(1)
    const [p] = proposals as [RuleProposal]
    expect(p.text).toBe('Leave out “I hope this email finds you well”')
    expect(p.line).toBe('You took out “I hope this email finds you well” again.')
    expect(p.state).toBe('open')
    expect(p.edits.map((e) => e.sentAt)).toEqual([1002, 1001, 1000])
    expect(p.edits[0]!.to).toBe('Sam Ortiz')
    expect(p.edits[0]!.ops.filter((o) => o.op === '-').map((o) => o.text.trim())).toEqual(['I hope this email finds you well.'])
    // Each sent draft's watch ended; only the held list is still watched.
    await flush()
    expect(lifeos.watching).toBe(1)
    expect((await page('ws-ref')).proposals).toEqual([])
    stop()
  })

  it('one edit is not a habit, and a draft sent as the agent wrote it is no edit', async () => {
    const { stop } = watchDrafts(ctx, () => {})
    lifeos.send(lifeos.draft('t1', GREETING), CUT)
    lifeos.send(lifeos.draft('t1', GREETING), GREETING)
    await flush()
    expect((await page()).proposals).toEqual([])
    expect(db.prepare('SELECT COUNT(*) AS n FROM work_rules_edits').get()).toEqual({ n: 1 })
    stop()
  })

  it('a rewrite he took is the agent\'s words, so only what he changed after it counts', async () => {
    const { stop } = watchDrafts(ctx, () => {})
    const id = lifeos.draft('t1', 'Hi Sam, a first try.')
    lifeos.rows.get(id)!.proposed = { text: GREETING }
    lifeos.emit()
    lifeos.rows.get(id)!.message.text = GREETING
    delete lifeos.rows.get(id)!.proposed
    lifeos.emit()
    lifeos.send(id, CUT)
    await flush()
    const habits = JSON.parse((db.prepare('SELECT habits FROM work_rules_edits').get() as { habits: string }).habits) as { key: string }[]
    expect(habits.map((h) => h.key)).toContain('cut:i hope this email finds you well')
    stop()
  })

  it('a rewrite that only copied his own words does not make them the agent\'s', async () => {
    const { stop } = watchDrafts(ctx, () => {})
    const id = lifeos.draft('t1', GREETING)
    lifeos.rows.get(id)!.message.text = CUT
    lifeos.emit()
    // A subject-only rewrite carries the draft's current words, his edit included; he leaves it.
    lifeos.rows.get(id)!.proposed = { text: CUT }
    lifeos.emit()
    delete lifeos.rows.get(id)!.proposed
    lifeos.emit()
    lifeos.send(id, CUT)
    await flush()
    stop()
    expect(db.prepare('SELECT COUNT(*) AS n FROM work_rules_edits').get()).toEqual({ n: 1 })
  })

  it('a deleted thread\'s drafts are let go, and so is one older than a month', async () => {
    const stopModule = rules.start!(ctx)
    lifeos.draft('t1', GREETING)
    const old = lifeos.draft('t2', GREETING)
    expect(lifeos.watching).toBe(3)
    // The thread is gone, so the host no longer knows its scope.
    const scopeOf = ctx.scopeOf
    ctx.scopeOf = (id) => (id === 't1' ? null : scopeOf(id))
    rules.sessionsRemoved!(['t1'], ctx)
    await flush()
    expect(lifeos.watching).toBe(2)
    db.prepare('UPDATE work_rules_drafts SET seen_at = 0 WHERE draft_id = ?').run(old)
    lifeos.rows.get(old)!._creationTime = 0
    lifeos.emit()
    await flush()
    expect(lifeos.watching).toBe(1)
    stopModule()
    expect(lifeos.watching).toBe(0)
  })

  it('a draft sent while the host was down is read when it comes back', async () => {
    let { stop } = watchDrafts(ctx, () => {})
    const id = lifeos.draft('t1', GREETING)
    stop()
    lifeos.rows.get(id)!.message.text = CUT
    lifeos.rows.get(id)!.status = 'sent'
    ;({ stop } = watchDrafts(ctx, () => {}))
    await flush()
    expect(db.prepare('SELECT draft_id FROM work_rules_edits').all()).toEqual([{ draft_id: id }])
    stop()
  })

  it('a Work Chat\'s draft and another host\'s draft are not watched', async () => {
    const { stop } = watchDrafts(ctx, () => {})
    lifeos.draft('chat', GREETING)
    lifeos.draft('t1', GREETING, 'mac')
    expect(db.prepare('SELECT COUNT(*) AS n FROM work_rules_drafts').get()).toEqual({ n: 0 })
    stop()
  })
})

describe('deciding a proposal', () => {
  const twice = async (): Promise<RuleProposal> => {
    const { stop } = watchDrafts(ctx, () => {})
    lifeos.send(lifeos.draft('t1', GREETING), CUT)
    lifeos.send(lifeos.draft('t2', GREETING), CUT)
    await flush()
    stop()
    return (await page()).proposals[0]!
  }

  it('adding it puts the sentence in the next preamble of that workspace\'s threads only', async () => {
    const p = await twice()
    const rule = await call<HouseRule>('work.rules.add', { workspaceId: 'ws-purdue', text: p.text, proposalId: p.id })
    expect((await page()).proposals).toEqual([])
    const preambleOf = (sessionId: string) => workPreamble({ workspace: 'x', sector: null, child: false }, modulePreambles(scope(sessionId), [rules]))
    const head = workPreambleHead({ workspace: 'x', sector: null, child: false })
    expect(preambleOf('t2')).toContain(`${head}\n\nHouse rules for Purdue Esports, set by the owner.`)
    expect(preambleOf('t2')).toContain(`- ${p.text}`)
    expect(preambleOf('t3')).not.toContain(p.text)
    expect(preambleOf('chat')).not.toContain(p.text)
    // Off, it is not told; Undo takes the rule away and offers the proposal again.
    await call('work.rules.edit', { id: rule.id, on: false })
    expect(rulesPreamble(db, scope('t1'))).toBeNull()
    await call('work.rules.remove', { id: rule.id, reopen: true })
    expect((await page()).proposals.map((x) => x.id)).toEqual([p.id])
    expect(pushes).toContainEqual({ push: 'work.rules', workspaceId: 'ws-purdue' })
  })

  it('a rule he deletes later dismisses the proposal it came from', async () => {
    const p = await twice()
    const rule = await call<HouseRule>('work.rules.add', { workspaceId: 'ws-purdue', text: p.text, proposalId: p.id })
    await call('work.rules.remove', { id: rule.id })
    expect((await page()).proposals).toEqual([])
    const draft = p.edits[0]!.draftId
    expect((await call<{ proposals: RuleProposal[] }>('work.rules.forDraft', { draftId: draft })).proposals).toEqual([])
  })

  it('a dismissed proposal does not return, however often he does it again', async () => {
    const p = await twice()
    await call('work.rules.decide', { id: p.id, to: 'dismissed' })
    const { stop } = watchDrafts(ctx, () => {})
    lifeos.send(lifeos.draft('t1', GREETING), CUT)
    lifeos.send(lifeos.draft('t1', GREETING), CUT)
    await flush()
    stop()
    expect((await page()).proposals).toEqual([])
    expect(db.prepare("SELECT state FROM work_rules_proposals WHERE habit LIKE 'cut:%'").all()).toEqual([{ state: 'dismissed' }])
  })

  it('Not now keeps it on the page and off the sent mail, until he does it again', async () => {
    const p = await twice()
    await call('work.rules.decide', { id: p.id, to: 'later' })
    const draft = (db.prepare('SELECT draft_id FROM work_rules_edits LIMIT 1').get() as { draft_id: string }).draft_id
    expect((await call<{ proposals: RuleProposal[] }>('work.rules.forDraft', { draftId: draft })).proposals).toEqual([])
    expect((await page()).proposals.map((x) => x.state)).toEqual(['later'])
    const { stop } = watchDrafts(ctx, () => {})
    const again = lifeos.draft('t1', GREETING)
    lifeos.send(again, CUT)
    await flush()
    stop()
    const line = await call<{ workspaceId: string; proposals: RuleProposal[] }>('work.rules.forDraft', { draftId: again })
    expect(line.workspaceId).toBe('ws-purdue')
    expect(line.proposals.map((x) => [x.id, x.state, x.edits.length])).toEqual([[p.id, 'open', 3]])
  })

  it('only a person adds or changes a rule; a thread may not, nor a key without approve', async () => {
    const p = await twice()
    await expect(call('work.rules.add', { workspaceId: 'ws-purdue', text: 'Sign as the director' }, model)).rejects.toThrow('only the owner')
    await expect(call('work.rules.add', { workspaceId: 'ws-purdue', text: 'x', proposalId: p.id }, reader)).rejects.toThrow('only the owner')
    await expect(call('work.rules.decide', { id: p.id, to: 'dismissed' }, model)).rejects.toThrow('only the owner')
    const rule = await call<HouseRule>('work.rules.add', { workspaceId: 'ws-purdue', text: 'Sign as the director' })
    await expect(call('work.rules.edit', { id: rule.id, text: 'Sign as the dean' }, model)).rejects.toThrow('only the owner')
    await expect(call('work.rules.remove', { id: rule.id }, model)).rejects.toThrow('only the owner')
    await expect(call('work.rules.add', { workspaceId: 'ws-code', text: 'x' })).rejects.toThrow('only a Work workspace')
    expect(rules.tools!(scope('t1')).map((t) => t.name)).toEqual(['voice_examples'])
  })
})

describe('rules', () => {
  it('keep his order, and the order must name each rule once', async () => {
    const a = await call<HouseRule>('work.rules.add', { workspaceId: 'ws-purdue', text: 'Sign as Landon Hale' })
    const b = await call<HouseRule>('work.rules.add', { workspaceId: 'ws-purdue', text: 'Send Purdue mail as plain text' })
    await call('work.rules.order', { workspaceId: 'ws-purdue', ids: [b.id, a.id] })
    expect((await page()).rules.map((r) => r.text)).toEqual(['Send Purdue mail as plain text', 'Sign as Landon Hale'])
    expect(rulesPreamble(db, scope('t1'))).toBe('House rules for Purdue Esports, set by the owner. Follow each one in everything you write for this workspace:\n- Send Purdue mail as plain text\n- Sign as Landon Hale')
    await expect(call('work.rules.order', { workspaceId: 'ws-purdue', ids: [b.id] })).rejects.toThrow('every rule')
  })
})

describe('the voice switch', () => {
  const voice = (on: boolean) => db.prepare('UPDATE workspaces SET work_settings = ? WHERE id = ?').run(JSON.stringify({ mayUseDesktop: [], voice: on }), 'ws-purdue')
  const sent = (id: string, sector: string, text: string, sentAt: number) =>
    lifeos.rows.set(id, { _id: id, status: 'sent', sector, sentAt, message: { kind: 'mail', subject: `About ${id}`, text, to: [{ name: 'Dana Lee' }], from: { address: 'landon@purdue.edu' } } })
  const run = (sessionId: string) => rules.tools!(scope(sessionId))[0]!.run({}, { ...ctx, scope: scope(sessionId), sessionId, signal: new AbortController().signal } as unknown as ToolCtx)
  const text = async (sessionId: string) => ((await run(sessionId)) as { content: { text: string }[] }).content[0]!.text

  it('lets a thread read the sector\'s recent sent mail only while it is on', async () => {
    const now = Date.now()
    sent('m1', 'purdue', 'Dana, the budget is attached.', now - 1000)
    sent('m2', 'ref', 'Ref crew: Friday at 6.', now - 500)
    sent('m3', 'purdue', 'An old mail.', now - 40 * 86_400_000)
    await expect(run('t1')).rejects.toThrow('has not turned on his voice')
    expect(rulesPreamble(db, scope('t1'))).toBeNull()
    voice(true)
    const got = await text('t1')
    expect(got).toContain('Dana, the budget is attached.')
    expect(got).not.toContain('Ref crew')
    expect(got).not.toContain('An old mail')
    expect(rulesPreamble(db, scope('t1'))).toContain('voice_examples')
    expect(rulesPreamble(db, scope('t3'))).toBeNull()
    expect(await call('work.rules.voice', { workspaceId: 'ws-purdue' })).toEqual({ on: true, count: 1, since: now - 1000, from: ['landon@purdue.edu'] })
    expect(rules.tools!(scope('chat'))).toEqual([])
  })

  it('keeps the switch readable when LifeOS does not answer', async () => {
    voice(true)
    ctx.lifeos.owner = () => ({ query: async () => Promise.reject(new Error('down')) }) as never
    expect(await call('work.rules.voice', { workspaceId: 'ws-purdue' })).toMatchObject({ on: true, count: null, error: 'LifeOS did not answer: down' })
  })
})

describe('habits', () => {
  const keys = (a: string, b: string) => habitsOf(a, b).map((h) => h.key)

  it('a time written the same way is one habit, whatever the hour', () => {
    expect(keys('Thursday at 3:00 PM works.', 'Thursday at 3 PM works.')).toEqual(['swap:#:## pm→# pm'])
    expect(keys('Doors open at 4:00 PM in the arena.', 'Doors open at 4 PM in the arena.')).toEqual(['swap:#:## pm→# pm'])
    expect(habitsOf('Doors open at 4:00 PM.', 'Doors open at 4 PM.')[0]!.rule).toBe('Write “4 PM”, not “4:00 PM”')
  })

  it('reads a greeting cut, a sign-off changed and an exclamation mark made a full stop', () => {
    expect(keys('Hi Karen, thank you so much for getting back to me so quickly. Our headcount is 120.\n\nSee you there.', 'Hi Karen, our headcount is 120.\n\nSee you there.')).toContain('opening')
    expect(keys('Thursday works.\n\nBest regards,\nLandon', 'Thursday works.\n\nLandon')).toEqual(['signoff:landon'])
    expect(keys('Great, see you then!', 'Great, see you then.')).toEqual(['exclaim'])
    expect(keys('Same words.', 'Same  words.\n')).toEqual([])
  })

  it('reads a sign-off taken out or a name put under it, and widens a figure only when it has no unit', () => {
    const body = 'Hi Sam,\n\nThe venue opens at noon for everyone.'
    expect(keys(`${body}\n\nBest,\nBot`, body)).toEqual(['signoff:none'])
    expect(keys(`${body}\n\nThanks,`, `${body}\n\nThanks,\nLandon`)).toEqual(['signoff:thanks, landon'])
    expect(keys(body, `${body}\n\nLandon`)).toEqual(['signoff:landon'])
    expect(habitsOf('Setup at 8:00 AM sharp.', 'Setup at 7:30 PM sharp.')[0]!.rule).toBe('Write “7:30 PM”, not “8:00 AM”')
  })

  it('unrelated habits in the same mails are each offered', async () => {
    const { stop } = watchDrafts(ctx, () => {})
    for (const t of ['t1', 't2']) lifeos.send(lifeos.draft(t, 'Hi Sam,\n\nGreat, see you then!\n\nBest,\nBot'), 'Hi Sam,\n\nGreat, see you then.\n\nThanks, Landon')
    await flush()
    stop()
    expect((await page()).proposals.map((p) => p.text).sort()).toEqual(['No exclamation marks', 'Sign off with “Thanks, Landon”'])
  })

  it('a broad habit is not offered when a narrower one holds every one of its edits', async () => {
    const { stop } = watchDrafts(ctx, () => {})
    const long = 'Hi Sam, I hope your week is off to a great start and all is well. Thursday at 7 works.\n\nLandon'
    const short = 'Hi Sam, Thursday at 7 works.\n\nLandon'
    lifeos.send(lifeos.draft('t1', long), short)
    lifeos.send(lifeos.draft('t1', long.replace('great', 'good')), short)
    await flush()
    stop()
    // The phrases differ, so only the greeting cut is a habit here.
    expect((await page()).proposals.map((p) => p.text)).toEqual(['Keep the greeting to one line'])
  })
})
