import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import type { MoneyActed, MoneyRead } from '@shared/contract-work-money'
import { requiredCapability } from '@shared/capabilities'
import { MONEY_CAPS, MoneyRequestSchemas } from '@shared/contract-work-money'
import { LEDGER_COLUMNS, sigOf, type LedgerRow } from '@shared/work/money'
import type { Caller } from '../modules'
import { money } from '.'
import { newRef, setSharedProbe } from './book'
import { bench, LOCAL, REMOTE, req, type Bench } from './testing'
import { moneyTools } from './tools'

/* The ledger on the host, over a Work service that stands in: what is made, what is written, and who may ask. */

let b: Bench
const call = async <T>(method: string, params: unknown, by: Caller = LOCAL): Promise<T> => ((await money.handle!(req(method, params), b.ctx, by)) as { result: T }).result
const ledger = (): string => join(b.ref, 'Money', 'Ledger.tcsheet')
const entry = (fields: Record<string, unknown>, at?: unknown, workspaceId = 'ws-ref') =>
  call<MoneyActed>('work.money.entry', { workspaceId, ...(at ? { at } : {}), fields: { date: '2026-11-21', who: 'Blue Heron Coffee', way: 'out', amount: 1043, ...fields } })
const read = (workspaceId = 'ws-ref', from = '2026-01-01', to = '2027-01-01', by: Caller = LOCAL) => call<MoneyRead>('work.money.read', { workspaceId, from, to }, by)
const atOf = (r: LedgerRow) => ({ ref: r.ref, row: r.row, sig: sigOf(r) })

beforeEach(() => {
  b = bench()
})

describe('the wire', () => {
  it('reads with read and writes with operate, and every method has its row', () => {
    expect(MoneyRequestSchemas.map((s) => s.shape.method.value).sort()).toEqual(Object.keys(MONEY_CAPS).sort())
    expect(requiredCapability({ method: 'work.money.read' })).toBe('read')
    expect(requiredCapability({ method: 'work.money.entry' })).toBe('operate')
    expect(requiredCapability({ method: 'work.money.paid' })).toBe('operate')
  })

  it('declares no act kind: nothing here sends or moves money', () => {
    expect(money.acts).toBeUndefined()
  })
})

describe('the books', () => {
  it('reads as empty before any are made, and makes nothing by reading', async () => {
    const got = await read()
    expect(got.made).toBe(false)
    expect(got.rows).toEqual([])
    expect(got.categories).toContain('Game fees')
    expect(existsSync(join(b.ref, 'Money'))).toBe(false)
  })

  it('makes the ledger and the mileage log in the job’s own Money folder on first use, with their headers', async () => {
    const books = await call<{ ledger: { at: string; host: string; path: string }; mileage: { path: string } }>('work.money.open', { workspaceId: 'ws-ref' })
    expect(books.ledger).toEqual({ at: 'file', host: 'env_box', path: ledger() })
    expect(books.mileage.path).toBe(join(b.ref, 'Money', 'Mileage.tcsheet'))
    expect(b.sheets.grid(ledger())).toEqual([[...LEDGER_COLUMNS]])
    expect(b.sheets.grid(books.mileage.path)).toEqual([['Date', 'Trip', 'Place', 'Miles', 'Rate', 'Value', 'Ref']])
    // Dressed once: a bold first row that stays in view.
    expect(b.sheets.sheets.get(ledger())!.applied.map((m) => (m as { id: string }).id)).toEqual(['sheet.mutation.set-range-values', 'sheet.mutation.set-frozen'])
    // A second open makes nothing again.
    const creates = b.sheets.asked.filter((a) => a.route === '/internal/sheet/create').length
    await call('work.money.open', { workspaceId: 'ws-ref' })
    expect(b.sheets.asked.filter((a) => a.route === '/internal/sheet/create')).toHaveLength(creates)
  })

  it('takes a ledger already at its place as it is', async () => {
    await call('work.money.open', { workspaceId: 'ws-ref' })
    b.db.exec('DELETE FROM work_money_books')
    b.sheets.type(ledger(), 'A2', '2026-11-01')
    await call('work.money.open', { workspaceId: 'ws-ref' })
    expect(b.sheets.grid(ledger())[1][0]).toBe('2026-11-01')
  })

  it('keeps no books for a code workspace', async () => {
    await expect(call('work.money.open', { workspaceId: 'repo' })).rejects.toThrow('That job is not on this computer.')
  })
})

