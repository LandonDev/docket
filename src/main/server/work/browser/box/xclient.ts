import { readFileSync } from 'node:fs'
import { connect, type Socket } from 'node:net'
import type { BoxDisplay } from './display'

/**
 * The X protocol by hand, over the box display's own socket with its cookie
 * (docs/agents/live-video.md "The box"): the few requests and events a
 * window manager needs, since none runs on that display and ours is a few
 * rules (xwm.ts). Requests are answered in the order they were made; events
 * and errors arrive between the answers.
 */

export interface XGeometry {
  x: number
  y: number
  width: number
  height: number
}

export interface XWindow extends XGeometry {
  id: number
  /** a menu, a tooltip, a list's popup: a window no window manager touches */
  overrideRedirect: boolean
  /** drawn on the screen now */
  viewable: boolean
}

/** What the server tells a client that asked to hear of the root's children. */
export type XEvent =
  | { type: 'create'; window: number; overrideRedirect: boolean; geometry: XGeometry }
  | { type: 'destroy'; window: number }
  | { type: 'mapRequest'; window: number }
  /** a window came onto the screen: the only word of one the display does not ask about */
  | { type: 'shown'; window: number; overrideRedirect: boolean }
  /** a window was moved, sized or restacked: `above` is the window now right under it, 0 at the bottom */
  | { type: 'placed'; window: number; above: number; overrideRedirect: boolean }
  | { type: 'configureRequest'; window: number; mask: number; geometry: XGeometry; stack: 'above' | 'below' | 'other' }
  /** a client's message to the window manager about one of its windows: `kind` is the atom that says what it asks */
  | { type: 'message'; window: number; kind: number }

const pad4 = (n: number): number => (4 - (n % 4)) % 4
const REQUEST_MS = 3_000
/** ConfigureWindow's value mask. */
export const CONFIGURE = { x: 1, y: 2, width: 4, height: 8, stack: 64 } as const
const SUBSTRUCTURE_NOTIFY = 1 << 19
const SUBSTRUCTURE_REDIRECT = 1 << 20
const STRUCTURE_NOTIFY = 1 << 17
/** Atoms every server has under a fixed number. */
export const ATOM = { atom: 4, string: 31, transientFor: 68, window: 33 } as const

interface Waiting {
  sequence: number
  resolve: (reply: Buffer | null) => void
  reject: (err: Error) => void
  timer: NodeJS.Timeout
}

export class XClient {
  private buffer: Buffer = Buffer.alloc(0)
  private readonly waiting: Waiting[] = []
  private closed = false
  /** requests sent so far: the server numbers them, and an answer or an error names the one it is about */
  private sequence = 0
  private readonly listeners = new Set<(event: XEvent) => void>()
  private readonly closers = new Set<() => void>()
  private readonly atoms = new Map<string, number>()
  private made = 0

  private constructor(
    private readonly socket: Socket,
    readonly root: number,
    readonly width: number,
    readonly height: number,
    /** the ids this client may give what it makes: a base, and the bits it may count in */
    private readonly ids: { base: number; mask: number }
  ) {}

