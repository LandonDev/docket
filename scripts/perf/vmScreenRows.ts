/**
 * The maths of the VM screen bench (vm-screen-bench.ts), apart from the machine so it is tested over recorded
 * frames. Times are in microseconds on one clock; a row records what was seen and judges nothing.
 */

/** One frame as the bench's viewer saw it: when it arrived, when the engine captured it, its bytes. */
export interface SeenFrame {
  us: number
  ts: number
  bytes: number
}

/** The `p` quantile of a list, by rank; NaN for none. */
export function quantile(xs: readonly number[], p: number): number {
  const s = [...xs].sort((a, b) => a - b)
  return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))]! : NaN
}

export interface RateRow {
  fps: number
  gapP50: number
  gapP95: number
  mbit: number
  /** capture to viewer, ms */
  captureP50: number
  captureP95: number
}

/** Frames a second, the gaps between them (ms) and the bit rate over [startUs, endUs). */
export function rateRow(frames: readonly SeenFrame[], startUs: number, endUs: number): RateRow {
  const secs = (endUs - startUs) / 1e6
  const got = frames.filter((f) => f.us >= startUs && f.us < endUs)
  const gaps = got.slice(1).map((f, i) => (f.us - got[i]!.us) / 1000)
  const capture = got.map((f) => (f.us - f.ts) / 1000)
  return {
    fps: got.length / secs,
    gapP50: quantile(gaps, 0.5),
    gapP95: quantile(gaps, 0.95),
    mbit: (got.reduce((s, f) => s + f.bytes, 0) * 8) / secs / 1e6,
    captureP50: quantile(capture, 0.5),
    captureP95: quantile(capture, 0.95)
  }
}

export interface ActRow {
  n: number
  seen: number
  /** the act to the first frame after it, ms */
  firstP50: number
  firstP95: number
  firstMin: number
  firstMax: number
  /** the act to the last frame of the burst it starts, ms */
  lastP50: number
  framesP50: number
  captureP50: number
  captureP95: number
  bytesP50: number
}

/**
 * Acts timed to the frames that show them: for each act (the moment it was sent), the frames within `windowMs`
 * after it. An act no frame followed is counted in `n` and not in `seen`.
 */
export function actRow(frames: readonly SeenFrame[], acts: readonly number[], windowMs: number): ActRow {
  const firsts: number[] = []
  const lasts: number[] = []
  const counts: number[] = []
  const capture: number[] = []
  const bytes: number[] = []
  for (const t0 of acts) {
    const got = frames.filter((f) => f.us > t0 && f.us <= t0 + windowMs * 1000)
    if (!got.length) continue
    firsts.push((got[0]!.us - t0) / 1000)
    lasts.push((got.at(-1)!.us - t0) / 1000)
    counts.push(got.length)
    capture.push((got[0]!.us - got[0]!.ts) / 1000)
    bytes.push(got[0]!.bytes)
  }
  return {
    n: acts.length,
    seen: firsts.length,
    firstP50: quantile(firsts, 0.5),
    firstP95: quantile(firsts, 0.95),
    firstMin: firsts.length ? Math.min(...firsts) : NaN,
    firstMax: firsts.length ? Math.max(...firsts) : NaN,
    lastP50: quantile(lasts, 0.5),
    framesP50: quantile(counts, 0.5),
    captureP50: quantile(capture, 0.5),
    captureP95: quantile(capture, 0.95),
    bytesP50: quantile(bytes, 0.5)
  }
}

/** Cores used between two readings of /proc/<pid>/stat's utime + stime (clock ticks, 100 a second). */
export const coresUsed = (ticks0: number, ticks1: number, secs: number): number => (ticks1 - ticks0) / (100 * secs)

/** `1280x800,2560x1600` as sizes; refused unless each is two even numbers of 640 or more. */
export function parseSizes(text: string): [number, number][] {
  return text.split(',').map((s) => {
    const m = /^(\d{3,4})x(\d{3,4})$/.exec(s.trim())
    const [w, h] = [Number(m?.[1]), Number(m?.[2])]
    if (!m || w < 640 || h < 480 || w % 2 || h % 2) throw new Error(`--sizes ${s}: give WIDTHxHEIGHT in even pixels`)
    return [w, h]
  })
}
