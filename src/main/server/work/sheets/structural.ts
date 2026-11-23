import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import type { SheetMutationJson } from '@shared/contract-work-sheets'
import type { Converter } from '../formats/jobs'
import { sheetStopWords } from '../../../../shared/work/sheets'
import { moveFacts, moveRefusal, moveRefusalWords } from './moves'
import { editsOf, FORMATTING, formatsOf, NotSaved, SET_RANGE_VALUES, UNSAVED } from './mutations'
import { readZip } from './patch/zip'
import type { EditSpec } from './patch/patch'
import { STRUCTURAL_PY } from './structuralScript'

/**
 * Structural edits on an opened package (docs/agents/work-sheets.md
 * "Structural edits"; architecture §9.1, the sheet report §8 item 7):
 * inserting or deleting rows and columns, a sort, adding, removing or
 * renaming a sheet. A row insert touches up to millions of places in a
 * package, so LibreOffice headless does it on the host and writes the
 * package again; graft.ts then puts back what LibreOffice drops. Cell
 * contents in the same edit (a fill, the formulas the grid moved, typed
 * values) still go through the patch writer, in the order they came.
 */

export type StructuralOp =
  | {
      op: 'insertRows' | 'removeRows' | 'insertCols' | 'removeCols'
      sheet: string
      at: number
      count: number
    }
  | {
      op: 'reorder'
      sheet: string
      r1: number
      c1: number
      r2: number
      c2: number
      order: Record<string, number>
    }
  | {
      /** a block cut and dropped with its top left at `to`!`row`,`col`: what stood there is gone */
      op: 'moveRange'
      sheet: string
      r1: number
      c1: number
      r2: number
      c2: number
      to: string
      row: number
      col: number
    }
  | {
      /** `count` rows or columns from `at` put before `to` (counted as the sheet stood before): the others close up */
      op: 'moveRows' | 'moveCols'
      sheet: string
      at: number
      count: number
      to: number
    }
  | { op: 'addSheet'; name: string; at: number }
  | { op: 'removeSheet'; sheet: string }
  | { op: 'renameSheet'; sheet: string; to: string }

const name = z.string().min(1).max(200)
const n = z.number().int().min(0).max(1_048_576)
export const StructuralOpSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.enum(['insertRows', 'removeRows', 'insertCols', 'removeCols']),
    sheet: name,
    at: n,
    count: z.number().int().min(1).max(100_000)
  }),
  z.object({
    op: z.literal('reorder'),
    sheet: name,
    r1: n,
    c1: n,
    r2: n,
    c2: n,
    order: z.record(z.string().regex(/^\d+$/), n)
  }),
  z.object({ op: z.literal('moveRange'), sheet: name, r1: n, c1: n, r2: n, c2: n, to: name, row: n, col: n }),
  z.object({ op: z.enum(['moveRows', 'moveCols']), sheet: name, at: n, count: z.number().int().min(1).max(100_000), to: n }),
  z.object({ op: z.literal('addSheet'), name, at: n }),
  z.object({ op: z.literal('removeSheet'), sheet: name }),
  z.object({ op: z.literal('renameSheet'), sheet: name, to: name })
])
const OpsSchema = z.array(StructuralOpSchema).min(1).max(500)

/**
 * One step of an edit: LibreOffice's structural ops, or the patch writer's cell writes with the
 * formatting mutations that came with them (`formats`, each named by its tab: mutations.ts
 * `formatsOf`).
 */
export type Step =
  { kind: 'structural'; ops: StructuralOp[] } | { kind: 'cells'; edits: EditSpec[]; formats: SheetMutationJson[] }

/** The grid's moves: a block dragged or cut and pasted, and whole rows or columns dragged. */
export const MOVE_IDS = ['sheet.mutation.move-range', 'sheet.mutation.move-rows', 'sheet.mutation.move-columns'] as const
const isMove = (op: StructuralOp): boolean => op.op === 'moveRange' || op.op === 'moveRows' || op.op === 'moveCols'

/** The Univer mutations a package saves through LibreOffice. */
export const STRUCTURAL_IDS = new Set([
  'sheet.mutation.insert-row',
  'sheet.mutation.remove-rows',
  'sheet.mutation.insert-col',
  'sheet.mutation.remove-col',
  'sheet.mutation.reorder-range',
  'sheet.mutation.insert-sheet',
  'sheet.mutation.remove-sheet',
  'sheet.mutation.set-worksheet-name',
  ...MOVE_IDS
])
/** What the grid works out again from content: nothing to save. */
const DERIVED = new Set(['sheet.mutation.set-worksheet-row-auto-height'])

