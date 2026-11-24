import { describe, expect, it } from 'vitest'
import { groups, medianCell, report, type ReportTake } from './pcDriveReport'

const take = (step: string, window: 'pc' | 'mac', run: number, ms: number | null): ReportTake => ({
  window,
  step,
  run,
  ms,
  marks: { rows: ms },
  failed: ms === null ? 'This PC did not answer' : null,
  link: { up: 1000, down: 2 ** 20, turns: 40 },
  take: { calls: [{ link: 'local', method: 'work.files.list', params: {}, at: 0, ms: ms ?? 30_000, ok: ms !== null, size: 100, n: 300 }], gap: 16, task: 0, bytesIn: {}, ms: 0 },
  stalls: { pc: ms === null ? ['2026-11-24T17:48:23.254Z loop max=6774ms mean=313ms'] : [], box: [] }
})

describe('the PC drive bench report', () => {
  it('groups the runs of one step in one window, in order', () => {
    const g = groups([take('list', 'pc', 1, 1), take('list', 'mac', 1, 2), take('list', 'pc', 2, 3)])
    expect(g.map((ts) => ts.map((t) => `${t.window}${t.run}`))).toEqual([['pc1', 'pc2'], ['mac1']])
  })

  it('says how many runs never came', () => {
    expect(medianCell([take('a', 'pc', 1, 2000), take('a', 'pc', 2, 4000), take('a', 'pc', 3, 9000)])).toBe('4.0')
    expect(medianCell([take('a', 'pc', 1, 2000), take('a', 'pc', 2, null)])).toBe('2.0 (1 of 2)')
    expect(medianCell([take('a', 'pc', 1, null)])).toBe('never (0 of 1)')
  })

  it('writes one row per step and window, and the host lines of a run', () => {
    const md = report({ label: 'before', version: '1.0.375', installer: '/x/temp-code-1.0.375-setup.exe', tree: '/t', shape: { delayMs: 20, rateMbit: 8 }, runs: 1, startedAt: 'now', minutes: 1, takes: [take('list Bench (cold)', 'pc', 1, null)], rpcs: [] })
    expect(md).toContain("| list Bench (cold) | PC's window | never (0 of 1) | rows — | 1 | 40 | 1.0 / 0.0 | 16 |")
    expect(md).toContain('host lines: PC loop max=6774ms mean=313ms')
  })
})
