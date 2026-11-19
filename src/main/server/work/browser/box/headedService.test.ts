import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ComputerClickPush, ComputerFramePush, ComputerPreviewPush } from '@shared/contract-computer'
import type { SessionMeta } from '@shared/events'
import { ComputerPreviews } from '../../../computer/preview'
import { ComputerService } from '../../../computer/service'
import { ComputerSessions } from '../../../computer/sessions'
import { findChromium } from './chromium'
import { BoxEngines, engineScreenshot } from './engine'
import { BoxComputerService, inProcessSpawn } from './service'
import { serveTestSite, type TestSite } from './testSite'
import { pixelAt, pngPixels, testBrowser, testVideoTools, type TestBrowser } from './testTools'

/**
 * Two threads on the headed browser, through the box's own computer
 * sessions: while he watches one thread's page, everything another thread
 * does to its own page (open it, read it, picture it, act on it, stream it)
 * leaves the watched page on top of the display.
 */
const bin = findChromium()
const tools = testVideoTools()
const d = bin && tools ? describe : describe.skip

const COLOURS = { red: '200,30,30', green: '30,160,60' }
const flat = (colour: string, title: string): string =>
  `<!doctype html><title>${title}</title><body style="margin:0;background:rgb(${colour})"><form action="/done"><label for="n">Name</label><input id="n" name="n"><button type="button" onclick="document.title='pressed'">Press</button></form>`

d('the box browser headed, driven by two threads', () => {
  let root: string
  let rig: TestBrowser
  let site: TestSite
  let sessions: ComputerSessions
  let service: ComputerService
  let engines: BoxEngines
  /** the page each service session last used, as the service says it */
  const pages = new Map<string, string>()

  const run = (threadId: string, tool: string, args: Record<string, unknown>) => sessions.run({ threadId, permission: () => 'auto' }, tool, args)
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  const seen = async () => {
    const lease = (await engines.lease())!
    try {
      return pngPixels(await engineScreenshot(lease))
    } finally {
      lease.release()
    }
  }

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'tc-box-two-'))
    rig = testBrowser(root, bin!, { headed: true })
    await rig.browser.endpoint()
    site = await serveTestSite({ '/red': flat(COLOURS.red, 'red'), '/green': flat(COLOURS.green, 'green'), '/done': '<title>done</title>' })
    service = new ComputerService({
      dataDir: join(root, 'computer'),
      bin: () => 'box-browser',
      spawn: inProcessSpawn(() => new BoxComputerService({ browser: rig.link, onPage: (session, targetId) => void pages.set(session, targetId) }))
    })
    sessions = new ComputerSessions({
      service,
      registry: { get: (id) => ({ id, permission: 'auto', scope: 'work' }) as unknown as SessionMeta, requestApproval: async () => true, awayOn: () => false },
      store: { getSetting: () => null, setSetting: () => {} } as never,
      dataDir: join(root, 'computer'),
      landing: (id) => join(root, 'landing', id),
      log: () => {}
    })
    engines = new BoxEngines({ root, tools: () => rig.browser.tools, display: () => rig.browser.display })
  }, 60_000)

  afterAll(async () => {
    await engines?.stopAll()
    await rig?.browser.stop()
    await site?.close()
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  })

  it('the service says which page each thread uses, and the first is shown when it is watched', async () => {
    expect(rig.stage.headed()).toBe(true)
    await run('w1', 'computer_apps', { launch: 'Chromium', open: [`${site.url}/red`] })
    await run('w1', 'computer_observe', { app: 'Chromium' })
    expect(pages.get('w1')).toBeTruthy()
    await rig.stage.watch(pages.get('w1')!)
    await sleep(300)
    expect(pixelAt(await seen(), 640, 400)).toBe(COLOURS.red)
  }, 60_000)

  it('another thread opens, reads, pictures and acts on its own page, and the watched page stays on top', async () => {
    const opened = await run('w2', 'computer_apps', { launch: 'Chromium', open: [`${site.url}/green`] })
    expect(opened.isError).toBe(false)
    expect(pixelAt(await seen(), 640, 400)).toBe(COLOURS.red)
    // a read with its picture: the capture of a covered page comes, and raises nothing
    const read = await run('w2', 'computer_observe', { app: 'Chromium', window: 'green', screenshot: true })
    expect(read.isError, read.body).toBe(false)
    expect(read.body).toContain('window "green"')
    expect(read.shots.length).toBeGreaterThan(0)
    expect(pages.get('w2')).toBeTruthy()
    expect(pages.get('w2')).not.toBe(pages.get('w1'))
    expect(pixelAt(await seen(), 640, 400)).toBe(COLOURS.red)
    // acts: text into a field and a press, on the page under the watched one
    const typed = await run('w2', 'computer_batch', {
      app: 'Chromium',
      window: 'green',
      actions: [
        { action: 'left_click', named: 'Name' },
        { action: 'type', text: 'covered' },
        { action: 'left_click', named: 'Press' }
      ]
    })
    expect(typed.isError, typed.body).toBe(false)
    expect(typed.body).toContain('"covered"')
    expect(typed.body).toContain('window "pressed"')
    expect(pixelAt(await seen(), 640, 400)).toBe(COLOURS.red)
    expect(rig.stage.watching).toBe(pages.get('w1'))
  }, 60_000)

  it('the 4 fps picture of the covered page still comes: it is what a second page shows when the display is taken', async () => {
    const pushes: (ComputerFramePush | ComputerClickPush | ComputerPreviewPush)[] = []
    const viewer = { connection: {}, send: (p: ComputerFramePush | ComputerClickPush | ComputerPreviewPush) => void pushes.push(p) }
    const previews = new ComputerPreviews({ service, sessions })
    const started = await previews.start(viewer, { threadId: 'w2', maxEdge: 640 })
    expect(started).toMatchObject({ app: 'Chromium', window: 'pressed' })
    for (let i = 0; i < 100 && !pushes.some((p) => p.push === 'computer-frame'); i++) await sleep(100)
    const frame = pushes.find((p): p is ComputerFramePush => p.push === 'computer-frame')!
    expect(Buffer.from(frame.data, 'base64').subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]))
    expect(pixelAt(await seen(), 640, 400)).toBe(COLOURS.red)
    await previews.close()
  }, 60_000)

  it('while he drives the watched page, a read of the other still leaves his on top, toolbar and all', async () => {
    await rig.stage.drive(pages.get('w1')!)
    await sleep(600)
    const read = await run('w2', 'computer_observe', { app: 'Chromium', window: 'pressed', screenshot: true })
    expect(read.isError, read.body).toBe(false)
    const now = await seen()
    expect(pixelAt(now, 640, 400)).toBe(COLOURS.red)
    expect(pixelAt(now, 640, 5)).not.toBe(COLOURS.red)
    await rig.stage.drive(null)
  }, 60_000)
})
