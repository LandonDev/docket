import { appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Boot timing trail: `/tmp/temp-code-boot.log` (beside the release
 *  worker's log; the temp dir on Windows, which has no /tmp) plus the
 *  console. Each line is milliseconds since the process started, so a slow
 *  startup shows exactly which step ate it. */
export const BOOT_LOG = process.platform === 'win32' ? join(tmpdir(), 'temp-code-boot.log') : '/tmp/temp-code-boot.log'

const bootLine = (label: string, detail?: string): string => `${Math.round(process.uptime() * 1000)} ${label}${detail ? ` ${detail}` : ''}`

/** A step of the boot: the console and the boot log, written at once so a boot that dies still left its last step. */
export function bootMark(label: string, detail?: string): void {
  const line = bootLine(label, detail)
  console.log(`[boot] ${line}`)
  try {
    appendFileSync(BOOT_LOG, `${line}\n`)
  } catch {
    // timing evidence, never a failure
  }
}

/**
 * A line for the console alone, in the boot trail's words, for what happens all day long (a slow request): no
 * synchronous write to the boot log from the server's loop. The stall log keeps the same fact through its own
 * queue (stalls.ts `recordSlowRequest`).
 */
export function bootNote(label: string, detail?: string): void {
  console.log(`[boot] ${bootLine(label, detail)}`)
}
