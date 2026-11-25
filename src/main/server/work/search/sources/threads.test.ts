import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SessionMeta } from '@shared/events'
import type { SearchReach } from '@shared/work/search'
import { openDb, Store } from '../../../db'
import { makeSearchHost, setSearchHost } from '../host'
import { COSMIC, everywhere, onlyPurdue, PURDUE, window } from '../testkit'
import { threadTitles, threadWords } from './threads'

/**
 * Work threads, on a database made for the test: titles at once, words
 * through the host's own index, both held to rows stamped `scope: 'work'`.
 * A code thread that says the same words is never answered.
 */

let root: string
let db: ReturnType<typeof openDb>
let store: Store
const metas = new Map<string, SessionMeta>()
const projects: Record<string, string> = { 'proj-lan': PURDUE }

function thread(id: string, o: { title: string; scope?: 'work'; workspaceId?: string | null; projectId?: string; parentId?: string; archived?: boolean; at?: number }): void {
  const meta = {
    id,
    parentId: o.parentId ?? null,
    projectId: o.projectId ?? null,
    workspaceId: o.projectId ? null : (o.workspaceId ?? null),
    threadType: 'chat',
    planPath: null,
    provider: 'claude',
    model: 'm',
    reasoning: 'medium',
    agentType: 'orchestrator',
    title: o.title,
    cwd: root,
    status: 'idle',
    archived: o.archived ?? false,
    pinned: false,
    permission: 'default',
    fast: false,
    ultrafast: false,
    context1m: false,
    busySince: null,
    pausedAt: null,
    frozenActiveElapsed: 0,
    threadRules: null,
    nativeId: null,
    ...(o.scope ? { scope: o.scope } : {}),
    createdAt: o.at ?? 1,
    updatedAt: o.at ?? 1
  } as unknown as SessionMeta
  metas.set(id, meta)
  store.insertSession(meta)
}
const say = (id: string, text: string): void => void store.appendEvent(id, { type: 'assistant-text', text, delta: false })
const ask = (text: string, reach: SearchReach = everywhere, limit = 4) => ({ text, reach, limit, by: window, signal: new AbortController().signal })

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tc-search-threads-'))
  db = openDb(join(root, 'test.db'))
  store = new Store(db)
  metas.clear()
  setSearchHost(makeSearchHost({ sessions: (archived) => [...metas.values()].filter((m) => m.archived === archived), session: (id) => metas.get(id) ?? null, workspaceOfProject: (id) => projects[id] ?? null, searchEvents: (o) => store.searchEvents(o) }))
  thread('t-purdue', { title: 'Budget review for the LAN', scope: 'work', workspaceId: PURDUE, at: 30 })
  thread('t-project', { title: 'Venue shortlist', scope: 'work', projectId: 'proj-lan', at: 20 })
  thread('t-cosmic', { title: 'Server budget', scope: 'work', workspaceId: COSMIC, at: 40 })
  thread('t-chat', { title: 'Budget across jobs', scope: 'work', workspaceId: null, at: 10 })
  thread('t-code', { title: 'Budget parser refactor', workspaceId: 'ws-code', at: 50 })
  thread('t-child', { title: 'Budget helper', scope: 'work', workspaceId: PURDUE, parentId: 't-purdue', at: 60 })
  thread('t-old', { title: 'Budget 2024', scope: 'work', workspaceId: PURDUE, archived: true, at: 5 })
  say('t-purdue', 'The pizza line is over by forty dollars.')
  say('t-project', 'The ballroom holds pizza for two hundred.')
  say('t-cosmic', 'No pizza here, only invoices.')
  say('t-chat', 'Pizza in every job this week.')
  say('t-code', 'pizza pizza pizza: the parser test fixture says pizza')
  say('t-child', 'Counted the pizza receipts.')
})
afterEach(async () => {
  setSearchHost(null)
  db.close()
  await rm(root, { recursive: true, force: true })
})

