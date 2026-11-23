import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { parseReceipt } from '@shared/work/money'
import type { Converter, ConvertJob, ConvertResult, ConvertRun } from '../formats/jobs'
import { runTool, Toolchain } from '../formats/tools'
import type { WorkCtx } from '../modules'
import { PDF_CONVERTERS } from '../pdf/extract'
import { FIXTURES, FIXTURE_TODAY } from './fixtures/receipts'
import { MONEY_CONVERTERS, readReceipt } from './reader'

/*
 * The real reader on the made-up receipts: RapidOCR from the Docling tool
 * folder for a picture, the pdf pillar's tools for a PDF, then the one
 * parser. It runs torch on the processor for each file, so it runs only
 * where it is asked for and the tools are installed:
 *
 *   TC_MONEY_TOOLS=/srv/agents/temp-code-data NODE_ENV=test bunx vitest run src/main/server/work/money/reader.proof.test.ts
 *
 * (the folder is the host's userData, which holds `work-tools/`; through
 * `heavy` on the box). Anywhere else it is skipped, by name.
 */

const dataDir = process.env.TC_MONEY_TOOLS
const tools = dataDir ? new Toolchain(dataDir) : null
const installed = !!tools && tools.has('docling-venv') && tools.has('docling-models') && tools.has('pdf-tools')
const root = mkdtempSync(join(tmpdir(), 'money-proof-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

let jobs = 0
/** The conversion runner in small: the converter for the pair, run here with the host's own tools. */
async function convert(job: ConvertJob): Promise<ConvertResult> {
  const converter = [...MONEY_CONVERTERS, ...PDF_CONVERTERS].find((c: Converter) => c.from === job.from && c.to === job.to)
  if (!converter) throw new Error(`no converter for ${job.from} to ${job.to}`)
  const dir = join(root, String(++jobs))
  mkdirSync(join(dir, 'tmp'), { recursive: true })
  const output = join(dir, `out.${job.to === 'lines' || job.to === 'extract' ? 'json' : job.to}`)
  const signal = new AbortController().signal
  const run: ConvertRun = { tools: tools!, threads: 2, slot: 0, tmp: join(dir, 'tmp'), signal, run: (cmd, args, o) => runTool(cmd, args, { ...o, signal }) }
  const { warnings = [] } = await converter.run({ ...job, output }, run)
  return { output, ranOn: 'here', warnings }
}
const ctx = { convert } as unknown as Pick<WorkCtx, 'convert'>

describe.skipIf(!installed)(installed ? 'the real reader on the made-up receipts' : 'the real reader (skipped: no Docling tool folder here; set TC_MONEY_TOOLS to the host’s data folder)', () => {
  it.each(FIXTURES.map((f) => [f.file, f] as const))(
    '%s reads to the fields the parser must find',
    async (_name, f) => {
      const lines = await readReceipt(ctx, join(import.meta.dirname, 'fixtures', f.file))
      expect(lines.length).toBeGreaterThan(0)
      expect(parseReceipt(lines, { sector: f.sector, today: FIXTURE_TODAY })).toEqual(f.expected)
    },
    180_000
  )
})
