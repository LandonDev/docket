import { notBuilt, type HostId } from '@shared/work'
import type { CtxPart } from '../ctx'

/**
 * `ctx.convert`: one conversion job, run on a host that has the tool. A
 * stub: milestone 15 builds the job runner, the converter registry
 * (`WorkModule.convert`) and the forwarding to a linked host.
 */

/** One conversion: a file in one format to a file in another. */
export interface ConvertJob {
  /** the format's short name: `docx`, `odt`, `pdf`, `pptx`, `md`, `html`, … */
  from: string
  to: string
  /** absolute path of the input on this host */
  input: string
  /** where the output goes; the job's own temp dir when absent */
  output?: string
  /** the converter's own switches */
  options?: Record<string, unknown>
  signal?: AbortSignal
}
export interface ConvertResult {
  /** absolute path of the output on this host */
  output: string
  /** the host that ran it: a forwarded job names the linked host */
  ranOn: HostId
  /** what the converter could not carry over, one line each */
  warnings: string[]
}
/** One converter a module registers (`WorkModule.convert`), keyed by `(from, to)`. */
export interface Converter {
  from: string
  to: string
  /** the toolchain tool it needs (`scripts/work-tools/<pillar>.json`); a host without it forwards the job */
  needs?: string
  run(job: ConvertJob): Promise<ConvertResult>
}

export const convertPart: CtxPart<'convert'> = () => ({
  convert: notBuilt('ctx.convert', 15)
})
