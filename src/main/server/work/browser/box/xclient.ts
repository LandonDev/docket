import { readFileSync } from 'node:fs'
import { connect, type Socket } from 'node:net'
import type { BoxDisplay } from './display'

/**
 * The few X requests the box's display needs and no window manager is there
 * to make (docs/agents/live-video.md "The box"): list the top-level windows,
 * read where each is, and set one's size. Chromium never makes a window the
 * exact size of the screen itself (it takes one pixel off each side so a
 * window manager does not read it as full screen), and with no window
 * manager nothing answers its ask to be full screen, so the browser's
 * windows are put at the screen's own size from here.
 *
 * The X protocol by hand, over the display's own socket with its cookie:
 * requests are answered in order, so one request at a time is in flight.
 */

export interface XWindow {
  id: number
  x: number
  y: number
  width: number
  height: number
  /** a menu, a tooltip, a list's popup: a window no window manager would touch */
  overrideRedirect: boolean
  /** drawn on the screen now */
  viewable: boolean
}

const pad4 = (n: number): number => (4 - (n % 4)) % 4

export class XClient {
  private buffer = Buffer.alloc(0)
  private waiting: { sequence: number; resolve: (reply: Buffer) => void; reject: (err: Error) => void } | null = null
  private closed = false
  /** requests sent so far: the server numbers them, and an error names the one it is about */
  private sequence = 0

  private constructor(
    private readonly socket: Socket,
    readonly root: number,
    readonly width: number,
    readonly height: number
  ) {}

  /** Connects with the display's cookie. Rejects when the server refuses, or does not answer in `timeoutMs`. */
  static open(display: BoxDisplay, timeoutMs = 3_000): Promise<XClient> {
    return new Promise((resolve, reject) => {
      const file = readFileSync(display.XAUTHORITY)
      const cookie = file.subarray(file.length - 16)
      const socket = connect(`/tmp/.X11-unix/X${display.DISPLAY.replace(/^:/, '').split('.')[0]}`)
      const timer = setTimeout(() => fail(new Error('the display did not answer in time')), timeoutMs)
      let got = Buffer.alloc(0)
      const fail = (err: Error): void => {
        clearTimeout(timer)
        socket.destroy()
        reject(err)
      }
      const onData = (chunk: Buffer): void => {
        got = Buffer.concat([got, chunk])
        if (got.length < 8) return
        const total = 8 + got.readUInt16LE(6) * 4
        if (got.length < total) return
        if (got[0] !== 1) return fail(new Error(`the display refused the connection: ${got.subarray(8, 8 + got[1]).toString().trim()}`))
        clearTimeout(timer)
        socket.off('data', onData)
        socket.off('error', fail)
        // The setup: the vendor's name, the pixmap formats, then the first screen, whose first field is its root window.
        const vendor = got.readUInt16LE(24)
        const formats = got[29]
        const screen = 40 + vendor + pad4(vendor) + formats * 8
        const client = new XClient(socket, got.readUInt32LE(screen), got.readUInt16LE(screen + 20), got.readUInt16LE(screen + 22))
        client.listen(got.subarray(total))
        resolve(client)
      }
      const name = Buffer.from('MIT-MAGIC-COOKIE-1')
      const head = Buffer.alloc(12)
      head.write('l', 0)
      head.writeUInt16LE(11, 2)
      head.writeUInt16LE(name.length, 6)
      head.writeUInt16LE(cookie.length, 8)
      socket.on('data', onData)
      socket.on('error', fail)
      socket.on('connect', () => socket.write(Buffer.concat([head, name, Buffer.alloc(pad4(name.length)), cookie, Buffer.alloc(pad4(cookie.length))])))
    })
  }

  /** The root's children, bottom of the stack first: every top-level window of the display. */
  async windows(): Promise<XWindow[]> {
    const tree = await this.request(15, 0, this.id(this.root))
    const count = tree.readUInt16LE(16)
    const out: XWindow[] = []
    for (let i = 0; i < count; i++) {
      const id = tree.readUInt32LE(32 + i * 4)
      try {
        const attributes = await this.request(3, 0, this.id(id))
        const geometry = await this.request(14, 0, this.id(id))
        out.push({
          id,
          x: geometry.readInt16LE(12),
          y: geometry.readInt16LE(14),
          width: geometry.readUInt16LE(16),
          height: geometry.readUInt16LE(18),
          overrideRedirect: attributes[27] === 1,
          viewable: attributes[26] === 2
        })
      } catch {
        // closed between the listing and the read
      }
    }
    return out
  }