describe('adding', () => {
  it('appends a row with dollars in In or Out, the status and a Ref of its own', async () => {
    const got = await entry({ category: 'Meals', what: 'Crew coffee' })
    expect(got).toMatchObject({ ok: true, row: 2 })
    const ref = (got as { ref: string }).ref
    expect(ref).toMatch(/^m[0-9a-f]{5}$/)
    expect(b.sheets.grid(ledger())[1]).toEqual(['2026-11-21', 'Blue Heron Coffee', 'Crew coffee', 'Meals', '', 10.43, 'Paid', '', '', ref])
    await entry({ who: 'Harrison HS', way: 'in', amount: 7500, status: 'Unpaid' })
    expect(b.sheets.grid(ledger())[2].slice(0, 7)).toEqual(['2026-11-21', 'Harrison HS', '', '', 75, '', 'Unpaid'])
  })

  it('writes under the last row that holds anything, his own included', async () => {
    await entry({})
    b.sheets.type(ledger(), 'B5', 'a note of his own, lower down')
    expect(await entry({ who: 'Second' })).toMatchObject({ row: 6 })
  })

  it('finds its columns where he moved them, and leaves out one he removed', async () => {
    await call('work.money.open', { workspaceId: 'ws-ref' })
    const s = b.sheets.sheets.get(ledger())!
    s.cells.clear()
    ;['Out', 'Notes', 'Who', 'In', 'Date'].forEach((v, i) => s.cells.set(`${'ABCDE'[i]}1`, v))
    s.rev++
    const got = await entry({ category: 'Meals' })
    // No Ref column: the row is written without one, and says so.
    expect(got).toEqual({ ok: true, ref: null, row: 2 })
    expect(b.sheets.grid(ledger())[1]).toEqual([10.43, '', 'Blue Heron Coffee', '', '2026-11-21'])
  })

  it('suggests on a sheet others can open, writes nothing, and gives each waiting suggestion a row of its own', async () => {
    await call('work.money.open', { workspaceId: 'ws-ref' })
    b.sheets.sheets.get(ledger())!.shared = true
    expect(await entry({})).toMatchObject({ ok: true, suggested: true, row: 2 })
    expect(await entry({ who: 'Second' })).toMatchObject({ ok: true, suggested: true, row: 3 })
    expect(b.sheets.grid(ledger())).toHaveLength(1)
    expect(b.sheets.sheets.get(ledger())!.suggested).toHaveLength(2)
  })

  it('suggests where the job’s folder is a place others can open, though the sheet’s own file says nothing of it', async () => {
    // Files' rule for where a file lies, standing in: this job's folder is in a shared library.
    setSharedProbe((path) => path.startsWith(b.ref))
    try {
      expect(await entry({})).toMatchObject({ ok: true, suggested: true, row: 2 })
      expect(b.sheets.grid(ledger())).toHaveLength(1)
      // The other job's folder is his own: written at once.
      expect(await entry({}, undefined, 'ws-purdue')).toEqual({ ok: true, ref: expect.any(String), row: 2 })
    } finally {
      setSharedProbe(null)
    }
  })

  it('appends one at a time: two at once take two rows', async () => {
    const [x, y] = await Promise.all([entry({ who: 'A' }), entry({ who: 'B' })])
    expect([(x as { row: number }).row, (y as { row: number }).row].sort()).toEqual([2, 3])
  })

  it('refuses a missing amount, a bad day and an amount of nothing', async () => {
    await expect(entry({ amount: 0 })).rejects.toThrow()
    await expect(entry({ date: '11/21/2026' })).rejects.toThrow()
    await expect(entry({ way: 'sideways' })).rejects.toThrow()
  })

  it('makes refs that never read as a number', () => {
    for (let i = 0; i < 50; i++) expect(newRef()).toMatch(/^m[0-9a-f]{5}$/)
  })
})

