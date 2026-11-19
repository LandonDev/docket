import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, test } from 'vitest'
import { patchXlsx, type EditSpec } from '../patch/patch'
import { ironcalc } from '../patch/recalc'
import { colName } from '../patch/xml'

/**
 * The sheet research's round-trip harness as a test (reports/nJLC5WoplSWf §2, lab/scripts/runner.py):
 * every corpus file gets its manifest's edit through the patch writer with IronCalc, then the lab's
 * checkers count the features lost (L) or changed (C) at the XML level and the values that differ
 * when LibreOffice reopens and recalculates it (V). The writer must score 16 of 16 with L0 C0 V0.
 *
 * Opt-in, since it runs LibreOffice: SHEET_HARNESS=1. It needs a python with lxml
 * (SHEET_HARNESS_PYTHON), LibreOffice's own python (SHEETLAB_LOPY), IronCalc (IRONCALC_DIR), and
 * for the two big files the lab's corpus (SHEET_CORPUS_BIG). The defaults are the box's.
 */
const LAB = '/srv/agents/work/temp-code/.temp-code/reports/nJLC5WoplSWf/lab'
const PYTHON = process.env.SHEET_HARNESS_PYTHON ?? '/tmp/sheetlab/tools/py/bin/python'
const LOPY = process.env.SHEETLAB_LOPY ?? '/tmp/sheetlab/tools/lo/opt/libreoffice26.8/program/python'
const IRONCALC = process.env.IRONCALC_DIR ?? '/srv/agents/temp-code-data/work-tools/ironcalc/0.9.1'
const BIG = process.env.SHEET_CORPUS_BIG ?? join(LAB, 'corpus')
/** LibreOffice's verdict on an unchanged file, cached by its hash: the lab's cache when it is there. */
const REF = process.env.SHEETLAB_REF ?? (existsSync(join(LAB, 'results/_reference')) ? join(LAB, 'results/_reference') : join(tmpdir(), 'sheet-harness-ref'))
const HERE = __dirname
const on = process.env.SHEET_HARNESS === '1'

interface Entry {
  file: string
  edit: { sheet: string; cell: string; value: string }
  large: boolean
}
const manifest = JSON.parse(readFileSync(join(HERE, 'corpus/manifest.json'), 'utf8')) as { files: Entry[] }
const pathOf = (e: Entry): string => (e.large ? join(BIG, e.file) : join(HERE, 'corpus', e.file))
const scratch = mkdtempSync(join(tmpdir(), 'sheet-harness-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

function python<T>(script: string, args: string[], timeoutMs: number): T {
  const p = spawnSync(PYTHON, ['-I', join(HERE, script), ...args], { encoding: 'utf8', timeout: timeoutMs, env: { ...process.env, SHEETLAB_LOPY: LOPY, SHEETLAB_REF: REF } })
  if (p.status !== 0) throw new Error(`${script} failed: ${(p.stderr || p.stdout || String(p.error)).slice(-1500)}`)
  return JSON.parse(p.stdout.trim().split('\n').pop()!) as T
}

async function patched(input: string, edits: EditSpec[], name: string): Promise<{ out: string; report: Awaited<ReturnType<typeof patchXlsx>>['report'] }> {
  const { bytes, report } = await patchXlsx(new Uint8Array(readFileSync(input)), edits, { inputPath: input, recalc: (path, e, keys) => ironcalc(IRONCALC, path, e, keys) })
  const out = join(scratch, name)
  writeFileSync(out, bytes)
  return { out, report }
}

describe.skipIf(!on)('the patch writer on the research corpus', () => {
  test('the manifest lists 16 files', () => {
    expect(manifest.files).toHaveLength(16)
  })
  for (const entry of manifest.files) {
    test(
      `${entry.file}: nothing lost, changed or wrong`,
      async () => {
        const { out, report } = await patched(pathOf(entry), [entry.edit], entry.file)
        expect(report.recalc.ok).toBe(true)
        const got = python<{ L: number; C: number; V: number; bad: string[]; stale: number }>('check.py', [pathOf(entry), out, entry.edit.sheet, entry.edit.cell, String(entry.edit.value)], 40 * 60_000)
        expect({ file: entry.file, L: got.L, C: got.C, V: got.V, bad: got.bad }).toEqual({ file: entry.file, L: 0, C: 0, V: 0, bad: [] })
      },
      45 * 60_000
    )
  }
  test(
    'a 1,000-cell batch on the 100,000-row file saves and reopens with every cached value right',
    async () => {
      const entry = manifest.files.find((f) => f.file === 'big_100k.xlsx')!
      const edits: EditSpec[] = []
      for (let r = 2; r <= 101; r++) for (let c = 1; c <= 10; c++) edits.push({ sheet: entry.edit.sheet, cell: `${colName(c)}${r}`, value: c >= 9 ? `t${r}` : r + c / 10 })
      const { out, report } = await patched(pathOf(entry), edits, 'batch_100k.xlsx')
      expect(report.recalc.ok).toBe(true)
      expect(report.edits).toBe(1000)
      const got = python<{ formulas: number; match: number; mismatch: number; examples: string[] }>('batch.py', [out], 45 * 60_000)
      expect(got.formulas).toBeGreaterThan(800_000)
      expect({ mismatch: got.mismatch, examples: got.examples }).toEqual({ mismatch: 0, examples: [] })
    },
    50 * 60_000
  )
})
