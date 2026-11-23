import { RANGE_TYPE } from '@univerjs/core'
import type { FormatRange } from './format'
import { FormatRefused } from './format-xml'
import { colNum, parseRef, refName, type Box } from './xml'

export const ROWS = 1_048_576
export const COLS = 16_384
export type Interval = { from: number; to: number }

export const fullHeight = (box: Box) => box.r1 === 1 && box.r2 === ROWS
export const fullWidth = (box: Box) => box.c1 === 1 && box.c2 === COLS
export const overlaps = (a: Box, b: Box) =>
  a.r1 <= b.r2 && b.r1 <= a.r2 && a.c1 <= b.c2 && b.c1 <= a.c2
export const contains = (outer: Box, inner: Box) =>
  outer.r1 <= inner.r1 && outer.r2 >= inner.r2 && outer.c1 <= inner.c1 && outer.c2 >= inner.c2
export const columnInterval = (box: Box): Interval => ({ from: box.c1, to: box.c2 })

export function boxRef(box: Box): string {
  const start = refName(box.r1, box.c1)
  const end = refName(box.r2, box.c2)
  return start === end ? start : start + ':' + end
}

function box(r1: number, r2: number, c1: number, c2: number): Box {
  if (
    ![r1, r2, c1, c2].every(Number.isInteger) ||
    Math.min(r1, r2) < 1 ||
    Math.max(r1, r2) > ROWS ||
    Math.min(c1, c2) < 1 ||
    Math.max(c1, c2) > COLS
  )
    throw new Error('Range outside the worksheet')
  return { r1: Math.min(r1, r2), r2: Math.max(r1, r2), c1: Math.min(c1, c2), c2: Math.max(c1, c2) }
}

export function readRange(range: FormatRange, axes = false): Box {
  try {
    if (typeof range !== 'string') {
      const { startRow, endRow, startColumn, endColumn, rangeType = RANGE_TYPE.NORMAL } = range
      if (axes) {
        if (rangeType === RANGE_TYPE.ALL) return box(1, ROWS, 1, COLS)
        if (rangeType === RANGE_TYPE.ROW) return box(startRow + 1, endRow + 1, 1, COLS)
        if (rangeType === RANGE_TYPE.COLUMN) return box(1, ROWS, startColumn + 1, endColumn + 1)
      }
      if (rangeType !== RANGE_TYPE.NORMAL) throw new Error('Expected a cell range')
      return box(startRow + 1, endRow + 1, startColumn + 1, endColumn + 1)
    }
    const a1 = range.trim()
    if (axes) {
      const columns = /^\$?([A-Z]{1,3}):\$?([A-Z]{1,3})$/i.exec(a1)
      if (columns) return box(1, ROWS, colNum(columns[1]), colNum(columns[2]))
      const rows = /^\$?(\d+):\$?(\d+)$/.exec(a1)
      if (rows) return box(Number(rows[1]), Number(rows[2]), 1, COLS)
    }
    const [start, end = start, ...rest] = a1.split(':')
    if (rest.length) throw new Error('Expected a single range')
    const first = parseRef(start)
    const last = parseRef(end)
    return box(first.row, last.row, first.col, last.col)
  } catch {
    const label = typeof range === 'string' ? `“${range}”` : 'The grid range'
    throw new FormatRefused(`${label} is outside the worksheet or isn't a valid range.`)
  }
}

export function checkAxis(
  from: number,
  to: number,
  limit: number,
  size: number | null,
  max: number,
  label: string
) {
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from || to >= limit)
    throw new FormatRefused(`The ${label} range is outside the worksheet.`)
  if (size !== null && (!Number.isFinite(size) || size < 0 || size > max))
    throw new FormatRefused(`The ${label} size must be between 0 and ${max}.`)
}

export function union(intervals: Interval[]): Interval[] {
  const out: Interval[] = []
  for (const { from, to } of intervals.sort((a, b) => a.from - b.from || a.to - b.to)) {
    const last = out.at(-1)
    if (last && from <= last.to + 1) last.to = Math.max(last.to, to)
    else out.push({ from, to })
  }
  return out
}