describe('acting on a row', () => {
  it('changes only the cells that differ, found by Ref after he sorted the sheet', async () => {
    await entry({ category: 'Meals' })
    const row = (await read()).rows[0]
    // He moved the row down by hand.
    const s = b.sheets.sheets.get(ledger())!
    for (const [at, v] of [...s.cells]) {
      if (!at.endsWith('2')) continue
      s.cells.delete(at)
      s.cells.set(at.replace('2', '7'), v)
    }
    s.rev++
    const before = b.sheets.asked.length
    const got = await entry({ category: 'Food', amount: 1100 }, atOf(row))
    expect(got).toMatchObject({ ok: true, row: 7, ref: row.ref })
    const wrote = b.sheets.asked.slice(before).find((a) => a.route === '/internal/sheet/cells')!.body.cells
    expect(wrote).toEqual([
      { at: 'D7', v: 'Food' },
      { at: 'F7', v: 11 }
    ])
  })

  it('finds a row he typed by its number while it reads the same, and gives it no Ref', async () => {
    await call('work.money.open', { workspaceId: 'ws-ref' })
    for (const [at, v] of [
      ['A2', '11/20/2026'],
      ['B2', 'By hand'],
      ['F2', 12]
    ] as const)
      b.sheets.type(ledger(), at, v)
    const row = (await read()).rows[0]
    expect(row).toMatchObject({ ref: null, date: '2026-11-20', out: 1200 })
    expect(await entry({ date: '2026-11-20', who: 'By hand', amount: 1200, category: 'Other' }, atOf(row))).toEqual({ ok: true, ref: null, row: 2 })
    expect(b.sheets.grid(ledger())[1]).toEqual(['11/20/2026', 'By hand', '', 'Other', '', 12])
  })

  it('does not write over a row of Money’s own that he changed in the sheet since the window read it', async () => {
    await entry({ who: 'Harrison HS', way: 'in', amount: 7500, status: 'Unpaid' })
    const row = (await read()).rows[0]
    // He corrects the amount in the sheet; the dialog still holds the old one and he edits only For.
    b.sheets.type(ledger(), 'E2', 80)
    const rev = b.sheets.sheets.get(ledger())!.rev
    expect(await entry({ who: 'Harrison HS', way: 'in', amount: 7500, status: 'Unpaid', what: 'Varsity' }, atOf(row))).toEqual({ changed: true })
    // Paid on the balance the window showed is refused too: it would settle a figure he never saw.
    expect(await call('work.money.paid', { workspaceId: 'ws-ref', at: atOf(row) })).toEqual({ changed: true })
    expect(b.sheets.sheets.get(ledger())!.rev).toBe(rev)
    expect((await read()).rows[0]).toMatchObject({ in: 8000, what: '', status: 'Unpaid' })
  })

  it('answers that the ledger changed, and writes nothing, when the row no longer reads as the window saw it', async () => {
    await call('work.money.open', { workspaceId: 'ws-ref' })
    b.sheets.type(ledger(), 'A2', '2026-11-20')
    b.sheets.type(ledger(), 'F2', 12)
    const row = (await read()).rows[0]
    b.sheets.type(ledger(), 'F2', 99)
    const before = b.sheets.sheets.get(ledger())!.rev
    expect(await entry({ amount: 1200 }, atOf(row))).toEqual({ changed: true })
    expect(await call('work.money.paid', { workspaceId: 'ws-ref', at: atOf(row) })).toEqual({ changed: true })
    expect(b.sheets.sheets.get(ledger())!.rev).toBe(before)
  })

  it('pays an unpaid row and pays back a cost, with the day, and leaves a settled row alone', async () => {
    await entry({ who: 'Harrison HS', way: 'in', amount: 7500, status: 'Unpaid' })
    await entry({ who: 'Ref Gear Outlet', amount: 5099, status: 'To reimburse' })
    await entry({ who: 'Settled', amount: 100 })
    const rows = (await read()).rows.sort((x, y) => x.row - y.row)
    await call('work.money.paid', { workspaceId: 'ws-ref', at: atOf(rows[0]), on: '2026-11-23' })
    await call('work.money.paid', { workspaceId: 'ws-ref', at: atOf(rows[1]), on: '2026-11-23' })
    const before = b.sheets.sheets.get(ledger())!.rev
    await call('work.money.paid', { workspaceId: 'ws-ref', at: atOf(rows[2]), on: '2026-11-23' })
    expect(b.sheets.sheets.get(ledger())!.rev).toBe(before)
    const after = (await read()).rows.sort((x, y) => x.row - y.row)
    expect(after.map((r) => [r.status, r.paidOn])).toEqual([
      ['Paid', '2026-11-23'],
      ['Reimbursed', '2026-11-23'],
      ['Paid', null]
    ])
    expect((await read()).owed).toEqual([])
  })

  it('refuses Paid on a row with money both ways: its one status would settle the side he did not press', async () => {
    await call('work.money.open', { workspaceId: 'ws-ref' })
    for (const [at, v] of [
      ['A2', '2026-11-20'],
      ['B2', 'Mixed'],
      ['E2', 30],
      ['F2', 20],
      ['G2', 'Unpaid']
    ] as const)
      b.sheets.type(ledger(), at, v)
    const got = await read()
    expect(got.owed.map((o) => [o.way, o.both])).toEqual([
      ['toHim', true],
      ['byHim', true]
    ])
    const rev = b.sheets.sheets.get(ledger())!.rev
    await expect(call('work.money.paid', { workspaceId: 'ws-ref', at: atOf(got.rows[0]) })).rejects.toThrow('money in and money out')
    expect(b.sheets.sheets.get(ledger())!.rev).toBe(rev)
  })
})

