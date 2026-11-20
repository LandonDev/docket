import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { OfficeCell } from '@shared/contract-work-office'
import type { Principal } from '@shared/work'
import { hashCells, type SheetBlock, type SheetCell, type SheetCellWrite, type SheetChange, type SheetRange, type SheetSource } from 'work-kit/sheet/source'
import { rangeName, type A1Range } from '../sheets/a1'
import type { SuggestionStore } from '../sheets/suggestions'
import type { OfficeCarrier, RangeGrid } from './carrier'

/**
 * Excel as the truth behind our grid (docs/agents/work-office.md "Excel
 * behind the grid"; architecture §9.2). Excel holds the workbook; this
 * helper keeps what it last read of each watched block with a hash, and:
 *
 *  - a write names the hash of the cells it replaces. The helper reads them
 *    again first (the safety re-read): moved on, it answers `conflict` and
 *    writes nothing;
 *  - every scripted write clears Excel's own undo, so the helper keeps its
 *    own log (`work_office_undo`): what the cells held before, and the hash
 *    they had after, so an undo never overwrites a later edit;
 *  - AppleScript reports no changes, so the safety pass is the main loop:
 *    every watched block is read again each `SAFETY_MS`. Someone else's edit
 *    arrives as a re-read block, not a mutation: a changed cell turns its
 *    waiting suggestion `conflict`; a block whose rows moved (a row inserted
 *    in Teams) orphans every suggestion on the workbook.
 *
 * One helper per host, over the carrier the host has.
 */

export const SAFETY_MS = 15_000
/** The most cells one read or write carries: one Apple Event each. */
export const EXCEL_MAX_CELLS = 50_000
/** The writes kept for undo, per workbook. */
export const UNDO_KEPT = 100

/** The suggestion store's key for a workbook (M27's `SuggestionStore`). */
export const excelStore = (book: string): string => `excel:${book}`

