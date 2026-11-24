import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, realpathSync } from 'node:fs'
import { join, sep } from 'node:path'
import type { EntryFields, MoneyActed } from '@shared/contract-work-money'
import {
  columnLetter,
  columnsOf,
  rowsOf,
  countOf,
  dollarsOf,
  findRow,
  LEDGER_COLUMNS,
  MILEAGE_COLUMNS,
  paidStatus,
  sheetOnly,
  today,
  type Cell,
  type Columns,
  type LedgerColumn,
  type LedgerRow,
  type RowAt
} from '@shared/work/money'
import type { WorkCtx } from '../modules'
import { forgetGrid, gridOf, ledgerOf, MoneyError, nextRow, restorePlan, writtenAt, type Ledger } from './read'
import { booksOf, putBooks, type Books, type Workspace } from './store'

/**
 * A job's books (docs/agents/work-money.md "The ledger"): two `.tcsheet`
 * files in the workspace's own `Money` folder, made on first use and
 * written through the Work service's `/internal/sheet/*`, as forms writes
 * its answers. Money appends rows and changes the cells of a row it is
 * asked to; it never reorders or deletes his cells.
 */

type Ctx = Pick<WorkCtx, 'db' | 'service' | 'log' | 'host' | 'dataDir'>

export const MONEY_FOLDER = 'Money'
/** Who a write is credited to in the sheet's history. */
const BY = 'money'
const COLUMNS_CHANGED = "The ledger's columns changed. Restore them, then try again."

const OUTSIDE = "The Money folder leads outside this job's folder, so Money writes nothing there."

/** Whether a path that exists lies, by its real spelling, inside the job's own folder: a link out of it does not. */
export function insideJob(ws: Pick<Workspace, 'path'>, path: string): boolean {
  try {
    const root = realpathSync(ws.path)
    const real = realpathSync(path)
    return real === root || real.startsWith(root + sep)
  } catch {
    return false
  }
}

/**
 * A folder under the job's `Money`, made where it is missing, one level at
 * a time, each checked by its real spelling before the next is made: a
 * `Money` (or a folder under it) that is a link out of the job's folder is
 * refused, and nothing is written through it.
 */
export function moneyFolder(ws: Pick<Workspace, 'path'>, ...sub: string[]): string {
  let dir = ws.path
  for (const part of [MONEY_FOLDER, ...sub]) {
    dir = join(dir, part)
    if (!existsSync(dir)) mkdirSync(dir)
    if (!insideJob(ws, dir)) throw new MoneyError(OUTSIDE)
  }
  return dir
}

const sheet = (path: string): { tcsheet: string } => ({ tcsheet: path })
export type A1 = { at: string; v?: string | number | boolean | null; f?: string }

/**
 * Whether others can open a sheet of Money's: the sheet's own word (a guest
 * link), or where its file lies. A job whose folder is inside a Teams or
 * OneDrive library or a cloud folder is a place others can open, by Files'
 * own rule (`sharedOf`), though the sheet's file knows nothing of it: a
 * write there waits as a suggestion, as on any shared sheet.
 */
export async function othersCanOpen(ctx: Pick<WorkCtx, 'db' | 'host' | 'dataDir'>, path: string, sheetSays: boolean): Promise<boolean> {
  if (sheetSays) return true
  if (probe) return probe(path)
  try {
    const { sharedOf } = await import('../files/policy')
    return sharedOf(ctx, { at: 'file', host: ctx.host, path })
  } catch {
    // Files' rule could not be asked (its pillar did not load): the sheet's own word stands.
    return false
  }
}
let probe: ((path: string) => boolean) | null = null
/** A test hands in its own answer for where a file lies. */
export const setSharedProbe = (p: ((path: string) => boolean) | null): void => void (probe = p)

/** One at a time for each workspace: an append reads the first empty row and writes it with nothing between. */
const tails = new Map<string, Promise<unknown>>()
export function locked<T>(workspaceId: string, fn: () => Promise<T>): Promise<T> {
  const run = (tails.get(workspaceId) ?? Promise.resolve()).then(fn, fn)
  const tail = run.catch(() => {})
  tails.set(workspaceId, tail)
  void tail.then(() => tails.get(workspaceId) === tail && tails.delete(workspaceId))
  return run
}

/** A row's own id: never one that reads as a number or a word, and long enough (96 bits) that two rows never share one. A Ref written before this was five letters, and is read all the same. */
export const newRef = (): string => `m${randomBytes(12).toString('hex')}`

