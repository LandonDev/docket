import { z } from 'zod'

/**
 * Live video of the computer an agent drives (docs/agents/live-video.md).
 * `video.open` answers a stream id and a single-use ticket; the frames then
 * travel on a socket of their own, `/video/<stream>?ticket=…`, as NSL1
 * messages (video/nsl1.ts), never on this one. The host the asking socket is
 * connected to serves both.
 */

const request = <M extends string, P extends z.ZodType>(method: M, params: P) =>
  z.object({ id: z.string(), method: z.literal(method), params })

/** The long edge a viewer may ask for, in frame pixels. */
export const VIDEO_MIN_EDGE = 256
export const VIDEO_MAX_EDGE = 3840
/** The long edge of a Mac's or a PC's window sent across a link. */
export const VIDEO_LINK_EDGE = 1280
/** The rate every source aims at. */
export const VIDEO_FPS = 120
/** The upgrade path of a stream's own socket, on the local server and on the fixed-port listener. */
export const VIDEO_PATH = '/video/'
/** `video.paste` carries at most this much text. */
export const VIDEO_PASTE_MAX_CHARS = 262_144

/**
 * Why `video.open` did not open one:
 *   off          the host's setting is off (`work.browser.video`, or a Mac's `computer.video.remote` for a viewer elsewhere)
 *   no-tools     the box has no engine installed
 *   unsupported  this host has no video source for that thread
 *   busy         the box's one display is showing another page, and the caller did not ask to take it
 *   permission   Screen Recording is off
 *   refused      the caller may not watch, or the page is closed to agents
 */
export const VIDEO_REFUSALS = ['off', 'no-tools', 'unsupported', 'busy', 'permission', 'refused'] as const
export type VideoRefusal = (typeof VIDEO_REFUSALS)[number]

export const VideoOpenAnswerSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    stream: z.string(),
    /** 30 s, single use: the only credential the stream's socket takes */
    ticket: z.string(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    fps: z.number().int().positive()
  }),
  z.object({ ok: z.literal(false), reason: z.enum(VIDEO_REFUSALS) })
])
export type VideoOpenAnswer = z.infer<typeof VideoOpenAnswerSchema>

/** What a viewer reads beside frames (NSL1 type 6, the pointer's shape; a pong): the relay passes a stream only those it named. */
export const VIDEO_ACCEPTS = ['cursor', 'pong'] as const
export type VideoAccept = (typeof VIDEO_ACCEPTS)[number]

/** Sharp: the guest at his screen's density (Windows at up to 200%); Faster: one guest pixel a point, drawn doubled. */
export const VIDEO_DETAILS = ['sharp', 'faster'] as const
export type VideoDetail = (typeof VIDEO_DETAILS)[number]
/** The sizes he may pick for the guest, in its pixels, in place of Fit to window. */
export const VIDEO_FIXED_SIZES = [
  { width: 1280, height: 800 },
  { width: 1920, height: 1200 },
  { width: 2560, height: 1600 }
] as const

const SizeStream = z.string().min(1)
const Detail = z.enum(VIDEO_DETAILS)
/**
 * `video.size`: the guest's size, asked by the viewer he drives with (`guestSizeFor`, shared/video/guestSize.ts).
 * `fit` is the picture's room in CSS points and the window's device scale; `fixed` one of VIDEO_FIXED_SIZES.
 */
export const VideoSizeParamsSchema = z.discriminatedUnion('mode', [
  z.object({
    stream: SizeStream,
    mode: z.literal('fit'),
    width: z.number().positive().max(16_384),
    height: z.number().positive().max(16_384),
    scale: z.number().positive().max(8),
    detail: Detail
  }),
  z
    .object({ stream: SizeStream, mode: z.literal('fixed'), width: z.number().int(), height: z.number().int(), detail: Detail })
    .refine((p) => VIDEO_FIXED_SIZES.some((s) => s.width === p.width && s.height === p.height), 'a fixed size is 1280×800, 1920×1200 or 2560×1600')
])
export type VideoSizeParams = z.infer<typeof VideoSizeParamsSchema>

/**
 * Why `video.size` did not take:
 *   unsupported  the stream's source has no size of its own to change (every source but the Windows VM's)
 *   elsewhere    another of his streams sent his last input: its device sizes the guest, this one shows it on matte
 */
export const VIDEO_SIZE_REFUSALS = ['unsupported', 'elsewhere'] as const
/** → the guest's mode it took, in its pixels and Windows' scale in percent; the stream then closes `resized`. */
export const VideoSizeAnswerSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), width: z.number().int().positive(), height: z.number().int().positive(), scale: z.number().int().positive() }),
  z.object({ ok: z.literal(false), reason: z.enum(VIDEO_SIZE_REFUSALS) })
])
export type VideoSizeAnswer = z.infer<typeof VideoSizeAnswerSchema>

