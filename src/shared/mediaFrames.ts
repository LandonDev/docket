import type { FrameRate, FrameTable, MediaPlay, MediaProbe, MediaVersion } from './contract-work-media'

/**
 * The media pillar's frame maths and the choice of what a viewer plays
 * (docs/agents/work-media.md), apart from the wire's zod schemas so the
 * canvas can import them. A lazy chunk that imports a zod schema adds the
 * zod code it uses to zod's one copy, which sits in the first paint's
 * chunk: milestone 34's contract did that, 5 kB over the budget. This file
 * imports types only (src/renderer/src/work/media/firstPaint.test.ts holds
 * it and the canvas to that); `contract-work-media.ts` re-exports it all.
 */

export const frameCount = (t: FrameTable): number => (t.kind === 'cfr' ? t.count : t.times.length)

/** When frame `n` starts showing. */
export function frameStart(t: FrameTable, n: number): number {
  if (t.kind === 'cfr') return t.start + (n * t.rate.den) / t.rate.num
  if (n >= t.times.length) return t.end
  return t.times[Math.max(0, n)]
}

/** The middle of frame `n`'s interval: the one seek target that lands on it in every decoder measured. */
export function frameCentre(t: FrameTable, n: number): number {
  const last = frameCount(t) - 1
  const i = Math.max(0, Math.min(last, Math.round(n)))
  return (frameStart(t, i) + frameStart(t, i + 1)) / 2
}

/** How far under a frame's start a reported time may sit and still name that frame. */
export const FRAME_SLACK_S = 0.001

/** The frame showing at media time `s` (the `mediaTime` a frame callback reports, or `currentTime`). */
export function frameAt(t: FrameTable, s: number): number {
  const last = Math.max(0, frameCount(t) - 1)
  // A millisecond of slack (at most a quarter frame): a frame's start as a decoder reports it, rounded down to
  // the microsecond in MP4 and to the millisecond in WebM, still names that frame and not the one before.
  const slack = Math.min(FRAME_SLACK_S, 0.25 / (tableFps(t) || 24))
  if (t.kind === 'cfr') {
    const n = Math.floor(((s + slack - t.start) * t.rate.num) / t.rate.den)
    return Math.max(0, Math.min(last, n))
  }
  let lo = 0
  let hi = last
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (t.times[mid] <= s + slack) lo = mid
    else hi = mid - 1
  }
  return lo
}

/** The length of the whole table in seconds. */
export const tableDuration = (t: FrameTable): number => frameStart(t, frameCount(t)) - frameStart(t, 0)

/** The rate a table plays at, as frames per second (a VFR table's average). */
export function tableFps(t: FrameTable): number {
  if (t.kind === 'cfr') return t.rate.num / t.rate.den
  const d = tableDuration(t)
  return d > 0 ? t.times.length / d : 0
}

/** `0:41`, `1:02:05`: a clock for people, from seconds. */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = String(s % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

/** Drop-frame counting drops two labels a minute at 29.97 (four at 59.94), except every tenth minute. */
const dropsOf = (rate: FrameRate): number => {
  const nominal = Math.round(rate.num / rate.den)
  return rate.den === 1001 && rate.num === nominal * 1000 && (nominal === 30 || nominal === 60) ? nominal / 15 : 0
}

/** A start timecode's frame count (`00:00:58;00`, `;` or `.` before the frames meaning drop-frame); null when it does not parse. */
export function timecodeFrames(tc: string, rate: FrameRate): number | null {
  const m = /^(\d{1,2}):(\d{2}):(\d{2})([:;.,])(\d{2,3})$/.exec(tc.trim())
  if (!m) return null
  const nominal = Math.round(rate.num / rate.den)
  const [hh, mm, ss, ff] = [m[1], m[2], m[3], m[5]].map(Number)
  const drop = m[4] === ';' || m[4] === ',' ? dropsOf(rate) : 0
  const minutes = hh * 60 + mm
  return (hh * 3600 + mm * 60 + ss) * nominal + ff - drop * (minutes - Math.floor(minutes / 10))
}

/** The timecode label of a frame count, drop-frame when the rate is 29.97 or 59.94 and `drop` is asked. */
export function framesTimecode(frames: number, rate: FrameRate, drop: boolean): string {
  const nominal = Math.round(rate.num / rate.den)
  const d = drop ? dropsOf(rate) : 0
  let n = Math.max(0, Math.round(frames))
  if (d > 0) {
    const per10 = Math.round((rate.num / rate.den) * 600)
    const perMin = nominal * 60 - d
    const tens = Math.floor(n / per10)
    const rest = n % per10
    n += d * 9 * tens + (rest > d ? d * Math.floor((rest - d) / perMin) : 0)
  }
  const ff = n % nominal
  const s = Math.floor(n / nominal)
  const two = (v: number): string => String(v).padStart(2, '0')
  return `${two(Math.floor(s / 3600) % 24)}:${two(Math.floor(s / 60) % 60)}:${two(s % 60)}${d > 0 ? ';' : ':'}${two(ff)}`
}

/** Frame `n`'s timecode: the file's start timecode plus `n`, or the frame's own place from 00:00:00:00 when it has none. */
export function frameTimecode(n: number, rate: FrameRate, start?: string): string {
  const drop = !!start && /[;,]\d+$/.test(start)
  const base = start ? (timecodeFrames(start, rate) ?? 0) : 0
  return framesTimecode(base + n, rate, drop)
}

/**
 * What a viewer decodes, as it reports it (`plays`): `h264` (8-bit 4:2:0),
 * `h264-hi` (10-bit or 4:2:2), `hevc`, `vp9`, `av1`, `prores`, `dnxhd`. A
 * codec it leaves out gets a proxy. Absent, the host assumes Chromium on
 * Linux: H.264 of any profile, VP9 and AV1.
 */
export const VIEWER_DEFAULT_PLAYS = ['h264', 'h264-hi', 'vp9', 'av1'] as const

/** A viewer's name for a probe's codec, as `plays` lists it. */
export function playKey(p: Pick<MediaProbe, 'codec' | 'pixFmt' | 'bitDepth'>): string {
  if (p.codec === 'h264') return (p.bitDepth ?? 8) > 8 || (!!p.pixFmt && !/^yuvj?420p$/.test(p.pixFmt)) ? 'h264-hi' : 'h264'
  return p.codec
}

/** What one viewer shows of a version: the original where it decodes it (and it is not interlaced), else the proxy, else a picture. Null: nothing it can show yet. */
export function playFor(v: Pick<MediaVersion, 'plays' | 'probe'>, plays: readonly string[]): MediaPlay | null {
  const original = v.plays.find((p) => p.via === 'original')
  if (original && (!v.probe || (!v.probe.interlaced && plays.includes(playKey(v.probe))))) return original
  return v.plays.find((p) => p.via === 'proxy' || p.via === 'hls') ?? v.plays.find((p) => p.via === 'image' || p.via === 'tiles') ?? null
}
