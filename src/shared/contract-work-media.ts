import { z } from 'zod'
import { CanvasSourceSchema, type CanvasSource } from './work/canvas'
import type { Principal } from './work/ids'
import { request, type CapsOf, type RelayOf } from './work/wire'

/**
 * The media pillar's wire (docs/agents/work-media.md): an image or a video
 * open beside a Work thread, its versions, and the notes on it. Its methods
 * are `work.media.<verb>` and its push `work.media`; src/shared/work/wire.ts
 * has the helpers and the rules.
 *
 * A note on a video is keyed by a **frame index** into its version's frame
 * table, never by seconds: the viewer seeks to the centre of that frame's
 * interval, which the formats research measured right 16 times in 16 on
 * H.264, VP9 and AV1 where a seek to the frame's start time missed 5 to 12.
 * The frame maths below is shared by the host (the agent's tools speak in
 * timecodes) and the canvas (the seeks).
 */

// ── frame maths ──────────────────────────────────────────────────────

/** A rate as a ratio, `24000/1001` kept exact. */
export interface FrameRate {
  num: number
  den: number
}
export const FrameRateSchema = z.object({ num: z.number().int().positive(), den: z.number().int().positive() })

/**
 * When each frame of a version is shown, built on the host at import.
 * `cfr`: frame `n` starts at `start + n·den/num`. `vfr`: a phone clip whose
 * rate varies, with every frame's start time (ffprobe's packet times,
 * sorted) and the end of the last frame. Seconds are media time, as the
 * `<video>` element reads it.
 */
export type FrameTable =
  | { kind: 'cfr'; start: number; rate: FrameRate; count: number }
  | { kind: 'vfr'; times: number[]; end: number }
export const FrameTableSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('cfr'), start: z.number(), rate: FrameRateSchema, count: z.number().int().nonnegative() }),
  z.object({ kind: z.literal('vfr'), times: z.array(z.number()), end: z.number() })
])

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
  const fps = rate.num / rate.den
  return rate.den === 1001 && Math.abs(fps * 1001 - Math.round(fps) * 1000) < 1 ? Math.round(fps / 15) : 0
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

// ── what the host found ──────────────────────────────────────────────

/** What ffprobe said of one file. Sizes are the picture's as stored; `rotation` is what the player turns it by. */
export interface MediaProbe {
  kind: 'video' | 'image'
  /** ffprobe's format name: `mov,mp4,m4a,3gp,3g2,mj2`, `matroska,webm`, `image2`, … */
  container: string
  size: number
  mtimeMs: number
  width: number
  height: number
  rotation: 0 | 90 | 180 | 270
  /** `h264`, `hevc`, `vp9`, `av1`, `prores`, `dnxhd`, `mjpeg`, `png`, `hevc` for a HEIC still, … */
  codec: string
  profile?: string
  pixFmt?: string
  bitDepth?: number
  interlaced?: boolean
  rate?: FrameRate
  durationS?: number
  frames?: number
  vfr?: boolean
  /** the `tmcd` track's start, or the stream's own tag */
  timecode?: string
  audio?: { codec: string; channels: number }
}
export const MediaProbeSchema = z.object({
  kind: z.enum(['video', 'image']),
  container: z.string(),
  size: z.number(),
  mtimeMs: z.number(),
  width: z.number(),
  height: z.number(),
  rotation: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]),
  codec: z.string(),
  profile: z.string().optional(),
  pixFmt: z.string().optional(),
  bitDepth: z.number().optional(),
  interlaced: z.boolean().optional(),
  rate: FrameRateSchema.optional(),
  durationS: z.number().optional(),
  frames: z.number().optional(),
  vfr: z.boolean().optional(),
  timecode: z.string().optional(),
  audio: z.object({ codec: z.string(), channels: z.number() }).optional()
})

/**
 * How the canvas shows one version. `original`: the file itself, where the
 * viewer decodes it. `proxy`: an H.264 8-bit 4:2:0 copy the host made, frame
 * for frame. `hls`: the same, cut into fMP4 segments for a long file, which
 * the canvas feeds through Media Source (Electron 39 has no HLS of its own);
 * `ended` is false while the host is still writing it. `image`: the picture,
 * or the JPEG a HEIC became. `tiles`: a picture too large to decode whole,
 * cut into Deep Zoom levels (`work.media.tile`), with a preview to show while
 * they load. Every URL is the media host's (`tempcode-asset://file/…`), with
 * Range, readable from another host's desktop.
 */
