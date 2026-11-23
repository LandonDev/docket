import { describe, expect, it } from 'vitest'
import type { ClientRequest } from '@shared/contract'
import { handled, NOT_HANDLED, NotBuilt } from '@shared/work'
import type { SearchReach } from '@shared/work/search'
import type { Caller, WorkModule } from '../../modules'
import { askPillar } from '../ask'
import { runSearch } from '../run'
import { COSMIC, everywhere, makeRig, onlyPurdue, phone, PURDUE, thread, window } from '../testkit'
import { fileSources, filesHoldLifeos } from './files'
import { doc } from './lifeos'
import { messageSource } from './messages'

/**
 * What is another pillar's to find, asked through that pillar's own wire
 * method with the caller the search was given: Files and Messages, each
 * against a stand-in module. A method that is not built is absent, with no
 * line.
 */

type Seen = { method: string; params: Record<string, unknown>; by: Caller }[]
/** A pillar that answers the methods it is given, and records who asked. */
function standIn(id: string, answers: Record<string, (params: Record<string, unknown>, by: Caller) => unknown>, seen: Seen = []): WorkModule & { seen: Seen } {
  return {
    id: id as WorkModule['id'],
    seen,
    ensure() {},
    async handle(req: ClientRequest, _ctx, by) {
      const params = ((req as { params?: unknown }).params ?? {}) as Record<string, unknown>
      seen.push({ method: req.method, params, by })
      const answer = answers[req.method]
      return answer ? handled(answer(params, by)) : NOT_HANDLED
    }
  }
}
const ask = (text: string, reach: SearchReach = everywhere, limit = 4, by: Caller = window) => ({ text, reach, limit, by, signal: new AbortController().signal })

describe('asking another pillar', () => {
  it("calls the pillar's own method through its module with the caller given", async () => {
    const rig = makeRig()
    const money = standIn('money', { 'work.money.search': (p) => ({ hits: [p.query] }) })
    expect(await askPillar(rig.ctx, [money], 'work.money.search', { workspaceId: PURDUE, query: 'pizza' }, thread('t1'))).toEqual({ hits: ['pizza'] })
    expect(money.seen).toEqual([{ method: 'work.money.search', params: { workspaceId: PURDUE, query: 'pizza' }, by: thread('t1') }])
  })
  it('reads a method that is not built, not known, or whose pillar did not load as absent', async () => {
    const rig = makeRig()
    const declared = standIn('files', {})
    const throwing: WorkModule = { id: 'files', ensure() {}, handle: async (req) => { throw new NotBuilt(req.method, 54) } }
    const notYet: WorkModule = { id: 'files', ensure() {}, handle: async () => { throw new Error('Files cannot search yet: that arrives with its milestone.') } }
    const bare: WorkModule = { id: 'files', ensure() {} }
    for (const modules of [[declared], [throwing], [notYet], [bare], []]) expect(await askPillar(rig.ctx, modules, 'work.files.names', { workspaceId: PURDUE, text: 'x' }, window)).toBeUndefined()
    expect(await askPillar(rig.ctx, [declared], 'session.search', {}, window)).toBeUndefined()
  })
  it("hands on a fault of the pillar's own", async () => {
    const rig = makeRig()
    const broken: WorkModule = { id: 'files', ensure() {}, handle: async () => { throw new Error('the library is signed out') } }
    await expect(askPillar(rig.ctx, [broken], 'work.files.names', {}, window)).rejects.toThrow('the library is signed out')
  })
})

