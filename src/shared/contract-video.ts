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

export const VideoRequestSchemas = [
  /**
   * → VideoOpenAnswer. `threadId` is the key the host's sessions know, as in
   * `computer.preview.start`. `computer` names a computer that outlives
   * every thread (`vm:windows`), and the source of that computer answers
   * whatever `threadId` says. `take` asks for the box's one display when
   * another page holds it; `drive` asks for a stream his pointer and keys go
   * down, which is given only while he is the driver.
   */
  request(
    'video.open',
    z.object({
      threadId: z.string().min(1),
      computer: z.string().min(3).max(300).optional(),
      maxEdge: z.number().int().min(VIDEO_MIN_EDGE).max(VIDEO_MAX_EDGE),
      take: z.boolean().optional(),
      drive: z.boolean().optional()
    })
  ),
  /** → null: the caller's own stream ends */
  request('video.close', z.object({ stream: z.string().min(1) })),
  /** → null: text into the page he drives, as a paste; a `drive` stream only */
  request('video.paste', z.object({ stream: z.string().min(1), text: z.string().min(1).max(VIDEO_PASTE_MAX_CHARS) }))
] as const

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
 */
export const VIDEO_CLOSE = { ended: 4100, moved: 4101, busy: 4102, held: 4103, revoked: 4104, error: 4105, permission: 4106, slow: 4107 } as const
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
 *   again       open again with a fresh ticket, up to VIDEO_RETRIES times, then the picture
 */
export type VideoCloseFace = 'picture' | 'kept' | 'stopped' | 'permission' | 'again'
export const VIDEO_CLOSE_SHOWS: Record<VideoCloseReason, { face: VideoCloseFace; retry?: true }> = {
  ended: { face: 'stopped' },
  moved: { face: 'picture' },
  busy: { face: 'picture' },
  held: { face: 'kept' },
  revoked: { face: 'stopped' },
  error: { face: 'stopped', retry: true },
  permission: { face: 'permission' },
  slow: { face: 'again' }
}
/** A viewer opens a dropped stream again this many times before it falls back to the picture. */
export const VIDEO_RETRIES = 5

/** What a viewer shows for a close code: a drop that named no reason is tried again. */
export function videoCloseShows(code: number): { face: VideoCloseFace; retry?: true } {
  const reason = videoCloseReason(code)
  return reason ? VIDEO_CLOSE_SHOWS[reason] : { face: 'again' }
}
