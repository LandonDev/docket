import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import { ensureOutboxTables, HeldStore, INTERRUPTED, itemOfRow, lifeosRunKey, LIVE_LOST, refOfRow, type NewHeld } from './store'

let db: DatabaseSync
let clock: number
let store: HeldStore

const act = (over: Partial<NewHeld> = {}): NewHeld => ({
  workspaceId: 'ws',
  sessionId: 't1',
  sector: 'purdue',
  kind: 'addon.call',
  origin: 'addon:ad_1/post',
  why: 'rule',
  summary: 'Post message with Slack',
  verb: 'Send',
  payload: { tool: 'post', arguments: { text: 'hi' } },
  ...over
})

beforeEach(() => {
  db = new DatabaseSync(':memory:')
  ensureOutboxTables(db)
  clock = 1_000
  store = new HeldStore(db, () => clock++)
})

describe('a held act', () => {
  it('is a row that waits, numbered in the order it was held, with exactly the payload it was given', () => {
    const a = store.insert(act())
    const b = store.insert(act({ summary: 'Second' }))
    expect(a).toMatchObject({ n: 1, state: 'held', runKey: `host:${a.id}`, payload: { tool: 'post', arguments: { text: 'hi' } }, decidedBy: null, attempts: 0 })
    expect(b.n).toBe(2)
    expect(store.list().map((r) => r.id)).toEqual([a.id, b.id])
    expect(store.waiting()).toBe(2)
    expect(itemOfRow(a)).toMatchObject({ ref: { at: 'host', id: a.id }, kind: 'addon.call', workspaceId: 'ws', sessionId: 't1', sector: 'purdue', verb: 'Send', state: 'held', n: 1, why: 'rule' })
  })

  it('is taken for sending by exactly one of any number of presses', () => {
    const a = store.insert(act())
    const first = store.claim(a.id, 'owner')
    expect(first).toMatchObject({ state: 'sending', decidedBy: 'owner', attempts: 1 })
    expect(store.claim(a.id, 'owner')).toBeNull()
    expect(store.claim(a.id, 'grant:gr_1', 'gr_1')).toBeNull()
    expect(store.get(a.id)).toMatchObject({ state: 'sending', decidedBy: 'owner', grantId: null, attempts: 1 })
  })

  it('once sent is never taken again, nor discarded, nor edited', () => {
    const a = store.insert(act())
    store.claim(a.id, 'owner')
    expect(store.settle(a.id, 'sent', { result: { summary: 'Posted' } })).toMatchObject({ state: 'sent', result: { summary: 'Posted' } })
    expect(store.claim(a.id, 'owner')).toBeNull()
    expect(store.discard(a.id, 'owner')).toBeNull()
    expect(store.edit(a.id, { payload: {}, summary: 'x', verb: 'Send' })).toBeNull()
    expect(store.settle(a.id, 'failed', { error: 'late' })).toBeNull()
    expect(store.get(a.id)?.state).toBe('sent')
    expect(store.waiting()).toBe(0)
    expect(store.list({ show: 'decided' }).map((r) => r.id)).toEqual([a.id])
  })

  it('that failed waits on him again and may be pressed again, each press its own attempt', () => {
    const a = store.insert(act())
    store.claim(a.id, 'owner')
    expect(store.settle(a.id, 'failed', { error: 'the server was down' })).toMatchObject({ state: 'failed', error: 'the server was down' })
    expect(store.waiting()).toBe(1)
    expect(store.claim(a.id, 'owner')).toMatchObject({ state: 'sending', attempts: 2, error: null })
  })

  it('is settled only while it is being sent', () => {
    const a = store.insert(act())
    expect(store.settle(a.id, 'sent')).toBeNull()
    expect(store.get(a.id)?.state).toBe('held')
  })

  it('discarded will never go, and one being sent is not discarded under the press', () => {
    const a = store.insert(act())
    const b = store.insert(act())
    expect(store.discard(a.id, 'owner')).toMatchObject({ state: 'discarded', decidedBy: 'owner' })
    expect(store.claim(a.id, 'owner')).toBeNull()
    store.claim(b.id, 'owner')
    expect(store.discard(b.id, 'owner')).toBeNull()
    expect(store.get(b.id)?.state).toBe('sending')
  })

  it('is edited only while it is held or failed: a live act is the screen as it was read', () => {
    const held = store.insert(act())
    const live = store.insert(act({ kind: 'computer.act', state: 'live' }))
    expect(store.edit(held.id, { payload: { tool: 'post', arguments: { text: 'bye' } }, summary: 'Post bye', verb: 'Send' })).toMatchObject({ summary: 'Post bye', payload: { arguments: { text: 'bye' } } })
    expect(store.edit(live.id, { payload: {}, summary: 'x', verb: 'Send' })).toBeNull()
    expect(store.stale(live.id, 'the screen moved on')).toMatchObject({ state: 'stale', error: 'the screen moved on' })
    expect(store.claim(live.id, 'owner')).toBeNull()
  })

  it('takes a new revision at every change, even two in one millisecond, so a press from the first view never sends the second (the hold review)', () => {
    const frozen = new HeldStore(db, () => 5_000)
    const held = frozen.insert(act())
    const first = frozen.edit(held.id, { payload: { tool: 'post', arguments: { text: 'one' } }, summary: 'Post one', verb: 'Send' })!
    const second = frozen.edit(held.id, { payload: { tool: 'post', arguments: { text: 'two' } }, summary: 'Post two', verb: 'Send' })!
    expect(first.updatedAt).toBeGreaterThan(held.updatedAt)
    expect(second.updatedAt).toBeGreaterThan(first.updatedAt)
  })

  it('is never deleted: every state stays in the log', () => {
    const ids = [store.insert(act()), store.insert(act()), store.insert(act())].map((r) => r.id)
    store.discard(ids[0]!, 'owner')
    store.claim(ids[1]!, 'owner')
    store.settle(ids[1]!, 'sent')
    store.closeSessions(['t1'], 'The thread that made this was deleted.')
    store.closeWorkspace('ws', 'gone')
    expect(store.list({ show: 'all' }).map((r) => r.state).sort()).toEqual(['discarded', 'sent', 'stale'])
  })
})

