import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ClientRequestSchema } from '@shared/contract'
import type { FileAct, FilesHome, FilesListing } from '@shared/contract-work-files'
import type { MentionReach } from '@shared/work'
import type { FileEntry } from '@shared/work/files'
import { searchMentions } from '../canvas/mentions'
import type { Caller } from '../modules'
import { ensureOutboxTables, HELD_TABLE } from '../outbox/store'
import { ensureSuggestionTables, SuggestionStore } from '../sheets/suggestions'
import { sheetWaiting } from '../sheets/waiting'
import { closeFilesState } from './handle'
import { registerFileWaiting } from './hooks'
import { files } from './index'
import { fileMentions } from './mention'
import { at, HOST, makeRig, peer, phone, window, WS, type Rig } from './testkit'
import { COUNTED_MOST, withWaiting } from './waiting'

/**
 * What waits on him in a file (waiting.ts, mention.ts): the amber count a row shows for an agent's suggestions, Home's
 * Waiting on you with the held file acts, and the composer's `@` for a file, each by caller.
 */

let rig: Rig
let off: () => void
beforeEach(() => {
  rig = makeRig()
  ensureSuggestionTables(rig.db)
  ensureOutboxTables(rig.db)
  off = registerFileWaiting(sheetWaiting)
})
afterEach(() => {
  off()
  closeFilesState(rig.db)
  rig.close()
})

async function call<T>(method: string, params: Record<string, unknown>, by: Caller = window): Promise<T> {
  const req = ClientRequestSchema.parse({ id: '1', method, params: { workspaceId: WS, ...params } })
  const out = await files.handle!(req, rig.ctx, by)
  if (!out.handled) throw new Error(`${method} was not handled`)
  return out.result as T
}
const settle = (): Promise<void> => new Promise((done) => setImmediate(() => setImmediate(done)))
const cell = (row: number) => ({ sheet: 'Sheet1', row, col: 0, base: null, proposed: { v: row } })
const suggest = (path: string, cells: number): void => void new SuggestionStore(rig.db).add(`file:${path}`, `cs-${path}`, 'agent:t1' as never, undefined, Array.from({ length: cells }, (_, i) => cell(i)))
const stateOf = (entries: FileEntry[], name: string): FileEntry['state'] => entries.find((e) => e.name === name)?.state

let held = 0
function hold(o: { path: string; name: string; verb?: FileAct['verb']; workspaceId?: string; state?: string }): string {
  const id = `h${++held}`
  const act: FileAct = {
    workspaceId: o.workspaceId ?? WS,
    host: HOST,
    verb: o.verb ?? 'move',
    op: `act:${id}-000000`,
    request: o.verb === 'make' ? { refs: [at(o.path)], kind: 'sheet', name: o.name } : { refs: [at(o.path)], to: at(join(rig.team, 'Events')) },
    digest: 'd'.repeat(32),
    things: [{ key: `lib:x:${o.name}`, name: o.name, version: '1:1:' }],
    from: { place: 'lib', name: 'General', trail: [] },
    audience: 'Everyone in Esports Staff can open it.'
  }
  rig.db
    .prepare(`INSERT INTO ${HELD_TABLE} (id, workspace_id, session_id, kind, origin, summary, payload, state, run_key, created_at, updated_at) VALUES (?, ?, 't1', 'file.act', 'agent', ?, ?, ?, ?, ?, ?)`)
    .run(id, act.workspaceId, `Move ${o.name}`, JSON.stringify(act), o.state ?? 'held', `run-${id}`, held, held)
  return id
}