  /**
   * Puts a window at `x`, `y` with this size, and with `stack` at the top or
   * the bottom of the windows. Answered by nothing: a later `windows` reads
   * what the server did.
   */
  configure(id: number, to: { x: number; y: number; width: number; height: number; stack?: 'top' | 'bottom' }): void {
    const body = Buffer.alloc(to.stack ? 28 : 24)
    body.writeUInt32LE(id, 0)
    // the value mask: x, y, width, height, and the stack mode when it is given
    body.writeUInt16LE(to.stack ? 0b1001111 : 0b1111, 4)
    body.writeInt32LE(to.x, 8)
    body.writeInt32LE(to.y, 12)
    body.writeUInt32LE(to.width, 16)
    body.writeUInt32LE(to.height, 20)
    if (to.stack) body.writeUInt32LE(to.stack === 'top' ? 0 : 1, 24)
    this.send(12, 0, body)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.socket.destroy()
    this.waiting?.reject(new Error('the display connection closed'))
    this.waiting = null
  }

  private id(window: number): Buffer {
    const b = Buffer.alloc(4)
    b.writeUInt32LE(window)
    return b
  }

  private send(opcode: number, data: number, body: Buffer): void {
    const head = Buffer.alloc(4)
    head[0] = opcode
    head[1] = data
    head.writeUInt16LE((4 + body.length) / 4, 2)
    this.sequence = (this.sequence + 1) & 0xffff
    this.socket.write(Buffer.concat([head, body]))
  }

  /** One request that has a reply. An X error answers as a rejection. */
  private request(opcode: number, data: number, body: Buffer): Promise<Buffer> {
    if (this.closed) return Promise.reject(new Error('the display connection closed'))
    if (this.waiting) return Promise.reject(new Error('one request at a time'))
    return new Promise((resolve, reject) => {
      this.send(opcode, data, body)
      this.waiting = { sequence: this.sequence, resolve, reject }
    })
  }

  private listen(rest: Buffer): void {
    this.buffer = rest
    this.socket.on('data', (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk])
      this.drain()
    })
    this.socket.on('close', () => this.close())
    this.socket.on('error', () => this.close())
    this.drain()
  }

  private drain(): void {
    while (this.buffer.length >= 32) {
      const kind = this.buffer[0]
      // a reply says how much longer than 32 bytes it is; an error and an event are 32
      const total = kind === 1 ? 32 + this.buffer.readUInt32LE(4) * 4 : 32
      if (this.buffer.length < total) return
      const message = this.buffer.subarray(0, total)
      this.buffer = this.buffer.subarray(total)
      // an event, or the error of a request that has no reply (a window that closed before it was sized)
      const waiting = this.waiting
      if (kind > 1 || !waiting || message.readUInt16LE(2) !== waiting.sequence) continue
      this.waiting = null
      if (kind === 1) waiting.resolve(Buffer.from(message))
      else waiting.reject(new Error(`X error ${message[1]}`))
    }
  }
}

/** Where a new page's window is made, off the screen, until it is put on it: it never covers the page he watches, even for a frame. */
export const STAGING_X = 2000
/** Where the Outlook carrier's window lives, never on the screen. */
export const CARRIER_X = 6000

const ordinary = (w: XWindow): boolean => w.viewable && !w.overrideRedirect

/** The windows that are a page's own and on the screen: drawn, and not a menu or a tooltip. */
export function pageWindows(all: XWindow[], screen: { width: number; height: number }): XWindow[] {
  return all.filter((w) => ordinary(w) && w.x < screen.width && w.y < screen.height && w.x + w.width > 0 && w.y + w.height > 0)
}

/** The windows that wait at the staging place. */
export function stagedWindows(all: XWindow[]): XWindow[] {
  return all.filter((w) => ordinary(w) && w.x >= STAGING_X && w.x < CARRIER_X)
}

async function withDisplay<T>(display: BoxDisplay, fn: (x: XClient) => Promise<T>): Promise<T> {
  const x = await XClient.open(display)
  try {
    return await fn(x)
  } finally {
    x.close()
  }
}

/**
 * Puts every page window on the screen at the screen's own size, as a window
 * manager would a full-screen one; none is raised or lowered. Answers how
 * many it changed. A window off the screen (a staged page's, the carrier's)
 * is left where it is.
 */
export function fitWindows(display: BoxDisplay): Promise<number> {
  return withDisplay(display, async (x) => {
    const screen = { width: x.width, height: x.height }
    let moved = 0
    for (const w of pageWindows(await x.windows(), screen)) {
      if (w.x === 0 && w.y === 0 && w.width === screen.width && w.height === screen.height) continue
      x.configure(w.id, { x: 0, y: 0, ...screen })
      moved++
    }
    // a round trip, so the server has done what was asked before the connection goes
    if (moved) await x.windows()
    return moved
  })
}

/**
 * Puts every staged window on the screen at the screen's size: under every
 * other window (a page nobody watches must not cover the one he does), or on
 * top. Answers how many it landed.
 */
export function landWindows(display: BoxDisplay, stack: 'top' | 'bottom'): Promise<number> {
  return withDisplay(display, async (x) => {
    const staged = stagedWindows(await x.windows())
    for (const w of staged) x.configure(w.id, { x: 0, y: 0, width: x.width, height: x.height, stack })
    if (staged.length) await x.windows()
    return staged.length
  })
}
