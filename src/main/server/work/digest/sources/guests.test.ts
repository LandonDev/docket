import { describe, expect, it } from 'vitest'
import type { FindEntry } from '@shared/work/docFind'
import type { Tell } from '@shared/work/tell'
import { guests, guestTitle } from './guests'
import { Sources, type SourceEnv, type SourceRead } from './index'

const NOW = Date.parse('2026-11-23T08:00:00Z')
const HOUR = 3_600_000
const WORKSPACES = [
  { id: 'ws-unify', name: 'Unify', sector: 'unify' },
  { id: 'ws-ref', name: 'Ref', sector: 'ref' }
]
const entry = (id: string, title: string, editedAt: number, lastBy?: FindEntry['lastBy']): FindEntry => ({
  key: `lifeos:docs:${id}`,
  title,
  kind: 'document',
  where: 'lifeos',
  source: { at: 'lifeos', table: 'docs', id },
  editedAt,
  createdAt: editedAt - 10 * HOUR,
  shared: true,
  guest: true,
  ...(lastBy ? { lastBy } : {}),
  comments: 0,
  waiting: 0,
  held: 0
})

function envOf(found: Record<string, FindEntry[] | Error | { entries: FindEntry[]; complete: boolean; lifeos?: string }>, since = 0): SourceEnv & { calls: unknown[] } {
  const calls: unknown[] = []
  return {
    calls,
    ctx: {} as never,
    modules: [],
    async call<T>(method: string, params: unknown): Promise<T> {
      calls.push({ method, params })
      const got = found[(params as { workspaceId: string }).workspaceId]
      if (!got || got instanceof Error) throw got ?? new Error('no such Work workspace')
      return (Array.isArray(got) ? { entries: got, projects: [], hits: [], complete: true } : { projects: [], hits: [], ...got }) as T
    },
    workspaces: () => WORKSPACES,
    day: '2026-11-23',
    zone: 'America/Chicago',
    since
  }
}

const tellsOf = async (env: SourceEnv, now: number): Promise<Tell[]> => ((await guests.read(env, now)) as SourceRead).tells

