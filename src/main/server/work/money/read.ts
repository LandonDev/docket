import { existsSync, realpathSync } from 'node:fs'
import { join, sep } from 'node:path'
import type { MoneyHits, MoneyOwed, MoneyRate, MoneyRead, MoneySums } from '@shared/contract-work-money'
import {
  byCategory,
  byMonth,
  categoriesFor,
  columnLetter,
  inPeriod,
  mileageMissing,
  mileageOf,
  milesOf,
  owedOf,
  rateFor,
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
  /** the number of the last row that holds anything, a formula with no result among them; 1 for a sheet with only its header */
  last: number
  /** the cells that wait in the sheet as suggestions, where they stand now: a new row goes under them, and a row Money already suggested is found among them */
  pending: { row: number; column: number; v: Cell }[]
}

/** The widest header Money reads: his own columns may stand among Money's. */
const HEADER_MAX = 52
const READ_CELLS = 10_000

type RangeAnswer = { cells: { at: string; v?: string | number | boolean }[][] }
const sheet = (path: string): { tcsheet: string } => ({ tcsheet: path })
const range = async (ctx: Svc, path: string, a1: string): Promise<Cell[][]> =>
  ((await ctx.service.internal('/internal/sheet/range', { sheet: sheet(path), range: a1 })) as RangeAnswer).cells.map((line) => line.map((c) => c.v))
const blank = (line: readonly Cell[]): boolean => line.every((c) => c === undefined || c === null || c === '')

/** The largest sheet Money asks for whole to find its last row: past it, the read falls back to stopping at a blank page. */
const EXTENT_MAX_BYTES = 32 * 1024 * 1024
const FRAME = 4 * 1024 * 1024

/**
 * How far a sheet's first tab holds a value or a formula, from the workbook
 * as the service holds it: the number of its last such row (1 for none past
 * the header) and how many columns across they reach. Null when the
 * workbook is too large to ask for whole.
 */
async function extentOf(ctx: Svc, path: string, rev: number): Promise<{ rows: number; columns: number } | null> {
  const chunks: Buffer[] = []
  for (let offset = 0; ; ) {
    const frame = (await ctx.service.internal('/internal/sheet/snapshot', { sheet: sheet(path), rev, offset, length: FRAME })) as { data: string; size: number }
    if (frame.size > EXTENT_MAX_BYTES) return null
    const part = Buffer.from(frame.data, 'base64')
    chunks.push(part)
    offset += part.length
    if (offset >= frame.size || part.length === 0) break
  }
  const book = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { sheetOrder?: string[]; sheets?: Record<string, { cellData?: Record<string, Record<string, { v?: unknown; f?: unknown } | null> | null> }> }
  const tab = book.sheets?.[book.sheetOrder?.[0] ?? '']
  let last = 0
  let across = 0
  for (const [row, cells] of Object.entries(tab?.cellData ?? {})) {
    if (!cells) continue
    for (const [column, c] of Object.entries(cells)) {
      if (!c || !((c.v !== undefined && c.v !== null && c.v !== '') || !!c.f)) continue
      last = Math.max(last, Number(row))
      across = Math.max(across, Number(column) + 1)
    }
  }
  return { rows: last + 1, columns: across }
}

const grids = new Map<string, Grid>()

/** A sheet as it is now. Answers from memory while its revision has not moved. */
export async function gridOf(ctx: Svc, path: string): Promise<Grid> {
  const open = (await ctx.service.internal('/internal/sheet/open', { sheet: sheet(path) })) as { rev: number; shared: boolean; suggestions?: { row: number; col: number; proposed: { v?: Cell } | null }[] }
  // What waits as a suggestion is asked afresh each time: accepting or rejecting one need not move the revision.
  const pending = (open.suggestions ?? []).map((s) => ({ row: s.row + 1, column: s.col, v: s.proposed?.v }))
  const held = grids.get(path)
  if (held && held.rev === open.rev) return { ...held, shared: open.shared === true, pending }
  // How far the sheet holds anything, down and across: a stretch of blank rows he left never ends the read early,
  // and figures under no header (a column he moved, its header cleared) are still seen.
  const extent = await extentOf(ctx, path, open.rev).catch(() => null)
  const first = (await range(ctx, path, `A1:${columnLetter(HEADER_MAX - 1)}1`))[0] ?? []
  let named = first.length
  while (named > 0 && blank([first[named - 1]])) named--
  const width = Math.min(HEADER_MAX, Math.max(named, extent?.columns ?? 0))
  const header = first.slice(0, width)
  const body: Cell[][] = []
  if (width > 0) {
    const per = Math.max(1, Math.floor(READ_CELLS / width))
    for (let start = 2; extent === null || start <= extent.rows; start += per) {
      const page = await range(ctx, path, `A${start}:${columnLetter(width - 1)}${start + per - 1}`)
      body.push(...page)
      // With the extent unknown (the sheet could not say), a whole page with nothing in it ends the read.
      if (extent === null && (page.length < per || page.every(blank))) break
    }
    while (body.length && blank(body[body.length - 1])) body.pop()
  }
  // A row that holds only a formula with no result yet reads as blank, and is a row all the same: nothing is written over it.
  const grid: Grid = { rev: open.rev, shared: open.shared === true, header, body, last: Math.max(1 + body.length, extent?.rows ?? 1), pending }
  grids.set(path, grid)
  return grid
}

