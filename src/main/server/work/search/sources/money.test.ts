import { describe, expect, it } from 'vitest'
import type { ClientRequest } from '@shared/contract'
import { handled, NOT_HANDLED } from '@shared/work'
import type { Caller, WorkModule } from '../../modules'
import { runSearch } from '../run'
import { COSMIC, everywhere, makeRig, onlyPurdue, PURDUE, thread, window } from '../testkit'
import { moneySource } from './money'

/** The ledger's rows, asked of Money through its own wire method, against a stand-in module. */

const seen: { params: Record<string, unknown>; by: Caller }[] = []
const money = (answers: Record<string, unknown[]>): WorkModule => ({
  id: 'money' as WorkModule['id'],
  ensure() {},
  async handle(req: ClientRequest, _ctx, by) {
    if (req.method !== ('work.money.search' as never)) return NOT_HANDLED
    const params = (req as { params: Record<string, unknown> }).params
    seen.push({ params, by })
    return handled({ hits: answers[String(params.workspaceId)] ?? [] })
  }
})
const ledgers = {
  [PURDUE]: [{ row: 12, date: '2026-11-20', who: 'Pizza Palace', amount: 4820, way: 'out', category: 'Meals', receipt: 'Money/Receipts/2026/pizza.pdf' }],
  [COSMIC]: [{ row: 3, date: '2026-11-22', who: 'Acme Hosting', amount: 120000, way: 'in', category: 'Invoices' }]
}
const ask = (reach = everywhere, by: Caller = window) => ({ text: 'pizza', reach, limit: 4, by, signal: new AbortController().signal })

describe('money', () => {
  it("is Money's own search, a job in reach at a time, newest first, opened in that job's Money view", async () => {
    seen.length = 0
    const rig = makeRig()
    const source = moneySource([money(ledgers)])
    const hits = await source.search(ask(), rig.ctx)
    expect([source.kind, source.label, source.tier]).toEqual(['money', 'Money', 'network'])
    expect(hits).toEqual([
      { key: `money:${COSMIC}:3`, kind: 'money', title: 'Acme Hosting', detail: '+$1200.00, Invoices', at: Date.parse('2026-11-22T12:00:00'), workspaceId: COSMIC, open: { to: 'view', view: 'money' } },
      { key: `money:${PURDUE}:12`, kind: 'money', title: 'Pizza Palace', detail: '$48.20, Meals', at: Date.parse('2026-11-20T12:00:00'), workspaceId: PURDUE, open: { to: 'view', view: 'money' } }
    ])
    expect(seen[0]).toEqual({ params: { workspaceId: PURDUE, query: 'pizza', limit: 5 }, by: window })
    // a receipt's file is Money's own: nothing of it is carried in a hit
    expect(JSON.stringify(hits)).not.toContain('Receipts')
  })
  it('stays inside the reach and asks as the caller the search was given', async () => {
    seen.length = 0
    const rig = makeRig()
    const hits = await moneySource([money(ledgers)]).search(ask(onlyPurdue, thread('t1')), rig.ctx)
    expect(hits.map((h) => h.workspaceId)).toEqual([PURDUE])
    expect(seen).toEqual([{ params: { workspaceId: PURDUE, query: 'pizza', limit: 5 }, by: thread('t1') }])
  })
  it('is absent, with no line, until Money answers, and stands down for its own search line', async () => {
    const rig = makeRig()
    expect(await runSearch(rig.ctx, { modules: [], own: [moneySource([])], reach: everywhere, text: 'pizza', by: window })).toEqual({ groups: [], pending: [], quiet: [] })
    const own = { kind: 'money', label: 'Money', tier: 'instant' as const, search: async () => [{ key: 'money:theirs', kind: 'money', title: 'Theirs', workspaceId: PURDUE, open: { to: 'view' as const, view: 'money' } }] }
    const module = { ...money(ledgers), search: [own] }
    const answer = await runSearch(rig.ctx, { modules: [module], own: [moneySource([module])], reach: everywhere, text: 'pizza', by: window })
    expect(answer.groups.map((g) => [g.source, g.hits.map((h) => h.key)])).toEqual([['money.money', ['money:theirs']]])
  })
  it('names a row with no payee by its category', async () => {
    const rig = makeRig()
    const [hit] = await moneySource([money({ [PURDUE]: [{ row: 2, date: null, who: '', amount: 500, category: 'Supplies' }] })]).search(ask(onlyPurdue), rig.ctx)
    expect(hit).toMatchObject({ title: 'Supplies', detail: '$5.00' })
    expect(hit.at).toBeUndefined()
  })
})