export type MediaPlay =
  | { via: 'original'; url: string; mime: string; table: FrameTable }
  | { via: 'proxy'; url: string; table: FrameTable; why: string }
  | { via: 'hls'; init: string; segments: Array<{ start: number; duration: number }>; ended: boolean; mime: string; table: FrameTable; why: string }
  | { via: 'image'; url: string; width: number; height: number; converted?: string }
  /** `levels`: Deep Zoom's count, level `levels − 1` at full size; tiles are cut from `minLevel` up, the preview stands in below it. */
  | { via: 'tiles'; preview: string; width: number; height: number; tile: number; overlap: number; levels: number; minLevel: number; format: 'jpg' }

/** One file in an item's stack of versions: `v1` is the first opened. */
export interface MediaVersion {
  id: string
  n: number
  name: string
  source: CanvasSource
  addedAt: number
  addedBy: Principal
  /** probing: ffprobe is reading it. preparing: a proxy, a conversion or tiles are being made. failed: `error` says why. */
  state: 'probing' | 'preparing' | 'ready' | 'failed'
  error?: string
  /** 0 to 1 while a proxy is made */
  progress?: number
  probe?: MediaProbe
  play?: MediaPlay
}

// ── notes ────────────────────────────────────────────────────────────

/** One mark in picture space: 0 to 1 of the picture, upper-left origin, as Frame.io stores them. `width` is a share of the picture's height. */
export type MediaShape =
  | { tool: 'pen'; color: string; width: number; points: Array<[number, number, number?]> }
  | { tool: 'rect'; color: string; width: number; x: number; y: number; w: number; h: number }
  | { tool: 'ellipse'; color: string; width: number; cx: number; cy: number; rx: number; ry: number }
  | { tool: 'line' | 'arrow'; color: string; width: number; x1: number; y1: number; x2: number; y2: number }
const unit = z.number().min(-0.5).max(1.5)
const colorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/)
const widthSchema = z.number().positive().max(0.1)
export const MediaShapeSchema = z.discriminatedUnion('tool', [
  z.object({ tool: z.literal('pen'), color: colorSchema, width: widthSchema, points: z.array(z.tuple([unit, unit]).or(z.tuple([unit, unit, z.number().min(0).max(1)]))).min(1).max(5000) }),
  z.object({ tool: z.literal('rect'), color: colorSchema, width: widthSchema, x: unit, y: unit, w: unit, h: unit }),
  z.object({ tool: z.literal('ellipse'), color: colorSchema, width: widthSchema, cx: unit, cy: unit, rx: unit, ry: unit }),
  z.object({ tool: z.literal('line'), color: colorSchema, width: widthSchema, x1: unit, y1: unit, x2: unit, y2: unit }),
  z.object({ tool: z.literal('arrow'), color: colorSchema, width: widthSchema, x1: unit, y1: unit, x2: unit, y2: unit })
])

/** A box in picture space, 0 to 1. */
export interface MediaRegion {
  x: number
  y: number
  w: number
  h: number
}
export const MediaRegionSchema = z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), w: z.number().min(0).max(1), h: z.number().min(0).max(1) })

/**
 * Where a note sits. A video note names a frame of its version (and a run of
 * frames for a stretch); an image note none. `region`, `pin` and `shapes`
 * are all in picture space.
 */
export interface MediaAnchor {
  versionId: string
  frame?: number
  durationFrames?: number
  region?: MediaRegion
  pin?: { x: number; y: number }
  shapes?: MediaShape[]
}
export const MediaAnchorSchema = z.object({
  versionId: z.string(),
  frame: z.number().int().nonnegative().optional(),
  durationFrames: z.number().int().positive().optional(),
  region: MediaRegionSchema.optional(),
  pin: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }).optional(),
  shapes: z.array(MediaShapeSchema).max(200).optional()
})

/**
 * A comment or a chapter. `suggested`: an agent's note on a shared item,
 * waiting for the person (the stepper's Accept makes it his, Reject drops
 * it). `external`: a note that came from a review service, for milestone 48.
 */