export async function write(ctx: Ctx, path: string, cells: A1[], shared: boolean): Promise<{ suggested: boolean }> {
  if (!cells.length) return { suggested: false }
  // A sheet others can open takes a suggestion he accepts in the sheet, never a write.
  await ctx.service.internal('/internal/sheet/cells', { sheet: sheet(path), cells, by: BY, suggest: shared, ...(shared ? { reason: 'Money' } : {}) })
  return { suggested: shared }
}

/**
 * The look of a sheet Money makes: a bold first row that stays in view. Raw
 * sheet mutations, so it is one function behind a test (book.test.ts shows
 * it in an exported file); a sheet it cannot dress stays plain.
 */
export async function dress(ctx: Ctx, path: string, columns: number): Promise<void> {
  const { rev } = (await ctx.service.internal('/internal/sheet/open', { sheet: sheet(path) })) as { rev: number }
  // A sheet Money has just made holds these two ids (`blankWorkbook`).
  const at = { unitId: 'workbook', subUnitId: 'sheet1' }
  const bold = Object.fromEntries(Array.from({ length: columns }, (_, c) => [c, { s: { bl: 1 } }]))
  await ctx.service.internal('/internal/sheet/apply', {
    sheet: sheet(path),
    baseRev: rev,
    by: BY,
    mutations: [
      { id: 'sheet.mutation.set-range-values', params: { ...at, cellValue: { 0: bold } } },
      // Column 0, not Univer's -1 for "no column": the xlsx writer names the pane's first cell from it ("A2").
      { id: 'sheet.mutation.set-frozen', params: { ...at, startRow: 1, startColumn: 0, ySplit: 1, xSplit: 0 } }
    ]
  })
}

async function make(ctx: Ctx, path: string, title: string, headers: readonly string[]): Promise<void> {
  await ctx.service.internal('/internal/sheet/create', { title, at: sheet(path) })
  await write(
    ctx,
    path,
    headers.map((v, i) => ({ at: `${columnLetter(i)}1`, v })),
    false
  )
  await dress(ctx, path, headers.length).catch((err) => ctx.log(`money: ${title} stays plain (${String(err)})`))
}

/**
 * A job's books, made where they are missing: the `Money` folder, the
 * ledger and the mileage log. A sheet already at its place (a folder copied
 * from another machine) is taken as it is, never written over.
 */
export function openBooks(ctx: Ctx, ws: Workspace, need: 'both' | 'ledger' = 'both'): Promise<Books> {
  return locked(ws.id, async () => {
    const dir = moneyFolder(ws)
    const kept = booksOf(ctx, ws.id)
    const place = async (was: string | undefined, name: string, title: string, headers: readonly string[]): Promise<string> => {
      // A kept path is trusted only while it still lies in the job's own folder. One that is there and leads out of it
      // is refused: a fresh sheet is never made beside it, as if the job's rows had never been.
      if (was && existsSync(was)) {
        if (insideJob(ws, was)) return was
        throw new MoneyError(OUTSIDE)
      }
      const path = join(dir, name)
      if (!existsSync(path)) await make(ctx, path, title, headers)
      else if (!insideJob(ws, path)) throw new MoneyError(OUTSIDE)
      forgetGrid(path)
      return path
    }
    const ledger = await place(kept?.ledger, 'Ledger.tcsheet', 'Ledger', LEDGER_COLUMNS)
    // With `ledger` asked for alone (an entry, a receipt, an invoice, Open ledger), a mileage log that cannot be
    // opened is the log's own fault: the ledger is answered, and nothing is read or written through the log's path.
    const mileage = await place(kept?.mileage, 'Mileage.tcsheet', 'Mileage', MILEAGE_COLUMNS).catch((err) => {
      if (need === 'both') throw err
      return kept?.mileage ?? join(dir, 'Mileage.tcsheet')
    })
    if (!kept || kept.ledger !== ledger || kept.mileage !== mileage) putBooks(ctx, { workspaceId: ws.id, ledger, mileage })
    return booksOf(ctx, ws.id)!
  })
}

