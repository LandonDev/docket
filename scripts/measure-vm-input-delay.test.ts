import { describe, expect, it } from 'vitest'
import { encodeAck, encodeFrame, encodePong, header, HEADER_SIZE, MESSAGE_TYPES } from '../src/shared/video/nsl1'
import { parseMeasurementRecord } from './measure-vm-input-delay'

describe('the VM delay bench’s stream records', () => {
  it('reads frames and shapes as separate records', () => {
    const frame = { generation: 2, sequence: 1, keyframe: true, width: 1280, height: 800, timestamp: 1234, data: Uint8Array.of(1) }
    expect(parseMeasurementRecord(encodeFrame(frame).buffer)).toEqual({ type: 'frame', frame })
    const cursor = header(MESSAGE_TYPES.cursor, 2, 0, 8 + 8)
    cursor.set([0, 1, 0, 2, 0, 0, 0, 1, 1, 2, 3, 255, 4, 5, 6, 0], HEADER_SIZE)
    expect(parseMeasurementRecord(cursor.buffer)).toMatchObject({ type: 'cursor', shape: { width: 1, height: 2, hotX: 0, hotY: 1 } })
  })

  it('reads a pong with or without the relay median, and skips unrelated records', () => {
    expect(parseMeasurementRecord(encodePong(12, 8.125).buffer)).toEqual({ type: 'pong', sequence: 12, captureMs: 8.125 })
    expect(parseMeasurementRecord(encodePong(13).buffer)).toEqual({ type: 'pong', sequence: 13, captureMs: undefined })
    expect(parseMeasurementRecord(encodeAck(1, 1).buffer)).toBeNull()
    expect(parseMeasurementRecord('not binary')).toBeNull()
  })
})
