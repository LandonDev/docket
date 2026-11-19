#!/usr/bin/env bun
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LIBREOFFICE_CONVERTERS } from '../../src/main/server/work/formats'
import { convertersOf, JobRunner } from '../../src/main/server/work/formats/jobs'

/**
 * One conversion through the host's job runner, outside the app, on the
 * tools the installer left under <userData>/work-tools/: the toolchain's
 * check that a job runs on this host.
 *
 *   bun scripts/work-tools/convert.ts --data <userData> --from odt --to docx <input> [--out <file>]
 *
 * Prints the result as JSON: the output's path, its size, the host that ran
 * it and the converter's warnings. Exits 1 when the job fails.
 */
const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(name)
  return i > 0 ? process.argv[i + 1] : undefined
}

const dataDir = arg('--data') ?? process.env.TEMP_CODE_USER_DATA
const from = arg('--from')
const to = arg('--to')
const input = process.argv.at(-1)
if (!dataDir || !from || !to || !input || input.startsWith('--')) {
  console.error('usage: convert.ts --data <userData> --from <fmt> --to <fmt> [--out <file>] <input>')
  process.exit(2)
}
const runner = new JobRunner({ host: 'cli', dataDir, converters: convertersOf([{ id: 'formats', ensure() {}, convert: LIBREOFFICE_CONVERTERS }]), log: (l) => console.error(l) })
const started = Date.now()
try {
  const out = arg('--out') ?? join(mkdtempSync(join(tmpdir(), 'tc-convert-')), `out.${to}`)
  const r = await runner.convert({ from, to, input, output: out })
  const bytes = readFileSync(r.output)
  console.log(JSON.stringify({ ok: true, output: r.output, bytes: bytes.length, zip: bytes.subarray(0, 2).toString() === 'PK', ranOn: r.ranOn, warnings: r.warnings, ms: Date.now() - started }))
} catch (err) {
  console.log(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }))
  process.exit(1)
}
