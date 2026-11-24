import type { MsQuestion } from '@shared/work/msforms'

/**
 * A Microsoft form from a sheet's header row (docs/agents/work-msforms.md "The makers"): each header cell a
 * question; a column of few distinct values (at most `CHOICE_MOST` over at least `CHOICE_ROWS` filled rows) a Choice
 * with them as its options, in the order they first appear, when at least two values recur; else Text. Pure; the reader is in makers/index.ts.
 */

export const CHOICE_MOST = 8
export const CHOICE_ROWS = 5
/** The rows and columns a read takes: a header and the 200 rows under it, 30 columns. */
export const SHEET_RANGE = 'A1:AD201'

/** `rows[0]` is the header row (or the row `header` names, 0-based); every row a list of cells as text. */
export function questionsOfSheet(rows: readonly (readonly string[])[], header = 0): MsQuestion[] {
  const head = rows[header] ?? []
  const body = rows.slice(header + 1)
  const out: MsQuestion[] = []
  head.forEach((cell, col) => {
    const title = cell.replace(/\s+/g, ' ').trim().slice(0, 500)
    if (!title || out.length >= 100) return
    const filled = body.map((r) => (r[col] ?? '').trim()).filter(Boolean)
    const distinct = [...new Set(filled)]
    // One value over every row is no choice to make, and a column whose every value differs (names) is no choice either.
    if (filled.length >= CHOICE_ROWS && distinct.length >= 2 && distinct.length <= CHOICE_MOST && distinct.length < filled.length) out.push({ title, type: 'choice', options: distinct.map((v) => v.slice(0, 200)), required: false })
    else out.push({ title, type: 'text', required: false })
  })
  return out
}

/** A column's letters as its 0-based index: A → 0, AD → 29. */
export const columnIndex = (letters: string): number => [...letters.toUpperCase()].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1

/** The sheet reader's cells (`{at: 'B4', v}`, a tab name allowed before a `!`) as rows of text, each cell in its own place. */
export function rowsOfCells(cells: readonly (readonly { at: string; v?: unknown }[])[]): string[][] {
  const rows: string[][] = []
  for (const row of cells)
    for (const c of row) {
      const m = /([A-Z]{1,3})(\d{1,7})$/i.exec(c.at)
      if (!m) continue
      const r = Number(m[2]) - 1
      const col = columnIndex(m[1]!)
      ;(rows[r] ??= [])[col] = c.v === undefined || c.v === null ? '' : String(c.v)
    }
  return Array.from({ length: rows.length }, (_, i) => Array.from({ length: rows[i]?.length ?? 0 }, (_, j) => rows[i]?.[j] ?? ''))
}
