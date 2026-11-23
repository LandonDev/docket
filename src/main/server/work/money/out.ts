import { createHash, randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { z } from 'zod'
import type { InvoiceFromSchema, InvoiceSchema, KeepParamsSchema, MoneyActed, MoneyExport, MoneyInvoiceNext, MoneyInvoicePage, MoneyKept } from '@shared/contract-work-money'
import { errorText } from '@shared/work/ids'
import { csvOf, daysBetween, fileWord, INVOICE_DUE_DAYS, invoiceHtml, invoiceTotal, nextInvoiceNumber, payCategory, taxSummaryHtml } from '@shared/work/money'
import type { WorkCtx } from '../modules'
import { appendRow, moneyFolder, openBooks } from './book'
import { keepFile } from './inbox'
import { takePart } from './parts'
import { booksHere, ledgerOf, mileageRows, MoneyError } from './read'
import { booksOf, setInvoice, type Workspace } from './store'

/**
 * What leaves Money (docs/agents/work-money.md "Out"): a year's folder for
 * tax time, and an invoice or a purchase request as a PDF with its row.
 * The host writes the CSV and has the Excel file made from it; a page that
 * must be printed (the summary, an invoice) is answered as HTML, printed by
 * the formats pillar from the window, and handed back in parts to be kept.
 * Nothing here sends anything: an invoice leaves from Mail's composer, by
 * his own Send.
 */

type Ctx = Pick<WorkCtx, 'db' | 'dataDir' | 'host' | 'service' | 'log' | 'convert' | 'push' | 'reaches'>
type Invoice = z.infer<typeof InvoiceSchema>
type From = z.infer<typeof InvoiceFromSchema>
type KeepParams = z.infer<typeof KeepParamsSchema>

/** The year's folder, made where it is missing and held inside the job's own folder. */
const taxFolder = (ws: Workspace, year: number): string => moneyFolder(ws, `Tax ${year}`)

/** Writes a file of Money's own making whole or not at all: a second export replaces the first's. */
function writeWhole(path: string, data: string | Uint8Array): void {
  const tmp = `${path}.${randomUUID().slice(0, 8)}.tmp`
  writeFileSync(tmp, data)
  renameSync(tmp, path)
}

/** A year for tax time: the CSV, the Excel file made from it, and the summary's page for the window to print. */
export async function exportYear(ctx: Ctx, ws: Workspace, o: { year: number; csv: boolean; xlsx: boolean; pdf: boolean }, signal?: AbortSignal): Promise<MoneyExport> {
  const books = booksHere(ctx, ws.id)
  if (!books) throw new MoneyError(`${ws.name} has no ledger to export yet.`)
  const [ledger, trips] = await Promise.all([ledgerOf(ctx, books), mileageRows(ctx, books)])
  if (ledger.missing.length) throw new MoneyError("The ledger's columns changed. Restore them, then export.")
  const dir = taxFolder(ws, o.year)
  const replaced = [`Ledger ${o.year}.csv`, `Ledger ${o.year}.xlsx`, `Summary ${o.year}.pdf`].some((name) => existsSync(join(dir, name)))
  const files: string[] = []
  const warnings: string[] = []
  const text = csvOf(ledger.rows, trips, o.year)
  const csvName = `Ledger ${o.year}.csv`
  if (o.csv) {
    writeWhole(join(dir, csvName), text)
    files.push(csvName)
  }
  if (o.xlsx) {
    // The Excel file is made from the CSV by the conversion runner; with no CSV asked for, from one in this host's own data folder.
    const scratch = join(ctx.dataDir, 'work-money', 'export', randomUUID())
    try {
      let input = join(dir, csvName)
      if (!o.csv) {
        mkdirSync(scratch, { recursive: true, mode: 0o700 })
        input = join(scratch, csvName)
        writeFileSync(input, text)
      }
      const made = await ctx.convert({ from: 'csv', to: 'xlsx', input, signal })
      const name = `Ledger ${o.year}.xlsx`
      copyFileSync(made.output, join(dir, `${name}.tmp`))
      renameSync(join(dir, `${name}.tmp`), join(dir, name))
      files.push(name)
      warnings.push(...made.warnings)
    } catch (err) {
      ctx.log(`money: no Excel file for ${o.year} (${errorText(err)})`)
      warnings.push('The Excel file could not be made on this computer.')
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  }
  return {
    folder: { at: 'file', host: ctx.host, path: dir },
    files,
    summary: o.pdf ? { name: `Summary ${o.year}.pdf`, html: taxSummaryHtml(ledger.rows, trips, { year: o.year, job: ws.name }) } : null,
    warnings,
    replaced
  }
}

/**
 * What the books remember of invoices, each kind by itself: a purchase
 * request has no "how to pay" and its own dates, and neither may overwrite
 * what he last gave an invoice.
 */
interface Kept {
  from?: Partial<Record<Invoice['kind'], From>>
  dueDays?: Partial<Record<Invoice['kind'], number>>
  last?: Partial<Record<Invoice['kind'], string>>
}
function keptOf(ctx: Pick<WorkCtx, 'db'>, workspaceId: string): Kept {
  const raw = (booksOf(ctx, workspaceId)?.invoice ?? {}) as Kept & { from?: unknown; dueDays?: unknown }
  // Books written before each kind kept its own: what was there was an invoice's.
  const from = raw.from && typeof (raw.from as From).name === 'string' ? { invoice: raw.from as From } : ((raw.from as Kept['from']) ?? {})
  const dueDays = typeof raw.dueDays === 'number' ? { invoice: raw.dueDays } : ((raw.dueDays as Kept['dueDays']) ?? {})
  return { from, dueDays, last: raw.last ?? {} }
}

const TITLE: Record<Invoice['kind'], string> = { invoice: 'Invoice', request: 'Purchase request' }
/** "Invoice 1042 Rivera Dental.pdf": the file's name, from the number and the first line of who it goes to. */
export const invoiceFile = (inv: Pick<Invoice, 'kind' | 'number' | 'to'>): string => `${[TITLE[inv.kind], fileWord(inv.number, 20), fileWord(inv.to.split('\n')[0], 40)].filter(Boolean).join(' ')}.pdf`

/** The next free number: one past the highest this job has used, in the ledger or in the books; 1001 for the first. */
export async function invoiceNext(ctx: Ctx, ws: Workspace, kind: Invoice['kind']): Promise<MoneyInvoiceNext> {
  const kept = keptOf(ctx, ws.id)
  const used: string[] = kept.last?.[kind] ? [kept.last[kind]!] : []
  const books = booksHere(ctx, ws.id)
  if (books) {
    const named = new RegExp(`^${TITLE[kind]} (\\d+)`)
    const ledger = await ledgerOf(ctx, books).catch(() => null)
    for (const row of ledger?.rows ?? []) {
      const n = named.exec(row.what)?.[1] ?? named.exec(row.receipt.split('/').pop() ?? '')?.[1]
      if (n) used.push(n)
    }
  }
  // His own details for this kind; else who he is from the other kind, with how to pay left for him to give.
  const other = kept.from?.[kind === 'invoice' ? 'request' : 'invoice']
  const from = kept.from?.[kind] ?? (other ? { name: other.name, address: other.address, pay: '' } : null)
  return { number: String(nextInvoiceNumber(used)), from, dueDays: kept.dueDays?.[kind] ?? INVOICE_DUE_DAYS }
}

/** Checks an invoice, remembers his details and terms for the next one, and answers its page. Nothing is filed until the printed page comes back. */
export async function invoicePage(ctx: Ctx, ws: Workspace, inv: Invoice): Promise<MoneyInvoicePage> {
  if (invoiceTotal(inv.lines) <= 0) throw new MoneyError(`${TITLE[inv.kind] === 'Invoice' ? 'An invoice' : 'A purchase request'} needs a line with an amount.`)
  if (inv.due && inv.due < inv.date) throw new MoneyError('It is due before its date.')
  await openBooks(ctx, ws)
  const kept = keptOf(ctx, ws.id)
  setInvoice(ctx, ws.id, {
    from: { ...kept.from, [inv.kind]: inv.from },
    dueDays: { ...kept.dueDays, ...(inv.due ? { [inv.kind]: daysBetween(inv.date, inv.due) } : {}) },
    last: { ...kept.last, [inv.kind]: inv.number }
  } satisfies Kept)
  return { name: invoiceFile(inv), html: invoiceHtml(inv) }
}

const keeping = (ctx: Pick<WorkCtx, 'dataDir'>, key: string): string => join(ctx.dataDir, 'work-money', 'keeping', createHash('sha256').update(key).digest('hex').slice(0, 32))

/**
 * A printed page comes back from the window, in parts. A summary is kept in
 * the year's folder. An invoice is kept under `Money/Invoices/` with a name
 * of its own and filed as its row: money in, unpaid (a request: money out,
 * Requested, which is not his cost). The sender's key makes a repeat answer
 * the first.
 */
export function keep(ctx: Ctx, ws: Workspace, p: KeepParams): Promise<MoneyKept> {
  // One filing a key at a time: the same part sent twice while the first is being filed answers the first.
  const claim = `${p.key}:${p.part}`
  const running = inFlight.get(claim)
  if (running) return running
  const run = keepOnce(ctx, ws, p).finally(() => inFlight.delete(claim))
  inFlight.set(claim, run)
  return run
}
const inFlight = new Map<string, Promise<MoneyKept>>()

async function keepOnce(ctx: Ctx, ws: Workspace, p: KeepParams): Promise<MoneyKept> {
  const done = ctx.db.prepare("SELECT ref FROM work_money_inbox WHERE key = ? AND source = 'kept'").get(`kept:${p.key}`) as { ref: string } | undefined
  if (done) return JSON.parse(done.ref) as MoneyKept
  if (p.what === 'summary' && p.year === undefined) throw new MoneyError('A summary names its year.')
  if (p.what === 'invoice' && !p.invoice) throw new MoneyError('An invoice comes with its fields.')
  const dir = keeping(ctx, p.key)
  const whole = await takePart(dir, 'page.pdf', p)
  if (!whole) return { partial: true }
  let kept: MoneyKept
  try {
    if (p.what === 'summary') {
      const folder = taxFolder(ws, p.year!)
      const name = `Summary ${p.year}.pdf`
      copyFileSync(whole, join(folder, `${name}.tmp`))
      renameSync(join(folder, `${name}.tmp`), join(folder, name))
      kept = { source: { at: 'file', host: ctx.host, path: join(folder, name) }, receipt: `Tax ${p.year}/${name}` }
    } else {
      const inv = p.invoice!
      const total = invoiceTotal(inv.lines)
      if (total <= 0) throw new MoneyError('An invoice needs a line with an amount.')
      const books = await openBooks(ctx, ws)
      const file = await keepFile(ws, whole, ['Invoices'], invoiceFile(inv))
      let got: Awaited<ReturnType<typeof appendRow>>
      try {
        got = await appendRow(
          ctx,
          ws,
          books,
          inv.kind === 'invoice'
            ? { Date: inv.date, Who: inv.to.split('\n')[0], For: `Invoice ${inv.number}`, Category: payCategory(ws.sector), In: total / 100, Status: 'Unpaid', Receipt: file.receipt }
            : { Date: inv.date, Who: inv.to.split('\n')[0], For: `Purchase request ${inv.number}${inv.reason ? `: ${inv.reason.split('\n')[0].slice(0, 200)}` : ''}`, Out: total / 100, Status: 'Requested', Receipt: file.receipt }
        )
      } catch (err) {
        rmSync(file.path, { force: true })
        throw err
      }
      const acted: MoneyActed = { ok: true, ref: got.ref, row: got.row, ...(got.suggested ? { suggested: true as const } : {}) }
      kept = { source: { at: 'file', host: ctx.host, path: file.path }, receipt: file.receipt, acted }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  const now = Date.now()
  ctx.db
    .prepare("INSERT OR REPLACE INTO work_money_inbox (id, key, workspace_id, state, source, ref, created_at, updated_at) VALUES (?, ?, ?, 'filed', 'kept', ?, ?, ?)")
    .run(randomUUID(), `kept:${p.key}`, ws.id, JSON.stringify(kept), now, now)
  return kept
}
