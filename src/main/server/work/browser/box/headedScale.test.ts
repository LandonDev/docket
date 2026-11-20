import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import type { PassThrough } from 'node:stream'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { COMPUTER_PROTOCOL, resultFrameSchema, type ComputerMethod, type ComputerResult } from '@shared/computer/protocol'
import { Cdp } from './cdp'
import { findChromium } from './chromium'
import { BoxEngines, engineScreenshot } from './engine'
import { BoxComputerService, inProcessSpawn } from './service'
import { serveTestSite, type TestSite } from './testSite'
import { pixelAt, pngPixels, testBrowser, testVideoTools, type TestBrowser } from './testTools'

/**
 * The box's browser headed on a display of more pixels than the page has
 * (docs/agents/live-video.md "The box"): the real Chromium drawing at the
 * display's scale, the real X server, window manager and engine. The page
 * still lays out at 1280×800; the window manager still finds each window the
 * stage places; the engine's picture is the display's own pixels; and the
 * agent's pictures stay in the page's units.
 */
const bin = findChromium()
const tools = testVideoTools()
const d = bin && tools ? describe : describe.skip

/** A JPEG's width and height, from its frame header. */
const jpegSize = (jpeg: Buffer): [number, number] => {
  for (let at = 2; at < jpeg.length; at += 2 + jpeg.readUInt16BE(at + 2)) if (jpeg[at + 1] === 0xc0 || jpeg[at + 1] === 0xc2) return [jpeg.readUInt16BE(at + 7), jpeg.readUInt16BE(at + 5)]
  return [0, 0]
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const COLOURS = { red: '200,30,30', blue: '30,60,200', mark: '255,0,255' }
const flat = (colour: string, title: string): string =>
  `<!doctype html><title>${title}</title><body style="margin:0;background:rgb(${colour})"><div style="position:fixed;right:0;bottom:0;width:16px;height:16px;background:rgb(${COLOURS.mark})"></div>`

d.each([
  [2, 2560, 1600],
  [1.5, 1920, 1200]
])('the box browser headed at scale %s', (scale, width, height) => {
  let root: string
  let rig: TestBrowser
  let site: TestSite
  let cdp: Cdp
  let engines: BoxEngines
  let child: { stdin: PassThrough; stdout: PassThrough; kill(): boolean }
  const logs: string[] = []
  const answers = new Map<number, (f: { result?: unknown; error?: unknown }) => void>()
  const frames: { width: number; height: number; data: string }[] = []
  let next = 0

  const ok = async <M extends ComputerMethod>(method: M, params: Record<string, unknown> = {}): Promise<ComputerResult<M>> => {
    const id = ++next
    const f = await new Promise<{ result?: unknown; error?: unknown }>((r) => {
      answers.set(id, r)
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
    expect(f.error, JSON.stringify(f.error)).toBeUndefined()
    return (resultFrameSchema(method).parse({ jsonrpc: '2.0', id, ...f }) as { result: ComputerResult<M> }).result
  }
  const seen = async () => {
    const lease = (await engines.lease())!
    try {
      return pngPixels(await engineScreenshot(lease))
    } finally {
      lease.release()
    }
  }
  const attach = async (targetId: string): Promise<string> => (await cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true })).sessionId
  const evaluate = async <T>(sid: string, expression: string): Promise<T> => (await cdp.send<{ result: { value: T } }>('Runtime.evaluate', { expression, returnByValue: true }, sid)).result.value

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'tc-box-scale-'))
    site = await serveTestSite({ '/red': flat(COLOURS.red, 'red'), '/blue': flat(COLOURS.blue, 'blue') })
    rig = testBrowser(root, bin!, { headed: true, scale, log: (l) => logs.push(l) })
    cdp = await Cdp.open(await rig.browser.endpoint())
    await rig.stage.ready()
    engines = new BoxEngines({ root, tools: () => rig.browser.tools, display: () => rig.browser.display })
    child = inProcessSpawn(() => new BoxComputerService({ browser: rig.link }))('box', ['serve']) as never
    createInterface({ input: child.stdout }).on('line', (line) => {
      const f = JSON.parse(line) as { id?: number; method?: string; params?: { width: number; height: number; data: string } }
      if (f.method === 'capture/frame') frames.push(f.params!)
      else if (!f.method && f.id !== undefined) answers.get(f.id)?.(f)
    })
  }, 60_000)

  afterAll(async () => {
    child?.kill()
    cdp?.close()
    await engines?.stopAll()
    await rig?.browser.stop()
    await site?.close()
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  })

  it(`runs the display at ${width}×${height} and the page at 1280×800, the window manager finding the window the stage made`, async () => {
    expect(readFileSync(`/proc/${rig.browser.pid!}/cmdline`, 'utf8').split(/[\0 ]/)).toContain(`--force-device-scale-factor=${scale}`)
    expect(rig.browser.wm!.screen).toEqual({ width, height })
    const target = await rig.stage.open(`${site.url}/red`)
    await rig.stage.watch(target)
    expect(logs.filter((l) => /no window/.test(l))).toEqual([])
    const sid = await attach(target)
    for (let i = 0; i < 40 && (await evaluate(sid, 'innerHeight')) !== 800; i++) await sleep(50)
    expect(await evaluate(sid, '[innerWidth, innerHeight, devicePixelRatio].join()')).toBe(`1280,800,${scale}`)
    // the window he watches is in front of the curtain, and it is the screen
    const [front] = await rig.browser.wm!.shown()
    expect(front).toBeDefined()
    await sleep(500)
    const engine = await seen()
    expect([engine.width, engine.height]).toEqual([width, height])
    expect(pixelAt(engine, width / 2, 10)).toBe(COLOURS.red)
    expect(pixelAt(engine, width - 5, height - 5)).toBe(COLOURS.mark)
  }, 60_000)

  it('finds a window that is already on the display too: the watched page’s popup comes up over it', async () => {
    const watched = rig.stage.watching!
    const sid = await attach(watched)
    await cdp.send('Runtime.evaluate', { expression: `window.open(${JSON.stringify(`${site.url}/blue`)}, '_blank', 'popup,width=400,height=300')`, userGesture: true }, sid)
    await sleep(1_500)
    expect(logs.filter((l) => /no window/.test(l))).toEqual([])
    const now = await seen()
    expect(pixelAt(now, width / 2, height / 2)).toBe(COLOURS.blue)
    expect(pixelAt(now, width - 5, height - 5)).toBe(COLOURS.mark)
    const { targetInfos } = await cdp.send<{ targetInfos: { targetId: string; type: string; openerId?: string }[] }>('Target.getTargets')
    for (const t of targetInfos.filter((t) => t.openerId === watched)) await cdp.send('Target.closeTarget', { targetId: t.targetId })
  }, 60_000)

  it(`answers the agent in the page’s units: the display is 1280×800 at scale ${scale}, and a picture is no larger than the page`, async () => {
    const init = await ok('initialize', { protocol: COMPUTER_PROTOCOL, client: { name: 'test', version: '0' }, dataDir: join(root, 'svc') })
    expect(init.displays).toEqual([{ id: 1, frame: { x: 0, y: 0, w: 1280, h: 800 }, scale }])
    await ok('session.open', { session: 's1' })
    const whole = await ok('capture.screenshot', { session: 's1', app: { app: 'Chromium' }, format: 'png' })
    expect([whole.width, whole.height]).toEqual([1280, 800])
    const file = pngPixels(readFileSync(whole.path))
    expect([file.width, file.height]).toEqual([1280, 800])
    const small = await ok('capture.screenshot', { session: 's1', app: { app: 'Chromium' }, format: 'png', maxEdge: 640 })
    expect([small.width, small.height]).toEqual([640, 400])
    expect(pngPixels(readFileSync(small.path)).width).toBe(640)
  }, 60_000)

  it('answers the 4 fps picture’s size in the frames’ own pixels', async () => {
    const edge = Math.min(1600, width)
    const started = await ok('capture.stream.start', { session: 's1', app: { app: 'Chromium' }, stream: 'pv_1', fps: 4, maxEdge: edge })
    expect([started.width, started.height]).toEqual([edge, (edge * 800) / 1280])
    for (let i = 0; i < 50 && !frames.length; i++) await sleep(100)
    expect([frames[0]!.width, frames[0]!.height]).toEqual([started.width, started.height])
    expect(jpegSize(Buffer.from(frames[0]!.data, 'base64'))).toEqual([started.width, started.height])
    await ok('capture.stream.stop', { stream: 'pv_1' })
  }, 30_000)
})
