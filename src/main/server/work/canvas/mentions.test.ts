import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { mentionExcerpt, mentionMatches, MENTION_PER_KIND, type MentionReach } from '@shared/work'
import type { MentionSource, WorkCtx, WorkModule } from '../modules'
import { lifeosMentions } from '../lifeos/mentions'
import { outboxMentions } from '../outbox/mentions'
import { ensureOutboxTables, HeldStore } from '../outbox/store'
import { routineMentions } from '../routines/mentions'
import { ensureRoutineTables, RoutineStore } from '../routines/store'
import { canvasMentions, searchMentions } from './mentions'
import { CanvasStore, ensureCanvasTables, setCanvasStore } from './store'

/**
 * The composer's `@` on the host: each kind finds only what the thread's
 * reach may read, a code thread is asked only LifeOS's kinds, and one kind
 * that fails leaves the rest. Every LifeOS answer here is a fake's.
 */

const purdue: MentionReach = { work: true, workspaceId: 'ws-purdue', sectors: ['purdue'], sessionId: 't1' }
const chat: MentionReach = { work: true, workspaceId: null, sectors: 'all', sessionId: 'c1' }
const code: MentionReach = { work: false, workspaceId: 'repo', sectors: ['cosmic'], sessionId: 'k1' }

/** A LifeOS that answers every list with rows of three sectors, and records what it was asked. */
function fakeLifeos(rows: Record<string, unknown>, connected = true) {
  const asked: { fn: string; args: Record<string, unknown> }[] = []
  return {
    asked,
    lifeos: {
      connected: () => connected,
      owner: () => ({
        query: async (fn: string, args: Record<string, unknown> = {}) => {
          asked.push({ fn, args })
          return rows[fn]
        }
      })
    }
  }
}

const ctxWith = (over: object): WorkCtx => ({ log: () => {}, ...over }) as unknown as WorkCtx
const source = (kind: MentionSource['kind'], search: MentionSource['search'], lifeos = false): MentionSource => ({ kind, lifeos, search })
const module = (mentions: MentionSource[]): WorkModule => ({ id: 'canvas', ensure() {}, mentions })

describe('the words typed', () => {
  it('match when every word is in a field, case and accents aside', () => {
    expect(mentionMatches('ball apr', 'Book the Ballroom', 'for April 10')).toBe(true)
    expect(mentionMatches('cafe', 'Café booking')).toBe(true)
    expect(mentionMatches('ball may', 'Book the Ballroom', 'for April 10')).toBe(false)
    expect(mentionMatches('  ', 'anything')).toBe(true)
  })

  it('cut an excerpt to one short line', () => {
    expect(mentionExcerpt('  a\n\nb  ')).toBe('a b')
    expect(mentionExcerpt('')).toBeUndefined()
    expect(mentionExcerpt('x'.repeat(400))?.length).toBe(280)
  })
})

describe('the router', () => {
  it('asks a code thread only the LifeOS kinds, and orders the answer by kind', async () => {
    const held = vi.fn(async () => [{ chip: { kind: 'held' as const, label: 'h', ref: { at: 'work' as const, pillar: 'outbox' as const, id: 'h1' } } }])
    const task = vi.fn(async () => [{ chip: { kind: 'task' as const, label: 't', ref: { at: 'lifeos' as const, table: 'tasks' as const, id: 'k' } } }])
    const modules = [module([source('held', held)]), module([source('task', task, true)])]
    const ctx = ctxWith(fakeLifeos({}))
    expect((await searchMentions(ctx, code, 'x', { modules })).hits.map((h) => h.chip.kind)).toEqual(['task'])
    expect(held).not.toHaveBeenCalled()
    expect((await searchMentions(ctx, purdue, 'x', { modules })).hits.map((h) => h.chip.kind)).toEqual(['task', 'held'])
  })

  it('names a kind that failed or was slow, keeps the rest, and holds each kind to a few rows', async () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ chip: { kind: 'item' as const, label: `i${i}`, ref: { at: 'item' as const, id: `i${i}` } } }))
    const modules = [
      module([source('item', async () => many), source('routine', async () => Promise.reject(new Error('boom'))), source('held', () => new Promise(() => {}))])
    ]
    const answer = await searchMentions(ctxWith({}), purdue, '', { modules, waitMs: 20 })
    expect(answer.hits).toHaveLength(MENTION_PER_KIND)
    expect(answer.failed.sort()).toEqual(['held', 'routine'])
  })

  it('names the LifeOS kinds failed while LifeOS is not connected, and never asks it', async () => {
    const search = vi.fn(async () => [])
    const answer = await searchMentions(ctxWith(fakeLifeos({}, false)), purdue, 'x', { modules: [module([source('task', search, true)])] })
    expect(answer).toEqual({ hits: [], failed: ['task'] })
    expect(search).not.toHaveBeenCalled()
  })

  it('asks only the kinds named', async () => {
    const answer = await searchMentions(ctxWith({}), purdue, '', { modules: [module(canvasMentions), module(outboxMentions)], kinds: ['task'] })
    expect(answer).toEqual({ hits: [], failed: [] })
  })
})

