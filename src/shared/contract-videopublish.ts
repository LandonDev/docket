import { z } from 'zod'
import { VIDEO_MAX_EDGE, VIDEO_MIN_EDGE, VIDEO_REFUSALS } from './contract-video'

/**
 * The publish leg of live video (docs/agents/live-video.md "From his other
 * devices"). A Mac's or a PC's windows are watched from elsewhere only
 * through the host that machine dials (the box): the viewer asks the box,
 * the box asks the machine over the peer link to publish one session's
 * stream (`video.publish`), and the machine dials the box's
 * `/video-publish/<id>` with the single-use ticket the call carried and
 * sends the stream up it. The machine checks its own switch
 * (`computer.video.remote`) before it publishes anything.
 */

/** A machine that can publish its windows' video to the host it dials. */
export const VIDEO_OFFER = 'video'
export const VIDEO_PEER_METHODS = ['video.publish'] as const
export type VideoPeerMethod = (typeof VIDEO_PEER_METHODS)[number]
export const isVideoPeerMethod = (method: string): method is VideoPeerMethod => (VIDEO_PEER_METHODS as readonly string[]).includes(method)

/** The upgrade path of a publishing machine's socket, on the fixed-port listener and the local server. */
export const VIDEO_PUBLISH_PATH = '/video-publish/'
/** How long the asking host waits for the machine's answer. */
export const VIDEO_PUBLISH_MS = 15_000

export const VideoPublishArgsSchema = z.object({
  /** the session, by the key the machine's own computer service knows it under */
  key: z.string().min(1).max(256),
  /** the id of the socket to dial, and the ticket that opens it once */
  publish: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
  ticket: z.string().min(1).max(256),
  maxEdge: z.number().int().min(VIDEO_MIN_EDGE).max(VIDEO_MAX_EDGE)
})
export type VideoPublishArgs = z.infer<typeof VideoPublishArgsSchema>
/** A `video.publish` call's params: the asking host and its args. */
export const VideoPublishParamsSchema = z.object({ from: z.string().min(1), args: VideoPublishArgsSchema })
export type VideoPublishCallParams = z.infer<typeof VideoPublishParamsSchema>

export const VideoPublishAnswerSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), width: z.number().int().positive(), height: z.number().int().positive(), fps: z.number().int().positive() }),
  z.object({ ok: z.literal(false), reason: z.enum(VIDEO_REFUSALS) })
])
export type VideoPublishAnswer = z.infer<typeof VideoPublishAnswerSchema>
