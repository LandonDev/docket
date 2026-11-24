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
  mileageTwice,
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
import { booksOf, putBooks, workspaces, type Books, type Workspace } from './store'

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
  /** the cells that wait in the first tab as suggestions, where they stand now: a new row goes under them, and a row Money already suggested is found among them; `open`: he can still accept it (not one the sheet marked as in conflict or without its cell) */
  pending: { row: number; column: number; v: Cell; open: boolean }[]
  /** the sheet is wider than Money reads (past 1,024 columns): cells may stand past what was read, so nothing is repaired on this reading */
  partial: boolean
  /** the first tab's own id in the workbook */
  tab: string
}

/** The header Money reads when the sheet cannot say how wide it is; a sheet that can is read to its last column that holds anything, however far. */
const HEADER_MAX = 52
/** The widest sheet Money reads whole: one with a cell farther out than this is read to here and marked `partial`. */
const WIDTH_MAX = 1024
const READ_CELLS = 10_000

type RangeAnswer = { cells: { at: string; v?: string | number | boolean }[][] }
const sheet = (path: string): { tcsheet: string } => ({ tcsheet: path })
const range = async (ctx: Svc, path: string, a1: string): Promise<Cell[][]> =>
  ((await ctx.service.internal('/internal/sheet/range', { sheet: sheet(path), range: a1 })) as RangeAnswer).cells.map((line) => line.map((c) => c.v))
const blank = (line: readonly Cell[]): boolean => line.every((c) => c === undefined || c === null || c === '')

/** The largest sheet Money asks for whole to find its last row: one past it is not read. */
const EXTENT_MAX_BYTES = 32 * 1024 * 1024
const FRAME = 4 * 1024 * 1024

/** The sheet's own answer for how far it holds anything was too large to ask for (a workbook past 32 MB): Money reads no such ledger, since it could not know its last row. */
const TOO_LARGE = 'The sheet is too large for Money to read (over 32 MB).'

/**
 * How far a sheet's first tab holds a value or a formula, from the workbook
 * as the service holds it: the number of its last such row (1 for none past
 * the header), how many columns across they reach, and the tab's own id.
 */
async function extentOf(ctx: Svc, path: string, rev: number): Promise<{ rows: number; columns: number; tab: string }> {
  const chunks: Buffer[] = []
  for (let offset = 0; ; ) {
    const frame = (await ctx.service.internal('/internal/sheet/snapshot', { sheet: sheet(path), rev, offset, length: FRAME })) as { data: string; size: number }
    if (frame.size > EXTENT_MAX_BYTES) throw new MoneyError(TOO_LARGE)
    const part = Buffer.from(frame.data, 'base64')
    chunks.push(part)
    offset += part.length
    if (offset >= frame.size || part.length === 0) break
  }
  const book = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { sheetOrder?: string[]; sheets?: Record<string, { cellData?: Record<string, Record<string, { v?: unknown; f?: unknown; p?: unknown } | null> | null> }> }
  const id = book.sheetOrder?.[0] ?? ''
  const tab = book.sheets?.[id]
  let last = 0
  let across = 0
  for (const [row, cells] of Object.entries(tab?.cellData ?? {})) {
    if (!cells) continue
    for (const [column, c] of Object.entries(cells)) {
      // A cell made rich in the cell editor keeps its words in its document (`p`) alone: it holds something all the same.
      if (!c || !((c.v !== undefined && c.v !== null && c.v !== '') || !!c.f || !!c.p)) continue
      last = Math.max(last, Number(row))
      across = Math.max(across, Number(column) + 1)
    }
  }
  return { rows: last + 1, columns: across, tab: id }
}

const grids = new Map<string, Grid>()
type Opened = { rev: number; shared: boolean; suggestions?: { sheet?: string; row: number; col: number; proposed: { v?: Cell } | null; state?: string }[] }

/**
 * A sheet as it is now. Answers from memory while its revision has not
 * moved. A read is whole or it fails: how far the sheet holds anything is
 * asked of the sheet itself, and when that cannot be had (it did not answer,
 * or the sheet moved on between two asks) the read is tried again and then
 * fails, so no reading that may have stopped short is ever kept, summed,
 * exported or appended under.
 */
