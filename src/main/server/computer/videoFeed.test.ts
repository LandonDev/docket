import { afterEach, describe, expect, it, vi } from 'vitest'
import { LOCAL_PRINCIPAL, type Principal } from '@shared/capabilities'
import type { ComputerNotification } from '@shared/computer/protocol'
import type { ComputerClickPush } from '@shared/contract-computer'
import { VIDEO_CLOSE } from '@shared/contract-video'
import { encodeAck, parseFrame, type Frame } from '@shared/video/nsl1'
import type { StreamClaim } from '../remote/auth'
import { VideoRelay, type ViewerSocket } from '../video/relay'
import { VideoRpc } from '../video/rpc'
import { computerHarness } from './runHarness'
import { ComputerVideo } from './videoFeed'

/** A viewer's socket: every frame kept, and acked when the test says so. */
class Viewer implements ViewerSocket {
  bufferedAmount = 0
  readonly frames: Frame[] = []
  closed: { code: number; reason: string } | null = null
  private say: ((data: Buffer, isBinary: boolean) => void) | null = null
  private readonly closers: (() => void)[] = []
  auto = true
  send(bytes: Uint8Array): void {
    const frame = parseFrame(bytes)
    this.frames.push({ ...frame, data: frame.data.slice() })
    if (this.auto) this.ack(frame)
  }
  ack(frame: Pick<Frame, 'generation' | 'sequence'>): void {
    this.say?.(Buffer.from(encodeAck(frame.generation, frame.sequence, 0)), true)
  }
  close(code: number, reason: string): void {
    if (this.closed) return
    this.closed = { code, reason }
    for (const fn of this.closers) fn()
  }
  on(event: 'message' | 'close', fn: never): void {
    if (event === 'message') this.say = fn
    else this.closers.push(fn)
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const until = async (what: () => boolean, ms = 5_000): Promise<void> => {
  const end = Date.now() + ms
  while (!what()) {
    if (Date.now() > end) throw new Error('timed out')
    await sleep(10)
  }
}
const phone: Principal = { kind: 'remote', keyId: 'k1', name: 'Phone', audience: 'client', caps: ['read', 'approve'] }

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const close of cleanups.splice(0).reverse()) await close()
})

async function setup(env: Record<string, string> = {}, opts: { remote?: boolean } = {}) {
  const h = computerHarness({ env: { FAKE_VIDEO_FPS: '100', ...env } })
  await h.run('computer_observe', { app: 'TextEdit' })
  const relay = new VideoRelay()
  const minted: StreamClaim[] = []
  const rpc = new VideoRpc(relay, { mintStreamTicket: (claim) => (minted.push(claim), { ticket: 't', expiresIn: 30 }) }, () => true)
  const state = { remote: opts.remote ?? false }
  rpc.addSource(new ComputerVideo({ service: h.service, sessions: h.sessions, remote: () => state.remote }))
  cleanups.push(
    () => relay.shutdown(),
    () => h.close()
  )
  const pushes: ComputerClickPush[] = []
  const me = { principal: LOCAL_PRINCIPAL, connection: {}, connectionId: '1', push: (p: ComputerClickPush) => void pushes.push(p) }
  const join = (): Viewer => {
    const viewer = new Viewer()
    expect(relay.attach(minted.at(-1)!, viewer)).toBe(true)
    return viewer
  }
  const requests = (method: string) => h.requests().filter((r) => r.method === method)
  return { h, relay, rpc, me, join, pushes, state, requests }
}

