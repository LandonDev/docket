import { spawn } from 'node:child_process'
import { OfficeError } from './carrier'

/**
 * One osascript run: the script on stdin, its arguments as `argv`, its
 * answer on stdout. The Mac carrier's only way out (mac.ts); a test hands
 * the carrier a recorded `Osa` instead.
 *
 * macOS attributes the Apple Events to TempCode (osascript's responsible
 * app), so the Automation prompt names TempCode, once per Office app.
 */
export type OsaLang = 'JavaScript' | 'AppleScript'
export type Osa = (lang: OsaLang, script: string, args: readonly string[], signal?: AbortSignal) => Promise<string>

/** A long range read is one Apple Event, but Excel may take a while to pack it. */
export const OSA_TIMEOUT_MS = 120_000

export const runOsa: Osa = (lang, script, args, signal) =>
  new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/osascript', ['-l', lang, '-', ...args], { stdio: ['pipe', 'pipe', 'pipe'], signal, timeout: OSA_TIMEOUT_MS })
    let out = ''
    let err = ''
    child.stdout.setEncoding('utf8').on('data', (d: string) => (out += d))
    child.stderr.setEncoding('utf8').on('data', (d: string) => (err += d))
    child.on('error', (e) => reject(new OfficeError(`osascript did not run: ${e.message}`)))
    child.on('close', (code) => (code === 0 ? resolve(out.replace(/\n$/, '')) : reject(osaError(err))))
    child.stdin.end(script)
  })

/** osascript's stderr as a refusal in words. */
export function osaError(stderr: string): OfficeError {
  const code = /\((-\d+)\)\s*$/.exec(stderr.trim())?.[1]
  const app = /(Microsoft \w+)/.exec(stderr)?.[1] ?? 'the Office app'
  switch (code) {
    case '-1743':
      return new OfficeError(`TempCode may not control ${app}: allow it in System Settings → Privacy & Security → Automation.`, 'not-allowed')
    case '-1744':
      return new OfficeError(`${app} asks the owner once whether TempCode may control it: he answers that prompt on the Mac.`, 'needs-consent')
    case '-600':
      return new OfficeError(`${app} is not open.`, 'not-running')
    case '-1728':
    case '-1719':
      return new OfficeError(`${app} has no such item: ${tail(stderr)}`, 'not-found')
  }
  return new OfficeError(`${app} answered: ${tail(stderr)}`)
}

const tail = (s: string): string => {
  const line = s.trim().split('\n').pop() ?? ''
  const msg = line.replace(/^.*?execution error:\s*/, '').trim()
  return msg.length > 200 ? `${msg.slice(0, 200)}…` : msg || 'no answer'
}
