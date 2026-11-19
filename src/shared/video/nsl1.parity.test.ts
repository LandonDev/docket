// Holds our port of the NSL1 wire to the pinned screen-relay package: a bump
// that changes the wire fails here before it reaches a host.
import { describe, expect, it } from 'vitest'
import * as theirs from 'screen-relay/protocol'
import * as ours from './nsl1'

const EVENTS: ours.InputEvent[] = [
  { type: 'keyDown', key: 4 },
  { type: 'keyUp', key: 231, modifiers: 2 },
  { type: 'pointerMove', x: 0.25, y: 0.75, buttons: 1 },
  { type: 'buttonDown', button: 1, x: 0, y: 1 },
  { type: 'buttonUp', button: 3, x: 1, y: 0, modifiers: 255, buttons: 31 },
  { type: 'wheel', axis: 'vertical', delta: -1200, x: 0.5, y: 0.5 },
  { type: 'wheel', axis: 'horizontal', delta: 120, x: 0.1, y: 0.9 },
  { type: 'releaseAll' },
  { type: 'text', codepoint: 0x1f600 },
  { type: 'text', codepoint: 0x0a }
]

const BAD: unknown[] = [
  { type: 'keyDown', key: 232 },
  { type: 'pointerMove', x: 1.01, y: 0 },
  { type: 'buttonDown', button: 4, x: 0, y: 0 },
  { type: 'wheel', axis: 'vertical', delta: 100, x: 0, y: 0 },
  { type: 'wheel', axis: 'diagonal', delta: 120, x: 0, y: 0 },
  { type: 'releaseAll', buttons: 1 },
  { type: 'text', codepoint: 0xd800 },
  { type: 'text', codepoint: 0 },
  { type: 'nudge' }
]

// An SPS for Constrained Baseline 4.2, as x264 writes it, then a slice.
const KEYFRAME = Uint8Array.from([0, 0, 0, 1, 0x67, 0x42, 0xc0, 0x2a, 0xda, 0x01, 0, 0, 1, 0x68, 0xce, 0x3c, 0x80, 0, 0, 1, 0x65, 0x88, 0x84])