describe('a window in tc-computer as live video', () => {
  it('asks the service for video of the window the thread last read, at the window’s own pixels for this desktop, and passes its frames on', async () => {
    const r = await setup()
    const answer = await r.rpc.open({ threadId: 't1', maxEdge: 2048 }, r.me)
    expect(answer).toMatchObject({ ok: true, fps: 120 })
    expect(r.requests('capture.video.start')[0].params).toMatchObject({ session: 't1', app: { pid: 16800 }, window: { id: 1581 }, maxEdge: 2048, fps: 120, mode: 'quality' })
    expect(r.relay.list()).toMatchObject([{ thread: 't1', scope: 'watch', tag: 'window:16800:1581' }])
    const viewer = r.join()
    await until(() => viewer.frames.length >= 12)
    expect(viewer.frames[0]).toMatchObject({ generation: 1, sequence: 1, keyframe: true })
    // in order, and well past the eight the service sends ahead of the acks: the acks reach it
    expect(viewer.frames.map((f) => f.sequence).slice(0, 12)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
    if (!answer.ok) throw new Error()
    expect([viewer.frames[0].width, viewer.frames[0].height]).toEqual([answer.width, answer.height])
    // the viewer leaves: the service's stream stops
    viewer.close(1000, '')
    await until(() => r.requests('capture.video.stop').length === 1)
  })

  it('sends the service nothing ahead of the viewer: with no acks it stops at eight frames', async () => {
    const r = await setup()
    await r.rpc.open({ threadId: 't1', maxEdge: 1280 }, r.me)
    const viewer = r.join()
    viewer.auto = false
    await until(() => viewer.frames.length === 8)
    await sleep(150)
    expect(viewer.frames).toHaveLength(8)
    for (const f of viewer.frames) viewer.ack(f)
    await until(() => viewer.frames.length > 8)
  })

  it('is not asked about a thread with no window here, and says unsupported for a service with no video', async () => {
    const r = await setup()
    expect(await r.rpc.open({ threadId: 'elsewhere', maxEdge: 1280 }, r.me)).toEqual({ ok: false, reason: 'unsupported' })
    expect(r.requests('capture.video.start')).toEqual([])
    const bare = await setup({ FAKE_NO_VIDEO_PIPE: '1' })
    expect(await bare.rpc.open({ threadId: 't1', maxEdge: 1280 }, bare.me)).toEqual({ ok: false, reason: 'unsupported' })
    expect(bare.requests('capture.video.start')).toEqual([])
  })

  it('says permission when Screen Recording is off, and ends a stream with it when it goes off', async () => {
    const denied = await setup({ FAKE_SCREEN_RECORDING: '0' })
    const answer = await denied.rpc.open({ threadId: 't1', maxEdge: 1280 }, denied.me)
    expect(answer.ok ? null : answer.reason).toBe('permission')
    const ending = await setup({ FAKE_VIDEO_END_MS: '120', FAKE_VIDEO_END_REASON: 'permission' })
    await ending.rpc.open({ threadId: 't1', maxEdge: 1280 }, ending.me)
    const viewer = ending.join()
    await until(() => viewer.closed !== null)
    expect(viewer.closed).toEqual({ code: VIDEO_CLOSE.permission, reason: 'permission' })
  })

  it('ends with ended when the window closes, and when the session is gone', async () => {
    const closing = await setup({ FAKE_VIDEO_END_MS: '120', FAKE_VIDEO_END_REASON: 'window-closed' })
    await closing.rpc.open({ threadId: 't1', maxEdge: 1280 }, closing.me)
    const viewer = closing.join()
    await until(() => viewer.closed !== null)
    expect(viewer.closed).toEqual({ code: VIDEO_CLOSE.ended, reason: 'ended' })
    const r = await setup()
    await r.rpc.open({ threadId: 't1', maxEdge: 1280 }, r.me)
    const second = r.join()
    await until(() => second.frames.length > 0)
    await r.h.sessions.stop('t1')
    await until(() => second.closed !== null)
    expect(second.closed).toEqual({ code: VIDEO_CLOSE.ended, reason: 'ended' })
  })

  it('refuses a viewer elsewhere: a person’s windows go to this machine’s own desktop, whatever the switch says', async () => {
    const r = await setup()
    const far = { principal: phone, connection: {}, connectionId: '2' }
    expect(await r.rpc.open({ threadId: 't1', maxEdge: 1280 }, far)).toEqual({ ok: false, reason: 'off' })
    r.state.remote = true
    // with the switch on they go out through the host that publishes them, never straight to a key
    expect(await r.rpc.open({ threadId: 't1', maxEdge: 1280 }, far)).toEqual({ ok: false, reason: 'unsupported' })
    expect(r.requests('capture.video.start')).toEqual([])
  })

  it('rings the agent’s click on the socket that asked, under the viewer’s own stream id', async () => {
    const r = await setup()
    const answer = await r.rpc.open({ threadId: 't1', maxEdge: 1280 }, r.me)
    if (!answer.ok) throw new Error()
    // what the feed hears from the service, said by hand: the fake's first video stream is its number 1
    const heard: ((n: ComputerNotification) => void)[] = []
    const subscribe = r.h.service.onNotification.bind(r.h.service)
    vi.spyOn(r.h.service, 'onNotification').mockImplementation((fn) => (heard.push(fn), subscribe(fn)))
    r.join()
    const say = (n: ComputerNotification): void => heard.forEach((fn) => fn(n))
    say({ method: 'capture/click', params: { stream: '1', at: [10, 20], width: 640, height: 400 } })
    say({ method: 'capture/click', params: { stream: 'pv_9', at: [1, 1], width: 10, height: 10 } })
    expect(r.pushes).toEqual([{ push: 'computer-click', preview: answer.stream, at: [10, 20], width: 640, height: 400 }])
  })

  it('follows the session to another window under the same socket: a new stream at the service, a new generation that starts with a keyframe', async () => {
    const r = await setup()
    await r.rpc.open({ threadId: 't1', maxEdge: 1280 }, r.me)
    const viewer = r.join()
    await until(() => viewer.frames.length >= 3)
    // the thread reads another app
    await r.h.run('computer_act', { app: 'Thin', action: 'left_click', coordinate: [640, 536] })
    await until(() => viewer.frames.some((f) => f.generation === 2))
    expect(r.requests('capture.video.start')).toHaveLength(2)
    expect(r.requests('capture.video.stop')).toHaveLength(1)
    expect(viewer.closed).toBeNull()
    const second = viewer.frames.filter((f) => f.generation === 2)
    expect(second[0]).toMatchObject({ sequence: 1, keyframe: true })
    // generations only rise, whatever the service numbers its own, and the new one's acks reach its stream
    expect(viewer.frames.map((f) => f.generation)).toEqual([...viewer.frames.map((f) => f.generation)].sort((a, b) => a - b))
    await until(() => viewer.frames.filter((f) => f.generation === 2).length > 10)
    // an ack of the window it left is owed to nobody: it breaks nothing
    viewer.ack({ generation: 1, sequence: 2 })
    await sleep(50)
    expect(viewer.closed).toBeNull()
  })
})
