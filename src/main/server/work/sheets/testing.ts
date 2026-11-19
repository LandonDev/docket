import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runTool, type Toolchain } from '../formats/tools'
import { STRUCTURAL_CONVERTERS, type StructuralOp } from './structural'

/** For tests: LibreOffice as the toolchain installs it on the box. */
export const SOFFICE =
  process.env.SHEET_SOFFICE ??
  '/srv/agents/temp-code-data/work-tools/libreoffice/26.8.3/opt/libreoffice26.8/program/soffice'

/** The converter, run in this process as the job runner runs it. */
export async function libreOffice(
  input: string,
  ops: StructuralOp[],
  kind: 'xlsx' | 'xlsm'
): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'tc-sheet-job-'))
  const tmp = join(dir, 'tmp')
  mkdirSync(tmp)
  const output = join(dir, `out.${kind}`)
  const c = STRUCTURAL_CONVERTERS.find((x) => x.from === kind)!
  await c.run(
    { from: kind, to: `${kind}+ops`, input, output, options: { ops } },
    {
      tools: { bin: () => SOFFICE } as unknown as Toolchain,
      threads: 1,
      slot: 0,
      tmp,
      signal: new AbortController().signal,
      run: (cmd, args, o) => runTool(cmd, args, o)
    }
  )
  return output
}
