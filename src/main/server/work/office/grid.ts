import type { SheetMutationJson } from '@shared/contract-work-sheets'
import type { CanvasSource, Principal } from '@shared/work'
import type { WorkCtx } from '../modules'
import type { A1Range } from '../sheets/a1'
import { editsOf } from '../sheets/mutations'
import type { Which } from '../sheets/suggestions'
import type { OfficeCell } from '@shared/contract-work-office'
import { cellOf, EXCEL_MAX_CELLS, excelStore, parseAddress } from './excel'
import { hereOf } from './index'

/**
 * A workbook that lives in Excel, in the sheet canvas (docs/agents/work-office.md
 * "Excel behind the grid"): what the sheets pillar asks of this pillar for an
 * item whose source is `{at: 'microsoft', app: 'excel'}`.
 *
 * The canvas loads the workbook as a Univer snapshot read from Excel, sheet
 * by sheet, with each sheet's id its tab name. Every change, ours or one
 * typed in Excel (heard on the helper's safety pass), moves the workbook's
 * `rev`, and `since` answers `reload`: Excel gives cells, not Univer's
 * mutations, so the grid reads the workbook again. An edit names the `rev`
 * it stands on; behind the workbook, it answers `conflict`.
 */

export interface ExcelRef {
  host: string
  book: string
  name: string
}

export const excelRefOf = (s: CanvasSource): ExcelRef | null =>
  s.at === 'microsoft' && s.app === 'excel' ? { host: s.host, book: s.ref.kind === 'path' ? s.ref.path : s.ref.url, name: s.name } : null

interface Open {
  rev: number
  off: () => void
  listeners: Set<() => void>
}
const open = new Map<string, Open>()

function here(ctx: WorkCtx, ref: ExcelRef) {
  if (ref.host !== ctx.host) throw new Error(`${ref.name} is open in Excel on another host: it opens in the canvas there.`)
  const h = hereOf(ctx)
  if (!h) throw new Error('Excel is not on this host.')
  return h
}

/**
 * Starts following the workbook (once per workbook) and calls `onChange` after each change Excel
 * shows. Answers its rev.
 */
export async function follow(ctx: WorkCtx, ref: ExcelRef, onChange: () => void): Promise<number> {
  const h = here(ctx, ref)
  let o = open.get(ref.book)
  if (!o) {
    const made: Open = { rev: 1, off: () => {}, listeners: new Set() }
    made.off = h.excel.source(ref.book, 'owner').subscribe((c) => {
      if (c.kind !== 'cells') return
      made.rev++
      for (const fn of made.listeners) fn()
    })
    open.set(ref.book, made)
    o = made
  }
  o.listeners.add(onChange)
  return o.rev
}

export const revOf = (ref: ExcelRef): number => open.get(ref.book)?.rev ?? 1

/** Stops following every workbook (Work off). */
export function unfollowAll(): void {
  for (const o of open.values()) o.off()
  open.clear()
  made.clear()
}

/** The last snapshot made of each workbook, by rev: the canvas loads it in pieces. */
const made = new Map<string, { rev: number; data: Buffer }>()

/** The workbook as a Univer snapshot (`IWorkbookData` as JSON bytes), each sheet's used cells, as of `rev`. */
export async function snapshot(ctx: WorkCtx, ref: ExcelRef, rev: number): Promise<Buffer> {
  const hit = made.get(ref.book)
  if (hit && hit.rev === rev) return hit.data
  const data = Buffer.from(await read(ctx, ref))
  made.set(ref.book, { rev, data })
  return data
}