describe('after a stop', () => {
  it('a row that was being sent is not sent again by the host: it reads failed and says it may have gone', () => {
    const a = store.insert(act())
    store.claim(a.id, 'owner')
    // a new process on the same database
    const again = new HeldStore(db, () => clock++)
    expect(again.recover()).toEqual({ interrupted: 1, lost: 0 })
    expect(again.get(a.id)).toMatchObject({ state: 'failed', error: INTERRUPTED, decidedBy: 'owner', attempts: 1, outcomeUnknown: true })
    // recovery itself claims nothing and runs nothing; a second recovery changes nothing
    expect(again.recover()).toEqual({ interrupted: 0, lost: 0 })
  })

  it('a send cut off by the stop may have gone: only a claim made with again takes it, and a LifeOS row, which LifeOS settles, is not marked', () => {
    const a = store.insert(act())
    const m = store.insert(act({ kind: 'mail.send', runKey: lifeosRunKey('outbox', 'ob_9') }))
    store.claim(a.id, 'owner')
    store.claim(m.id, 'owner')
    const again = new HeldStore(db, () => clock++)
    again.recover()
    expect(itemOfRow(again.get(a.id)!).outcomeUnknown).toBe(true)
    expect(again.get(m.id)!.outcomeUnknown).toBe(false)
    expect(again.claim(a.id, 'owner')).toBeNull()
    expect(again.claim(a.id, 'owner', null, { again: true })).toMatchObject({ state: 'sending', outcomeUnknown: false })
    // a failure that says nothing went leaves it pressable as it is
    expect(again.settle(a.id, 'failed', { error: 'refused', unknown: false })).toMatchObject({ outcomeUnknown: false })
    expect(again.claim(a.id, 'owner')).toMatchObject({ state: 'sending' })
    expect(again.settle(a.id, 'failed', { error: 'timed out', unknown: true })).toMatchObject({ outcomeUnknown: true })
  })

  it('a database made before the mark takes each failed host row as one that may have gone', () => {
    const old = new DatabaseSync(':memory:')
    old.exec(`CREATE TABLE work_held_acts (id TEXT PRIMARY KEY, workspace_id TEXT, session_id TEXT, sector TEXT, kind TEXT NOT NULL, origin TEXT NOT NULL, why TEXT NOT NULL DEFAULT 'rule', summary TEXT NOT NULL, verb TEXT NOT NULL DEFAULT 'Send', account TEXT, payload TEXT NOT NULL, state TEXT NOT NULL, run_key TEXT NOT NULL UNIQUE, grant_id TEXT, decided_by TEXT, decided_at INTEGER, result TEXT, error TEXT, routine_run_id TEXT, attempts INTEGER NOT NULL DEFAULT 0, task TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`)
    const row = (id: string, state: string, runKey: string): void =>
      void old.prepare(`INSERT INTO work_held_acts (id, kind, origin, summary, payload, state, run_key, created_at, updated_at) VALUES (?, 'addon.call', 'app', 's', '{}', ?, ?, 1, 1)`).run(id, state, runKey)
    row('ha_f', 'failed', 'host:ha_f')
    row('ha_h', 'held', 'host:ha_h')
    row('ha_l', 'failed', 'lifeos:outbox:ob_1')
    ensureOutboxTables(old)
    ensureOutboxTables(old)
    const s = new HeldStore(old, () => clock++)
    expect([s.get('ha_f'), s.get('ha_h'), s.get('ha_l')].map((r) => r!.outcomeUnknown)).toEqual([true, false, false])
  })

  it('a live act goes stale: its screen went with the process', () => {
    const live = store.insert(act({ kind: 'computer.act', state: 'live' }))
    const held = store.insert(act())
    expect(new HeldStore(db).recover()).toEqual({ interrupted: 0, lost: 1 })
    expect(store.get(live.id)).toMatchObject({ state: 'stale', error: LIVE_LOST })
    expect(store.get(held.id)?.state).toBe('held')
  })
})

