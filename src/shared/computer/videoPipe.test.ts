import { describe, expect, it } from 'vitest'
import { encodeAck, encodeFrame, parseFrame } from '../video/nsl1'
import { RecordReader, VideoPipeError, encodeRecord } from './videoPipe'

const frame = (sequence: number, size: number): Uint8Array =>
  encodeFrame({ generation: 1, sequence, keyframe: sequence === 1, width: 640, height: 400, timestamp: sequence * 8_333, data: new Uint8Array(size).fill(sequence) })

describe('the bytes pipe', () => {
  it('a record is the stream number, four bytes big-endian, then the message as it is', () => {
    const ack = encodeAck(1, 5, 2)
    const record = encodeRecord(0x01020304, ack)
    expect([...record.subarray(0, 4)]).toEqual([1, 2, 3, 4])
    expect([...record.subarray(4)]).toEqual([...ack])
    expect(() => encodeRecord(0, ack)).toThrow(VideoPipeError)
    expect(() => encodeRecord(2 ** 32, ack)).toThrow(VideoPipeError)
  })

  it('cuts records out of the bytes however they are split, and keeps two streams apart', () => {
    const records = [encodeRecord(7, frame(1, 5_000)), encodeRecord(9, frame(1, 12)), encodeRecord(7, frame(2, 300)), encodeRecord(9, encodeAck(1, 1))]
    const all = new Uint8Array(records.reduce((n, r) => n + r.byteLength, 0))
    let at = 0
    for (const r of records) {
      all.set(r, at)
      at += r.byteLength
    }
    for (const step of [1, 3, 17, 1_000, all.byteLength]) {
      const reader = new RecordReader()
      const got: { stream: number; length: number }[] = []
      for (let i = 0; i < all.byteLength; i += step) for (const r of reader.push(all.subarray(i, i + step))) got.push({ stream: r.stream, length: r.message.byteLength })
      expect(got, `in pieces of ${step}`).toEqual(records.map((r) => ({ stream: new DataView(r.buffer).getUint32(0), length: r.byteLength - 4 })))
    }
    const reader = new RecordReader()
    const [first] = reader.push(all)
    expect(parseFrame(first.message)).toMatchObject({ sequence: 1, keyframe: true, width: 640, height: 400 })
  })

  it('gives each message as a copy: the next bytes do not change it', () => {
    const reader = new RecordReader()
    const bytes = encodeRecord(3, frame(1, 64))
    const [record] = reader.push(bytes)
    const before = [...record.message]
    bytes.fill(0)
    expect([...record.message]).toEqual(before)
  })

  it('throws once it has lost its place: no stream number, no header, or a message larger than the wire allows', () => {
    expect(() => new RecordReader().push(new Uint8Array(24))).toThrow(VideoPipeError)
    const notOurs = encodeRecord(3, encodeAck(1, 1))
    notOurs[4] = 0x58
    expect(() => new RecordReader().push(notOurs)).toThrow('lost its place')
    const huge = encodeRecord(3, encodeAck(1, 1))
    new DataView(huge.buffer).setUint32(4 + 16, 0x7fffffff)
    expect(() => new RecordReader().push(huge)).toThrow('larger than the wire allows')
    // too few bytes to judge is no error: it waits for more
    expect(new RecordReader().push(encodeRecord(3, encodeAck(1, 1)).subarray(0, 23))).toEqual([])
  })
})
