import { randomUUID } from 'node:crypto'
import type { ICellData, IWorkbookData } from '@univerjs/core'
import { IResourceManagerService, UniverInstanceType } from '@univerjs/core'
import { headlessSheet, type HeadlessSheet } from 'work-kit/sheet/engine'
import { formulaLexer, rebase, type SuggestionCell } from 'work-kit/sheet/suggest'
import type { SheetCellJson, SheetMutationJson, SheetRevision, SheetSuggestion } from '@shared/contract-work-sheets'
import type { Principal } from '@shared/work/ids'
import { colName, parseA1, rangeCells, READ_MAX_CELLS } from '../a1'
import { diffWorkbooks } from '../diff'
import { flatText, mutationsOf, SET_RANGE_VALUES, STRUCTURAL, type CellWrite } from '../mutations'
import { moveThrough } from './live'
import { NOTES_RESOURCE, noteMutations, ruleMutations, sheetNotes } from './rules'
import { heldOf, layOn, listMisfit, objectMutations, withHeld, type HeldObjects } from './objects'
import { isObjectList } from '../../../../../shared/work/sheets'
import { SNAPSHOT_EVERY, type Op, type SheetBackend, type StoredSuggestion } from './backends'
import { createRules } from 'work-kit/sheet/rules'
import { guestMisfit } from './guest'
import type { A1Cell, HostAnswer, SheetRef, Which, RulesHeld } from './wire'

type Box = { startRow: number; endRow: number; startColumn: number; endColumn: number }

/**
 * The Work service's host engine for the sheets it holds (architecture §9.1,
 * docs/agents/work-sheets.md "Sheets the service holds"): one headless Univer
 * per open sheet, kept at the store's newest op. Every write goes to the store
 * first, compare-and-set on its revision, then into the engine; agents read
 * its computed values; a suggestion is rebased over every op that lands after
 * it; a snapshot is cut every 500 ops. Its engines mount the grid's data
 * plugins (`rules`, `notes`), so a conditional format, a validation, a filter,
 * a defined name or a note made in the grid is replayed, kept in the snapshot
 * and restored; so is text in more than one style, a cell's own document.
 */

/** Every engine the host makes: with the rule, note and page plugins, or their ops would not apply and their rules, notes and page set-ups would leave the snapshot. */
const ENGINE = { rules: true, notes: true, pages: true } as const

/** What each engine holds that Univer does not: its charts and pictures (objects.ts). */
const kept = new WeakMap<HeadlessSheet, HeldObjects>()
/** An engine over a snapshot, with the objects the snapshot carries. */
function engineOf(snapshot: IWorkbookData): HeadlessSheet {
  const engine = headlessSheet('work', snapshot, ENGINE)
  kept.set(engine, heldOf(snapshot))
  return engine
}
/** The engine's workbook as a snapshot, its charts and pictures laid in. */
const savedOf = (engine: HeadlessSheet): IWorkbookData => withHeld(engine.workbook.save(), kept.get(engine) ?? heldOf(null))

interface Open {
  key: string
  backend: SheetBackend
  engine: HeadlessSheet
  unitId: string
  title: string
  shared: boolean
  sector?: string
  rev: number
  snapRev: number
}

/** One sheet's calls one after another: a sheet's ops have one order. */
class Lane {
  private tail: Promise<unknown> = Promise.resolve()
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn)
    this.tail = next.catch(() => {})
    return next
  }
}

export const refKey = (ref: SheetRef): string => ('lifeos' in ref ? `lifeos:${ref.lifeos}` : `tcsheet:${ref.tcsheet}`)

const content = (c: ICellData | null | undefined): SheetCellJson | null => {
  if (!c) return null
  const out: SheetCellJson = {}
  if (c.f) out.f = c.f
  else if (c.v !== undefined && c.v !== null && c.v !== '') out.v = c.v as SheetCellJson['v']
  return out.f !== undefined || out.v !== undefined ? out : null
}