  /** Connects with the display's cookie. Rejects when the server refuses, or does not answer in `timeoutMs`. */
  static open(display: BoxDisplay, timeoutMs = REQUEST_MS): Promise<XClient> {
    return new Promise((resolve, reject) => {
      let cookie: Buffer
      try {
        const file = readFileSync(display.XAUTHORITY)
        cookie = file.subarray(file.length - 16)
      } catch (err) {
        return reject(err as Error)
      }
      const socket = connect(`/tmp/.X11-unix/X${display.DISPLAY.replace(/^:/, '').split('.')[0]}`)
      const timer = setTimeout(() => fail(new Error('the display did not answer in time')), timeoutMs)
      let got: Buffer = Buffer.alloc(0)
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
        const client = new XClient(socket, got.readUInt32LE(screen), got.readUInt16LE(screen + 20), got.readUInt16LE(screen + 22), { base: got.readUInt32LE(12), mask: got.readUInt32LE(16) })
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

  get alive(): boolean {
    return !this.closed
  }

  onEvent(fn: (event: XEvent) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  onClose(fn: () => void): void {
    this.closers.add(fn)
  }

  /**
   * Asks to be the one client that answers for the root's children: every
   * other client's ask to map, move, size or restack a top-level window comes
   * here as an event and is not done until this client does it. Rejects when
   * another client already holds that place.
   */
  async manage(): Promise<void> {
    const body = Buffer.alloc(12)
    body.writeUInt32LE(this.root, 0)
    // the value mask: the event mask alone
    body.writeUInt32LE(1 << 11, 4)
    body.writeUInt32LE(SUBSTRUCTURE_NOTIFY | SUBSTRUCTURE_REDIRECT, 8)
    this.send(2, 0, body)
    // a refusal is an error with no reply of its own: a round trip brings it in before the answer
    const refused = this.voided()
    await this.geometry(this.root)
    if (await refused) throw new Error('another client manages the display')
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
        out.push({ id, ...(await this.geometry(id)), overrideRedirect: attributes[27] === 1, viewable: attributes[26] === 2 })
      } catch {
        // closed between the listing and the read
      }
    }
    return out
  }

  async geometry(id: number): Promise<XGeometry> {
    const reply = await this.request(14, 0, this.id(id))
    return { x: reply.readInt16LE(12), y: reply.readInt16LE(14), width: reply.readUInt16LE(16), height: reply.readUInt16LE(18) }
  }

  /** Any of a window's place, size and place in the stack (top or bottom). Answered by nothing. */
  configure(id: number, to: Partial<XGeometry> & { stack?: 'top' | 'bottom' }): void {
    const values: number[] = []
    let mask = 0
    for (const key of ['x', 'y', 'width', 'height'] as const) {
      if (to[key] === undefined) continue
      mask |= CONFIGURE[key]
      values.push(to[key]!)
    }
    if (to.stack) {
      mask |= CONFIGURE.stack
      values.push(to.stack === 'top' ? 0 : 1)
    }
    if (!mask) return
    const body = Buffer.alloc(8 + values.length * 4)
    body.writeUInt32LE(id, 0)
    body.writeUInt16LE(mask, 4)
    values.forEach((v, i) => body.writeInt32LE(v, 8 + i * 4))
    this.send(12, 0, body)
  }

  /** Puts a window on the screen. Answered by nothing. */
  map(id: number): void {
    this.send(8, 0, this.id(id))
  }

  /** Tells a window's own client where it is and how large, when an ask of its was not carried out as asked. */
  tell(id: number, at: XGeometry): void {
    const event = Buffer.alloc(32)
    event[0] = 22
    event.writeUInt32LE(id, 4)
    event.writeUInt32LE(id, 8)
    event.writeInt16LE(at.x, 16)
    event.writeInt16LE(at.y, 18)
    event.writeUInt16LE(at.width, 20)
    event.writeUInt16LE(at.height, 22)
    const head = Buffer.alloc(8)
    head.writeUInt32LE(id, 0)
    head.writeUInt32LE(STRUCTURE_NOTIFY, 4)
    this.send(25, 0, Buffer.concat([head, event]))
  }

  /** The number the server knows a name by, making it when it has none. */
  async atom(name: string): Promise<number> {
    const have = this.atoms.get(name)
    if (have) return have
    const text = Buffer.from(name, 'latin1')
    const body = Buffer.alloc(4 + text.length + pad4(text.length))
    body.writeUInt16LE(text.length, 0)
    text.copy(body, 4)
    const atom = (await this.request(16, 0, body)).readUInt32LE(8)
    this.atoms.set(name, atom)
    return atom
  }

  /** Sets a property of a window to a list of 32-bit values (atoms, windows). Answered by nothing. */
  setProperty(id: number, property: number, type: number, values: number[]): void {
    const body = Buffer.alloc(20 + values.length * 4)
    body.writeUInt32LE(id, 0)
    body.writeUInt32LE(property, 4)
    body.writeUInt32LE(type, 8)
    body[12] = 32
    body.writeUInt32LE(values.length, 16)
    values.forEach((v, i) => body.writeUInt32LE(v, 20 + i * 4))
    this.send(18, 0, body)
  }

  /** Sets a property of a window to text. Answered by nothing. */
  setText(id: number, property: number, type: number, text: string): void {
    const bytes = Buffer.from(text, 'utf8')
    const body = Buffer.alloc(20 + bytes.length + pad4(bytes.length))
    body.writeUInt32LE(id, 0)
    body.writeUInt32LE(property, 4)
    body.writeUInt32LE(type, 8)
    body[12] = 8
    body.writeUInt32LE(bytes.length, 16)
    bytes.copy(body, 20)
    this.send(18, 0, body)
  }

  /** The first 32-bit value of a window's property, or null when it has none. */
  async property(id: number, property: number): Promise<number | null> {
    const body = Buffer.alloc(20)
    body.writeUInt32LE(id, 0)
    body.writeUInt32LE(property, 4)
    body.writeUInt32LE(1, 16)
    const reply = await this.request(20, 0, body)
    return reply[1] === 32 && reply.readUInt32LE(16) > 0 ? reply.readUInt32LE(32) : null
  }

  /** A plain black window of this client's own over the whole screen, asked about by nobody. Returns its id. */
  curtain(): number {
    const id = this.ids.base | (++this.made & this.ids.mask)
    const body = Buffer.alloc(36)
    body.writeUInt32LE(id, 0)
    body.writeUInt32LE(this.root, 4)
    body.writeUInt16LE(this.width, 12)
    body.writeUInt16LE(this.height, 14)
    // drawn; the values are its background (pixel 0, black) and override-redirect
    body.writeUInt16LE(1, 18)
    body.writeUInt32LE((1 << 1) | (1 << 9), 24)
    body.writeUInt32LE(0, 28)
    body.writeUInt32LE(1, 32)
    this.send(1, 0, body)
    this.map(id)
    return id
  }

  /** A window of this client's own that is never drawn: one pixel, off the screen, asked about by nobody. Returns its id. */
  hidden(): number {
    const id = this.ids.base | (++this.made & this.ids.mask)
    const body = Buffer.alloc(32)
    body.writeUInt32LE(id, 0)
    body.writeUInt32LE(this.root, 4)
    body.writeInt16LE(-1, 8)
    body.writeInt16LE(-1, 10)
    body.writeUInt16LE(1, 12)
    body.writeUInt16LE(1, 14)
    // input only; the one value is override-redirect
    body.writeUInt16LE(2, 18)
    body.writeUInt32LE(1 << 9, 24)
    body.writeUInt32LE(1, 28)
    this.send(1, 0, body)
    return id
  }

  /** Gives a window the keyboard. A window not on the screen is refused by the server, and nothing changes. Answered by nothing. */
  focus(id: number): void {
    const body = Buffer.alloc(8)
    body.writeUInt32LE(id, 0)
    // revert to the pointer's window when this one goes
    this.send(42, 1, body)
  }

  /** The window that holds the keyboard: 0 for none, 1 for whichever the pointer is in. */
  async focused(): Promise<number> {
    return (await this.request(43, 0, Buffer.alloc(0))).readUInt32LE(8)
  }

  /** A round trip: everything asked before it has been done by the server when it answers. */
  async sync(): Promise<void> {
    await this.geometry(this.root)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.socket.destroy()
    for (const w of this.waiting.splice(0)) {
      clearTimeout(w.timer)
      w.reject(new Error('the display connection closed'))
    }
    for (const fn of this.closers) fn()
  }

  private id(window: number): Buffer {
    const b = Buffer.alloc(4)
    b.writeUInt32LE(window)
    return b
  }

  private send(opcode: number, data: number, body: Buffer): void {
    if (this.closed) return
    const head = Buffer.alloc(4)
    head[0] = opcode
    head[1] = data
    head.writeUInt16LE((4 + body.length) / 4, 2)
    this.sequence = (this.sequence + 1) & 0xffff
    this.socket.write(Buffer.concat([head, body]))
  }

  /** One request that has a reply. An X error answers as a rejection, and so does a server that says nothing for three seconds. */
  private request(opcode: number, data: number, body: Buffer): Promise<Buffer> {
    if (this.closed) return Promise.reject(new Error('the display connection closed'))
    return new Promise((resolve, reject) => {
      this.send(opcode, data, body)
      // a server that stopped answering without closing must not hold everything queued behind this call
      const timer = setTimeout(() => this.close(), REQUEST_MS)
      this.waiting.push({ sequence: this.sequence, resolve: (reply) => (reply ? resolve(reply) : reject(new Error('X error'))), reject, timer })
    })
  }

  /** Whether the request just sent, which has no reply, is answered with an error: known by the time a later round trip answers. */
  private voided(): Promise<boolean> {
    const sequence = this.sequence
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.close(), REQUEST_MS)
      this.waiting.push({ sequence, resolve: (reply) => resolve(reply === null), reject: () => resolve(false), timer })
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
      const message = Buffer.from(this.buffer.subarray(0, total))
      this.buffer = this.buffer.subarray(total)
      if (kind > 1) {
        this.event(message)
        continue
      }
      this.answer(message.readUInt16LE(2), kind === 1 ? message : null)
    }
  }