describe('titles', () => {
  it('are answered at once from the Work rows, newest first, with Work Chats when the reach has them, never a code thread or a subagent, and an archived thread last, marked', async () => {
    const hits = await threadTitles.search(ask('budget'), {} as never)
    expect(threadTitles.tier).toBe('instant')
    expect(hits.map((h) => [h.key, h.workspaceId])).toEqual([
      ['thread:t-cosmic', COSMIC],
      ['thread:t-purdue', PURDUE],
      ['thread:t-chat', null],
      ['thread:t-old', PURDUE]
    ])
    expect(hits[0]).toMatchObject({ kind: 'thread', title: 'Server budget', open: { to: 'thread', sessionId: 't-cosmic' } })
    expect(hits[0]!.detail).toBeUndefined()
    expect(hits[3]).toMatchObject({ title: 'Budget 2024', detail: 'Archived', open: { to: 'thread', sessionId: 't-old', archived: true } })
  })
  it('never let archived threads crowd out live ones under the limit', async () => {
    for (let i = 0; i < 6; i++) thread(`t-arch-${i}`, { title: `Budget archive ${i}`, scope: 'work', workspaceId: PURDUE, archived: true, at: 100 + i })
    const hits = await threadTitles.search(ask('budget', everywhere, 3), {} as never)
    expect(hits.slice(0, 3).map((h) => h.key)).toEqual(['thread:t-cosmic', 'thread:t-purdue', 'thread:t-chat'])
  })
  it('read the archived rows only when the live titles leave room', async () => {
    const asked: boolean[] = []
    setSearchHost(makeSearchHost({ sessions: (archived) => (asked.push(archived), [...metas.values()].filter((m) => m.archived === archived)), session: (id) => metas.get(id) ?? null, workspaceOfProject: (id) => projects[id] ?? null, searchEvents: (o) => store.searchEvents(o) }))
    await threadTitles.search(ask('budget', everywhere, 2), {} as never)
    expect(asked).toEqual([false])
    await threadTitles.search(ask('budget', everywhere, 10), {} as never)
    expect(asked).toEqual([false, false, true])
  })
  it('stay inside one job, a thread in a project of the job among them', async () => {
    expect((await threadTitles.search(ask('budget', onlyPurdue), {} as never)).map((h) => h.key)).toEqual(['thread:t-purdue', 'thread:t-old'])
    expect((await threadTitles.search(ask('venue', onlyPurdue), {} as never)).map((h) => [h.key, h.workspaceId])).toEqual([['thread:t-project', PURDUE]])
    expect(await threadTitles.search(ask('venue', { workspaces: [everywhere.workspaces[1]], chats: false, sessionId: null }), {} as never)).toEqual([])
  })
})

