import { randomBytes } from 'node:crypto'
import WebSocket from 'ws'

/**
 * A document's socket carried over the host's own link
 * (docs/agents/work-docs.md "The socket"). The editor's provider makes its
 * socket with the renderer's `RelaySocket`; that asks `work.docs.connect`,
 * and this host opens the real socket to its own Work service on loopback.
 * Frames the editor sends arrive in order through `work.docs.send`; frames
 * the service sends wait here until the next `work.docs.recv`, which waits
 * up to 20 s for one. So a far window (the Mac's app on a box thread, the
 * phone) edits a box document with no route to the service's port, and
 * nothing of one person's socket reaches another's link.
 *
 * A socket nobody has asked after for a minute is closed.
 */

export const RECV_WAIT_MS = 20_000
export const IDLE_MS = 60_000
/** The most bytes waiting for one socket before it is closed as stalled. */
export const QUEUE_MAX = 16 * 1024 * 1024
/** The most sockets open on a host at once: each holds a loopback socket and its queue. */
export const SOCKETS_MAX = 64

export interface RelayClosed {
  code: number
  reason: string
}

interface Relayed {
  id: string
  doc: string
  ws: WebSocket
  frames: Buffer[]
  bytes: number
  closed: RelayClosed | null
  waiter: (() => void) | null
  lastAsked: number
  /** frames sent before the service's socket opened */
  early: Buffer[]
}

export interface Relay {
  connect(url: string, doc: string): string
  send(id: string, frames: readonly string[]): void
  recv(id: string, signal?: AbortSignal): Promise<{ frames: string[]; closed?: RelayClosed }>
  close(id: string): void
  /** The documents that have a socket open, for a subscription held only while one does. */
  docs(): Set<string>
  stop(): void
}

export function createRelay(opts: { onDocs?(docs: Set<string>): void; now?: () => number; idleMs?: number; waitMs?: number; socket?: (url: string) => WebSocket } = {}): Relay {
  const now = opts.now ?? Date.now
  const waitMs = opts.waitMs ?? RECV_WAIT_MS
  const sockets = new Map<string, Relayed>()
  const docsOpen = () => new Set([...sockets.values()].filter((s) => !s.closed).map((s) => s.doc))
  const changed = () => opts.onDocs?.(docsOpen())

  const finish = (s: Relayed, closed: RelayClosed): void => {
    if (s.closed) return
    s.closed = closed
    s.waiter?.()
    changed()
  }

  const sweep = setInterval(() => {
    const t = now()
    for (const s of sockets.values()) {
      if (t - s.lastAsked < (opts.idleMs ?? IDLE_MS)) continue
      sockets.delete(s.id)
      if (!s.closed) {
        s.ws.close(1000, 'idle')
        finish(s, { code: 1000, reason: 'idle' })
      }
    }
  }, 5_000)
  sweep.unref?.()

  const get = (id: string): Relayed => {
    const s = sockets.get(id)
    if (!s) throw new Error('that document socket is closed; open the document again')
    s.lastAsked = now()
    return s
  }

  return {
    connect(url, doc) {
      if ([...sockets.values()].filter((x) => !x.closed).length >= SOCKETS_MAX) throw new Error('too many documents are open on this host; close one and try again')
      const id = randomBytes(18).toString('base64url')
      const ws = opts.socket ? opts.socket(url) : new WebSocket(url, { maxPayload: 4 * 1024 * 1024 })
      const s: Relayed = { id, doc, ws, frames: [], bytes: 0, closed: null, waiter: null, lastAsked: now(), early: [] }
      sockets.set(id, s)
      ws.binaryType = 'nodebuffer'
      ws.on('open', () => {
        for (const frame of s.early.splice(0)) ws.send(frame)
      })
      ws.on('message', (data: Buffer | ArrayBuffer | Buffer[]) => {
        // Closed (stalled, or by its window): what still arrives has nobody to go to.
        if (s.closed) return
        const frame = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as Buffer)
        s.bytes += frame.length
        if (s.bytes > QUEUE_MAX) {
          ws.close(4503, 'stalled')
          return finish(s, { code: 4503, reason: 'the window stopped reading this document' })
        }
        s.frames.push(frame)
        s.waiter?.()
      })
      ws.on('close', (code: number, reason: Buffer) => finish(s, { code, reason: reason.toString() }))
      ws.on('error', (err: Error) => finish(s, { code: 1011, reason: err.message }))
      changed()
      return id
    },

    send(id, frames) {
      const s = get(id)
      if (s.closed) throw new Error('that document socket is closed; open the document again')
      for (const frame of frames) {
        const bytes = Buffer.from(frame, 'base64')
        if (s.ws.readyState === WebSocket.OPEN) s.ws.send(bytes)
        else s.early.push(bytes)
      }
    },

    async recv(id, signal) {
      const s = get(id)
      if (s.frames.length === 0 && !s.closed) {
        await new Promise<void>((resolve) => {
          const done = () => {
            clearTimeout(timer)
            signal?.removeEventListener('abort', done)
            s.waiter = null
            resolve()
          }
          const timer = setTimeout(done, waitMs)
          signal?.addEventListener('abort', done)
          s.waiter = done
        })
      }
      s.lastAsked = now()
      const frames = s.frames.splice(0).map((f) => f.toString('base64'))
      s.bytes = 0
      if (s.closed && frames.length === 0) {
        sockets.delete(id)
        return { frames, closed: s.closed }
      }
      return { frames }
    },

    close(id) {
      const s = sockets.get(id)
      if (!s) return
      sockets.delete(id)
      s.ws.close(1000, 'closed')
      finish(s, { code: 1000, reason: 'closed' })
    },

    docs: docsOpen,

    stop() {
      clearInterval(sweep)
      for (const s of sockets.values()) {
        s.ws.terminate()
        finish(s, { code: 1001, reason: 'the host stopped' })
      }
      sockets.clear()
    }
  }
}