interface Range {
  startRow: number
  endRow: number
  startColumn: number
  endColumn: number
}

/**
 * The steps an edit takes, in order, with `names` (Univer sheet id → tab name, as the file
 * stood before) followed through renames, new sheets and removals.
 */
export function planOf(
  mutations: readonly SheetMutationJson[],
  names: Map<string, string>
): Step[] {
  const steps: Step[] = []
  const nameOf = (id: string): string => {
    const got = names.get(id)
    if (!got) throw new NotSaved('That sheet is not in the file.')
    return got
  }
  const push = (op: StructuralOp): void => {
    const last = steps.at(-1)
    // A move is a step of its own: what it may move is judged on the file as the step finds it (moves.ts).
    if (last?.kind === 'structural' && !isMove(op) && !last.ops.some(isMove)) last.ops.push(op)
    else steps.push({ kind: 'structural', ops: [op] })
  }
  /** The cells step being gathered: the last step when it is one, else a new one. */
  const cells = (): Extract<Step, { kind: 'cells' }> => {
    const last = steps.at(-1)
    if (last?.kind === 'cells') return last
    const made = { kind: 'cells' as const, edits: [], formats: [] }
    steps.push(made)
    return made
  }
  for (const m of mutations) {
    if (DERIVED.has(m.id)) continue
    if (FORMATTING.has(m.id)) {
      // A merge made or parted, a width or a height he set: the format edits carry it, in the order it came.
      const formats = formatsOf([m], (id) => names.get(id))
      if (formats.length) cells().formats.push(...formats)
      continue
    }
    const p = m.params as {
      subUnitId: string
      range?: Range
      sourceRange?: Range
      targetRange?: Range
      fromRange?: Range
      toRange?: Range
      from?: { subUnitId: string }
      to?: { subUnitId: string }
      order?: Record<string, number>
      index?: number
      sheet?: { id: string; name: string }
      name?: string
    }
    if (m.id === SET_RANGE_VALUES) {
      const edits = editsOf([m], (id) => names.get(id))
      // Every style is kept, in the order it came: a press made while an insert was saving rides the same batch, and the
      // style the grid gave a row it inserted is written over LibreOffice's own choice, so the file is what the grid shows.
      const formats = formatsOf([m], (id) => names.get(id))
      if (!edits.length && !formats.length) continue
      const step = cells()
      step.edits.push(...edits)
      step.formats.push(...formats)
      continue
    }
    if (!STRUCTURAL_IDS.has(m.id)) throw new NotSaved(m.id.includes('.move-') ? UNSAVED.moved : UNSAVED.other)
    const r = p.range
    switch (m.id) {
      case 'sheet.mutation.insert-row':
        push({
          op: 'insertRows',
          sheet: nameOf(p.subUnitId),
          at: r!.startRow,
          count: r!.endRow - r!.startRow + 1
        })
        break
      case 'sheet.mutation.remove-rows':
        push({
          op: 'removeRows',
          sheet: nameOf(p.subUnitId),
          at: r!.startRow,
          count: r!.endRow - r!.startRow + 1
        })
        break
      case 'sheet.mutation.insert-col':
        push({
          op: 'insertCols',
          sheet: nameOf(p.subUnitId),
          at: r!.startColumn,
          count: r!.endColumn - r!.startColumn + 1
        })
        break
      case 'sheet.mutation.remove-col':
        push({
          op: 'removeCols',
          sheet: nameOf(p.subUnitId),
          at: r!.startColumn,
          count: r!.endColumn - r!.startColumn + 1
        })
        break
      case 'sheet.mutation.reorder-range':
        push({
          op: 'reorder',
          sheet: nameOf(p.subUnitId),
          r1: r!.startRow,
          c1: r!.startColumn,
          r2: r!.endRow,
          c2: r!.endColumn,
          order: Object.fromEntries(Object.entries(p.order ?? {}).map(([k, v]) => [k, Number(v)]))
        })
        break
      case 'sheet.mutation.move-range': {
        // Only the move: the cells it carries, and the formulas, merges and rules the grid moved beside it in the same
        // turn, LibreOffice moves itself (the canvas sends the move alone), and every grid then loads the file again.
        const f = p.fromRange!
        const t = p.toRange!
        const sheet = nameOf(p.from!.subUnitId)
        const to = nameOf(p.to!.subUnitId)
        if (sheet === to && f.startRow === t.startRow && f.startColumn === t.startColumn) break
        push({ op: 'moveRange', sheet, r1: f.startRow, c1: f.startColumn, r2: f.endRow, c2: f.endColumn, to, row: t.startRow, col: t.startColumn })
        break
      }
      case 'sheet.mutation.move-rows':
      case 'sheet.mutation.move-columns': {
        const rows = m.id === 'sheet.mutation.move-rows'
        const f = p.sourceRange!
        const at = rows ? f.startRow : f.startColumn
        const count = (rows ? f.endRow : f.endColumn) - at + 1
        // the line the block goes before, counted as the sheet stood before the move (Univer's `targetRange`)
        const to = rows ? p.targetRange!.startRow : p.targetRange!.startColumn
        if (to >= at && to <= at + count) break
        push({ op: rows ? 'moveRows' : 'moveCols', sheet: nameOf(p.subUnitId), at, count, to })
        break
      }
      case 'sheet.mutation.insert-sheet': {
        const sheet = p.sheet!
        if ([...names.values()].includes(sheet.name))
          throw new NotSaved(`There is a sheet named ${sheet.name} already.`)
        names.set(sheet.id, sheet.name)
        push({ op: 'addSheet', name: sheet.name, at: p.index ?? names.size })
        // A sheet that comes with cells (a copy) gets them through the patch writer, after it exists.
        const cells = (sheet as { cellData?: Record<string, Record<string, unknown>> }).cellData
        if (cells && Object.keys(cells).length) {
          const edits = editsOf(
            [{ id: SET_RANGE_VALUES, params: { subUnitId: sheet.id, cellValue: cells } }],
            (id) => names.get(id)
          )
          if (edits.length) steps.push({ kind: 'cells', edits, formats: [] })
        }
        break
      }
      case 'sheet.mutation.remove-sheet':
        push({ op: 'removeSheet', sheet: nameOf(p.subUnitId) })
        names.delete(p.subUnitId)
        break
      case 'sheet.mutation.set-worksheet-name': {
        const from = nameOf(p.subUnitId)
        if (from !== p.name) push({ op: 'renameSheet', sheet: from, to: p.name! })
        names.set(p.subUnitId, p.name!)
        break
      }
    }
  }
  return steps
}

