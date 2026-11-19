import type { ICellData, IWorkbookData } from '@univerjs/core'
import type { SheetCellDiff, SheetCellJson } from '@shared/contract-work-sheets'

/** Compare: what two workbooks hold differently, cell by cell. Pure; the sheet worker and the Work service both use it. */

const json = (c: ICellData | null | undefined): SheetCellJson | null => {
  if (!c) return null
  const out: SheetCellJson = {}
  if (c.v !== undefined && c.v !== null) out.v = c.v as SheetCellJson['v']
  if (c.f) out.f = c.f
  return Object.keys(out).length ? out : null
}

const same = (a: SheetCellJson | null, b: SheetCellJson | null): boolean => (a?.f ?? null) === (b?.f ?? null) && (a?.v ?? null) === (b?.v ?? null)

/** Cells whose formula or value differ between two workbooks, sheet by sheet as `to` orders them. */
export function diffWorkbooks(from: IWorkbookData, to: IWorkbookData, max: number): { cells: SheetCellDiff[]; truncated: boolean } {
  const cells: SheetCellDiff[] = []
  const ids = [...new Set([...to.sheetOrder, ...from.sheetOrder])]
  for (const id of ids) {
    const a = from.sheets[id]?.cellData ?? {}
    const b = to.sheets[id]?.cellData ?? {}
    const sheetName = to.sheets[id]?.name ?? from.sheets[id]?.name ?? id
    const rows = [...new Set([...Object.keys(a), ...Object.keys(b)].map(Number))].sort((x, y) => x - y)
    for (const row of rows) {
      const cols = [...new Set([...Object.keys(a[row] ?? {}), ...Object.keys(b[row] ?? {})].map(Number))].sort((x, y) => x - y)
      for (const col of cols) {
        const before = json(a[row]?.[col])
        const after = json(b[row]?.[col])
        if (same(before, after)) continue
        if (cells.length >= max) return { cells, truncated: true }
        cells.push({ sheet: id, sheetName, row, col, before, after })
      }
    }
  }
  return { cells, truncated: false }
}
