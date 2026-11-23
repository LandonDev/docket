import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ClientRequest } from '@shared/contract'
import { ClientRequestSchema } from '@shared/contract'
import { SEARCH_RECENTS, SEARCH_RECENTS_KEPT, type SearchAnswer } from '@shared/work/search'
import { WORK_MODULES, type Caller, type WorkModule } from '../modules'
import { OWN_SOURCES, search } from './index'
import { recentGroup, recordOpened } from './recents'
import { windowReach } from './reach'
import { COSMIC, fakeSource, hit, makeRig, phone, PURDUE, window } from './testkit'

/** The module: its two methods, Recent, and a pillar's `search` line found with no edit under work/search/. */

const req = (method: string, params: unknown): ClientRequest => ({ id: '1', method, params }) as ClientRequest
async function ask(rig: ReturnType<typeof makeRig>, params: Record<string, unknown>, by: Caller = window): Promise<SearchAnswer> {
  const answer = await search.handle!(req('work.search.query', params), rig.ctx, by)
  if (!answer.handled) throw new Error('not handled')
  return answer.result as SearchAnswer
}
const opened = (rig: ReturnType<typeof makeRig>, h: ReturnType<typeof hit>, by: Caller = window) => search.handle!(req('work.search.opened', { hit: h }), rig.ctx, by)

const registry = [...WORK_MODULES]
const own = [...OWN_SOURCES]
// Each test names the sources it asks; the pillar's own are proven in sources/.
beforeEach(() => void OWN_SOURCES.splice(0, OWN_SOURCES.length))
afterEach(() => {
  WORK_MODULES.splice(0, WORK_MODULES.length, ...registry)
  OWN_SOURCES.splice(0, OWN_SOURCES.length, ...own)
})

describe('the wire', () => {
  it('parses both methods, bounds the words and refuses a hit that is not one', () => {
    const parse = (method: string, params: unknown) => ClientRequestSchema.safeParse({ id: '1', method, params }).success
    expect(parse('work.search.query', { text: 'budget' })).toBe(true)
    expect(parse('work.search.query', { text: 'budget', workspaceId: PURDUE, tier: 'instant', kind: 'mail', own: true })).toBe(true)
    expect(parse('work.search.query', { text: 'budget', sources: ['search.mail'] })).toBe(true)
    expect(parse('work.search.query', { text: 'x'.repeat(201) })).toBe(false)
    expect(parse('work.search.query', { text: 'budget', tier: 'network' })).toBe(false)
    expect(parse('work.search.query', {})).toBe(false)
    expect(parse('work.search.opened', { hit: hit('lifeos:mailThreads:m1', PURDUE) })).toBe(true)
    expect(parse('work.search.opened', { hit: hit('thread:t1', null, { open: { to: 'thread', sessionId: 't1', seq: 4 } }) })).toBe(true)
    expect(parse('work.search.opened', { hit: { key: 'k', title: 'no open' } })).toBe(false)
    // `open.with` is a small record of ids, never a bag
    const big = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`k${i}`, 'v']))
    expect(parse('work.search.opened', { hit: hit('k', PURDUE, { open: { to: 'view', view: 'mail', with: big } }) })).toBe(false)
    expect(parse('work.search.opened', { hit: hit('k', PURDUE, { open: { to: 'view', view: 'docs', with: { doc: { id: 'd1', title: 'Plan' } } } }) })).toBe(true)
  })
})

describe('work.search.query', () => {
  it("finds a pillar's own search line with no edit under work/search/", async () => {
    const rig = makeRig()
    const money: WorkModule = { id: 'mail', ensure() {}, search: [fakeSource('receipt', [hit('receipt:1', PURDUE, { title: 'Budget dinner' })], { label: 'Receipts' })] }
    WORK_MODULES.splice(0, WORK_MODULES.length, search, money)
    const answer = await ask(rig, { text: 'budget' })
    expect(answer.groups.map((g) => [g.source, g.kind, g.label, g.hits.map((h) => h.title)])).toEqual([['mail.receipt', 'receipt', 'Receipts', ['Budget dinner']]])
  })
  it('names the one job the window asks for, and shows nothing of another', async () => {
    const rig = makeRig()
    OWN_SOURCES.splice(0, OWN_SOURCES.length, fakeSource('mail', (a) => a.reach.workspaces.map((w) => hit(`m-${w.id}`, w.id))))
    WORK_MODULES.splice(0, WORK_MODULES.length, search)
    expect((await ask(rig, { text: 'budget' })).groups[0].hits.map((h) => h.workspaceId)).toEqual([PURDUE, COSMIC, 'ws-bare'])
    expect((await ask(rig, { text: 'budget', workspaceId: COSMIC })).groups[0].hits.map((h) => h.workspaceId)).toEqual([COSMIC])
    expect((await ask(rig, { text: 'budget', workspaceId: 'ws-code' })).groups).toEqual([])
  })
  it('answers both speeds of one keystroke', async () => {
    const rig = makeRig()
    OWN_SOURCES.splice(0, OWN_SOURCES.length, fakeSource('thread', [hit('thread:1', PURDUE)]), fakeSource('mail', [hit('m1', PURDUE)], { tier: 'network' }))
    WORK_MODULES.splice(0, WORK_MODULES.length, search)
    const first = await ask(rig, { text: 'budget', tier: 'instant' })
    expect(first.groups.map((g) => g.kind)).toEqual(['thread'])
    expect(first.pending).toEqual([{ source: 'search.mail', kind: 'mail' }])
    const second = await ask(rig, { text: 'budget', sources: first.pending.map((p) => p.source) })
    expect(second.groups.map((g) => g.kind)).toEqual(['mail'])
  })
})

