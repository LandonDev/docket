import { HEADER_SIZE, MESSAGE_TYPES, SUBPROTOCOL, encodeInput, type InputEvent } from '@shared/video/nsl1'
import type { FeedSink, VideoFeed } from '../../../video/feed'
import type { EngineLease } from './engine'

/**
 * One viewer's feed from one engine (engine.ts): a socket to the engine's
 * `/stream` on loopback, the token offered as a subprotocol and never in the
 * address. A watcher's socket is `?view=1`, which owns no input; a driver's is
 * the plain `/stream`, which takes his pointer and keys.
 *
 * Bytes pass as they are, both ways. The feed reads one thing off a frame: its
 * generation, which the engine numbers each connection with and expects back
 * on any input, so a message made here (release-all, a paste's Ctrl+V) is
 * accepted.
 */

/** The engine's address for one viewer. */
export function engineUrl(port: number, drive: boolean): string {
  return `ws://127.0.0.1:${port}/stream${drive ? '' : '?view=1'}`
}

export class EngineFeed implements VideoFeed {
  private ws: WebSocket | null = null
  private sink: FeedSink | null = null
  private closed = false
  /** the engine exited: the end is an error, not a slow link */
  private exited = false
  private generation = 0

  constructor(
    private readonly lease: EngineLease,
    private readonly drive: boolean,
    private readonly socket: (url: string, protocols: string[]) => WebSocket = (url, protocols) => new WebSocket(url, protocols)
  ) {}

  start(sink: FeedSink): void {
    if (this.closed) return
    this.sink = sink
    this.lease.onExit(() => {
      this.exited = true
      this.end('error')
    })
    const ws = this.socket(engineUrl(this.lease.port, this.drive), [SUBPROTOCOL, `bearer.${this.lease.token}`])
    ws.binaryType = 'arraybuffer'
    this.ws = ws
    ws.addEventListener('message', (ev) => {
      const data = (ev as MessageEvent).data
      if (!(data instanceof ArrayBuffer) || data.byteLength < HEADER_SIZE) return
      const bytes = new Uint8Array(data)
      if (bytes[5] === MESSAGE_TYPES.frame) this.generation = new DataView(data).getUint32(8)
      this.sink?.frame(bytes)
    })
    // The engine closes a stream whose acks stopped for three seconds, or whose oldest frame is that old: the
    // viewer's link is too slow for now, and it opens another. An engine that exited says `error` above.
    const gone = (): void => this.end(this.exited ? 'error' : 'slow')
    ws.addEventListener('close', gone)
    ws.addEventListener('error', gone)
  }

  ack(bytes: Uint8Array): void {
    this.send(bytes)
  }

  input(bytes: Uint8Array): void {
    if (this.drive) this.send(bytes)
  }

  /** One input event made on this host, numbered for the engine's connection. False when no frame has named the connection yet. */
  type(event: InputEvent): boolean {
    if (!this.drive || !this.generation) return false
    this.send(encodeInput(event, this.generation))
    return true
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.sink = null
    const ws = this.ws
    this.ws = null
    try {
      ws?.close()
    } catch {
      // closed already
    }
    this.lease.release()
  }

  private send(bytes: Uint8Array): void {
    const ws = this.ws
    if (!ws || ws.readyState !== 1) return
    ws.send(bytes)
  }

  private end(reason: 'error' | 'slow'): void {
    const sink = this.sink
    if (this.closed || !sink) return
    // the relay closes this feed in answer, which lets the engine go
    sink.end(reason)
  }
}
