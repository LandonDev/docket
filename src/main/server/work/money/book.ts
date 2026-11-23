import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, realpathSync } from 'node:fs'
import { join, sep } from 'node:path'
import type { EntryFields, MoneyActed } from '@shared/contract-work-money'
import {
  columnLetter,
  columnsOf,
  countOf,
  dollarsOf,
  findRow,
  LEDGER_COLUMNS,
  MILEAGE_COLUMNS,
  paidStatus,
  today,
  type Cell,
  type Columns,
  type LedgerColumn,
  type LedgerRow,
  type RowAt
} from '@shared/work/money'
import type { WorkCtx } from '../modules'
import { forgetGrid, gridOf, ledgerOf, MoneyError } from './read'
import { booksOf, putBooks, type Books, type Workspace } from './store'

/**
 * A job's books (docs/agents/work-money.md "The ledger"): two `.tcsheet`
 * files in the workspace's own `Money` folder, made on first use and
 * written through the Work service's `/internal/sheet/*`, as forms writes
 * its answers. Money appends rows and changes the cells of a row it is
 * asked to; it never reorders or deletes his cells.
 */

type Ctx = Pick<WorkCtx, 'db' | 'service' | 'log'>

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

/** One at a time for each workspace: an append reads the first empty row and writes it with nothing between. */
const tails = new Map<string, Promise<unknown>>()
export function locked<T>(workspaceId: string, fn: () => Promise<T>): Promise<T> {
  const run = (tails.get(workspaceId) ?? Promise.resolve()).then(fn, fn)
  const tail = run.catch(() => {})
  tails.set(workspaceId, tail)
  void tail.then(() => tails.get(workspaceId) === tail && tails.delete(workspaceId))
  return run
}

/** A row's own id: short, and never one that reads as a number or a word. */
export const newRef = (): string => `m${randomBytes(4).toString('hex').slice(0, 5)}`

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
export function openBooks(ctx: Ctx, ws: Workspace): Promise<Books> {
  return locked(ws.id, async () => {
    const dir = moneyFolder(ws)
    const kept = booksOf(ctx, ws.id)
    const place = async (was: string | undefined, name: string, title: string, headers: readonly string[]): Promise<string> => {
      // A kept path is trusted only while it still lies in the job's own folder.
      if (was && existsSync(was) && insideJob(ws, was)) return was
      const path = join(dir, name)
      if (!existsSync(path)) await make(ctx, path, title, headers)
      else if (!insideJob(ws, path)) throw new MoneyError(OUTSIDE)
      forgetGrid(path)
      return path
    }
    const ledger = await place(kept?.ledger, 'Ledger.tcsheet', 'Ledger', LEDGER_COLUMNS)
    const mileage = await place(kept?.mileage, 'Mileage.tcsheet', 'Mileage', MILEAGE_COLUMNS)
    if (!kept || kept.ledger !== ledger || kept.mileage !== mileage) putBooks(ctx, { workspaceId: ws.id, ledger, mileage })
    return booksOf(ctx, ws.id)!
  })
}

/** Writes the headers the ledger lacks at the end of its first row: his own columns and their order stay as they are. */
export function restoreColumns(ctx: Ctx, ws: Workspace, books: Books): Promise<void> {
  return locked(ws.id, async () => {
    const grid = await gridOf(ctx, books.ledger)
    const have = columnsOf(grid.header, LEDGER_COLUMNS)
    const missing = LEDGER_COLUMNS.filter((c) => have[c] === undefined)
    await write(
      ctx,
      books.ledger,
      missing.map((v, i) => ({ at: `${columnLetter(grid.header.length + i)}1`, v })),
      grid.shared
    )
  })
}

/** Rows suggested since a sheet's revision last moved, so two suggestions never name one row. */
const suggestedAt = new Map<string, { rev: number; n: number }>()
const suggestedRows = (path: string, rev: number): number => (suggestedAt.get(path)?.rev === rev ? suggestedAt.get(path)!.n : 0)

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
 * Adds a row under the last one that holds anything. There is no append in
 * the service: under the workspace's lock the ledger is read for its first
 * empty row and the row written at once.
 */
export function appendRow(ctx: Ctx, ws: Workspace, books: Books, values: Values): Promise<{ ref: string | null; row: number; suggested: boolean }> {
  return locked(ws.id, async () => {
    const ledger = await ledgerOf(ctx, books)
    if (ledger.missing.length) throw new MoneyError(COLUMNS_CHANGED)
    // On a sheet others can open the row waits as a suggestion and the sheet's last row does not move: each one waiting takes the next row down.
    const waits = ledger.grid.shared ? suggestedRows(books.ledger, ledger.grid.rev) : 0
    const row = ledger.grid.last + 1 + waits
    const ref = ledger.columns.Ref === undefined ? null : newRef()
    const { suggested } = await write(ctx, books.ledger, cellsAt(ledger.columns, row, { ...values, ...(ref ? { Ref: ref } : {}) }), ledger.grid.shared)
    if (suggested) suggestedAt.set(books.ledger, { rev: ledger.grid.rev, n: waits + 1 })
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
    const { suggested } = await write(ctx, books.ledger, cellsAt(ledger.columns, row.row, values(row)), ledger.grid.shared)
    return { ok: true as const, ref: row.ref, row: row.row, ...(suggested ? { suggested: true as const } : {}) }
  })
}

export const editRow = (ctx: Ctx, ws: Workspace, books: Books, at: RowAt, fields: EntryFields): Promise<MoneyActed> => act(ctx, ws, books, at, (row) => changed(row, fields))

/** An open row is settled: an unpaid one is Paid, a cost waiting to be paid back is Reimbursed, on that day. A row that is not open is left as it is. */
export const payRow = (ctx: Ctx, ws: Workspace, books: Books, at: RowAt, on: string = today()): Promise<MoneyActed> =>
  act(ctx, ws, books, at, (row) => {
    const c = countOf(row)
    return c.owedToHim || c.heOwes ? { Status: paidStatus(row.status), 'Paid on': on } : {}
  })

export async function addRow(ctx: Ctx, ws: Workspace, fields: EntryFields, more: Values = {}): Promise<MoneyActed> {
  const books = await openBooks(ctx, ws)
  const got = await appendRow(ctx, ws, books, { ...valuesOf(fields), ...more })
  return { ok: true, ref: got.ref, row: got.row, ...(got.suggested ? { suggested: true as const } : {}) }
}
