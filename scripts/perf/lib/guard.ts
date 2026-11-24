/**
 * The live box comes first. While a perf run measures, this asks the live service for its hello every 5 s (the
 * same read-only ask `tc-local --hello` makes) and times the answer; two in a row over 800 ms abort the run with
 * "the live box slowed". It reads `server.json` for the port and sends nothing but the socket's open.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export const GUARD_EVERY_MS = 5000
export const GUARD_LIMIT_MS = 800
export const LIVE_DATA = '/srv/agents/temp-code-data'
export const LIVE_SLOWED = 'the live box slowed'

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

/** Starts the guard; `stop()` returns every answer time it saw. With no live service on this machine it watches nothing. */
export function guardLiveBox(abort: AbortController, ask: () => Promise<number | null> = helloMs): { stop(): (number | null)[] } {
  const times: (number | null)[] = []
  let live: boolean | null = null
  const timer = setInterval(async () => {
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
    }
  }
}
