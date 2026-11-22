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

/**
 * A long range read is one Apple Event, but Excel may take a while to pack it. Under the host link's 120
 * seconds, so a call from another host of his hears this Mac's own words for an app that does not answer
 * rather than the link's bare "did not answer".
 */
export const OSA_TIMEOUT_MS = 100_000

/** The app never answered the script: something modal holds it (a dialog of its own, or a prompt of the system's). */
export class OsaTimeout extends OfficeError {
  constructor() {
    super('the Office app did not answer.', 'busy')
  }
}

export const runOsa: Osa = (lang, script, args, signal) =>
  new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/osascript', ['-l', lang, '-', ...args], { stdio: ['pipe', 'pipe', 'pipe'], signal, timeout: OSA_TIMEOUT_MS })
    let out = ''
    let err = ''
    child.stdout.setEncoding('utf8').on('data', (d: string) => (out += d))
    child.stderr.setEncoding('utf8').on('data', (d: string) => (err += d))
    child.on('error', (e) => reject(new OfficeError(`osascript did not run: ${e.message}`)))
    // killed at the time limit: no exit code, and nothing on stderr to read
    child.on('close', (code, sig) => (code === 0 ? resolve(out.replace(/\n$/, '')) : code === null && sig && !signal?.aborted ? reject(new OsaTimeout()) : reject(osaError(err))))
    child.stdin.end(script)
  })

/** osascript's stderr as a refusal in words. */
export function osaError(stderr: string): OfficeError {
  // A script's own throw reaches stderr wrapped by JXA: "Error: Error: Microsoft Word is not open. (-600) (-2700)".
  // The code the script gave is the one that says what went wrong; -2700 alone is the wrapper's.
  const codes = [...stderr.matchAll(/\((-\d+)\)/g)].map((m) => m[1])
  const code = codes.find((c) => c !== '-2700') ?? codes.at(-1)
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
  const msg = line
    .replace(/^.*?execution error:\s*/, '')
    .replace(/^(Error:\s*)+/, '')
    .replace(/\s*\(-2700\)\s*$/, '')
    .trim()
  return msg.length > 200 ? `${msg.slice(0, 200)}…` : msg || 'no answer'
}
