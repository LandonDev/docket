import { randomUUID } from 'node:crypto'
import type { ICellData, IWorkbookData } from '@univerjs/core'
import { headlessSheet, type HeadlessSheet } from 'work-kit/sheet/engine'
import { formulaLexer, rebase, type SuggestionCell } from 'work-kit/sheet/suggest'
import type { SheetCellJson, SheetMutationJson, SheetRevision, SheetSuggestion } from '@shared/contract-work-sheets'
import type { Principal } from '@shared/work/ids'
import { colName, parseA1, rangeCells, READ_MAX_CELLS } from '../a1'
import { diffWorkbooks } from '../diff'
import { mutationsOf, SET_RANGE_VALUES, STRUCTURAL } from '../mutations'
import { moveThrough } from './live'
import { SNAPSHOT_EVERY, type Op, type SheetBackend, type StoredSuggestion } from './backends'
import type { A1Cell, HostAnswer, SheetRef, Which } from './wire'

/**
 * The Work service's host engine for the sheets it holds (architecture §9.1,
 * docs/agents/work-sheets.md "Sheets the service holds"): one headless Univer
 * per open sheet, kept at the store's newest op. Every write goes to the store
 * first, compare-and-set on its revision, then into the engine; agents read
 * its computed values; a suggestion is rebased over every op that lands after
 * it; a snapshot is cut every 500 ops.
 */

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
    const engine = headlessSheet('work', loaded.snapshot)
    const o: Open = { key: refKey(ref), backend, engine, unitId: engine.workbook.getId(), title: loaded.title, shared: loaded.shared, sector: loaded.sector, rev: loaded.snapRev, snapRev: loaded.snapRev }
    this.replay(o, await backend.opsAfter(loaded.snapRev))
    await engine.settled()
    return o
  }

  private applyTo(engine: HeadlessSheet, unitId: string, mutations: readonly SheetMutationJson[]): void {
    for (const m of mutations) {
      const params = { ...(m.params as object), unitId }
      engine.api.syncExecuteCommand(m.id, params, { fromCollab: true })
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
      await o.backend.cutSnapshot(o.rev, o.engine.workbook.save())
      o.snapRev = o.rev
    }
    return { rev: o.rev }
  }

  // ── what main and the routes ask ─────────────────────────────────

  open(ref: SheetRef): Promise<HostAnswer<'open'>> {
    return this.with(ref, async (o) => ({ title: o.title, rev: o.rev, shared: o.shared, suggestions: (await this.suggestionsOf(o)).map(toSuggestion) }))
  }

  /** The row's sector (LifeOS), for the route to hold a caller's fence against. */
  sectorOf(ref: SheetRef): Promise<string | undefined> {
    return this.with(ref, async (o) => o.sector)
  }

  /** The workbook as Univer's JSON at the newest op, whole: what the live route sends on hello. */
  snapshotJson(ref: SheetRef): Promise<{ rev: number; json: string }> {
    return this.with(ref, async (o) => {
      await o.engine.settled()
      return { rev: o.rev, json: JSON.stringify(o.engine.workbook.save()) }
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
        s = { rev: o.rev, bytes: Buffer.from(JSON.stringify(o.engine.workbook.save()), 'utf8') }
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
      return this.commit(o, o.rev, [{ by, mutations: ops }])
    })
  }

  range(ref: SheetRef, range: string): Promise<HostAnswer<'range'>> {
    return this.with(ref, async (o) => {
      const r = parseA1(range)
      if (!r) throw new Error(`${range} is not a range: write it like B4:D9 or 'Q1 Budget'!B4:D9.`)
      if (rangeCells(r) > READ_MAX_CELLS) throw new Error(`A read is at most ${READ_MAX_CELLS.toLocaleString('en')} cells: ask for a smaller range.`)
      await o.engine.settled()
      const sheet = this.sheetByName(o, r.sheet)
      const cells: HostAnswer<'range'>['cells'] = []
      for (let row = r.startRow; row <= r.endRow; row++) {
        const line: HostAnswer<'range'>['cells'][number] = []
        for (let col = r.startColumn; col <= r.endColumn; col++) {
          const c = this.cell(o, sheet.id, row, col)
          line.push({ at: `${colName(col)}${row + 1}`, ...(c?.v !== undefined && c.v !== null ? { v: c.v as string | number | boolean } : {}), ...(c?.f ? { f: c.f } : {}) })
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
      if (verdict === 'accept' && which !== 'all' && 'ids' in which && taken.length < picked.length) throw new Error('That cell changed since the agent saw it: reject it, or edit the cell yourself.')
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
      return o.engine.workbook.save()
    }
    if (rev > o.rev) throw new Error(`There is no revision ${rev} yet.`)
    const snap = await o.backend.snapshotAt(rev)
    const engine = headlessSheet('work', snap.data)
    try {
      const ops = (await o.backend.opsAfter(snap.rev)).filter((op) => op.rev <= rev)
      this.applyTo(engine, engine.workbook.getId(), ops.flatMap((op) => op.mutations))
      await engine.settled()
      return engine.workbook.save()
    } finally {
      engine.dispose()
    }
  }

  compare(ref: SheetRef, from: number, to: number, max: number): Promise<HostAnswer<'compare'>> {
    return this.with(ref, async (o) => diffWorkbooks(await this.workbookAt(o, from), await this.workbookAt(o, to), max))
  }

  /** Writes revision `rev`'s contents back as a new revision; a formula whose value moved is not written, its formula is. */
  restore(ref: SheetRef, rev: number, by: string): Promise<HostAnswer<'restore'>> {
    return this.with(ref, async (o) => {
      const diff = diffWorkbooks(await this.workbookAt(o, o.rev), await this.workbookAt(o, rev), Number.MAX_SAFE_INTEGER)
      const writes = diff.cells
        .filter((c) => (c.before?.f || c.after?.f ? c.before?.f !== c.after?.f : true))
        .map((c) => ({ sheet: c.sheet, row: c.row, col: c.col, cell: c.after?.f ? { f: c.after.f } : c.after }))
      if (!writes.length) return { rev: o.rev }
      const got = await this.commit(o, o.rev, [{ by, mutations: mutationsOf(o.unitId, writes) }])
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
  let n = 0
  for (const m of mutations) if (m.id === SET_RANGE_VALUES) for (const cols of Object.values((m.params as { cellValue?: Record<string, Record<string, unknown>> }).cellValue ?? {})) n += Object.keys(cols ?? {}).length
  return n === 1 ? '1 cell' : n ? `${n} cells` : 'Changed the sheet'
}
