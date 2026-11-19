import { DASH_BARS_MAX, DASH_TABLE_COLS, DASH_TABLE_ROWS, type DashAgg, type DashFormat } from '@shared/contract-work-dashboards'

/**
 * What a dashboard makes of the cells it reads (docs/agents/work-dashboards.md
 * "Reading"): a figure from a range, a chart's bars, a flat table. Pure, so
 * the tests read them plainly.
 */

export type Cell = { at: string; v?: string | number | boolean }
export type Cells = Cell[][]

const flat = (cells: Cells): Cell[] => cells.flat().filter((c) => c.v !== undefined && c.v !== '')
const numberOf = (v: Cell['v']): number | null => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v !== 'string') return null
  const n = Number(v.replace(/[$,\s]/g, ''))
  return v.trim() && Number.isFinite(n) ? n : null
}

/** A figure's number: one cell, or the range summed, counted, averaged or its least or most. Null when there is nothing to count. */
export function aggregate(cells: Cells, agg: DashAgg): number | string | null {
  const all = flat(cells)
  if (agg === 'cell') {
    const v = all[0]?.v
    return v === undefined ? null : typeof v === 'boolean' ? String(v) : v
  }
  if (agg === 'count') return all.length
  const nums = all.map((c) => numberOf(c.v)).filter((n): n is number => n !== null)
  if (!nums.length) return null
  if (agg === 'sum') return nums.reduce((a, b) => a + b, 0)
  if (agg === 'average') return nums.reduce((a, b) => a + b, 0) / nums.length
  return agg === 'min' ? Math.min(...nums) : Math.max(...nums)
}

const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 })
const moneyWhole = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
const plain = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 })

/** A number as the page shows it: $7,420 or $1,850.50; 12,300; 14%. Text stays as it is. */
export function formatValue(v: number | string | null, format: DashFormat): string | null {
  if (v === null) return null
  const n = typeof v === 'number' ? v : numberOf(v)
  if (format === 'text' || n === null) return String(v)
  if (format === 'money') return Number.isInteger(n) ? moneyWhole.format(n) : money.format(n)
  if (format === 'percent') return `${plain.format(Math.abs(n) <= 1 && !Number.isInteger(n) ? n * 100 : n)}%`
  return plain.format(n)
}

/** A chart's bars: the labels and the values read in step, empty pairs left out, at most 24. */
export function barsOf(labels: Cells, values: Cells): { label: string; value: number }[] {
  const names = labels.flat().map((c) => (c.v === undefined ? '' : String(c.v)))
  const nums = values.flat().map((c) => numberOf(c.v))
  const bars: { label: string; value: number }[] = []
  for (let i = 0; i < Math.max(names.length, nums.length); i++) {
    const value = nums[i]
    if (names[i] && value != null) bars.push({ label: names[i], value })
  }
  return bars.slice(-DASH_BARS_MAX)
}

/** A flat table: the range's first row is its head; blank rows are left out; a column of numbers is said to be one. */
export function tableOf(cells: Cells): { head: string[]; rows: string[][]; numeric: boolean[] } {
  const text = (c: Cell | undefined): string => (c?.v === undefined ? '' : typeof c.v === 'number' ? plain.format(c.v) : String(c.v))
  const width = Math.min(DASH_TABLE_COLS, Math.max(0, ...cells.map((r) => r.length)))
  const grid = cells.map((r) => Array.from({ length: width }, (_, i) => r[i]))
  const [head = [], ...body] = grid
  const kept = body.filter((r) => r.some((c) => c?.v !== undefined && c.v !== '')).slice(0, DASH_TABLE_ROWS)
  const numeric = Array.from({ length: width }, (_, i) => kept.length > 0 && kept.every((r) => r[i]?.v === undefined || r[i]?.v === '' || numberOf(r[i]?.v) !== null))
  return { head: head.map(text), rows: kept.map((r) => r.map(text)), numeric }
}
