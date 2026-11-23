import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, realpathSync, renameSync, rmSync, statSync } from 'node:fs'
import type { DatabaseSync } from 'node:sqlite'
import { basename, dirname, join } from 'node:path'
import type { SheetCellDiff, SheetMutationJson, SheetRevision } from '@shared/contract-work-sheets'
import { cellName, colName, parseA1 } from './a1'
import type { Inspected, ReadCell } from './jobs'
import { mutationsOf, NotSaved, type CellWrite } from './mutations'
import { planOf, type Step, type StructuralOp } from './structural'
import type { EditSpec } from './patch/patch'
import type { SheetJobs } from './workerClient'

/**
 * Opened packages (docs/agents/work-sheets.md "Packages"): an .xlsx or .xlsm
 * on this host's disk stays the truth. Every edit is saved into it by the
 * patch writer as it lands, and becomes a revision: the op log row (what the
 * grids apply to catch up) and a copy of the package as it then stood (what
 * history compares and restores). The copies live under
 * `<dataDir>/sheets/files/<hash of the path>/`; the original as first opened
 * is kept for good, and the newest `KEEP_COPIES` after it.
 */

/** The grid's workbook id for a package: `importXlsx`'s default. A grid that names its own rewrites it. */
export const PACKAGE_UNIT = 'workbook'
export const KEEP_COPIES = 30