/** The row under everything a sheet holds and everything that waits in it as a suggestion: where an append writes. */
export const nextRow = (grid: Grid): number => Math.max(grid.last, ...grid.pending.map((p) => p.row)) + 1

/**
 * Where a row Money wrote now stands: by its mark (a Ref, or a receipt's
 * path) in the named column, among the sheet's rows or among what waits as
 * a suggestion. Null: no such row was written.
 */
export function writtenAt(grid: Grid, column: string, mark: string): { row: number; suggested: boolean } | null {
  const at = grid.header.findIndex((h) => String(h ?? '').trim().toLowerCase() === column.toLowerCase())
  if (at < 0 || !mark) return null
  const i = grid.body.findIndex((line) => line[at] === mark)
  if (i >= 0) return { row: 2 + i, suggested: false }
  const waits = grid.pending.find((p) => p.column === at && p.v === mark)
  return waits ? { row: waits.row, suggested: true } : null
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

/** Why a mileage log cannot be read as trips; null when it can. */
export type MileageProblem = { kind: 'mileage'; reason: 'outside' | 'columns'; missing: string[] }
export const MILEAGE_OUTSIDE = "The mileage log leads outside this job's folder, so Money does not read it."

/**
 * The mileage log's trips, and why they could not be read when they could
 * not: a log that is not there has no trips and no problem; one that leads
 * out of the job's folder, or holds rows without Date or Miles, has trips
 * Money cannot say, which is not the same as none.
 */
export async function mileageLog(ctx: Svc & Pick<WorkCtx, 'db'>, books: Books): Promise<{ trips: MileageRow[]; problem: MileageProblem | null }> {
  if (!existsSync(books.mileage)) return { trips: [], problem: null }
  // A log that is a link out of the job's folder is not this job's: its miles are not read, shown or exported.
  const ws = workspaces(ctx).find((w) => w.id === books.workspaceId)
  if (!ws || !insideFolder(ws.path, books.mileage)) return { trips: [], problem: { kind: 'mileage', reason: 'outside', missing: [] } }
  const grid = await gridOf(ctx, books.mileage)
  const missing = mileageMissing(grid.header, grid.body)
  if (missing.length) return { trips: [], problem: { kind: 'mileage', reason: 'columns', missing } }
  return { trips: mileageOf(grid.header, grid.body), problem: null }
}

/** A mileage problem as a sentence. */
export const mileageWords = (p: MileageProblem): string => (p.reason === 'outside' ? MILEAGE_OUTSIDE : `The mileage log has no ${p.missing.join(' or ')} column, so its trips cannot be read.`)

export const mileageRows = async (ctx: Svc & Pick<WorkCtx, 'db'>, books: Books): Promise<MileageRow[]> => (await mileageLog(ctx, books)).trips

/** A job's books when both the row and the ledger's file are there; null otherwise (he has none yet, or deleted the file). */
export function booksHere(ctx: Pick<WorkCtx, 'db'>, workspaceId: string): Books | null {
  const books = booksOf(ctx, workspaceId)
  if (!books || !existsSync(books.ledger)) return null
  // A ledger that is a link out of the job's folder is not this job's: it is neither read nor written.
  const ws = workspaces(ctx).find((w) => w.id === workspaceId)
  return ws && insideFolder(ws.path, books.ledger) ? books : null
}

/** Whether a file that exists lies, by its real spelling, inside a folder. */
function insideFolder(folder: string, path: string): boolean {
  try {
    return realpathSync(path).startsWith(realpathSync(folder) + sep)
  } catch {
    return false
  }
}

/** The mileage rate for a year: his own when he set one, else the last we are sure of. */
export const rateOf = (books: Books | null, year: number): MoneyRate => ({ year, rate: rateFor(year, books?.rates ?? {}), own: books?.rates[year] !== undefined })

const EMPTY_SUMS = { in: 0, out: 0, net: 0, owedToHim: 0, heOwes: 0 }

/** Everything the view paints, in one read. */
export async function readMoney(ctx: Pick<WorkCtx, 'db' | 'service' | 'host'>, ws: Workspace, period: Period): Promise<MoneyRead> {
  const year = Number(period.from.slice(0, 4))
  const root = { at: 'file' as const, host: ctx.host, path: join(ws.path, 'Money') }
  const books = booksHere(ctx, ws.id)
  if (!books) {
    return { made: false, any: false, root, period, rows: [], sums: EMPTY_SUMS, byCategory: [], byMonth: byMonth([], year), owed: [], miles: { miles: 0, value: 0, rate: null }, categories: categoriesFor(ws.sector), sellers: [], toConfirm: [], calendar: [], rate: rateOf(booksOf(ctx, ws.id), year), problems: [] }
  }
  const [ledger, log] = await Promise.all([ledgerOf(ctx, books), mileageLog(ctx, books)])
  const rows = ledger.rows
  const trips = log.trips
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
    // A ledger or a log that cannot be read is not an empty job.
    any: rows.length > 0 || trips.length > 0 || ledger.missing.length > 0 || log.problem !== null,
    root,
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
    toConfirm: [],
    calendar: [],
    rate: rateOf(books, year),
    problems: [...(ledger.missing.length ? [{ kind: 'columns' as const, missing: ledger.missing, renamed: ledger.renamed }] : []), ...(log.problem ? [log.problem] : [])]
  }
}