describe('the NSL1 wire against screen-relay 0.1.2', () => {
  it('shares the constants', () => {
    expect(ours.MAGIC).toBe(theirs.MAGIC)
    expect(ours.VERSION).toBe(theirs.VERSION)
    expect(ours.HEADER_SIZE).toBe(theirs.HEADER_SIZE)
    expect(ours.INPUT_SIZE).toBe(theirs.INPUT_SIZE)
    expect(ours.MAX_BYTES_IN_FLIGHT).toBe(theirs.MAX_BYTES_IN_FLIGHT)
    expect(ours.SUBPROTOCOL).toBe(theirs.SUBPROTOCOL)
    expect(ours.MESSAGE_TYPES).toEqual(theirs.MESSAGE_TYPES)
    expect(ours.INPUT_TYPES).toEqual(theirs.INPUT_TYPES)
  })

  it('encodes every input record to the same bytes, and reads them back', () => {
    for (const event of EVENTS) {
      expect([...ours.encodeInputRecord(event)]).toEqual([...theirs.encodeInputRecord(event)])
      const message = ours.encodeInput(event, 7)
      expect([...message]).toEqual([...theirs.encodeInput(event, 7, 0)])
      expect(theirs.parseHeader(message)).toEqual(ours.parseHeader(message))
      expect(ours.encodeInputRecord(ours.parseInput(message))).toEqual(ours.encodeInputRecord(event))
    }
  })

  it('refuses the input the package refuses', () => {
    for (const event of BAD) {
      expect(() => theirs.encodeInputRecord(event as theirs.InputEvent)).toThrow()
      expect(() => ours.encodeInputRecord(event as ours.InputEvent)).toThrow(ours.Nsl1Error)
    }
  })

  it('reads back no record the engine would refuse: a field its type does not use must be zero', () => {
    const tweak = (event: ours.InputEvent, at: number, value: number): Uint8Array => {
      const bytes = ours.encodeInput(event, 1)
      bytes[ours.HEADER_SIZE + at] = value
      return bytes
    }
    // a value on a key, a move and a button; a code on a move; the reserved byte
    expect(() => ours.parseInput(tweak({ type: 'keyDown', key: 4 }, 7, 5))).toThrow(ours.Nsl1Error)
    expect(() => ours.parseInput(tweak({ type: 'pointerMove', x: 0, y: 0 }, 7, 1))).toThrow(ours.Nsl1Error)
    expect(() => ours.parseInput(tweak({ type: 'pointerMove', x: 0, y: 0 }, 3, 1))).toThrow(ours.Nsl1Error)
    expect(() => ours.parseInput(tweak({ type: 'buttonDown', button: 1, x: 0, y: 0 }, 7, 1))).toThrow(ours.Nsl1Error)
    expect(() => ours.parseInput(tweak({ type: 'releaseAll' }, 7, 1))).toThrow(ours.Nsl1Error)
    expect(() => ours.parseInput(tweak({ type: 'keyDown', key: 4 }, 1, 1))).toThrow(ours.Nsl1Error)
    expect(ours.parseInput(ours.encodeInput({ type: 'keyDown', key: 4 }, 1))).toMatchObject({ type: 'keyDown', key: 4 })
  })

  it('encodes acks to the same bytes, with and without the wait', () => {
    for (const wait of [undefined, 0, 0.4, 16.6667, 5000, Number.POSITIVE_INFINITY, Number.NaN, -3]) {
      const mine = ours.encodeAck(3, 41, wait)
      expect([...mine]).toEqual([...theirs.encodeAck(3, 41, wait)])
      expect(ours.parseAck(mine).sequence).toBe(41)
    }
    expect(ours.parseAck(ours.encodeAck(1, 9, 2.5))).toEqual({ generation: 1, sequence: 9, waitMicros: 2500 })
    expect(ours.parseAck(ours.encodeAck(1, 9))).toEqual({ generation: 1, sequence: 9, waitMicros: 0 })
    expect(ours.parseAck(ours.encodeAck(1, 9, 1e9)).waitMicros).toBe(0xffffffff)
  })

  it('writes a frame the package decodes, field for field', () => {
    const frame: ours.Frame = { generation: 2, sequence: 1, keyframe: true, width: 1280, height: 800, timestamp: 1_763_577_000_123_456, data: KEYFRAME }
    const bytes = ours.encodeFrame(frame)
    const read = theirs.parseMessage(bytes)
    expect(read).toEqual({ type: 'frame', ...frame })
    expect(ours.parseFrame(bytes)).toEqual(frame)
    expect(theirs.parseHeader(bytes)).toEqual(ours.parseHeader(bytes))
    const delta = ours.encodeFrame({ ...frame, sequence: 2, keyframe: false })
    expect(theirs.parseMessage(delta)).toMatchObject({ type: 'frame', sequence: 2, keyframe: false })
  })

  it('refuses the envelopes the package refuses', () => {
    const good = ours.encodeAck(1, 1)
    const cases: Uint8Array[] = []
    const tweak = (at: number, value: number): void => {
      const copy = good.slice()
      copy[at] = value
      cases.push(copy)
    }
    tweak(0, 0x4d) // the magic
    tweak(4, 2) // the version
    tweak(5, 0) // no such type
    tweak(5, 7)
    tweak(7, 1) // a flag on an ack
    tweak(19, 1) // a length the message does not have
    cases.push(good.subarray(0, 19))
    const zeroGeneration = good.slice()
    zeroGeneration.fill(0, 8, 12)
    cases.push(zeroGeneration)
    for (const bytes of cases) {
      expect(() => theirs.parseHeader(bytes)).toThrow()
      expect(() => ours.parseHeader(bytes)).toThrow(ours.Nsl1Error)
      expect(ours.messageType(bytes)).toBe(0)
    }
    expect(ours.messageType(good)).toBe(ours.MESSAGE_TYPES.ack)
  })

  it('reads the codec from a keyframe as the package does', () => {
    expect(ours.h264Codec(KEYFRAME)).toBe('avc1.42c02a')
    expect(ours.h264Codec(KEYFRAME)).toBe(theirs.h264Codec(KEYFRAME))
    expect(() => ours.h264Codec(KEYFRAME.subarray(10))).toThrow(ours.Nsl1Error)
  })

  it('refuses a frame with no sequence, no size or no bytes', () => {
    const base = { generation: 1, sequence: 1, keyframe: false, width: 2, height: 2, timestamp: 1, data: Uint8Array.of(1) }
    expect(() => ours.encodeFrame({ ...base, sequence: 0 })).toThrow(ours.Nsl1Error)
    expect(() => ours.encodeFrame({ ...base, width: 0 })).toThrow(ours.Nsl1Error)
    expect(() => ours.encodeFrame({ ...base, data: new Uint8Array(0) })).toThrow(ours.Nsl1Error)
    expect(() => ours.parseFrame(ours.encodeAck(1, 1))).toThrow(ours.Nsl1Error)
  })
})