describe('the guests source', () => {
  it("tells one row a document a guest last edited since the last digest, from the docs pillar's list", async () => {
    const env = envOf(
      {
        'ws-unify': [entry('d1', 'Pricing notes', NOW - 2 * HOUR, 'guest'), entry('d2', 'Roadmap', NOW - HOUR, 'owner'), entry('d3', 'Old brief', NOW - 30 * HOUR, 'guest')],
        'ws-ref': [entry('d4', 'Game schedule', NOW - 3 * HOUR, 'guest')]
      },
      NOW - 20 * HOUR
    )
    expect(await tellsOf(env, NOW)).toEqual([
      { kind: 'docs.guest', workspaceId: 'ws-unify', title: 'A guest edited Pricing notes', key: `guest-edit:lifeos:docs:d1:${NOW - 2 * HOUR}`, open: { view: 'docs', workspaceId: 'ws-unify', at: 'lifeos:docs:d1' } },
      { kind: 'docs.guest', workspaceId: 'ws-ref', title: 'A guest edited Game schedule', key: `guest-edit:lifeos:docs:d4:${NOW - 3 * HOUR}`, open: { view: 'docs', workspaceId: 'ws-ref', at: 'lifeos:docs:d4' } }
    ])
    expect(env.calls[0]).toEqual({ method: 'work.docs.find', params: { workspaceId: 'ws-unify', refresh: true } })
  })

  it('looks back a day when no digest was ever made', async () => {
    const env = envOf({ 'ws-unify': [entry('d1', 'Pricing notes', NOW - 23 * HOUR, 'guest'), entry('d3', 'Old brief', NOW - 25 * HOUR, 'guest')] })
    expect((await tellsOf(env, NOW)).map((t) => t.title)).toEqual(['A guest edited Pricing notes'])
  })

  it("names the guest when there is a name", () => {
    expect(guestTitle('Pricing notes', 'Dana Reyes')).toBe('Dana Reyes edited Pricing notes')
    expect(guestTitle('Pricing notes', ' ')).toBe('A guest edited Pricing notes')
  })

  it('tells nothing for a job the docs pillar cannot list, nor when no guest edited', async () => {
    expect(await tellsOf(envOf({ 'ws-unify': new Error('LifeOS is not signed in'), 'ws-ref': [entry('d2', 'Roadmap', NOW - HOUR)] }), NOW)).toEqual([])
  })

  it('says the same words on a second read with nothing changed', async () => {
    const env = envOf({ 'ws-unify': [entry('d1', 'Pricing notes', NOW - HOUR, 'guest')] }, NOW - 20 * HOUR)
    expect(await tellsOf(env, NOW)).toEqual(await tellsOf(env, NOW + 60_000))
  })
  it('reads each job from its own last whole read: a job whose list failed is read from the same time again, so its guest edit is told late, not lost', async () => {
    const kept = new Map<string, string>()
    const store = { get: (k: string) => kept.get(k) ?? null, set: (k: string, v: string) => void kept.set(k, v) }
    // Monday 8:00: Unify's list fails; Ref's is read whole
    const monday = { ...envOf({ 'ws-unify': new Error('LifeOS timed out'), 'ws-ref': [] }, NOW - 24 * HOUR), kept: store }
    const first = (await guests.read(monday, NOW)) as SourceRead
    expect(first.tells).toEqual([])
    first.done!(() => true)
    // Ref moves to its read; Unify stays where it read from
    expect(Object.fromEntries(kept)).toEqual({ 'guests.since:ws-unify': String(NOW - 24 * HOUR), 'guests.since:ws-ref': String(NOW) })
    // Tuesday 8:00: the day was made Monday, after the guest's edit; Unify's list answers now
    const tuesday = { ...envOf({ 'ws-unify': [entry('d1', 'Pricing notes', NOW - 2 * HOUR, 'guest')], 'ws-ref': [entry('d4', 'Game schedule', NOW - 2 * HOUR, 'guest')] }, NOW), kept: store }
    const second = (await guests.read(tuesday, NOW + 24 * HOUR)) as SourceRead
    // Unify looks back to Monday's day before; Ref only to its own read on Monday
    expect(second.tells.map((t) => t.title)).toEqual(['A guest edited Pricing notes'])
    second.done!(() => true)
    expect(kept.get('guests.since:ws-unify')).toBe(String(NOW + 24 * HOUR))
  })
  it("reads LifeOS's error beside a list as a read that was not whole: the cutoff stays, so the edit is told when LifeOS answers", async () => {
    const kept = new Map<string, string>()
    const store = { get: (k: string) => kept.get(k) ?? null, set: (k: string, v: string) => void kept.set(k, v) }
    // Docs catches the LifeOS failure and answers it beside an empty, "complete" list
    const monday = { ...envOf({ 'ws-unify': { entries: [], complete: true, lifeos: 'LifeOS timed out' }, 'ws-ref': [] }, NOW - 24 * HOUR), kept: store }
    ;((await guests.read(monday, NOW)) as SourceRead).done!(() => true)
    expect(kept.get('guests.since:ws-unify')).toBe(String(NOW - 24 * HOUR))
    const tuesday = { ...envOf({ 'ws-unify': [entry('d1', 'Pricing notes', NOW - 2 * HOUR, 'guest')], 'ws-ref': [] }, NOW), kept: store }
    expect((await tellsOf(tuesday, NOW + 24 * HOUR)).map((t) => t.title)).toEqual(['A guest edited Pricing notes'])
  })
  it('keys a row by the document and its edit: the same edit in a partial read and again in a whole one the next day is one row', async () => {
    const kept = new Map<string, string>()
    const store = { get: (k: string) => kept.get(k) ?? null, set: (k: string, v: string) => void kept.set(k, v) }
    const edit = entry('d1', 'Pricing notes', NOW - 2 * HOUR, 'guest')
    const partial = { ...envOf({ 'ws-unify': { entries: [edit], complete: false }, 'ws-ref': [] }, NOW - 24 * HOUR), day: '2026-11-23', kept: store }
    const first = (await guests.read(partial, NOW)) as SourceRead
    first.done!(() => true)
    const whole = { ...envOf({ 'ws-unify': [edit], 'ws-ref': [] }, NOW), day: '2026-11-24', kept: store }
    const second = (await guests.read(whole, NOW + 24 * HOUR)) as SourceRead
    expect(second.tells.map((t) => t.key)).toEqual(first.tells.map((t) => t.key))
    expect(first.tells).toHaveLength(1)
  })
  it("moves a job's cutoff only past what the ledger kept: a tell that did not reach it is told at the next read", async () => {
    const kept = new Map<string, string>()
    const edit = entry('d1', 'Pricing notes', NOW - 2 * HOUR, 'guest')
    const docs = { id: 'docs', handle: async () => ({ handled: true, result: { entries: [edit], projects: [], hits: [], complete: true } }) }
    const ctx = { db: { prepare: () => ({ all: () => [WORKSPACES[0]] }) }, enabled: () => true, log: () => {}, tell: Object.assign(() => {}, { only: () => {} }) }
    const told: string[] = []
    let ledgerUp = false
    const frame = (since: number) =>
      new Sources({
        ctx: ctx as never,
        modules: () => [docs] as never,
        sources: [guests],
        day: () => '2026-11-23',
        zone: () => 'America/Chicago',
        since: () => since,
        // the settings store works throughout
        kept: { get: (k) => kept.get(k) ?? null, set: (k, v) => void kept.set(k, v) },
        // the ledger's insert fails the first time
        tell: (t) => (ledgerUp ? (told.push(t.title), true) : false)
      })
    await frame(NOW - 24 * HOUR).beforeDay(NOW)
    expect(kept.get('guests.since:ws-unify')).toBe(String(NOW - 24 * HOUR))
    // the next digest: the day was made at NOW, after the edit; the ledger takes it now
    ledgerUp = true
    await frame(NOW).beforeDay(NOW + 24 * HOUR)
    expect(told).toEqual(['A guest edited Pricing notes'])
    expect(kept.get('guests.since:ws-unify')).toBe(String(NOW + 24 * HOUR))
  })
})