describe('the amber count', () => {
  it('a workbook with suggestions waiting says how many in its row; the rest say nothing', async () => {
    suggest(join(rig.folder, 'Budget.xlsx'), 3)
    const got = await call<FilesListing>('work.files.list', { at: { at: 'place', id: 'folder' } })
    expect(stateOf(got.entries, 'Budget.xlsx')).toEqual({ is: 'suggestions', count: 3 })
    expect(got.entries.filter((e) => e.state).map((e) => e.name)).toEqual(['Budget.xlsx'])
  })

  it('counts open suggestions only: accepted and rejected are done', async () => {
    const path = join(rig.folder, 'Budget.xlsx')
    suggest(path, 2)
    const store = new SuggestionStore(rig.db)
    store.mark(`file:${path}`, [store.open(`file:${path}`)[0]!.id], 'accepted')
    const got = await call<FilesListing>('work.files.list', { at: { at: 'place', id: 'folder' } })
    expect(stateOf(got.entries, 'Budget.xlsx')).toEqual({ is: 'suggestions', count: 1 })
  })

  it('reads no file and asks about the first hundred rows of a page only, in one question', () => {
    const asked: number[] = []
    const offCount = registerFileWaiting({ count: (sources) => (asked.push(sources.length), sources.map(() => 1)), files: () => [] })
    try {
      const rows: FileEntry[] = Array.from({ length: 150 }, (_, i) => ({ key: `k${i}`, ref: at(join(rig.folder, `missing ${i}.xlsx`)), folder: null, name: `missing ${i}.xlsx`, kind: 'sheet' }))
      const out = withWaiting(rig.ctx, rows)
      // The files do not exist: nothing was read for the count.
      expect(asked).toEqual([COUNTED_MOST])
      expect(out.slice(0, COUNTED_MOST).every((e) => e.state?.is === 'suggestions')).toBe(true)
      expect(out.slice(COUNTED_MOST).some((e) => e.state)).toBe(false)
    } finally {
      offCount()
    }
  })

  it('leaves a row of another host, a folder, and a row with a state of its own as they are', () => {
    const rows: FileEntry[] = [
      { key: 'a', ref: at('/elsewhere/a.xlsx', 'env_mac'), folder: null, name: 'a.xlsx', kind: 'sheet' },
      { key: 'b', ref: null, folder: at(rig.folder), name: 'Events', kind: 'folder' },
      { key: 'c', ref: at(join(rig.folder, 'c.xlsx')), folder: null, name: 'c.xlsx', kind: 'sheet', state: { is: 'cloud' } }
    ]
    const offCount = registerFileWaiting({ count: (sources) => sources.map(() => 5), files: () => [] })
    try {
      expect(withWaiting(rig.ctx, rows)).toEqual(rows)
    } finally {
      offCount()
    }
  })
})

describe("Home's Waiting on you", () => {
  it("lists the workspace's held file acts first, each as the file it names with the item to open, then the files with suggestions", async () => {
    suggest(join(rig.folder, 'Budget.xlsx'), 2)
    suggest(join(rig.otherFolder, 'Payroll.xlsx'), 4)
    const move = hold({ path: join(rig.team, 'General', 'Spring budget.xlsx'), name: 'Spring budget.xlsx' })
    const make = hold({ path: join(rig.team, 'General'), name: 'Roster', verb: 'make' })
    hold({ path: join(rig.team, 'General', 'Plan.docx'), name: 'Plan.docx', state: 'done' })
    hold({ path: join(rig.otherFolder, 'Payroll.xlsx'), name: 'Payroll.xlsx', workspaceId: 'w2' })
    const home = await call<FilesHome>('work.files.home', {})
    expect(home.waiting.map((e) => [e.name, e.held ?? e.state])).toEqual([
      ['Roster', { id: make, verb: 'make' }],
      ['Spring budget.xlsx', { id: move, verb: 'move' }],
      ['Budget.xlsx', { is: 'suggestions', count: 2 }]
    ])
    const spring = home.waiting.find((e) => e.name === 'Spring budget.xlsx')!
    // Stated where it is now, with the place it lies in; nothing read from inside it.
    expect(spring).toMatchObject({ shared: true, kind: 'sheet', ref: at(join(rig.team, 'General', 'Spring budget.xlsx')), where: { name: 'General' } })
    expect(spring.by).toBeUndefined()
    expect(home.waiting.find((e) => e.name === 'Roster')).toMatchObject({ ref: null, folder: null, kind: 'sheet', shared: true })
  })

  it('a key hears only of files it could name itself', async () => {
    suggest(join(rig.folder, 'Budget.xlsx'), 2)
    hold({ path: join(rig.team, 'General', 'Spring budget.xlsx'), name: 'Spring budget.xlsx' })
    const home = await call<FilesHome>('work.files.home', {}, phone)
    expect(home.waiting.map((e) => e.name)).toEqual(['Budget.xlsx'])
  })

  it('counts the files Starred and Recent show too', async () => {
    suggest(join(rig.folder, 'Budget.xlsx'), 1)
    await call('work.files.star', { ref: at(join(rig.folder, 'Budget.xlsx')), name: 'Budget.xlsx', on: true })
    const home = await call<FilesHome>('work.files.home', {})
    expect(stateOf(home.starred, 'Budget.xlsx')).toEqual({ is: 'suggestions', count: 1 })
  })
})