export interface MediaNote {
  id: string
  itemId: string
  kind: 'comment' | 'chapter'
  anchor: MediaAnchor
  body: string
  by: Principal
  state: 'kept' | 'suggested'
  resolved: boolean
  parentId?: string
  external?: { service: string; id: string; author: string }
  createdAt: number
  updatedAt: number
}

/** What the agent last wrote straight onto the item, for the "Added 7 chapters, 2:04 PM" line and its Undo. */
export interface MediaWrite {
  id: string
  text: string
  at: number
}

/** Everything the canvas shows of one media item. `shared`: other people review it, so the agent's notes wait for the person. */
export interface MediaView {
  itemId: string
  kind: 'video' | 'image'
  versions: MediaVersion[]
  notes: MediaNote[]
  mode: 'suggests' | 'writes'
  shared: boolean
  lastWrite?: MediaWrite
  rev: number
}

// ── the wire ─────────────────────────────────────────────────────────

/**
 * What a viewer decodes, as it reports it (`plays`): `h264` (8-bit 4:2:0),
 * `h264-hi` (10-bit or 4:2:2), `hevc`, `vp9`, `av1`, `prores`, `dnxhd`. A
 * codec it leaves out gets a proxy. Absent, the host assumes Chromium on
 * Linux: H.264 of any profile, VP9 and AV1.
 */
export const VIEWER_DEFAULT_PLAYS = ['h264', 'h264-hi', 'vp9', 'av1'] as const

export const MediaRequestSchemas = [
  /** → MediaView: the item's versions, notes and mode; the first read probes the file and starts what it needs (a proxy, a conversion, tiles) */
  request('work.media.view', z.object({ itemId: z.string(), plays: z.array(z.string().max(16)).max(20).optional() })),
  /** → MediaNote: the person's note at a frame, a stretch or a region */
  request('work.media.note', z.object({ itemId: z.string(), kind: z.enum(['comment', 'chapter']).optional(), anchor: MediaAnchorSchema, body: z.string().max(40_000), parentId: z.string().optional() })),
  /** → MediaNote: a note's words, or whether it is resolved */
  request('work.media.edit', z.object({ noteId: z.string(), body: z.string().min(1).max(40_000).optional(), resolved: z.boolean().optional() })),
  /** → null */
  request('work.media.remove', z.object({ noteId: z.string() })),
  /** → MediaView: Accept (the note becomes the person's) or Reject (it goes) one waiting note, or all of them */
  request('work.media.decide', z.object({ itemId: z.string(), which: z.union([z.string(), z.literal('all')]), accept: z.boolean() })),
  /** → MediaView: what the agent does to the item: suggest, or write straight onto it */
  request('work.media.mode', z.object({ itemId: z.string(), mode: z.enum(['suggests', 'writes']) })),
  /** → MediaView: takes back the agent's last direct write */
  request('work.media.undo', z.object({ itemId: z.string(), writeId: z.string() })),
  /** → MediaView: another file as the item's next version */
  request('work.media.version', z.object({ itemId: z.string(), source: CanvasSourceSchema })),
  /** → { url }: one segment of a version's HLS proxy, minted when it is wanted */
  request('work.media.segment', z.object({ itemId: z.string(), versionId: z.string(), index: z.number().int().nonnegative() })),
  /** → { data }: one Deep Zoom tile as base64 JPEG; level 0 is 1×1 px, the last the full picture */
  request('work.media.tile', z.object({ itemId: z.string(), versionId: z.string(), level: z.number().int().nonnegative().max(40), x: z.number().int().nonnegative(), y: z.number().int().nonnegative() }))
] as const

/** An item's view changed: its versions, its notes or its mode. */
export type MediaPush = { push: 'work.media'; itemId: string; view: MediaView }

export const MEDIA_CAPS = {
  'work.media.view': 'read',
  'work.media.note': 'operate',
  'work.media.edit': 'operate',
  'work.media.remove': 'operate',
  'work.media.decide': 'operate',
  'work.media.mode': 'operate',
  'work.media.undo': 'operate',
  'work.media.version': 'operate',
  'work.media.segment': 'read',
  'work.media.tile': 'read'
} satisfies CapsOf<typeof MediaRequestSchemas>
export const MEDIA_RELAY = {} satisfies RelayOf<typeof MediaRequestSchemas>
