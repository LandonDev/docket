import { createHash, randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import type { DatabaseSync } from 'node:sqlite'
import { basename, dirname, join } from 'node:path'
import type { SheetCellDiff, SheetMutationJson, SheetRevision } from '@shared/contract-work-sheets'
import { isObjectList, RULES_SET, type ObjectIds, type RulesSetParams } from '@shared/work/sheets'
import { saveFile, versionWord } from '../files/save'
import { versionOf } from '../files/write'
import { cellName, colName, parseA1 } from './a1'
import type { Inspected, ReadCell } from './jobs'
import { mutationsOf, NotSaved, type CellWrite } from './mutations'
import { planOf, refuseMove, type Step, type StructuralOp } from './structural'
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
  // Who holds a workbook others can open: its tab, or a thread that read it by its path. Names and ids only.
  db.exec(`CREATE TABLE IF NOT EXISTS work_sheets_shared (
    path TEXT NOT NULL,
    item TEXT NOT NULL,
    session TEXT NOT NULL,
    PRIMARY KEY (path, item, session)
  )`)
}

/**
 * What an edit's row says in place of its mutations for a workbook others can open: the cells did
 * not move, and what was typed is not kept in this host's database. Another grid of the file reads
 * it again (`since`); an edit made before it still lands (`reloadSince` does not count it).
 */
const UNKEPT = '"unkept"'

