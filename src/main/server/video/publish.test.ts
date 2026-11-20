import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import type { Principal } from '@shared/capabilities'
import { VIDEO_CLOSE, type VideoOpenAnswer } from '@shared/contract-video'
import { VIDEO_PUBLISH_PATH, type VideoPublishArgs } from '@shared/contract-videopublish'
import { encodeAck, parseFrame, type Frame } from '@shared/video/nsl1'
import { computerHarness } from '../computer/runHarness'
import { ComputerVideo } from '../computer/videoFeed'
import { openDb } from '../db'
import { RemoteAuth } from '../remote/auth'
import { PublishedFeed, VideoPublishing, publishIdOf } from './published'
import { VideoPublisher, publishUrl, videoOffers } from './publisher'
import { VideoRelay } from './relay'
import { VideoRpc } from './rpc'
import { VideoSockets, refuseVideoUpgrade } from './sockets'

/**
 * The publish leg, whole, between two hosts in one process: "the box" is a
 * real HTTP server with the real upgrades, tickets, relay and RPC; "the Mac"
 * is the real publisher over the real window source and the fake computer
 * service, which sends video on its bytes pipe and stops eight frames ahead
 * of the acks. The peer call between them is a function call; both sockets
 * are real.
 */

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const until = async (what: () => boolean, ms = 5_000): Promise<void> => {
  const end = Date.now() + ms
  while (!what()) {
    if (Date.now() > end) throw new Error('timed out')
    await sleep(10)
  }
}

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close()
})

