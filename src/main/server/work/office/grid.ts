import type { SheetMutationJson } from '@shared/contract-work-sheets'
import type { CanvasSource, Principal } from '@shared/work'
import type { WorkCtx } from '../modules'
import type { A1Range } from '../sheets/a1'
import { editsOf } from '../sheets/mutations'
import type { Which } from '../sheets/suggestions'
import type { OfficeCell } from '@shared/contract-work-office'
import type { SheetCell } from 'work-kit/sheet/source'
import { cellOf, EXCEL_MAX_CELLS, excelStore, parseAddress, writable } from './excel'
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
  /** one per canvas item, by its id: a view read again replaces its own */
  listeners: Map<string, () => void>
}
const open = new Map<string, Open>()

function here(ctx: WorkCtx, ref: ExcelRef) {
  if (ref.host !== ctx.host) throw new Error(`${ref.name} is open in Excel on another host: it opens in the canvas there.`)
  const h = hereOf(ctx)
  if (!h) throw new Error('Excel is not on this host.')
  return h
}

/**
 * Follows the workbook (once per workbook) and calls `onChange` for the canvas item `itemId` after
 * each change: someone else's, heard on the safety pass, or any write this host makes to it.
 * Answers its rev.
 */
export function follow(ctx: WorkCtx, ref: ExcelRef, itemId: string, onChange: () => void): number {
  const h = here(ctx, ref)
  let o = open.get(ref.book)
  if (!o) {
    const made: Open = { rev: 1, off: () => {}, listeners: new Map() }
    const bump = () => {
      made.rev++
      for (const fn of made.listeners.values()) fn()
    }
    const offSource = h.excel.source(ref.book, 'owner').subscribe((c) => c.kind === 'cells' && c.by === 'excel' && bump())
    const ours = (book: string) => book === ref.book && bump()
    h.excel.wrote.add(ours)
    made.off = () => {
      offSource()
      h.excel.wrote.delete(ours)
    }
    open.set(ref.book, made)
    o = made
  }
  o.listeners.set(itemId, onChange)
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
 * The person's edit from the grid, written through Excel, cell by cell. Only cell contents (as for
 * an opened file); a grid behind the workbook gets `conflict` with the rev to catch up to.
 */
export async function edit(ctx: WorkCtx, ref: ExcelRef, baseRev: number, mutations: readonly SheetMutationJson[], by: Principal): Promise<{ rev: number } | { conflict: true; rev: number }> {
  const h = here(ctx, ref)
  if (baseRev !== revOf(ref)) return { conflict: true, rev: revOf(ref) }
  const cells = editsOf(mutations, (id) => id).map((e) => {
    const at = parseAddress(e.cell)
    return { sheet: e.sheet, row: at.startRow, col: at.startColumn, v: (e.formula ?? e.value ?? null) as OfficeCell }
  })
  if ((await h.excel.writeCells(ref.book, cells, by)) === 'conflict') {
    // Excel moved under the edit before the safety pass saw it: the grid reads the workbook again.
    const o = open.get(ref.book)
    if (o) o.rev++
    return { conflict: true, rev: revOf(ref) }
  }
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
    const same = (held: (SheetCell | null)[]) => (held[0]?.f ?? null) === (p.base?.f ?? null) && (held[0]?.f ? true : (held[0]?.v ?? null) === (p.base?.v ?? null))
    const v = p.proposed === null ? null : writable(p.proposed.f ? { f: p.proposed.f } : { v: (p.proposed.v ?? null) as OfficeCell })
    const got = await h.excel.writeCells(ref.book, [{ sheet: p.sheet, row: p.row, col: p.col, v }], by, same)
    h.suggestions.mark(key, [p.id], got === 'ok' ? 'accepted' : 'conflict')
  }
}

/** Desktop Excel, brought forward with the workbook: the switch's press. */
export async function bringForward(ctx: WorkCtx, s: CanvasSource): Promise<void> {
  if (s.at !== 'microsoft') throw new Error('Only a Microsoft file opens in its Office app.')
  const h = here(ctx, { host: s.host, book: '', name: s.name })
  await h.carrier.open(s.app, s.ref)
}
