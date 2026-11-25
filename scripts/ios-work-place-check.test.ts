import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// scripts/lib/work_place_check.py: a Work place's ready file (TestHooks.recordPlaceLoaded) held to its shot.
const checker = join(import.meta.dirname, 'lib', 'work_place_check.py')

function run(report: unknown, ...args: string[]): { status: number | null; out: string } {
  const dir = mkdtempSync(join(tmpdir(), 'work-place-'))
  const path = join(dir, 'place-people.json')
  if (report !== undefined) writeFileSync(path, typeof report === 'string' ? report : JSON.stringify(report))
  const done = spawnSync('python3', [checker, path, 'm2-20-people-all-light', ...args], { encoding: 'utf8' })
  return { status: done.status, out: done.stdout + done.stderr }
}

describe('work_place_check.py', () => {
  it('passes a list with enough rows and no failure', () => {
    const done = run({ rows: 3, failed: 0 }, '3')
    expect(done.status).toBe(0)
    expect(done.out).toContain('work place m2-20-people-all-light PASS (3 rows)')
  })

  it('fails a list short of its rows, or one whose read failed', () => {
    expect(run({ rows: 2, failed: 0 }, '3')).toMatchObject({ status: 1, out: expect.stringContaining('WORK PLACE FAIL (m2-20-people-all-light) 2 rows, at least 3 wanted') })
    expect(run({ rows: 3, failed: 1 }, '1')).toMatchObject({ status: 1, out: expect.stringContaining('the read failed (3 rows kept)') })
  })

  it('with `failed`, passes only a read that failed', () => {
    expect(run({ rows: 0, failed: 1 }, '0', 'failed')).toMatchObject({ status: 0, out: expect.stringContaining('PASS (0 rows, failed as meant)') })
    expect(run({ rows: 4, failed: 0 }, '0', 'failed')).toMatchObject({ status: 1, out: expect.stringContaining('meant to fail and did not') })
  })

  it('says so when the report is missing, unreadable or not a place report', () => {
    expect(run(undefined, '1').status).toBe(2)
    expect(run('{not json', '1').status).toBe(2)
    expect(run({ rows: 'three' }, '1')).toMatchObject({ status: 1, out: expect.stringContaining('not a place report') })
    expect(run({ rows: 1, failed: 0 }, '1', 'nope').status).toBe(2)
  })
})