describe('LifeOS things', () => {
  const rows = {
    'tasks:search': [
      { _id: 'k1', sector: 'purdue', title: 'Book the ballroom', description: 'For April 10, 200 seats' },
      { _id: 'k2', sector: 'cosmic', title: 'Book the ballroom too' }
    ],
    'mail:search': [
      { _id: 'm1', sector: 'cosmic', subject: 'Ballroom', senders: ['Dana'] },
      { _id: 'm2', sector: 'purdue', subject: 'Re: Ballroom', snippet: 'We can hold it', senders: ['Sam'], lastMessageAt: 5 }
    ],
    'events:range': [{ _id: 'e1', sector: 'purdue', title: 'Ballroom walk-through', startsAt: Date.now() + 86_400_000, location: 'Union' }],
    'projects:list': [
      { _id: 'p1', sector: 'purdue', name: 'Spring ballroom LAN' },
      { _id: 'p2', sector: 'life', name: 'Ballroom dancing' }
    ],
    'people:list': [
      { _id: 'u1', name: 'Ballroom Bob', sectors: ['purdue', 'ref'] },
      { _id: 'u2', name: 'Ballroom Bea', sectors: ['life'] }
    ],
    'docs:list': { page: [{ _id: 'd1', sector: 'purdue', title: 'Ballroom run of show' }] }
  }
  const search = (ctx: WorkCtx, reach: MentionReach) => searchMentions(ctx, reach, 'ballroom', { modules: [module(lifeosMentions)] })

  it('keeps only rows of the sectors in reach, whatever LifeOS answered', async () => {
    const { lifeos } = fakeLifeos(rows)
    const { hits } = await search(ctxWith({ lifeos }), purdue)
    expect(hits.map((h) => h.chip.label)).toEqual(['Book the ballroom', 'Re: Ballroom', 'Ballroom walk-through', 'Spring ballroom LAN', 'Ballroom Bob', 'Ballroom run of show'])
    expect(hits[0].chip).toEqual({ kind: 'task', label: 'Book the ballroom', ref: { at: 'lifeos', table: 'tasks', id: 'k1' }, excerpt: 'For April 10, 200 seats' })
    expect(hits[1]).toMatchObject({ detail: 'Sam', at: 5, chip: { excerpt: 'We can hold it' } })
    expect(hits[5].chip.ref).toEqual({ at: 'lifeos', table: 'docs', id: 'd1' })
  })

  it('asks LifeOS for the one sector, and a Work Chat for all of them', async () => {
    const one = fakeLifeos(rows)
    await search(ctxWith({ lifeos: one.lifeos }), purdue)
    expect(one.asked.find((a) => a.fn === 'tasks:search')?.args).toEqual({ text: 'ballroom', sector: 'purdue' })
    const all = fakeLifeos(rows)
    const { hits } = await search(ctxWith({ lifeos: all.lifeos }), chat)
    expect(all.asked.find((a) => a.fn === 'tasks:search')?.args).toEqual({ text: 'ballroom' })
    expect(hits.filter((h) => h.chip.kind === 'person').map((h) => h.chip.label)).toEqual(['Ballroom Bob', 'Ballroom Bea'])
  })

  it('reads nothing for a workspace with no sector', async () => {
    const none = fakeLifeos(rows)
    const { hits } = await search(ctxWith({ lifeos: none.lifeos }), { ...purdue, sectors: [] })
    expect(hits).toEqual([])
    expect(none.asked).toEqual([])
  })
})