describe('reading', () => {
  it('paints the view in one read: the period’s rows newest first, sums, categories, months, owed, names', async () => {
    await entry({ date: '2026-10-03', who: 'Harrison HS', way: 'in', amount: 7500, category: 'Game fees' })
    await entry({ date: '2026-11-07', who: 'West Side HS', way: 'in', amount: 8000, status: 'Unpaid', category: 'Game fees' })
    await entry({ date: '2026-11-14', who: 'Northside Fuel Stop', amount: 4817, category: 'Travel' })
    await entry({ date: '2025-12-30', who: 'Last year', amount: 900, category: 'Whistles' })
    const got = await read('ws-ref', '2026-11-01', '2026-12-01')
    expect(got.made).toBe(true)
    expect(got.rows.map((r) => r.who)).toEqual(['Northside Fuel Stop', 'West Side HS'])
    expect(got.sums).toEqual({ in: 0, out: 4817, net: -4817, owedToHim: 8000, heOwes: 0 })
    expect(got.byCategory).toEqual([{ category: 'Travel', amount: -4817, share: 1 }])
    expect(got.byMonth[9]).toEqual({ month: 10, in: 7500, out: 0 })
    expect(got.owed.map((o) => o.who)).toEqual(['West Side HS'])
    expect(got.categories.slice(-1)).toEqual(['Whistles'])
    expect(got.sellers).toEqual(['Last year', 'Northside Fuel Stop', 'West Side HS', 'Harrison HS'])
    expect(got.problems).toEqual([])
  })

  it('reads the sheet again only when its revision moved', async () => {
    await entry({})
    await read()
    const ranges = (): number => b.sheets.asked.filter((a) => a.route === '/internal/sheet/range').length
    const before = ranges()
    await read()
    await read('ws-ref', '2026-11-01', '2026-12-01')
    expect(ranges()).toBe(before)
    // What he edits in the sheet is what Money shows.
    b.sheets.type(ledger(), 'F2', 20)
    expect((await read()).rows[0].out).toBe(2000)
    expect(ranges()).toBeGreaterThan(before)
  })

  it('says the columns changed when a needed header is gone, refuses to write, and restores them at the end on his press', async () => {
    await call('work.money.open', { workspaceId: 'ws-ref' })
    // The header went with nothing under it: there is nothing of his to misread, so it is put back at the end.
    b.sheets.type(ledger(), 'F1', '')
    const got = await read()
    expect(got.problems).toEqual([{ kind: 'columns', missing: ['Out'], renamed: [] }])
    await expect(entry({})).rejects.toThrow("The ledger's columns changed.")
    await call('work.money.open', { workspaceId: 'ws-ref', restore: true })
    expect(b.sheets.grid(ledger())[0]).toEqual(['Date', 'Who', 'For', 'Category', 'In', '', 'Status', 'Paid on', 'Receipt', 'Ref', 'Out'])
    expect((await read()).problems).toEqual([])
  })

  it('never restores over a column he renamed: his figures are under it, so naming it back is his', async () => {
    await entry({})
    b.sheets.type(ledger(), 'F1', 'Spent')
    const got = await read()
    expect(got.problems).toEqual([{ kind: 'columns', missing: ['Out'], renamed: ['Spent'] }])
    expect(got.rows).toEqual([])
    const rev = b.sheets.sheets.get(ledger())!.rev
    await expect(call('work.money.open', { workspaceId: 'ws-ref', restore: true })).rejects.toThrow('Spent may be it. Name it back in the ledger.')
    expect(b.sheets.sheets.get(ledger())!.rev).toBe(rev)
    // He names it back: his expense is read again, never as nothing.
    b.sheets.type(ledger(), 'F1', 'Out')
    expect((await read()).rows[0].out).toBe(1043)
  })

  it('reads past a long stretch of blank rows he left, and appends under the last row that holds anything', async () => {
    await entry({ who: 'First' })
    // He pastes a block far down the sheet, more than a whole page of blank rows below the last entry.
    for (const [at, v] of [
      ['A2600', '2026-11-22'],
      ['B2600', 'Far down'],
      ['F2600', 7]
    ] as const)
      b.sheets.type(ledger(), at, v)
    const got = await read()
    expect(got.rows.map((r) => [r.row, r.who])).toEqual([
      [2600, 'Far down'],
      [2, 'First']
    ])
    expect(await entry({ who: 'After it' })).toMatchObject({ row: 2601 })
  })

  it('says whether the job has any money at all, apart from the period on screen', async () => {
    expect((await read()).any).toBe(false)
    await call('work.money.open', { workspaceId: 'ws-ref' })
    expect((await read()).any).toBe(false)
    // A row with no name, in another year: the job is not empty, though this period and its names are.
    await entry({ date: '2024-03-01', who: '', amount: 500 })
    const got = await read()
    expect([got.any, got.rows.length, got.sellers.length]).toEqual([true, 0, 0])
  })

  it('leaves a row he typed with money both in and out to the sheet: the form cannot say it', async () => {
    await call('work.money.open', { workspaceId: 'ws-ref' })
    for (const [at, v] of [
      ['A2', '2026-11-20'],
      ['B2', 'Mixed'],
      ['E2', 30],
      ['F2', 20]
    ] as const)
      b.sheets.type(ledger(), at, v)
    const row = (await read()).rows[0]
    expect([row.in, row.out]).toEqual([3000, 2000])
    const rev = b.sheets.sheets.get(ledger())!.rev
    await expect(entry({ date: '2026-11-20', who: 'Mixed', amount: 2000, what: 'A note' }, atOf(row))).rejects.toThrow('money in and money out')
    expect(b.sheets.sheets.get(ledger())!.rev).toBe(rev)
  })

  it('says so when restored columns only wait as a suggestion on a sheet others can open', async () => {
    await call('work.money.open', { workspaceId: 'ws-ref' })
    b.sheets.type(ledger(), 'F1', '')
    b.sheets.sheets.get(ledger())!.shared = true
    expect((await call<{ suggested?: true }>('work.money.open', { workspaceId: 'ws-ref', restore: true })).suggested).toBe(true)
    expect((await read()).problems).toEqual([{ kind: 'columns', missing: ['Out'], renamed: [] }])
    b.sheets.sheets.get(ledger())!.shared = false
    expect((await call<{ suggested?: true }>('work.money.open', { workspaceId: 'ws-ref', restore: true })).suggested).toBeUndefined()
  })

  it('sums every job with a ledger, or the one asked for', async () => {
    await entry({ date: '2026-11-14', amount: 4817 })
    await entry({ date: '2026-11-15', who: 'Purdue Catering', amount: 2000, status: 'Unpaid' }, undefined, 'ws-purdue')
    const all = await call<{ rows: { workspaceId: string; out: number; heOwes: number; currency: string }[] }>('work.money.sums', { from: '2026-11-01', to: '2026-12-01' })
    expect(all.rows).toEqual([
      { workspaceId: 'ws-ref', sector: 'ref', in: 0, out: 4817, owedToHim: 0, heOwes: 0, miles: 0, currency: 'USD' },
      { workspaceId: 'ws-purdue', sector: 'purdue', in: 0, out: 0, owedToHim: 0, heOwes: 2000, miles: 0, currency: 'USD' }
    ])
    const one = await call<{ rows: unknown[] }>('work.money.sums', { from: '2026-11-01', to: '2026-12-01', workspaceId: 'ws-purdue' })
    expect(one.rows).toHaveLength(1)
  })

  it('lists what is owed across jobs, the oldest first, with how many receipts wait', async () => {
    await entry({ date: '2026-11-07', who: 'West Side HS', way: 'in', amount: 8000, status: 'Unpaid' })
    await entry({ date: '2026-11-01', who: 'Purdue Catering', amount: 2000, status: 'Unpaid' }, undefined, 'ws-purdue')
    b.db.prepare("INSERT INTO work_money_inbox (id, key, workspace_id, state, source, created_at, updated_at) VALUES ('i1', 'k1', 'ws-ref', 'ready', 'drop', 1, 1)").run()
    const got = await call<{ rows: { who: string; way: string; workspaceId: string }[]; toConfirm: number }>('work.money.owed', {})
    expect(got.rows.map((r) => [r.who, r.way, r.workspaceId])).toEqual([
      ['Purdue Catering', 'byHim', 'ws-purdue'],
      ['West Side HS', 'toHim', 'ws-ref']
    ])
    expect(got.toConfirm).toBe(1)
  })

  it('finds rows by every word asked for, newest first', async () => {
    await entry({ date: '2026-11-14', who: 'Northside Fuel Stop', amount: 4817, category: 'Travel' })
    await entry({ date: '2026-11-21', who: 'Northside Fuel Stop', amount: 5210, category: 'Travel' })
    await entry({ date: '2026-11-20', who: 'Blue Heron Coffee', amount: 1043 })
    const got = await call<{ hits: { who: string; amount: number; way: string; date: string }[] }>('work.money.search', { workspaceId: 'ws-ref', query: 'northside travel' })
    expect(got.hits.map((h) => [h.date, h.amount, h.way])).toEqual([
      ['2026-11-21', 5210, 'out'],
      ['2026-11-14', 4817, 'out']
    ])
    expect((await call<{ hits: unknown[] }>('work.money.search', { workspaceId: 'ws-ref', query: '$10.43' })).hits).toHaveLength(1)
    expect((await call<{ hits: unknown[] }>('work.money.search', { workspaceId: 'ws-purdue', query: 'fuel' })).hits).toEqual([])
  })
})

