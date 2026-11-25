import type { ICellData } from '@univerjs/core'

/**
 * A guest's ops cut to what a guest may send (docs/agents/work-sheets.md "Live editing"). The service cuts every
 * batch of a guest's with this before it commits it, and the guest's page cuts its own with the same function
 * before it sends: a client never lays its own op when it comes back, so what the service commits must be what the
 * page's grid holds. No zod and no node import: the hosted page bundles this file.
 */

type Mutation = { id: string; params: unknown }
type Matrix = Record<string, Record<string, ICellData | null>>
type P = Record<string, unknown>

const SET_RANGE_VALUES = 'sheet.mutation.set-range-values'
/** A row or column key as a grid writes one: a whole number with no sign, no fraction and no leading zero. */
export const INDEX_KEY = /^(0|[1-9]\d{0,6})$/
/** The widest column and tallest row a guest may set (px). */
export const SIZE_MAX = 2000
/** The most rows or columns one insert or delete may span. */
export const STRUCTURAL_MAX = 1000
/** The longest string a guest's style may hold (a number format's code is at most 255 characters in Excel). */
const STYLE_TEXT_MAX = 255
/** The largest number a guest's style may hold: a theme colour's tag (work-kit `themeTag`) is the largest the grid writes, under 400,000. */
const STYLE_NUMBER_MAX = 1_000_000
export const guestSize = (n: unknown): boolean => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= SIZE_MAX

const NEVER_A_KEY = new Set(['__proto__', 'constructor', 'prototype'])

/**
 * A guest's style as the grid's own: short keys, numbers, flags and short strings, a few levels
 * deep. Univer drops a key it does not know but keeps any value whole, so a string of a hundred
 * thousand characters in a colour would stay in the workbook's styles for good.
 */
function guestStyle(style: unknown, depth = 0): unknown {
  if (style === null) return null
  if (typeof style === 'string') return style.length <= 64 ? style : undefined
  if (typeof style !== 'object' || Array.isArray(style) || depth > 4) return undefined
  const out: Record<string, unknown> = {}
  let kept = 0
  for (const [k, v] of Object.entries(style)) {
    if (!/^[A-Za-z_]{1,12}$/.test(k) || NEVER_A_KEY.has(k) || kept >= 24) continue
    let value: unknown
    if (v === null || typeof v === 'boolean' || (typeof v === 'number' && Math.abs(v) <= STYLE_NUMBER_MAX)) value = v
    else if (typeof v === 'string') value = v.length <= STYLE_TEXT_MAX ? v : undefined
    else value = guestStyle(v, depth + 1)
    if (value === undefined) continue
    out[k] = value
    kept++
  }
  return out
}

/** A formula without the prefixes Excel's files give newer functions and a lambda's own names (`_xlfn.`, `_xlws.`, `_xlpm.`, `_xludf.`): the engine reads the plain names, and throws on the prefixed ones. Text in quotes is left as it is. */
export const plainFormula = (f: string): string =>
  f.includes('_xl')
    ? f
        .split('"')
        .map((part, i) => (i % 2 ? part : part.replace(/_xl(?:fn|ws|pm|udf)\./gi, '')))
        .join('"')
    : f

/** What an inserted row or column may carry beside its place: its height or its width, nothing else (not hidden, no other key). */
function sizesOnly(info: unknown, key: 'h' | 'w'): Record<string, Record<string, number>> | undefined {
  if (!info || typeof info !== 'object') return undefined
  const out: Record<string, Record<string, number>> = {}
  let kept = 0
  for (const [k, v] of Object.entries(info)) {
    const n = (v as Record<string, unknown> | null)?.[key]
    if (!INDEX_KEY.test(k) || kept >= STRUCTURAL_MAX || !guestSize(n)) continue
    out[k] = { [key]: n as number }
    kept++
  }
  return kept ? out : undefined
}

/**
 * A guest's ops cut to what a guest may send: cells as values, formulas, styles and types only (no
 * rich text, no custom data), named by indexes, a style held to the grid's own shape, a formula in
 * plain names; an inserted row or column with its size and nothing else.
 */