describe('the words said in a thread', () => {
  it("are found through the host's index with the line they are in, one row a thread, and a code thread with the same words is never answered", async () => {
    const hits = await threadWords.search(ask('pizza', everywhere, 10), {} as never)
    expect(threadWords.tier).toBe('network')
    expect(hits.map((h) => h.key).sort()).toEqual(['thread:t-chat', 'thread:t-child', 'thread:t-cosmic', 'thread:t-project', 'thread:t-purdue'])
    const purdue = hits.find((h) => h.key === 'thread:t-purdue')!
    expect(purdue.snippet).toContain('pizza line')
    expect(purdue.open).toMatchObject({ to: 'thread', sessionId: 't-purdue' })
    expect((purdue.open as { seq?: number }).seq).toBeGreaterThan(0)
    expect(hits.find((h) => h.key === 'thread:t-project')!.workspaceId).toBe(PURDUE)
  })
  it('find an archived thread by its words, marked, and opening it puts it back', async () => {
    say('t-old', 'Last year the pizza ran out by noon.')
    const hit = (await threadWords.search(ask('noon', everywhere, 10), {} as never)).find((h) => h.key === 'thread:t-old')!
    expect(hit).toMatchObject({ detail: 'Archived', open: { to: 'thread', sessionId: 't-old', archived: true } })
    expect(hit.snippet).toContain('noon')
  })
  it('find an archived thread by its words once its log has moved to the cold file', async () => {
    say('t-old', 'Last year the pizza ran out by noon.')
    expect(store.moveToCold('t-old').done).toBe(true)
    // The hot file alone no longer holds it.
    expect((await store.searchEvents({ query: 'noon', scope: 'work' })).hits).toEqual([])
    const hit = (await threadWords.search(ask('noon', everywhere, 10), {} as never)).find((h) => h.key === 'thread:t-old')!
    expect(hit).toMatchObject({ detail: 'Archived', open: { to: 'thread', sessionId: 't-old', archived: true } })
    expect(hit.snippet).toContain('noon')
  })
  it('read the cold file only for archived threads, and only with room left by the live ones', async () => {
    const asked: { ids: readonly string[]; cold: boolean; limit: number }[] = []
    setSearchHost(
      makeSearchHost({
        sessions: (archived) => [...metas.values()].filter((m) => m.archived === archived),
        session: (id) => metas.get(id) ?? null,
        workspaceOfProject: (id) => projects[id] ?? null,
        searchEvents: (o) => (asked.push({ ids: o.sessionIds, cold: !!o.archived, limit: o.limit }), store.searchEvents(o))
      })
    )
    await threadWords.search(ask('pizza', onlyPurdue, 10), {} as never)
    expect(asked.map((a) => [a.ids.includes('t-old'), a.cold])).toEqual([
      [false, false],
      [true, true]
    ])
    expect(asked[1]!.ids).toEqual(['t-old'])
  })
  it('list live threads before archived ones before the limit, whatever the index ranked first', async () => {
    for (let i = 0; i < 4; i++) {
      thread(`t-gone-${i}`, { title: `Gone ${i}`, scope: 'work', workspaceId: PURDUE, archived: true, at: 200 + i })
      for (let j = 0; j < 5; j++) say(`t-gone-${i}`, `pizza pizza pizza ${j}`)
    }
    const hits = await threadWords.search(ask('pizza', everywhere, 3), {} as never)
    expect(hits).toHaveLength(4)
    expect(hits.every((h) => !(h.open as { archived?: boolean }).archived)).toBe(true)
  })
  it('stay inside one job, with no Work Chat', async () => {
    const hits = await threadWords.search(ask('pizza', onlyPurdue, 10), {} as never)
    expect(hits.map((h) => h.key).sort()).toEqual(['thread:t-child', 'thread:t-project', 'thread:t-purdue'])
  })
  it("are still found in one job when another job's thread holds more matching rows than the store's whole cap: the index is asked for one row a thread", async () => {
    // The index ranks rows and knows no job: 260 rows of one Cosmic thread outrank Purdue's one line each, and the store answers 200 at most.
    for (let i = 0; i < 260; i++) say('t-cosmic', `pizza pizza pizza ${i}`)
    expect((await store.searchEvents({ query: 'pizza', scope: 'work' })).hits.every((h) => h.sessionId === 't-cosmic')).toBe(true)
    const perThread = await store.searchEvents({ query: 'pizza', scope: 'work', perThread: true })
    expect(perThread.hits.map((h) => h.sessionId).sort()).toEqual(['t-chat', 't-child', 't-cosmic', 't-project', 't-purdue'])
    const hits = await threadWords.search(ask('pizza', onlyPurdue, 10), {} as never)
    expect(hits.map((h) => h.key).sort()).toEqual(['thread:t-child', 'thread:t-project', 'thread:t-purdue'])
  })
  it("are still found in one job when another job holds more matching threads than the store's cap, by their words or their notes: the reach is applied before the cap", async () => {
    for (let i = 0; i < 210; i++) {
      thread(`t-cosmic-${i}`, { title: `Cosmic ${i}`, scope: 'work', workspaceId: COSMIC, at: 100 + i })
      store.setSessionNotes(`t-cosmic-${i}`, `pizza order ${i}`, 1000 + i)
    }
    // the plain Work read is all Cosmic's: 200 notes, newest first
    const plain = await store.searchEvents({ query: 'pizza', scope: 'work', perThread: true })
    expect(plain.hits.every((h) => h.sessionId.startsWith('t-cosmic'))).toBe(true)
    const hits = await threadWords.search(ask('pizza', onlyPurdue, 10), {} as never)
    expect(hits.map((h) => h.key).sort()).toEqual(['thread:t-child', 'thread:t-project', 'thread:t-purdue'])
    // and a reach with no thread asks the store nothing
    expect(await threadWords.search(ask('pizza', { workspaces: [{ id: 'ws-none', sector: null, name: 'None' }], chats: false, sessionId: null }, 10), {} as never)).toEqual([])
  })
  it("ask the store for Work rows alone: the same search with no scope finds the code thread first", async () => {
    const all = await store.searchEvents({ query: 'pizza' })
    expect(all.hits.map((h) => h.sessionId)).toContain('t-code')
    const work = await store.searchEvents({ query: 'pizza', scope: 'work' })
    expect(work.hits.map((h) => h.sessionId)).not.toContain('t-code')
    expect(work.hits.length).toBe(5)
  })
  it('find a Work thread by what it kept in its notes, and never a code thread by its', async () => {
    store.setSessionNotes('t-purdue', 'Decision: order from Dominoes', 100)
    store.setSessionNotes('t-code', 'Decision: Dominoes fixture', 101)
    expect(store.searchNotes({ query: 'dominoes', scope: 'work' }).map((n) => n.sessionId)).toEqual(['t-purdue'])
    const [hit] = await threadWords.search(ask('dominoes'), {} as never)
    expect(hit).toMatchObject({ key: 'thread:t-purdue', open: { to: 'thread', sessionId: 't-purdue' } })
    expect((hit.open as { seq?: number }).seq).toBeUndefined()
    expect(hit.snippet).toContain('Dominoes')
  })
})

describe('with no host part', () => {
  it('answers nothing', async () => {
    setSearchHost(null)
    expect(await threadTitles.search(ask('budget'), {} as never)).toEqual([])
    expect(await threadWords.search(ask('pizza'), {} as never)).toEqual([])
  })
})