export const VideoRequestSchemas = [
  /**
   * → VideoOpenAnswer. `threadId` is the key the host's sessions know, as in
   * `computer.preview.start`. `computer` names a computer that outlives
   * every thread (`vm:windows`), and the source of that computer answers
   * whatever `threadId` says. `take` asks for the box's one display when
   * another page holds it; `drive` asks for a stream his pointer and keys go
   * down, which is given only while he is the driver. `accepts` names what the viewer reads beside frames; one
   * that names none gets frames alone.
   */
  request(
    'video.open',
    z.object({
      threadId: z.string().min(1),
      computer: z.string().min(3).max(300).optional(),
      maxEdge: z.number().int().min(VIDEO_MIN_EDGE).max(VIDEO_MAX_EDGE),
      take: z.boolean().optional(),
      drive: z.boolean().optional(),
      accepts: z.array(z.enum(VIDEO_ACCEPTS)).max(VIDEO_ACCEPTS.length).optional()
    })
  ),
  /** → null: the caller's own stream ends */
  request('video.close', z.object({ stream: z.string().min(1) })),
  /** → null: text into the page he drives, as a paste; a `drive` stream only */
  request('video.paste', z.object({ stream: z.string().min(1), text: z.string().min(1).max(VIDEO_PASTE_MAX_CHARS) })),
  /** → VideoCopyAnswer: the far clipboard's text after his copy in the page he drives, for his own; a `drive` stream only */
  request('video.copy', z.object({ stream: z.string().min(1) })),
  /**
   * → VideoSizeAnswer: the guest's size, on his say alone. The paste gate (a `drive` stream this socket opened, while
   * he drives), never a phone's key, and of his streams only the one that last sent input.
   */
  request('video.size', VideoSizeParamsSchema)
] as const

/** What `video.copy` answers: the text, or null when the far clipboard holds none; `truncated` past its cap. */
export const VideoCopyAnswerSchema = z.object({ text: z.string().nullable(), truncated: z.boolean().optional() })
export type VideoCopyAnswer = z.infer<typeof VideoCopyAnswerSchema>

/**
 * The codes a stream's socket closes with, and the reason each carries.
 *   ended       the session or the page is gone
 *   moved       the box's display went to another page
 *   busy        the display was taken before this socket joined
 *   held        an outward act waits in the Outbox: the kept picture is what he judges
 *   revoked     the key was revoked, or the socket that asked is gone
 *   error       the source failed
 *   permission  Screen Recording went off
 *   slow        the socket held more than 8 MiB unsent
 *   resized     the guest took a new size (`video.size`): its streams' engines start again at it
 */
export const VIDEO_CLOSE = { ended: 4100, moved: 4101, busy: 4102, held: 4103, revoked: 4104, error: 4105, permission: 4106, slow: 4107, resized: 4108 } as const
export type VideoCloseReason = keyof typeof VIDEO_CLOSE

const CLOSE_REASONS = new Map<number, VideoCloseReason>(Object.entries(VIDEO_CLOSE).map(([reason, code]) => [code, reason as VideoCloseReason]))

/** The reason a close code names; null for a drop that named none (a cut link, the engine's own close). */
export function videoCloseReason(code: number): VideoCloseReason | null {
  return CLOSE_REASONS.get(code) ?? null
}

/**
 * What a viewer shows when its stream's socket closes:
 *   picture     the 4 fps picture, with no line
 *   kept        the held act's kept picture
 *   stopped     "The preview stopped" (with Retry where `retry`)
 *   permission  the Screen Recording line
 *   again       open again with a fresh ticket, up to VIDEO_RETRIES times, then the picture; `atOnce`: with no wait,
 *               the last frame kept, and not counted toward VIDEO_RETRIES
 */
export type VideoCloseFace = 'picture' | 'kept' | 'stopped' | 'permission' | 'again'
export interface VideoCloseShows {
  face: VideoCloseFace
  retry?: true
  atOnce?: true
}
export const VIDEO_CLOSE_SHOWS: Record<VideoCloseReason, VideoCloseShows> = {
  ended: { face: 'stopped' },
  moved: { face: 'picture' },
  busy: { face: 'picture' },
  held: { face: 'kept' },
  revoked: { face: 'stopped' },
  error: { face: 'stopped', retry: true },
  permission: { face: 'permission' },
  slow: { face: 'again' },
  resized: { face: 'again', atOnce: true }
}
/** A viewer opens a dropped stream again this many times before it falls back to the picture. */
export const VIDEO_RETRIES = 5

/** What a viewer shows for a close code: a drop that named no reason is tried again. */
export function videoCloseShows(code: number): VideoCloseShows {
  const reason = videoCloseReason(code)
  return reason ? VIDEO_CLOSE_SHOWS[reason] : { face: 'again' }
}
