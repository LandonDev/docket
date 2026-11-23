import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseReceipt } from '@shared/work/money'
import { FIXTURES, FIXTURE_TODAY, linesOf } from './fixtures/receipts'

/* The one parser on every made-up receipt, from the lines a reader gives back for it. */
describe('parseReceipt on the fixtures', () => {
  it.each(FIXTURES.map((f) => [f.file, f] as const))('%s', (_name, f) => {
    expect(parseReceipt(linesOf(f), { sector: f.sector, today: FIXTURE_TODAY })).toEqual(f.expected)
  })

  it('has every fixture drawn beside it', () => {
    for (const f of FIXTURES) expect(existsSync(join(import.meta.dirname, 'fixtures', f.file)), f.file).toBe(true)
  })

  it('holds six pictures and two PDFs, one of them a scan', () => {
    expect(FIXTURES.filter((f) => f.kind === 'picture')).toHaveLength(6)
    expect(FIXTURES.filter((f) => f.kind === 'pdf')).toHaveLength(1)
    expect(FIXTURES.filter((f) => f.kind === 'scan')).toHaveLength(1)
  })
})
