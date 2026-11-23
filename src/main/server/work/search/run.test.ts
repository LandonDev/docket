import { describe, expect, it } from 'vitest'
import type { MentionSource, WorkModule } from '../modules'
import { SEARCH_ALL, SEARCH_PER_GROUP } from '@shared/work/search'
import { listSources, runSearch, type SearchRun } from './run'
import type { SearchSource } from './source'
import { COSMIC, everywhere, fakeSource, hit, makeRig, onlyPurdue, phone, PURDUE, window } from './testkit'

/** The frame: every rule a search keeps whatever its sources do, each proven with fake sources. */

const module = (id: WorkModule['id'], over: Partial<WorkModule>): WorkModule => ({ id, ensure() {}, ...over })
const run = (rig: ReturnType<typeof makeRig>, own: SearchSource[], over: Partial<SearchRun> = {}) => runSearch(rig.ctx, { modules: [], own, reach: everywhere, text: 'budget', by: window, ...over })
const mention = (kind: MentionSource['kind']): MentionSource => ({ kind, search: async () => [] })

describe('which sources are asked', () => {
  it("asks one provider a kind: a module's own line, then this pillar's source, then the mention bridge", () => {
    const modules = [
      module('mail', { search: [fakeSource('mail', [])], mentions: [mention('mail')] }),
      module('lifeos', { mentions: [mention('task'), mention('person')] }),
      module('outbox', { mentions: [mention('held')] })
    ]
    const listed = listSources(modules, [fakeSource('mail', []), fakeSource('task', []), fakeSource('thread', [])])
    expect(listed.map((l) => l.id)).toEqual(['mail.mail', 'search.task', 'search.thread', 'lifeos.person', 'outbox.held'])
  })
  it('asks both of a pillar that lists two sources of one kind, each by its own id', () => {
    const listed = listSources([], [fakeSource('thread', []), fakeSource('thread', [], { tier: 'network' })])
    expect(listed.map((l) => l.id)).toEqual(['search.thread/instant', 'search.thread/network'])
  })
  it("never reads the search pillar's own module line", () => {
    expect(listSources([module('search', { search: [fakeSource('x', [])] })], [])).toEqual([])
  })
})

describe('the tiers', () => {
  it('answers the instant sources at once and names the network ones as pending', async () => {
    const rig = makeRig()
    const fast = fakeSource('thread', [hit('thread:1', PURDUE)])
    const slow = fakeSource('mail', [hit('m1', PURDUE)], { tier: 'network' })
    const answer = await run(rig, [fast, slow], { tier: 'instant' })
    expect(answer.groups.map((g) => g.source)).toEqual(['search.thread'])
    expect(answer.pending).toEqual([{ source: 'search.mail', kind: 'mail' }])
    expect(slow.asks).toHaveLength(0)
  })
  it('asks only the sources named, whatever their tier', async () => {
    const rig = makeRig()
    const fast = fakeSource('thread', [hit('thread:1', PURDUE)])
    const slow = fakeSource('mail', [hit('m1', PURDUE)], { tier: 'network' })
    const answer = await run(rig, [fast, slow], { sources: ['search.mail'] })
    expect(answer.groups.map((g) => g.source)).toEqual(['search.mail'])
    expect(answer.pending).toEqual([])
    expect(fast.asks).toHaveLength(0)
  })
  it('asks every source when no tier is named, and stands the groups in the fixed order', async () => {
    const rig = makeRig()
    const answer = await run(rig, [fakeSource('thread', [hit('t', PURDUE)]), fakeSource('zebra', [hit('z', PURDUE)]), fakeSource('person', [hit('p', PURDUE)], { tier: 'network' })])
    expect(answer.groups.map((g) => g.kind)).toEqual(['person', 'thread', 'zebra'])
    expect(answer.groups.map((g) => g.label)).toEqual(['People', 'Threads', 'zebra'])
  })
  it('answers nothing for no words, and nothing for a reach with no job', async () => {
    const rig = makeRig()
    const source = fakeSource('mail', [hit('m1', PURDUE)])
    expect(await run(rig, [source], { text: '   ' })).toEqual({ groups: [], pending: [], quiet: [] })
    expect(await run(rig, [source], { reach: { workspaces: [], chats: false, sessionId: null } })).toEqual({ groups: [], pending: [], quiet: [] })
    expect(source.asks).toHaveLength(0)
  })
  it('hands a source the trimmed words, the reach, the caller and a limit', async () => {
    const rig = makeRig()
    const source = fakeSource('mail', [])
    await run(rig, [source], { text: '  spring lan ', reach: onlyPurdue })
    expect(source.asks[0]).toMatchObject({ text: 'spring lan', reach: onlyPurdue, limit: SEARCH_PER_GROUP, by: window })
  })
})