describe('Recent', () => {
  it('is what nothing typed answers: the newest things he opened, and nothing else', async () => {
    const rig = makeRig()
    expect(await ask(rig, { text: '' })).toEqual({ groups: [], pending: [], quiet: [] })
    await opened(rig, hit('lifeos:mailThreads:m1', PURDUE, { title: 'Budget for the LAN', detail: 'Dana Kim', snippet: 'the body of the mail' }))
    await opened(rig, hit('thread:t9', null, { kind: 'thread', title: 'Budget review', open: { to: 'thread', sessionId: 't9' } }))
    const { groups, pending, quiet } = await ask(rig, { text: '  ' })
    expect(pending).toEqual([])
    expect(quiet).toEqual([])
    expect(groups).toHaveLength(1)
    expect(groups[0]).toMatchObject({ source: 'search.recent', kind: 'recent', label: 'Recent', more: false })
    expect(groups[0].hits.map((h) => h.title).sort()).toEqual(['Budget for the LAN', 'Budget review'])
  })
  it('keeps the title, the kind, the id and the job, and never a fact, a snippet or the words a chip carried', async () => {
    const rig = makeRig()
    const chip = { kind: 'mail' as const, label: 'Budget for the LAN', ref: { at: 'lifeos' as const, table: 'mailThreads' as const, id: 'm1' }, excerpt: 'Dear all, the numbers are', quote: 'secret' }
    await opened(rig, hit('lifeos:mailThreads:m1', PURDUE, { title: 'Budget for the LAN', detail: 'Dana Kim', snippet: 'Dear all', at: 5, chip }))
    const row = rig.db.prepare(`SELECT hit FROM work_search_recent`).get() as { hit: string }
    expect(JSON.parse(row.hit)).toEqual({
      key: 'lifeos:mailThreads:m1',
      kind: 'mail',
      title: 'Budget for the LAN',
      workspaceId: PURDUE,
      open: { to: 'view', view: 'mail', with: { mail: 'lifeos:mailThreads:m1' } },
      chip: { kind: 'mail', label: 'Budget for the LAN', ref: { at: 'lifeos', table: 'mailThreads', id: 'm1' } }
    })
    expect(row.hit).not.toContain('Dear all')
    expect(row.hit).not.toContain('secret')
  })
  it('opening a thing again moves it to the top and keeps one row', () => {
    const rig = makeRig()
    recordOpened(rig.db, hit('a', PURDUE), 1)
    recordOpened(rig.db, hit('b', PURDUE), 2)
    recordOpened(rig.db, hit('a', PURDUE), 3)
    expect(recentGroup(rig.db, windowReach(rig.ctx))!.hits.map((h) => h.key)).toEqual(['a', 'b'])
  })
  it(`keeps the newest ${SEARCH_RECENTS_KEPT} and shows the newest ${SEARCH_RECENTS}`, () => {
    const rig = makeRig()
    for (let i = 0; i < SEARCH_RECENTS_KEPT + 10; i++) recordOpened(rig.db, hit(`k${i}`, PURDUE), i)
    const kept = rig.db.prepare(`SELECT key FROM work_search_recent ORDER BY opened_at`).all() as { key: string }[]
    expect(kept).toHaveLength(SEARCH_RECENTS_KEPT)
    expect(kept[0].key).toBe('k10')
    expect(recentGroup(rig.db, windowReach(rig.ctx))!.hits.map((h) => h.key)).toEqual(Array.from({ length: SEARCH_RECENTS }, (_, i) => `k${SEARCH_RECENTS_KEPT + 9 - i}`))
  })
  it('sends eight he can tell apart: two things that would read the same (two messages of one conversation) are one, the newest', () => {
    const rig = makeRig()
    for (let i = 0; i < 9; i++) recordOpened(rig.db, hit(`msg${i}`, PURDUE, { kind: 'message', title: '#launch-crew' }), 100 + i)
    for (let i = 0; i < 9; i++) recordOpened(rig.db, hit(`mail${i}`, PURDUE, { title: `Mail ${i}` }), i)
    const hits = recentGroup(rig.db, windowReach(rig.ctx))!.hits
    expect(hits.map((h) => h.key)).toEqual(['msg8', 'mail8', 'mail7', 'mail6', 'mail5', 'mail4', 'mail3', 'mail2'])
    // the same title in another job is another thing
    recordOpened(rig.db, hit('msgC', COSMIC, { kind: 'message', title: '#launch-crew' }), 500)
    expect(recentGroup(rig.db, windowReach(rig.ctx))!.hits.slice(0, 2).map((h) => h.key)).toEqual(['msgC', 'msg8'])
  })
  it('held to one kind, answers the last of that kind, picked before the eight are counted', async () => {
    const rig = makeRig()
    recordOpened(rig.db, hit('lifeos:mailThreads:old', PURDUE, { title: 'An old mail' }), 1)
    for (let i = 0; i < 9; i++) recordOpened(rig.db, hit(`thread:t${i}`, PURDUE, { kind: 'thread', title: `Thread ${i}`, open: { to: 'thread', sessionId: `t${i}` } }), 10 + i)
    expect((await ask(rig, { text: '' })).groups[0].hits.map((h) => h.kind)).toEqual(Array.from({ length: SEARCH_RECENTS }, () => 'thread'))
    expect((await ask(rig, { text: '', kind: 'mail' })).groups[0].hits.map((h) => h.key)).toEqual(['lifeos:mailThreads:old'])
    expect((await ask(rig, { text: '', kind: 'person' })).groups).toEqual([])
  })
  it('shows only things whose job still exists, and a deleted job takes its rows with it', async () => {
    const rig = makeRig()
    await opened(rig, hit('a', PURDUE))
    await opened(rig, hit('b', COSMIC))
    await opened(rig, hit('c', null))
    rig.db.prepare(`DELETE FROM workspaces WHERE id = ?`).run(COSMIC)
    expect((await ask(rig, { text: '' })).groups[0].hits.map((h) => h.key).sort()).toEqual(['a', 'c'])
    search.workspaceRemoved!(COSMIC, rig.ctx)
    expect((rig.db.prepare(`SELECT key FROM work_search_recent ORDER BY key`).all() as { key: string }[]).map((r) => r.key)).toEqual(['a', 'c'])
  })
  it('scoped to one job shows that job alone', async () => {
    const rig = makeRig()
    await opened(rig, hit('a', PURDUE))
    await opened(rig, hit('b', COSMIC))
    expect((await ask(rig, { text: '', workspaceId: COSMIC })).groups[0].hits.map((h) => h.key)).toEqual(['b'])
  })
  it('writes no mark for a thing of a job this host does not have', async () => {
    const rig = makeRig()
    await opened(rig, hit('x', 'ws-on-another-host'))
    await opened(rig, hit('y', 'ws-code'))
    expect(rig.db.prepare(`SELECT COUNT(*) AS n FROM work_search_recent`).get()).toEqual({ n: 0 })
  })
  it('shows a remote key a recent file only when the key could name the file', async () => {
    const rig = makeRig()
    const file = (path: string) => ({ to: 'file' as const, ref: { at: 'file', host: 'env_box', path }, name: 'x' })
    await opened(rig, hit('file:in', PURDUE, { kind: 'file', open: file('/work/ws-purdue/Budget.xlsx') }))
    await opened(rig, hit('file:out', PURDUE, { kind: 'file', open: file('/Users/him/OneDrive/Payroll.xlsx') }))
    rig.reachable.add('/work/ws-purdue/Budget.xlsx')
    expect((await ask(rig, { text: '' }, phone)).groups[0].hits.map((h) => h.key)).toEqual(['file:in'])
    expect((await ask(rig, { text: '' })).groups[0].hits.map((h) => h.key).sort()).toEqual(['file:in', 'file:out'])
  })
})

describe('the module', () => {
  it('answers no other method, and registers no act, tool of the hold or push', async () => {
    const rig = makeRig()
    expect(await search.handle!(req('work.search.list', {}), rig.ctx, window)).toEqual({ handled: false })
    expect(search.acts).toBeUndefined()
    expect(search.onPush).toBeUndefined()
  })
})
