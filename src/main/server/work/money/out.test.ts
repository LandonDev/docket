import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { MONEY_CAPS, MONEY_OWNER_ONLY, MONEY_PART_BYTES, type MoneyExport, type MoneyInvoiceNext, type MoneyInvoicePage, type MoneyKept, type MoneyRead } from '@shared/contract-work-money'
import { ACT_KINDS, ACT_PILLAR } from '@shared/work/acts'
import type { Caller } from '../modules'
import { money } from '.'
import { publishSet } from './out'
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
/** Create as the window does it: the page is asked for (which takes the number for this key), then the printed page is kept under the same key. */
const create = async (inv: Record<string, unknown>, key = 'keep-key-01', data: Buffer = PDF): Promise<MoneyKept> => {
  await call('work.money.invoice', { workspaceId: 'ws-ref', key, invoice: inv })
  return keep({ key, what: 'invoice', invoice: inv }, data)
}
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
    expect(got.replaced).toBe(false)
    const csv = readFileSync(join(tax(), 'Ledger 2026.csv'), 'utf8')
    expect(csv).toContain('2026-03-01,"Rivera, Dental",,Sales,1200.00,,Paid')
    expect(csv).not.toContain('Last year')
    expect(csv).toContain('Date,Trip,Place,Miles,Rate,Value,Ref\r\n2026-06-01,Client visit,Rivera Dental,30,0.7,21.00')
    // The Excel file came from the conversion runner, asked for csv to xlsx.
    expect(b.converted.map((j) => [j.from, j.to])).toEqual([['csv', 'xlsx']])
    // From this read's own copy, in the host's data folder: never from the file in the year's folder, which another hand could change first.
    expect(b.converted[0].input.startsWith(join(b.root, 'data', 'work-money', 'export'))).toBe(true)
    expect(existsSync(join(tax(), 'Ledger 2026.xlsx'))).toBe(true)
    expect(got.summary?.name).toBe('Summary 2026.pdf')
    // The reimbursed clinic is listed and left out of the costs; the mileage is there.
    expect(got.summary?.html).toContain('<tr><td>Out</td><td class="n">$0.00</td></tr>')
    expect(got.summary?.html).toContain('Clinic')
    expect(got.summary?.html).toContain('30 mi · $21.00 at $0.70')
    expect(readdirSync(tax()).sort()).toEqual(['Ledger 2026.csv', 'Ledger 2026.xlsx'])
    // A second export takes the first's place, and says so; one that writes none of the files already there does not.
    expect((await call<MoneyExport>('work.money.export', { workspaceId: 'ws-ref', year: 2026 })).replaced).toBe(true)
    expect((await call<MoneyExport>('work.money.export', { workspaceId: 'ws-ref', year: 2026, csv: false, xlsx: false })).replaced).toBe(false)
    // A staged file is made under a fresh name of its own, never through a name already there.
    expect(readdirSync(tax()).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })

  it('never writes an export through a link someone left at its staging name or its place', async () => {
    await add({})
    await call<MoneyExport>('work.money.export', { workspaceId: 'ws-ref', year: 2026, xlsx: false, pdf: false })
    const outside = join(b.root, 'elsewhere', 'victim.txt')
    writeFileSync(outside, 'mine')
    rmSync(join(tax(), 'Ledger 2026.csv'))
    symlinkSync(outside, join(tax(), 'Ledger 2026.csv'))
    symlinkSync(outside, join(tax(), 'Ledger 2026.csv.tmp'))
    await call<MoneyExport>('work.money.export', { workspaceId: 'ws-ref', year: 2026, xlsx: false, pdf: false })
    // The file outside is untouched, and the export is a real file in the folder now.
    expect(readFileSync(outside, 'utf8')).toBe('mine')
    expect(lstatSync(join(tax(), 'Ledger 2026.csv')).isSymbolicLink()).toBe(false)
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
    // A summary is of an export: with none on record for the year, it is not kept.
    await expect(keep({ key: 'no-export-key', what: 'summary', year: 2026 })).rejects.toThrow("That summary is not of 2026's newest export, so it was not kept. Export again.")
    const { generation } = await call<MoneyExport>('work.money.export', { workspaceId: 'ws-ref', year: 2026, csv: false, xlsx: false })
    const data = Buffer.alloc(MONEY_PART_BYTES + 5, 3)
    const part = (n: number) =>
      call<MoneyKept>('work.money.keep', { workspaceId: 'ws-ref', key: 'summary-key', what: 'summary', year: 2026, generation, part: n, parts: 2, dataBase64: data.subarray(n * MONEY_PART_BYTES, (n + 1) * MONEY_PART_BYTES).toString('base64') })
    expect(await part(0)).toEqual({ partial: true })
    const done = await part(1)
    expect(done).toEqual({ source: { at: 'file', host: 'env_box', path: join(tax(), 'Summary 2026.pdf') }, receipt: 'Tax 2026/Summary 2026.pdf' })
    expect(readFileSync(join(tax(), 'Summary 2026.pdf')).equals(data)).toBe(true)
    expect(await part(1)).toEqual(done)
    // A second summary for the year takes the first's place, and says so.
    expect((await keep({ key: 'summary-key-2', what: 'summary', year: 2026, generation })).replaced).toBe(true)
    // What was kept is no waiting receipt.
    expect((await view()).toConfirm).toEqual([])
    await expect(keep({ key: 'no-year-key', what: 'summary' })).rejects.toThrow('names its year')
  })

  it('makes two exports of one year one after the other, each whole from its own read', async () => {
    await add({})
    const [x, y] = await Promise.all([call<MoneyExport>('work.money.export', { workspaceId: 'ws-ref', year: 2026, pdf: false }), call<MoneyExport>('work.money.export', { workspaceId: 'ws-ref', year: 2026, pdf: false })])
    expect([x.files, y.files]).toEqual([
      ['Ledger 2026.csv', 'Ledger 2026.xlsx'],
      ['Ledger 2026.csv', 'Ledger 2026.xlsx']
    ])
    // The second began only when the first had written everything: it is the one that found files to replace.
    expect([x.replaced, y.replaced]).toEqual([false, true])
    expect(new Set(b.converted.map((j) => j.input)).size).toBe(2)
  })

  it('exports no year whose trips it cannot read: a log with rows and no Miles column is not a year with no miles', async () => {
    await add({})
    await call('work.money.trip', { workspaceId: 'ws-ref', date: '2026-06-01', title: 'Client visit', place: 'Rivera Dental', miles: 30 })
    b.sheets.type(join(b.ref, 'Money', 'Mileage.tcsheet'), 'D1', 'Distance')
    const now = await view()
    expect(now.problems).toEqual([{ kind: 'mileage', reason: 'columns', missing: ['Miles'] }])
    expect(now.miles.miles).toBe(0)
    await expect(call('work.money.export', { workspaceId: 'ws-ref', year: 2026 })).rejects.toThrow('The mileage log has no Miles column, so its trips cannot be read. Put it right, then export.')
    expect(existsSync(tax())).toBe(false)
  })

  it('keeps only the newest export’s summary: a page printed from an older export, sent late, is refused', async () => {
    await add({})
    const older = await call<MoneyExport>('work.money.export', { workspaceId: 'ws-ref', year: 2026 })
    const newer = await call<MoneyExport>('work.money.export', { workspaceId: 'ws-ref', year: 2026 })
    expect(newer.generation).toBeGreaterThan(older.generation)
    // The slower window's page arrives after the newer export was made.
    await expect(keep({ key: 'summary-old-1', what: 'summary', year: 2026, generation: older.generation }, Buffer.from('%PDF old'))).rejects.toThrow("That summary is not of 2026's newest export, so it was not kept. Export again.")
    // Nor one that names no export, or one the host never answered: with an export on record, the page must be of it.
    await expect(keep({ key: 'summary-none-1', what: 'summary', year: 2026 }, Buffer.from('%PDF none'))).rejects.toThrow('not of 2026')
    await expect(keep({ key: 'summary-next-1', what: 'summary', year: 2026, generation: newer.generation + 5 }, Buffer.from('%PDF next'))).rejects.toThrow('not of 2026')
    expect(existsSync(join(tax(), 'Summary 2026.pdf'))).toBe(false)
    await keep({ key: 'summary-new-1', what: 'summary', year: 2026, generation: newer.generation }, Buffer.from('%PDF new'))
    expect(readFileSync(join(tax(), 'Summary 2026.pdf'), 'utf8')).toBe('%PDF new')
    // The refused key stays refused, and another year's export does not touch this year's count.
    await expect(keep({ key: 'summary-old-1', what: 'summary', year: 2026, generation: older.generation }, Buffer.from('%PDF old'))).rejects.toThrow('not of 2026')
    expect(readFileSync(join(tax(), 'Summary 2026.pdf'), 'utf8')).toBe('%PDF new')
  })

  it('never leaves an older export’s workbook beside new figures when the Excel file cannot be made', async () => {
    await add({})
    await call<MoneyExport>('work.money.export', { workspaceId: 'ws-ref', year: 2026, pdf: false })
    expect(readdirSync(tax()).sort()).toEqual(['Ledger 2026.csv', 'Ledger 2026.xlsx'])
    await add({ who: 'A later entry', amount: 700 })
    b.readerDown = true
    const got = await call<MoneyExport>('work.money.export', { workspaceId: 'ws-ref', year: 2026, pdf: false })
    expect(got.files).toEqual(['Ledger 2026.csv'])
    expect(got.warnings).toEqual(['The Excel file could not be made on this computer.', 'The older Ledger 2026.xlsx was removed, so the folder holds one export.'])
    expect(readdirSync(tax())).toEqual(['Ledger 2026.csv'])
    expect(readFileSync(join(tax(), 'Ledger 2026.csv'), 'utf8')).toContain('A later entry')
  })

  it('leaves no file of an older export beside a new one: what this export does not make again goes, the last summary too', async () => {
    await add({})
    const first = await call<MoneyExport>('work.money.export', { workspaceId: 'ws-ref', year: 2026 })
    await keep({ key: 'summary-first1', what: 'summary', year: 2026, generation: first.generation })
    expect(readdirSync(tax()).sort()).toEqual(['Ledger 2026.csv', 'Ledger 2026.xlsx', 'Summary 2026.pdf'])
    // The year again, the CSV alone: the workbook and the summary of the older read do not stay as if they were this one's.
    const second = await call<MoneyExport>('work.money.export', { workspaceId: 'ws-ref', year: 2026, xlsx: false, pdf: false })
    expect(second.warnings).toEqual(['The older Ledger 2026.xlsx was removed, so the folder holds one export.', 'The older Summary 2026.pdf was removed, so the folder holds one export.'])
    expect(readdirSync(tax())).toEqual(['Ledger 2026.csv'])
    // A summary asked for is the window's to print and bring back: until it does, the folder holds no older one.
    const third = await call<MoneyExport>('work.money.export', { workspaceId: 'ws-ref', year: 2026, xlsx: false })
    expect(third.summary).not.toBeNull()
    expect(readdirSync(tax())).toEqual(['Ledger 2026.csv'])
  })

  it('checks the year’s folder again after the wait for the Excel file: one that came to lead out of the job takes nothing', async () => {
    await add({})
    const outside = join(b.root, 'elsewhere', 'taken')
    const convert = b.ctx.convert
    ;(b.ctx as { convert: typeof convert }).convert = async (job) => {
      const made = await convert(job)
      // While the workbook was being made, the year's folder was swapped for a link out of the job.
      rmSync(tax(), { recursive: true, force: true })
      mkdirSync(outside, { recursive: true })
      symlinkSync(outside, tax())
      return made
    }
    await expect(call('work.money.export', { workspaceId: 'ws-ref', year: 2026 })).rejects.toThrow("leads outside this job's folder")
    expect(readdirSync(outside)).toEqual([])
  })

  it('puts an export in the folder as one set: a step that fails after the first file is replaced puts the older set back', () => {
    const into = join(b.root, 'set')
    mkdirSync(into)
    for (const [name, text] of [['Ledger 2026.csv', 'old csv'], ['Ledger 2026.xlsx', 'old xlsx'], ['Summary 2026.pdf', 'old pdf']]) writeFileSync(join(into, name), text)
    const set = [
      { name: 'Ledger 2026.csv', write: (tmp: string) => writeFileSync(tmp, 'new csv', { flag: 'wx' }) },
      { name: 'Ledger 2026.xlsx', write: (tmp: string) => writeFileSync(tmp, 'new xlsx', { flag: 'wx' }) },
      { name: 'Summary 2026.pdf' }
    ]
    // The new CSV is in place, and the workbook's rename then fails.
    let placed = 0
    const rename = (from: string, to: string): void => {
      if (from.endsWith('.tmp') && ++placed === 2) throw new Error('disk full')
      renameSync(from, to)
    }
    expect(() => publishSet(into, set, { rename })).toThrow('disk full')
    expect(readdirSync(into).sort()).toEqual(['Ledger 2026.csv', 'Ledger 2026.xlsx', 'Summary 2026.pdf'])
    expect(readFileSync(join(into, 'Ledger 2026.csv'), 'utf8')).toBe('old csv')
    expect(readFileSync(join(into, 'Ledger 2026.xlsx'), 'utf8')).toBe('old xlsx')
    // Whole: every new file, and the older summary gone with nothing in its place.
    expect(publishSet(into, set)).toEqual({ replaced: ['Ledger 2026.csv', 'Ledger 2026.xlsx'], retired: ['Summary 2026.pdf'] })
    expect(readdirSync(into).sort()).toEqual(['Ledger 2026.csv', 'Ledger 2026.xlsx'])
    expect(readFileSync(join(into, 'Ledger 2026.xlsx'), 'utf8')).toBe('new xlsx')
  })

  it('binds a page’s key to its job at the first part, before anything is put together', async () => {
    await add({})
    const { generation } = await call<MoneyExport>('work.money.export', { workspaceId: 'ws-ref', year: 2026, csv: false, xlsx: false })
    const part = (workspaceId: string, n: number) => call<MoneyKept>('work.money.keep', { workspaceId, key: 'two-jobs-key', what: 'summary', year: 2026, generation, part: n, parts: 2, dataBase64: Buffer.alloc(8, n).toString('base64') })
    expect(await part('ws-ref', 0)).toEqual({ partial: true })
    await expect(part('ws-purdue', 0)).rejects.toThrow('kept for another job')
    await expect(part('ws-purdue', 1)).rejects.toThrow('kept for another job')
    expect((await part('ws-ref', 1)).receipt).toBe('Tax 2026/Summary 2026.pdf')
  })

  it('refuses a job with no ledger', async () => {
    await expect(call('work.money.export', { workspaceId: 'ws-ref', year: 2026 })).rejects.toThrow('Ref has no ledger to export yet.')
  })
})

