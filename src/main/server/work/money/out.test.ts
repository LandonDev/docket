import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { MONEY_CAPS, MONEY_OWNER_ONLY, MONEY_PART_BYTES, type MoneyExport, type MoneyInvoiceNext, type MoneyInvoicePage, type MoneyKept, type MoneyRead } from '@shared/contract-work-money'
import { ACT_KINDS, ACT_PILLAR } from '@shared/work/acts'
import type { Caller } from '../modules'
import { money } from '.'
import { bench, LOCAL, REMOTE, req, type Bench } from './testing'
import { moneyTools } from './tools'

/* Out: the year's folder for tax time, an invoice and a purchase request, and that nothing here sends. */

let b: Bench
const call = async <T>(method: string, params: unknown, by: Caller = LOCAL): Promise<T> => ((await money.handle!(req(method, params), b.ctx, by)) as { result: T }).result
const add = (fields: Record<string, unknown>) => call('work.money.entry', { workspaceId: 'ws-ref', fields: { date: '2026-11-21', who: 'Blue Heron Coffee', way: 'out', amount: 1043, ...fields } })
const view = () => call<MoneyRead>('work.money.read', { workspaceId: 'ws-ref', from: '2026-01-01', to: '2027-01-01' })
const tax = (year = 2026): string => join(b.ref, 'Money', `Tax ${year}`)
const PDF = Buffer.from('%PDF-1.7 made up')
const keep = (over: Record<string, unknown>, data: Buffer = PDF, by: Caller = LOCAL) =>
  call<MoneyKept>('work.money.keep', { workspaceId: 'ws-ref', key: 'keep-key-01', part: 0, parts: 1, dataBase64: data.toString('base64'), ...over }, by)
const invoice = (over: Record<string, unknown> = {}) => ({
  kind: 'invoice',
  number: '1042',
  to: 'Rivera Dental\n12 Elm St',
  date: '2026-11-23',
  due: '2026-12-07',
  lines: [
    { what: 'Design', quantity: 2.5, rate: 12000 },
    { what: 'Hosting', quantity: 1, rate: 2000 }
  ],
  from: { name: 'Unify Platforms', address: '1 Main St', pay: 'Check or ACH' },
  ...over
})

beforeEach(() => {
  b = bench()
})