export function ensureExcelTables(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS work_office_undo (
    id TEXT PRIMARY KEY,
    book TEXT NOT NULL,
    sheet TEXT NOT NULL,
    address TEXT NOT NULL,
    before TEXT NOT NULL,
    after_hash TEXT NOT NULL,
    by TEXT NOT NULL,
    at INTEGER NOT NULL
  )`)
  db.exec('CREATE INDEX IF NOT EXISTS work_office_undo_book ON work_office_undo (book, at)')
}

/** What a cell holds as the hash sees it: its formula, else its value. */
export const cellOf = (v: OfficeCell, f: string): SheetCell | null => (f ? { f } : v === null || v === '' ? null : { v })
const cellsOf = (g: RangeGrid): (SheetCell | null)[][] => g.values.map((row, i) => row.map((v, j) => cellOf(v, g.formulas[i]?.[j] ?? '')))
/** The block's hash: work-kit's `hashCells`, rows first. */
export const gridHash = (g: RangeGrid): string => hashCells(cellsOf(g).flat())
/** What a cell is written back as: its formula, else its value. */
export const writable = (c: SheetCell | null): OfficeCell => (c === null ? null : c.f ? c.f : (c.v ?? null))

export interface ExcelBlock extends RangeGrid {
  sheet: string
  address: string
  hash: string
}

export type ExcelWrite = { ok: true; writeId: string; hash: string } | { conflict: true; now: ExcelBlock }

interface Watched {
  book: string
  sheet: string
  range: A1Range
  cells: (SheetCell | null)[][]
  hash: string
  listeners: Set<(c: SheetChange) => void>
}

const addressOf = (r: A1Range): string => rangeName(r)
const sizeOf = (r: A1Range): number => (r.endRow - r.startRow + 1) * (r.endColumn - r.startColumn + 1)

export class ExcelHelper {
  private readonly watched = new Map<string, Watched>()
  private readonly chains = new Map<string, Promise<unknown>>()
  private timer: ReturnType<typeof setInterval> | null = null
  private passing = false
  /** told after each write or undo this helper makes, with the workbook's key */
  readonly wrote = new Set<(book: string) => void>()

  constructor(
    private readonly carrier: OfficeCarrier,
    private readonly db: DatabaseSync,
    private readonly suggestions: SuggestionStore,
    private readonly now: () => number = Date.now
  ) {}

  async read(book: string, sheet: string, range: A1Range): Promise<ExcelBlock> {
    if (sizeOf(range) > EXCEL_MAX_CELLS) throw new Error(`${addressOf(range)} is over ${EXCEL_MAX_CELLS.toLocaleString('en-US')} cells: read it in parts.`)
    const address = addressOf(range)
    const grid = await this.carrier.readRange(book, sheet, address)
    return { ...grid, sheet, address, hash: gridHash(grid) }
  }

  /** Work on one workbook runs one piece at a time: a write, an undo, a watched block's re-read. */
  private serial<T>(book: string, fn: () => Promise<T>): Promise<T> {
    const run = (this.chains.get(book) ?? Promise.resolve()).then(fn, fn)
    this.chains.set(book, run.catch(() => undefined))
    return run
  }

  /**
   * Writes a block. With `base`, only while the cells still hash to it; without, over whatever is
   * there now (read just before). What the cells held goes to the undo log before Excel is called.
   */
  write(book: string, sheet: string, range: A1Range, grid: OfficeCell[][], o: { base?: string; by: Principal }): Promise<ExcelWrite> {
    return this.serial(book, () => this.writeNow(book, sheet, range, grid, o))
  }

  private async writeNow(book: string, sheet: string, range: A1Range, grid: OfficeCell[][], o: { base?: string; by: Principal }): Promise<ExcelWrite> {
    const now = await this.read(book, sheet, range)
    if (o.base !== undefined && o.base !== now.hash) return { conflict: true, now }
    const writeId = randomUUID()
    this.db
      .prepare('INSERT INTO work_office_undo (id, book, sheet, address, before, after_hash, by, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(writeId, book, sheet, now.address, JSON.stringify(cellsOf(now).map((row) => row.map(writable))), '', o.by, this.now())
    this.db.prepare('DELETE FROM work_office_undo WHERE book = ? AND id NOT IN (SELECT id FROM work_office_undo WHERE book = ? ORDER BY at DESC LIMIT ?)').run(book, book, UNDO_KEPT)
    const after = await this.put(book, sheet, range, grid)
    this.db.prepare('UPDATE work_office_undo SET after_hash = ? WHERE id = ?').run(after.hash, writeId)
    await this.settle(book, sheet, range, now, after)
    return { ok: true, writeId, hash: after.hash }
  }

  /**
   * Writes single cells, touching no other: one call when they fill their block, else one per cell
   * (a block written back whole would turn the cells between into what a read says of them). With
   * `check`, only while what the cells hold now, in order, passes it. Not all-or-nothing across
   * sheets or cells: a cell that changed between the check and its own write answers `conflict`
   * and stops there.
   */
  writeCells(book: string, cells: readonly { sheet: string; row: number; col: number; v: OfficeCell }[], by: Principal, check?: (held: (SheetCell | null)[]) => boolean): Promise<'ok' | 'conflict'> {
    return this.serial(book, async () => {
      const sheets = [...new Set(cells.map((c) => c.sheet))].map((sheet) => {
        const mine = cells.filter((c) => c.sheet === sheet)
        const box: A1Range = { startRow: Math.min(...mine.map((c) => c.row)), endRow: Math.max(...mine.map((c) => c.row)), startColumn: Math.min(...mine.map((c) => c.col)), endColumn: Math.max(...mine.map((c) => c.col)) }
        return { sheet, mine, box }
      })
      const blocks = new Map<string, ExcelBlock>()
      for (const s of sheets) blocks.set(s.sheet, await this.read(book, s.sheet, s.box))
      const heldAt = (sheet: string, row: number, col: number) => {
        const s = sheets.find((x) => x.sheet === sheet)!
        const b = blocks.get(sheet)!
        return cellOf(b.values[row - s.box.startRow][col - s.box.startColumn], b.formulas[row - s.box.startRow][col - s.box.startColumn])
      }
      if (check && !check(cells.map((c) => heldAt(c.sheet, c.row, c.col)))) return 'conflict'
      for (const s of sheets) {
        if (s.mine.length === sizeOf(s.box)) {
          const grid = Array.from({ length: s.box.endRow - s.box.startRow + 1 }, () => Array<OfficeCell>(s.box.endColumn - s.box.startColumn + 1).fill(null))
          for (const c of s.mine) grid[c.row - s.box.startRow][c.col - s.box.startColumn] = c.v
          if ('conflict' in (await this.writeNow(book, s.sheet, s.box, grid, { base: blocks.get(s.sheet)!.hash, by }))) return 'conflict'
          continue
        }
        for (const c of s.mine) {
          const at: A1Range = { startRow: c.row, endRow: c.row, startColumn: c.col, endColumn: c.col }
          if ('conflict' in (await this.writeNow(book, s.sheet, at, [[c.v]], { base: hashCells([heldAt(s.sheet, c.row, c.col)]), by }))) return 'conflict'
        }
      }
      return 'ok'
    })
  }

  /** Puts back what a write replaced, while the cells still hold what it wrote. */
  undo(book: string, writeId: string): Promise<{ ok: true } | { conflict: true }> {
    return this.serial(book, async () => {
      const row = this.db.prepare('SELECT sheet, address, before, after_hash FROM work_office_undo WHERE id = ? AND book = ?').get(writeId, book) as
        | { sheet: string; address: string; before: string; after_hash: string }
        | undefined
      if (!row) throw new Error('There is no such write to take back in that workbook.')
      const range = parseAddress(row.address)
      const now = await this.read(book, row.sheet, range)
      if (now.hash !== row.after_hash) return { conflict: true as const }
      const after = await this.put(book, row.sheet, range, JSON.parse(row.before) as OfficeCell[][])
      this.db.prepare('DELETE FROM work_office_undo WHERE id = ?').run(writeId)
      await this.settle(book, row.sheet, range, now, after)
      return { ok: true as const }
    })
  }

  /** The writes this host made to a workbook and can still take back, newest first. */
  writes(book: string): { writeId: string; sheet: string; address: string; by: string; at: number }[] {
    return (this.db.prepare('SELECT id, sheet, address, by, at FROM work_office_undo WHERE book = ? ORDER BY at DESC LIMIT 50').all(book) as { id: string; sheet: string; address: string; by: string; at: number }[]).map(
      ({ id, ...r }) => ({ writeId: id, ...r })
    )
  }

  private async put(book: string, sheet: string, range: A1Range, grid: OfficeCell[][]): Promise<ExcelBlock> {
    await this.carrier.writeRange(book, sheet, addressOf(range), grid)
    // Excel types what it is given (text that reads as a number): the truth is what it holds now.
    return this.read(book, sheet, range)
  }

  /**
   * Suggestions over cells our write changed no longer hold, the watched blocks it touched move to
   * what Excel holds now (their watchers hear it as ours, `by: 'tempcode'`), and `wrote` hears the
   * workbook changed, wherever the write was.
   */
  private async settle(book: string, sheet: string, range: A1Range, before: ExcelBlock, after: ExcelBlock): Promise<void> {
    const touched = new Set<string>()
    const a = cellsOf(before)
    const b = cellsOf(after)
    for (let i = 0; i < b.length; i++)
      for (let j = 0; j < b[i].length; j++) if (JSON.stringify(a[i]?.[j] ?? null) !== JSON.stringify(b[i][j])) touched.add(`${sheet}:${range.startRow + i}:${range.startColumn + j}`)
    if (touched.size) this.suggestions.conflictOn(excelStore(book), touched)
    for (const w of [...this.watched.values()]) if (w.book === book && w.sheet === sheet && overlaps(w.range, range)) await this.refresh(w, false).catch(() => undefined)
    for (const fn of this.wrote) fn(book)
  }

  /**
   * Watches a block: `onChange` hears of every change to it, someone else's on the next safety pass
   * (`by: 'excel'`), this helper's own as it writes (`by: 'tempcode'`). Returns its off; the pass stops when nothing is watched.
   */
  watch(book: string, sheet: string, range: A1Range, onChange: (c: SheetChange) => void): () => void {
    const key = `${book}\u0000${sheet}\u0000${addressOf(range)}`
    let w = this.watched.get(key)
    if (!w) {
      w = { book, sheet, range, cells: [], hash: '', listeners: new Set() }
      this.watched.set(key, w)
      const first = w
      void this.serial(book, () => this.refresh(first, false)).catch(() => undefined)
    }
    w.listeners.add(onChange)
    this.timer ??= setInterval(() => void this.pass(), SAFETY_MS)
    this.timer.unref?.()
    const mine = w
    return () => {
      mine.listeners.delete(onChange)
      if (mine.listeners.size === 0) this.watched.delete(key)
      if (this.watched.size === 0 && this.timer) {
        clearInterval(this.timer)
        this.timer = null
      }
    }
  }

  /** One safety pass over every watched block. Errors (Excel closed, the file gone) wait for the next. */
  async pass(): Promise<void> {
    if (this.passing) return
    this.passing = true
    try {
      for (const w of [...this.watched.values()]) await this.serial(w.book, () => this.refresh(w, true)).catch(() => undefined)
    } finally {
      this.passing = false
    }
  }

  /**
   * Someone changed `address` on a sheet, as our Office add-in heard it (milestone 29): the watched
   * blocks it touches are read again now rather than on the next pass. An address with no cells
   * in it (a whole row or column) reads every block on the sheet.
   */
  heard(book: string, sheet: string, address: string): Promise<void> {
    let r: A1Range | null
    try {
      r = parseAddress(address)
    } catch {
      r = null
    }
    const hit = [...this.watched.values()].filter((w) => w.book === book && w.sheet === sheet && (!r || overlaps(w.range, r)))
    return Promise.all(hit.map((w) => this.serial(book, () => this.refresh(w, true)).catch(() => undefined))).then(() => undefined)
  }

  private async refresh(w: Watched, others: boolean): Promise<void> {
    const block = await this.read(w.book, w.sheet, w.range)
    if (block.hash === w.hash) return
    const cells = cellsOf(block)
    const first = w.hash === ''
    const old = w.cells
    w.cells = cells
    w.hash = block.hash
    if (first) return
    const shifted = others && shiftOf(old, cells)
    const store = excelStore(w.book)
    if (shifted) this.suggestions.orphanAll(store)
    else if (others) {
      const touched = new Set<string>()
      cells.forEach((row, i) => row.forEach((c, j) => JSON.stringify(old[i]?.[j] ?? null) !== JSON.stringify(c) && touched.add(`${w.sheet}:${w.range.startRow + i}:${w.range.startColumn + j}`)))
      this.suggestions.conflictOn(store, touched)
    }
    const change: SheetChange = { kind: 'cells', ranges: [{ sheet: w.sheet, ...w.range }], ...(shifted ? { shifted: true } : {}), by: others ? 'excel' : 'tempcode' }
    for (const fn of w.listeners) fn(change)
  }

  /** A workbook as a `SheetSource` (work-kit/sheet/source): sheets named by their tab names, cells from zero. */
  source(book: string, by: Principal): SheetSource {
    const helper = this
    const outline = async (): Promise<SheetChange> => {
      const info = (await helper.carrier.workbooks()).find((b) => b.key === book)
      return { kind: 'outline', sheets: (info?.sheets ?? []).map((s) => ({ id: s.name, name: s.name, rowCount: Math.max(s.rows, 1), columnCount: Math.max(s.columns, 1) })) }
    }
    return {
      capabilities: { formulas: 'store', write: true, formats: false, live: false, maxReadCells: EXCEL_MAX_CELLS, maxWriteCells: EXCEL_MAX_CELLS },
      async read(r: SheetRange): Promise<SheetBlock> {
        const block = await helper.read(book, r.sheet, r)
        return { range: r, cells: cellsOf(block).map((row, i) => row.map((c, j) => ({ ...(c ?? {}), ...(c?.f && block.values[i][j] !== null ? { v: block.values[i][j] } : {}), ...(block.formats[i]?.[j] && block.formats[i][j] !== 'General' ? { z: block.formats[i][j] } : {}) }))), hash: block.hash }
      },
      async write(cells: SheetCellWrite[], baseHash: string) {
        const writes = cells.map((c) => ({ sheet: c.sheet, row: c.row, col: c.column, v: writable(c.cell?.f ? { f: c.cell.f } : c.cell?.v !== undefined && c.cell.v !== null ? { v: c.cell.v } : null) }))
        return helper.writeCells(book, writes, by, (held) => hashCells(held) === baseHash)
      },
      subscribe(onChange) {
        let live = true
        const offs: (() => void)[] = []
        void outline().then((o) => {
          if (!live) return
          onChange(o)
          if (o.kind !== 'outline') return
          // A big sheet is watched as far as one read reaches.
          for (const s of o.sheets) {
            const rows = Math.min(s.rowCount, Math.max(1, Math.floor(EXCEL_MAX_CELLS / s.columnCount)))
            offs.push(helper.watch(book, s.id, { startRow: 0, startColumn: 0, endRow: rows - 1, endColumn: s.columnCount - 1 }, onChange))
          }
        })
        return () => {
          live = false
          for (const off of offs) off()
        }
      }
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.watched.clear()
  }
}

const overlaps = (a: A1Range, b: A1Range): boolean => a.startRow <= b.endRow && b.startRow <= a.endRow && a.startColumn <= b.endColumn && b.startColumn <= a.endColumn

/** `B2:D9` (no sheet) as zero-based rows and columns. */
export function parseAddress(address: string): A1Range {
  const m = /^\$?([A-Z]+)\$?(\d+)(?::\$?([A-Z]+)\$?(\d+))?$/i.exec(address.trim())
  if (!m) throw new Error(`${address} is not a range.`)
  const col = (s: string) => [...s.toUpperCase()].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1
  const r1 = Number(m[2]) - 1
  const c1 = col(m[1])
  const r2 = m[4] ? Number(m[4]) - 1 : r1
  const c2 = m[3] ? col(m[3]) : c1
  return { startRow: Math.min(r1, r2), endRow: Math.max(r1, r2), startColumn: Math.min(c1, c2), endColumn: Math.max(c1, c2) }
}

/**
 * Whether a block's rows moved rather than changed: some run of at least two rows that held
 * something now sits one to ten rows above or below where it was (a row inserted or deleted).
 */
export function shiftOf(old: readonly (SheetCell | null)[][], now: readonly (SheetCell | null)[][]): boolean {
  const key = (row: readonly (SheetCell | null)[] | undefined) => (row ? JSON.stringify(row) : '')
  const filled = (row: readonly (SheetCell | null)[] | undefined) => !!row?.some((c) => c !== null)
  for (let k = 1; k <= 10; k++)
    for (const d of [k, -k]) {
      let run = 0
      for (let i = 0; i < old.length; i++) {
        const j = i + d
        if (j < 0 || j >= now.length || !filled(old[i]) || key(old[i]) === key(now[i])) {
          run = 0
          continue
        }
        run = key(old[i]) === key(now[j]) ? run + 1 : 0
        if (run >= 2) return true
      }
    }
  return false
}

