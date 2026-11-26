/**
 * The live box comes first. While a perf run measures, this asks the live service for its hello every 5 s (the
 * same read-only ask `tc-local --hello` makes) and times the answer; two in a row over 800 ms abort the run with
 * "the live box slowed". It reads `server.json` for the port and sends nothing but the socket's open. Beside the
 * hello it reads the machine's io pressure (`some avg10` in /proc/pressure/io: the share of the last ten seconds
 * in which some task waited on the disk) and aborts with "the box's disk is under pressure" when it passes 30.
 * `scripts/perf/guarded.ts <cmd>` runs any command under it.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export const GUARD_EVERY_MS = 5000
export const GUARD_LIMIT_MS = 800
export const LIVE_DATA = '/srv/agents/temp-code-data'
export const LIVE_SLOWED = 'the live box slowed'
export const PRESSURE_FILE = '/proc/pressure/io'
export const PRESSURE_LIMIT = 30
export const DISK_PRESSED = "the box's disk is under pressure"

/** `some avg10` of a pressure file, in percent; null where the kernel keeps none (a laptop, a container). */
export function ioPressure(file = PRESSURE_FILE): number | null {
  try {
    const avg10 = readFileSync(file, 'utf8').match(/^some\s.*?\bavg10=(\d+(?:\.\d+)?)/m)?.[1]
    return avg10 === undefined ? null : Number(avg10)
  } catch {
    return null
  }
}

/** Whether the last answers say stop: two in a row over the limit. A missed answer counts as over. */
export function slowed(times: (number | null)[], limit = GUARD_LIMIT_MS): boolean {
  const [a, b] = times.slice(-2)
  return times.length >= 2 && (a === null || a! > limit) && (b === null || b! > limit)
}

/** One hello from the live service, in ms; null when it did not answer within 4 s or no service is there. */
export function helloMs(data = LIVE_DATA): Promise<number | null> {
  let port: number
  try {
    port = (JSON.parse(readFileSync(join(data, 'server.json'), 'utf8')) as { port: number }).port
  } catch {
    return Promise.resolve(null)
  }
  return new Promise((resolve) => {
    const at = performance.now()
    const ws = new WebSocket(`ws://127.0.0.1:${port}/`)
    const done = (ms: number | null): void => {
      clearTimeout(timer)
      ws.onmessage = ws.onerror = ws.onclose = null
      ws.close()
      resolve(ms)
    }
    const timer = setTimeout(() => done(null), 4000)
    ws.onmessage = (event) => {
      try {
        if ((JSON.parse(String(event.data)) as { push?: string }).push === 'hello') done(performance.now() - at)
      } catch {
        // not the hello
      }
    }
    ws.onerror = ws.onclose = () => done(null)
  })
}

/**
 * Starts the guard; `stop()` returns every answer time it saw and `pressure()` the highest io pressure. With no
 * live service on this machine the hello is not judged; the pressure still is, where the kernel keeps it.
 */
export function guardLiveBox(
  abort: AbortController, ask: () => Promise<number | null> = helloMs, pressed: () => number | null = ioPressure
): { stop(): (number | null)[]; pressure(): number | null } {
  const times: (number | null)[] = []
  let live: boolean | null = null
  let highest: number | null = null
  const timer = setInterval(async () => {
    const io = pressed()
    if (io !== null) {
      highest = Math.max(highest ?? 0, io)
      if (io > PRESSURE_LIMIT) abort.abort(new Error(DISK_PRESSED))
    }
    const ms = await ask()
    // No service at all (a laptop, a CI box) is not a slow one.
    if (live === null) live = ms !== null
    if (!live) return
    times.push(ms === null ? null : Math.round(ms))
    if (slowed(times)) abort.abort(new Error(LIVE_SLOWED))
  }, GUARD_EVERY_MS)
  return {
    stop() {
      clearInterval(timer)
      return times
    },
    pressure: () => highest
  }
}
