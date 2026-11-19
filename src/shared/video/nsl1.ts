/**
 * The NSL1 wire: the binary messages a live video stream speaks on its own
 * WebSocket, on every host. One WebSocket message holds one protocol message.
 *
 * Ported from screen-relay 0.1.2 (github.com/vercel-labs/screen-relay,
 * `src/protocol/index.ts` and PROTOCOL.md), licensed under the Apache License,
 * Version 2.0 (http://www.apache.org/licenses/LICENSE-2.0). Changed here: only the frame,
 * the ack and the input message are kept, errors are plain `Nsl1Error`s, and a
 * frame encoder is added for our own sources and tests. `nsl1.parity.test.ts`
 * holds this file to the pinned package byte for byte.
 */

export const MAGIC = 0x4e534c31
export const VERSION = 1
export const HEADER_SIZE = 20
export const INPUT_SIZE = 16
/** Width, height and the capture time, ahead of a frame's access unit. */
export const FRAME_PREFIX = 12
export const MAX_BYTES_IN_FLIGHT = 8 * 1024 * 1024
/** The largest whole message: the header, a frame's prefix and an access unit of 8 MiB. */
export const MAX_MESSAGE_BYTES = HEADER_SIZE + FRAME_PREFIX + MAX_BYTES_IN_FLIGHT
export const SUBPROTOCOL = 'nsl1'

/**
 * The message types of the wire at 0.1.2. A stream socket carries 1 to 3; 4 and
 * 5 are the engine's `/control` socket, which only the box's relay opens; 6 (the
 * remote pointer's shape) is never passed on to a viewer.
 */
export const MESSAGE_TYPES = { frame: 1, ack: 2, input: 3, controlReady: 4, inputResponse: 5, cursor: 6 } as const
const LAST_TYPE = 6
export const INPUT_TYPES = { keyDown: 1, keyUp: 2, pointerMove: 3, buttonDown: 4, buttonUp: 5, wheel: 6, releaseAll: 7, text: 8 } as const

export class Nsl1Error extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'Nsl1Error'
  }
}

/** One input record. `x` and `y` are 0..1 across the picture; a wheel `delta` is a multiple of 120. */
export type InputEvent = (
  | { type: 'keyDown' | 'keyUp'; key: number }
  | { type: 'pointerMove'; x: number; y: number }
  | { type: 'buttonDown' | 'buttonUp'; button: 1 | 2 | 3; x: number; y: number }
  | { type: 'wheel'; axis: 'vertical' | 'horizontal'; delta: number; x: number; y: number }
  | { type: 'releaseAll' }
  | { type: 'text'; codepoint: number }
) & { buttons?: number; modifiers?: number }

export interface Header {
  type: number
  flags: number
  generation: number
  sequence: number
  payloadLength: number
}

export interface Frame {
  generation: number
  sequence: number
  keyframe: boolean
  width: number
  height: number
  /** When the source captured the frame, in microseconds on the source's clock. */
  timestamp: number
  /** One H.264 Annex B access unit; a view of the message's bytes, not a copy. */
  data: Uint8Array
}

function integer(value: number, min: number, max: number, name: string): number {
  if (!Number.isInteger(value) || value < min || value > max) throw new Nsl1Error(`Invalid ${name}`)
  return value
}

function coordinate(value: number, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) throw new Nsl1Error(`Invalid ${name}`)
  return Math.round(value * 65535)
}

const bytesOf = (bytes: Uint8Array | ArrayBuffer): Uint8Array => (bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes))

/** A message of `size` payload bytes with its header written. */
export function header(type: number, generation: number, sequence: number, size: number, flags = 0): Uint8Array {
  integer(type, 1, LAST_TYPE, 'message type')
  integer(generation, 1, 0xffffffff, 'generation')
  integer(sequence, 0, 0xffffffff, 'sequence')
  integer(size, 0, FRAME_PREFIX + MAX_BYTES_IN_FLIGHT, 'payload length')
  integer(flags, 0, type === MESSAGE_TYPES.frame ? 1 : 0, 'flags')
  const bytes = new Uint8Array(HEADER_SIZE + size)
  const view = new DataView(bytes.buffer)
  view.setUint32(0, MAGIC)
  view.setUint8(4, VERSION)
  view.setUint8(5, type)
  view.setUint16(6, flags)
  view.setUint32(8, generation)
  view.setUint32(12, sequence)
  view.setUint32(16, size)
  return bytes
}

/** Reads and checks a message's envelope; throws for anything malformed. */
export function parseHeader(bytes: Uint8Array | ArrayBuffer): Header {
  const data = bytesOf(bytes)
  if (data.byteLength < HEADER_SIZE || data.byteLength > MAX_MESSAGE_BYTES) throw new Nsl1Error('Invalid message length')
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const type = view.getUint8(5)
  const flags = view.getUint16(6)
  const generation = view.getUint32(8)
  if (
    view.getUint32(0) !== MAGIC ||
    view.getUint8(4) !== VERSION ||
    type < 1 ||
    type > LAST_TYPE ||
    flags > (type === MESSAGE_TYPES.frame ? 1 : 0) ||
    !generation ||
    view.getUint32(16) !== data.byteLength - HEADER_SIZE
  ) {
    throw new Nsl1Error('Invalid message envelope')
  }
  return { type, flags, generation, sequence: view.getUint32(12), payloadLength: view.getUint32(16) }
}