describe('export for tax time', () => {
  it('makes the year’s folder with the CSV and the Excel file made from it, and answers the summary’s page to print', async () => {
    await add({ date: '2026-03-01', who: 'Rivera, Dental', way: 'in', amount: 120000, category: 'Sales' })
    await add({ date: '2026-05-02', who: 'Clinic', amount: 2500, status: 'Reimbursed' })
    await add({ date: '2025-04-02', who: 'Last year', amount: 9900 })
    await call('work.money.trip', { workspaceId: 'ws-ref', date: '2026-06-01', title: 'Client visit', place: 'Rivera Dental', miles: 30 })
    const got = await call<MoneyExport>('work.money.export', { workspaceId: 'ws-ref', year: 2026 })
    expect(got.folder).toEqual({ at: 'file', host: 'env_box', path: tax() })
    expect(got.files).toEqual(['Ledger 2026.csv', 'Ledger 2026.xlsx'])
    expect(got.warnings).toEqual([])
    const csv = readFileSync(join(tax(), 'Ledger 2026.csv'), 'utf8')
    expect(csv).toContain('2026-03-01,"Rivera, Dental",,Sales,1200.00,,Paid')
    expect(csv).not.toContain('Last year')
    expect(csv).toContain('Date,Trip,Place,Miles,Rate,Value,Ref\r\n2026-06-01,Client visit,Rivera Dental,30,0.7,21.00')
    // The Excel file came from the conversion runner, asked for csv to xlsx.
    expect(b.converted.map((j) => [j.from, j.to, j.input])).toEqual([['csv', 'xlsx', join(tax(), 'Ledger 2026.csv')]])
    expect(existsSync(join(tax(), 'Ledger 2026.xlsx'))).toBe(true)
    expect(got.summary?.name).toBe('Summary 2026.pdf')
    // The reimbursed clinic is listed and left out of the costs; the mileage is there.
    expect(got.summary?.html).toContain('<tr><td>Out</td><td class="n">$0.00</td></tr>')
    expect(got.summary?.html).toContain('Clinic')
    expect(got.summary?.html).toContain('30 mi · $21.00 at $0.70')
    expect(readdirSync(tax()).sort()).toEqual(['Ledger 2026.csv', 'Ledger 2026.xlsx'])
  })

  it('makes only what was asked for, and the Excel file with no CSV left behind', async () => {
    await add({})
    const got = await call<MoneyExport>('work.money.export', { workspaceId: 'ws-ref', year: 2026, csv: false, pdf: false })
    expect(got.files).toEqual(['Ledger 2026.xlsx'])
    expect(got.summary).toBeNull()
    expect(readdirSync(tax())).toEqual(['Ledger 2026.xlsx'])
  })

  it('still makes the rest, and says so, when no Excel file can be made here', async () => {
    await add({})
    b.readerDown = true
    const got = await call<MoneyExport>('work.money.export', { workspaceId: 'ws-ref', year: 2026 })
    expect(got.files).toEqual(['Ledger 2026.csv'])
    expect(got.warnings).toEqual(['The Excel file could not be made on this computer.'])
    expect(got.summary).not.toBeNull()
  })

  it('keeps the printed summary in the year’s folder, in parts, and a repeat of the key answers the first', async () => {
    await add({})
    const data = Buffer.alloc(MONEY_PART_BYTES + 5, 3)
    const part = (n: number) => call<MoneyKept>('work.money.keep', { workspaceId: 'ws-ref', key: 'summary-key', what: 'summary', year: 2026, part: n, parts: 2, dataBase64: data.subarray(n * MONEY_PART_BYTES, (n + 1) * MONEY_PART_BYTES).toString('base64') })
    expect(await part(0)).toEqual({ partial: true })
    const done = await part(1)
    expect(done).toEqual({ source: { at: 'file', host: 'env_box', path: join(tax(), 'Summary 2026.pdf') }, receipt: 'Tax 2026/Summary 2026.pdf' })
    expect(readFileSync(join(tax(), 'Summary 2026.pdf')).equals(data)).toBe(true)
    expect(await part(1)).toEqual(done)
    // What was kept is no waiting receipt.
    expect((await view()).toConfirm).toEqual([])
    await expect(keep({ key: 'no-year-key', what: 'summary' })).rejects.toThrow('names its year')
  })

  it('refuses a job with no ledger', async () => {
    await expect(call('work.money.export', { workspaceId: 'ws-ref', year: 2026 })).rejects.toThrow('Ref has no ledger to export yet.')
  })
})