describe('an invoice', () => {
  it('starts at 1001, then one past the highest used; his details are asked once and come back with his terms', async () => {
    expect(await call<MoneyInvoiceNext>('work.money.invoiceNext', { workspaceId: 'ws-ref' })).toEqual({ number: '1001', from: null, dueDays: 14 })
    const page = await call<MoneyInvoicePage>('work.money.invoice', { workspaceId: 'ws-ref', key: 'create-key-1', invoice: invoice({ due: '2026-12-23' }) })
    expect(page.name).toBe('Invoice 1042 Rivera Dental.pdf')
    expect(page.html).toContain('Invoice 1042')
    expect(page.html).toContain('$320.00')
    expect(await call<MoneyInvoiceNext>('work.money.invoiceNext', { workspaceId: 'ws-ref' })).toEqual({ number: '1043', from: { name: 'Unify Platforms', address: '1 Main St', pay: 'Check or ACH' }, dueDays: 30 })
    // A purchase request counts by itself.
    expect((await call<MoneyInvoiceNext>('work.money.invoiceNext', { workspaceId: 'ws-ref', kind: 'request' })).number).toBe('1001')
    // The page alone files nothing.
    expect((await view()).rows).toEqual([])
  })

  it('keeps each kind’s details and terms by itself: a purchase request never overwrites how he is paid or when an invoice is due', async () => {
    await call('work.money.invoice', { workspaceId: 'ws-ref', key: 'create-key-1', invoice: invoice({ due: '2026-12-23' }) })
    // First request: who he is carries over, how to pay does not apply.
    expect(await call<MoneyInvoiceNext>('work.money.invoiceNext', { workspaceId: 'ws-ref', kind: 'request' })).toEqual({ number: '1001', from: { name: 'Unify Platforms', address: '1 Main St', pay: '' }, dueDays: 14 })
    await call('work.money.invoice', { workspaceId: 'ws-ref', key: 'create-key-2', invoice: invoice({ kind: 'request', number: '7', due: '2026-11-26', from: { name: 'Esports', address: 'Rec Center', pay: '' } }) })
    expect(await call<MoneyInvoiceNext>('work.money.invoiceNext', { workspaceId: 'ws-ref' })).toEqual({ number: '1043', from: { name: 'Unify Platforms', address: '1 Main St', pay: 'Check or ACH' }, dueDays: 30 })
    expect(await call<MoneyInvoiceNext>('work.money.invoiceNext', { workspaceId: 'ws-ref', kind: 'request' })).toEqual({ number: '8', from: { name: 'Esports', address: 'Rec Center', pay: '' }, dueDays: 3 })
  })

  it('gives one number to one Create: a second form that holds the same number is told the next free one', async () => {
    const first = await call<MoneyInvoiceNext>('work.money.invoiceNext', { workspaceId: 'ws-ref' })
    const second = await call<MoneyInvoiceNext>('work.money.invoiceNext', { workspaceId: 'ws-ref' })
    expect([first.number, second.number]).toEqual(['1001', '1001'])
    await call('work.money.invoice', { workspaceId: 'ws-ref', key: 'create-key-a', invoice: invoice({ number: '1001' }) })
    // The other form's Create: the number is held by the first, though no row carries it yet.
    await expect(call('work.money.invoice', { workspaceId: 'ws-ref', key: 'create-key-b', invoice: invoice({ number: '1001' }) })).rejects.toThrow('Invoice 1001 is taken. The next free number is 1002.')
    // A form opened now is offered the next one, and the first Create pressed again keeps its own.
    expect((await call<MoneyInvoiceNext>('work.money.invoiceNext', { workspaceId: 'ws-ref' })).number).toBe('1002')
    await call('work.money.invoice', { workspaceId: 'ws-ref', key: 'create-key-a', invoice: invoice({ number: '1001' }) })
    await keep({ key: 'create-key-a', what: 'invoice', invoice: invoice({ number: '1001' }) })
    // Filed: the number is the ledger's, and still no other Create's; the same Create again (its answer was lost) is let through.
    await expect(call('work.money.invoice', { workspaceId: 'ws-ref', key: 'create-key-b', invoice: invoice({ number: '1001' }) })).rejects.toThrow('is taken')
    await call('work.money.invoice', { workspaceId: 'ws-ref', key: 'create-key-a', invoice: invoice({ number: '1001' }) })
    // A page nobody took a number for is not filed: not one whose number another Create holds, nor one never asked for.
    await call('work.money.invoice', { workspaceId: 'ws-ref', key: 'create-key-c', invoice: invoice({ number: '1005' }) })
    await expect(keep({ key: 'create-key-d', what: 'invoice', invoice: invoice({ number: '1005' }) })).rejects.toThrow('Invoice 1005 is not held for this Create any more. Create it again.')
    await expect(keep({ key: 'create-key-e', what: 'invoice', invoice: invoice({ number: '1009' }) })).rejects.toThrow('not held for this Create')
    // Nor a page of another number or kind than the one its key took.
    await expect(keep({ key: 'create-key-c', what: 'invoice', invoice: invoice({ number: '1006' }) })).rejects.toThrow('not held for this Create')
    expect((await view()).rows).toHaveLength(1)
  })

  it('holds a number whose row only waits as a suggestion: on a ledger others can open it is still never printed twice', async () => {
    await call('work.money.open', { workspaceId: 'ws-ref' })
    b.sheets.sheets.get(join(b.ref, 'Money', 'Ledger.tcsheet'))!.shared = true
    const got = await create(invoice({ number: '1042' }), 'create-key-a')
    expect(got.acted).toMatchObject({ ok: true, suggested: true })
    // No row in the ledger shows 1042 yet, and the first Create's claim has done its work: the number is used all the same.
    expect((await view()).rows).toEqual([])
    await expect(call('work.money.invoice', { workspaceId: 'ws-ref', key: 'create-key-b', invoice: invoice({ number: '1042' }) })).rejects.toThrow('Invoice 1042 is taken. The next free number is 1043.')
    expect((await call<MoneyInvoiceNext>('work.money.invoiceNext', { workspaceId: 'ws-ref' })).number).toBe('1043')
  })

  it('files an invoice once when its row landed and the sheet’s answer was lost, and keeps its number used', async () => {
    await call('work.money.open', { workspaceId: 'ws-ref' })
    const inv = invoice({ number: '1042' })
    await call('work.money.invoice', { workspaceId: 'ws-ref', key: 'lost-reply-1', invoice: inv })
    b.sheets.losing = (route, body) => route === '/internal/sheet/cells' && (body.sheet as { tcsheet: string }).tcsheet === join(b.ref, 'Money', 'Ledger.tcsheet')
    const got = await keep({ key: 'lost-reply-1', what: 'invoice', invoice: inv })
    expect(got.acted).toMatchObject({ ok: true, row: 2 })
    expect((await view()).rows).toMatchObject([{ what: 'Invoice 1042', receipt: 'Invoices/Invoice 1042 Rivera Dental.pdf' }])
    expect(readdirSync(join(b.ref, 'Money', 'Invoices'))).toEqual(['Invoice 1042 Rivera Dental.pdf'])
    expect((await call<MoneyInvoiceNext>('work.money.invoiceNext', { workspaceId: 'ws-ref' })).number).toBe('1043')
  })

  it('frees a number whose row the ledger refused, and lets the same Create try again', async () => {
    await call('work.money.open', { workspaceId: 'ws-ref' })
    b.sheets.type(join(b.ref, 'Money', 'Ledger.tcsheet'), 'I1', 'Paperwork')
    const inv = invoice({ number: '1042' })
    await expect(create(inv, 'refused-key-1')).rejects.toThrow('no Receipt column')
    expect(readdirSync(join(b.ref, 'Money', 'Invoices'))).toEqual([])
    b.sheets.type(join(b.ref, 'Money', 'Ledger.tcsheet'), 'I1', 'Receipt')
    expect((await create(inv, 'refused-key-1')).acted).toMatchObject({ ok: true })
  })

  it('lets the same Create settle a keep that stopped half way, however long after: its note outlives the cleanup and its number stays its own', async () => {
    await call('work.money.open', { workspaceId: 'ws-ref' })
    const inv = invoice({ number: '1042' })
    await call('work.money.invoice', { workspaceId: 'ws-ref', key: 'half-way-key', invoice: inv })
    // The sheet took the row, its answer was lost, and the sheet then did not answer the read that would have settled it.
    const real = b.sheets.internal
    let down = false
    ;(b.ctx.service as { internal: unknown }).internal = async (route: string, body: Record<string, unknown>) => {
      if (down) throw new Error('The Work service did not answer.')
      const got = await real(route, body)
      if (route === '/internal/sheet/cells' && (body.sheet as { tcsheet: string }).tcsheet === join(b.ref, 'Money', 'Ledger.tcsheet')) {
        down = true
        throw new Error('The Work service did not answer.')
      }
      return got
    }
    await expect(keep({ key: 'half-way-key', what: 'invoice', invoice: inv })).rejects.toThrow('did not answer')
    ;(b.ctx.service as { internal: unknown }).internal = real
    // Two days on: the claim on the number has run out, and the cleanup of unfinished uploads has been through.
    const later = Date.now() + 48 * 3600_000
    const { resume } = await import('./inbox')
    resume(b.ctx, later)
    expect(b.db.prepare("SELECT COUNT(*) AS n FROM work_money_inbox WHERE key = 'kept:half-way-key'").get()).toEqual({ n: 1 })
    b.db.prepare("UPDATE work_money_books SET invoice = json_set(invoice, '$.claims', json('[]')) WHERE workspace_id = 'ws-ref'").run()
    // The same Create again: the page is answered (the number is its own), and the keep finds the row it wrote.
    await call('work.money.invoice', { workspaceId: 'ws-ref', key: 'half-way-key', invoice: inv })
    const got = await keep({ key: 'half-way-key', what: 'invoice', invoice: inv })
    expect(got.acted).toMatchObject({ ok: true, row: 2 })
    expect((await view()).rows).toHaveLength(1)
    expect(readdirSync(join(b.ref, 'Money', 'Invoices'))).toEqual(['Invoice 1042 Rivera Dental.pdf'])
    // Another Create still cannot take the number.
    await expect(call('work.money.invoice', { workspaceId: 'ws-ref', key: 'other-key-99', invoice: inv })).rejects.toThrow('is taken')
  })

  it('never brings the count back down: a lower number typed by hand leaves the highest standing', async () => {
    await call('work.money.invoice', { workspaceId: 'ws-ref', key: 'create-key-a', invoice: invoice({ number: '1042' }) })
    await call('work.money.invoice', { workspaceId: 'ws-ref', key: 'create-key-b', invoice: invoice({ number: '12' }) })
    expect((await call<MoneyInvoiceNext>('work.money.invoiceNext', { workspaceId: 'ws-ref' })).number).toBe('1043')
  })

  it('holds a page’s key to its job, and files a keep that was begun and never noted only once', async () => {
    const got = await create(invoice())
    // The same key under another job neither answers this job's file nor files anything there.
    await expect(call('work.money.keep', { workspaceId: 'ws-purdue', key: 'keep-key-01', what: 'invoice', invoice: invoice(), part: 0, parts: 1, dataBase64: PDF.toString('base64') })).rejects.toThrow('kept for another job')
    expect(existsSync(join(b.purdue, 'Money'))).toBe(false)
    // The host stopped after the ledger's write and before its note: the row is there under its Ref, the note still says "begun".
    const ref = (got.acted as { ref: string }).ref
    b.db.prepare("UPDATE work_money_inbox SET state = 'partial', ref = ? WHERE key = 'kept:keep-key-01'").run(JSON.stringify({ intent: { ref, receipt: got.receipt } }))
    expect(await keep({ what: 'invoice', invoice: invoice() })).toEqual(got)
    expect((await view()).rows).toHaveLength(1)
    expect(readdirSync(join(b.ref, 'Money', 'Invoices'))).toEqual(['Invoice 1042 Rivera Dental.pdf'])
    // Begun, the file kept, and the row never written: that file is no row's and goes, and the keep starts afresh.
    b.db.prepare("INSERT INTO work_money_inbox (id, key, workspace_id, state, source, ref, created_at, updated_at) VALUES ('k2', 'kept:keep-key-09', 'ws-ref', 'partial', 'kept', ?, 1, 1)").run(JSON.stringify({ intent: { ref: 'mnone1', receipt: 'Invoices/Invoice 7 Stray.pdf' } }))
    writeFileSync(join(b.ref, 'Money', 'Invoices', 'Invoice 7 Stray.pdf'), 'left behind')
    await call('work.money.invoice', { workspaceId: 'ws-ref', key: 'keep-key-09', invoice: invoice({ number: '7', to: 'Stray' }) })
    const fresh = await keep({ key: 'keep-key-09', what: 'invoice', invoice: invoice({ number: '7', to: 'Stray' }) })
    expect(fresh.receipt).toBe('Invoices/Invoice 7 Stray.pdf')
    expect(readFileSync(join(b.ref, 'Money', 'Invoices', 'Invoice 7 Stray.pdf')).equals(PDF)).toBe(true)
    expect((await view()).rows).toHaveLength(2)
  })

  it('keeps an invoice’s file when its row is there under a Receipt header he renamed since the keep stopped', async () => {
    const got = await create(invoice())
    const ref = (got.acted as { ref: string }).ref
    b.db.prepare("UPDATE work_money_inbox SET state = 'partial', ref = ? WHERE key = 'kept:keep-key-01'").run(JSON.stringify({ intent: { ref, receipt: got.receipt } }))
    b.sheets.type(join(b.ref, 'Money', 'Ledger.tcsheet'), 'I1', 'Scan')
    expect(await keep({ what: 'invoice', invoice: invoice() })).toEqual(got)
    expect(readdirSync(join(b.ref, 'Money', 'Invoices'))).toEqual(['Invoice 1042 Rivera Dental.pdf'])
  })

  it('never files a second balance for one Create whose answer was lost: a changed retry of its key is told what was created', async () => {
    await call('work.money.open', { workspaceId: 'ws-ref' })
    const inv = invoice({ number: '1042' })
    await call('work.money.invoice', { workspaceId: 'ws-ref', key: 'lost-then-edited', invoice: inv })
    b.sheets.losing = (route, body) => route === '/internal/sheet/cells' && (body.sheet as { tcsheet: string }).tcsheet === join(b.ref, 'Money', 'Ledger.tcsheet')
    // The row landed and its answer was lost on the way to the window.
    await keep({ key: 'lost-then-edited', what: 'invoice', invoice: inv })
    // He corrects the rate and presses Create again in the same dialog: one key, so the host knows this Create.
    const edited = invoice({ number: '1042', lines: [{ what: 'Design', quantity: 2.5, rate: 13000 }] })
    await expect(call('work.money.invoice', { workspaceId: 'ws-ref', key: 'lost-then-edited', invoice: edited })).rejects.toThrow('Invoice 1042 was already created, for $320.00. It is in the ledger.')
    await expect(keep({ key: 'lost-then-edited', what: 'invoice', invoice: edited })).rejects.toThrow('already created')
    // The same Create unchanged is answered with what was kept.
    expect((await keep({ key: 'lost-then-edited', what: 'invoice', invoice: inv })).acted).toMatchObject({ ok: true, row: 2 })
    expect((await view()).rows).toHaveLength(1)
  })

  it('files one invoice for the same key sent twice at once', async () => {
    await call('work.money.invoice', { workspaceId: 'ws-ref', key: 'keep-key-01', invoice: invoice() })
    const [x, y] = await Promise.all([keep({ what: 'invoice', invoice: invoice() }), keep({ what: 'invoice', invoice: invoice() })])
    expect(x).toEqual(y)
    expect((await view()).rows).toHaveLength(1)
    expect(readdirSync(join(b.ref, 'Money', 'Invoices'))).toHaveLength(1)
  })

  it('reads the highest number from the ledger too, so a number he typed by hand counts', async () => {
    await add({ way: 'in', who: 'Old client', amount: 5000, what: 'Invoice 2001' })
    expect((await call<MoneyInvoiceNext>('work.money.invoiceNext', { workspaceId: 'ws-ref' })).number).toBe('2002')
  })

  it('keeps the printed PDF under Invoices and files its row: money in, unpaid, with the file', async () => {
    const got = await create(invoice())
    expect(got.receipt).toBe('Invoices/Invoice 1042 Rivera Dental.pdf')
    expect(got.acted).toMatchObject({ ok: true, row: 2 })
    expect(readFileSync(join(b.ref, 'Money', 'Invoices', 'Invoice 1042 Rivera Dental.pdf')).equals(PDF)).toBe(true)
    const now = await view()
    expect(now.rows).toMatchObject([{ date: '2026-11-23', who: 'Rivera Dental', what: 'Invoice 1042', category: 'Game fees', in: 32000, status: 'Unpaid', receipt: 'Invoices/Invoice 1042 Rivera Dental.pdf' }])
    expect(now.owed).toMatchObject([{ who: 'Rivera Dental', amount: 32000, way: 'toHim' }])
    // The same key again files nothing twice.
    expect(await keep({ what: 'invoice', invoice: invoice() })).toEqual(got)
    expect((await view()).rows).toHaveLength(1)
    // A file already at an invoice's name (one he put there) is never replaced: the invoice takes a name of its own.
    writeFileSync(join(b.ref, 'Money', 'Invoices', 'Invoice 1050 Rivera Dental.pdf'), 'his own')
    const twin = await create(invoice({ number: '1050' }), 'keep-key-02')
    expect(twin.receipt).toBe('Invoices/Invoice 1050 Rivera Dental (2).pdf')
    expect(readFileSync(join(b.ref, 'Money', 'Invoices', 'Invoice 1050 Rivera Dental.pdf'), 'utf8')).toBe('his own')
  })

  it('files a purchase request as money out that is not his cost', async () => {
    const got = await create(invoice({ kind: 'request', number: '12', to: 'Gear & Co', reason: 'Jerseys for spring' }), 'request-key')
    expect(got.receipt).toBe('Invoices/Purchase request 12 Gear & Co.pdf')
    const now = await view()
    expect(now.rows).toMatchObject([{ who: 'Gear & Co', what: 'Purchase request 12: Jerseys for spring', out: 32000, status: 'Requested' }])
    expect(now.sums.out).toBe(0)
    expect(now.owed).toEqual([])
  })

  it('needs to know who it is from', async () => {
    await expect(call('work.money.invoice', { workspaceId: 'ws-ref', key: 'create-key-1', invoice: invoice({ from: { name: '  ', address: '', pay: '' } }) })).rejects.toThrow()
    await expect(keep({ key: 'no-from-key1', what: 'invoice', invoice: invoice({ from: { name: '', address: '', pay: '' } }) })).rejects.toThrow()
    expect((await view()).rows).toEqual([])
  })

  it('refuses one with no amount, and one due before its date', async () => {
    await expect(call('work.money.invoice', { workspaceId: 'ws-ref', key: 'create-key-1', invoice: invoice({ lines: [{ what: 'Nothing', quantity: 0, rate: 100 }] }) })).rejects.toThrow('needs a line with an amount')
    await expect(call('work.money.invoice', { workspaceId: 'ws-ref', key: 'create-key-1', invoice: invoice({ due: '2026-11-01' }) })).rejects.toThrow('due before its date')
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
