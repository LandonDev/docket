import { describe, expect, it } from 'vitest'
import { actRow, coresUsed, liveAppTrouble, RUN_MAX_MS, watchTick, parseSizes, quantile, rateRow, traceStages, type SeenFrame } from './vmScreenRows'

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

  it("reads a pointer move's stages from QEMU's trace: the report taken, the screen changed", () => {
    const line = (ms: number, event: string) => `4242@${(1795560000 + ms / 1000).toFixed(6)}:${event} con 0, axis x, value 100`
    const trace = [
      // an act at 1000 ms (x then y), the report taken 1 ms later, the screen changed 150 ms later
      line(1000, 'input_event_abs'), line(1000.02, 'input_event_abs'), line(1001, 'usb_xhci_xfer_success'), line(1150, 'gd_update'),
      // a move 8 ms after another is no act of its own
      line(1158, 'input_event_abs'),
      // an act at 2000 ms: 2 ms and 30 ms
      line(2000, 'input_event_abs'), line(2002, 'usb_xhci_xfer_success'), line(2030, 'gd_update'),
      'a line of something else'
    ].join('\n')
    const r = traceStages(trace, 300)
    expect(r.n).toBe(2)
    expect(r.usbP50).toBeCloseTo(2, 0)
    expect(r.usbMax).toBeCloseTo(2, 0)
    expect(r.drawP50).toBeCloseTo(150, 0)
    expect(traceStages(trace.split('\n').slice(5).join('\n'), 300)).toMatchObject({ n: 1 })
  })

  it('answers no stage for a trace with no pointer event', () => {
    expect(traceStages('nothing', 300)).toMatchObject({ n: 0 })
  })

  it('pulls a scratch machine down when the live app is slow twice running, or the disk under pressure once', () => {
    const ok = { appMs: 90, ioSome: 2 }
    const slow = { appMs: 1200, ioSome: 2 }
    expect(liveAppTrouble([])).toBeNull()
    expect(liveAppTrouble([ok, ok])).toBeNull()
    // one slow answer is a blip
    expect(liveAppTrouble([ok, slow])).toBeNull()
    expect(liveAppTrouble([slow, ok])).toBeNull()
    expect(liveAppTrouble([slow, slow])).toContain('1200 ms twice running')
    expect(liveAppTrouble([{ appMs: null, ioSome: 0 }, { appMs: null, ioSome: 0 }])).toContain('did not answer')
    expect(liveAppTrouble([ok, { appMs: 90, ioSome: 31 }])).toContain("pressure is 31%")
  })

  it("judges each watch tick on the last two readings, and ends a run at its 30 minutes", () => {
    const ok = { appMs: 90, ioSome: 2 }
    const slow = { appMs: 1200, ioSome: 2 }
    const kept: { appMs: number | null; ioSome: number }[] = []
    expect(watchTick(kept, slow, 1000)).toBeNull()
    expect(watchTick(kept, ok, 6000)).toBeNull()
    expect(watchTick(kept, slow, 11000)).toBeNull()
    expect(kept).toHaveLength(2)
    expect(watchTick(kept, slow, 16000)).toContain('twice running')
    expect(watchTick([], ok, RUN_MAX_MS + 1)).toContain('30 minutes')
  })
})