describe("Work's own things", () => {
  it('offers the held acts that wait in the workspace, and a Work Chat those outside every workspace', async () => {
    const db = new DatabaseSync(':memory:')
    ensureOutboxTables(db)
    const store = new HeldStore(db)
    const act = { sessionId: 't1', sector: 'purdue', kind: 'addon.call' as const, origin: 'addon:a/post', why: 'rule' as const, verb: 'Send', payload: {} }
    store.insert({ ...act, workspaceId: 'ws-purdue', summary: 'Reply to Dana' })
    store.insert({ ...act, workspaceId: 'ws-cosmic', summary: 'Reply to Dana elsewhere' })
    store.insert({ ...act, workspaceId: null, summary: 'Reply from a chat' })
    const ctx = ctxWith({ db })
    const [held] = outboxMentions
    expect((await held.search('reply', purdue, ctx)).map((h) => h.chip.label)).toEqual(['Reply to Dana'])
    expect((await held.search('reply', chat, ctx)).map((h) => h.chip.label)).toEqual(['Reply from a chat'])
    expect((await held.search('', purdue, ctx))[0].chip.ref).toMatchObject({ at: 'work', pillar: 'outbox' })
  })

  it("offers the workspace's routines, never a proposal, and none to a Work Chat", async () => {
    const db = new DatabaseSync(':memory:')
    ensureRoutineTables(db)
    const store = new RoutineStore(db)
    const base = { kind: 'scheduled' as never, prompt: 'Sum up the inbox', trigger: { on: 'schedule' as const, rrule: 'FREQ=DAILY', tz: 'UTC' }, ends: { kind: 'never' as const }, nextAt: 9, createdBy: 'owner' as const }
    store.create({ ...base, workspaceId: 'ws-purdue', name: 'Morning sweep' }, 1)
    store.create({ ...base, workspaceId: 'ws-purdue', name: 'Proposed sweep', proposed: true }, 2)
    store.create({ ...base, workspaceId: 'ws-cosmic', name: 'Other sweep' }, 3)
    const ctx = ctxWith({ db })
    const [routine] = routineMentions
    expect((await routine.search('sweep', purdue, ctx)).map((h) => h.chip.label)).toEqual(['Morning sweep'])
    expect(await routine.search('sweep', chat, ctx)).toEqual([])
  })

  it("offers the workspace's items, not a history view or a LifeOS document twice; a Work Chat its own pane's", async () => {
    const db = new DatabaseSync(':memory:')
    ensureCanvasTables(db)
    const sessions: Record<string, { id: string; workspaceId: string | null; scope: 'work'; parentId: null }> = {
      t1: { id: 't1', workspaceId: 'ws-purdue', scope: 'work', parentId: null },
      t2: { id: 't2', workspaceId: 'ws-cosmic', scope: 'work', parentId: null },
      c1: { id: 'c1', workspaceId: null, scope: 'work', parentId: null }
    }
    const store = new CanvasStore({ db, dataDir: mkdtempSync(join(tmpdir(), 'tc-mentions-')), session: (id) => sessions[id] ?? null, push: () => {}, log: () => {} } as never)
    setCanvasStore(db, store)
    const file = (path: string) => ({ at: 'file' as const, host: 'h', path })
    store.open('t1', { kind: 'sheet', source: file('/w/budget.xlsx'), title: 'Budget' })
    store.open('t1', { kind: 'history', source: file('/w/budget.xlsx'), title: 'Budget history' })
    store.open('t1', { kind: 'document', source: { at: 'lifeos', table: 'docs', id: 'd1' }, title: 'Budget notes' })
    store.open('t2', { kind: 'sheet', source: file('/w/other.xlsx'), title: 'Budget elsewhere' })
    store.open('c1', { kind: 'pdf', source: file('/w/contract.pdf'), title: 'Budget contract' })
    const ctx = ctxWith({ db, canvas: { forSession: (id: string) => store.list(id), paneOf: (id: string) => id } as unknown as WorkCtx['canvas'] })
    const [items] = canvasMentions
    const hits = await items.search('budget', purdue, ctx)
    expect(hits.map((h) => [h.chip.label, h.detail])).toEqual([['Budget', 'Sheet']])
    expect(hits[0].chip.ref).toMatchObject({ at: 'item' })
    expect((await items.search('budget', chat, ctx)).map((h) => h.chip.label)).toEqual(['Budget contract'])
  })
})
