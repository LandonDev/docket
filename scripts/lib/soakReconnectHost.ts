import { WebSocketServer, type WebSocket } from 'ws'
import { RECONNECT_TIMEOUT_MS, RECONNECT_WINDOW_MS, type Cursors, type ReconnectPhase, type ReconnectWire } from './soakReconnect'

type SocketBytes = () => number
type Measurement = {
  wire: ReconnectWire
  sockets: Map<SocketBytes, number>
  finish: (wire: ReconnectWire) => void
  timer: ReturnType<typeof setTimeout>
  connected?: () => void
}

/**
 * Watch the real remote listener in the synthetic host process. The port
 * filter leaves its loopback RPC and any other WebSocketServer alone. The
 * wrapper forwards the original ws.send overloads and payloads untouched.
 */
export function watchReconnectSocket(port: number, cursors: () => Cursors) {
  const peers = new Map<WebSocket, SocketBytes>()
  const original = WebSocketServer.prototype.handleUpgrade
  let active: Measurement | undefined
  let reopen: ReturnType<typeof setTimeout> | undefined

  const complete = (): void => {
    if (!active) return
    const { wire, sockets, timer, finish } = active
    clearTimeout(timer)
    for (const [written, start] of sockets) wire.socketBytes += written() - start
    active = undefined
    finish(wire)
  }

  const upgrade: typeof original = function (this: WebSocketServer, request, socket, head, accept) {
    if (request.socket.localPort !== port) return original.call(this, request, socket, head, accept)
    if (reopen) {
      if (active) active.wire.refusedUpgrades++
      socket.destroy()
      return
    }
    return original.call(this, request, socket, head, (ws, req) => {
      const written = (): number => req.socket.bytesWritten
      peers.set(ws, written)
      ws.once('close', () => peers.delete(ws))
      if (active) {
        const { wire, sockets } = active
        wire.connections++
        wire.remote &&= ws.extensions.split(',').includes('permessage-deflate')
        sockets.set(written, written())
        if (wire.connectedAt === null) {
          wire.connectedAt = Date.now()
          wire.connected = cursors()
          active.connected?.()
          if (wire.phase === 'cut') {
            clearTimeout(active.timer)
            wire.end = wire.connectedAt + RECONNECT_WINDOW_MS
            active.timer = setTimeout(complete, RECONNECT_WINDOW_MS)
          } else {
            wire.through = wire.connected
          }
        }
      }

      const requests = new Map<string, { method: string; afterSeq?: number; tail?: number }>()
      ws.prependListener('message', (data) => {
        if (!active) return
        try {
          const { id, method, params } = JSON.parse(data.toString()) as {
            id?: string; method?: string; params?: { afterSeq?: number; tail?: number }
          }
          if (typeof id === 'string' && typeof method === 'string') requests.set(id, { method, afterSeq: params?.afterSeq, tail: params?.tail })
        } catch {
          // The server owns malformed input.
        }
      })
      const send = ws.send
      ws.send = (...args: unknown[]): void => {
        const wire = active?.wire
        const payload = args[0]
        if (wire && Date.now() < wire.end && typeof payload === 'string') {
          // frameJson puts the id or push first. Read the small header and
          // page suffix without a second JSON parse of the whole transcript.
          const id = /^\{"id":("(?:[^"\\]|\\.)*"),/.exec(payload)?.[1]
          const key = id && JSON.parse(id) as string
          const request = key ? requests.get(key) : undefined
          if (key) requests.delete(key)
          const group = request?.method === 'session.events' ? 'events' : payload.startsWith('{"push":') ? 'pushes' : 'other'
          wire.bytes[group] += Buffer.byteLength(payload)
          if (request?.method === 'queue.list') wire.answers.queue++
          if (group === 'events') {
            wire.answers.events++
            const reset = /"reset":(true|false)(?:,"subscribed":true)?\}\}$/.exec(payload.slice(-64))?.[1]
            if (reset === 'true') wire.answers.resets++
            else if (reset === 'false' && request?.tail) wire.answers.tails++
            else if (reset === 'false' && request?.afterSeq) wire.answers.gaps++
          }
        }
        Reflect.apply(send, ws, args)
        if (wire && Date.now() < wire.end) wire.maxUnsentBytes = Math.max(wire.maxUnsentBytes, ws.bufferedAmount)
      }
      accept(ws, req)
    })
  }
  WebSocketServer.prototype.handleUpgrade = upgrade

  return {
    begin(phase: ReconnectPhase, cutMs: number, finish: (wire: ReconnectWire) => void, connected?: () => void): number {
      if (active) throw new Error('a reconnect measurement is already running')
      const before = cursors()
      const start = Date.now()
      const limit = phase === 'cut' ? RECONNECT_TIMEOUT_MS : RECONNECT_WINDOW_MS
      const wire: ReconnectWire = {
        phase, start, end: start + limit, connectedAt: null,
        connections: 0, refusedUpgrades: 0, remote: true,
        bytes: { events: 0, pushes: 0, other: 0 }, socketBytes: 0, maxUnsentBytes: 0,
        answers: { events: 0, queue: 0, resets: 0, gaps: 0, tails: 0 },
        before, through: before, connected: before
      }
      active = {
        wire, finish, connected,
        sockets: new Map([...peers.values()].map((written) => [written, written()])),
        timer: setTimeout(complete, limit)
      }
      if (phase === 'cut') {
        reopen = setTimeout(() => {
          wire.through = cursors()
          reopen = undefined
        }, cutMs)
        for (const ws of peers.keys()) ws.terminate()
      }
      return start
    },
    close(): void {
      if (reopen) clearTimeout(reopen)
      if (active) clearTimeout(active.timer)
      active = undefined
      reopen = undefined
      if (WebSocketServer.prototype.handleUpgrade === upgrade) WebSocketServer.prototype.handleUpgrade = original
    }
  }
}
