import { WebSocket } from 'ws'
import type { LinkRequest } from './remote/peerCalls'

/**
 * A proof's stand-in for a linked host (scripts/e2e-code-update.ts): an
 * isolated instance started with `TEMP_CODE_CODE_HOST=self` takes code-only
 * updates from its own server, asked over a real loopback socket, so one
 * packaged copy plays the host that offers a pack and the Mac that takes
 * it. Honored only with an isolated userData, the rule the update feed
 * override follows (update.ts): on the real instance a host named by the
 * environment would be a way to put any code in the app.
 */
export const HARNESS_HOST = 'harness'

export function harnessHostWanted(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!env.TEMP_CODE_USER_DATA && env.TEMP_CODE_CODE_HOST === 'self'
}

/** One request to this instance's own loopback server, on a socket of its own. */
export function selfLink(port: () => number): LinkRequest {
  return (method, params, opts) =>
    new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port()}/`)
      const timer = setTimeout(() => {
        ws.terminate()
        reject(new Error(`${method} timed out`))
      }, opts?.timeoutMs ?? 30_000)
      ws.on('open', () => ws.send(JSON.stringify({ id: 'code', method, params })))
      ws.on('message', (data) => {
        let frame: { id?: string; ok?: boolean; result?: unknown; error?: string }
        try {
          frame = JSON.parse(String(data)) as typeof frame
        } catch {
          return
        }
        if (frame.id !== 'code') return
        clearTimeout(timer)
        ws.close()
        if (frame.ok) resolve(frame.result)
        else reject(new Error(frame.error ?? `${method} failed`))
      })
      ws.on('error', (err) => {
        clearTimeout(timer)
        reject(err)
      })
    })
}
