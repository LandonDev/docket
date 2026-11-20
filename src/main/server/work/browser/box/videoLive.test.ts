import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { LOCAL_PRINCIPAL } from '@shared/capabilities'
import { VIDEO_CLOSE, type VideoOpenAnswer } from '@shared/contract-video'
import type { SessionMeta } from '@shared/events'
import { encodeAck, encodeInput, h264Codec, parseFrame, type Frame, type InputEvent } from '@shared/video/nsl1'
import type { StreamClaim } from '../../../remote/auth'
import { VideoRelay, type ViewerSocket } from '../../../video/relay'
import { VideoRpc } from '../../../video/rpc'
import type { WorkCtx } from '../../modules'
import { DriveStore, ensureBrowserTables } from '../drive'
import { Cdp } from './cdp'
import { findChromium } from './chromium'
import { boxDriveChanged, setBoxBrowser, startBoxBrowser, wireBoxBrowser, type BoxBrowserHost } from './index'
import { serveTestSite, type TestSite } from './testSite'
import { testVideoTools } from './testTools'

/**
 * Live video of the box's browser, whole: the host's own wiring
 * (`wireBoxBrowser`), the real Chromium on the real display, real engines,
 * the relay and the RPC. A viewer here is the relay's end of a socket: it
 * gets frames, acks each, and sends what a driver's viewer sends.
 */
const bin = findChromium()
const tools = testVideoTools()
const d = bin && tools ? describe : describe.skip

