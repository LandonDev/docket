import { describe, expect, it } from 'vitest'
import { LOCAL_PRINCIPAL, METHOD_CAPABILITY, type Capability, type Principal } from '../capabilities'
import {
  VIDEO_CLOSE,
  VIDEO_CLOSE_SHOWS,
  VIDEO_REFUSALS,
  VideoOpenAnswerSchema,
  VideoRequestSchemas,
  VideoSizeAnswerSchema,
  VideoSizeParamsSchema,
  videoCloseReason,
  videoCloseShows
} from '../contract-video'
import { mayWatch } from './access'

const key = (caps: Capability[], audience: 'client' | 'mcp' = 'client'): Principal => ({ kind: 'remote', keyId: 'k1', name: 'Phone', audience, caps })
const DESKTOP = { desktop: true }
const BOX = { desktop: false }

describe('mayWatch', () => {
  it('a client key with approve watches, on a desktop and on the box', () => {
    expect(mayWatch(key(['read', 'approve']), DESKTOP)).toBe(true)
    expect(mayWatch(key(['read', 'approve']), BOX)).toBe(true)
    expect(mayWatch(key(['admin', 'read']), BOX)).toBe(true)
  })
  it('a read-only key and an operate key never get a picture', () => {
    expect(mayWatch(key(['read']), BOX)).toBe(false)
    expect(mayWatch(key(['operate', 'read']), BOX)).toBe(false)
  })
  it('an mcp key never does, whatever it holds', () => {
    expect(mayWatch(key(['approve', 'read'], 'mcp'), BOX)).toBe(false)
    expect(mayWatch(key(['admin', 'read'], 'mcp'), DESKTOP)).toBe(false)
  })
  it("a desktop's own socket watches", () => {
    expect(mayWatch(LOCAL_PRINCIPAL, DESKTOP)).toBe(true)
  })
  it("the box's local socket is refused: any process of its user reaches it", () => {
    expect(mayWatch(LOCAL_PRINCIPAL, BOX)).toBe(false)
  })
})

describe('the video contract', () => {
  it('every video method and the preview need approve', () => {
    for (const m of ['video.open', 'video.close', 'video.paste', 'video.copy', 'video.size', 'computer.preview.start', 'computer.preview.ack', 'computer.preview.stop'] as const)
      expect(METHOD_CAPABILITY[m]).toBe('approve')
  })
  it('an open answers a stream with its ticket, or one of the six refusals', () => {
    expect(VideoOpenAnswerSchema.safeParse({ ok: true, stream: 's', ticket: 't', width: 1280, height: 800, fps: 120 }).success).toBe(true)
    for (const reason of VIDEO_REFUSALS) expect(VideoOpenAnswerSchema.safeParse({ ok: false, reason }).success).toBe(true)
    expect(VideoOpenAnswerSchema.safeParse({ ok: false, reason: 'later' }).success).toBe(false)
    expect(VideoOpenAnswerSchema.safeParse({ ok: true, stream: 's' }).success).toBe(false)
  })
  it('each close code names its reason, in the range an app may use', () => {
    const codes = Object.values(VIDEO_CLOSE)
    expect(new Set(codes).size).toBe(codes.length)
    for (const [reason, code] of Object.entries(VIDEO_CLOSE)) {
      expect(code).toBeGreaterThanOrEqual(4000)
      expect(code).toBeLessThan(5000)
      expect(videoCloseReason(code)).toBe(reason)
    }
    // 4001 is the key-revoked close of the RPC socket, 1006 a cut link: neither is one of ours
    expect(videoCloseReason(4001)).toBeNull()
    expect(videoCloseReason(1006)).toBeNull()
  })
  it('says what each close shows', () => {
    expect(VIDEO_CLOSE_SHOWS.moved).toEqual({ face: 'picture' })
    expect(VIDEO_CLOSE_SHOWS.busy).toEqual({ face: 'picture' })
    expect(VIDEO_CLOSE_SHOWS.held).toEqual({ face: 'kept' })
    expect(VIDEO_CLOSE_SHOWS.ended).toEqual({ face: 'stopped' })
    expect(VIDEO_CLOSE_SHOWS.revoked).toEqual({ face: 'stopped' })
    expect(VIDEO_CLOSE_SHOWS.error).toEqual({ face: 'stopped', retry: true })
    expect(VIDEO_CLOSE_SHOWS.permission).toEqual({ face: 'permission' })
    // the socket was too slow, or the link was cut: open again
    expect(VIDEO_CLOSE_SHOWS.slow).toEqual({ face: 'again' })
    expect(videoCloseShows(1006)).toEqual({ face: 'again' })
    expect(videoCloseShows(VIDEO_CLOSE.moved)).toEqual({ face: 'picture' })
    // the guest took a new size: open again at once, not a try
    expect(VIDEO_CLOSE.resized).toBe(4108)
    expect(videoCloseShows(4108)).toEqual({ face: 'again', atOnce: true })
  })
  it('asks a size to fit a room, or one of three fixed sizes', () => {
    const fit = { stream: 's', mode: 'fit', width: 1728, height: 1117, scale: 2, detail: 'sharp' }
    expect(VideoSizeParamsSchema.safeParse(fit).success).toBe(true)
    expect(VideoSizeParamsSchema.safeParse({ ...fit, detail: 'blurry' }).success).toBe(false)
    expect(VideoSizeParamsSchema.safeParse({ ...fit, scale: 0 }).success).toBe(false)
    const fixed = { stream: 's', mode: 'fixed', detail: 'faster' }
    for (const [width, height] of [[1280, 800], [1920, 1200], [2560, 1600]]) expect(VideoSizeParamsSchema.safeParse({ ...fixed, width, height }).success).toBe(true)
    expect(VideoSizeParamsSchema.safeParse({ ...fixed, width: 3000, height: 2000 }).success).toBe(false)
    expect(VideoSizeAnswerSchema.safeParse({ ok: true, width: 4000, height: 2250, scale: 125 }).success).toBe(true)
    expect(VideoSizeAnswerSchema.safeParse({ ok: false, reason: 'elsewhere' }).success).toBe(true)
  })
  it('an open names what it reads beside frames, from a known list', () => {
    const open = VideoRequestSchemas[0].shape.params
    expect(open.safeParse({ threadId: 't', maxEdge: 1280, accepts: ['cursor', 'pong'] }).success).toBe(true)
    expect(open.safeParse({ threadId: 't', maxEdge: 1280, accepts: ['audio'] }).success).toBe(false)
    expect(open.safeParse({ threadId: 't', maxEdge: 1280 }).success).toBe(true)
  })
})
