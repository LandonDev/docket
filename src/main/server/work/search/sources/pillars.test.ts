import { describe, expect, it } from 'vitest'
import type { ClientRequest } from '@shared/contract'
import { handled, NOT_HANDLED, NotBuilt } from '@shared/work'
import type { SearchReach } from '@shared/work/search'
import type { Caller, WorkModule } from '../../modules'
import { askPillar } from '../ask'
import { runSearch } from '../run'
import { COSMIC, everywhere, makeRig, onlyPurdue, phone, PURDUE, thread, window } from '../testkit'
import { asleepWords, fileSources, filesHoldLifeos } from './files'
import { doc, docAsFile } from './lifeos'

/**
 * What is another pillar's to find, asked through that pillar's own wire
 * method with the caller the search was given: Files, against a stand-in
 * module. A method that is not built is absent, with no line. (Messages and
 * Money list their own sources: sources/others.test.ts.)
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
      {
        key: 'file:k1',
        kind: 'file',
        title: 'Budget FY27.xlsx',
        detail: 'Esports › Finance',
        at: 7,
        workspaceId: PURDUE,
        open: { to: 'file', ref: { at: 'file', host: 'env_box', path: '/work/Budget FY27.xlsx' }, name: 'Budget FY27.xlsx' },
        // the chip Files gives the same row: a thread can be started about a file he found
        chip: { kind: 'file', label: 'Budget FY27.xlsx', ref: { at: 'file', host: 'env_box', path: '/work/Budget FY27.xlsx' }, where: { place: 'teams:esports', name: 'Esports', path: 'Finance/Budget FY27.xlsx' } },
        cloud: true
      },
      {
        key: 'file:k3',
        kind: 'file',
        title: 'Server budget.xlsx',
        at: 7,
        workspaceId: COSMIC,
        open: { to: 'file', ref: { at: 'file', host: 'env_box', path: '/work/Server budget.xlsx' }, name: 'Server budget.xlsx' },
        chip: { kind: 'file', label: 'Server budget.xlsx', ref: { at: 'file', host: 'env_box', path: '/work/Server budget.xlsx' } }
      }
    ])
    expect(module.seen.map((s) => [s.method, s.params])).toEqual([
      ['work.files.names', { workspaceId: PURDUE, text: 'budget' }],
      ['work.files.names', { workspaceId: COSMIC, text: 'budget' }],
      ['work.files.names', { workspaceId: 'ws-bare', text: 'budget' }]
    ])
  })
  it("says the places Files left asleep, in Files' own words, with or without rows", async () => {
    const rig = makeRig()
    const said: { cause: string; line: string }[] = []
    const asleep = standIn('files', { 'work.files.search': (p) => (p.workspaceId === PURDUE ? { entries: [], asleep: ['The Windows VM'] } : p.workspaceId === COSMIC ? { entries: [entry('k9', 'Policy.docx')], asleep: ['The Windows VM', 'Studio Mac'] } : { entries: [] }) })
    const [, all] = fileSources([asleep])
    const hits = await all.search({ ...ask('policy'), note: (q) => void said.push(q) }, rig.ctx)
    expect(hits.map((h) => h.key)).toEqual(['file:k9'])
    expect(said).toEqual([{ cause: 'files:asleep', line: 'The Windows VM and Studio Mac are asleep. Their files were not searched.' }])
    expect(asleepWords(['The Windows VM'])).toBe('The Windows VM is asleep. Its files were not searched.')
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
  it("says where a file lies, and never the job's own folder by its name: the row's end already says the job", async () => {
    const rig = makeRig()
    const module = standIn('files', {
      'work.files.names': () => ({
        entries: [
          entry('top', 'Budget.csv', { where: { place: 'folder', name: 'Purdue', trail: [] } }),
          entry('deep', 'Budget old.csv', { where: { place: 'folder', name: 'Purdue', trail: ['Finance', '2025'] } }),
          entry('lib', 'Budget shared.xlsx', { where: { place: 'teams:esports', name: 'Esports', trail: ['Finance'] } })
        ]
      })
    })
    const hits = await fileSources([module])[0].search(ask('budget', onlyPurdue), rig.ctx)
    expect(hits.map((h) => [h.title, h.detail])).toEqual([
      ['Budget.csv', undefined],
      ['Budget old.csv', 'Finance › 2025'],
      ['Budget shared.xlsx', 'Esports › Finance']
    ])
  })
  it('is absent, with no line, until Files answers', async () => {
    const rig = makeRig()
    const answer = await runSearch(rig.ctx, { modules: [], own: fileSources([standIn('files', {})]), reach: everywhere, text: 'budget', by: window })
    expect(answer).toMatchObject({ groups: [], pending: [], quiet: [] })
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
  it('are files there: under Files by the key Files gives a document, so one that both find is listed once', async () => {
    const rig = makeRig()
    lifeos(rig)
    const ref = { at: 'lifeos', table: 'docs', id: 'd-purdue' }
    const files = standIn('files', {
      'work.files.names': (p) => ({ entries: p.workspaceId === PURDUE ? [{ key: 'lifeos:docs:d-purdue', ref, name: 'Budget notes' }] : [] }),
      'work.files.places': (p) => ({ places: p.workspaceId === PURDUE ? [{ kind: 'lifeos' }] : [{ kind: 'folder' }] })
    })
    await filesHoldLifeos(rig.ctx, PURDUE, window, [files])
    await filesHoldLifeos(rig.ctx, COSMIC, window, [files])
    const found = await docAsFile.search(ask('budget'), rig.ctx)
    expect(found.map((h) => [h.key, h.kind, h.workspaceId])).toEqual([['file:lifeos:docs:d-purdue', 'file', PURDUE]])
    expect(found[0].open).toEqual({ to: 'file', ref, name: 'Budget notes' })
    // Files' own list as he types names the same document by the same key
    const named = await fileSources([files])[0].search(ask('budget'), rig.ctx)
    expect(named.map((h) => h.key)).toEqual([found[0].key])
    // and the job where Files holds no LifeOS keeps its Documents
    expect((await doc.search(ask('budget'), rig.ctx)).map((h) => [h.key, h.workspaceId])).toEqual([['lifeos:docs:d-cosmic', COSMIC]])
  })
  it('stay everywhere while Files does not answer names', async () => {
    const rig = makeRig()
    lifeos(rig)
    expect(await filesHoldLifeos(rig.ctx, PURDUE, window, [standIn('files', { 'work.files.places': () => ({ places: [{ kind: 'lifeos' }] }) })])).toBe(false)
    expect((await doc.search(ask('budget'), rig.ctx)).map((h) => h.workspaceId)).toEqual([PURDUE, COSMIC])
    expect(await docAsFile.search(ask('budget'), rig.ctx)).toEqual([])
  })
})