export function ensurePackageTables(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS work_sheets_files (
    path TEXT PRIMARY KEY,
    rev INTEGER NOT NULL,
    stamp TEXT NOT NULL,
    save_error TEXT
  )`)
  db.exec(`CREATE TABLE IF NOT EXISTS work_sheets_ops (
    path TEXT NOT NULL,
    rev INTEGER NOT NULL,
    by TEXT NOT NULL,
    at INTEGER NOT NULL,
    label TEXT NOT NULL,
    mutations TEXT NOT NULL,
    write_id TEXT,
    undo TEXT,
    PRIMARY KEY (path, rev)
  )`)
}

/** The file's stamp: what tells a change made outside us. */
const stampOf = (path: string): string => {
  const st = statSync(path)
  return `${st.size}:${Math.round(st.mtimeMs)}`
}

interface FileRow {
  path: string
  rev: number
  stamp: string
  save_error: string | null
}

export interface PackageState {
  rev: number
  inspected: Inspected
  saveError: string | null
  missing: boolean
}

export interface WriteResult {
  rev: number
  mutations: SheetMutationJson[]
}

export class PackageStore {
  /** one save at a time per file, in the order asked */
  private chains = new Map<string, Promise<unknown>>()
  private inspected = new Map<string, { stamp: string; value: Inspected }>()

  constructor(
    private db: DatabaseSync,
    private jobs: SheetJobs,
    private root: string,
    private ironcalcDir: () => string | null,
    private now: () => number = Date.now,
    /** a change from outside landed: no suggestion over the file is where the agent saw it for sure */
    private outside: (path: string) => void = () => {},
    /** LibreOffice applying structural ops (structural.ts's converter through `ctx.convert`): answers the package it wrote */
    private structural: ((input: string, ops: StructuralOp[], kind: 'xlsx' | 'xlsm') => Promise<string>) | null = null
  ) {}

  private dir(path: string): string {
    return join(this.root, createHash('sha256').update(path).digest('hex').slice(0, 24))
  }
  copyOf(path: string, rev: number): string {
    return join(this.dir(path), `${rev}.xlsx`)
  }
  private row(path: string): FileRow | undefined {
    return this.db.prepare('SELECT * FROM work_sheets_files WHERE path = ?').get(path) as FileRow | undefined
  }

  private serial<T>(path: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(path) ?? Promise.resolve()
    const run = prev.then(fn, fn)
    this.chains.set(
      path,
      run.catch(() => {})
    )
    return run
  }

  /**
   * The package's revision, first seen or changed outside us. A change on disk we did not make
   * (Excel saved it, a sync replaced it) is a revision of its own by `file`, and the grids reload.
   */
  private sync(path: string): FileRow {
    const row = this.row(path)
    const stamp = stampOf(path)
    if (!row) {
      mkdirSync(this.dir(path), { recursive: true })
      copyFileSync(path, this.copyOf(path, 0))
      this.db.prepare('INSERT INTO work_sheets_files (path, rev, stamp) VALUES (?, 0, ?)').run(path, stamp)
      return this.row(path)!
    }
    if (row.stamp === stamp) return row
    const rev = row.rev + 1
    copyFileSync(path, this.copyOf(path, rev))
    this.db.prepare('INSERT INTO work_sheets_ops (path, rev, by, at, label, mutations) VALUES (?, ?, ?, ?, ?, ?)').run(path, rev, 'file', this.now(), 'Changed outside TempCode', '[]')
    this.db.prepare('UPDATE work_sheets_files SET rev = ?, stamp = ? WHERE path = ?').run(rev, stamp, path)
    this.prune(path)
    this.outside(path)
    return this.row(path)!
  }

  async open(path: string): Promise<PackageState> {
    if (!existsSync(path)) {
      const row = this.row(path)
      if (!row) throw new Error(`There is no file at ${path}.`)
      return { rev: row.rev, inspected: this.inspected.get(path)?.value ?? { sheets: [], date1904: false, reach: null }, saveError: row.save_error, missing: true }
    }
    const row = this.sync(path)
    const hit = this.inspected.get(path)
    const inspected = hit?.stamp === row.stamp ? hit.value : await this.jobs.inspect(path)
    this.inspected.set(path, { stamp: row.stamp, value: inspected })
    return { rev: row.rev, inspected, saveError: row.save_error, missing: false }
  }

  /** The package's bytes as revision `rev` stood: the file itself when it is the newest, else its kept copy. */
  fileAt(path: string, rev: number): string {
    const row = this.row(path)
    if (!row) throw new Error('Open the sheet first.')
    if (rev === row.rev && existsSync(path) && stampOf(path) === row.stamp) return path
    const copy = this.copyOf(path, rev)
    if (!existsSync(copy)) throw new Error('That version of the file is no longer kept: open the sheet again.')
    return copy
  }

  /** What landed after `rev`; a reload when a change came from outside, which has no ops. */
  since(path: string, rev: number): { rev: number; ops: { rev: number; by: string; mutations: SheetMutationJson[] }[] } | { rev: number; reload: true } {
    const row = existsSync(path) ? this.sync(path) : this.row(path)
    if (!row) throw new Error('Open the sheet first.')
    const ops = this.db.prepare('SELECT rev, by, mutations FROM work_sheets_ops WHERE path = ? AND rev > ? ORDER BY rev').all(path, rev) as { rev: number; by: string; mutations: string }[]
    // A change from outside and a restore carry no ops: the grids load the file again.
    if (ops.some((o) => o.by === 'file' || o.mutations === 'null')) return { rev: row.rev, reload: true }
    return { rev: row.rev, ops: ops.map((o) => ({ rev: o.rev, by: o.by, mutations: JSON.parse(o.mutations) as SheetMutationJson[] })) }
  }

  private sheetName(path: string): (id: string) => string | undefined {
    const sheets = this.inspected.get(path)?.value.sheets ?? []
    return (id) => sheets.find((s) => s.id === id)?.name
  }
  private sheetId(path: string, name: string | undefined): string {
    const sheets = this.inspected.get(path)?.value.sheets ?? []
    const s = name === undefined ? sheets[0] : sheets.find((x) => x.name === name)
    if (!s) throw new Error(name === undefined ? 'The workbook has no sheets.' : `There is no sheet named ${name}.`)
    return s.id
  }

  /**
   * Saves edits into the package as one revision. `baseRev` is the revision the editor stood on.
   * Edits that came between were cell writes and formatting (rows and columns moved answer a
   * reload), so the cells are where the editor saw them and the edit lands; a change from outside
   * or a restore between answers a conflict and writes nothing, and the editor reloads.
   */
  edit(
    path: string,
    baseRev: number,
    mutations: SheetMutationJson[],
    by: string,
    extra: { label?: string; writeId?: string; undo?: SheetMutationJson[] } = {}
  ): Promise<{ rev: number; moved?: Moved } | { conflict: true; rev: number }> {
    return this.serial(path, async () => {
      const row = this.sync(path)
      if (baseRev > row.rev || (baseRev < row.rev && this.reloadSince(path, baseRev))) return { conflict: true as const, rev: row.rev }
      if (!this.inspected.has(path)) await this.open(path)
      const before = new Map(this.inspected.get(path)!.value.sheets.map((s) => [s.id, s.name]))
      const steps = planOf(mutations, new Map(before))
      if (!steps.length) return { rev: row.rev }
      const ops = steps.flatMap((s) => (s.kind === 'structural' ? s.ops : []))
      let rev: number
      try {
        rev = await this.save(path, row, (target, out) => this.write(target, out, steps))
      } catch (err) {
        if (!(err instanceof ChangedOutside)) throw err
        // Excel saved it while we patched: its save stands as a revision, and this edit goes back to the editor.
        return { conflict: true as const, rev: this.sync(path).rev }
      }
      const edits = steps.flatMap((s) => (s.kind === 'cells' ? s.edits : []))
      // After a structural save every grid loads the file again (LibreOffice renumbers sheets): its op carries no mutations.
      this.db
        .prepare('INSERT INTO work_sheets_ops (path, rev, by, at, label, mutations, write_id, undo) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(path, rev, by, this.now(), extra.label ?? (ops.length ? labelOfOps(ops) : labelOf(edits)), ops.length ? 'null' : JSON.stringify(mutations), extra.writeId ?? null, extra.undo && !ops.length ? JSON.stringify(extra.undo) : null)
      return ops.length ? { rev, moved: { ops, before } } : { rev }
    })
  }

  /** Writes the edit's steps from `target` into `out`: the patch writer for cells, LibreOffice and the graft for structure. */
  private async write(target: string, out: string, steps: Step[]): Promise<void> {
    if (steps.length === 1 && steps[0].kind === 'cells') {
      await this.jobs.save(target, out, steps[0].edits, this.ironcalcDir(), steps[0].formats)
      return
    }
    if (!this.structural) throw new NotSaved('Rows, columns and sheets cannot be changed in an opened Excel file on this host.')
    const kind = target.toLowerCase().endsWith('.xlsm') ? 'xlsm' : 'xlsx'
    const work = join(this.root, 'work', randomUUID())
    mkdirSync(work, { recursive: true })
    try {
      let at = target
      for (const [i, step] of steps.entries()) {
        const next = join(work, `${i}.${kind}`)
        if (step.kind === 'cells') await this.jobs.save(at, next, step.edits, this.ironcalcDir(), step.formats)
        else {
          const written = await this.structural(at, step.ops, kind)
          try {
            await this.jobs.graft(at, written, next, step.ops)
          } finally {
            rmSync(written, { force: true })
            // held.ts's job folder for this step, when it is one
            if (basename(dirname(written)).startsWith('tc-sheet-ops-')) rmSync(dirname(written), { recursive: true, force: true })
          }
        }
        at = next
      }
      copyFileSync(at, out)
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  }

  /** Whether a change from outside or a restore landed after `rev`: the cells may have moved. */
  private reloadSince(path: string, rev: number): boolean {
    return !!this.db.prepare("SELECT 1 FROM work_sheets_ops WHERE path = ? AND rev > ? AND (by = 'file' OR mutations = 'null') LIMIT 1").get(path, rev)
  }

  private async save(path: string, row: FileRow, write: (target: string, out: string) => Promise<void>): Promise<number> {
    const rev = row.rev + 1
    // Written beside the file (through a link, beside its target) and moved over it, so a reader never sees half a package.
    const target = realpathSync(path)
    const tmp = join(dirname(target), `.${randomUUID()}.tcsave`)
    try {
      await write(target, tmp)
      chmodSync(tmp, statSync(target).mode & 0o7777)
      // A save made outside while we patched (Excel, a sync) is not ours to overwrite.
      if (stampOf(path) !== row.stamp) throw new ChangedOutside()
      renameSync(tmp, target)
    } catch (err) {
      rmSync(tmp, { force: true })
      if (err instanceof ChangedOutside || err instanceof NotSaved) throw err
      const words = err instanceof Error ? err.message : String(err)
      this.db.prepare('UPDATE work_sheets_files SET save_error = ? WHERE path = ?').run(words, path)
      throw new Error(`The file was not saved: ${words}`)
    }
    copyFileSync(path, this.copyOf(path, rev))
    this.db.prepare('UPDATE work_sheets_files SET rev = ?, stamp = ?, save_error = NULL WHERE path = ?').run(rev, stampOf(path), path)
    this.prune(path)
    return rev
  }

  /** Reads the cells of an A1 range as the package holds them now. */
  async read(path: string, range: string): Promise<{ sheet: string; cells: ReadCell[][] }> {
    const r = parseA1(range)
    if (!r) throw new Error(`${range} is not a range: write it like B4:D9 or 'Q1 Budget'!B4:D9.`)
    this.sync(path)
    return this.jobs.read(path, r)
  }

  /** The cells as they are now, by sheet id, for undo and for a suggestion's base. */
  async cellsAt(path: string, at: readonly { sheet: string; row: number; col: number }[]): Promise<CellWrite[]> {
    const name = this.sheetName(path)
    const out: CellWrite[] = []
    for (const c of at) {
      const sheet = name(c.sheet)
      const got = sheet === undefined ? null : (await this.jobs.read(path, { sheet, startRow: c.row, endRow: c.row, startColumn: c.col, endColumn: c.col })).cells[0]?.[0]
      out.push({ sheet: c.sheet, row: c.row, col: c.col, cell: got && (got.f !== undefined || got.v !== undefined) ? { ...(got.v !== undefined ? { v: got.v } : {}), ...(got.f !== undefined ? { f: got.f } : {}) } : null })
    }
    return out
  }

  /**
   * Writes cells given in A1 on behalf of `by` (an agent asked, a routine, its own idea where it
   * writes, an accepted suggestion). Keeps what they held, so the write can be taken back.
   */
  async writeCells(path: string, cells: readonly { at: string; v?: string | number | boolean | null; f?: string }[], by: string, label: string, writeId?: string): Promise<WriteResult> {
    const state = await this.open(path)
    const writes: CellWrite[] = cells.map((c) => {
      const r = parseA1(c.at)
      if (!r || r.startRow !== r.endRow || r.startColumn !== r.endColumn) throw new Error(`${c.at} is not one cell.`)
      const f = c.f === undefined ? undefined : c.f.startsWith('=') ? c.f : `=${c.f}`
      return { sheet: this.sheetId(path, r.sheet), row: r.startRow, col: r.startColumn, cell: f ? { f } : c.v === undefined || c.v === null || c.v === '' ? null : { v: c.v } }
    })
    const before = await this.cellsAt(path, writes)
    const mutations = mutationsOf(PACKAGE_UNIT, writes)
    const got = await this.edit(path, state.rev, mutations, by, { label, writeId, undo: mutationsOf(PACKAGE_UNIT, before) })
    if ('conflict' in got) throw new Error('The file changed while writing: try again.')
    return { rev: got.rev, mutations }
  }

  /** Takes back an agent's direct write, when no later edit touched those cells. */
  async undo(path: string, writeId: string): Promise<WriteResult> {
    const op = this.db.prepare('SELECT rev, undo, mutations FROM work_sheets_ops WHERE path = ? AND write_id = ?').get(path, writeId) as { rev: number; undo: string | null; mutations: string } | undefined
    if (!op?.undo) throw new Error('That write can no longer be taken back.')
    const touched = cellsOfMutations(JSON.parse(op.mutations) as SheetMutationJson[])
    const later = this.db.prepare('SELECT mutations FROM work_sheets_ops WHERE path = ? AND rev > ?').all(path, op.rev) as { mutations: string }[]
    if (later.some((l) => l.mutations === 'null' || l.mutations === '[]')) throw new Error('The file was restored or changed since: that write can no longer be taken back.')
    for (const l of later) for (const k of cellsOfMutations(JSON.parse(l.mutations) as SheetMutationJson[])) if (touched.has(k)) throw new Error('Those cells were edited since: that write can no longer be taken back.')
    const state = await this.open(path)
    const mutations = JSON.parse(op.undo) as SheetMutationJson[]
    const got = await this.edit(path, state.rev, mutations, 'owner', { label: 'Took back a write' })
    if ('conflict' in got) throw new Error('The file changed while taking it back: try again.')
    this.db.prepare('UPDATE work_sheets_ops SET undo = NULL WHERE path = ? AND write_id = ?').run(path, writeId)
    return { rev: got.rev, mutations }
  }

  history(path: string): SheetRevision[] {
    const ops = this.db.prepare('SELECT rev, by, at, label FROM work_sheets_ops WHERE path = ? ORDER BY rev DESC').all(path) as { rev: number; by: string; at: number; label: string }[]
    const first = existsSync(this.copyOf(path, 0)) ? [{ rev: 0, at: statSync(this.copyOf(path, 0)).mtimeMs, by: 'file' as const, label: 'As opened' }] : []
    return [...ops.map((o) => ({ rev: o.rev, at: o.at, by: o.by as SheetRevision['by'], label: o.label })), ...first]
  }

  compare(path: string, from: number, to: number, max: number): Promise<{ cells: SheetCellDiff[]; truncated: boolean }> {
    return this.jobs.compare(this.fileAt(path, from), this.fileAt(path, to), max)
  }

  /**
   * Puts revision `rev`'s package back as a new revision: its copy, byte for byte, so whatever the
   * file held then (parts our grid never sees included) is what it holds again. Nothing after it is
   * lost: those revisions stay in the history. The grids reload.
   */
  restore(path: string, rev: number, by: string): Promise<{ rev: number }> {
    return this.serial(path, async () => {
      const row = this.sync(path)
      const copy = this.copyOf(path, rev)
      if (!existsSync(copy)) throw new Error('That version of the file is no longer kept.')
      const target = realpathSync(path)
      const tmp = join(dirname(target), `.${randomUUID()}.tcsave`)
      copyFileSync(copy, tmp)
      chmodSync(tmp, statSync(target).mode & 0o7777)
      if (stampOf(path) !== row.stamp) {
        rmSync(tmp, { force: true })
        throw new Error('The file changed outside TempCode just now: open it again and restore.')
      }
      renameSync(tmp, target)
      const next = row.rev + 1
      copyFileSync(path, this.copyOf(path, next))
      const at = new Date(this.history(path).find((h) => h.rev === rev)?.at ?? this.now())
      this.db.prepare('INSERT INTO work_sheets_ops (path, rev, by, at, label, mutations) VALUES (?, ?, ?, ?, ?, ?)').run(path, next, by, this.now(), `Restored to ${at.toTimeString().slice(0, 5)}`, 'null')
      this.db.prepare('UPDATE work_sheets_files SET rev = ?, stamp = ?, save_error = NULL WHERE path = ?').run(next, stampOf(path), path)
      this.prune(path)
      return { rev: next }
    })
  }

  /** Keeps the original and the newest copies. */
  private prune(path: string): void {
    const dir = this.dir(path)
    const revs = readdirSync(dir)
      .map((f) => Number(/^(\d+)\.xlsx$/.exec(f)?.[1]))
      .filter((n) => Number.isInteger(n) && n > 0)
      .sort((a, b) => b - a)
    for (const rev of revs.slice(KEEP_COPIES)) rmSync(this.copyOf(path, rev), { force: true })
  }

  /** Forget a file's copies and log (its item was deleted with its thread, and no other item names it). */
  forget(path: string): void {
    this.db.prepare('DELETE FROM work_sheets_ops WHERE path = ?').run(path)
    this.db.prepare('DELETE FROM work_sheets_files WHERE path = ?').run(path)
    rmSync(this.dir(path), { recursive: true, force: true })
    this.inspected.delete(path)
  }
}

class ChangedOutside extends Error {}

/** A structural save, for the pillar to move suggestions: the ops, and each sheet's id and name before them. */
export interface Moved {
  ops: StructuralOp[]
  before: Map<string, string>
}

/** "Inserted 2 rows", "Renamed Q1" */
function labelOfOps(ops: readonly StructuralOp[]): string {
  const op = ops[0]
  const many = ops.length > 1 ? ' and more' : ''
  switch (op.op) {
    case 'insertRows':
      return `Inserted ${op.count === 1 ? 'a row' : `${op.count} rows`}${many}`
    case 'removeRows':
      return `Deleted ${op.count === 1 ? 'a row' : `${op.count} rows`}${many}`
    case 'insertCols':
      return `Inserted ${op.count === 1 ? 'a column' : `${op.count} columns`}${many}`
    case 'removeCols':
      return `Deleted ${op.count === 1 ? 'a column' : `${op.count} columns`}${many}`
    case 'reorder':
      return `Sorted ${op.sheet}${many}`
    case 'addSheet':
      return `Added ${op.name}${many}`
    case 'removeSheet':
      return `Removed ${op.sheet}${many}`
    case 'renameSheet':
      return `Renamed ${op.sheet} to ${op.to}${many}`
  }
}

/** "12 cells", "B4"; "Formatting" for an edit that changed no cell's contents */
function labelOf(edits: readonly EditSpec[]): string {
  return edits.length === 0 ? 'Formatting' : edits.length === 1 ? `${edits[0].cell}` : `${edits.length} cells`
}

/**
 * `sheet:row:col` of every cell whose contents a list of set-range-values mutations writes. A cell
 * that only takes a style keeps what it held, so a suggestion waiting on it still stands and a
 * write to it can still be taken back.
 */
export function cellsOfMutations(mutations: readonly SheetMutationJson[]): Set<string> {
  const out = new Set<string>()
  for (const m of mutations) {
    const p = m.params as { subUnitId?: string; cellValue?: Record<string, Record<string, Record<string, unknown> | null>> }
    for (const [r, cols] of Object.entries(p.cellValue ?? {}))
      for (const [c, cell] of Object.entries(cols ?? {})) if (cell === null || 'v' in cell || 'f' in cell || 'p' in cell || 'si' in cell) out.add(`${p.subUnitId}:${r}:${c}`)
  }
  return out
}

export { cellName, colName }