describe('`@` a file', () => {
  const reach: MentionReach = { work: true, workspaceId: WS, sectors: ['purdue'], sessionId: 't1' }
  const search = fileMentions[0]!
  const feed = async (): Promise<void> => {
    await call<FilesListing>('work.files.list', { at: { at: 'place', id: 'folder' } })
    await call<FilesListing>('work.files.list', { at: at(join(rig.team, 'General')) })
    await settle()
  }

  it('answers names across the workspace places as file chips, his recents first, with the place and path in words', async () => {
    await feed()
    await call('work.files.seen', { ref: at(join(rig.team, 'General', 'Spring budget.xlsx')), name: 'Spring budget.xlsx' })
    const hits = await search.search('budget', reach, rig.ctx, window)
    expect(hits.map((h) => h.chip.label)).toEqual(['Spring budget.xlsx', 'Budget.xlsx'])
    expect(hits[0]!.chip).toMatchObject({ kind: 'file', ref: at(join(rig.team, 'General', 'Spring budget.xlsx')), where: { name: 'General', path: 'Spring budget.xlsx', shared: true } })
    expect(hits[1]!.chip).toMatchObject({ kind: 'file', where: { place: 'folder', name: 'Dummy Esports', path: 'Budget.xlsx' } })
    expect(hits[1]!.chip.where!.shared).toBeUndefined()
    // No words from inside a file, shared or not.
    expect(hits.every((h) => h.chip.excerpt === undefined && h.chip.quote === undefined)).toBe(true)
    expect(hits[0]!.detail).toBe('General')
  })

  it('answers five at most, and never a folder', async () => {
    for (let i = 0; i < 8; i++) writeFileSync(join(rig.folder, `Budget ${i}.xlsx`), 'x')
    await feed()
    const hits = await search.search('budget', reach, rig.ctx, window)
    expect(hits).toHaveLength(5)
    expect((await search.search('events', reach, rig.ctx, window)).length).toBe(0)
  })

  it('tells a key only of files it could name, and tells no one the router did not name, nor another host', async () => {
    await feed()
    expect((await search.search('budget', reach, rig.ctx, phone)).map((h) => h.chip.label)).toEqual(['Budget.xlsx'])
    expect(await search.search('budget', reach, rig.ctx)).toEqual([])
    expect(await search.search('budget', reach, rig.ctx, peer)).toEqual([])
  })

  it('offers a Work Chat and a code thread nothing', async () => {
    await feed()
    expect(await search.search('budget', { ...reach, workspaceId: null, sectors: 'all' }, rig.ctx, window)).toEqual([])
    expect(await search.search('budget', { ...reach, work: false }, rig.ctx, window)).toEqual([])
  })

  it('is asked by the router with the caller, held to the thread reach', async () => {
    await feed()
    const asWindow = await searchMentions(rig.ctx, reach, 'budget', { modules: [files], by: window })
    expect(asWindow.hits.map((h) => h.chip.label)).toEqual(['Budget.xlsx', 'Spring budget.xlsx'])
    const asKey = await searchMentions(rig.ctx, reach, 'budget', { modules: [files], by: phone })
    expect(asKey.hits.map((h) => h.chip.label)).toEqual(['Budget.xlsx'])
    // A thread of the other workspace is offered that workspace's files alone.
    const other = await searchMentions(rig.ctx, { ...reach, workspaceId: 'w2', sessionId: 't2' }, 'budget', { modules: [files], by: window })
    expect(other.hits).toEqual([])
  })
})
