import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Cdp } from './cdp'
import { HEADED_BLOCKED, findChromium } from './chromium'
import { BoxEngines, engineScreenshot } from './engine'
import { serveTestSite, type TestSite } from './testSite'
import { pixelAt, pixelsApart, pngPixels, testBrowser, testVideoTools, type TestBrowser } from './testTools'
import { XClient, pageWindows } from './xclient'

/**
 * The box's browser headed on its private display, with the real Chromium,
 * the real X server and the real engine: what he is shown is the page alone,
 * at the display's own size, and only the page that is watched.
 */
const bin = findChromium()
const tools = testVideoTools()
const d = bin && tools ? describe : describe.skip

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
/** A page of one flat colour with a mark in its far corner, so a picture that is cut short or shifted shows. */
const flat = (colour: string, title: string): string =>
  `<!doctype html><title>${title}</title><body style="margin:0;background:${colour}"><input id=i><div style="position:fixed;right:0;bottom:0;width:16px;height:16px;background:rgb(255,0,255)"></div>`
const COLOURS = { red: '200,30,30', green: '30,160,60', blue: '30,60,200', mark: '255,0,255' }
let site: TestSite
const page = (name: 'red' | 'green' | 'blue'): string => `${site.url}/${name}`

d('the box browser, headed', () => {
  let root: string
  let rig: TestBrowser
  let cdp: Cdp
  let engines: BoxEngines
  const serverDisplay = process.env.DISPLAY

  /** What the engine sees of the display now. */
  const seen = async () => {
    const lease = (await engines.lease())!
    try {
      return pngPixels(await engineScreenshot(lease))
    } finally {
      lease.release()
    }
  }
  const attach = async (targetId: string): Promise<string> => (await cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true })).sessionId
  const evaluate = async <T>(sid: string, expression: string): Promise<T> =>
    (await cdp.send<{ result: { value: T } }>('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sid)).result.value

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'tc-box-headed-'))
    site = await serveTestSite({ '/red': flat(`rgb(${COLOURS.red})`, 'red'), '/green': flat(`rgb(${COLOURS.green})`, 'green'), '/blue': flat(`rgb(${COLOURS.blue})`, 'blue') })
    // the host's own server runs under a display of its own: the browser must not end up on it
    process.env.DISPLAY = ':99'
    rig = testBrowser(root, bin!, { headed: true })
    cdp = await Cdp.open(await rig.browser.endpoint())
    await rig.stage.ready()
    engines = new BoxEngines({ root, tools: () => rig.browser.tools, display: () => rig.browser.display })
  }, 60_000)

  afterAll(async () => {
    if (serverDisplay === undefined) delete process.env.DISPLAY
    else process.env.DISPLAY = serverDisplay
    cdp?.close()
    await engines?.stopAll()
    await rig?.browser.stop()
    await site?.close()
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  })

  it('runs on its own display and none of the host’s, with a covered window still painting and no test bar', () => {
    const display = rig.browser.display!
    expect(display.DISPLAY).toMatch(/^:\d+$/)
    expect(display.DISPLAY).not.toBe(':99')
    // (what it was handed is chromium.test.ts's to prove: Chromium writes over its own environment once it runs)
    const args = readFileSync(`/proc/${rig.browser.pid!}/cmdline`, 'utf8').split(/[\0 ]/)
    expect(args.some((a) => a.startsWith('--headless'))).toBe(false)
    expect(args).toContain('--disable-backgrounding-occluded-windows')
    expect(args).toContain('--hide-crash-restore-bubble')
    expect(args.some((a) => /no-sandbox/.test(a))).toBe(false)
  })

  it('shows a page alone at the display’s own size: its viewport reads 1280×800, and the engine’s picture is the page’s own', async () => {
    const target = await rig.stage.open(page('red'))
    const sid = await attach(target)
    await rig.stage.watch(target)
    const m = await cdp.send<{ cssVisualViewport: { clientWidth: number; clientHeight: number } }>('Page.getLayoutMetrics', {}, sid)
    expect([m.cssVisualViewport.clientWidth, m.cssVisualViewport.clientHeight]).toEqual([1280, 800])
    expect(await evaluate(sid, '[innerWidth, innerHeight, outerWidth, outerHeight, screenX, screenY].join()')).toBe('1280,800,1280,800,0,0')
    // every window of a page is the screen's size, at its corner
    const x = await XClient.open(rig.browser.display!)
    const windows = pageWindows(await x.windows(), { width: x.width, height: x.height })
    expect([x.width, x.height]).toEqual([1280, 800])
    x.close()
    expect(windows.length).toBeGreaterThan(0)
    for (const w of windows) expect([w.x, w.y, w.width, w.height]).toEqual([0, 0, 1280, 800])
    // the notice that says how to leave full screen goes after a few seconds
    await sleep(4_500)
    const engine = await seen()
    expect([engine.width, engine.height]).toEqual([1280, 800])
    const { data } = await cdp.send<{ data: string }>('Page.captureScreenshot', { format: 'png' }, sid)
    const own = pngPixels(Buffer.from(data, 'base64'))
    expect([own.width, own.height]).toEqual([1280, 800])
    // no tab strip, no address bar, no bar of any kind: the two pictures are one
    expect(pixelsApart(engine, own)).toBeLessThan(0.002)
    expect(pixelAt(engine, 640, 5)).toBe(COLOURS.red)
    expect(pixelAt(engine, 1275, 795)).toBe(COLOURS.mark)
  }, 60_000)

  it('puts a new page under the one he watches, and keeps it there while it is acted on through DevTools', async () => {
    const watched = rig.stage.watching!
    const other = await rig.stage.open(page('green'))
    const sid = await attach(other)
    await sleep(300)
    expect(pixelAt(await seen(), 640, 400)).toBe(COLOURS.red)
    // the covered page is whole and still paints: it has the screen's size, a capture of it comes, and keys land in it
    expect(await evaluate(sid, '[innerWidth, innerHeight].join()')).toBe('1280,800')
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }, sid)
    await evaluate(sid, 'document.getElementById("i").focus()')
    for (const type of ['keyDown', 'keyUp']) await cdp.send('Input.dispatchKeyEvent', { type, key: 'k', code: 'KeyK', windowsVirtualKeyCode: 75, ...(type === 'keyDown' ? { text: 'k' } : {}) }, sid)
    expect(await evaluate(sid, 'document.getElementById("i").value')).toBe('k')
    const { data } = await cdp.send<{ data: string }>('Page.captureScreenshot', { format: 'png' }, sid)
    expect(pixelAt(pngPixels(Buffer.from(data, 'base64')), 640, 400)).toBe(COLOURS.green)
    expect(await evaluate<number>(sid, 'new Promise((r) => { let n = 0; const t = performance.now(); (function f() { n++; performance.now() - t < 500 ? requestAnimationFrame(f) : r(n) })() })')).toBeGreaterThan(30)
    // and through all of it the display still shows the page he watches
    expect(pixelAt(await seen(), 640, 400)).toBe(COLOURS.red)
    expect(rig.stage.watching).toBe(watched)
    // watching the other raises it
    await rig.stage.watch(other)
    await sleep(300)
    expect(pixelAt(await seen(), 640, 400)).toBe(COLOURS.green)
    await rig.stage.watch(watched)
    await sleep(300)
    expect(pixelAt(await seen(), 640, 400)).toBe(COLOURS.red)
  }, 60_000)

  it('puts a window a page opens back under the watched one, unless the watched page opened it', async () => {
    const watched = rig.stage.watching!
    const { targetInfos } = await cdp.send<{ targetInfos: { targetId: string; type: string; title: string }[] }>('Target.getTargets')
    const green = targetInfos.find((t) => t.type === 'page' && t.title === 'green')!.targetId
    const greenSid = await attach(green)
    // another page's popup: a window of its own, which lands on top and is put back under
    await cdp.send('Runtime.evaluate', { expression: `window.open(${JSON.stringify(page('blue'))}, '_blank', 'popup,width=400,height=300')`, userGesture: true }, greenSid)
    await sleep(1_200)
    expect(pixelAt(await seen(), 640, 400)).toBe(COLOURS.red)
    // the watched page's own popup is part of what he watches: it stays on top, full screen like the rest
    const watchedSid = await attach(watched)
    await cdp.send('Runtime.evaluate', { expression: `window.open(${JSON.stringify(page('blue'))}, '_blank', 'popup,width=400,height=300')`, userGesture: true }, watchedSid)
    await sleep(1_200)
    const now = await seen()
    expect(pixelAt(now, 640, 400)).toBe(COLOURS.blue)
    expect(pixelAt(now, 1275, 795)).toBe(COLOURS.mark)
    await rig.stage.watch(watched)
    await sleep(300)
    expect(pixelAt(await seen(), 640, 400)).toBe(COLOURS.red)
  }, 60_000)

  it('keeps the carrier’s page off the screen and unraised, and it still runs there', async () => {
    const carrier = await rig.stage.open(page('blue'), 'carrier')
    const sid = await attach(carrier)
    await sleep(500)
    expect(pixelAt(await seen(), 640, 400)).toBe(COLOURS.red)
    expect(Number(await evaluate(sid, 'screenX'))).toBeGreaterThanOrEqual(1280)
    // it loads, runs script, fetches and paints where nobody sees it
    expect(await evaluate(sid, 'document.title')).toBe('blue')
    expect(await evaluate(sid, 'fetch("data:text/plain,ok").then((r) => r.text())')).toBe('ok')
    expect(await evaluate<number>(sid, 'new Promise((r) => { let n = 0; const t = performance.now(); (function f() { n++; performance.now() - t < 500 ? requestAnimationFrame(f) : r(n) })() })')).toBeGreaterThan(30)
    // a new page after it still lands under the watched one, and the carrier stays where it is
    await rig.stage.open(page('green'))
    await sleep(300)
    expect(pixelAt(await seen(), 640, 400)).toBe(COLOURS.red)
    expect(Number(await evaluate(sid, 'screenX'))).toBeGreaterThanOrEqual(1280)
  }, 60_000)

  it('shows the browser’s own toolbar while he drives, and the page alone again when he hands back', async () => {
    const watched = rig.stage.watching!
    const sid = await attach(watched)
    await rig.stage.drive(watched)
    await sleep(600)
    const driving = await seen()
    // the toolbar takes the top of the picture; the page is shorter and still as wide
    expect(pixelAt(driving, 640, 5)).not.toBe(COLOURS.red)
    expect(pixelAt(driving, 640, 400)).toBe(COLOURS.red)
    const [w, h] = (await evaluate<string>(sid, '[innerWidth, innerHeight].join()')).split(',').map(Number)
    expect(w).toBe(1280)
    expect(h).toBeGreaterThan(680)
    expect(h).toBeLessThan(760)
    await rig.stage.drive(null)
    await sleep(600)
    expect(await evaluate(sid, '[innerWidth, innerHeight].join()')).toBe('1280,800')
    await sleep(4_500)
    const back = await seen()
    expect(pixelAt(back, 640, 5)).toBe(COLOURS.red)
    expect(pixelAt(back, 1275, 795)).toBe(COLOURS.mark)
  }, 60_000)

  it('says so when the watched page goes to an address that is closed to agents', async () => {
    const watched = rig.stage.watching!
    const closed: string[] = []
    const off = rig.stage.onClosedHost((id) => closed.push(id))
    const sid = await attach(watched)
    // the address alone decides: nothing has to load from it
    await cdp.send('Page.navigate', { url: 'https://outlook.office.com/mail/' }, sid).catch(() => {})
    for (let i = 0; i < 100 && !closed.length; i++) await sleep(50)
    off()
    expect(closed).toEqual([watched])
    await cdp.send('Page.navigate', { url: page('red') }, sid)
  }, 60_000)

  it('saves no password, fills none, refuses every prompt, and keeps downloads in its own folder: read back from the running browser', async () => {
    const target = await rig.stage.open('chrome://prefs-internals/')
    const sid = await attach(target)
    let prefs: Record<string, unknown> | null = null
    for (let i = 0; i < 50 && !prefs; i++) {
      await sleep(100)
      prefs = await evaluate<Record<string, unknown> | null>(sid, '(() => { try { return JSON.parse(document.body.innerText) } catch { return null } })()')
    }
    // the page lists each preference as its value beside where it came from
    const at = (path: string): unknown => {
      const found = path.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], prefs)
      return found && typeof found === 'object' && 'value' in found ? (found as { value: unknown }).value : found
    }
    const read = Object.fromEntries(
      ['credentials_enable_service', 'credentials_enable_autosignin', 'profile.password_manager_leak_detection', 'autofill.profile_enabled', 'autofill.credit_card_enabled', 'signin.allowed', 'translate.enabled', 'download.prompt_for_download', 'download.default_directory', ...HEADED_BLOCKED.map((n) => `profile.default_content_setting_values.${n}`)].map((path) => [path, at(path)])
    )
    expect(read).toEqual({
      credentials_enable_service: false,
      credentials_enable_autosignin: false,
      'profile.password_manager_leak_detection': false,
      'autofill.profile_enabled': false,
      'autofill.credit_card_enabled': false,
      'signin.allowed': false,
      'translate.enabled': false,
      'download.prompt_for_download': false,
      'download.default_directory': join(root, 'downloads'),
      ...Object.fromEntries(HEADED_BLOCKED.map((n) => [`profile.default_content_setting_values.${n}`, 2]))
    })
    await cdp.send('Target.closeTarget', { targetId: target })
  }, 60_000)

  it('asks nothing and offers nothing when a page asks for a permission or a file', async () => {
    const watched = rig.stage.watching!
    const sid = await attach(watched)
    await cdp.send('Page.navigate', { url: page('red') }, sid)
    await sleep(300)
    // a permission is refused at once, with no prompt to wait on
    expect(await evaluate(sid, 'navigator.permissions.query({ name: "notifications" }).then((p) => p.state)')).toBe('denied')
    expect(await evaluate(sid, 'navigator.permissions.query({ name: "geolocation" }).then((p) => p.state)')).toBe('denied')
    // a file chooser is handed to DevTools and never drawn
    await cdp.send('Page.enable', {}, sid)
    await cdp.send('Page.setInterceptFileChooserDialog', { enabled: true }, sid)
    const opened = new Promise<boolean>((resolve) => {
      const offEvent = cdp.on('Page.fileChooserOpened', () => (offEvent(), resolve(true)))
      setTimeout(() => resolve(false), 3_000)
    })
    await cdp.send('Runtime.evaluate', { expression: 'const f = document.createElement("input"); f.type = "file"; document.body.append(f); f.click()', userGesture: true }, sid)
    expect(await opened).toBe(true)
    const x = await XClient.open(rig.browser.display!)
    const dialogs = (await x.windows()).filter((w) => w.viewable && !w.overrideRedirect && (w.width !== 1280 || w.height !== 800) && w.x < 1280 && w.width > 100)
    x.close()
    expect(dialogs).toEqual([])
  }, 60_000)

  it('stops its display with it', async () => {
    const display = rig.browser.display!
    const cookie = display.XAUTHORITY
    cdp.close()
    await engines.stopAll()
    await rig.browser.stop()
    expect(rig.browser.display).toBeNull()
    expect(() => readFileSync(cookie)).toThrow()
    await expect(XClient.open(display, 500)).rejects.toThrow()
  }, 30_000)
})

d('the box browser, with the tools there but the setting off', () => {
  it('starts headless exactly as before', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tc-box-headless-'))
    const rig = testBrowser(root, bin!, { headed: false })
    try {
      await rig.browser.endpoint()
      expect(rig.browser.display).toBeNull()
      expect(rig.stage.headed()).toBe(false)
      const args = readFileSync(`/proc/${rig.browser.pid}/cmdline`, 'utf8').split(/[\0 ]/)
      expect(args).toContain('--headless=new')
      expect(args).not.toContain('--disable-backgrounding-occluded-windows')
      // a page is a plain tab
      const cdp = await Cdp.open(await rig.browser.endpoint())
      const target = await rig.stage.open('about:blank')
      const { targetInfos } = await cdp.send<{ targetInfos: { targetId: string }[] }>('Target.getTargets')
      expect(targetInfos.some((t) => t.targetId === target)).toBe(true)
      cdp.close()
    } finally {
      await rig.browser.stop()
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    }
  }, 60_000)
})