export function guestCells<M extends Mutation>(mutations: readonly M[]): M[] {
  return mutations.map((m) => {
    if (m.id === 'sheet.mutation.insert-row' || m.id === 'sheet.mutation.insert-col') {
      const p = m.params as { unitId?: unknown; subUnitId?: unknown; range?: unknown; rowInfo?: unknown; colInfo?: unknown }
      const rows = m.id.endsWith('row')
      const info = rows ? sizesOnly(p.rowInfo, 'h') : sizesOnly(p.colInfo, 'w')
      return { id: m.id, params: { unitId: p.unitId, subUnitId: p.subUnitId, range: p.range, ...(info ? { [rows ? 'rowInfo' : 'colInfo']: info } : {}) } } as unknown as M
    }
    if (m.id !== SET_RANGE_VALUES) return m
    const p = m.params as { cellValue?: Matrix }
    const cellValue: Matrix = {}
    for (const [r, cols] of Object.entries(p.cellValue ?? {})) {
      if (!INDEX_KEY.test(r)) continue
      const row: Record<string, ICellData | null> = (cellValue[r] = {})
      for (const [c, cell] of Object.entries(cols ?? {})) {
        if (!INDEX_KEY.test(c)) continue
        if (cell === null) row[c] = null
        else {
          const kept: Record<string, unknown> = {}
          for (const k of ['v', 'f', 't'] as const) if (k in cell) kept[k] = cell[k]
          if (typeof kept.f === 'string') kept.f = plainFormula(kept.f)
          if ('s' in cell) {
            const style = guestStyle(cell.s)
            if (style !== undefined) kept.s = style
          }
          row[c] = kept as ICellData
        }
      }
    }
    return { id: m.id, params: { ...p, cellValue } } as unknown as M
  })
}

type Cells = Record<string, Record<string, Record<string, unknown> | null> | null>

/**
 * A page's cell write with the type the grid gave each value. A value written with no type takes one from the
 * cell's number format, so the same write laid on two grids in two orders can leave a number on one and text on
 * the other; said with its type, it is the same cell everywhere. `typeOf` reads the grid, which already holds the
 * write.
 */
export function typedCells<M extends Mutation>(m: M, typeOf: (sheet: string, row: number, column: number) => number | null | undefined): M {
  if (m.id !== SET_RANGE_VALUES) return m
  const sheet = typeof (m.params as P).subUnitId === 'string' ? ((m.params as P).subUnitId as string) : ''
  const cells = ((m.params as P).cellValue ?? {}) as Cells
  let changed = false
  const out: Cells = {}
  for (const [r, cols] of Object.entries(cells)) {
    const row: Record<string, Record<string, unknown> | null> = (out[r] = {})
    for (const [c, cell] of Object.entries(cols ?? {})) {
      const t = cell && cell.v != null && cell.t == null && cell.f == null ? typeOf(sheet, Number(r), Number(c)) : null
      if (typeof t === 'number') changed = true
      row[c] = typeof t === 'number' ? { ...cell, t } : cell
    }
  }
  return changed ? ({ ...m, params: { ...(m.params as P), cellValue: out } } as unknown as M) : m
}

/**
 * What a grid must lay on itself so it holds a cell write as it was sent, or null when it already does. The page
 * sends a write cut to what the sheet keeps (rich text as its words, a shared formula as its own text, a guest's
 * style in the grid's shape); the grid made the write whole. Each cell that differs is written as sent, with the
 * keys the cut dropped cleared.
 */
export function cutFix<M extends Mutation>(made: M, sent: M): M | null {
  if (made.id !== SET_RANGE_VALUES || made === sent) return null
  const before = ((made.params as P).cellValue ?? {}) as Cells
  const after = ((sent.params as P).cellValue ?? {}) as Cells
  const fix: Cells = {}
  let any = false
  for (const [r, cols] of Object.entries(before)) {
    for (const [c, cell] of Object.entries(cols ?? {})) {
      const kept = after[r]?.[c]
      if (!cell || !kept || JSON.stringify(cell) === JSON.stringify(kept)) continue
      const dropped = Object.keys(cell).filter((k) => !(k in kept))
      ;(fix[r] ??= {})[c] = { ...Object.fromEntries(dropped.map((k) => [k, null])), ...kept }
      any = true
    }
  }
  return any ? ({ ...sent, params: { ...(sent.params as P), cellValue: fix } } as unknown as M) : null
}
