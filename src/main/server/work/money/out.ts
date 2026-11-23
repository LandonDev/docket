import { createHash, randomUUID } from 'node:crypto'
import { constants, copyFileSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { z } from 'zod'
import type { InvoiceFromSchema, InvoiceSchema, KeepParamsSchema, MoneyExport, MoneyInvoiceNext, MoneyInvoicePage, MoneyKept } from '@shared/contract-work-money'
import { errorText } from '@shared/work/ids'
import { csvOf, daysBetween, fileWord, INVOICE_DUE_DAYS, invoiceHtml, invoiceTotal, nextInvoiceNumber, payCategory, taxSummaryHtml } from '@shared/work/money'
import type { WorkCtx } from '../modules'
import { appendRow, insideJob, locked, MONEY_FOLDER, moneyFolder, newRef, openBooks, writtenRow } from './book'
import { keepFile, keyed } from './inbox'
import { takePart } from './parts'
import { booksHere, ledgerOf, mileageLog, mileageWords, MoneyError } from './read'
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

/**
 * A file of Money's own making, whole or not at all: it is staged beside
 * its place under a fresh name made exclusively (never through a name that
 * is already there, so never through a link out of the folder), then
 * renamed into place, where it replaces an earlier export's.
 */
function staged(path: string, write: (tmp: string) => void): void {
  const tmp = `${path}.${randomUUID()}.tmp`
  try {
    write(tmp)
    renameSync(tmp, path)
  } catch (err) {
    rmSync(tmp, { force: true })
    throw err
  }
}
const writeWhole = (path: string, data: string | Uint8Array): void => staged(path, (tmp) => writeFileSync(tmp, data, { flag: 'wx' }))
const copyWhole = (from: string, path: string): void => staged(path, (tmp) => copyFileSync(from, tmp, constants.COPYFILE_EXCL))

/**
 * A year for tax time: the CSV, the Excel file made from it, and the
 * summary's page for the window to print. One export a job and a year at a
 * time, each from one read: a second waits for the first, so the folder
 * never holds a CSV of one read beside a workbook of another.
 */
export function exportYear(ctx: Ctx, ws: Workspace, o: { year: number; csv: boolean; xlsx: boolean; pdf: boolean }, signal?: AbortSignal): Promise<MoneyExport> {
  return keyed(`export:${ws.id}:${o.year}`, () => exportOnce(ctx, ws, o, signal))
}

async function exportOnce(ctx: Ctx, ws: Workspace, o: { year: number; csv: boolean; xlsx: boolean; pdf: boolean }, signal?: AbortSignal): Promise<MoneyExport> {
  const books = booksHere(ctx, ws.id)
  if (!books) throw new MoneyError(`${ws.name} has no ledger to export yet.`)
  const [ledger, log] = await Promise.all([ledgerOf(ctx, books), mileageLog(ctx, books)])
  if (ledger.missing.length) throw new MoneyError("The ledger's columns changed. Restore them, then export.")
  // A year with trips Money cannot read is not exported as a year with none.
  if (log.problem) throw new MoneyError(`${mileageWords(log.problem)} Put it right, then export.`)
  const trips = log.trips
  const dir = taxFolder(ws, o.year)
  const xlsxName = `Ledger ${o.year}.xlsx`
  // What this export will write over: only the files it was asked for and that are there already.
  let replaced = false
  const files: string[] = []
  const warnings: string[] = []
  const text = csvOf(ledger.rows, trips, o.year)
  const csvName = `Ledger ${o.year}.csv`
  if (o.csv) {
    replaced ||= existsSync(join(dir, csvName))
    writeWhole(join(dir, csvName), text)
    files.push(csvName)
  }
  if (o.xlsx) {
    // The Excel file is made by the conversion runner from this read's own CSV, kept in this host's data folder: never
    // from the one in the year's folder, which another hand could change before the runner copies it.
    const scratch = join(ctx.dataDir, 'work-money', 'export', randomUUID())
    try {
      mkdirSync(scratch, { recursive: true, mode: 0o700 })
      const input = join(scratch, csvName)
      writeFileSync(input, text)
      const made = await ctx.convert({ from: 'csv', to: 'xlsx', input, signal })
      const there = existsSync(join(dir, xlsxName))
      copyWhole(made.output, join(dir, xlsxName))
      replaced ||= there
      files.push(xlsxName)
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
  /** the highest number he used, of each kind */
  last?: Partial<Record<Invoice['kind'], string>>
  /** numbers taken by a Create that has not filed its row yet, each by that Create's key: no other Create may print one */
  claims?: Claim[]
}
interface Claim {
  kind: Invoice['kind']
  number: string
  key: string
  at: number
}
/** How long a number is held for a Create that never came back with its printed page. */
const CLAIM_MS = 60 * 60_000
/** A number as it is compared: its digits ("INV-1042" and "1042" are one number), else its words in lower case. */
const numberKey = (n: string): string => n.replace(/\D/g, '').replace(/^0+/, '') || n.trim().toLowerCase()
function keptOf(ctx: Pick<WorkCtx, 'db'>, workspaceId: string): Kept {
  const raw = (booksOf(ctx, workspaceId)?.invoice ?? {}) as Kept & { from?: unknown; dueDays?: unknown }
  // Books written before each kind kept its own: what was there was an invoice's.
  const from = raw.from && typeof (raw.from as From).name === 'string' ? { invoice: raw.from as From } : ((raw.from as Kept['from']) ?? {})
  const dueDays = typeof raw.dueDays === 'number' ? { invoice: raw.dueDays } : ((raw.dueDays as Kept['dueDays']) ?? {})
  return { from, dueDays, last: raw.last ?? {}, claims: Array.isArray(raw.claims) ? raw.claims : [] }
}

/** The numbers of a kind this job has used: in the ledger's rows (the For column, else the kept file's name). */
async function usedNumbers(ctx: Ctx, ws: Workspace, kind: Invoice['kind']): Promise<string[]> {
  const books = booksHere(ctx, ws.id)
  if (!books) return []
  const named = new RegExp(`^${TITLE[kind]} (\\S+?):?(?: |$)`)
  const ledger = await ledgerOf(ctx, books).catch(() => null)
  return (ledger?.rows ?? []).flatMap((row) => {
    const n = named.exec(row.what)?.[1] ?? named.exec(row.receipt.split('/').pop() ?? '')?.[1]
    return n ? [n] : []
  })
}

const TITLE: Record<Invoice['kind'], string> = { invoice: 'Invoice', request: 'Purchase request' }
/** "Invoice 1042 Rivera Dental.pdf": the file's name, from the number and the first line of who it goes to. */
export const invoiceFile = (inv: Pick<Invoice, 'kind' | 'number' | 'to'>): string => `${[TITLE[inv.kind], fileWord(inv.number, 20), fileWord(inv.to.split('\n')[0], 40)].filter(Boolean).join(' ')}.pdf`

/** The next free number: one past the highest this job has used, in the ledger or in the books; 1001 for the first. */
export async function invoiceNext(ctx: Ctx, ws: Workspace, kind: Invoice['kind'], now = Date.now()): Promise<MoneyInvoiceNext> {
  const kept = keptOf(ctx, ws.id)
  // Used: the highest he gave, every number in the ledger, and every number a Create still holds.
  const used: string[] = [...(kept.last?.[kind] ? [kept.last[kind]!] : []), ...(await usedNumbers(ctx, ws, kind)), ...(kept.claims ?? []).filter((c) => c.kind === kind && now - c.at < CLAIM_MS).map((c) => c.number)]
  // His own details for this kind; else who he is from the other kind, with how to pay left for him to give.
  const other = kept.from?.[kind === 'invoice' ? 'request' : 'invoice']
  const from = kept.from?.[kind] ?? (other ? { name: other.name, address: other.address, pay: '' } : null)
  return { number: String(nextInvoiceNumber(used)), from, dueDays: kept.dueDays?.[kind] ?? INVOICE_DUE_DAYS }
}

/** The higher of two numbers as he wrote them: by their digits. */
const higher = (a: string | undefined, b: string): string => (a !== undefined && (Number(numberKey(a)) || 0) > (Number(numberKey(b)) || 0) ? a : b)

/**
 * Checks an invoice, takes its number for this Create, remembers his
 * details and terms for the next one, and answers its page. Nothing is
 * filed until the printed page comes back. The number is taken under the
 * job's lock: one that a row already carries, or that another Create holds,
 * is refused with the next free one, so two forms opened together never
 * print the same number. The same Create again (its `key`) keeps its own.
 */
export async function invoicePage(ctx: Ctx, ws: Workspace, key: string, inv: Invoice, now = Date.now()): Promise<MoneyInvoicePage> {
  if (invoiceTotal(inv.lines) <= 0) throw new MoneyError(`${TITLE[inv.kind] === 'Invoice' ? 'An invoice' : 'A purchase request'} needs a line with an amount.`)
  if (inv.due && inv.due < inv.date) throw new MoneyError('It is due before its date.')
  if (!inv.from.name.trim()) throw new MoneyError('Say who it is from.')
  await openBooks(ctx, ws)
  // The same Create again after its row was filed (its answer was lost on the way): the number in the ledger is its own.
  const mine = ctx.db.prepare("SELECT state FROM work_money_inbox WHERE key = ? AND source = 'kept' AND workspace_id = ?").get(`kept:${key}`, ws.id) as { state: string } | undefined
  if (mine?.state === 'filed') return { name: invoiceFile(inv), html: invoiceHtml(inv) }
  await locked(ws.id, async () => {
    const kept = keptOf(ctx, ws.id)
    const claims = (kept.claims ?? []).filter((c) => now - c.at < CLAIM_MS)
    const mine = numberKey(inv.number)
    const taken = [...(await usedNumbers(ctx, ws, inv.kind)), ...claims.filter((c) => c.kind === inv.kind && c.key !== key).map((c) => c.number)]
    if (taken.some((n) => numberKey(n) === mine)) {
      const free = nextInvoiceNumber([...taken, ...(kept.last?.[inv.kind] ? [kept.last[inv.kind]!] : [])])
      throw new MoneyError(`${TITLE[inv.kind]} ${inv.number} is taken. The next free number is ${free}.`)
    }
    setInvoice(ctx, ws.id, {
      from: { ...kept.from, [inv.kind]: inv.from },
      dueDays: { ...kept.dueDays, ...(inv.due ? { [inv.kind]: daysBetween(inv.date, inv.due) } : {}) },
      // The highest stands: a lower number typed by hand never brings the count back down.
      last: { ...kept.last, [inv.kind]: higher(kept.last?.[inv.kind], inv.number) },
      // This Create's one claim: a number it held before, under the same key, is let go.
      claims: [...claims.filter((c) => c.key !== key), { kind: inv.kind, number: inv.number, key, at: now }]
    } satisfies Kept)
  })
  return { name: invoiceFile(inv), html: invoiceHtml(inv) }
}

/** Where a page's parts wait: by the job and the sender's key, so a key sent under another job never finishes this one's upload. */
const keeping = (ctx: Pick<WorkCtx, 'dataDir'>, workspaceId: string, key: string): string => join(ctx.dataDir, 'work-money', 'keeping', createHash('sha256').update(`${workspaceId}\n${key}`).digest('hex').slice(0, 32))

/**
 * A printed page comes back from the window, in parts. A summary is kept in
 * the year's folder. An invoice is kept under `Money/Invoices/` with a name
 * of its own and filed as its row: money in, unpaid (a request: money out,
 * Requested, which is not his cost). The sender's key makes a repeat answer
 * the first. One call a key at a time: two parts that land together, or
 * the last part sent twice, put the page together and file it once.
 */
export function keep(ctx: Ctx, ws: Workspace, p: KeepParams): Promise<MoneyKept> {
  return keyed(`keep:${p.key}`, () => keepOnce(ctx, ws, p))
}

/** What a keep in hand means to write, noted before the ledger is touched (as an accept's is): the Ref of the invoice's row and the file it kept. */
interface KeepIntent {
  ref: string
  receipt?: string
}
type KeptRow = { id: string; workspace_id: string; state: string; ref: string | null }

async function keepOnce(ctx: Ctx, ws: Workspace, p: KeepParams): Promise<MoneyKept> {
  const noted = ctx.db.prepare("SELECT id, workspace_id, state, ref FROM work_money_inbox WHERE key = ? AND source = 'kept'").get(`kept:${p.key}`) as KeptRow | undefined
  // A key is one page of one job: under another job it neither answers this one's file nor is filed there.
  if (noted && noted.workspace_id !== ws.id) throw new MoneyError('That page was kept for another job.')
  if (noted?.state === 'filed' && noted.ref) return JSON.parse(noted.ref) as MoneyKept
  if (p.what === 'summary' && p.year === undefined) throw new MoneyError('A summary names its year.')
  if (p.what === 'invoice' && !p.invoice) throw new MoneyError('An invoice comes with its fields.')
  const dir = keeping(ctx, ws.id, p.key)
  const whole = await takePart(dir, 'page.pdf', p)
  if (!whole) return { partial: true }
  const done = (kept: MoneyKept): MoneyKept => {
    const now = Date.now()
    ctx.db
      .prepare("INSERT INTO work_money_inbox (id, key, workspace_id, state, source, ref, created_at, updated_at) VALUES (?, ?, ?, 'filed', 'kept', ?, ?, ?) ON CONFLICT(key) DO UPDATE SET state = 'filed', ref = excluded.ref, updated_at = excluded.updated_at")
      .run(randomUUID(), `kept:${p.key}`, ws.id, JSON.stringify(kept), now, now)
    return kept
  }
  try {
    if (p.what === 'summary') {
      const folder = taxFolder(ws, p.year!)
      const name = `Summary ${p.year}.pdf`
      const there = existsSync(join(folder, name))
      copyWhole(whole, join(folder, name))
      return done({ source: { at: 'file', host: ctx.host, path: join(folder, name) }, receipt: `Tax ${p.year}/${name}`, ...(there ? { replaced: true as const } : {}) })
    }
    const inv = p.invoice!
    const total = invoiceTotal(inv.lines)
    if (total <= 0) throw new MoneyError('An invoice needs a line with an amount.')
    // The number is this Create's own: one another Create took since the page was asked for is not filed a second time.
    const other = (keptOf(ctx, ws.id).claims ?? []).find((c) => c.kind === inv.kind && c.key !== p.key && numberKey(c.number) === numberKey(inv.number) && Date.now() - c.at < CLAIM_MS)
    if (other) throw new MoneyError(`${TITLE[inv.kind]} ${inv.number} is taken. Create it again for the next free number.`)
    const books = await openBooks(ctx, ws)
    const fileOf = (receipt: string): string => join(ws.path, MONEY_FOLDER, ...receipt.split('/'))
    const filed = (receipt: string, at: { ref: string | null; row: number; suggested: boolean }): MoneyKept =>
      done({ source: { at: 'file', host: ctx.host, path: fileOf(receipt) }, receipt, acted: { ok: true, ref: at.ref, row: at.row, ...(at.suggested ? { suggested: true as const } : {}) } })
    // A keep of this page was begun and not seen to its end (the host stopped between the ledger's write and this
    // note): its row is looked for by its Ref, else by its file, and is never written twice.
    let begun: KeepIntent | null = null
    try {
      begun = noted?.ref ? ((JSON.parse(noted.ref) as { intent?: KeepIntent }).intent ?? null) : null
    } catch {
      begun = null
    }
    if (begun) {
      const found = writtenRow(await ledgerOf(ctx, books), begun)
      if (found && begun.receipt) return filed(begun.receipt, found)
      // Its row was never written: the file that keep left is no row's, and goes.
      if (begun.receipt && existsSync(fileOf(begun.receipt)) && insideJob(ws, fileOf(begun.receipt))) rmSync(fileOf(begun.receipt), { force: true })
    }
    const ref = newRef()
    const note = (receipt?: string): void => {
      const now = Date.now()
      ctx.db
        .prepare("INSERT INTO work_money_inbox (id, key, workspace_id, state, source, ref, created_at, updated_at) VALUES (?, ?, ?, 'partial', 'kept', ?, ?, ?) ON CONFLICT(key) DO UPDATE SET ref = excluded.ref, updated_at = excluded.updated_at")
        .run(randomUUID(), `kept:${p.key}`, ws.id, JSON.stringify({ intent: { ref, ...(receipt ? { receipt } : {}) } } satisfies { intent: KeepIntent }), now, now)
    }
    note()
    let file: { path: string; receipt: string } | null = null
    try {
      file = await keepFile(ws, whole, ['Invoices'], invoiceFile(inv))
      note(file.receipt)
      const got = await appendRow(
        ctx,
        ws,
        books,
        inv.kind === 'invoice'
          ? { Date: inv.date, Who: inv.to.split('\n')[0], For: `Invoice ${inv.number}`, Category: payCategory(ws.sector), In: total / 100, Status: 'Unpaid', Receipt: file.receipt }
          : { Date: inv.date, Who: inv.to.split('\n')[0], For: `Purchase request ${inv.number}${inv.reason ? `: ${inv.reason.split('\n')[0].slice(0, 200)}` : ''}`, Out: total / 100, Status: 'Requested', Receipt: file.receipt },
        { ref }
      )
      // Filed: the number is the ledger's now, and the claim has done its work.
      const kept = keptOf(ctx, ws.id)
      setInvoice(ctx, ws.id, { ...kept, claims: (kept.claims ?? []).filter((c) => c.key !== p.key) } satisfies Kept)
      return filed(file.receipt, got)
    } catch (err) {
      // No row, no kept file, no note: the same Create may be pressed again.
      if (file) rmSync(file.path, { force: true })
      ctx.db.prepare("DELETE FROM work_money_inbox WHERE key = ? AND source = 'kept' AND state = 'partial'").run(`kept:${p.key}`)
      throw err
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
