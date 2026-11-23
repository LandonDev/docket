import { existsSync } from 'node:fs'
import type { MoneyHits, MoneyOwed, MoneyRead, MoneySums } from '@shared/contract-work-money'
import {
  byCategory,
  byMonth,
  categoriesFor,
  columnLetter,
  inPeriod,
  mileageOf,
  milesOf,
  owedOf,
  rowsOf,
  sumsOf,
  type Cell,
  type LedgerRead,
  type MileageRow,
  type Period
} from '@shared/work/money'
import type { WorkCtx } from '../modules'
import { booksOf, workspaces, type Books, type Workspace } from './store'

/**
 * Reading a job's sheets (docs/agents/work-money.md "Reading"). The ledger
 * and the mileage log are `.tcsheet` files the Work service holds; Money
 * asks it over `/internal/sheet/*`, as forms does, and never opens the
 * file itself. A sheet is read again only when its revision moved.
 */

type Svc = Pick<WorkCtx, 'service'>

/** Words for the person: every error Money throws by name reads as a sentence on a screen. */
export class MoneyError extends Error {}

/** A sheet's first tab as cells: row 1, then the rows under it down to the last that holds anything. */
export interface Grid {
  rev: number
  /** others can open the sheet: a write waits as a suggestion */
  shared: boolean
  header: Cell[]
  body: Cell[][]
  /** the number of the last row that holds anything; 1 for a sheet with only its header */
  last: number
}

/** The widest header Money reads: his own columns may stand among Money's. */
const HEADER_MAX = 52
const READ_CELLS = 10_000

type RangeAnswer = { cells: { at: string; v?: string | number | boolean }[][] }
const sheet = (path: string): { tcsheet: string } => ({ tcsheet: path })
const range = async (ctx: Svc, path: string, a1: string): Promise<Cell[][]> =>
  ((await ctx.service.internal('/internal/sheet/range', { sheet: sheet(path), range: a1 })) as RangeAnswer).cells.map((line) => line.map((c) => c.v))
const blank = (line: readonly Cell[]): boolean => line.every((c) => c === undefined || c === null || c === '')

const grids = new Map<string, Grid>()

/** A sheet as it is now. Answers from memory while its revision has not moved. */
export async function gridOf(ctx: Svc, path: string): Promise<Grid> {
  const open = (await ctx.service.internal('/internal/sheet/open', { sheet: sheet(path) })) as { rev: number; shared: boolean }
  const held = grids.get(path)
  if (held && held.rev === open.rev) return held.shared === open.shared ? held : { ...held, shared: open.shared }
  const first = (await range(ctx, path, `A1:${columnLetter(HEADER_MAX - 1)}1`))[0] ?? []
  let width = first.length
  while (width > 0 && blank([first[width - 1]])) width--
  const header = first.slice(0, width)
  const body: Cell[][] = []
  if (width > 0) {
    const per = Math.max(1, Math.floor(READ_CELLS / width))
    for (let start = 2; ; start += per) {
      const page = await range(ctx, path, `A${start}:${columnLetter(width - 1)}${start + per - 1}`)
      body.push(...page)
      // A whole page with nothing in it: the sheet's rows have ended.
      if (page.length < per || page.every(blank)) break
    }
    while (body.length && blank(body[body.length - 1])) body.pop()
  }
  const grid: Grid = { rev: open.rev, shared: open.shared === true, header, body, last: 1 + body.length }
  grids.set(path, grid)
  return grid
}

/** Forgets a sheet's cells, for a file that moved or went. */
export const forgetGrid = (path: string): void => void grids.delete(path)

export interface Ledger extends LedgerRead {
  grid: Grid
}

export async function ledgerOf(ctx: Svc, books: Books): Promise<Ledger> {
  const grid = await gridOf(ctx, books.ledger)
  return { grid, ...rowsOf(grid.header, grid.body) }
}

export async function mileageRows(ctx: Svc, books: Books): Promise<MileageRow[]> {
  if (!existsSync(books.mileage)) return []
  const grid = await gridOf(ctx, books.mileage)
  return mileageOf(grid.header, grid.body)
}

/** A job's books when both the row and the ledger's file are there; null otherwise (he has none yet, or deleted the file). */
export function booksHere(ctx: Pick<WorkCtx, 'db'>, workspaceId: string): Books | null {
  const books = booksOf(ctx, workspaceId)
  return books && existsSync(books.ledger) ? books : null
}

const EMPTY_SUMS = { in: 0, out: 0, net: 0, owedToHim: 0, heOwes: 0 }