/** A viewer: every frame acked as it comes, as one that draws at once would. */
class Viewer implements ViewerSocket {
  bufferedAmount = 0
  readonly frames: Frame[] = []
  closed: { code: number; reason: string } | null = null
  private say: ((data: Buffer, isBinary: boolean) => void) | null = null
  private readonly closers: (() => void)[] = []
  send(bytes: Uint8Array): void {
    const frame = parseFrame(bytes)
    this.frames.push({ ...frame, data: frame.data.slice() })
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
  /** his input, numbered as the newest frame's connection */
  input(event: InputEvent): void {
    this.say?.(Buffer.from(encodeInput(event, this.frames.at(-1)!.generation)), true)
  }
  leave(): void {
    this.close(1000, '')
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const until = async (what: () => boolean, ms = 8_000): Promise<void> => {
  const end = Date.now() + ms
  while (!what()) {
    if (Date.now() > end) throw new Error('timed out')
    await sleep(20)
  }
}
/** A page that repaints every frame, with a field that takes the keyboard. */
const moving = (title: string): string =>
  `<!doctype html><title>${title}</title><body style="margin:0"><input id="i" autofocus style="font:20px monospace;width:600px"><div id="b" style="height:700px"></div><script>let n=0;(function f(){n++;document.getElementById('b').style.background='hsl('+(n%360)+' 80% 50%)';requestAnimationFrame(f)})()</script>`
const still = (title: string): string => `<!doctype html><title>${title}</title><body style="margin:0;background:rgb(30,60,200)"><input id="i" autofocus>`

d('live video of the box browser, end to end', () => {
  let dataDir: string
  let host: BoxBrowserHost
  let site: TestSite
  let relay: VideoRelay
  let rpc: VideoRpc
  let db: DatabaseSync
  let stopWork: () => void
  let cdp: Cdp
  const minted: StreamClaim[] = []
  const me = { principal: LOCAL_PRINCIPAL, connection: {}, connectionId: '1' }

  const run = (threadId: string, tool: string, args: Record<string, unknown>) => host.sessions.run({ threadId, permission: () => 'auto' }, tool, args)
  /** `video.open`, then the viewer's socket joins */
  const watch = async (threadId: string, more: { take?: boolean; drive?: boolean } = {}): Promise<{ answer: VideoOpenAnswer & { ok: true }; viewer: Viewer }> => {
    const answer = await rpc.open({ threadId, maxEdge: 1280, ...more }, me)
    if (!answer.ok) throw new Error(`video.open refused: ${answer.reason}`)
    const viewer = new Viewer()
    expect(relay.attach(minted.at(-1)!, viewer)).toBe(true)
    return { answer, viewer }
  }
  const pageValue = async (title: string): Promise<{ value: string; size: string }> => {
    const { targetInfos } = await cdp.send<{ targetInfos: { targetId: string; type: string; title: string }[] }>('Target.getTargets')
    const target = targetInfos.find((t) => t.type === 'page' && t.title === title)!
    const { sessionId } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId: target.targetId, flatten: true })
    const r = await cdp.send<{ result: { value: { value: string; size: string } } }>('Runtime.evaluate', { expression: '({ value: document.getElementById("i").value, size: innerWidth + "x" + innerHeight })', returnByValue: true }, sessionId)
    return r.result.value
  }

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'tc-box-video-'))
    // the installed tools, where the host looks for them: <userData>/work-tools
    symlinkSync(dirname(dirname(dirname(tools!.sys))), join(dataDir, 'work-tools'))
    mkdirSync(join(dataDir, 'attachments'), { recursive: true })
    site = await serveTestSite({ '/moving': moving('moving'), '/still': still('still') })
    relay = new VideoRelay()
    rpc = new VideoRpc(relay, { mintStreamTicket: (claim) => (minted.push(claim), { ticket: 't', expiresIn: 30 }) }, () => true)
    setBoxBrowser(null)
    host = wireBoxBrowser({
      registry: {
        get: (id: string) => ({ id, permission: 'auto', scope: 'work' }) as unknown as SessionMeta,
        requestApproval: async () => true,
        awayOn: () => false,
        rootSessionOf: (id: string) => (id === 'sub' ? 'w1' : id),
        onMeta: () => {},
        onRemoved: () => {}
      } as never,
      store: { getSetting: () => null, setSetting: () => {} } as never,
      dataDir,
      log: () => {},
      video: { relay, rpc }
    })!
    db = new DatabaseSync(':memory:')
    ensureBrowserTables(db)
    stopWork = startBoxBrowser({ db, held: { onDecided: () => () => {} } } as unknown as WorkCtx)
    await run('w1', 'computer_apps', { launch: 'Chromium', open: [`${site.url}/moving`] })
    await run('w1', 'computer_observe', { app: 'Chromium' })
    await run('w2', 'computer_apps', { launch: 'Chromium', open: [`${site.url}/still`] })
    await run('w2', 'computer_observe', { app: 'Chromium', window: 'still' })
    cdp = await Cdp.open(await host.browser.endpoint())
  }, 90_000)

  afterAll(async () => {
    cdp?.close()
    relay?.shutdown()
    stopWork?.()
    await host?.browser.stop()
    setBoxBrowser(null)
    await site?.close()
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  })

  it('runs headed, and plays the page a thread drives as H.264 at the display’s size, well past the old four frames a second', async () => {
    expect(host.browser.display).not.toBeNull()
    const { answer, viewer } = await watch('w1')
    expect(answer).toMatchObject({ width: 1280, height: 800, fps: 120 })
    await until(() => viewer.frames.length > 0)
    const first = viewer.frames[0]
    expect(first).toMatchObject({ sequence: 1, keyframe: true, width: 1280, height: 800 })
    // the stream Electron's decoder was proven on: constrained baseline H.264
    expect(h264Codec(first.data)).toMatch(/^avc1\.42/)
    const before = viewer.frames.length
    await sleep(1_500)
    const perSecond = (viewer.frames.length - before) / 1.5
    expect(perSecond).toBeGreaterThan(30)
    // in order, one connection, each stamped with when it was captured
    const sequences = viewer.frames.map((f) => f.sequence)
    expect(sequences).toEqual(sequences.map((_, i) => i + 1))
    expect(new Set(viewer.frames.map((f) => f.generation)).size).toBe(1)
    expect(viewer.frames.at(-1)!.timestamp).toBeGreaterThan(first.timestamp)
    // watched only: what a watcher's viewer sends as input goes nowhere
    viewer.input({ type: 'keyDown', key: 4 })
    viewer.input({ type: 'keyUp', key: 4 })
    await sleep(200)
    expect((await pageValue('moving')).value).toBe('')
    viewer.leave()
    await until(() => relay.list().length === 0)
  }, 60_000)

  it('a still page sends its first picture and then nothing', async () => {
    const { viewer } = await watch('w2', { take: true })
    await until(() => viewer.frames.length > 0)
    await sleep(1_000)
    const settled = viewer.frames.length
    await sleep(1_500)
    // a few frames sharpen a picture that came to rest; then silence
    expect(viewer.frames.length - settled).toBeLessThan(8)
    viewer.leave()
    await until(() => relay.list().length === 0)
  }, 60_000)

  it('shows one page at a time: the thread on screen takes the display, and the page that lost it closes with moved', async () => {
    const one = await watch('w1')
    await until(() => one.viewer.frames.length > 0)
    expect(await rpc.open({ threadId: 'w2', maxEdge: 1280 }, me)).toEqual({ ok: false, reason: 'busy' })
    const two = await watch('w2', { take: true })
    expect(one.viewer.closed).toEqual({ code: VIDEO_CLOSE.moved, reason: 'moved' })
    await until(() => two.viewer.frames.length > 0)
    // each viewer has an engine of its own, so the second starts with its own first frame
    expect(two.viewer.frames[0]).toMatchObject({ sequence: 1, keyframe: true })
    two.viewer.leave()
    await until(() => relay.list().length === 0)
  }, 60_000)

  it('lists a row for the page he took over, though its session was stopped, and streams it by the pane’s thread', async () => {
    expect(host.rows.rows().map((r) => r.threadId).sort()).toEqual(['w1', 'w2'])
    // he is watching the page when he takes over
    const watching = await watch('w1', { take: true })
    await until(() => watching.viewer.frames.length > 0)
    // Take over: the agent's sessions of the pane are stopped, then he is the driver
    expect(await host.rows.stop('w1')).toBe(true)
    new DriveStore(db).drive('w1', 'owner')
    boxDriveChanged('w1', true)
    await until(() => host.stage.driving !== null)
    // the stream he was watching goes on through it: its page outlives the session that used it
    expect(watching.viewer.closed).toBeNull()
    const before = watching.viewer.frames.length
    await until(() => watching.viewer.frames.length > before)
    watching.viewer.leave()
    const rows = host.rows.rows()
    expect(rows.find((r) => r.threadId === 'w1')).toMatchObject({ driver: 'owner', running: null, apps: [{ name: 'Chromium', bundleId: 'org.chromium.Chromium' }] })
    // nothing of his to stop: Hand back is how it ends
    expect(await host.rows.stop('w1')).toBe(false)
    // the page shows the browser's toolbar: shorter, as wide
    await sleep(600)
    expect((await pageValue('moving')).size).toMatch(/^1280x7[0-4]\d$/)
  }, 60_000)

  it('takes his pointer and keys on a drive stream, in the page he drives', async () => {
    // a subagent's thread names the same pane, and so the same page
    const { viewer } = await watch('sub', { drive: true, take: true })
    expect(relay.list()[0]).toMatchObject({ scope: 'drive', group: 'w1' })
    await until(() => viewer.frames.length > 0)
    // a click into the field (the toolbar is 87 of the 800 lines), then h, i by their usage codes
    const at = { x: 100 / 1280, y: (87 + 14) / 800 }
    viewer.input({ type: 'pointerMove', ...at })
    viewer.input({ type: 'buttonDown', button: 1, ...at })
    viewer.input({ type: 'buttonUp', button: 1, ...at })
    for (const key of [11, 12]) {
      viewer.input({ type: 'keyDown', key })
      viewer.input({ type: 'keyUp', key })
    }
    await until(() => false, 600).catch(() => {})
    expect((await pageValue('moving')).value).toBe('hi')
    // his paste goes through the display's clipboard
    await rpc.paste({ stream: relay.list()[0].id, text: ' there, ünïcode' }, me)
    await sleep(500)
    expect((await pageValue('moving')).value).toBe('hi there, ünïcode')
    // and a moment later the clipboard is empty: the same keys paste nothing
    await sleep(1_600)
    for (const [type, key] of [['keyDown', 224], ['keyDown', 25], ['keyUp', 25], ['keyUp', 224]] as const) viewer.input({ type, key })
    await sleep(400)
    expect((await pageValue('moving')).value).toBe('hi there, ünïcode')
    // another thread's page is still acted on by nobody's input, and no agent acts while he drives: that is the tools' own gate
    expect((await pageValue('still')).value).toBe('')

    // Hand back: the page is whole again, and his keys go nowhere though his socket is still open
    new DriveStore(db).drive('w1', 'agent')
    boxDriveChanged('w1', false)
    await until(() => host.stage.driving === null)
    await sleep(600)
    expect((await pageValue('moving')).size).toBe('1280x800')
    expect(relay.list()[0]).toMatchObject({ scope: 'watch' })
    viewer.input({ type: 'keyDown', key: 29 })
    viewer.input({ type: 'keyUp', key: 29 })
    await sleep(300)
    expect((await pageValue('moving')).value).toBe('hi there, ünïcode')
    expect(viewer.closed).toBeNull()
    expect(host.rows.rows().some((r) => r.driver === 'owner')).toBe(false)
    viewer.leave()
  }, 90_000)

  it('ends the stream when the browser stops, and has no page to show after', async () => {
    await run('w2', 'computer_observe', { app: 'Chromium', window: 'still' })
    const { viewer } = await watch('w2', { take: true })
    await until(() => viewer.frames.length > 0)
    cdp.close()
    await host.browser.stop()
    expect(viewer.closed).toEqual({ code: VIDEO_CLOSE.ended, reason: 'ended' })
    expect(await rpc.open({ threadId: 'w2', maxEdge: 1280 }, me)).toEqual({ ok: false, reason: 'unsupported' })
  }, 60_000)
})