/** Where a workbook others can open keeps its copies, and which workbook that is (held.ts: Files' own scratch, out of every backup, cleared at each start). */
export interface SharedPlace {
  root: string
  is(path: string): boolean
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
    private structural: ((input: string, ops: StructuralOp[], kind: 'xlsx' | 'xlsm') => Promise<string>) | null = null,
    /** the lock a save of this file takes in Files' door: the file's own key there, so a save here and a change made in Files take turns */
    private keyOf: (path: string) => string | Promise<string> = (path) => `file::${path}`,
    /**
     * A workbook others can open (a Teams library's, a shared OneDrive folder's): nothing made from it
     * outlives its tab or thread, or reaches a backup. Its copies live under `shared.root`, go when the
     * last holder goes (`release`), and its edits are logged without what was typed.
     */
    private shared: SharedPlace | null = null
  ) {}

  private sharedSeen = new Map<string, { at: number; value: boolean }>()
  /** Whether others can open the file, asked of the host's rule and kept for a moment (it reads the disk). */
  isShared(path: string): boolean {
    if (!this.shared) return false
    const hit = this.sharedSeen.get(path)
    if (hit && this.now() - hit.at < 5000) return hit.value
    const value = this.shared.is(path)
    this.sharedSeen.set(path, { at: this.now(), value })
    return value
  }
  private rootOf(path: string): string {
    return this.isShared(path) ? this.shared!.root : this.root
  }
  /**
   * Where a save is made before the file takes it. A shared workbook's is in the OS temp folder, which no backup
   * reads and nothing else clears mid-save (Files clears its scratch at each start, while tabs reopen): it is
   * removed as the save ends.
   */
  private scratchOf(path: string): string {
    if (!this.isShared(path)) return join(this.root, 'work')
    // (a folder of this process alone, made for its owner only: the workbook is not readable by another account while it saves)
    if (!this.saveDir || !existsSync(this.saveDir)) this.saveDir = mkdtempSync(join(tmpdir(), 'tc-sheet-save-'))
    return this.saveDir
  }
  private saveDir: string | null = null

  /**
   * What was kept of shared workbooks before this rule: their copies move to the scratch and their log gives up
   * what was typed, for every workbook this host knows, opened again or not.
   */
  sweep(): void {
    if (!this.shared) return
    for (const { path } of this.db.prepare('SELECT path FROM work_sheets_files').all() as { path: string }[]) {
      if (!this.isShared(path)) continue
      this.dir(path)
      this.db.prepare(`UPDATE work_sheets_ops SET mutations = ?, undo = NULL WHERE path = ? AND mutations NOT IN ('null', '[]', ?)`).run(UNKEPT, path, UNKEPT)
    }
  }
  private dir(path: string): string {
    const name = createHash('sha256').update(path).digest('hex').slice(0, 24)
    const here = join(this.rootOf(path), name)
    // Copies made where the file's place was judged otherwise (before this rule, or before its folder became a library) are not left behind.
    if (this.shared) {
      const other = join(this.isShared(path) ? this.root : this.shared.root, name)
      if (existsSync(other)) {
        if (this.isShared(path) && !existsSync(here)) {
          mkdirSync(dirname(here), { recursive: true })
          try {
            renameSync(other, here)
          } catch {
            rmSync(other, { recursive: true, force: true })
          }
        } else rmSync(other, { recursive: true, force: true })
      }
    }
    return here
  }
  copyOf(path: string, rev: number): string {
    return join(this.dir(path), `${rev}.xlsx`)
  }
  private row(path: string): FileRow | undefined {
    return this.db.prepare('SELECT * FROM work_sheets_files WHERE path = ?').get(path) as FileRow | undefined
  }

  /**
   * Runs `fn` while no save of the file runs: edits asked meanwhile wait until it ends. What reads the file and acts on
   * what it read (Save back converting a copy, then stamping it) holds it, so no edit lands between the read and the act.
   */
  holding<T>(path: string, fn: () => Promise<T>): Promise<T> {
    return this.serial(path, fn)
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
    // (copies kept where the file's place was judged otherwise are moved or removed now, not at the next save; and
    // a shared workbook's log written before this rule gives up what was typed: the database rides the backup)
    if (this.shared && row) {
      this.dir(path)
      if (this.isShared(path)) this.db.prepare(`UPDATE work_sheets_ops SET mutations = ?, undo = NULL WHERE path = ? AND mutations NOT IN ('null', '[]', ?)`).run(UNKEPT, path, UNKEPT)
    }
    if (!row) {
      mkdirSync(this.dir(path), { recursive: true })
      copyFileSync(path, this.copyOf(path, 0))
      this.db.prepare('INSERT INTO work_sheets_files (path, rev, stamp) VALUES (?, 0, ?)').run(path, stamp)
      return this.row(path)!
    }
    if (row.stamp === stamp) return row
    const rev = row.rev + 1
    // (a shared workbook's copies go with its tab and at each start: the folder is made again)
    mkdirSync(this.dir(path), { recursive: true })
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
    // A change from outside and a restore carry no ops, and a shared workbook's edit keeps none: the grids load the file again.
    if (ops.some((o) => o.by === 'file' || o.mutations === 'null' || o.mutations === UNKEPT)) return { rev: row.rev, reload: true }
    const out = ops.map((o) => ({ rev: o.rev, by: o.by, mutations: JSON.parse(o.mutations) as SheetMutationJson[] }))
    // A rule's whole list is no mutation a grid applies: the grids that were not its sender load the file again.
    if (out.some((o) => o.mutations.some((m) => m.id === RULES_SET))) return { rev: row.rev, reload: true }
    return { rev: row.rev, ops: out }
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
    extra: { label?: string; writeId?: string; undo?: SheetMutationJson[]; under?: () => Promise<{ mutations: SheetMutationJson[]; label: string }> } = {}
  ): Promise<{ rev: number; moved?: Moved; ids?: ObjectIds } | { conflict: true; rev: number }> {
    return this.serial(path, async () => {
      // A file moved or deleted since it was opened takes no edit: said, not thrown as a raw error.
      if (!existsSync(path)) throw new NotSaved('This file is not where it was: it was moved or deleted.')
      const row = this.sync(path)
      if (baseRev > row.rev || (baseRev < row.rev && (this.reloadSince(path, baseRev) || this.listSince(path, baseRev, mutations)))) return { conflict: true as const, rev: row.rev }
      if (!this.inspected.has(path)) await this.open(path)
      // An edit that is worked out from the cells (an accepted suggestion, written only over what the agent saw) reads
      // them here, under the save's own turn, from the file this save then checks it writes over: what was checked is
      // what is written, and a change from outside after the read is refused by the save as any other.
      if (extra.under) ({ mutations, label: extra.label } = await extra.under())
      const before = new Map(this.inspected.get(path)!.value.sheets.map((s) => [s.id, s.name]))
      const steps = planOf(mutations, new Map(before))
      if (!steps.length) return { rev: row.rev }
      const ops = steps.flatMap((s) => (s.kind === 'structural' ? s.ops : []))
      let rev: number
      let ids: ObjectIds = {}
      try {
        rev = await this.save(path, row, async (target, out) => {
          ids = await this.write(path, target, out, steps)
        })
      } catch (err) {
        if (!(err instanceof ChangedOutside)) throw err
        // The file was moved or deleted while we patched: nothing is made under its old name, and the edit goes back.
        if (!existsSync(path)) return { conflict: true as const, rev: row.rev }
        // Excel saved it while we patched: its save stands as a revision, and this edit goes back to the editor.
        return { conflict: true as const, rev: this.sync(path).rev }
      }
      const edits = steps.flatMap((s) => (s.kind === 'cells' ? s.edits : []))
      const rules = mutations.filter((m) => m.id === RULES_SET)
      // A workbook others can open: what was typed is not kept in this host's database (it rides the backup).
      const unkept = this.isShared(path)
      // After a structural save every grid loads the file again (LibreOffice renumbers sheets): its op carries no mutations.
      // A rule's op keeps its own (the whole list its change left), which `since` answers as a reload: no other grid
      // can apply a list as it is, but no cell moved, so an edit made before it still lands.
      this.db
        .prepare('INSERT INTO work_sheets_ops (path, rev, by, at, label, mutations, write_id, undo) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(path, rev, by, this.now(), extra.label ?? (ops.length ? labelOfOps(ops) : rules.length && !edits.length ? labelOfRules(rules) : labelOf(edits)), ops.length ? 'null' : unkept ? UNKEPT : JSON.stringify(mutations.map(withoutBytes)), extra.writeId ?? null, extra.undo && !ops.length && !unkept ? JSON.stringify(extra.undo) : null)
      const named = Object.keys(ids).length ? { ids } : {}
      return ops.length ? { rev, moved: { ops, before }, ...named } : { rev, ...named }
    })
  }

  /** Writes the edit's steps from `target` into `out`: the patch writer for cells, LibreOffice and the graft for structure. */
  private async write(path: string, target: string, out: string, steps: Step[]): Promise<ObjectIds> {
    if (steps.length === 1 && steps[0].kind === 'cells') return (await this.jobs.save(target, out, steps[0].edits, this.ironcalcDir(), steps[0].formats)).report.ids ?? {}
    const ids: ObjectIds = {}
    if (!this.structural) throw new NotSaved('Rows, columns and sheets cannot be changed in an opened Excel file on this host.')
    const kind = target.toLowerCase().endsWith('.xlsm') ? 'xlsm' : 'xlsx'
    const work = join(this.scratchOf(path), randomUUID())
    mkdirSync(work, { recursive: true })
    try {
      let at = target
      for (const [i, step] of steps.entries()) {
        const next = join(work, `${i}.${kind}`)
        if (step.kind === 'cells') Object.assign(ids, (await this.jobs.save(at, next, step.edits, this.ironcalcDir(), step.formats)).report.ids)
        else {
          // A move the file cannot take is refused here, on the file as this step finds it, before the job is asked
          // for: the words come back at once, not after a wait behind another conversion, and as a refusal even where
          // the job itself would run on another host.
          refuseMove(at, step.ops)
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
    return ids
  }

  /**
   * Whether a list this edit replaces whole (a tab's charts or pictures, its conditional formats, the names) was
   * replaced after `rev` by another edit: the list sent was made without that one's change, and would take it out of
   * the file. A shared workbook's log keeps no lists, so any edit after `rev` there counts.
   */
  private listSince(path: string, rev: number, mutations: readonly SheetMutationJson[]): boolean {
    const lists = new Set(mutations.filter((m) => m.id === RULES_SET).map(listKey))
    if (!lists.size) return false
    const later = this.db.prepare('SELECT mutations FROM work_sheets_ops WHERE path = ? AND rev > ?').all(path, rev) as { mutations: string }[]
    return later.some((o) => o.mutations === UNKEPT || (o.mutations !== 'null' && (JSON.parse(o.mutations) as SheetMutationJson[]).some((m) => m.id === RULES_SET && lists.has(listKey(m)))))
  }

  /** Whether a change from outside or a restore landed after `rev`: the cells may have moved. */
  private reloadSince(path: string, rev: number): boolean {
    return !!this.db.prepare("SELECT 1 FROM work_sheets_ops WHERE path = ? AND rev > ? AND (by = 'file' OR mutations = 'null') LIMIT 1").get(path, rev)
  }

  private async save(path: string, row: FileRow, write: (target: string, out: string) => Promise<void>): Promise<number> {
    const rev = row.rev + 1
    // The new package is made among this host's own files, never beside the file, and its bytes are handed to
    // Files' one door for replacing a file where it lies (through a link, its target).
    const target = realpathSync(path)
    const made = join(this.scratchOf(path), `${randomUUID()}.save`)
    let stamp: string
    try {
      mkdirSync(dirname(made), { recursive: true })
      // The file as the patch read it: the door replaces it only while it is still this.
      const expect = versionWord(await versionOf(target))
      if (stampOf(path) !== row.stamp) throw new ChangedOutside()
      await write(target, made)
      stamp = await this.put(path, target, new Uint8Array(readFileSync(made)), expect, rev)
    } catch (err) {
      if (err instanceof ChangedOutside || err instanceof NotSaved) throw err
      const words = saveWords(err)
      this.db.prepare('UPDATE work_sheets_files SET save_error = ? WHERE path = ?').run(words, path)
      throw new Error(`The file was not saved: ${words}`)
    } finally {
      rmSync(made, { force: true })
    }
    this.db.prepare('UPDATE work_sheets_files SET rev = ?, stamp = ?, save_error = NULL WHERE path = ?').run(rev, stamp, path)
    this.prune(path)
    return rev
  }

  /**
   * Replaces the file's bytes through Files' door (files/save.ts `saveFile`): written under a hidden name of the
   * door's own, synced and renamed over the file, one save of a file at a time, and only while the file is still
   * `expect`. A file that changed since, or is gone, is a change from outside. The kept copy of revision `rev` is
   * written first, from the same bytes, and taken back when the door refuses: so once the file holds the save the
   * store holds its copy, and nothing between the two can fail. Answers the file's stamp as the door left it, not
   * as a later look finds it (a sync may land in between, and that is the next change from outside).
   */
  private async put(path: string, target: string, bytes: Uint8Array, expect: string, rev: number): Promise<string> {
    const copy = this.copyOf(path, rev)
    try {
      try {
        mkdirSync(dirname(copy), { recursive: true })
        writeFileSync(copy, bytes)
      } catch {
        // (a shared workbook's folder is Files' scratch, cleared at each start: made again once)
        mkdirSync(dirname(copy), { recursive: true })
        writeFileSync(copy, bytes)
      }
    } catch {
      // Our own folder, not the workbook's: said as that, so he does not look for the fault beside his file.
      rmSync(copy, { force: true })
      throw new Error('TempCode could not keep this version among its own files')
    }
    let got: Awaited<ReturnType<typeof saveFile>>
    try {
      got = await saveFile({ roots: [dirname(target)] }, await this.keyOf(target), target, bytes, expect)
    } catch (err) {
      rmSync(copy, { force: true })
      throw err
    }
    if ('conflict' in got) {
      rmSync(copy, { force: true })
      throw new ChangedOutside()
    }
    // A version word is `size:mtime:sha`: its first two parts are the stamp.
    return got.version.split(':').slice(0, 2).join(':')
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
    if (later.some((l) => l.mutations === 'null' || l.mutations === '[]' || l.mutations === UNKEPT)) throw new Error('The file was restored or changed since: that write can no longer be taken back.')
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
    // A workbook others can open keeps its copies only while a tab or thread holds it: History lists the newest
    // revision (the file itself) and those whose copy is still here, so nothing it offers answers "no longer kept".
    const newest = ops[0]?.rev
    const kept = this.isShared(path) ? ops.filter((o) => o.rev === newest || existsSync(this.copyOf(path, o.rev))) : ops
    return [...kept.map((o) => ({ rev: o.rev, at: o.at, by: o.by as SheetRevision['by'], label: o.label })), ...first]
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
      const expect = versionWord(await versionOf(target))
      const next = row.rev + 1
      let stamp: string
      try {
        if (stampOf(path) !== row.stamp) throw new ChangedOutside()
        stamp = await this.put(path, target, new Uint8Array(readFileSync(copy)), expect, next)
      } catch (err) {
        if (err instanceof ChangedOutside) throw new Error('The file changed outside TempCode just now: open it again and restore.')
        throw new Error(`The file was not restored: ${saveWords(err)}`)
      }
      const at = new Date(this.history(path).find((h) => h.rev === rev)?.at ?? this.now())
      this.db.prepare('INSERT INTO work_sheets_ops (path, rev, by, at, label, mutations) VALUES (?, ?, ?, ?, ?, ?)').run(path, next, by, this.now(), `Restored to ${at.toTimeString().slice(0, 5)}`, 'null')
      this.db.prepare('UPDATE work_sheets_files SET rev = ?, stamp = ?, save_error = NULL WHERE path = ?').run(next, stamp, path)
      this.prune(path)
      return { rev: next }
    })
  }

  /** Keeps the original and the newest copies. */
  private prune(path: string): void {
    const dir = this.dir(path)
    if (!existsSync(dir)) return
    const revs = readdirSync(dir)
      .map((f) => Number(/^(\d+)\.xlsx$/.exec(f)?.[1]))
      .filter((n) => Number.isInteger(n) && n > 0)
      .sort((a, b) => b - a)
    for (const rev of revs.slice(KEEP_COPIES)) rmSync(this.copyOf(path, rev), { force: true })
  }

  /**
   * Says who holds a workbook others can open: `item` its tab (or ''), `session` the thread or pane it is in. Its
   * copies go when the last holder does (`release`).
   */
  hold(path: string, item: string, session: string): void {
    if (!this.isShared(path)) return
    this.db.prepare('INSERT OR IGNORE INTO work_sheets_shared (path, item, session) VALUES (?, ?, ?)').run(path, item, session)
  }

  /**
   * Holders that went: tabs closed for good (`items`) or threads deleted (`sessions`). A workbook nobody holds any
   * more keeps no copy here: what stays is its row (a path, a revision number, a stamp) and its log's labels, so a
   * suggestion waiting on it still knows which revision it was made for.
   */
  release(gone: { items?: readonly string[]; sessions?: readonly string[] }): string[] {
    const paths = new Set<string>()
    const rows = (column: 'item' | 'session', ids: readonly string[]): void => {
      for (const id of ids) {
        if (!id) continue
        for (const r of this.db.prepare(`SELECT path FROM work_sheets_shared WHERE ${column} = ?`).all(id) as { path: string }[]) paths.add(r.path)
        this.db.prepare(`DELETE FROM work_sheets_shared WHERE ${column} = ?`).run(id)
      }
    }
    rows('item', gone.items ?? [])
    rows('session', gone.sessions ?? [])
    const dropped: string[] = []
    for (const path of paths) {
      if (this.db.prepare('SELECT 1 FROM work_sheets_shared WHERE path = ? LIMIT 1').get(path)) continue
      dropped.push(path)
      // After any save of the file in flight (a tab's last edit is flushed as it closes), and only if nobody took hold meanwhile.
      void this.serial(path, async () => {
        if (!this.db.prepare('SELECT 1 FROM work_sheets_shared WHERE path = ? LIMIT 1').get(path)) this.dropCopies(path)
      })
    }
    return dropped
  }

  /** Resolves once every save and release asked for so far has ended (a test waits on it). */
  idle(): Promise<void> {
    return Promise.all([...this.chains.values()]).then(() => undefined)
  }

  /** Removes every copy kept of a file, in either place. */
  private dropCopies(path: string): void {
    const name = createHash('sha256').update(path).digest('hex').slice(0, 24)
    rmSync(join(this.root, name), { recursive: true, force: true })
    if (this.shared) rmSync(join(this.shared.root, name), { recursive: true, force: true })
  }

  /** Forget a file's copies and log (its item was deleted with its thread, and no other item names it). */
  forget(path: string): void {
    this.db.prepare('DELETE FROM work_sheets_ops WHERE path = ?').run(path)
    this.db.prepare('DELETE FROM work_sheets_files WHERE path = ?').run(path)
    this.db.prepare('DELETE FROM work_sheets_shared WHERE path = ?').run(path)
    this.dropCopies(path)
    this.inspected.delete(path)
  }
}

class ChangedOutside extends Error {}

/** Why a save could not be written, in his words: never a raw error with the door's own hidden path in it. */
function saveWords(err: unknown): string {
  const code = (err as { code?: string } | null)?.code
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') return 'this folder is read only'
  if (code === 'ENOSPC' || code === 'EDQUOT') return 'the disk is full'
  if (code === 'ENOENT') return 'the file is not there any more'
  const text = err instanceof Error ? err.message : String(err)
  // (a path the door made is nothing he named)
  return text.replace(/'[^']*\.tmp'/g, 'a temporary file')
}

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
    case 'moveRange':
      return `Moved cells${many}`
    case 'moveRows':
      return `Moved ${op.count === 1 ? 'a row' : `${op.count} rows`}${many}`
    case 'moveCols':
      return `Moved ${op.count === 1 ? 'a column' : `${op.count} columns`}${many}`
    case 'addSheet':
      return `Added ${op.name}${many}`
    case 'removeSheet':
      return `Removed ${op.sheet}${many}`
    case 'renameSheet':
      return `Renamed ${op.sheet} to ${op.to}${many}`
  }
}

