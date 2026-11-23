import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { WorkCtx } from '../modules'
import { answer, standInOf, withStandIn, type StandInRows } from './standIn'

/** The proof's LifeOS stand-in: only an isolated instance takes it, and it answers as LifeOS narrows. */

const rows: StandInRows = {
  'mail:search': [
    { _id: 'm1', sector: 'cosmic', subject: 'Budget for servers', senders: ['Ops'] },
    { _id: 'm2', sector: 'unify', subject: 'Lunch', snippet: 'the budget is fine' },
    { _id: 'm3', sector: 'unify', subject: 'Offsite' }
  ],
  'tasks:search': [
    { _id: 't1', sector: 'cosmic', title: 'Send the budget', key: 'COS-4', status: 'todo' },
    { _id: 't2', sector: 'cosmic', title: 'Budget review', status: 'done' }
  ],
  'docs:list': [{ _id: 'd1', sector: 'unify', title: 'Budget notes' }],
  'people:list': [{ _id: 'p1', name: 'Dana Kim', sectors: ['cosmic'] }]
}
const file = (): string => {
  const path = join(mkdtempSync(join(tmpdir(), 'tc-search-standin-')), 'rows.json')
  writeFileSync(path, JSON.stringify(rows))
  return path
}

describe('the LifeOS stand-in', () => {
  it('is taken only by an isolated instance: never with no data folder of its own, never by the box itself', () => {
    const path = file()
    expect(standInOf({ TEMP_CODE_WORK_SEARCH_STANDIN: path })).toBeNull()
    expect(standInOf({ TEMP_CODE_WORK_SEARCH_STANDIN: path, TEMP_CODE_USER_DATA: '/srv/agents/temp-code-data' })).toBeNull()
    expect(standInOf({ TEMP_CODE_USER_DATA: '/tmp/proof-data' })).toBeNull()
    expect(standInOf({ TEMP_CODE_WORK_SEARCH_STANDIN: path, TEMP_CODE_USER_DATA: '/tmp/proof-data' })).toEqual(rows)
    expect(standInOf({ TEMP_CODE_WORK_SEARCH_STANDIN: '/nowhere/rows.json', TEMP_CODE_USER_DATA: '/tmp/proof-data' })).toBeNull()
  })
  it('answers as LifeOS narrows: by the words for a search, by the sector asked for, the open tasks alone for the list', () => {
    expect((answer(rows, 'mail:search', { text: 'budget' }) as { _id: string }[]).map((m) => m._id)).toEqual(['m1', 'm2'])
    expect((answer(rows, 'tasks:search', { text: 'budget', sector: 'cosmic' }) as { _id: string }[]).map((t) => t._id)).toEqual(['t1', 't2'])
    expect((answer(rows, 'tasks:list', {}) as { _id: string }[]).map((t) => t._id)).toEqual(['t1'])
    expect((answer(rows, 'tasks:byKeys', { keys: ['cos-4'] }) as { _id: string }[]).map((t) => t._id)).toEqual(['t1'])
    expect(answer(rows, 'docs:list', { sector: 'unify', paginationOpts: {} })).toEqual({ page: [rows['docs:list'][0]] })
    expect(answer(rows, 'docs:list', { sector: 'cosmic' })).toEqual({ page: [] })
    expect(answer(rows, 'events:range', {})).toEqual([])
  })
  it("stands in for this pillar's reads alone: connected, queried, subscribed once, and it changes nothing", async () => {
    const real = { lifeos: { connected: () => false, jwt: async () => 'real-jwt' } } as unknown as WorkCtx
    const ctx = withStandIn(real, rows)
    expect(ctx.lifeos.connected()).toBe(true)
    expect(await ctx.lifeos.owner().query('people:list', {})).toEqual(rows['people:list'])
    const got: unknown[] = []
    ctx.lifeos.subscribe('people:list', {}, (v) => got.push(v))()
    expect(got).toEqual([rows['people:list']])
    await expect(ctx.lifeos.owner().mutation('tasks:add', {})).rejects.toThrow('changes nothing')
    // the real context is untouched: every other pillar still reads the real LifeOS
    expect(real.lifeos.connected()).toBe(false)
    expect(await ctx.lifeos.jwt()).toBe('real-jwt')
  })
})