const toSuggestion = (s: StoredSuggestion): SheetSuggestion => ({
  id: s.id,
  changeSet: s.changeSet,
  by: s.by as Principal,
  sheet: s.sheet,
  row: s.row,
  col: s.col,
  base: s.base,
  proposed: s.proposed,
  state: s.state,
  ...(s.reason ? { reason: s.reason } : {})
})

/** Ops that landed on a sheet, by whoever wrote them: what the live route sends to the sockets on it. */
export type Committed = { key: string; rev: number; by: string; mutations: SheetMutationJson[] }

export class SheetHost {
  private sheets = new Map<string, Promise<Open>>()
  private lanes = new Map<string, Lane>()
  private listeners = new Set<(c: Committed) => void>()

  onCommit(fn: (c: Committed) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  constructor(private backendOf: (ref: SheetRef) => SheetBackend) {}

  private lane(key: string): Lane {
    let l = this.lanes.get(key)
    if (!l) this.lanes.set(key, (l = new Lane()))
    return l
  }

  /** Forgets a sheet's engine; the next call loads it again from the store. */
  private drop(o: Open): void {
    if (this.sheets.get(o.key) && this.loaded.get(o.key) === o) {
      this.sheets.delete(o.key)
      this.loaded.delete(o.key)
    }
    o.engine.dispose()
  }

  /** Engines not asked for in this long are let go: the service holds what is being worked on. */
  static IDLE_MS = 10 * 60_000
  private used = new Map<string, number>()
  private loaded = new Map<string, Open>()
  private sweep(now: number): void {
    for (const [key, at] of this.used) {
      if (now - at < SheetHost.IDLE_MS) continue
      const o = this.loaded.get(key)
      this.used.delete(key)
      // Only from its own lane, so no call is using it.
      if (o) void this.lane(key).run(async () => this.used.has(key) || this.drop(o))
    }
  }

  /** Runs `fn` on the sheet, in its lane, with the engine caught up to the store. */
  private with<T>(ref: SheetRef, fn: (o: Open) => Promise<T>): Promise<T> {
    const key = refKey(ref)
    const now = Date.now()
    this.sweep(now)
    this.used.set(key, now)
    return this.lane(key).run(async () => {
      let p = this.sheets.get(key)
      if (!p) {
        p = this.load(ref)
        this.sheets.set(key, p)
        p.then((o) => this.loaded.set(key, o)).catch(() => this.sheets.delete(key))
      }
      const o = await p
      // Another writer of the same store (the worker's direct LifeOS calls never append ops, but a second service would): catch up.
      const later = await o.backend.opsAfter(o.rev)
      if (later.length) this.replay(o, later)
      return fn(o)
    })
  }

  private async load(ref: SheetRef): Promise<Open> {
    const backend = this.backendOf(ref)
    const loaded = await backend.load()
    const engine = engineOf(loaded.snapshot)
    const o: Open = { key: refKey(ref), backend, engine, unitId: engine.workbook.getId(), title: loaded.title, shared: loaded.shared, sector: loaded.sector, rev: loaded.snapRev, snapRev: loaded.snapRev }
    this.replay(o, await backend.opsAfter(loaded.snapRev))
    await engine.settled()
    return o
  }

  private applyTo(engine: HeadlessSheet, unitId: string, mutations: readonly SheetMutationJson[]): void {
    const held = kept.get(engine)
    for (const m of mutations) {
      // A sheet's names as they stood before the mutation: a rename is read after it ran.
      const names = held ? new Map(engine.workbook.getSheets().map((x) => [x.getSheetId(), x.getSheetName()])) : null
      // A tab's chart or picture list is ours, not Univer's: it is laid beside the engine.
      if (!isObjectList(m)) engine.api.syncExecuteCommand(m.id, { ...(m.params as object), unitId }, { fromCollab: true })
      if (held && names) layOn(held, m, (id) => names.get(id))
    }
  }
  private replay(o: Open, ops: readonly Op[]): void {
    for (const op of ops) {
      this.applyTo(o.engine, o.unitId, op.mutations)
      o.rev = op.rev
    }
  }

  /** The cell as it is now, by sheet id: what rebase and suggestions read. */
  private cell(o: Open, sheet: string, row: number, col: number): ICellData | null {
    return o.engine.workbook.getSheetBySheetId(sheet)?.getSheet().getCellRaw(row, col) ?? null
  }
  private sheetByName(o: Open, name: string | undefined): { id: string; name: string } {
    const sheets = o.engine.workbook.getSheets()
    const s = name === undefined ? sheets[0] : sheets.find((x) => x.getSheetName() === name)
    if (!s) throw new Error(name === undefined ? 'The workbook has no sheets.' : `There is no sheet named ${name}. Sheets: ${sheets.map((x) => x.getSheetName()).join(', ')}.`)
    return { id: s.getSheetId(), name: s.getSheetName() }
  }

  private async suggestionsOf(o: Open): Promise<StoredSuggestion[]> {
    return (await o.backend.suggestions()).filter((s) => s.state === 'pending' || s.state === 'conflict' || s.state === 'orphaned')
  }

  /**
   * Appends ops at `baseRev` and brings the engine and the open suggestions along: each moves with
   * the rows and columns inserted or removed before it, and turns `conflict` when its cell no longer
   * holds what the agent saw, `orphaned` when its cell is gone.
   */
  private async commit(o: Open, baseRev: number, ops: { by: string; mutations: SheetMutationJson[] }[]): Promise<{ rev: number } | { conflict: true; rev: number }> {
    if (baseRev !== o.rev) return { conflict: true, rev: o.rev }
    const all = ops.flatMap((op) => op.mutations)
    const open = await this.suggestionsOf(o)
    // Names as the formulas being moved wrote them: the sheets before these mutations.
    const names = new Map(o.engine.workbook.getSheets().map((s) => [s.getSheetName(), s.getSheetId()]))
    // Into the engine first: an op it cannot apply is never stored, so it can never stop the sheet
    // from loading. The engine then holds an op the store may refuse, so any failure from here on
    // drops it, and the next call loads the sheet again from the store.
    try {
      this.applyTo(o.engine, o.unitId, all)
    } catch (err) {
      this.drop(o)
      throw new Error(`That change could not be applied: ${err instanceof Error ? err.message : String(err)}`)
    }
    let got: { rev: number } | { stale: number }
    try {
      got = await o.backend.append(baseRev, ops)
    } catch (err) {
      this.drop(o)
      throw err
    }
    if ('stale' in got) {
      this.drop(o)
      return { conflict: true, rev: got.stale }
    }
    o.rev = got.rev
    let at = baseRev
    for (const op of ops) for (const fn of this.listeners) fn({ key: o.key, rev: ++at, by: op.by, mutations: op.mutations })
    if (open.length) {
      const cells: SuggestionCell[] = open.map((s) => ({ id: s.id, changeSet: s.changeSet, sheet: s.sheet, row: s.row, column: s.col, base: s.base as ICellData | null, proposed: s.proposed as ICellData | null, state: s.state }))
      const moved = rebase(cells, all, (sheet, row, col) => this.cell(o, sheet, row, col), formulaLexer(), { sheetId: (name) => names.get(name) })
      const updates = moved.flatMap((m, i) => {
        const was = open[i]
        const u: Parameters<SheetBackend['setSuggestions']>[0][number] = { id: was.id }
        if (m.state !== was.state) u.state = m.state
        if (m.row !== was.row) u.row = m.row
        if (m.column !== was.col) u.col = m.column
        if (JSON.stringify(m.base) !== JSON.stringify(was.base)) u.base = m.base as SheetCellJson | null
        if (JSON.stringify(m.proposed) !== JSON.stringify(was.proposed)) u.proposed = m.proposed as SheetCellJson | null
        return Object.keys(u).length > 1 ? [u] : []
      })
      await o.backend.setSuggestions(updates)
    }
    if (o.rev - o.snapRev >= SNAPSHOT_EVERY) {
      await o.engine.settled()
      await o.backend.cutSnapshot(o.rev, savedOf(o.engine))
      o.snapRev = o.rev
    }
    return { rev: o.rev }
  }

  // ── what main and the routes ask ─────────────────────────────────

  /** `shared` is read afresh from the store on every open, never kept from the load: an agent's write is decided by it, and a guest link made since the load turns it on. */
  open(ref: SheetRef): Promise<HostAnswer<'open'>> {
    return this.with(ref, async (o) => {
      o.shared = await o.backend.sharedNow()
      const sheets = o.engine.workbook.getSheets().map((sheet) => ({ id: sheet.getSheetId(), name: sheet.getSheetName() }))
      return { title: o.title, rev: o.rev, shared: o.shared, suggestions: (await this.suggestionsOf(o)).map(toSuggestion), unit: o.unitId, sheets, rules: this.rulesHeld(o, sheets) }
    })
  }

  /** The row's sector (LifeOS), for the route to hold a caller's fence against. */
  sectorOf(ref: SheetRef): Promise<string | undefined> {
    return this.with(ref, async (o) => o.sector)
  }

  /** The workbook as Univer's JSON at the newest op, whole: what the live route sends on hello. */
  snapshotJson(ref: SheetRef): Promise<{ rev: number; json: string }> {
    return this.with(ref, async (o) => {
      await o.engine.settled()
      return { rev: o.rev, json: JSON.stringify(savedOf(o.engine)) }
    })
  }

  /** The serialized workbook by sheet and rev, so a large one is handed over in frames, not one answer. */
  private serialized = new Map<string, { rev: number; bytes: Buffer }>()

  /** Bytes `offset` to `offset + length` of the workbook's JSON at the newest op; `rev` must be it. */
  snapshot(ref: SheetRef, rev: number, offset: number, length: number): Promise<HostAnswer<'snapshot'>> {
    return this.with(ref, async (o) => {
      if (rev !== o.rev) throw new Error('The sheet moved on since it was opened: open it again.')
      let s = this.serialized.get(o.key)
      if (!s || s.rev !== o.rev) {
        await o.engine.settled()
        s = { rev: o.rev, bytes: Buffer.from(JSON.stringify(savedOf(o.engine)), 'utf8') }
        this.serialized.set(o.key, s)
      }
      const part = s.bytes.subarray(offset, offset + length)
      if (offset + part.length >= s.bytes.length) this.serialized.delete(o.key)
      return { rev: o.rev, data: part.toString('base64'), size: s.bytes.length }
    })
  }

  since(ref: SheetRef, rev: number): Promise<HostAnswer<'since'>> {
    return this.with(ref, async (o) => {
      if (rev > o.rev) return { rev: o.rev, reload: true as const }
      const ops = await o.backend.opsAfter(rev)
      return { rev: o.rev, ops: ops.map((op) => ({ rev: op.rev, by: op.by, mutations: op.mutations })) }
    })
  }

  /**
   * The owner's or a client's edit, made on the workbook at `baseRev`. One made on an older
   * revision is moved through the ops it missed (rows and columns inserted or deleted before it);
   * one that cannot be moved answers a conflict, and the editor reloads.
   */
  apply(ref: SheetRef, baseRev: number, mutations: SheetMutationJson[], by: string): Promise<HostAnswer<'apply'>> {
    return this.with(ref, async (o) => {
      if (baseRev > o.rev) return { conflict: true as const, rev: o.rev }
      let ops = mutations
      if (baseRev < o.rev) {
        const moved = moveThrough(mutations, (await o.backend.opsAfter(baseRev)).flatMap((op) => op.mutations))
        if (!moved) return { conflict: true as const, rev: o.rev }
        ops = moved
      }
      // A guest's ops are held to the sheet as it stands: the route checks their shape, only the engine knows the sheet.
      if (by.startsWith('guest:')) {
        const why = guestMisfit(ops, (id) => {
          const sheet = o.engine.workbook.getSheetBySheetId(id)?.getSheet()
          return sheet ? { rows: sheet.getRowCount(), columns: sheet.getColumnCount(), merges: sheet.getMergeData() } : null
        })
        if (why) throw new Error(why)
      }
      // A tab's chart or picture list is held to its shape and a made picture's bytes to their bounds, before anything is kept.
      const held = kept.get(o.engine)
      for (const m of ops) {
        const why = held && isObjectList(m) ? listMisfit(held, m) : null
        if (why) throw new Error(why)
      }
      return this.commit(o, o.rev, [{ by, mutations: ops }])
    })
  }

  /** The names, filters and validated ranges the sheet holds now, read from the engine's own models (work-kit's `createRules`). */
  private rulesHeld(o: Open, sheets: readonly { id: string }[]): RulesHeld {
    const rules = createRules(o.engine.api, () => true)
    const box = (r: Box): Box => ({ startRow: r.startRow, endRow: r.endRow, startColumn: r.startColumn, endColumn: r.endColumn })
    const held: RulesHeld = { names: rules.names.list().map((n) => ({ name: n.name, ...(n.localSheetId && sheets.some((x) => x.id === n.localSheetId) ? { scope: n.localSheetId } : {}) })), filters: {}, validations: {} }
    for (const { id } of sheets) {
      const filter = rules.filter.get(id)
      if (filter) held.filters[id] = box(filter.ref)
      const ranges = rules.validation.list(id).flatMap((rule) => rule.ranges.map(box))
      if (ranges.length) held.validations[id] = ranges
    }
    return held
  }

  range(ref: SheetRef, range: string): Promise<HostAnswer<'range'>> {
    return this.with(ref, async (o) => {
      const r = parseA1(range)
      if (!r) throw new Error(`${range} is not a range: write it like B4:D9 or 'Q1 Budget'!B4:D9.`)
      if (rangeCells(r) > READ_MAX_CELLS) throw new Error(`A read is at most ${READ_MAX_CELLS.toLocaleString('en')} cells: ask for a smaller range.`)
      await o.engine.settled()
      const sheet = this.sheetByName(o, r.sheet)
      // The notes as the engine keeps them (its resources, not a whole snapshot of the cells).
      const kept = o.engine.univer.__getInjector().get(IResourceManagerService).getResourcesByType(o.unitId, UniverInstanceType.UNIVER_SHEET)
      const notes = sheetNotes(kept.find((x) => x.name === NOTES_RESOURCE)?.data, sheet.id)
      const cells: HostAnswer<'range'>['cells'] = []
      for (let row = r.startRow; row <= r.endRow; row++) {
        const line: HostAnswer<'range'>['cells'][number] = []
        for (let col = r.startColumn; col <= r.endColumn; col++) {
          const c = this.cell(o, sheet.id, row, col)
          // A cell made rich in the cell editor keeps its words in its document alone.
          const v = (c?.v === undefined || c.v === null) && c?.p && !c.f ? flatText(c) : c?.v
          const note = notes.get(`${row}:${col}`)
          line.push({ at: `${colName(col)}${row + 1}`, ...(v !== undefined && v !== null ? { v: v as string | number | boolean } : {}), ...(c?.f ? { f: c.f } : {}), ...(note !== undefined ? { note } : {}) })
        }
        cells.push(line)
      }
      return { sheet: sheet.name, cells }
    })
  }

  /** Writes cells now, or adds them as one change set of suggestions. */
  cells(ref: SheetRef, cells: A1Cell[], by: string, suggest: boolean, reason?: string, origin?: unknown): Promise<HostAnswer<'cells'>> {
    return this.with(ref, async (o) => {
      const at = cells.map((c) => {
        const r = parseA1(c.at)
        if (!r || r.startRow !== r.endRow || r.startColumn !== r.endColumn) throw new Error(`${c.at} is not one cell.`)
        const proposed: SheetCellJson | null = c.f !== undefined ? { f: c.f.startsWith('=') ? c.f : `=${c.f}` } : c.v === undefined || c.v === null || c.v === '' ? null : { v: c.v }
        return { sheet: this.sheetByName(o, r.sheet).id, row: r.startRow, col: r.startColumn, proposed }
      })
      if (suggest) {
        const changeSet = randomUUID()
        await o.backend.addSuggestions(changeSet, by, reason, at.map((c) => ({ ...c, base: content(this.cell(o, c.sheet, c.row, c.col)) })), origin)
        return { changeSetId: changeSet, count: at.length }
      }
      const got = await this.commit(o, o.rev, [{ by, mutations: mutationsOf(o.unitId, at.map((c) => ({ sheet: c.sheet, row: c.row, col: c.col, cell: c.proposed }))) }])
      if ('conflict' in got) throw new Error('The sheet changed while writing: try again.')
      return { rev: got.rev, count: at.length }
    })
  }

  review(ref: SheetRef, which: Which, verdict: 'accept' | 'reject'): Promise<HostAnswer<'review'>> {
    return this.with(ref, async (o) => {
      const open = await this.suggestionsOf(o)
      const picked = which === 'all' ? open : 'ids' in which ? open.filter((s) => which.ids.includes(s.id)) : open.filter((s) => s.changeSet === which.changeSet)
      const taken = verdict === 'accept' ? picked.filter((s) => s.state === 'pending') : picked
      // What can be taken is, and the rest stays as it is; refused in words only when the press could take nothing.
      if (verdict === 'accept' && which !== 'all' && 'ids' in which && taken.length === 0 && picked.length > 0) throw new Error('That cell changed since the agent saw it: reject it, or edit the cell yourself.')
      let rev: number | undefined
      if (verdict === 'accept' && taken.length) {
        const got = await this.commit(o, o.rev, [{ by: 'owner', mutations: mutationsOf(o.unitId, taken.map((s) => ({ sheet: s.sheet, row: s.row, col: s.col, cell: s.proposed }))) }])
        if ('conflict' in got) throw new Error('The sheet changed while accepting: try again.')
        rev = got.rev
      }
      await o.backend.setSuggestions(taken.map((s) => ({ id: s.id, state: verdict === 'accept' ? 'accepted' : 'rejected' })))
      return { ...(rev === undefined ? {} : { rev }), decided: taken.length }
    })
  }

  history(ref: SheetRef): Promise<HostAnswer<'history'>> {
    return this.with(ref, async (o) => {
      const ops = await o.backend.opsAfter(0)
      const revisions: SheetRevision[] = ops
        .slice(-500)
        .reverse()
        .map((op) => ({ rev: op.rev, at: op.at, by: op.by as Principal, label: labelOf(op.mutations) }))
      return { revisions: [...revisions, { rev: 0, at: ops[0]?.at ?? 0, by: 'file' as const, label: 'Made' }] }
    })
  }

  /** The workbook as revision `rev` left it, from the newest snapshot at or before it. */
  private async workbookAt(o: Open, rev: number): Promise<IWorkbookData> {
    if (rev === o.rev) {
      await o.engine.settled()
      return savedOf(o.engine)
    }
    if (rev > o.rev) throw new Error(`There is no revision ${rev} yet.`)
    const snap = await o.backend.snapshotAt(rev)
    const engine = engineOf(snap.data)
    try {
      const ops = (await o.backend.opsAfter(snap.rev)).filter((op) => op.rev <= rev)
      this.applyTo(engine, engine.workbook.getId(), ops.flatMap((op) => op.mutations))
      await engine.settled()
      return savedOf(engine)
    } finally {
      engine.dispose()
    }
  }

  compare(ref: SheetRef, from: number, to: number, max: number): Promise<HostAnswer<'compare'>> {
    return this.with(ref, async (o) => diffWorkbooks(await this.workbookAt(o, from), await this.workbookAt(o, to), max))
  }

  /**
   * Writes revision `rev`'s contents back as a new revision; a formula whose value moved is not
   * written, its formula is. Its rules (conditional formats, validations, filters, defined names)
   * and its notes come back too.
   */
  restore(ref: SheetRef, rev: number, by: string): Promise<HostAnswer<'restore'>> {
    return this.with(ref, async (o) => {
      const now = await this.workbookAt(o, o.rev)
      const then = await this.workbookAt(o, rev)
      const diff = diffWorkbooks(now, then, Number.MAX_SAFE_INTEGER)
      // A cell of text runs is written whole, its runs with it: the same words in other runs are no difference the
      // compare sees, and a cell of runs holds no value it would write back.
      const rich = richWrites(now, then)
      const runs = new Set(rich.map((w) => `${w.sheet}:${w.row}:${w.col}`))
      const writes = [
        ...diff.cells
          .filter((c) => !runs.has(`${c.sheet}:${c.row}:${c.col}`) && (c.before?.f || c.after?.f ? c.before?.f !== c.after?.f : true))
          .map((c) => ({ sheet: c.sheet, row: c.row, col: c.col, cell: c.after?.f ? { f: c.after.f } : c.after })),
        ...rich
      ]
      const rules = [...ruleMutations(o.unitId, now, then), ...noteMutations(o.unitId, now, then), ...objectMutations(o.unitId, now, then)]
      if (!writes.length && !rules.length) return { rev: o.rev }
      const got = await this.commit(o, o.rev, [{ by, mutations: [...(writes.length ? mutationsOf(o.unitId, writes) : []), ...rules] }])
      if ('conflict' in got) throw new Error('The sheet changed while restoring: try again.')
      return { rev: got.rev }
    })
  }

  /** Forget a sheet's engine (a test, or the service going down). */
  close(): void {
    for (const p of this.sheets.values()) void p.then((o) => o.engine.dispose()).catch(() => {})
    this.sheets.clear()
    this.loaded.clear()
    this.used.clear()
  }
}

function labelOf(mutations: readonly SheetMutationJson[]): string {
  if (mutations.some((m) => STRUCTURAL.has(m.id))) {
    const id = mutations.find((m) => STRUCTURAL.has(m.id))!.id
    return id.includes('insert-row') ? 'Inserted rows' : id.includes('remove-rows') ? 'Deleted rows' : id.includes('insert-col') ? 'Inserted columns' : id.includes('remove-col') ? 'Deleted columns' : 'Moved cells'
  }
  // A tab's chart or picture list alone: "Chart", "Picture" (the labels an opened Excel file's revisions take).
  if (mutations.length && mutations.every(isObjectList)) {
    const kinds = new Set(mutations.map((m) => (m.params as { kind?: string }).kind))
    return kinds.size === 1 ? (kinds.has('charts') ? 'Chart' : 'Picture') : 'Charts and pictures'
  }
  if (mutations.length && mutations.every((m) => m.id.endsWith('-note') || m.id === 'sheet.mutation.update-note-position')) return mutations.length === 1 && mutations[0].id.endsWith('remove-note') ? 'Removed a note' : 'A note'
  let n = 0
  for (const m of mutations) if (m.id === SET_RANGE_VALUES) for (const cols of Object.values((m.params as { cellValue?: Record<string, Record<string, unknown>> }).cellValue ?? {})) n += Object.keys(cols ?? {}).length
  return n === 1 ? '1 cell' : n ? `${n} cells` : 'Changed the sheet'
}

/**
 * Each cell whose text runs differ between the workbook now and the one restored (a rich cell's document; a plain cell
 * has none), as the restored one holds it: its words and runs, or none over a cell that has them now.
 */
export function richWrites(now: IWorkbookData, then: IWorkbookData): CellWrite[] {
  const out: CellWrite[] = []
  for (const id of new Set([...now.sheetOrder, ...then.sheetOrder])) {
    const a = now.sheets[id]?.cellData ?? {}
    const b = then.sheets[id]?.cellData ?? {}
    for (const r of new Set([...Object.keys(a), ...Object.keys(b)]))
      for (const c of new Set([...Object.keys(a[Number(r)] ?? {}), ...Object.keys(b[Number(r)] ?? {})])) {
        const was = a[Number(r)]?.[Number(c)]?.p ?? null
        const cell = b[Number(r)]?.[Number(c)]
        const doc = cell?.p ?? null
        if (JSON.stringify(was) === JSON.stringify(doc)) continue
        out.push({ sheet: id, row: Number(r), col: Number(c), cell: cell ? ({ v: cell.v ?? null, f: cell.f ?? null, p: doc } as unknown as SheetCellJson) : null })
      }
  }
  return out
}
