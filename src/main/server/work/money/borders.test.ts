import { beforeEach, describe, expect, it } from 'vitest'
import type { MoneyOwed, MoneySums } from '@shared/contract-work-money'
import type { Caller } from '../modules'
import { money } from '.'
import { MONEY_TELLS, moneySearch } from './borders'
import { bench, LOCAL, req, type Bench } from './testing'
import { moneyTools } from './tools'

/* Money's answers to the other pillars, by their shape: the weekly review, Today, Work search and the digest. */

let b: Bench
const call = async <T>(method: string, params: unknown, by: Caller = LOCAL): Promise<T> => ((await money.handle!(req(method, params), b.ctx, by)) as { result: T }).result
const add = (workspaceId: string, fields: Record<string, unknown>) => call('work.money.entry', { workspaceId, fields: { date: '2026-11-21', who: 'Blue Heron Coffee', way: 'out', amount: 1043, ...fields } })

beforeEach(async () => {
  b = bench()
  await add('ws-ref', { date: '2026-11-07', who: 'West Side HS', way: 'in', amount: 8000, status: 'Unpaid', category: 'Game fees' })
  await add('ws-ref', { date: '2026-11-14', who: 'Northside Fuel Stop', amount: 4817, category: 'Travel' })
  await add('ws-purdue', { date: '2026-11-15', who: 'Purdue Catering', amount: 2000, status: 'Unpaid', category: 'Food' })
  await call('work.money.trip', { workspaceId: 'ws-ref', date: '2026-11-21', title: 'Varsity', place: 'Harrison HS', miles: 24 })
})

describe('the weekly review', () => {
  it('reads each job’s sums for a span of local days, in whole cents, with the miles', async () => {
    const got = await call<MoneySums>('work.money.sums', { from: '2026-11-09', to: '2026-11-23' })
    expect(got).toEqual({
      rows: [
        { workspaceId: 'ws-ref', sector: 'ref', in: 0, out: 4817, owedToHim: 8000, heOwes: 0, miles: 24, currency: 'USD' },
        { workspaceId: 'ws-purdue', sector: 'purdue', in: 0, out: 0, owedToHim: 0, heOwes: 2000, miles: 0, currency: 'USD' }
      ]
    })
    // `to` is not in the span.
    expect((await call<MoneySums>('work.money.sums', { from: '2026-11-09', to: '2026-11-14', workspaceId: 'ws-ref' })).rows[0].out).toBe(0)
  })
})

describe('Today', () => {
  it('lists unpaid rows across jobs, the oldest first, each with its job, and how many wait for his accept', async () => {
    const got = await call<MoneyOwed>('work.money.owed', {})
    expect(got).toEqual({
      rows: [
        { workspaceId: 'ws-ref', sector: 'ref', row: 2, who: 'West Side HS', what: '', amount: 8000, since: '2026-11-07', way: 'toHim', reimburse: false, both: false },
        { workspaceId: 'ws-purdue', sector: 'purdue', row: 2, who: 'Purdue Catering', what: '', amount: 2000, since: '2026-11-15', way: 'byHim', reimburse: false, both: false }
      ],
      toConfirm: 0
    })
  })
})

describe('Work search', () => {
  const ask = (text: string, workspaces = ['ws-ref', 'ws-purdue'], limit = 5) =>
    moneySearch.search({ text, limit, by: LOCAL, signal: new AbortController().signal, reach: { workspaces: workspaces.map((id) => ({ id, sector: null, name: id })), chats: false, sessionId: null } }, b.ctx)

  it('is listed on the module, and finds a ledger’s rows as hits that open the Money view of their job', async () => {
    expect(money.search).toEqual([moneySearch])
    expect(await ask('fuel')).toEqual([
      { key: 'money:ws-ref:3', kind: 'money', title: 'Northside Fuel Stop', detail: 'Nov 14, 2026, $48.17, Travel', at: Date.parse('2026-11-14T12:00:00'), workspaceId: 'ws-ref', open: { to: 'view', view: 'money', with: { row: 3 } } }
    ])
    expect((await ask('west'))[0]).toMatchObject({ title: 'West Side HS', detail: 'Nov 7, 2026, +$80.00, Game fees' })
  })

  it('looks only in the jobs in reach, newest first across them, and says there are more with one hit past the limit', async () => {
    expect((await ask('2026')).map((h) => h.workspaceId)).toEqual(['ws-purdue', 'ws-ref', 'ws-ref'])
    expect(await ask('catering', ['ws-ref'])).toEqual([])
    expect(await ask('2026', ['ws-ref', 'ws-purdue'], 1)).toHaveLength(2)
  })
})

describe('the digest', () => {
  it('names its one kind of news on the module, in the results group', () => {
    expect((money as unknown as { tells: unknown }).tells).toBe(MONEY_TELLS)
    expect(MONEY_TELLS).toEqual([{ kind: 'money.confirm', group: 'results', name: 'Receipts to confirm' }])
  })

  it('tells of a waiting one a thread left, with no `by`, and is done with it when he files or drops it; his own drop is no news', async () => {
    const told: Record<string, unknown>[] = []
    const done: string[] = []
    Object.assign(b.ctx, { tell: Object.assign((t: Record<string, unknown>) => void told.push(t), { done: (key: string) => void done.push(key) }) })
    const run = (args: unknown) => moneyTools.find((t) => t.name === 'money_add')!.run(args, { ...b.ctx, sessionId: 't-ref', scope: b.ctx.scopeOf('t-ref')!, signal: new AbortController().signal } as never)
    await run({ date: '2026-11-20', who: 'Clinic', amount: 25, way: 'out' })
    expect(told).toHaveLength(1)
    expect(told[0]).toMatchObject({ kind: 'money.confirm', workspaceId: 'ws-ref', title: 'A receipt to confirm', detail: 'Clinic, $25.00', open: { view: 'money', workspaceId: 'ws-ref' } })
    expect(told[0]).not.toHaveProperty('by')
    const id = (told[0].key as string).replace('money:', '')
    await call('work.money.drop', { id })
    expect(done).toEqual([told[0].key])
    // A file he dropped on the view himself is not news to him.
    await call('work.money.receive', { key: 'own-drop-01', workspaceId: 'ws-ref', name: 'a.png', part: 0, parts: 1, dataBase64: 'AAAA' })
    await new Promise((r) => setTimeout(r, 20))
    expect(told).toHaveLength(1)
  })
})