describe('files', () => {
  const entry = (key: string, name: string, over: object = {}) => ({ key, ref: { at: 'file', host: 'env_box', path: `/work/${name}` }, folder: null, name, kind: 'sheet', changed: 7, ...over })
  const files = () =>
    standIn('files', {
      'work.files.names': (p) => ({
        entries:
          p.workspaceId === PURDUE
            ? [entry('k1', 'Budget FY27.xlsx', { where: { place: 'teams:esports', name: 'Esports', trail: ['Finance'] }, local: false }), { key: 'k2', ref: null, folder: { at: 'place', id: 'x' }, name: 'Budget folder', kind: 'folder' }]
            : p.workspaceId === COSMIC
              ? [entry('k3', 'Server budget.xlsx')]
              : []
      }),
      'work.files.search': (p) => ({ entries: p.workspaceId === PURDUE ? Array.from({ length: 40 }, (_, i) => entry(`s${i}`, `Budget ${i}.xlsx`)) : [] })
    })
  it("are Files' names, a job in reach at a time, each with its place as the fact and Files' own ref to open it", async () => {
    const rig = makeRig()
    const module = files()
    const [names] = fileSources([module])
    const hits = await names.search(ask('budget'), rig.ctx)
    expect(names.tier).toBe('instant')
    expect(hits).toEqual([
      { key: 'file:k1', kind: 'file', title: 'Budget FY27.xlsx', detail: 'Esports › Finance', at: 7, workspaceId: PURDUE, open: { to: 'file', ref: { at: 'file', host: 'env_box', path: '/work/Budget FY27.xlsx' }, name: 'Budget FY27.xlsx' }, cloud: true },
      { key: 'file:k3', kind: 'file', title: 'Server budget.xlsx', at: 7, workspaceId: COSMIC, open: { to: 'file', ref: { at: 'file', host: 'env_box', path: '/work/Server budget.xlsx' }, name: 'Server budget.xlsx' } }
    ])
    expect(module.seen.map((s) => [s.method, s.params])).toEqual([
      ['work.files.names', { workspaceId: PURDUE, text: 'budget' }],
      ['work.files.names', { workspaceId: COSMIC, text: 'budget' }],
      ['work.files.names', { workspaceId: 'ws-bare', text: 'budget' }]
    ])
  })
  it("asks Files as the caller the search was given, so Files' own fence answers", async () => {
    const rig = makeRig()
    const module = files()
    await fileSources([module])[0].search(ask('budget', onlyPurdue, 4, phone), rig.ctx)
    expect(module.seen).toEqual([{ method: 'work.files.names', params: { workspaceId: PURDUE, text: 'budget' }, by: phone }])
  })
  it("asks Files' search of every place only for all files, never as he types", async () => {
    const rig = makeRig()
    const module = files()
    const own = fileSources([module])
    const typed = await runSearch(rig.ctx, { modules: [], own, reach: onlyPurdue, text: 'budget', by: window, tier: 'instant' })
    expect(typed.pending).toEqual([])
    expect(typed.groups.map((g) => g.source)).toEqual(['search.file/instant'])
    expect(module.seen.some((s) => s.method === 'work.files.search')).toBe(false)
    const all = await runSearch(rig.ctx, { modules: [], own, reach: onlyPurdue, text: 'budget', by: window, kind: 'file', sources: ['search.file/network'] })
    expect(all.groups[0].hits).toHaveLength(30)
    expect(all.groups[0].more).toBe(true)
    expect(module.seen.filter((s) => s.method === 'work.files.search').map((s) => s.params)).toEqual([{ workspaceId: PURDUE, query: 'budget' }])
  })
  it('is absent, with no line, until Files answers', async () => {
    const rig = makeRig()
    const answer = await runSearch(rig.ctx, { modules: [], own: fileSources([standIn('files', {})]), reach: everywhere, text: 'budget', by: window })
    expect(answer).toEqual({ groups: [], pending: [], quiet: [] })
  })
})