/** The jobs a call covers, of the ones the caller may ask about: those that have a ledger. No other job's books are opened. */
function jobsFor(ctx: Pick<WorkCtx, 'db'>, jobs: readonly Workspace[]): { ws: Workspace; books: Books }[] {
  return jobs.flatMap((ws) => {
    const books = booksHere(ctx, ws.id)
    return books ? [{ ws, books }] : []
  })
}

/**
 * Each job's sums for a span of local days: the one answer for anyone who
 * shows money (the weekly review). A job whose books cannot be read whole
 * is answered with `problem` and no figures, and never keeps another job's
 * sums from being answered.
 */
export async function sumsFor(ctx: Pick<WorkCtx, 'db' | 'service'>, period: Period, jobs: readonly Workspace[]): Promise<MoneySums> {
  const rows: MoneySums['rows'] = []
  for (const { ws, books } of jobsFor(ctx, jobs)) {
    const base = { workspaceId: ws.id, sector: ws.sector, currency: 'USD' as const }
    try {
      const [ledger, log] = await Promise.all([ledgerOf(ctx, books), mileageLog(ctx, books)])
      const sums = sumsOf(ledger.rows, period)
      rows.push({ ...base, in: sums.in, out: sums.out, owedToHim: sums.owedToHim, heOwes: sums.heOwes, miles: milesOf(log.trips, period).miles, ...(ledger.missing.length || log.problem ? { problem: true as const } : {}) })
    } catch {
      rows.push({ ...base, in: 0, out: 0, owedToHim: 0, heOwes: 0, miles: 0, problem: true })
    }
  }
  return { rows }
}

/** Unpaid rows across jobs, the oldest first, how many receipts wait for his accept, and the jobs whose ledger could not be read. */
export async function owedFor(ctx: Pick<WorkCtx, 'db' | 'service'>, jobs: readonly Workspace[]): Promise<MoneyOwed> {
  const rows: MoneyOwed['rows'] = []
  const problems: string[] = []
  for (const { ws, books } of jobsFor(ctx, jobs)) {
    const ledger = await ledgerOf(ctx, books).catch(() => null)
    if (!ledger || ledger.missing.length) {
      problems.push(ws.id)
      continue
    }
    for (const o of owedOf(ledger.rows)) rows.push({ workspaceId: ws.id, sector: ws.sector, row: o.row, who: o.who, what: o.what, amount: o.amount, since: o.since, way: o.way, reimburse: o.reimburse, both: o.both })
  }
  rows.sort((a, b) => (a.since ?? '9999').localeCompare(b.since ?? '9999'))
  return { rows, toConfirm: jobs.reduce((n, ws) => n + waiting(ctx, ws.id), 0), ...(problems.length ? { problems } : {}) }
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
    // Both figures of a row with money both ways are words to find it by, and both ride on the hit.
    const text = `${r.who} ${r.what} ${r.category} ${r.date ?? ''} ${[r.in, r.out].filter(Boolean).map((c) => (c / 100).toFixed(2)).join(' ')}`.toLowerCase()
    if (!words.every((w) => text.includes(w.replace(/^\$/, '')))) continue
    hits.push({ row: r.row, date: r.date, who: r.who, amount: r.in || r.out, way: r.in ? 'in' : 'out', ...(r.in && r.out ? { other: r.out } : {}), category: r.category, ...(r.receipt ? { receipt: r.receipt } : {}) })
    if (hits.length >= limit) break
  }
  return { hits }
}