describe('a source that fails', () => {
  it('is one quiet line when it throws, and the others still answer', async () => {
    const rig = makeRig()
    const answer = await run(rig, [
      fakeSource('mail', () => {
        throw new Error('boom')
      }),
      fakeSource('task', [hit('t1', PURDUE)])
    ])
    expect(answer.groups.map((g) => g.kind)).toEqual(['task'])
    expect(answer.quiet).toEqual([{ cause: 'source:search.mail', line: 'Mail did not answer.' }])
    expect(rig.logs.join('\n')).toContain('search.mail did not answer: boom')
  })
  it('is one quiet line when it stalls past the wait, and its signal is aborted', async () => {
    const rig = makeRig()
    let aborted = false
    const stalled = fakeSource('mail', (ask) => new Promise(() => ask.signal.addEventListener('abort', () => (aborted = true))))
    const answer = await run(rig, [stalled, fakeSource('task', [hit('t1', PURDUE)])], { waitMs: 20 })
    expect(answer.groups.map((g) => g.kind)).toEqual(['task'])
    expect(answer.quiet).toEqual([{ cause: 'source:search.mail', line: 'Mail did not answer.' }])
    expect(aborted).toBe(true)
  })
  it('says nothing when the caller gave the search up', async () => {
    const rig = makeRig()
    const gone = new AbortController()
    const source = fakeSource('mail', (ask) => new Promise((_, reject) => ask.signal.addEventListener('abort', () => reject(new Error('aborted')))))
    const asked = run(rig, [source], { signal: gone.signal })
    gone.abort()
    expect(await asked).toEqual({ groups: [], pending: [], quiet: [] })
  })
})

describe('the cap', () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => hit(`m${i}`, PURDUE))
  it('keeps four of a kind and says there are more, never trusting a count', async () => {
    const rig = makeRig()
    const [group] = (await run(rig, [fakeSource('mail', many(9))])).groups
    expect(group.hits.map((h) => h.key)).toEqual(['m0', 'm1', 'm2', 'm3'])
    expect(group.more).toBe(true)
    const [exact] = (await run(rig, [fakeSource('mail', many(4))])).groups
    expect(exact.more).toBe(false)
  })
  it('one kind alone asks only that kind, for thirty rows', async () => {
    const rig = makeRig()
    const mail = fakeSource('mail', many(40))
    const task = fakeSource('task', [hit('t1', PURDUE)])
    const answer = await run(rig, [mail, task], { kind: 'mail' })
    expect(answer.groups).toHaveLength(1)
    expect(answer.groups[0].hits).toHaveLength(SEARCH_ALL)
    expect(answer.groups[0].more).toBe(true)
    expect(mail.asks[0].limit).toBe(SEARCH_ALL)
    expect(task.asks).toHaveLength(0)
  })
  it("leaves out a group with no rows, and stamps each hit with its source's kind", async () => {
    const rig = makeRig()
    const answer = await run(rig, [fakeSource('mail', []), fakeSource('task', [hit('t1', PURDUE, { kind: 'mail' })])])
    expect(answer.groups.map((g) => g.kind)).toEqual(['task'])
    expect(answer.groups[0].hits[0].kind).toBe('task')
  })
  it('cuts a snippet to one short line', async () => {
    const rig = makeRig()
    const [group] = (await run(rig, [fakeSource('mail', [hit('m1', PURDUE, { snippet: `the  budget\n${'x'.repeat(400)}` })])])).groups
    expect(group.hits[0].snippet).toHaveLength(160)
    expect(group.hits[0].snippet).toMatch(/^the budget x/)
  })
})

describe('the fence, checked a second time', () => {
  it("drops a hit whose job is not in the reach, whatever the source answered, and logs it", async () => {
    const rig = makeRig()
    const careless = fakeSource('mail', [hit('mine', PURDUE), hit('theirs', COSMIC), hit('chat', null), hit('ghost', 'ws-elsewhere')])
    const [group] = (await run(rig, [careless], { reach: onlyPurdue })).groups
    expect(group.hits.map((h) => h.key)).toEqual(['mine'])
    expect(rig.logs.join('\n')).toContain('search.mail answered 3 hit(s) outside the reach; dropped')
  })
  it('keeps a Work Chats hit only when the reach has Work Chats', async () => {
    const rig = makeRig()
    const [group] = (await run(rig, [fakeSource('thread', [hit('chat', null), hit('mine', PURDUE)])])).groups
    expect(group.hits.map((h) => h.key)).toEqual(['chat', 'mine'])
  })
})

