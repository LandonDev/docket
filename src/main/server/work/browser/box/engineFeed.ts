import { HEADER_SIZE, INPUT_SIZE, MESSAGE_TYPES, SUBPROTOCOL, encodeInput, parseInput, type InputEvent } from '@shared/video/nsl1'
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

// HID usage codes (the wire's own): the keys of the chords below, and the modifiers that make them.
const KEY_I = 12
/** With Ctrl held these close, quit or leave the shared browser: W, Q, N, T. */
const NEVER_WITH_CTRL = new Set([26, 20, 17, 23])
/**
 * With Ctrl and Alt held these are QEMU's own window's, never the guest's: Q quits QEMU (the guest's power cut),
 * F full screen, G grab, M the menu bar, U the original size, 0, minus and plus the zoom (the pointer then misses),
 * 1 to 9 its consoles (ui-gtk's accelerators).
 */
const QEMU_WITH_CTRL_ALT = new Set([20, 9, 10, 16, 24, 39, 45, 46, 86, 87, 30, 31, 32, 33, 34, 35, 36, 37, 38])
const isCtrl = (key: number): boolean => key === 224 || key === 228
const isShift = (key: number): boolean => key === 225 || key === 229
const isAlt = (key: number): boolean => key === 226 || key === 230

/**
 * What a source's feed never passes on, by whose screen it is (docs/agents/live-video.md "Driving"):
 * - `browser`: the box's browser every thread shares: Ctrl+W, Ctrl+Q, Ctrl+N, Ctrl+T and Ctrl+Shift+I would close,
 *   quit or leave it;
 * - `vm`: the Windows VM is his: every chord of the guest's is his, Ctrl+W included, but QEMU's own window's
 *   Ctrl+Alt chords never reach it, and no `text` record either (QEMU reads X's keycodes, and a character the engine
 *   types on a spare keycode lands as the wrong key in the guest: a phone types there with keys or a paste).
 */
export type NeverSent = 'browser' | 'vm'

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
  /** the Ctrl, Shift and Alt keys his records have pressed and not let go */
  private readonly held = new Set<number>()
  /** his records passed on since the last release-all: a close lets go of what they may still hold */
  private pressed = false

  constructor(
    private readonly lease: EngineLease,
    private readonly drive: boolean,
    private readonly socket: (url: string, protocols: string[]) => WebSocket = (url, protocols) => new WebSocket(url, protocols),
    /** `close` once, when the feed is closed, started or not; `input` at each of his input records passed on */
    private readonly on: { close?: () => void; input?: () => void } = {},
    /** whose screen it is: what is never passed on */
    private readonly rules: NeverSent = 'browser'
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

  // The engine drops a connection that sends it anything it does not expect, so only what it takes is passed on:
  // an ack of 20 or 24 bytes, an input of 36 with no sequence, each carrying the connection's own number.
  ack(bytes: Uint8Array): void {
    if ((bytes.byteLength === HEADER_SIZE || bytes.byteLength === HEADER_SIZE + 4) && this.mine(bytes)) this.send(bytes)
  }

  input(bytes: Uint8Array): void {
    if (!this.drive || bytes.byteLength !== HEADER_SIZE + INPUT_SIZE || !this.mine(bytes)) return
    if (new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(12) !== 0) return
    if (this.never(bytes)) return
    this.on.input?.()
    this.pressed = true
    this.send(bytes)
  }

  release(): void {
    this.held.clear()
    this.pressed = false
    this.type({ type: 'releaseAll' })
  }

  /**
   * The records this source never passes on (`NeverSent`): the browser's
   * chords, or QEMU's own on the VM. The app's viewer never sends the
   * browser's (videoInput.ts); no other client of his can either. The
   * modifiers are followed from the records themselves, since the engine
   * presses each key as it comes, whatever a record says is held.
   */
  private never(bytes: Uint8Array): boolean {
    let event: InputEvent
    try {
      event = parseInput(bytes)
    } catch {
      // not a record the engine takes: it would drop the connection
      return true
    }
    if (event.type === 'releaseAll') this.held.clear()
    if (event.type === 'text') return this.rules === 'vm'
    if (event.type !== 'keyDown' && event.type !== 'keyUp') return false
    const key = event.key
    if (isCtrl(key) || isShift(key) || isAlt(key)) {
      if (event.type === 'keyDown') this.held.add(key)
      else this.held.delete(key)
      return false
    }
    if (event.type === 'keyUp') return false
    const held = [...this.held]
    const mods = event.modifiers ?? 0
    const ctrl = held.some(isCtrl) || (mods & 0x11) !== 0
    const shift = held.some(isShift) || (mods & 0x22) !== 0
    const alt = held.some(isAlt) || (mods & 0x44) !== 0
    if (this.rules === 'vm') return ctrl && alt && QEMU_WITH_CTRL_ALT.has(key)
    return ctrl && (NEVER_WITH_CTRL.has(key) || (key === KEY_I && shift))
  }

  /** The message carries the number of this connection, which the first frame said. */
  private mine(bytes: Uint8Array): boolean {
    return this.generation !== 0 && new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(8) === this.generation
  }

  /** One input event made on this host, numbered for the engine's connection. False when no frame has named the connection yet. */
  type(event: InputEvent): boolean {
    if (!this.drive || !this.generation) return false
    this.send(encodeInput(event, this.generation))
    return true
  }

  close(): void {
    if (this.closed) return
    // a drive stream that ends (his link cut, the window gone) lets go of every key and button first: the engine
    // presses each on the display as it comes, and one left down would stay down for the next viewer
    if (this.pressed) this.release()
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
    this.on.close?.()
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