/** Writes the headers the ledger lacks at the end of its first row: his own columns and their order stay as they are. */
export function restoreColumns(ctx: Ctx, ws: Workspace, books: Books): Promise<{ suggested: boolean }> {
  return locked(ws.id, async () => {
    const grid = await gridOf(ctx, books.ledger)
    const have = columnsOf(grid.header, LEDGER_COLUMNS)
    const missing = LEDGER_COLUMNS.filter((c) => have[c] === undefined)
    // A column he renamed still holds his figures: an empty column of the old name beside it would read them as nothing.
    const read = rowsOf(grid.header, grid.body)
    if (read.twice?.length) throw new MoneyError(`The ledger has two ${read.twice.join(' and two ')} columns. Rename or remove one in the ledger.`)
    if (read.renamed.length) throw new MoneyError(`The ledger has no ${read.missing.join(' or ')} column, and ${read.renamed.join(', ')} may be it. Name it back in the ledger.`)
    // A sheet too large to be read whole may hold a header past what was read: nothing is written into its first row unseen.
    if (grid.partial) throw new MoneyError('The ledger is too wide to check whole. Add the missing column in the ledger yourself.')
    // Planned as the read plans it: a header that already waits past the last one (a restore's own suggestion) is not
    // suggested again, and none is put in a cell where something else already waits.
    const plan = restorePlan(grid, missing)
    if (!plan.write.length) return { suggested: plan.waits.length > 0 }
    return write(
      ctx,
      books.ledger,
      plan.write.map(({ column, name }) => ({ at: `${columnLetter(column)}1`, v: name })),
      await othersCanOpen(ctx, books.ledger, grid.shared)
    )
  })
}

type Values = Partial<Record<LedgerColumn, Cell>>

/** One cell for each column the sheet still has: a column he removed is left out, not put back. */
const cellsAt = (columns: Columns<LedgerColumn>, row: number, values: Values): A1[] =>
  (Object.entries(values) as [LedgerColumn, Cell][]).flatMap(([name, v]) => (columns[name] === undefined || v === undefined ? [] : [{ at: `${columnLetter(columns[name]!)}${row}`, v: v === '' ? null : v }]))

/** An entry's fields as the ledger's cells. */
export function valuesOf(f: EntryFields): Values {
  return {
    Date: f.date,
    Who: f.who,
    For: f.what,
    Category: f.category,
    In: f.way === 'in' ? dollarsOf(f.amount) : null,
    Out: f.way === 'out' ? dollarsOf(f.amount) : null,
    Status: f.status,
    'Paid on': f.paidOn ?? null
  }
}

/**
 * What a write needs of the sheet beside the columns it is read by. A
 * column he removed is left out of a write, not put back; but a status that
 * is not Paid must have a Status cell to stand in (an unpaid invoice read
 * with none is money in hand), and a file must have a Receipt cell to be
 * named in.
 */
function needs(ledger: Ledger, values: Values): void {
  if (ledger.missing.length) throw new MoneyError(COLUMNS_CHANGED)
  if (values.Receipt && ledger.columns.Receipt === undefined) throw new MoneyError('The ledger has no Receipt column, so this row could not name its file. Add a Receipt column in the ledger, then save again.')
  if (values.Status && values.Status !== 'Paid' && ledger.columns.Status === undefined)
    throw new MoneyError(`The ledger has no Status column, so this row could not say it is ${String(values.Status).toLowerCase()}. Add a Status column in the ledger, then save again.`)
}

/**
 * A row Money wrote before and noted (an add taken up again after a stop),
 * by the Ref it was given, else by the file it names: in the ledger, or
 * waiting in it as a suggestion. When the note names a file, the row found
 * by Ref must name that file too: a row that only shares the Ref is not
 * this add's. Both are looked for in every cell of the row, whatever its
 * headers are called now.
 */
export function writtenRow(ledger: Pick<Ledger, 'grid'>, mark: { ref?: string | null; receipt?: string | null }): { ref: string | null; row: number; suggested: boolean } | null {
  const byRef = mark.ref ? writtenAt(ledger.grid, mark.ref, mark.receipt) : null
  if (byRef) return { ref: mark.ref!, ...byRef }
  const byFile = mark.receipt ? writtenAt(ledger.grid, mark.receipt) : null
  return byFile ? { ref: null, ...byFile } : null
}

/**
 * Adds a row under the last one that holds anything and under every row
 * that waits there as a suggestion. There is no append in the service:
 * under the workspace's lock the ledger is read for its first free row and
 * the row written at once. `ref` is the Ref the row carries (an add that
 * noted it first, so it can be found after a stop). A new row is always a
 * new row: whether an add taken up again already wrote its row is asked by
 * that add, of its own note (`writtenRow`), never guessed here.
 */
export function appendRow(ctx: Ctx, ws: Workspace, books: Books, values: Values, o: { ref?: string } = {}): Promise<{ ref: string | null; row: number; suggested: boolean }> {
  return locked(ws.id, async () => {
    const ledger = await ledgerOf(ctx, books)
    needs(ledger, values)
    const shared = await othersCanOpen(ctx, books.ledger, ledger.grid.shared)
    // On a sheet others can open the row waits as a suggestion and the sheet's last row does not move: it goes under the ones that wait.
    const row = nextRow(ledger.grid)
    const ref = ledger.columns.Ref === undefined ? null : (o.ref ?? newRef())
    const { suggested } = await write(ctx, books.ledger, cellsAt(ledger.columns, row, { ...values, ...(ref ? { Ref: ref } : {}) }), shared)
    return { ref, row, suggested }
  })
}

