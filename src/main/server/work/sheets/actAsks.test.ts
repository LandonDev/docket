import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { TOTAL_FUNCTIONS as KIT_TOTALS } from 'work-kit/sheet/tables'
import { ChartAskSchema, NoteAskSchema, PageAskSchema, TableAskSchema, TOTAL_FUNCTIONS } from './actAsks'

/**
 * The asks of sheet_table, sheet_page, sheet_note and sheet_chart: what a model may send is bounded
 * here, before the sheet is read; and main reads them with no Univer loaded (only the sheet worker
 * runs the engine, acts.ts).
 */
describe("the agent's asks for what the grid's own handles make", () => {
  it('name the totals the kit offers', () => {
    expect([...TOTAL_FUNCTIONS]).toEqual([...KIT_TOTALS])
  })

  it('load nothing but zod in main: the tools reach the engine through the sheet worker alone', () => {
    const text = (name: string) => readFileSync(join(import.meta.dirname, name), 'utf8')
    const values = (src: string) => [...src.matchAll(/^import (?!type )[^\n]*from '([^']+)'/gm)].map((m) => m[1])
    expect(values(text('actAsks.ts'))).toEqual(['zod'])
    for (const file of ['tools.ts', 'changes.ts', 'workerClient.ts']) expect(text(file), file).not.toMatch(/from '\.\/acts'/)
  })

  it('take what a hand can make and refuse the rest before anything is read', () => {
    expect(TableAskSchema.safeParse({ op: 'make', range: 'A1:C9', style: 'Medium 2', total: true }).success).toBe(true)
    expect(TableAskSchema.safeParse({ op: 'make', range: 'A1:C9', style: 'Pink' }).success).toBe(false)
    expect(TableAskSchema.safeParse({ op: 'total', table: 'T', column: 'Qty', fn: 'median' }).success).toBe(false)
    expect(TableAskSchema.safeParse({ op: 'convert', table: 'T', extra: 1 }).success).toBe(false)
    expect(PageAskSchema.safeParse({ orientation: 'landscape', fit: { wide: 1, tall: 0 }, titleRows: '1:2' }).success).toBe(true)
    for (const bad of [{ scale: 5 }, { scale: 401 }, { fit: { wide: -1, tall: 1 } }, { titleRows: 'A' }, { breakAfterColumn: 'A1' }, { gutter: 1 }]) expect(PageAskSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false)
    expect(NoteAskSchema.safeParse({ at: 'B2', text: null }).success).toBe(true)
    expect(NoteAskSchema.safeParse({ at: 'B2', text: '' }).success).toBe(false)
    expect(NoteAskSchema.safeParse({ at: 'B2', text: 'x'.repeat(32_768) }).success).toBe(false)
    expect(ChartAskSchema.safeParse({ op: 'make', range: 'A1:B9', kind: 'pie', title: 'Share' }).success).toBe(true)
    expect(ChartAskSchema.safeParse({ op: 'make', range: 'A1:B9', kind: 'radar' }).success).toBe(false)
    expect(ChartAskSchema.safeParse({ op: 'change', chart: 'Chart 1', title: null }).success).toBe(true)
  })
})
