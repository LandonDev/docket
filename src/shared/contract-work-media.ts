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

// The frame maths and `playFor` live in a module with no zod (mediaFrames.ts): the canvas imports
// them from there, since a lazy chunk's zod schemas grow zod's one copy in the first paint's chunk.
export { frameCount, frameStart, frameCentre, FRAME_SLACK_S, frameAt, tableDuration, tableFps, clock, timecodeFrames, framesTimecode, frameTimecode, VIEWER_DEFAULT_PLAYS, playKey, playFor } from './mediaFrames'

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
  /** the file's own start time (ffprobe's `format.start_time`), which ffmpeg counts a seek from; the video may start after it */
  startS?: number
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
  startS: z.number().optional(),
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
  /** The proxy could not be made: the original and its notes still stand, for a viewer that decodes it. */
  proxyError?: string
  /** 0 to 1 while a proxy is made */
  progress?: number
  probe?: MediaProbe
  /**
   * What the host has for this version, each viewer taking the first it can
   * decode (`playFor`): the original, and a proxy once a viewer that cannot
   * decode the original asked; a picture or its tiles; a review service's
   * renditions. Empty while nothing is ready.
   */
  plays: MediaPlay[]
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

export const MediaRequestSchemas = [
  /** → MediaView: the item's versions, notes and mode. With `plays` (a key that may operate, or this window), it also starts what that viewer needs: a probe, a proxy, a conversion, tiles; `retry` starts a version that failed again. */
  request('work.media.view', z.object({ itemId: z.string(), plays: z.array(z.string().max(16)).max(20).optional(), retry: z.boolean().optional() })),
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
  /** → { data }: one segment of a version's HLS proxy (or `'init'`, its init segment) as base64, asked for as the player needs it */
  request('work.media.segment', z.object({ itemId: z.string(), versionId: z.string(), index: z.union([z.number().int().nonnegative(), z.literal('init')]) })),
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