/** What an edit changes of a row: only the cells whose reading differs, so his own formatting and words elsewhere stay. */
function changed(row: LedgerRow, f: EntryFields): Values {
  const next = valuesOf(f)
  const out: Values = {}
  if (row.date !== f.date) out.Date = next.Date
  if (row.who !== f.who) out.Who = next.Who
  if (row.what !== f.what) out.For = next.For
  if (row.category !== f.category) out.Category = next.Category
  if (row.in !== (f.way === 'in' ? f.amount : 0)) out.In = next.In
  if (row.out !== (f.way === 'out' ? f.amount : 0)) out.Out = next.Out
  if (row.status !== f.status) out.Status = next.Status
  if ((row.paidOn ?? null) !== (f.paidOn ?? null)) out['Paid on'] = next['Paid on']
  return out
}

/**
 * Changes the row the window named. The ledger is read again first: the row
 * is found by its Ref, else by its number while it still reads as the
 * window saw it. No match answers `changed` and writes nothing. A row he
 * typed is never given a Ref.
 */
function act(ctx: Ctx, ws: Workspace, books: Books, at: RowAt, values: (row: LedgerRow) => Values): Promise<MoneyActed> {
  return locked(ws.id, async () => {
    const ledger = await ledgerOf(ctx, books)
    if (ledger.missing.length) throw new MoneyError(COLUMNS_CHANGED)
    const row = findRow(ledger.rows, at)
    if (!row) return { changed: true as const }
    const next = values(row)
    needs(ledger, next)
    const cells = cellsAt(ledger.columns, row.row, next)
    // A change to these cells may already wait in the sheet as a suggestion (the same press in another window, or a
    // different edit of the row): the same change is answered and not suggested twice; a different one is his to
    // settle in the sheet first, since accepting both would keep whichever came last.
    const waits = cells.map((c) => ledger.grid.pending.find((p) => `${columnLetter(p.column)}${p.row}` === c.at))
    if (waits.some(Boolean)) {
      if (waits.every((w, i) => w !== undefined && (w.v ?? null) === (cells[i].v ?? null))) return { ok: true as const, ref: row.ref, row: row.row, suggested: true as const }
      throw new MoneyError('A change to this row already waits in the ledger. Accept or reject it there, then try again.')
    }
    const { suggested } = await write(ctx, books.ledger, cells, await othersCanOpen(ctx, books.ledger, ledger.grid.shared))
    return { ok: true as const, ref: row.ref, row: row.row, ...(suggested ? { suggested: true as const } : {}) }
  })
}

/** A row he typed with money both in and out has no one direction: the entry form cannot say it, so it is his to edit in the sheet. */
export const BOTH_WAYS = 'This row has money in and money out. Edit it in the ledger.'
/** A figure below nothing is a correction he typed: the form's amount is above nothing, so it cannot say it either. */
export const NEGATIVE = 'This row has an amount below zero. Edit it in the ledger.'
export const editRow = (ctx: Ctx, ws: Workspace, books: Books, at: RowAt, fields: EntryFields): Promise<MoneyActed> =>
  act(ctx, ws, books, at, (row) => {
    const why = sheetOnly(row)
    if (why) throw new MoneyError(why === 'both' ? BOTH_WAYS : NEGATIVE)
    return changed(row, fields)
  })

/** An open row is settled: an unpaid one is Paid, a cost waiting to be paid back is Reimbursed, on that day. A row that is not open is left as it is. */
export const payRow = (ctx: Ctx, ws: Workspace, books: Books, at: RowAt, on: string = today()): Promise<MoneyActed> =>
  act(ctx, ws, books, at, (row) => {
    // One status covers both sides of a row with money in and out: Paid on one would settle the other, which he did not press.
    if (row.in && row.out) throw new MoneyError(BOTH_WAYS)
    const c = countOf(row)
    return c.owedToHim || c.heOwes ? { Status: paidStatus(row.status), 'Paid on': on } : {}
  })

export async function addRow(ctx: Ctx, ws: Workspace, fields: EntryFields, more: Values = {}): Promise<MoneyActed> {
  const books = await openBooks(ctx, ws, 'ledger')
  const got = await appendRow(ctx, ws, books, { ...valuesOf(fields), ...more })
  return { ok: true, ref: got.ref, row: got.row, ...(got.suggested ? { suggested: true as const } : {}) }
}
