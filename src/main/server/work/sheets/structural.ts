import { existsSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import type { SheetMutationJson } from '@shared/contract-work-sheets'
import type { Converter } from '../formats/jobs'
import { editsOf, NotSaved, SET_RANGE_VALUES } from './mutations'
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
  z.object({ op: z.literal('addSheet'), name, at: n }),
  z.object({ op: z.literal('removeSheet'), sheet: name }),
  z.object({ op: z.literal('renameSheet'), sheet: name, to: name })
])
const OpsSchema = z.array(StructuralOpSchema).min(1).max(500)

/** One step of an edit: LibreOffice's structural ops, or the patch writer's cell writes. */
export type Step =
  { kind: 'structural'; ops: StructuralOp[] } | { kind: 'cells'; edits: EditSpec[] }

/** The Univer mutations a package saves through LibreOffice. */
export const STRUCTURAL_IDS = new Set([
  'sheet.mutation.insert-row',
  'sheet.mutation.remove-rows',
  'sheet.mutation.insert-col',
  'sheet.mutation.remove-col',
  'sheet.mutation.reorder-range',
  'sheet.mutation.insert-sheet',
  'sheet.mutation.remove-sheet',
  'sheet.mutation.set-worksheet-name'
])
/** What the grid works out again from content, and what a row or column insert brings along: nothing to save. */
const FOLLOWERS = new Set([
  'sheet.mutation.set-worksheet-row-auto-height',
  'sheet.mutation.set-worksheet-row-is-auto-height',
  'sheet.mutation.set-worksheet-row-height',
  'sheet.mutation.set-worksheet-col-width'
])

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
  // The grid formats a row or column it inserts like its neighbour, as LibreOffice does itself: a cell
  // that carries only a style in a structural edit has nothing more for the file.
  const structural = isStructural(mutations)
  const nameOf = (id: string): string => {
    const got = names.get(id)
    if (!got) throw new NotSaved('That sheet is not in the file.')
    return got
  }
  const push = (op: StructuralOp): void => {
    const last = steps.at(-1)
    if (last?.kind === 'structural') last.ops.push(op)
    else steps.push({ kind: 'structural', ops: [op] })
  }
  for (const m of mutations) {
    if (FOLLOWERS.has(m.id)) continue
    const p = m.params as {
      subUnitId: string
      range?: Range
      order?: Record<string, number>
      index?: number
      sheet?: { id: string; name: string }
      name?: string
    }
    if (m.id === SET_RANGE_VALUES) {
      const edits = editsOf([structural ? withoutStyleOnly(m) : m], (id) => names.get(id))
      if (!edits.length) continue
      const last = steps.at(-1)
      if (last?.kind === 'cells') last.edits.push(...edits)
      else steps.push({ kind: 'cells', edits })
      continue
    }
    if (!STRUCTURAL_IDS.has(m.id))
      throw new NotSaved(
        'Moving cells, merging and formatting are not saved into an opened Excel file yet.'
      )
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
          if (edits.length) steps.push({ kind: 'cells', edits })
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

function withoutStyleOnly(m: SheetMutationJson): SheetMutationJson {
  const p = m.params as {
    cellValue?: Record<string, Record<string, Record<string, unknown> | null>>
  }
  const cellValue: Record<string, Record<string, Record<string, unknown> | null>> = {}
  for (const [r, cols] of Object.entries(p.cellValue ?? {}))
    for (const [c, cell] of Object.entries(cols ?? {}))
      if (cell === null || 'v' in cell || 'f' in cell || 'p' in cell || 'si' in cell)
        (cellValue[r] ??= {})[c] = cell
  return { id: m.id, params: { ...p, cellValue } }
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
    if (op.op === 'addSheet' || op.sheet !== at.sheet) continue
    switch (op.op) {
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
    // Options may come from another host's key: the ops are checked, never passed through as they came.
    const ops = OpsSchema.parse(job.options?.ops)
    const script = join(run.tmp, 'structural.py')
    const opsFile = join(run.tmp, 'ops.json')
    const out = join(run.tmp, `out.${kind}`)
    writeFileSync(script, STRUCTURAL_PY)
    writeFileSync(opsFile, JSON.stringify(ops))
    const r = await run.run(python, [script, job.input, out, opsFile, join(run.tmp, 'profile')], {
      timeoutMs: LIBREOFFICE_MS,
      cwd: run.tmp
    })
    if (r.code !== 0 || !existsSync(out)) {
      const said = r.out.trim().split('\n').pop() ?? ''
      const sheet = /^protected: (.*)$/.exec(said)?.[1]
      throw new NotSaved(
        sheet
          ? `${sheet} is protected: unprotect it in Excel to insert or delete rows and columns there.`
          : `LibreOffice could not make that change: ${said || `exit ${r.code}`}`
      )
    }
    const { renameSync, copyFileSync } = await import('node:fs')
    try {
      renameSync(out, job.output)
    } catch {
      copyFileSync(out, job.output)
    }
    return {}
  }
}))