describe('who may ask', () => {
  const MODEL: Caller = { kind: 'model', caps: ['read', 'operate'], sessionId: 't-ref' }

  it('refuses every write for a thread’s own call', async () => {
    await expect(entry({}, undefined, 'ws-ref').then(() => call('work.money.entry', { workspaceId: 'ws-ref', fields: { date: '2026-11-21', who: 'X', way: 'out', amount: 1 } }, MODEL))).rejects.toThrow('Only the owner writes the ledger.')
    await expect(call('work.money.open', { workspaceId: 'ws-ref' }, MODEL)).rejects.toThrow('Only the owner')
    await expect(call('work.money.paid', { workspaceId: 'ws-ref', at: { row: 2, sig: 'x' } }, MODEL)).rejects.toThrow('Only the owner')
  })

  it('lets a thread read its own job’s money and no other’s', async () => {
    await entry({})
    expect((await read('ws-ref', '2026-01-01', '2027-01-01', MODEL)).rows).toHaveLength(1)
    await expect(read('ws-purdue', '2026-01-01', '2027-01-01', MODEL)).rejects.toThrow("its own job's money")
    const state = await call<{ jobs: { workspaceId: string }[] }>('work.money.state', {}, MODEL)
    expect(state.jobs.map((j) => j.workspaceId)).toEqual(['ws-ref'])
  })

  it('holds a remote key to the folders it could name itself', async () => {
    await entry({})
    await entry({ who: 'Purdue Catering' }, undefined, 'ws-purdue')
    expect((await read('ws-ref', '2026-01-01', '2027-01-01', REMOTE)).rows).toHaveLength(1)
    await expect(read('ws-purdue', '2026-01-01', '2027-01-01', REMOTE)).rejects.toThrow('outside app-managed roots')
    await expect(call('work.money.entry', { workspaceId: 'ws-purdue', fields: { date: '2026-11-21', who: 'X', way: 'out', amount: 1 } }, REMOTE)).rejects.toThrow('outside app-managed roots')
    // A call that names no job answers only for the ones it reaches.
    const sums = await call<{ rows: { workspaceId: string }[] }>('work.money.sums', { from: '2026-01-01', to: '2027-01-01' }, REMOTE)
    expect(sums.rows.map((r) => r.workspaceId)).toEqual(['ws-ref'])
    const state = await call<{ jobs: { workspaceId: string; made: boolean }[] }>('work.money.state', {}, REMOTE)
    expect(state.jobs).toEqual([{ workspaceId: 'ws-ref', name: 'Ref', sector: 'ref', made: true, categories: ['Game fees', 'Mileage', 'Uniform and gear', 'Dues and registration', 'Training', 'Travel', 'Meals', 'Other'] }])
  })
})

