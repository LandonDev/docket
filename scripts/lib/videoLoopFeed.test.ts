import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseFrame } from '../../src/shared/video/nsl1'
import { LoopFeed, recordedMessages, restamped } from './videoLoopFeed'

const FIXTURE = join(__dirname, '../fixtures/ios-test-server/box-stream.nsl1')

describe('the recorded stream played as a live one', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'hrtime'] }))
  afterEach(() => vi.useRealTimers())

  it('reads the box engine\'s 180 frames, a keyframe first', () => {
    const messages = recordedMessages(FIXTURE)
    expect(messages).toHaveLength(180)
    const first = parseFrame(messages[0])
    expect(first).toMatchObject({ keyframe: true, sequence: 1, width: 1280, height: 800 })
    expect(messages.slice(1).every((m) => !parseFrame(m).keyframe)).toBe(true)
  })

  it('restamps a copy and leaves the access unit as it was', () => {
    const [message] = recordedMessages(FIXTURE)
    const out = restamped(message, 7, 3, 123_456n)
    expect(parseFrame(out)).toMatchObject({ generation: 7, sequence: 3, timestamp: 123_456 })
    expect(parseFrame(out).data).toEqual(parseFrame(message).data)
    expect(parseFrame(message).generation).not.toBe(7)
  })

  it('sends about 120 a second, each pass a new generation starting on the keyframe, and counts acks', () => {
    const messages = recordedMessages(FIXTURE).slice(0, 3)
    const feed = new LoopFeed(messages)
    const got: Uint8Array[] = []
    feed.start({ frame: (b) => void got.push(b), end: () => {} })
    vi.advanceTimersByTime(1_000)
    expect(got.length).toBeGreaterThanOrEqual(118)
    expect(got.length).toBeLessThanOrEqual(121)
    const frames = got.slice(0, 7).map(parseFrame)
    expect(frames.map((f) => [f.generation, f.sequence, f.keyframe])).toEqual([
      [1, 1, true], [1, 2, false], [1, 3, false], [2, 1, true], [2, 2, false], [2, 3, false], [3, 1, true]
    ])
    feed.ack()
    expect(feed.acks).toBe(1)
    feed.close()
    const at = got.length
    vi.advanceTimersByTime(500)
    expect(got.length).toBe(at)
  })
})
