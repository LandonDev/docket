/**
 * What the live video proofs on the Mac share (scripts/e2e-computer-video.ts, scripts/e2e-video-viewer.ts):
 * the idle gate, the watch for the person's input, the clock check, the service's CPU and the screen's rate.
 */
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'

export class InputReturned extends Error {}

/** Five minutes with no input before a window shows, waiting at most 45 minutes, checked every 20 s. */
export async function idleGate(idle: () => number, log: (line: string) => void, opts: { needS?: number; waitMs?: number } = {}): Promise<{ ok: boolean; idle: number; why: string }> {
  const need = opts.needS ?? 300
  const until = Date.now() + (opts.waitMs ?? 45 * 60_000)
  let seconds = idle()
  for (;;) {
    if (seconds >= need) return { ok: true, idle: Math.round(seconds), why: '' }
    if (Date.now() >= until) return { ok: false, idle: Math.round(seconds), why: `not run: no idle gap in 45 min (idle ${Math.round(seconds)} s at the end)` }
    log(`waiting for ${need} s with no input (idle ${Math.round(seconds)} s)`)
    await new Promise((r) => setTimeout(r, 20_000))
    seconds = idle()
  }
}

/** Reads the idle time every half second while a window shows; `nap` throws once the person touched the Mac. */
export const watchInput = {
  read: null as (() => number) | null,
  last: 0,
  timer: null as NodeJS.Timeout | null,
  returned: null as string | null,
  start(read: () => number): void {
    this.read = read
    this.last = read()
    this.timer = setInterval(() => {
      const now = read()
      if (now + 1 < this.last) this.returned = `input returned (idle ${this.last.toFixed(0)} s → ${now.toFixed(1)} s): the run stopped`
      this.last = now
    }, 500)
  },
  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  },
  async nap(ms: number): Promise<void> {
    for (const until = Date.now() + ms; Date.now() < until; ) {
      if (this.returned) throw new InputReturned(this.returned)
      await new Promise((r) => setTimeout(r, Math.min(100, until - Date.now())))
    }
    if (this.returned) throw new InputReturned(this.returned)
  }
}

export function percentile(values: number[], p: number): number {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.round((sorted.length - 1) * p))]
}

/**
 * Whether `process.hrtime` reads CLOCK_UPTIME_RAW, the clock the service stamps a frame's capture with: another
 * process reads CLOCK_UPTIME_RAW between two reads of hrtime, five times, and each lies between them.
 */
export function sameClock(): string {
  let worst = 0
  for (let i = 0; i < 5; i++) {
    const before = process.hrtime.bigint()
    const raw = BigInt(execFileSync('/usr/bin/python3', ['-c', 'import time; print(time.clock_gettime_ns(time.CLOCK_UPTIME_RAW))'], { encoding: 'utf8' }).trim())
    const after = process.hrtime.bigint()
    if (raw < before || raw > after) return `not the same: CLOCK_UPTIME_RAW ${raw} outside hrtime ${before}..${after}`
    worst = Math.max(worst, Number(after - before) / 1e6)
  }
  return `same: CLOCK_UPTIME_RAW read by python3 fell between two process.hrtime reads, five times out of five (the widest ${worst.toFixed(0)} ms apart)`
}

/** `ps -o cputime` as seconds: `M:SS.ss`, `H:MM:SS.ss`, or with days, `D-H:MM:SS`. */
export function cpuTimeSeconds(text: string): number {
  const [days, rest] = text.trim().includes('-') ? text.trim().split('-') : ['0', text.trim()]
  return Number(days) * 86_400 + rest.split(':').reduce((sum, part) => sum * 60 + Number(part), 0)
}

/** A process's CPU time (user and system), from `ps -o cputime`. */
export function serviceCpuSeconds(pid: number): number {
  return cpuTimeSeconds(execFileSync('ps', ['-o', 'cputime=', '-p', String(pid)], { encoding: 'utf8' }))
}

const REFRESH_SOURCE = `import AppKit
// the refresh rate of the screen under the first on-screen window of a pid
let pid = Int32(CommandLine.arguments[1])!
let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] ?? []
let bounds = list.first { ($0[kCGWindowOwnerPID as String] as? Int32) == pid }.flatMap { $0[kCGWindowBounds as String] as? NSDictionary }.flatMap { CGRect(dictionaryRepresentation: $0) }
var display: CGDirectDisplayID = CGMainDisplayID()
var count: UInt32 = 0
if let bounds { _ = CGGetDisplaysWithPoint(CGPoint(x: bounds.midX, y: bounds.midY), 1, &display, &count) }
let screen = NSScreen.screens.first { ($0.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value == display }
print(screen?.maximumFramesPerSecond ?? 0)
`

/** The refresh of the screen a pid's window is on (`NSScreen.maximumFramesPerSecond`), through a helper built under `dir`. */
export function screenRefresh(dir: string, pid: number): number {
  const source = `${dir}/screen-refresh.swift`
  const binary = `${dir}/screen-refresh`
  writeFileSync(source, REFRESH_SOURCE)
  execFileSync('xcrun', ['swiftc', '-O', '-o', binary, source], { stdio: 'pipe' })
  return Number(execFileSync(binary, [String(pid)], { encoding: 'utf8' }).trim()) || 0
}