export async function gridOf(ctx: Svc, path: string): Promise<Grid> {
  let failed: unknown
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await readGrid(ctx, path)
    } catch (err) {
      if (err instanceof MoneyError) throw err
      failed = err
    }
  }
  throw failed
}

async function readGrid(ctx: Svc, path: string): Promise<Grid> {
  const open = (await ctx.service.internal('/internal/sheet/open', { sheet: sheet(path) })) as Opened
  const held = grids.get(path)
  // What waits as a suggestion is asked afresh each time: accepting or rejecting one need not move the revision.
  const pendingOf = (tab: string): Grid['pending'] =>
    (open.suggestions ?? []).filter((s) => !tab || !s.sheet || s.sheet === tab).map((s) => ({ row: s.row + 1, column: s.col, v: s.proposed?.v, open: (s.state ?? 'pending') === 'pending' }))
  if (held && held.rev === open.rev) return { ...held, shared: open.shared === true, pending: pendingOf(held.tab) }
  // How far the sheet holds anything, down and across: a stretch of blank rows he left never ends the read early,
  // and figures under no header (a column he moved, its header cleared) are still seen.
  const extent = await extentOf(ctx, path, open.rev)
  // Row 1 is read as far as the sheet holds anything: a column he moved past AZ is still seen, under its own header.
  const across = Math.min(WIDTH_MAX, extent.columns)
  const first = (await range(ctx, path, `A1:${columnLetter(Math.max(HEADER_MAX, across) - 1)}1`))[0] ?? []
  let named = first.length
  while (named > 0 && blank([first[named - 1]])) named--
  const width = Math.max(named, across)
  const header = first.slice(0, width)
  const body: Cell[][] = []
  if (width > 0) {
    const per = Math.max(1, Math.floor(READ_CELLS / width))
    for (let start = 2; start <= extent.rows; start += per) body.push(...(await range(ctx, path, `A${start}:${columnLetter(width - 1)}${start + per - 1}`)))
    while (body.length && blank(body[body.length - 1])) body.pop()
  }
  // The ranges read the sheet as it is now, each a moment after the last: a sort or an edit between two of them would
  // count a row twice or leave one out. The read is of one revision or it is made again.
  const after = (await ctx.service.internal('/internal/sheet/open', { sheet: sheet(path) })) as Opened
  if (after.rev !== open.rev) throw new Error('The sheet changed while it was being read.')
  // A row that holds only a formula with no result yet reads as blank, and is a row all the same: nothing is written over it.
  const grid: Grid = { rev: open.rev, shared: open.shared === true, header, body, last: Math.max(1 + body.length, extent.rows), pending: pendingOf(extent.tab), partial: extent.columns > WIDTH_MAX, tab: extent.tab }
  grids.set(path, grid)
  return grid
}

/**
 * Whether these headers already wait in the sheet's first row as
 * suggestions he can accept (a restore on a ledger others can open): each
 * by its own name. Another suggestion in row 1, or one on another tab, is
 * not that.
 */
export const headersWait = (grid: Grid, names: readonly string[]): boolean => names.length > 0 && restorePlan(grid, names).write.length === 0

/**
 * Where a restore puts the headers a sheet lacks, planned once for the read
 * and for the write: each at the end of row 1, in the first cells past the
 * headers that nothing else already waits in. A header of that name that
 * already waits there, past the last header (a restore's own suggestion,
 * not someone's change to a header that stands), is not written again.
 */
export function restorePlan(grid: Grid, names: readonly string[]): { waits: string[]; write: { column: number; name: string }[] } {
  const first = grid.header.length
  const row1 = grid.pending.filter((p) => p.row === 1)
  const waiting = (name: string): boolean => row1.some((p) => p.open && p.column >= first && String(p.v ?? '').trim().toLowerCase() === name.toLowerCase())
  const waits = names.filter(waiting)
  const taken = new Set(row1.map((p) => p.column))
  const write: { column: number; name: string }[] = []
  let column = first
  for (const name of names) {
    if (waiting(name)) continue
    while (taken.has(column)) column++
    write.push({ column, name })
    taken.add(column)
  }
  return { waits, write }
}