/** Whether an edit needs LibreOffice. */
export const isStructural = (mutations: readonly SheetMutationJson[]): boolean =>
  mutations.some((m) => STRUCTURAL_IDS.has(m.id))

/**
 * Where a cell of the file as it stood lands after the ops: its sheet's name then, its row and
 * column, or null when its row, column or sheet went. What graft.ts uses to put back the cell
 * marks LibreOffice drops.
 */
export function mapCell(
  ops: readonly StructuralOp[],
  sheet: string,
  row: number,
  col: number
): { sheet: string; row: number; col: number } | null {
  let at = { sheet, row, col }
  for (const op of ops) {
    if (op.op === 'renameSheet') {
      if (op.sheet === at.sheet) at = { ...at, sheet: op.to }
      continue
    }
    if (op.op === 'removeSheet') {
      if (op.sheet === at.sheet) return null
      continue
    }
    if (op.op === 'moveRange') {
      const inside = at.sheet === op.sheet && at.row >= op.r1 && at.row <= op.r2 && at.col >= op.c1 && at.col <= op.c2
      if (inside) {
        at = { sheet: op.to, row: op.row + at.row - op.r1, col: op.col + at.col - op.c1 }
        continue
      }
      // what stood where the block landed is gone
      const under = at.sheet === op.to && at.row >= op.row && at.row <= op.row + op.r2 - op.r1 && at.col >= op.col && at.col <= op.col + op.c2 - op.c1
      if (under) return null
      continue
    }
    if (op.op === 'addSheet' || op.sheet !== at.sheet) continue
    switch (op.op) {
      case 'moveRows':
        at = { ...at, row: moveLine(at.row, op) }
        break
      case 'moveCols':
        at = { ...at, col: moveLine(at.col, op) }
        break
      case 'insertRows':
        if (at.row >= op.at) at = { ...at, row: at.row + op.count }
        break
      case 'removeRows':
        if (at.row >= op.at + op.count) at = { ...at, row: at.row - op.count }
        else if (at.row >= op.at) return null
        break
      case 'insertCols':
        if (at.col >= op.at) at = { ...at, col: at.col + op.count }
        break
      case 'removeCols':
        if (at.col >= op.at + op.count) at = { ...at, col: at.col - op.count }
        else if (at.col >= op.at) return null
        break
      case 'reorder':
        if (at.row >= op.r1 && at.row <= op.r2 && at.col >= op.c1 && at.col <= op.c2) {
          const to = Object.entries(op.order).find(([, from]) => from === at.row)
          if (to) at = { ...at, row: Number(to[0]) }
        }
        break
    }
  }
  return at
}