async function read(ctx: WorkCtx, ref: ExcelRef): Promise<string> {
  const h = here(ctx, ref)
  const info = (await h.carrier.workbooks()).find((b) => b.key === ref.book)
  if (!info) throw new Error(`${ref.name} is not open in Excel: open it there, or press Excel to bring it up.`)
  const sheets: Record<string, unknown> = {}
  for (const s of info.sheets) {
    const cellData: Record<number, Record<number, unknown>> = {}
    if (s.rows && s.columns) {
      const rows = Math.min(s.rows, Math.max(1, Math.floor(EXCEL_MAX_CELLS / s.columns)))
      const range: A1Range = { startRow: 0, startColumn: 0, endRow: rows - 1, endColumn: s.columns - 1 }
      const block = await h.excel.read(ref.book, s.name, range)
      block.values.forEach((row, r) =>
        row.forEach((v, c) => {
          const cell = cellOf(v, block.formulas[r][c])
          if (!cell) return
          ;(cellData[r] ??= {})[c] = cell.f ? { f: cell.f, ...(v !== null ? { v } : {}) } : { v: cell.v }
        })
      )
    }
    sheets[s.name] = { id: s.name, name: s.name, rowCount: Math.max(s.rows + 100, 1000), columnCount: Math.max(s.columns + 10, 26), cellData }
  }
  return JSON.stringify({ id: `excel:${ref.book}`, name: ref.name, appVersion: '1.5.2', locale: 'enUS', styles: {}, sheetOrder: info.sheets.map((s) => s.name), sheets })
}

/**
 * The person's edit from the grid, written through Excel. Only cell contents (as for an opened
 * file); a grid behind the workbook gets `conflict` and catches up.
 */
export async function edit(ctx: WorkCtx, ref: ExcelRef, baseRev: number, mutations: readonly SheetMutationJson[], by: Principal): Promise<{ rev: number } | { conflict: true; rev: number }> {
  const h = here(ctx, ref)
  const rev = revOf(ref)
  if (baseRev !== rev) return { conflict: true, rev }
  const edits = editsOf(mutations, (id) => id)
  for (const sheet of new Set(edits.map((e) => e.sheet))) {
    const mine = edits.filter((e) => e.sheet === sheet).map((e) => ({ ...parseAddress(e.cell), v: (e.formula ?? e.value ?? null) as OfficeCell }))
    const box: A1Range = {
      startRow: Math.min(...mine.map((c) => c.startRow)),
      endRow: Math.max(...mine.map((c) => c.startRow)),
      startColumn: Math.min(...mine.map((c) => c.startColumn)),
      endColumn: Math.max(...mine.map((c) => c.startColumn))
    }
    const now = await h.excel.read(ref.book, sheet, box)
    const grid = now.values.map((row, r) => row.map((v, c) => (now.formulas[r][c] || v) as OfficeCell))
    for (const c of mine) grid[c.startRow - box.startRow][c.startColumn - box.startColumn] = c.v
    const res = await h.excel.write(ref.book, sheet, box, grid, { base: now.hash, by })
    if ('conflict' in res) return { conflict: true, rev }
  }
  // The helper's watchers heard the write as ours and moved the rev.
  return { rev: revOf(ref) }
}

/**
 * Takes or drops an agent's suggestions over the workbook. An accepted cell is written through Excel
 * only while it still holds what the agent saw; one changed since turns `conflict`.
 */
export async function review(ctx: WorkCtx, ref: ExcelRef, which: Which, verdict: 'accept' | 'reject', by: Principal): Promise<void> {
  const h = here(ctx, ref)
  const key = excelStore(ref.book)
  const picked = h.suggestions.pick(key, which)
  if (verdict === 'reject') return h.suggestions.mark(key, picked.map((p) => p.id), 'rejected')
  for (const p of picked.filter((x) => x.state === 'pending')) {
    const at: A1Range = { startRow: p.row, endRow: p.row, startColumn: p.col, endColumn: p.col }
    const now = await h.excel.read(ref.book, p.sheet, at)
    const held = cellOf(now.values[0][0], now.formulas[0][0])
    const same = (held?.f ?? null) === (p.base?.f ?? null) && (held?.f ? true : (held?.v ?? null) === (p.base?.v ?? null))
    const put = p.proposed === null ? null : ((p.proposed.f || p.proposed.v) ?? null) as OfficeCell
    const res = same ? await h.excel.write(ref.book, p.sheet, at, [[put]], { base: now.hash, by }) : null
    h.suggestions.mark(key, [p.id], res && 'ok' in res ? 'accepted' : 'conflict')
  }
}

/** Desktop Excel, brought forward with the workbook: the switch's press. */
export async function bringForward(ctx: WorkCtx, s: CanvasSource): Promise<void> {
  if (s.at !== 'microsoft') throw new Error('Only a Microsoft file opens in its Office app.')
  const h = here(ctx, { host: s.host, book: '', name: s.name })
  await h.carrier.open(s.app, s.ref)
}
