// Recalculation through IronCalc (native N-API build): load the same bytes, evaluate, apply the
// edits, evaluate again, and report every cell whose value moved. IronCalc never writes the file;
// its values only feed <v> patches.
import { createRequire } from 'node:module'
import type { Cached, CellWrite } from './sheet'
import { numText } from './sheet'
import { toUserFormula } from './formula'

export interface EngineEdit {
  sheet: string
  row: number
  col: number
  write: CellWrite
}
export interface Changed {
  sheet: string
  row: number
  col: number
  before: Cached | null
  after: Cached | null
}
export interface EngineResult {
  engine: string
  ok: boolean
  error?: string
  changed: Changed[] // excludes the edited cells
  editValues: Record<string, Cached | null> // "sheet\u0000row,col" → engine value of an edited formula cell
  editErrors: string[] // edits the engine refused (formula it cannot parse, ...)
  auditBefore: Record<string, Cached | null> // "sheet\u0000A1" → engine value before the edit, for the keys asked for
  timings: {
    loadMs: number
    evalMs: number
    applyMs: number
    snapshotMs: number
    workerMs?: number
  }
}

export const UNSUPPORTED = new Set(['#NAME?', '#N/IMPL!', '#ERROR!', '#CALC!'])

function toCached(v: unknown, type: number): Cached | null {
  if (v === null || v === undefined) return null
  if (type === 16) return { t: 'e', v: String(v) }
  if (typeof v === 'number') return { t: 'n', v: numText(v) }
  if (typeof v === 'boolean') return { t: 'b', v: v ? '1' : '0' }
  return { t: 'str', v: String(v) }
}

export function sameCached(a: Cached | null | undefined, b: Cached | null | undefined): boolean {
  if (!a || !b)
    return (
      (a ?? null) === (b ?? null) ||
      (!a && b?.t === 'str' && b.v === '') ||
      (!b && a?.t === 'str' && a.v === '')
    )
  if (a.t === 'n' && b.t === 'n') {
    const x = Number(a.v),
      y = Number(b.v)
    return Math.abs(x - y) <= 1e-9 * Math.max(1, Math.abs(x))
  }
  if (a.t === 'b' && b.t === 'b')
    return (a.v === '1' || a.v === 'true') === (b.v === '1' || b.v === 'true')
  return a.t === b.t && a.v === b.v
}

/**
 * IronCalc's native binding, loaded from the toolchain's folder (`<userData>/work-tools/ironcalc/<v>`,
 * scripts/work-tools/base.json). Load it only in a process that may die: a Rust panic aborts the
 * whole process (the sheet worker, sheets/worker.ts), never main.
 */
export function ironcalc(
  ironcalcDir: string,
  inputPath: string,
  edits: EngineEdit[],
  auditKeys: string[] = []
): EngineResult {
  const timings = { loadMs: 0, evalMs: 0, applyMs: 0, snapshotMs: 0 }
  const res: EngineResult = {
    engine: 'ironcalc',
    ok: false,
    changed: [],
    editValues: {},
    editErrors: [],
    auditBefore: {},
    timings
  }
  let Model: any
  try {
    ;({ Model } = createRequire(`${ironcalcDir.replace(/\/+$/, '')}/node_modules/`)(
      '@ironcalc/nodejs'
    ))
  } catch (e) {
    res.error = `IronCalc is not installed under ${ironcalcDir}: ${e}`
    return res
  }
  let t = performance.now()
  let m: any
  try {
    m = Model.fromXlsx(inputPath, 'en', 'UTC')
  } catch (e) {
    res.error = `IronCalc cannot load the workbook: ${e}`
    return res
  }
  timings.loadMs = performance.now() - t
  const names: string[] = m.getWorksheetsProperties().map((p: any) => p.name)
  t = performance.now()
  m.evaluate()
  timings.evalMs += performance.now() - t

  t = performance.now()
  const snap = () => {
    const out = new Map<string, Cached | null>()
    for (const [s, r, c] of m.getAllCells() as [number, number, number][]) {
      const v = m.getCellValue(s, r, c)
      if (v === null) continue
      out.set(`${s},${r},${c}`, toCached(v, typeof v === 'string' ? m.getCellType(s, r, c) : 0))
    }
    return out
  }
  const before = snap()
  timings.snapshotMs += performance.now() - t
  for (const k of auditKeys) {
    const [sheet, ref] = k.split('\u0000')
    const s = names.indexOf(sheet)
    if (s < 0) continue
    const m1 = /^([A-Z]+)(\d+)$/.exec(ref)!
    const col = [...m1[1]].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0)
    res.auditBefore[k] = before.get(`${s},${Number(m1[2])},${col}`) ?? null
  }
  t = performance.now()
  const editKeys = new Set<string>()
  for (const e of edits) {
    const s = names.indexOf(e.sheet)
    if (s < 0) {
      res.editErrors.push(`${e.sheet}: sheet not in the engine's model`)
      continue
    }
    editKeys.add(`${s},${e.row},${e.col}`)
    try {
      const w = e.write
      if (w.kind === 'clear') m.clearCellContents(s, e.row, e.col)
      else if (w.kind === 'number') m.updateCellWithNumber(s, e.row, e.col, w.value)
      else if (w.kind === 'bool') m.updateCellWithBool(s, e.row, e.col, w.value)
      else if (w.kind === 'text') m.updateCellWithText(s, e.row, e.col, w.value)
      else m.updateCellWithFormula(s, e.row, e.col, toUserFormula(w.file))
    } catch (err) {
      res.editErrors.push(`${e.sheet}!R${e.row}C${e.col}: ${err}`)
    }
  }
  timings.applyMs = performance.now() - t
  t = performance.now()
  m.evaluate()
  timings.evalMs += performance.now() - t
  t = performance.now()
  const after = snap()
  timings.snapshotMs += performance.now() - t

  const split = (k: string) => {
    const [s, r, c] = k.split(',').map(Number)
    return { sheet: names[s], row: r, col: c }
  }
  for (const [k, v] of after) {
    if (editKeys.has(k)) {
      const p = split(k)
      res.editValues[`${p.sheet}\u0000${p.row},${p.col}`] = v
      continue
    }
    const b = before.get(k) ?? null
    if (!sameCached(b, v)) res.changed.push({ ...split(k), before: b, after: v })
  }
  for (const [k, b] of before)
    if (!after.has(k) && !editKeys.has(k)) res.changed.push({ ...split(k), before: b, after: null })
  res.ok = true
  return res
}
