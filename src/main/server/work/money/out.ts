import { randomUUID } from 'node:crypto'
import { constants, copyFileSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { z } from 'zod'
import type { InvoiceFromSchema, InvoiceSchema, KeepParamsSchema, MoneyExport, MoneyInvoiceNext, MoneyInvoicePage, MoneyKept } from '@shared/contract-work-money'
import { errorText } from '@shared/work/ids'
import { csvOf, daysBetween, fileWord, formatMoney, INVOICE_DUE_DAYS, invoiceHtml, invoiceTotal, nextInvoiceNumber, payCategory, staleSummary, taxSummaryHtml } from '@shared/work/money'
import type { WorkCtx } from '../modules'
import { appendRow, insideJob, locked, MONEY_FOLDER, moneyFolder, newRef, openBooks, writtenRow } from './book'
import { keepFile, keyed } from './inbox'
import { pageFolder, takePart } from './parts'
import { booksHere, LEDGER_OUTSIDE, ledgerOf, ledgerOutside, mileageLog, mileageWords, MoneyError } from './read'
import { booksOf, nextExport, setInvoice, type Workspace } from './store'

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
  if (ledgerOutside(ctx, ws.id)) throw new MoneyError(LEDGER_OUTSIDE)
  const books = booksHere(ctx, ws.id)
  if (!books) throw new MoneyError(`${ws.name} has no ledger to export yet.`)
  const [ledger, log] = await Promise.all([ledgerOf(ctx, books), mileageLog(ctx, books)])
  if (ledger.missing.length) throw new MoneyError("The ledger's columns changed. Restore them, then export.")
  // A year with trips Money cannot read is not exported as a year with none.
  if (log.problem) throw new MoneyError(`${mileageWords(log.problem)} Put it right, then export.`)
  const trips = log.trips
  const dir = taxFolder(ws, o.year)
  // This export's place among the year's: its summary comes back later, printed by the window, and is kept only
  // while no newer export has been made since.
  const generation = nextExport(ctx, ws.id, o.year)
  const xlsxName = `Ledger ${o.year}.xlsx`
  // What this export will write over: only the files it was asked for and that are there already.
  let replaced = false
  const files: string[] = []
  const warnings: string[] = []
  const text = csvOf(ledger.rows, trips, o.year)
  const csvName = `Ledger ${o.year}.csv`
  // Everything asked for is made first, in this host's own data folder, and only then put in the year's folder, one
  // file after the other with nothing between: the folder never holds this read's CSV beside an older read's workbook.
  const scratch = join(ctx.dataDir, 'work-money', 'export', randomUUID())
  try {
    let workbook: string | null = null
    if (o.xlsx) {
      try {
        // The Excel file is made by the conversion runner from this read's own CSV: never from the one in the year's
        // folder, which another hand could change before the runner copies it.
        mkdirSync(scratch, { recursive: true, mode: 0o700 })
        const input = join(scratch, csvName)
        writeFileSync(input, text)
        const made = await ctx.convert({ from: 'csv', to: 'xlsx', input, signal })
        workbook = made.output
        warnings.push(...made.warnings)
      } catch (err) {
        ctx.log(`money: no Excel file for ${o.year} (${errorText(err)})`)
      }
    }
    // The folder is checked again now, after the wait for the conversion: one that came to lead out of the job
    // meanwhile takes nothing.
    const into = taxFolder(ws, o.year)
    /** An older export's file that this export does not make again would stand beside its figures as if it were theirs: it goes, and he is told. */
    const retire = (name: string): void => {
      if (!existsSync(join(into, name))) return
      rmSync(join(into, name), { force: true })
      warnings.push(`The older ${name} was removed, so the folder holds one export.`)
    }
    if (o.csv) {
      replaced ||= existsSync(join(into, csvName))
      writeWhole(join(into, csvName), text)
      files.push(csvName)
    } else retire(csvName)
    if (o.xlsx && workbook) {
      replaced ||= existsSync(join(into, xlsxName))
      copyWhole(workbook, join(into, xlsxName))
      files.push(xlsxName)
    } else {
      if (o.xlsx) warnings.push('The Excel file could not be made on this computer.')
      retire(xlsxName)
    }
    // The summary is printed by the window and kept later, by this export's generation: until then, and when no
    // summary was asked for, the older one is not this export's.
    retire(`Summary ${o.year}.pdf`)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
  return {
    folder: { at: 'file', host: ctx.host, path: dir },
    files,
    summary: o.pdf ? { name: `Summary ${o.year}.pdf`, html: taxSummaryHtml(ledger.rows, trips, { year: o.year, job: ws.name }) } : null,
    warnings,
    replaced,
    generation
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
  /** every number Money filed, in the ledger or waiting there as a suggestion: a number is never printed twice, whatever the sheet shows yet */
  used?: { kind: Invoice['kind']; number: string }[]
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
  return { from, dueDays, last: raw.last ?? {}, claims: Array.isArray(raw.claims) ? raw.claims : [], used: Array.isArray(raw.used) ? raw.used : [] }
}

/**
 * The numbers of a kind this job has used: every one Money filed (kept in
 * the books, so a row that only waits as a suggestion counts), and every
 * one the ledger's rows show (the For column, else the kept file's name:
 * a number he typed by hand).
 */
async function usedNumbers(ctx: Ctx, ws: Workspace, kind: Invoice['kind']): Promise<string[]> {
  const filed = (keptOf(ctx, ws.id).used ?? []).filter((u) => u.kind === kind).map((u) => u.number)
  const books = booksHere(ctx, ws.id)
  if (!books) return filed
  const named = new RegExp(`^${TITLE[kind]} (\\S+?):?(?: |$)`)
  const ledger = await ledgerOf(ctx, books).catch(() => null)
  const shown = (ledger?.rows ?? []).flatMap((row) => {
    const n = named.exec(row.what)?.[1] ?? named.exec(row.receipt.split('/').pop() ?? '')?.[1]
    return n ? [n] : []
  })
  // A row that only waits in the sheet as a suggestion names its number too.
  const waiting = (ledger?.grid.pending ?? []).flatMap((p) => {
    const n = typeof p.v === 'string' ? (named.exec(p.v)?.[1] ?? named.exec(p.v.split('/').pop() ?? '')?.[1]) : undefined
    return n ? [n] : []
  })
  return [...filed, ...shown, ...waiting]
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
  await openBooks(ctx, ws, 'ledger')
  // The same Create again after its row was filed (its answer was lost on the way): the number in the ledger is its own.
  const mine = ctx.db.prepare("SELECT state, fields FROM work_money_inbox WHERE key = ? AND source = 'kept' AND workspace_id = ?").get(`kept:${key}`, ws.id) as Pick<KeptRow, 'state' | 'fields'> | undefined
  if (mine?.state === 'filed') samePage(mine, inv)
  if (mine?.state === 'filed') return { name: invoiceFile(inv), html: invoiceHtml(inv) }
  await locked(ws.id, async () => {
    const kept = keptOf(ctx, ws.id)
    const claims = (kept.claims ?? []).filter((c) => now - c.at < CLAIM_MS)
    const mine = numberKey(inv.number)
    // This Create holds this very number already (the same press again, or its keep was begun and stopped half way):
    // the number is its own, whatever the books have noted of it since.
    // A keep of this key that was begun and not settled (its note stands) holds the number too, however long ago the
    // page was asked for: the same Create must be able to come back and settle it.
    const own = claims.some((c) => c.key === key && c.kind === inv.kind && numberKey(c.number) === mine) || unsettled(ctx, ws.id, key)
    const taken = own ? [] : [...(await usedNumbers(ctx, ws, inv.kind)), ...claims.filter((c) => c.kind === inv.kind && c.key !== key).map((c) => c.number)]
    if (taken.some((n) => numberKey(n) === mine)) {
      const free = nextInvoiceNumber([...taken, ...(kept.last?.[inv.kind] ? [kept.last[inv.kind]!] : [])])
      throw new MoneyError(`${TITLE[inv.kind]} ${inv.number} is taken. The next free number is ${free}.`)
    }
    setInvoice(ctx, ws.id, {
      ...kept,
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
const keeping = (ctx: Pick<WorkCtx, 'dataDir'>, workspaceId: string, key: string): string => pageFolder(ctx.dataDir, workspaceId, key)

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

/** Whether a keep of this key in this job was begun and not settled: its note (the row's Ref, the file) still stands. */
const unsettled = (ctx: Pick<WorkCtx, 'db'>, workspaceId: string, key: string): boolean =>
  !!ctx.db.prepare("SELECT 1 FROM work_money_inbox WHERE key = ? AND source = 'kept' AND workspace_id = ? AND state = 'partial' AND ref IS NOT NULL").get(`kept:${key}`, workspaceId)

/** What a keep in hand means to write, noted before the ledger is touched (as an accept's is): the Ref of the invoice's row and the file it kept. */
interface KeepIntent {
  ref: string
  receipt?: string
}
type KeptRow = { id: string; workspace_id: string; state: string; ref: string | null; fields: string | null }

/**
 * A Create whose row is in the ledger (filed, or begun and its row found)
 * is that invoice's alone: the same press again is answered, and
 * one with other lines, another rate or another number is told what was
 * created, never filed as a second balance for the same work.
 */
function samePage(row: Pick<KeptRow, 'fields'>, inv: Invoice): void {
  if (!row.fields) return
  const was = JSON.parse(row.fields) as Invoice
  if (JSON.stringify(was) === JSON.stringify(inv)) return
  throw new MoneyError(`${TITLE[was.kind]} ${was.number} was already created, for ${formatMoney(invoiceTotal(was.lines))}. It is in the ledger.`)
}

async function keepOnce(ctx: Ctx, ws: Workspace, p: KeepParams): Promise<MoneyKept> {
  const noted = ctx.db.prepare("SELECT id, workspace_id, state, ref, fields FROM work_money_inbox WHERE key = ? AND source = 'kept'").get(`kept:${p.key}`) as KeptRow | undefined
  // A key is one page of one job: under another job it neither answers this one's file nor is filed there.
  if (noted && noted.workspace_id !== ws.id) throw new MoneyError('That page was kept for another job.')
  if (noted?.state === 'filed' && p.what === 'invoice' && p.invoice) samePage(noted, p.invoice)
  if (noted?.state === 'filed' && noted.ref) return JSON.parse(noted.ref) as MoneyKept
  if (p.what === 'summary' && p.year === undefined) throw new MoneyError('A summary names its year.')
  if (p.what === 'invoice' && !p.invoice) throw new MoneyError('An invoice comes with its fields.')
  // The key is this job's from its first part on, before anything is put together: the same key under another job is refused at once.
  if (!noted) {
    const now = Date.now()
    ctx.db.prepare("INSERT INTO work_money_inbox (id, key, workspace_id, state, source, created_at, updated_at) VALUES (?, ?, ?, 'partial', 'kept', ?, ?)").run(randomUUID(), `kept:${p.key}`, ws.id, now, now)
  }
  const dir = keeping(ctx, ws.id, p.key)
  const whole = await takePart(dir, 'page.pdf', p)
  if (!whole) return { partial: true }
  const done = (kept: MoneyKept): MoneyKept => {
    ctx.db.prepare("UPDATE work_money_inbox SET state = 'filed', ref = ?, updated_at = ? WHERE key = ? AND source = 'kept'").run(JSON.stringify(kept), Date.now(), `kept:${p.key}`)
    return kept
  }
  try {
    if (p.what === 'summary') {
      const year = p.year!
      // Under the year's own lock, with its exports: a summary printed from an older export than the year's newest is
      // not kept over the newer one's files, however late its window sent it.
      return await keyed(`export:${ws.id}:${year}`, async () => {
        // The page must be of the year's newest export, by the generation that export answered: an older one's, one
        // that names none or another, or one for a year never exported is not kept in the year's folder.
        const newest = booksOf(ctx, ws.id)?.exports[year]
        if (newest === undefined || p.generation !== newest) throw new MoneyError(staleSummary(year))
        const folder = taxFolder(ws, year)
        const name = `Summary ${year}.pdf`
        const there = existsSync(join(folder, name))
        copyWhole(whole, join(folder, name))
        return done({ source: { at: 'file', host: ctx.host, path: join(folder, name) }, receipt: `Tax ${year}/${name}`, ...(there ? { replaced: true as const } : {}) })
      })
    }
    const inv = p.invoice!
    const total = invoiceTotal(inv.lines)
    if (total <= 0) throw new MoneyError('An invoice needs a line with an amount.')
    const books = await openBooks(ctx, ws, 'ledger')
    const fileOf = (receipt: string): string => join(ws.path, MONEY_FOLDER, ...receipt.split('/'))
    /** The number is used for good, noted BEFORE the ledger is touched: a stop after the sheet took the row never leaves the number free for another Create. */
    const use = (): void => {
      const kept = keptOf(ctx, ws.id)
      if (!(kept.used ?? []).some((u) => u.kind === inv.kind && numberKey(u.number) === numberKey(inv.number))) setInvoice(ctx, ws.id, { ...kept, used: [...(kept.used ?? []), { kind: inv.kind, number: inv.number }].slice(-5000) } satisfies Kept)
    }
    /** The row was never written (the ledger refused it): the number is free again. */
    const unuse = (): void => {
      const kept = keptOf(ctx, ws.id)
      setInvoice(ctx, ws.id, { ...kept, used: (kept.used ?? []).filter((u) => !(u.kind === inv.kind && numberKey(u.number) === numberKey(inv.number))) } satisfies Kept)
    }
    /** Filed (also while its row only waits as a suggestion): the claim has done its work. */
    const filed = (receipt: string, at: { ref: string | null; row: number; suggested: boolean }): MoneyKept => {
      use()
      const kept = keptOf(ctx, ws.id)
      setInvoice(ctx, ws.id, { ...kept, claims: (kept.claims ?? []).filter((c) => c.key !== p.key) } satisfies Kept)
      return done({ source: { at: 'file', host: ctx.host, path: fileOf(receipt) }, receipt, acted: { ok: true, ref: at.ref, row: at.row, ...(at.suggested ? { suggested: true as const } : {}) } })
    }
    // A keep of this page was begun and not seen to its end (the host stopped between the ledger's write and this
    // note): its row is looked for by its Ref and its file, and is never written twice.
    let begun: KeepIntent | null = null
    try {
      begun = noted?.ref ? ((JSON.parse(noted.ref) as { intent?: KeepIntent }).intent ?? null) : null
    } catch {
      begun = null
    }
    if (begun) {
      const found = writtenRow(await ledgerOf(ctx, books), begun)
      if (found && begun.receipt) {
        samePage(noted!, inv)
        return filed(begun.receipt, found)
      }
      // Its row was never written: the file that keep left is no row's, and goes.
      if (begun.receipt && existsSync(fileOf(begun.receipt)) && insideJob(ws, fileOf(begun.receipt))) rmSync(fileOf(begun.receipt), { force: true })
    }
    // The page is this Create's own: its key took this number of this kind when the page was asked for
    // (`invoicePage`), and still holds it. A page nobody took a number for is not filed.
    const held = begun !== null || (keptOf(ctx, ws.id).claims ?? []).some((c) => c.key === p.key && c.kind === inv.kind && numberKey(c.number) === numberKey(inv.number) && Date.now() - c.at < CLAIM_MS)
    if (!held) throw new MoneyError(`${TITLE[inv.kind]} ${inv.number} is not held for this Create any more. Create it again.`)
    const ref = newRef()
    // The invoice itself is noted with its intent: a later press of this key is answered only for the same invoice.
    const note = (receipt?: string): void =>
      void ctx.db
        .prepare("UPDATE work_money_inbox SET ref = ?, fields = ?, updated_at = ? WHERE key = ? AND source = 'kept'")
        .run(JSON.stringify({ intent: { ref, ...(receipt ? { receipt } : {}) } } satisfies { intent: KeepIntent }), JSON.stringify(inv), Date.now(), `kept:${p.key}`)
    use()
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
      return filed(file.receipt, got)
    } catch (err) {
      // The write may have landed though its answer did not: a fresh read settles it, as for a receipt. Landed: filed.
      // Not readable now: the file, the note and the number stay for the next keep to settle. Not there: no row, no
      // kept file, no note, the number free again; the same Create may be pressed again, and the key stays this job's.
      const landed = await ledgerOf(ctx, books).then(
        (l) => writtenRow(l, { ref, receipt: file?.receipt }),
        () => undefined
      )
      if (landed && file) return filed(file.receipt, landed)
      if (landed === undefined) throw err
      if (file) rmSync(file.path, { force: true })
      unuse()
      ctx.db.prepare("UPDATE work_money_inbox SET ref = NULL, fields = NULL WHERE key = ? AND source = 'kept' AND state = 'partial'").run(`kept:${p.key}`)
      throw err
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