async function hosts(opts: { remote?: boolean; knows?: boolean } = {}) {
  // ── the Mac: a session that read a window, and the publisher over its service ──
  const h = computerHarness({ env: { FAKE_VIDEO_FPS: '100' } })
  await h.run('computer_observe', { app: 'TextEdit' }, 'box-env:t1')
  const mac = { remote: opts.remote ?? true, port: 0 }
  const publisher = new VideoPublisher({
    remote: () => mac.remote,
    source: new ComputerVideo({ service: h.service, sessions: h.sessions, remote: () => mac.remote }),
    urlOf: (envId) => (envId === 'box-env' && opts.knows !== false ? `ws://127.0.0.1:${mac.port}/ws?ticket=old` : null),
    link: () => null
  })
  // ── the box: its own listener, with both upgrades ──
  const dir = mkdtempSync(join(tmpdir(), 'tc-publish-'))
  const db = openDb(join(dir, 'app.db'))
  const auth = new RemoteAuth(db, { resolveHost: async () => [] })
  const relay = new VideoRelay()
  const rpc = new VideoRpc(relay, auth, () => false)
  const sockets = new VideoSockets(relay, auth)
  const calls: VideoPublishArgs[] = []
  const publishing = new VideoPublishing({
    auth,
    call: async (macId, args) => {
      calls.push(args)
      if (macId !== 'mac-env') throw new Error('offline')
      return publisher.publish('box-env', args)
    },
    macOf: (thread) => (thread === 't1' ? { mac: 'mac-env', key: 'box-env:t1' } : null),
    joinMs: 1_000
  })
  rpc.addSource(publishing, 'last')
  auth.onRevoke((keyId) => relay.revoke(keyId))
  const server: Server = createServer((_req, res) => res.writeHead(404).end())
  server.on('upgrade', (req, socket, head) => {
    const path = (req.url ?? '').split('?')[0]
    const refused = path.startsWith(VIDEO_PUBLISH_PATH) ? publishing.upgrade(req, socket, head) : sockets.upgrade(req, socket, head, 'remote')
    if (refused !== null) refuseVideoUpgrade(socket, refused)
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  mac.port = (server.address() as { port: number }).port
  cleanups.push(
    () => publisher.closeAll(),
    () => publishing.close(),
    () => sockets.close(),
    () => relay.shutdown(),
    () => new Promise<void>((r) => (server.closeAllConnections(), server.close(() => r()))),
    () => h.close(),
    () => {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  )
  // ── his phone: a key that may watch ──
  const phone = (await auth.verifyToken((await auth.createKey({ name: 'Phone', audience: 'client', caps: ['read', 'approve'], createdBy: 'local' })).token))! as Principal & { kind: 'remote' }
  const me = { principal: phone, connection: {}, connectionId: 'c1' }
  const open = (threadId = 't1'): Promise<VideoOpenAnswer> => rpc.open({ threadId, maxEdge: 2560 }, me)
  /** the phone's own socket to the stream */
  const watch = (answer: VideoOpenAnswer & { ok: true }, ack = true) => {
    const frames: Frame[] = []
    const closed: { code: number | null } = { code: null }
    const ws = new WebSocket(`ws://127.0.0.1:${mac.port}/video/${answer.stream}?ticket=${answer.ticket}`, ['nsl1'])
    ws.binaryType = 'arraybuffer'
    ws.on('message', (data) => {
      const frame = parseFrame(new Uint8Array(data as ArrayBuffer))
      frames.push({ ...frame, data: frame.data.slice() })
      if (ack) ws.send(encodeAck(frame.generation, frame.sequence, 0))
    })
    ws.on('close', (code) => (closed.code = code))
    ws.on('error', () => undefined)
    cleanups.push(() => ws.terminate())
    return { ws, frames, closed }
  }
  const starts = () => h.requests().filter((r) => r.method === 'capture.video.start')
  const stops = () => h.requests().filter((r) => r.method === 'capture.video.stop')
  return { h, mac, publisher, publishing, relay, rpc, auth, phone, me, open, watch, calls, starts, stops, port: () => mac.port }
}

describe('the publish leg, between two hosts', () => {
  it('names the socket to dial beside the host’s RPC socket, and a path that names a publish id', () => {
    expect(publishUrl('wss://box.example/ws?ticket=old', 'abcDEF_123-x', 'tk')).toBe('wss://box.example/video-publish/abcDEF_123-x?ticket=tk')
    expect(publishIdOf('/video-publish/abcDEF_123-x')).toBe('abcDEF_123-x')
    expect(publishIdOf('/video-publish/short')).toBeNull()
    expect(publishIdOf('/video/abcDEF_123-x')).toBeNull()
    expect(videoOffers(true)).toEqual(['video'])
    expect(videoOffers(false)).toEqual([])
  })

  it('brings a window on the Mac to a viewer on the box: frames arrive, and the viewer’s acks reach the encoder', async () => {
    const r = await hosts()
    const answer = await r.open()
    if (!answer.ok) throw new Error(`refused: ${answer.reason}`)
    // the Mac was asked for the session by its own key, across a link: at most 1280, the encoder following the link
    expect(r.calls[0]).toMatchObject({ key: 'box-env:t1', maxEdge: 1280 })
    expect(r.starts()[0].params).toMatchObject({ app: { pid: 16800 }, window: { id: 1581 }, maxEdge: 1280, mode: 'budget' })
    expect(answer).toMatchObject({ fps: 120 })
    expect(r.publisher.count).toBe(1)
    const viewer = r.watch(answer)
    // far past the eight the service sends ahead of the acks: they crossed both sockets and the pipe
    await until(() => viewer.frames.length >= 30)
    expect(viewer.frames[0]).toMatchObject({ sequence: 1, keyframe: true, width: answer.width, height: answer.height })
    expect(viewer.frames.slice(0, 30).map((f) => f.sequence)).toEqual(Array.from({ length: 30 }, (_, i) => i + 1))
    // the viewer leaves: the Mac's stream stops and nothing is left published
    viewer.ws.close()
    await until(() => r.stops().length === 1 && r.publisher.count === 0 && r.publishing.count === 0)
  })

  it('stops at the service’s window when the viewer acks nothing', async () => {
    const r = await hosts()
    const answer = await r.open()
    if (!answer.ok) throw new Error()
    const viewer = r.watch(answer, false)
    await until(() => viewer.frames.length === 8)
    await sleep(200)
    expect(viewer.frames).toHaveLength(8)
  })

  it('refuses while the Mac’s switch is off, and asks its service for nothing', async () => {
    const r = await hosts({ remote: false })
    expect(await r.open()).toEqual({ ok: false, reason: 'off' })
    expect(r.starts()).toEqual([])
    expect(r.publishing.count).toBe(0)
    // a thread whose session is on no machine of his is not this source's
    expect(await r.open('elsewhere')).toEqual({ ok: false, reason: 'unsupported' })
    expect(r.calls).toHaveLength(1)
  })

  it('closes what is being watched when he turns the switch off', async () => {
    const r = await hosts()
    const answer = await r.open()
    if (!answer.ok) throw new Error()
    const viewer = r.watch(answer)
    await until(() => viewer.frames.length > 0)
    r.mac.remote = false
    r.publisher.closeAll()
    await until(() => viewer.closed.code !== null)
    expect(viewer.closed.code).toBe(VIDEO_CLOSE.ended)
    expect(r.stops()).toHaveLength(1)
    expect(await r.open()).toEqual({ ok: false, reason: 'off' })
  })

  it('closes the viewer’s stream and the Mac’s when the viewer’s key is revoked', async () => {
    const r = await hosts()
    const answer = await r.open()
    if (!answer.ok) throw new Error()
    const viewer = r.watch(answer)
    await until(() => viewer.frames.length > 0)
    r.auth.revokeKey(r.phone.keyId)
    await until(() => viewer.closed.code !== null)
    expect(viewer.closed.code).toBe(VIDEO_CLOSE.revoked)
    await until(() => r.stops().length === 1 && r.publisher.count === 0)
  })

  it('publishes only to a host the Mac has saved', async () => {
    const r = await hosts({ knows: false })
    expect(await r.open()).toEqual({ ok: false, reason: 'refused' })
    expect(r.starts()).toEqual([])
  })

  it('takes a publisher only with the ticket its ask carried, once, and never a viewer’s', async () => {
    const r = await hosts()
    const dial = (path: string): Promise<number | 'open'> =>
      new Promise((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${r.port()}${path}`, ['nsl1'])
        ws.on('open', () => (ws.terminate(), resolve('open')))
        ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0))
        ws.on('error', () => undefined)
      })
    expect(await dial('/video-publish/abcdefgh1234?ticket=nope')).toBe(401)
    expect(await dial('/video-publish/abcdefgh1234')).toBe(401)
    expect(await dial('/video-publish/bad')).toBe(404)
    // a viewer's ticket opens no publish socket, and a publish ticket no viewer's
    const viewerTicket = r.auth.mintStreamTicket({ stream: 'abcdefgh1234', scope: 'watch', holder: { keyId: r.phone.keyId } }).ticket
    expect(await dial(`/video-publish/abcdefgh1234?ticket=${viewerTicket}`)).toBe(401)
    const publishTicket = r.auth.mintStreamTicket({ stream: 'abcdefgh1234', scope: 'publish', holder: { local: 'publish:mac-env' } }).ticket
    expect(await dial(`/video/abcdefgh1234?ticket=${publishTicket}`)).toBe(401)
    // a real ticket for a stream nobody waits for
    const orphan = r.auth.mintStreamTicket({ stream: 'abcdefgh1234', scope: 'publish', holder: { local: 'publish:mac-env' } }).ticket
    expect(await dial(`/video-publish/abcdefgh1234?ticket=${orphan}`)).toBe(404)
  })
})

describe('a published feed', () => {
  it('ends a stream whose machine never dials in', async () => {
    const ends: string[] = []
    let gone = 0
    const feed = new PublishedFeed('abcdefgh1234', () => void gone++, 40)
    feed.start({ frame: () => undefined, end: (reason) => void ends.push(reason) })
    await sleep(120)
    expect(ends).toEqual(['error'])
    expect(gone).toBe(1)
    // and takes no socket after
    expect(feed.attach({ send: () => undefined, close: () => undefined, on: () => undefined })).toBe(false)
  })
})