describe('the tool', () => {
  const run = (args: unknown, sessionId = 't-ref') =>
    moneyTools[0].run(args, { ...b.ctx, sessionId, scope: b.ctx.scopeOf(sessionId)!, signal: new AbortController().signal } as never).then((r) => ({ text: (r.content[0] as { text: string }).text, isError: r.isError }))

  it('is read only, and offered to a job’s thread alone', () => {
    expect(moneyTools[0]).toMatchObject({ name: 'money_read', readOnly: true })
    expect(money.tools!({ workspaceId: null } as never)).toEqual([])
    expect(money.tools!({ workspaceId: 'ws-ref' } as never)).toBe(moneyTools)
  })

  it('reads the thread’s own job: sums, then each entry', async () => {
    expect((await run({})).text).toBe('Ref has no ledger yet.')
    await entry({ date: '2026-11-14', who: 'Northside Fuel Stop', amount: 4817, category: 'Travel' })
    await entry({ date: '2026-11-07', who: 'West Side HS', way: 'in', amount: 8000, status: 'Unpaid', category: 'Game fees', what: 'Varsity' })
    const got = await run({ from: '2026-11-01', to: '2026-12-01' })
    expect(got.isError).toBeUndefined()
    expect(got.text).toContain('In $0.00, out $48.17, net -$48.17')
    expect(got.text).toContain('Owed to the owner $80.00')
    expect(got.text).toContain('2026-11-07 | West Side HS | Game fees | +$80.00 | Unpaid | Varsity')
    expect((await run({ from: '2026-11-01', to: '2026-12-01', category: 'travel' })).text).not.toContain('West Side HS')
  })
})

describe('a receipt as a file', () => {
  it('joins the Receipt cell under the Money folder in the host’s own spelling, and never leaves the folder', async () => {
    const { receiptSource } = await import('@shared/contract-work-money')
    const got = await read()
    expect(got.root).toEqual({ at: 'file', host: 'env_box', path: join(b.ref, 'Money') })
    expect(receiptSource(got.root, 'Receipts/2026/a b.png').path).toBe(join(b.ref, 'Money', 'Receipts', '2026', 'a b.png'))
    expect(receiptSource(got.root, '../../etc/passwd').path).toBe(join(b.ref, 'Money', 'etc', 'passwd'))
    expect(receiptSource({ at: 'file', host: 'pc', path: 'C:\\Jobs\\Ref\\Money' }, 'Receipts/2026/a.png').path).toBe('C:\\Jobs\\Ref\\Money\\Receipts\\2026\\a.png')
  })
})