  /** A reply (or, with null, an error) for the request numbered `sequence`; every request with no reply before it went through. */
  private answer(sequence: number, reply: Buffer | null): void {
    while (this.waiting.length) {
      const head = this.waiting[0]
      const behind = (sequence - head.sequence) & 0xffff
      // an answer for a later request: the head was one that has no reply, and it was not refused
      if (behind !== 0 && behind < 0x8000) {
        this.waiting.shift()
        clearTimeout(head.timer)
        head.resolve(Buffer.alloc(0))
        continue
      }
      if (behind !== 0) return
      this.waiting.shift()
      clearTimeout(head.timer)
      head.resolve(reply)
      return
    }
  }

  private event(message: Buffer): void {
    // the top bit marks an event another client sent; its code is the rest
    const code = message[0] & 0x7f
    let event: XEvent | null = null
    if (code === 16) {
      event = { type: 'create', window: message.readUInt32LE(8), overrideRedirect: message[22] === 1, geometry: { x: message.readInt16LE(12), y: message.readInt16LE(14), width: message.readUInt16LE(16), height: message.readUInt16LE(18) } }
    } else if (code === 17) event = { type: 'destroy', window: message.readUInt32LE(8) }
    else if (code === 19) event = { type: 'shown', window: message.readUInt32LE(8), overrideRedirect: message[12] === 1 }
    else if (code === 20) event = { type: 'mapRequest', window: message.readUInt32LE(8) }
    else if (code === 22) event = { type: 'placed', window: message.readUInt32LE(8), above: message.readUInt32LE(12), overrideRedirect: message[26] === 1 }
    else if (code === 23) {
      event = {
        type: 'configureRequest',
        window: message.readUInt32LE(8),
        mask: message.readUInt16LE(26),
        geometry: { x: message.readInt16LE(16), y: message.readInt16LE(18), width: message.readUInt16LE(20), height: message.readUInt16LE(22) },
        stack: message[1] === 0 ? 'above' : message[1] === 1 ? 'below' : 'other'
      }
    }
    // only a message in 32-bit values names a window to act on
    else if (code === 33 && message[1] === 32) event = { type: 'message', window: message.readUInt32LE(4), kind: message.readUInt32LE(8) }
    if (event) for (const fn of this.listeners) fn(event)
  }
}