/** The type of a message whose envelope holds, else 0. For a relay that passes bytes on and reads nothing else. */
export function messageType(bytes: Uint8Array | ArrayBuffer): number {
  try {
    return parseHeader(bytes).type
  } catch {
    return 0
  }
}

/** One frame message: what a source sends. */
export function encodeFrame(frame: Frame): Uint8Array {
  integer(frame.sequence, 1, 0xffffffff, 'frame sequence')
  integer(frame.width, 1, 65535, 'width')
  integer(frame.height, 1, 65535, 'height')
  integer(frame.timestamp, 0, Number.MAX_SAFE_INTEGER, 'timestamp')
  if (frame.data.byteLength < 1 || frame.data.byteLength > MAX_BYTES_IN_FLIGHT) throw new Nsl1Error('Invalid access unit')
  const bytes = header(MESSAGE_TYPES.frame, frame.generation, frame.sequence, FRAME_PREFIX + frame.data.byteLength, frame.keyframe ? 1 : 0)
  const view = new DataView(bytes.buffer)
  view.setUint16(HEADER_SIZE, frame.width)
  view.setUint16(HEADER_SIZE + 2, frame.height)
  view.setBigUint64(HEADER_SIZE + 4, BigInt(frame.timestamp))
  bytes.set(frame.data, HEADER_SIZE + FRAME_PREFIX)
  return bytes
}

/** Decodes one frame message; throws for any other type or a malformed frame. */
export function parseFrame(bytes: Uint8Array | ArrayBuffer): Frame {
  const data = bytesOf(bytes)
  const { type, flags, generation, sequence, payloadLength: size } = parseHeader(data)
  if (type !== MESSAGE_TYPES.frame) throw new Nsl1Error('Invalid message type')
  if (size < FRAME_PREFIX + 1 || !sequence) throw new Nsl1Error('Invalid frame header')
  const view = new DataView(data.buffer, data.byteOffset + HEADER_SIZE, size)
  const width = view.getUint16(0)
  const height = view.getUint16(2)
  const timestamp = view.getBigUint64(4)
  if (!width || !height || timestamp > BigInt(Number.MAX_SAFE_INTEGER)) throw new Nsl1Error('Invalid frame header')
  return { generation, sequence, keyframe: flags === 1, width, height, timestamp: Number(timestamp), data: data.subarray(HEADER_SIZE + FRAME_PREFIX) }
}

/**
 * An ack for one frame, carrying how long the frame waited inside the viewer
 * (arrival to the draw or the drop), in microseconds that saturate at 2^32 - 1.
 * Without a wait it is the bare 20-byte ack.
 */
export function encodeAck(generation: number, sequence: number, viewerWaitMs?: number): Uint8Array {
  if (viewerWaitMs === undefined) return header(MESSAGE_TYPES.ack, generation, sequence, 0)
  const bytes = header(MESSAGE_TYPES.ack, generation, sequence, 4)
  const micros = Number.isFinite(viewerWaitMs) ? Math.min(0xffffffff, Math.max(0, Math.round(viewerWaitMs * 1000))) : 0
  new DataView(bytes.buffer).setUint32(HEADER_SIZE, micros)
  return bytes
}

/** Decodes one ack: the frame it answers and the viewer's wait in microseconds (0 when it carries none). */
export function parseAck(bytes: Uint8Array | ArrayBuffer): { generation: number; sequence: number; waitMicros: number } {
  const data = bytesOf(bytes)
  const { type, generation, sequence, payloadLength: size } = parseHeader(data)
  if (type !== MESSAGE_TYPES.ack || (size !== 0 && size !== 4)) throw new Nsl1Error('Invalid ack')
  const waitMicros = size === 4 ? new DataView(data.buffer, data.byteOffset + HEADER_SIZE, 4).getUint32(0) : 0
  return { generation, sequence, waitMicros }
}

