import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { TcsheetBackend } from './backends'
import { SheetHost } from './host'

/**
 * A `.tcsheet` of about 5 MB under two typists (plan milestone 3, item 8): each op rewrites the file whole, so how
 * long a write takes decides whether ops landing in one turn of the sheet's lane are written as one. Run it by hand:
 * `TC_BENCH=1 NODE_ENV=test bunx vitest run src/main/server/work/sheets/host/typists.bench.test.ts`. The numbers are
 * in `.temp-code/plans/landed/F-live-guest/M3.md`.
 */
describe.skipIf(!process.env.TC_BENCH)('a 5 MB .tcsheet under two typists', () => {
  it('times each commit while two clients type a cell each, one after the other and at once', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tc-typists-'))
    try {
      const path = join(dir, 'Big.tcsheet')
      TcsheetBackend.create(path, 'Big')
      const host = new SheetHost(() => new TcsheetBackend(path))
      const ref = { tcsheet: path }
      const opened = await host.open(ref)
      const subUnitId = opened.sheets[0]!.id
      const unitId = opened.unit
      // Fill it: 200 rows of 60 columns of text, written in batches, until the file is past 5 MB.
      let rev = opened.rev
      for (let block = 0; statSync(path).size < 5 * 1024 * 1024 && block < 400; block++) {
        const cellValue: Record<number, Record<number, { v: string; t: number }>> = {}
        for (let r = 0; r < 20; r++) {
          const row: Record<number, { v: string; t: number }> = (cellValue[block * 20 + r] = {})
          for (let c = 0; c < 60; c++) row[c] = { v: `row ${block * 20 + r} col ${c} ${'x'.repeat(30)} ${Math.random().toString(36)}`, t: 1 }
        }
        const got = await host.apply(ref, rev, [{ id: 'sheet.mutation.set-range-values', params: { unitId, subUnitId, cellValue } }], 'owner')
        rev = (got as { rev: number }).rev
      }
      const size = statSync(path).size
      const cell = (row: number, v: string) => [{ id: 'sheet.mutation.set-range-values', params: { unitId, subUnitId, cellValue: { [row]: { 0: { v, t: 1 } } } } }]
      const times = (list: number[]) => {
        const s = [...list].sort((a, b) => a - b)
        return { n: s.length, median: s[Math.floor(s.length / 2)]!, p95: s[Math.floor(s.length * 0.95)]!, max: s.at(-1)! }
      }
      // One after the other: each typist's op waits for the other's.
      const serial: number[] = []
      for (let i = 0; i < 40; i++) {
        const t0 = performance.now()
        const got = await host.apply(ref, rev, cell(i % 2 ? 5 : 6, `k${i}`), i % 2 ? 'owner' : 'guest:L1')
        serial.push(performance.now() - t0)
        rev = (got as { rev: number }).rev
      }
      // At once: two ops sent in the same moment, as two people typing together (the second waits its turn in the lane).
      const together: number[] = []
      for (let i = 0; i < 20; i++) {
        const t0 = performance.now()
        const [a, b] = await Promise.all([host.apply(ref, rev, cell(7, `a${i}`), 'owner'), host.apply(ref, rev, cell(8, `b${i}`), 'guest:L1')])
        together.push(performance.now() - t0)
        rev = Math.max((a as { rev: number }).rev, (b as { rev: number }).rev)
      }
      console.log(JSON.stringify({ bytes: size, serial: times(serial), pairOfOps: times(together) }))
      expect(size).toBeGreaterThan(5 * 1024 * 1024)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 600_000)
})
