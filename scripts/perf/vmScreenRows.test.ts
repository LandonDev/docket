import { describe, expect, it } from 'vitest'
import { actRow, coresUsed, parseSizes, quantile, rateRow, type SeenFrame } from './vmScreenRows'

/** Frames 16 ms apart from `from` (ms), each captured `lag` ms before it arrived. */
const steady = (from: number, n: number, lag = 5, bytes = 1000): SeenFrame[] => Array.from({ length: n }, (_, i) => ({ us: (from + i * 16) * 1000, ts: (from + i * 16 - lag) * 1000, bytes }))

describe("the VM screen bench's rows", () => {
  it('takes a quantile by rank, and none of nothing', () => {
    expect(quantile([5, 1, 3], 0.5)).toBe(3)
    expect(quantile([1, 2, 3, 4], 0.95)).toBe(4)
    expect(quantile([], 0.5)).toBeNaN()
  })

  it('counts frames a second, their gaps and the bit rate inside the window alone', () => {
    // 100 frames 16 ms apart from 1000 ms: the window 1000 to 2000 ms holds the first 63
    const r = rateRow([...steady(0, 10), ...steady(1000, 100)], 1_000_000, 2_000_000)
    expect(r.fps).toBe(63)
    expect(r.gapP50).toBe(16)
    expect(r.gapP95).toBe(16)
    expect(r.mbit).toBeCloseTo((63 * 1000 * 8) / 1e6)
    expect(r.captureP50).toBe(5)
  })

  it('reads a still screen as no frames, with no gap to speak of', () => {
    const r = rateRow([], 0, 5_000_000)
    expect(r.fps).toBe(0)
    expect(r.mbit).toBe(0)
    expect(r.gapP50).toBeNaN()
  })

  it('times each act to the first and last frame of the burst it starts', () => {
    // an act at 100 ms: frames at 130, 146, 162; an act at 1000 ms: frames at 1050 and 1066
    const frames = [...steady(130, 3, 8, 400), ...steady(1050, 2, 12, 900)]
    const r = actRow(frames, [100_000, 1_000_000], 450)
    expect(r).toMatchObject({ n: 2, seen: 2, firstMin: 30, firstMax: 50, firstP50: 50, lastP50: 66, framesP50: 3, captureP50: 12, bytesP50: 900 })
  })

  it('counts an act no frame followed as asked and not seen', () => {
    const r = actRow(steady(130, 3), [100_000, 5_000_000], 450)
    expect(r).toMatchObject({ n: 2, seen: 1, firstP50: 30 })
    expect(actRow([], [0], 450)).toMatchObject({ n: 1, seen: 0 })
    expect(actRow([], [0], 450).firstMin).toBeNaN()
  })

  it('leaves out a frame that came after the window', () => {
    expect(actRow([{ us: 600_000, ts: 590_000, bytes: 1 }], [100_000], 450).seen).toBe(0)
  })

  it('turns clock ticks into cores', () => {
    expect(coresUsed(1000, 1500, 10)).toBe(0.5)
  })

  it('reads sizes, and refuses an odd or a tiny one', () => {
    expect(parseSizes('1280x800, 3456x2234')).toEqual([[1280, 800], [3456, 2234]])
    for (const bad of ['1281x800', '320x200', 'x', '1280']) expect(() => parseSizes(bad)).toThrow('--sizes')
  })
})