/** A range of a sheet, zero-based and inclusive. */
export interface SheetRange {
  sheet: string
  r1: number
  c1: number
  r2: number
  c2: number
}

const ALL = 1_048_575

/**
 * Where a range of the file as it stood lands after the ops, as LibreOffice moves a reference (and
 * Excel too): an insert inside it grows it, a delete shrinks it, a moved block takes it along only
 * when the range lies wholly inside the block, and a range wholly under where a block landed is gone
 * (Excel's #REF!). Rows or columns moved are what the script does: room made, the block moved, the
 * emptied lines taken out. Null when the range is gone. What graft.ts uses for a chartsheet's ranges.
 */
export function mapRange(ops: readonly StructuralOp[], range: SheetRange): SheetRange | null {
  let at: SheetRange = { ...range }
  const lines = (a: number, b: number, op: { at: number; count: number }, insert: boolean): [number, number] | null => {
    if (insert) return [a >= op.at ? a + op.count : a, b >= op.at ? b + op.count : b]
    const end = op.at + op.count
    const a2 = a < op.at ? a : a >= end ? a - op.count : op.at
    const b2 = b < op.at ? b : b >= end ? b - op.count : op.at - 1
    return b2 < a2 ? null : [a2, b2]
  }
  for (const op of expand(ops)) {
    if (op.op === 'renameSheet' || op.op === 'removeSheet' || op.op === 'addSheet' || op.op === 'reorder') {
      const a = mapCell([op], at.sheet, at.r1, at.c1)
      const b = mapCell([op], at.sheet, at.r2, at.c2)
      if (!a || !b) return null
      at = { sheet: a.sheet, r1: a.row, c1: a.col, r2: b.row, c2: b.col }
      continue
    }
    if (op.op === 'moveRange') {
      if (at.sheet === op.sheet && at.r1 >= op.r1 && at.r2 <= op.r2 && at.c1 >= op.c1 && at.c2 <= op.c2) {
        at = { sheet: op.to, r1: at.r1 - op.r1 + op.row, r2: at.r2 - op.r1 + op.row, c1: at.c1 - op.c1 + op.col, c2: at.c2 - op.c1 + op.col }
        continue
      }
      const under = at.sheet === op.to && at.r1 >= op.row && at.r2 <= op.row + op.r2 - op.r1 && at.c1 >= op.col && at.c2 <= op.col + op.c2 - op.c1
      if (under) return null
      continue
    }
    if (op.sheet !== at.sheet || op.op === 'moveRows' || op.op === 'moveCols') continue
    const rows = op.op === 'insertRows' || op.op === 'removeRows'
    const got = rows ? lines(at.r1, at.r2, op, op.op === 'insertRows') : lines(at.c1, at.c2, op, op.op === 'insertCols')
    if (!got) return null
    at = rows ? { ...at, r1: got[0], r2: got[1] } : { ...at, c1: got[0], c2: got[1] }
  }
  return at
}

/** Rows or columns moved, as the script makes them: room before `to`, the block moved into it, the emptied lines out. */
function expand(ops: readonly StructuralOp[]): StructuralOp[] {
  return ops.flatMap((op): StructuralOp[] => {
    if (op.op !== 'moveRows' && op.op !== 'moveCols') return [op]
    if (op.to >= op.at && op.to <= op.at + op.count) return []
    const rows = op.op === 'moveRows'
    const src = op.to > op.at ? op.at : op.at + op.count
    const last = src + op.count - 1
    return [
      { op: rows ? 'insertRows' : 'insertCols', sheet: op.sheet, at: op.to, count: op.count },
      rows
        ? { op: 'moveRange', sheet: op.sheet, r1: src, c1: 0, r2: last, c2: ALL, to: op.sheet, row: op.to, col: 0 }
        : { op: 'moveRange', sheet: op.sheet, r1: 0, c1: src, r2: ALL, c2: last, to: op.sheet, row: 0, col: op.to },
      { op: rows ? 'removeRows' : 'removeCols', sheet: op.sheet, at: src, count: op.count }
    ]
  })
}

