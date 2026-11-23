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
  setSearchHost(makeSearchHost({ sessions: () => [...metas.values()], session: (id) => metas.get(id) ?? null, workspaceOfProject: (id) => projects[id] ?? null, searchEvents: (o) => store.searchEvents(o) }))
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
  it('are answered at once from the Work rows, newest first, with Work Chats when the reach has them, and never a code thread, a subagent or an archived thread', async () => {
    const hits = await threadTitles.search(ask('budget'), {} as never)
    expect(threadTitles.tier).toBe('instant')
    expect(hits.map((h) => [h.key, h.workspaceId])).toEqual([
      ['thread:t-cosmic', COSMIC],
      ['thread:t-purdue', PURDUE],
      ['thread:t-chat', null]
    ])
    expect(hits[0]).toMatchObject({ kind: 'thread', title: 'Server budget', open: { to: 'thread', sessionId: 't-cosmic' } })
  })
  it('stay inside one job, a thread in a project of the job among them', async () => {
    expect((await threadTitles.search(ask('budget', onlyPurdue), {} as never)).map((h) => h.key)).toEqual(['thread:t-purdue'])
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
  it('stay inside one job, with no Work Chat', async () => {
    const hits = await threadWords.search(ask('pizza', onlyPurdue, 10), {} as never)
    expect(hits.map((h) => h.key).sort()).toEqual(['thread:t-child', 'thread:t-project', 'thread:t-purdue'])
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