describe('documents, where Files lists LifeOS', () => {
  const lifeos = (rig: ReturnType<typeof makeRig>): void => {
    rig.rows['docs:list'] = (a: Record<string, unknown>) => ({ page: [{ _id: `d-${a.sector}`, sector: a.sector, title: 'Budget notes' }] })
    rig.rows['catalog:search'] = () => []
  }
  it('stand down for a job whose Files answers names and holds LifeOS as a place, and stay for the others', async () => {
    const rig = makeRig()
    lifeos(rig)
    const files = standIn('files', { 'work.files.names': () => ({ entries: [] }), 'work.files.places': (p) => ({ places: p.workspaceId === PURDUE ? [{ kind: 'folder' }, { kind: 'lifeos' }] : [{ kind: 'folder' }] }) })
    expect(await filesHoldLifeos(rig.ctx, PURDUE, window, [files])).toBe(true)
    expect(await filesHoldLifeos(rig.ctx, COSMIC, window, [files])).toBe(false)
    // the real registry has no Files that answers names, so the source's own check is made against the stand-in's answers kept above
    const hits = await doc.search(ask('budget'), rig.ctx)
    expect(hits.map((h) => h.workspaceId)).toEqual([COSMIC])
  })
  it('stay everywhere while Files does not answer names', async () => {
    const rig = makeRig()
    lifeos(rig)
    expect(await filesHoldLifeos(rig.ctx, PURDUE, window, [standIn('files', { 'work.files.places': () => ({ places: [{ kind: 'lifeos' }] }) })])).toBe(false)
    expect((await doc.search(ask('budget'), rig.ctx)).map((h) => h.workspaceId)).toEqual([PURDUE, COSMIC])
  })
})

describe('messages', () => {
  const rows = (workspaceId: unknown) =>
    workspaceId === PURDUE
      ? [{ chatId: 'c1', messageId: 'm1', chat: '#esports-staff', who: 'Dana Kim', text: 'the pizza budget is approved', at: 50, source: 'slack' }]
      : workspaceId === COSMIC
        ? [{ chatId: 'c2', messageId: 'm2', chat: 'Sam Ortiz', who: 'Sam Ortiz', text: 'pizza friday?', at: 90, source: 'discord' }]
        : []
  it("are Messages' own search, a job in reach at a time, newest first, opened in the conversation at the message", async () => {
    const rig = makeRig()
    const module = standIn('messages', { 'work.messages.search': (p) => ({ hits: rows(p.workspaceId) }) })
    const source = messageSource([module])
    const hits = await source.search(ask('pizza'), rig.ctx)
    expect([source.kind, source.tier]).toEqual(['message', 'network'])
    expect(hits).toEqual([
      { key: 'message:m2', kind: 'message', title: 'Sam Ortiz', detail: 'Sam Ortiz', snippet: 'pizza friday?', at: 90, workspaceId: COSMIC, open: { to: 'view', view: 'messages', with: { chat: 'c2', message: 'm2' } } },
      { key: 'message:m1', kind: 'message', title: '#esports-staff', detail: 'Dana Kim', snippet: 'the pizza budget is approved', at: 50, workspaceId: PURDUE, open: { to: 'view', view: 'messages', with: { chat: 'c1', message: 'm1' } } }
    ])
    expect(module.seen[0]).toEqual({ method: 'work.messages.search', params: { workspaceId: PURDUE, query: 'pizza', limit: 5 }, by: window })
  })
  it('stay inside the reach, and are absent with no line until Messages answers', async () => {
    const rig = makeRig()
    const module = standIn('messages', { 'work.messages.search': (p) => ({ hits: rows(p.workspaceId) }) })
    expect((await messageSource([module]).search(ask('pizza', onlyPurdue), rig.ctx)).map((h) => h.key)).toEqual(['message:m1'])
    expect(await runSearch(rig.ctx, { modules: [], own: [messageSource([])], reach: everywhere, text: 'pizza', by: window })).toEqual({ groups: [], pending: [], quiet: [] })
  })
  it("stands down once the Messages module lists its own search line", async () => {
    const rig = makeRig()
    const own = { kind: 'message', label: 'Messages', tier: 'network' as const, search: async () => [{ key: 'message:theirs', kind: 'message', title: 'Theirs', workspaceId: PURDUE, open: { to: 'view' as const, view: 'messages' } }] }
    const module = { ...standIn('messages', { 'work.messages.search': (p) => ({ hits: rows(p.workspaceId) }) }), search: [own] }
    const answer = await runSearch(rig.ctx, { modules: [module], own: [messageSource([module])], reach: everywhere, text: 'pizza', by: window })
    expect(answer.groups.map((g) => [g.source, g.hits.map((h) => h.key)])).toEqual([['messages.message', ['message:theirs']]])
  })
})