/** Where line `i` (a row or a column) lands when `count` lines from `at` go before `to`: the others close up behind and open up in front. */
function moveLine(i: number, op: { at: number; count: number; to: number }): number {
  const { at, count, to } = op
  if (to >= at && to <= at + count) return i
  if (i >= at && i < at + count) return (to > at ? to - count : to) + i - at
  if (to > at && i >= at + count && i < to) return i - count
  if (to < at && i >= to && i < at) return i + count
  return i
}

/**
 * Refuses (NotSaved, in the canvas's words) a move the file at `input` cannot take: moves.ts, on the
 * file's own XML, with no LibreOffice. A move is judged on the file as it stands, so it comes alone
 * (`planOf` makes it a step of its own). The converter's first act, and what the store calls before
 * it asks for the job: a refusal then does not wait behind another conversion, and it is still a
 * NotSaved where the job itself would run on another host.
 */
export function refuseMove(input: string, ops: readonly StructuralOp[]): void {
  if (!ops.some(isMove)) return
  if (ops.length > 1) throw new Error('a move comes alone')
  const why = moveRefusal(moveFacts(readZip(new Uint8Array(readFileSync(input)))), ops[0])
  if (why) throw new NotSaved(moveRefusalWords(why))
}

/**
 * The refusal for what the script said as it gave up (its last line: "protected: <sheet>", "full: <sheet>",
 * "unmoved: <sheet>", or LibreOffice's own error). A move is refused in the canvas's words, as the host's
 * check refuses one before LibreOffice runs: a move LibreOffice did not make (the script checks every one)
 * is never saved, it is Excel's.
 */
export function scriptRefusal(ops: readonly StructuralOp[], said: string, code: number): NotSaved {
  const sheet = /^protected: (.*)$/.exec(said)?.[1]
  const full = /^full: (.*)$/.exec(said)?.[1]
  if (ops.some(isMove)) {
    if (sheet) return new NotSaved(moveRefusalWords('protected'))
    if (full) return new NotSaved(moveRefusalWords('full'))
    if (/^unmoved: /.test(said)) return new NotSaved(sheetStopWords('moved'))
  }
  if (full) return new NotSaved(`There is no room in ${full}: its last rows or columns hold cells that would be pushed off the sheet.`)
  return new NotSaved(sheet ? `${sheet} is protected: unprotect it in Excel to insert or delete rows and columns there.` : `LibreOffice could not make that change: ${said || `exit ${code}`}`)
}

/** LibreOffice's own Python, beside soffice: it has `uno`. */
export function officePython(soffice: string): string | null {
  const dir = dirname(soffice)
  for (const p of [
    join(dir, 'python'),
    join(dir, '..', 'Resources', 'python'),
    join(dir, 'python.exe')
  ])
    if (existsSync(p)) return p
  return null
}

const LIBREOFFICE_MS = 20 * 60_000

/** The conversion jobs: an .xlsx or .xlsm with `options.ops` applied, written as the same kind. */
export const STRUCTURAL_CONVERTERS: Converter[] = (['xlsx', 'xlsm'] as const).map((kind) => ({
  from: kind,
  to: `${kind}+ops`,
  needs: 'libreoffice',
  threads: 1,
  async run(job, run) {
    const soffice = run.tools.bin('libreoffice')
    if (!soffice) throw new Error('libreoffice is not installed here')
    const python = officePython(soffice)
    if (!python) throw new Error("LibreOffice's Python is not installed here")
    // Options may come from another host's key: the ops are checked, never passed through as they came. A move
    // the file cannot keep is refused here, before anything is written or LibreOffice starts.
    const ops = OpsSchema.parse(job.options?.ops)
    refuseMove(job.input, ops)
    const script = join(run.tmp, 'structural.py')
    const opsFile = join(run.tmp, 'ops.json')
    const out = join(run.tmp, `out.${kind}`)
    // LibreOffice opens a copy of its own: its lock file stays out of the workbook's folder, and another
    // LibreOffice holding the same file cannot make it open read only (where a move does nothing).
    const input = join(run.tmp, `in.${kind}`)
    copyFileSync(job.input, input)
    writeFileSync(script, STRUCTURAL_PY)
    writeFileSync(opsFile, JSON.stringify(ops))
    const r = await run.run(python, [script, input, out, opsFile, join(run.tmp, 'profile')], {
      timeoutMs: LIBREOFFICE_MS,
      cwd: run.tmp
    })
    if (r.code !== 0 || !existsSync(out)) throw scriptRefusal(ops, r.out.trim().split('\n').pop() ?? '', r.code)
    const { renameSync } = await import('node:fs')
    try {
      renameSync(out, job.output)
    } catch {
      copyFileSync(out, job.output)
    }
    return {}
  }
}))