/** Everything the view paints, in one read. */
export async function readMoney(ctx: Pick<WorkCtx, 'db' | 'service'>, ws: Workspace, period: Period): Promise<MoneyRead> {
  const year = Number(period.from.slice(0, 4))
  const books = booksHere(ctx, ws.id)
  if (!books) {
    return { made: false, period, rows: [], sums: EMPTY_SUMS, byCategory: [], byMonth: byMonth([], year), owed: [], miles: { miles: 0, value: 0, rate: null }, categories: categoriesFor(ws.sector), sellers: [], problems: [] }
  }
  const [ledger, trips] = await Promise.all([ledgerOf(ctx, books), mileageRows(ctx, books)])
  const rows = ledger.rows
  const sellers: string[] = []
  const seen = new Set<string>()
  for (let i = rows.length - 1; i >= 0 && sellers.length < 200; i--) {
    const who = rows[i].who
    if (!who || seen.has(who.toLowerCase())) continue
    seen.add(who.toLowerCase())
    sellers.push(who)
  }
  return {
    made: true,
    period,
    rows: rows.filter((r) => inPeriod(r.date, period)).sort((a, b) => (b.date ?? '').localeCompare(a.date ?? '') || b.row - a.row),
    sums: sumsOf(rows, period),
    byCategory: byCategory(rows, period),
    byMonth: byMonth(rows, year),
    owed: owedOf(rows),
    miles: milesOf(trips, period),
    categories: categoriesFor(
      ws.sector,
      rows.map((r) => r.category)
    ),
    sellers,
    problems: ledger.missing.length ? [{ kind: 'columns', missing: ledger.missing }] : []
  }
}

/** The jobs a call covers: the one named, or every job on this host that has a ledger. */
function jobsFor(ctx: Pick<WorkCtx, 'db'>, workspaceId?: string): { ws: Workspace; books: Books }[] {
  return workspaces(ctx)
    .filter((ws) => !workspaceId || ws.id === workspaceId)
    .flatMap((ws) => {
      const books = booksHere(ctx, ws.id)
      return books ? [{ ws, books }] : []
    })
}

/** Each job's sums for a span of local days: the one answer for anyone who shows money (the weekly review). */
export async function sumsFor(ctx: Pick<WorkCtx, 'db' | 'service'>, period: Period, workspaceId?: string): Promise<MoneySums> {
  const rows: MoneySums['rows'] = []
  for (const { ws, books } of jobsFor(ctx, workspaceId)) {
    const [ledger, trips] = await Promise.all([ledgerOf(ctx, books), mileageRows(ctx, books)])
    const sums = sumsOf(ledger.rows, period)
    rows.push({ workspaceId: ws.id, sector: ws.sector, in: sums.in, out: sums.out, owedToHim: sums.owedToHim, heOwes: sums.heOwes, miles: milesOf(trips, period).miles, currency: 'USD' })
  }
  return { rows }
}

/** Unpaid rows across jobs, the oldest first, and how many receipts wait for his accept. */
export async function owedFor(ctx: Pick<WorkCtx, 'db' | 'service'>, workspaceId?: string): Promise<MoneyOwed> {
  const rows: MoneyOwed['rows'] = []
  for (const { ws, books } of jobsFor(ctx, workspaceId)) {
    const ledger = await ledgerOf(ctx, books)
    for (const o of owedOf(ledger.rows)) rows.push({ workspaceId: ws.id, sector: ws.sector, row: o.row, who: o.who, amount: o.amount, since: o.since, way: o.way })
  }
  rows.sort((a, b) => (a.since ?? '9999').localeCompare(b.since ?? '9999'))
  return { rows, toConfirm: waiting(ctx, workspaceId) }
}

/** How many receipts wait for his accept, in one job or in all. */
export function waiting(ctx: Pick<WorkCtx, 'db'>, workspaceId?: string): number {
  const where = workspaceId ? ' AND workspace_id = ?' : ''
  const row = ctx.db.prepare(`SELECT COUNT(*) AS n FROM work_money_inbox WHERE state IN ('reading', 'ready')${where}`).get(...(workspaceId ? [workspaceId] : [])) as { n: number }
  return row.n
}

/** The ledger's rows that hold every word asked for, in who, what for, the category or the amount; the newest first. */
export async function searchMoney(ctx: Pick<WorkCtx, 'db' | 'service'>, ws: Workspace, query: string, limit = 20): Promise<MoneyHits> {
  const books = booksHere(ctx, ws.id)
  if (!books) return { hits: [] }
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  const ledger = await ledgerOf(ctx, books)
  const hits: MoneyHits['hits'] = []
  for (const r of [...ledger.rows].sort((a, b) => (b.date ?? '').localeCompare(a.date ?? '') || b.row - a.row)) {
    const amount = r.in || r.out
    const text = `${r.who} ${r.what} ${r.category} ${r.date ?? ''} ${(amount / 100).toFixed(2)}`.toLowerCase()
    if (!words.every((w) => text.includes(w.replace(/^\$/, '')))) continue
    hits.push({ row: r.row, date: r.date, who: r.who, amount, way: r.in ? 'in' : 'out', category: r.category, ...(r.receipt ? { receipt: r.receipt } : {}) })
    if (hits.length >= limit) break
  }
  return { hits }
}