/** "Conditional formatting", "Validation", "Names", "Filter", "Table", "Page set-up"; "Rules" for more than one kind */
function labelOfRules(rules: readonly SheetMutationJson[]): string {
  const kinds = new Set(rules.map((m) => (m.params as RulesSetParams).kind))
  if (kinds.size !== 1) return 'Rules'
  return { conditional: 'Conditional formatting', validation: 'Validation', names: 'Names', filter: 'Filter', tables: 'Table', pages: 'Page set-up', charts: 'Chart', pictures: 'Picture' }[[...kinds][0]!]
}

/** A whole list's kind and the tab it is of (none for the names). */
const listKey = (m: SheetMutationJson): string => `${(m.params as RulesSetParams).kind}\u0000${(m.params as RulesSetParams).subUnitId ?? ''}`

/** A picture list as the op log keeps it: a new picture's bytes are in the file and its kept copy, not the database. */
function withoutBytes(m: SheetMutationJson): SheetMutationJson {
  if (!isObjectList(m) || (m.params as RulesSetParams).kind !== 'pictures') return m
  const p = m.params as RulesSetParams
  return { ...m, params: { ...p, list: (Array.isArray(p.list) ? p.list : []).map((x: Record<string, unknown>) => { const { data: _data, ...rest } = x; return rest }) } }
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