describe('LifeOS', () => {
  it('is not asked while it is not connected, and is said once in its own words however many kinds it feeds', async () => {
    const rig = makeRig()
    rig.lifeosDown('This host is not signed in to LifeOS')
    const mail = fakeSource('mail', [hit('m1', PURDUE)], { lifeos: true, tier: 'network' })
    const task = fakeSource('task', [hit('t1', PURDUE)], { lifeos: true, tier: 'network' })
    const threads = fakeSource('thread', [hit('th', PURDUE)])
    const answer = await run(rig, [mail, task, threads], { tier: 'instant' })
    expect(answer.quiet).toEqual([{ cause: 'lifeos', line: 'This host is not signed in to LifeOS' }])
    expect(answer.pending).toEqual([])
    expect(answer.groups.map((g) => g.kind)).toEqual(['thread'])
    expect(mail.asks).toHaveLength(0)
  })
  it('that goes while a source asks is still one line, its own', async () => {
    const rig = makeRig()
    const gone = () => {
      throw Object.assign(new Error('LifeOS is unreachable'), { name: 'LifeosUnavailable' })
    }
    const answer = await run(rig, [fakeSource('mail', gone, { lifeos: true }), fakeSource('task', gone, { lifeos: true })])
    expect(answer.quiet).toEqual([{ cause: 'lifeos', line: 'LifeOS is unreachable' }])
  })
  it("is left out, with no line, when another host asks it (own)", async () => {
    const rig = makeRig()
    rig.lifeosDown()
    const mail = fakeSource('mail', [hit('m1', PURDUE)], { lifeos: true, tier: 'network' })
    const answer = await run(rig, [mail, fakeSource('thread', [hit('th', PURDUE)])], { skipLifeos: true, tier: 'instant' })
    expect(answer.quiet).toEqual([])
    expect(answer.pending).toEqual([])
    expect(answer.groups.map((g) => g.kind)).toEqual(['thread'])
  })
})

describe('a remote key', () => {
  const file = (path: string) => ({ to: 'file' as const, ref: { at: 'file', host: 'env_box', path }, name: 'x' })
  it('is shown a file only when it could have named the file itself', async () => {
    const rig = makeRig()
    rig.reachable.add('/work/ws-purdue/Budget.xlsx')
    const files = fakeSource('file', [hit('file:a', PURDUE, { open: file('/work/ws-purdue/Budget.xlsx') }), hit('file:b', PURDUE, { open: file('/Users/him/OneDrive/Payroll.xlsx') })])
    const [remote] = (await run(rig, [files], { by: phone })).groups
    expect(remote.hits.map((h) => h.key)).toEqual(['file:a'])
    const [local] = (await run(rig, [files])).groups
    expect(local.hits.map((h) => h.key)).toEqual(['file:a', 'file:b'])
  })
  it('is refused a chip that names a file outside its roots too', async () => {
    const rig = makeRig()
    const chip = { kind: 'doc' as const, label: 'Plan', ref: { at: 'file' as const, host: 'env_box', path: '/elsewhere/Plan.tcdoc' } }
    const answer = await run(rig, [fakeSource('doc', [hit('d', PURDUE, { open: { to: 'chip', chip }, chip })])], { by: phone })
    expect(answer.groups).toEqual([])
  })
})

describe('what he opened before', () => {
  it('goes first in a list with no ranking of its own, and leaves a ranked source alone', async () => {
    const rig = makeRig()
    const opened = (key: string): number | undefined => ({ p3: 50, p2: 20 })[key]
    const rows = [hit('p1', PURDUE), hit('p2', PURDUE), hit('p3', PURDUE)]
    const [list] = (await run(rig, [fakeSource('person', rows, { unranked: true })], { opened })).groups
    expect(list.hits.map((h) => h.key)).toEqual(['p3', 'p2', 'p1'])
    const [ranked] = (await run(rig, [fakeSource('person', rows)], { opened })).groups
    expect(ranked.hits.map((h) => h.key)).toEqual(['p1', 'p2', 'p3'])
  })
})

describe('the kinds a caller names', () => {
  it('asks only those', async () => {
    const rig = makeRig()
    const answer = await run(rig, [fakeSource('mail', [hit('m', PURDUE)]), fakeSource('task', [hit('t', PURDUE)]), fakeSource('thread', [hit('th', PURDUE)])], { kinds: ['task', 'thread'], limit: 2 })
    expect(answer.groups.map((g) => g.kind)).toEqual(['task', 'thread'])
  })
})