describe('a LifeOS-held item', () => {
  it('gets one row, by its run key: a second decision on the same item cannot make another', () => {
    const key = lifeosRunKey('outbox', 'ob_1')
    const row = store.insert(act({ kind: 'mail.send', runKey: key, origin: 'lifeos:outbox/ob_1', why: 'lifeos' }))
    expect(() => store.insert(act({ kind: 'mail.send', runKey: key }))).toThrow()
    expect(store.byRunKey(key)?.id).toBe(row.id)
    expect(store.byRef({ at: 'lifeos', table: 'outbox', id: 'ob_1' })?.id).toBe(row.id)
    expect(refOfRow(row)).toEqual({ at: 'lifeos', table: 'outbox', id: 'ob_1' })
    expect(store.byRef({ at: 'lifeos', table: 'calendarOps', id: 'ob_1' })).toBeNull()
  })

  it('recorded as sent comes back as failed when LifeOS could not send it, and only then', () => {
    const row = store.insert(act({ kind: 'mail.send', runKey: lifeosRunKey('outbox', 'ob_2') }))
    expect(store.failSent(row.id, 'x')).toBeNull()
    store.claim(row.id, 'owner')
    store.settle(row.id, 'sent')
    expect(store.failSent(row.id, 'Gmail refused it')).toMatchObject({ state: 'failed', error: 'Gmail refused it' })
  })
})

describe('grants and rules', () => {
  it('a grant is listed per workspace, removed by a mark and never deleted', () => {
    const g = store.addGrant({ workspaceId: 'ws', kind: 'addon.call', matcher: { tool: 'post' }, label: 'Posts to #general', madeFrom: { at: 'host', id: 'ha_1' } })
    store.addGrant({ workspaceId: 'other', kind: 'addon.call', matcher: {}, label: 'x', madeFrom: { at: 'host', id: 'ha_2' }, routineId: 'r1' })
    expect(store.grants({ workspaceId: 'ws' })).toEqual([{ ...g, routineId: null, removedAt: null }])
    expect(store.removeGrant(g.id)?.removedAt).toBeGreaterThan(0)
    expect(store.grants({ workspaceId: 'ws' })).toEqual([])
    expect(store.grants({ workspaceId: 'ws', all: true })).toHaveLength(1)
    expect(store.grants()).toHaveLength(1)
  })

  it("a tool's rule is kept with the server and the tool it was set for", () => {
    store.setRule({ addonId: 'ad_1', tool: 'post', rule: 'runs', hints: { readOnly: true }, specDigest: 'spec-a', toolDigest: 'tool-a', setBy: 'owner' })
    expect(store.rule('ad_1', 'post')).toMatchObject({ rule: 'runs', specDigest: 'spec-a', toolDigest: 'tool-a', hints: { readOnly: true }, setBy: 'owner' })
    store.setRule({ addonId: 'ad_1', tool: 'post', rule: 'off', hints: {}, specDigest: 'spec-b', toolDigest: 'tool-b', setBy: 'owner' })
    expect(store.rules('ad_1')).toHaveLength(1)
    expect(store.rule('ad_1', 'post')).toMatchObject({ rule: 'off', specDigest: 'spec-b' })
    expect(store.rule('ad_1', 'read')).toBeNull()
    store.dropRules('ad_1')
    expect(store.rules('ad_1')).toEqual([])
  })
})
