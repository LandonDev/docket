import { describe, expect, it } from 'vitest'
import { clock, frameAt, frameCentre, frameCount, frameStart, frameTimecode, framesTimecode, MediaAnchorSchema, timecodeFrames, type FrameTable } from './contract-work-media'

const cfr = (num: number, den: number, count: number, start = 0): FrameTable => ({ kind: 'cfr', start, rate: { num, den }, count })

describe('the frame maths', () => {
  it('seeks to the middle of a frame and reads every point inside it back as that frame', () => {
    const t = cfr(24, 1, 120)
    expect(frameCentre(t, 0)).toBeCloseTo(1 / 48)
    expect(frameCentre(t, 25)).toBeCloseTo(25.5 / 24)
    for (const n of [0, 1, 2, 11, 12, 23, 24, 25, 47, 48, 49, 71, 95, 100, 118, 119]) {
      expect(frameAt(t, frameCentre(t, n))).toBe(n)
      // A decoder that reports the frame's own start time still names it, and the instant before names the one before.
      expect(frameAt(t, frameStart(t, n))).toBe(n)
      // WebM's millisecond times: frame 2 at 0.083 for 0.08333.
      expect(frameAt(t, Math.floor(frameStart(t, n) * 1000) / 1000)).toBe(n)
      if (n > 0) expect(frameAt(t, frameStart(t, n) - 2e-3)).toBe(n - 1)
    }
  })

  it('keeps a 23.976 rate exact and clamps to the clip', () => {
    const t = cfr(24000, 1001, 1000, 0.5)
    expect(frameAt(t, frameCentre(t, 999))).toBe(999)
    expect(frameAt(t, 1e9)).toBe(999)
    expect(frameAt(t, 0)).toBe(0)
    expect(frameCentre(t, 5000)).toBe(frameCentre(t, 999))
  })

  it('reads a variable-rate clip by its own frame times, not by a rate', () => {
    // 30 fps with frames 10 to 14 of every 30 missing, as the research's phone-style clip
    const times = Array.from({ length: 30 }, (_, i) => i / 30).filter((_, i) => i < 10 || i > 14)
    const t: FrameTable = { kind: 'vfr', times, end: 1 }
    expect(frameCount(t)).toBe(25)
    expect(frameAt(t, frameCentre(t, 10))).toBe(10)
    expect(frameStart(t, 10)).toBeCloseTo(15 / 30)
    expect(frameCentre(t, 9)).toBeCloseTo((9 / 30 + 15 / 30) / 2)
  })

  it('counts drop-frame timecode as the research checked it', () => {
    const rate = { num: 30000, den: 1001 }
    expect(frameTimecode(60, rate, '00:00:58;00')).toBe('00:01:00;02')
    expect(framesTimecode(17982, rate, true)).toBe('00:10:00;00')
    expect(framesTimecode(107892, rate, true)).toBe('01:00:00;00')
    for (const n of [0, 1799, 1800, 17981, 17982, 107891, 500_000]) expect(timecodeFrames(framesTimecode(n, rate, true), rate)).toBe(n)
    expect(frameTimecode(30, { num: 25, den: 1 }, '10:00:00:00')).toBe('10:00:01:05')
    expect(frameTimecode(49, { num: 24, den: 1 })).toBe('00:00:02:01')
  })

  it('writes a clock for people', () => {
    expect(clock(41.9)).toBe('0:41')
    expect(clock(3725)).toBe('1:02:05')
  })

  it('takes an anchor in picture space and refuses one far outside it', () => {
    expect(MediaAnchorSchema.safeParse({ versionId: 'v', frame: 3, region: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 } }).success).toBe(true)
    expect(MediaAnchorSchema.safeParse({ versionId: 'v', region: { x: 2, y: 0, w: 1, h: 1 } }).success).toBe(false)
    expect(MediaAnchorSchema.safeParse({ versionId: 'v', frame: -1 }).success).toBe(false)
  })
})
