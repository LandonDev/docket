import { appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Boot timing trail: `/tmp/temp-code-boot.log` (beside the release
 *  worker's log; the temp dir on Windows, which has no /tmp) plus the
 *  console. Each line is milliseconds since the process started, so a slow
 *  startup shows exactly which step ate it. */
export const BOOT_LOG = process.platform === 'win32' ? join(tmpdir(), 'temp-code-boot.log') : '/tmp/temp-code-boot.log'

export function bootMark(label: string, detail?: string): void {
  const ms = Math.round(process.uptime() * 1000)
  const line = `${ms} ${label}${detail ? ` ${detail}` : ''}`
  console.log(`[boot] ${line}`)
  try {
    appendFileSync(BOOT_LOG, `${line}\n`)
  } catch {
    // timing evidence, never a failure
  }
}