/** The 16 bytes of one input record. */
export function encodeInputRecord(event: InputEvent): Uint8Array {
  if (!event || typeof event !== 'object' || !Object.hasOwn(INPUT_TYPES, event.type)) throw new Nsl1Error('Unknown input type')
  const bytes = new Uint8Array(INPUT_SIZE)
  const view = new DataView(bytes.buffer)
  view.setUint8(0, INPUT_TYPES[event.type])
  const buttons = integer(event.buttons ?? 0, 0, 31, 'buttons')
  const modifiers = integer(event.modifiers ?? 0, 0, 255, 'modifiers')
  if ((event.type === 'releaseAll' || event.type === 'text') && (buttons || modifiers)) throw new Nsl1Error('Release and text events require zero masks')
  view.setUint16(12, buttons)
  view.setUint16(14, modifiers)
  if (event.type === 'pointerMove' || event.type === 'buttonDown' || event.type === 'buttonUp' || event.type === 'wheel') {
    view.setUint16(8, coordinate(event.x, 'x'))
    view.setUint16(10, coordinate(event.y, 'y'))
  }
  if (event.type === 'keyDown' || event.type === 'keyUp') view.setUint16(2, integer(event.key, 0, 231, 'key'))
  if (event.type === 'buttonDown' || event.type === 'buttonUp') view.setUint16(2, integer(event.button, 1, 3, 'button'))
  if (event.type === 'wheel') {
    if (event.axis !== 'vertical' && event.axis !== 'horizontal') throw new Nsl1Error('Invalid wheel axis')
    const delta = integer(event.delta, -1200, 1200, 'wheel delta')
    if (delta % 120) throw new Nsl1Error('Wheel delta must be a multiple of 120')
    view.setUint16(2, event.axis === 'horizontal' ? 1 : 0)
    view.setInt32(4, delta)
  }
  if (event.type === 'text') {
    const codepoint = integer(event.codepoint, 1, 0x10ffff, 'Unicode scalar')
    if (codepoint >= 0xd800 && codepoint <= 0xdfff) throw new Nsl1Error('Invalid Unicode scalar')
    view.setInt32(4, codepoint)
  }
  return bytes
}

/** One input message for a stream socket: the sequence is zero there. */
export function encodeInput(event: InputEvent, generation: number, sequence = 0): Uint8Array {
  const bytes = header(MESSAGE_TYPES.input, generation, sequence, INPUT_SIZE)
  bytes.set(encodeInputRecord(event), HEADER_SIZE)
  return bytes
}

const INPUT_NAMES = Object.fromEntries(Object.entries(INPUT_TYPES).map(([name, code]) => [code, name])) as Record<number, InputEvent['type']>

/** Decodes one input message back to its event, refusing what the engine refuses (its `core/input.cpp`): a field a type does not use must be zero. */
export function parseInput(bytes: Uint8Array | ArrayBuffer): InputEvent {
  const data = bytesOf(bytes)
  const { type, payloadLength: size } = parseHeader(data)
  if (type !== MESSAGE_TYPES.input || size !== INPUT_SIZE) throw new Nsl1Error('Invalid input message')
  const view = new DataView(data.buffer, data.byteOffset + HEADER_SIZE, INPUT_SIZE)
  const kind = INPUT_NAMES[view.getUint8(0)]
  if (!kind || view.getUint8(1)) throw new Nsl1Error('Unknown input type')
  const code = view.getUint16(2)
  const value = view.getInt32(4)
  const x = view.getUint16(8) / 65535
  const y = view.getUint16(10) / 65535
  const masks = { buttons: integer(view.getUint16(12), 0, 31, 'buttons'), modifiers: integer(view.getUint16(14), 0, 255, 'modifiers') }
  if (kind !== 'wheel' && kind !== 'text' && value) throw new Nsl1Error('Invalid input value')
  switch (kind) {
    case 'keyDown':
    case 'keyUp':
      return { type: kind, key: integer(code, 0, 231, 'key'), ...masks }
    case 'pointerMove':
      if (code) throw new Nsl1Error('Invalid pointer move')
      return { type: kind, x, y, ...masks }
    case 'buttonDown':
    case 'buttonUp':
      return { type: kind, button: integer(code, 1, 3, 'button') as 1 | 2 | 3, x, y, ...masks }
    case 'wheel':
      if (code > 1 || value % 120 || value < -1200 || value > 1200) throw new Nsl1Error('Invalid wheel')
      return { type: kind, axis: code === 1 ? 'horizontal' : 'vertical', delta: value, x, y, ...masks }
    case 'releaseAll':
      if (code || value || masks.buttons || masks.modifiers) throw new Nsl1Error('Invalid release')
      return { type: kind }
    case 'text':
      if (code || masks.buttons || masks.modifiers || value < 1 || value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff)) throw new Nsl1Error('Invalid Unicode scalar')
      return { type: kind, codepoint: value }
  }
}

/** The `avc1.PPCCLL` codec string from the SPS in an H.264 Annex B keyframe. */
export function h264Codec(bytes: Uint8Array): string {
  for (let i = 0; i + 7 < bytes.length; i++) {
    let n = 0
    if (bytes[i] === 0 && bytes[i + 1] === 0 && bytes[i + 2] === 1) n = i + 3
    else if (bytes[i] === 0 && bytes[i + 1] === 0 && bytes[i + 2] === 0 && bytes[i + 3] === 1) n = i + 4
    if (n && n + 3 < bytes.length && (bytes[n] & 31) === 7) {
      return `avc1.${[bytes[n + 1], bytes[n + 2], bytes[n + 3]].map((v) => v.toString(16).padStart(2, '0')).join('')}`
    }
  }
  throw new Nsl1Error('Keyframe is missing SPS')
}