describe('an invoice', () => {
  it('starts at 1001, then one past the highest used; his details are asked once and come back with his terms', async () => {
    expect(await call<MoneyInvoiceNext>('work.money.invoiceNext', { workspaceId: 'ws-ref' })).toEqual({ number: '1001', from: null, dueDays: 14 })
    const page = await call<MoneyInvoicePage>('work.money.invoice', { workspaceId: 'ws-ref', invoice: invoice({ due: '2026-12-23' }) })
    expect(page.name).toBe('Invoice 1042 Rivera Dental.pdf')
    expect(page.html).toContain('Invoice 1042')
    expect(page.html).toContain('$320.00')
    expect(await call<MoneyInvoiceNext>('work.money.invoiceNext', { workspaceId: 'ws-ref' })).toEqual({ number: '1043', from: { name: 'Unify Platforms', address: '1 Main St', pay: 'Check or ACH' }, dueDays: 30 })
    // A purchase request counts by itself.
    expect((await call<MoneyInvoiceNext>('work.money.invoiceNext', { workspaceId: 'ws-ref', kind: 'request' })).number).toBe('1001')
    // The page alone files nothing.
    expect((await view()).rows).toEqual([])
  })

  it('reads the highest number from the ledger too, so a number he typed by hand counts', async () => {
    await add({ way: 'in', who: 'Old client', amount: 5000, what: 'Invoice 2001' })
    expect((await call<MoneyInvoiceNext>('work.money.invoiceNext', { workspaceId: 'ws-ref' })).number).toBe('2002')
  })

  it('keeps the printed PDF under Invoices and files its row: money in, unpaid, with the file', async () => {
    const got = await keep({ what: 'invoice', invoice: invoice() })
    expect(got.receipt).toBe('Invoices/Invoice 1042 Rivera Dental.pdf')
    expect(got.acted).toMatchObject({ ok: true, row: 2 })
    expect(readFileSync(join(b.ref, 'Money', 'Invoices', 'Invoice 1042 Rivera Dental.pdf')).equals(PDF)).toBe(true)
    const now = await view()
    expect(now.rows).toMatchObject([{ date: '2026-11-23', who: 'Rivera Dental', what: 'Invoice 1042', category: 'Game fees', in: 32000, status: 'Unpaid', receipt: 'Invoices/Invoice 1042 Rivera Dental.pdf' }])
    expect(now.owed).toMatchObject([{ who: 'Rivera Dental', amount: 32000, way: 'toHim' }])
    // The same key again files nothing twice.
    expect(await keep({ what: 'invoice', invoice: invoice() })).toEqual(got)
    expect((await view()).rows).toHaveLength(1)
    // A second invoice of the same name never replaces the first's file.
    const twin = await keep({ key: 'keep-key-02', what: 'invoice', invoice: invoice() })
    expect(twin.receipt).toBe('Invoices/Invoice 1042 Rivera Dental (2).pdf')
  })

  it('files a purchase request as money out that is not his cost', async () => {
    const got = await keep({ key: 'request-key', what: 'invoice', invoice: invoice({ kind: 'request', number: '12', to: 'Gear & Co', reason: 'Jerseys for spring' }) })
    expect(got.receipt).toBe('Invoices/Purchase request 12 Gear & Co.pdf')
    const now = await view()
    expect(now.rows).toMatchObject([{ who: 'Gear & Co', what: 'Purchase request 12: Jerseys for spring', out: 32000, status: 'Requested' }])
    expect(now.sums.out).toBe(0)
    expect(now.owed).toEqual([])
  })

  it('refuses one with no amount, and one due before its date', async () => {
    await expect(call('work.money.invoice', { workspaceId: 'ws-ref', invoice: invoice({ lines: [{ what: 'Nothing', quantity: 0, rate: 100 }] }) })).rejects.toThrow('needs a line with an amount')
    await expect(call('work.money.invoice', { workspaceId: 'ws-ref', invoice: invoice({ due: '2026-11-01' }) })).rejects.toThrow('due before its date')
    await expect(keep({ what: 'invoice' })).rejects.toThrow('comes with its fields')
  })
})

describe('nothing here sends', () => {
  const MODEL: Caller = { kind: 'model', caps: ['read', 'operate'], sessionId: 't-ref' }

  it('refuses every write for a thread’s own call', async () => {
    for (const method of MONEY_OWNER_ONLY) {
      const params = method === 'work.money.accept' || method === 'work.money.drop' ? { id: 'x' } : { workspaceId: 'ws-ref' }
      await expect(money.handle!(req(method, params), b.ctx, MODEL), method).rejects.toThrow('Only the owner')
    }
    // Every method that changes something is the owner's alone.
    const writes = Object.entries(MONEY_CAPS)
      .filter(([, cap]) => cap !== 'read')
      .map(([m]) => m)
    expect(writes.sort()).toEqual([...MONEY_OWNER_ONLY].sort())
  })

  it('declares no act kind, holds nothing, and no tool of its own sends or files', () => {
    expect(money.acts).toBeUndefined()
    expect(Object.values(ACT_PILLAR)).not.toContain('money')
    expect(ACT_KINDS.some((k) => /invoice|money/.test(k))).toBe(false)
    expect(moneyTools.map((t) => t.name)).toEqual(['money_read', 'money_add', 'money_receipt'])
  })

  it('holds a remote key to the job’s folder for an export and a kept file', async () => {
    await call('work.money.entry', { workspaceId: 'ws-purdue', fields: { date: '2026-11-21', who: 'X', way: 'out', amount: 100 } })
    await expect(call('work.money.export', { workspaceId: 'ws-purdue', year: 2026 }, REMOTE)).rejects.toThrow('outside app-managed roots')
    await expect(call('work.money.keep', { workspaceId: 'ws-purdue', key: 'remote-keep-1', what: 'summary', year: 2026, part: 0, parts: 1, dataBase64: 'AAAA' }, REMOTE)).rejects.toThrow('outside app-managed roots')
  })
})