/** The row under everything a sheet holds and everything that waits in it as a suggestion: where an append writes. */
export const nextRow = (grid: Grid): number => Math.max(grid.last, ...grid.pending.map((p) => p.row)) + 1

/**
 * Where a row Money wrote now stands: by its mark (a Ref, or a receipt's
 * path), in any cell of the sheet's rows or among what waits as a
 * suggestion; `with`, a second mark the same row must hold too. Looked for
 * in every column, never under a header's name: a header he renamed since
 * (Receipt to Scan) must not make a row that is there read as never
 * written, or its file would be taken for no row's. Null: no such row.
 */
export function writtenAt(grid: Grid, mark: string, also?: string | null): { row: number; suggested: boolean } | null {
  if (!mark) return null
  const i = grid.body.findIndex((line) => line.includes(mark) && (!also || line.includes(also)))
  if (i >= 0) return { row: 2 + i, suggested: false }
  const waits = grid.pending.find((p) => p.v === mark && (!also || grid.pending.some((q) => q.row === p.row && q.v === also)))
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
export type MileageProblem = { kind: 'mileage'; reason: 'outside' | 'columns' | 'unreadable' | 'twice'; missing: string[] }
export const LEDGER_OUTSIDE = "The ledger leads outside this job's folder, so Money does not read it."

/** A job's ledger is on record and its file is there, but leads out of the job's folder (a link): it is neither read nor written, and the job is not an empty one. */
export function ledgerOutside(ctx: Pick<WorkCtx, 'db'>, workspaceId: string): boolean {
  const ws = workspaces(ctx).find((w) => w.id === workspaceId)
  // With no record yet, the ledger's own place is where it would be looked for.
  const ledger = booksOf(ctx, workspaceId)?.ledger ?? (ws ? join(ws.path, 'Money', 'Ledger.tcsheet') : null)
  if (!ledger || !existsSync(ledger)) return false
  return !ws || !insideFolder(ws.path, ledger)
}
export const MILEAGE_OUTSIDE = "The mileage log leads outside this job's folder, so Money does not read it."

/**
 * The mileage log's trips, and why they could not be read when they could
 * not: a log that is not there has no trips and no problem; one that leads
 * out of the job's folder, or holds rows without Date or Miles, has trips
 * Money cannot say, which is not the same as none.
 */
export async function mileageLog(ctx: Svc & Pick<WorkCtx, 'db'>, books: Pick<Books, 'workspaceId' | 'mileage'>): Promise<{ trips: MileageRow[]; problem: MileageProblem | null }> {
  if (!existsSync(books.mileage)) return { trips: [], problem: null }
  // A log that is a link out of the job's folder is not this job's: its miles are not read, shown or exported.
  const ws = workspaces(ctx).find((w) => w.id === books.workspaceId)
  if (!ws || !insideFolder(ws.path, books.mileage)) return { trips: [], problem: { kind: 'mileage', reason: 'outside', missing: [] } }
  // A log the sheet service cannot open (a damaged file) is the log's own fault: the ledger still reads.
  const grid = await gridOf(ctx, books.mileage).catch(() => null)
  if (!grid) return { trips: [], problem: { kind: 'mileage', reason: 'unreadable', missing: [] } }
  // A needed header twice: the first would be read and the trips under the second left out of every sum and export.
  const twice = mileageTwice(grid.header)
  if (twice.length) return { trips: [], problem: { kind: 'mileage', reason: 'twice', missing: twice } }
  const missing = mileageMissing(grid.header, grid.body)
  if (missing.length) return { trips: [], problem: { kind: 'mileage', reason: 'columns', missing } }
  return { trips: mileageOf(grid.header, grid.body), problem: null }
}

/** A mileage problem as a sentence. */
export const mileageWords = (p: MileageProblem): string =>
  p.reason === 'outside'
    ? MILEAGE_OUTSIDE
    : p.reason === 'unreadable'
      ? 'The mileage log could not be read.'
      : p.reason === 'twice'
        ? `The mileage log has two ${p.missing.join(' and two ')} columns, so its trips cannot be read.`
        : `The mileage log has no ${p.missing.join(' or ')} column, so its trips cannot be read.`

export const mileageRows = async (ctx: Svc & Pick<WorkCtx, 'db'>, books: Books): Promise<MileageRow[]> => (await mileageLog(ctx, books)).trips

/** A job's books when both the row and the ledger's file are there; null otherwise (he has none yet, or deleted the file). */
export function booksHere(ctx: Pick<WorkCtx, 'db'>, workspaceId: string): Books | null {
  const books = booksOf(ctx, workspaceId) ?? adopt(ctx, workspaceId)
  if (!books || !existsSync(books.ledger)) return null
  // A ledger that is a link out of the job's folder is not this job's: it is neither read nor written.
  const ws = workspaces(ctx).find((w) => w.id === workspaceId)
  return ws && insideFolder(ws.path, books.ledger) ? books : null
}

/**
 * A ledger already at its place with no record of it (a job's folder copied
 * from another machine): it is the job's ledger from the first read on,
 * never "no money yet" until something happens to open it. Only the record
 * is written; nothing is made in a folder that holds no ledger.
 */
function adopt(ctx: Pick<WorkCtx, 'db'>, workspaceId: string): Books | null {
  const ws = workspaces(ctx).find((w) => w.id === workspaceId)
  if (!ws) return null
  const ledger = join(ws.path, 'Money', 'Ledger.tcsheet')
  if (!existsSync(ledger) || !insideFolder(ws.path, ledger)) return null
  putBooks(ctx, { workspaceId, ledger, mileage: join(ws.path, 'Money', 'Mileage.tcsheet') })
  return booksOf(ctx, workspaceId)
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
  // A ledger that leads out of the job is a fault he must see, never "no money yet".
  if (ledgerOutside(ctx, ws.id)) throw new MoneyError(LEDGER_OUTSIDE)
  const books = booksHere(ctx, ws.id)
  if (!books) {
    // No ledger, and perhaps a mileage log all the same (a job's folder copied in part): its trips are this job's, or its
    // fault is said, never "no money yet".
    const kept = booksOf(ctx, ws.id)
    const log = await mileageLog(ctx, { workspaceId: ws.id, mileage: kept?.mileage ?? join(ws.path, 'Money', 'Mileage.tcsheet') })
    return { made: false, any: log.trips.length > 0 || log.problem !== null, root, period, rows: [], sums: EMPTY_SUMS, byCategory: [], byMonth: byMonth([], year), owed: [], miles: milesOf(log.trips, period), categories: categoriesFor(ws.sector), sellers: [], toConfirm: [], calendar: [], rate: rateOf(kept, year), problems: log.problem ? [log.problem] : [] }
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
    problems: [
      // Headers that wait in the sheet as a suggestion (a restore on a ledger others can open) are said, so the view asks for his accept, not for another restore.
      ...(ledger.missing.length ? [{ kind: 'columns' as const, missing: ledger.missing, renamed: ledger.renamed, ...(ledger.twice?.length ? { twice: ledger.twice } : headersWait(ledger.grid, ledger.missing) ? { waits: true as const } : {}) }] : []),
      // Money in no month and no year: the sums of every span leave it out, and he is told, never short without a word.
      ...(ledger.undated.length ? [{ kind: 'undated' as const, rows: ledger.undated }] : []),
      ...(log.problem ? [log.problem] : [])
    ]
  }
}

/** The jobs a call covers, of the ones the caller may ask about: those that have a ledger, one that leads out of its job among them (`books` null: it cannot be read, which is not the same as none). No other job's books are opened. */
function jobsFor(ctx: Pick<WorkCtx, 'db'>, jobs: readonly Workspace[]): { ws: Workspace; books: Books | null }[] {
  return jobs.flatMap((ws): { ws: Workspace; books: Books | null }[] => {
    const books = booksHere(ctx, ws.id)
    return books ? [{ ws, books }] : ledgerOutside(ctx, ws.id) ? [{ ws, books: null }] : []
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
      if (!books) throw new MoneyError(LEDGER_OUTSIDE)
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
    const ledger = books ? await ledgerOf(ctx, books).catch(() => null) : null
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
