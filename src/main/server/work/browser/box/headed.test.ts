import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Cdp } from './cdp'
import { HEADED_BLOCKED, findChromium } from './chromium'
import { BoxEngines, engineScreenshot } from './engine'
import { serveTestSite, type TestSite } from './testSite'
import { pixelAt, pixelsApart, pngPixels, testBrowser, testVideoTools, type TestBrowser } from './testTools'
import { XClient } from './xclient'
import { BoxWindowManager } from './xwm'

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
  `<!doctype html><title>${title}</title><body style="margin:0;background:${colour}"><input id=i><select id=s style="position:fixed;left:100px;top:300px;width:200px;height:30px"><option>one<option>two<option>three</select><div style="position:fixed;right:0;bottom:0;width:16px;height:16px;background:rgb(255,0,255)"></div>`
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

  it('has one window manager, and an engine that answers nobody without its token', async () => {
    // the display asks one client about its windows: a second cannot take that place
    await expect(BoxWindowManager.start(rig.browser.display!)).rejects.toThrow('another client manages the display')
    const lease = (await engines.lease())!
    try {
      for (const headers of [undefined, { Authorization: `Bearer ${'0'.repeat(64)}` }]) expect((await fetch(`http://127.0.0.1:${lease.port}/screenshot.png`, { headers })).status).toBe(401)
      const refused = await new Promise<boolean>((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${lease.port}/stream?view=1`, ['nsl1'])
        ws.addEventListener('open', () => resolve(false))
        ws.addEventListener('error', () => resolve(true))
        ws.addEventListener('close', () => resolve(true))
      })
      expect(refused).toBe(true)
    } finally {
      lease.release()
    }
  }, 30_000)

  it('shows a page alone at the display’s own size: its viewport reads 1280×800, and the engine’s picture is the page’s own', async () => {
    const target = await rig.stage.open(page('red'))
    const sid = await attach(target)
    await rig.stage.watch(target)
    // the browser lays the page out again a moment after its window is full screen
    for (let i = 0; i < 40 && (await evaluate(sid, 'innerHeight')) !== 800; i++) await sleep(50)
    const m = await cdp.send<{ cssVisualViewport: { clientWidth: number; clientHeight: number } }>('Page.getLayoutMetrics', {}, sid)
    expect([m.cssVisualViewport.clientWidth, m.cssVisualViewport.clientHeight]).toEqual([1280, 800])
    expect(await evaluate(sid, '[innerWidth, innerHeight, outerWidth, outerHeight, screenX, screenY].join()')).toBe('1280,800,1280,800,0,0')
    // every window of a page is the screen's size, at its corner
    const x = await XClient.open(rig.browser.display!)
    const windows = (await x.windows()).filter((w) => w.viewable && !w.overrideRedirect && w.width > 1)
    expect([x.width, x.height]).toEqual([1280, 800])
    x.close()
    expect(windows.length).toBeGreaterThan(0)
    for (const w of windows) expect([w.x, w.y, w.width, w.height]).toEqual([0, 0, 1280, 800])
    // the browser's notice of how to leave full screen is behind the curtain from the start: it is not his to act on
    await sleep(500)
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
    // nor does the new page's full-screen notice show over him
    expect(pixelAt(await seen(), 640, 70)).toBe(COLOURS.red)
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
    const openedBy = async (opener: string): Promise<string[]> =>
      (await cdp.send<{ targetInfos: { targetId: string; type: string; openerId?: string }[] }>('Target.getTargets')).targetInfos.filter((t) => t.type === 'page' && t.openerId === opener).map((t) => t.targetId)
    for (const id of await openedBy(green)) await cdp.send('Target.closeTarget', { targetId: id })
    // the watched page's own popup is part of what he watches: it stays on top, full screen like the rest
    const watchedSid = await attach(watched)
    await cdp.send('Runtime.evaluate', { expression: `window.open(${JSON.stringify(page('blue'))}, '_blank', 'popup,width=400,height=300')`, userGesture: true }, watchedSid)
    await sleep(1_200)
    const now = await seen()
    expect(pixelAt(now, 640, 400)).toBe(COLOURS.blue)
    expect(pixelAt(now, 1275, 795)).toBe(COLOURS.mark)
    // it is over that page whenever that page is watched: another page watched in between does not lose it
    await rig.stage.watch(green)
    await sleep(300)
    expect(pixelAt(await seen(), 640, 400)).toBe(COLOURS.green)
    await rig.stage.watch(watched)
    await sleep(300)
    expect(pixelAt(await seen(), 640, 400)).toBe(COLOURS.blue)
    // until it closes
    for (const id of await openedBy(watched)) await cdp.send('Target.closeTarget', { targetId: id })
    await sleep(500)
    expect(pixelAt(await seen(), 640, 400)).toBe(COLOURS.red)
    // a window that may not reach back to the page that opened it is still that page's: the browser says who opened it
    await cdp.send('Runtime.evaluate', { expression: `window.open(${JSON.stringify(page('blue'))}, '_blank', 'noopener,popup,width=400,height=300')`, userGesture: true }, greenSid)
    await sleep(1_200)
    expect(pixelAt(await seen(), 640, 400)).toBe(COLOURS.red)
    expect((await openedBy(green)).length).toBe(1)
    for (const id of await openedBy(green)) await cdp.send('Target.closeTarget', { targetId: id })
  }, 60_000)

  it('keeps the keyboard with the watched page, whatever opens, is clicked through DevTools or asks to come forward', async () => {
    const wm = rig.browser.wm!
    const watched = rig.stage.watching!
    const holder = await wm.focused()
    const top = (await wm.shown()).at(-1)
    expect(holder).toBe(top)
    const { targetInfos } = await cdp.send<{ targetInfos: { targetId: string; type: string; title: string }[] }>('Target.getTargets')
    const green = targetInfos.find((t) => t.type === 'page' && t.title === 'green')!.targetId
    const sid = await attach(green)
    // an agent's click, as its tools send it
    for (const type of ['mousePressed', 'mouseReleased']) await cdp.send('Input.dispatchMouseEvent', { type, x: 300, y: 300, button: 'left', clickCount: 1 }, sid)
    // the browser's own ask to bring a page forward
    await cdp.send('Target.activateTarget', { targetId: green })
    await cdp.send('Page.bringToFront', {}, sid)
    const fresh = await rig.stage.open(page('blue'))
    await sleep(500)
    expect(await wm.focused()).toBe(holder)
    expect((await wm.shown()).at(-1)).toBe(top)
    expect(pixelAt(await seen(), 640, 400)).toBe(COLOURS.red)
    // the keyboard goes with the watched page
    await rig.stage.watch(green)
    const moved = await wm.focused()
    expect(moved).not.toBe(holder)
    expect((await wm.shown()).at(-1)).toBe(moved)
    await rig.stage.watch(watched)
    expect(await wm.focused()).toBe(holder)
    await cdp.send('Target.closeTarget', { targetId: fresh })
  }, 60_000)

  it('puts a menu behind the curtain unless he drives and his input came just before it', async () => {
    const wm = rig.browser.wm!
    const watched = rig.stage.watching!
    const { targetInfos } = await cdp.send<{ targetInfos: { targetId: string; type: string; title: string }[] }>('Target.getTargets')
    const green = targetInfos.find((t) => t.type === 'page' && t.title === 'green')!.targetId
    const front = await wm.shown(false)
    expect(front.length).toBe(1)
    const press = async (targetId: string, key?: string): Promise<void> => {
      const sid = await attach(targetId)
      if (key) for (const type of ['keyDown', 'keyUp']) await cdp.send('Input.dispatchKeyEvent', { type, key, code: key, windowsVirtualKeyCode: 27 }, sid)
      else for (const type of ['mousePressed', 'mouseReleased']) await cdp.send('Input.dispatchMouseEvent', { type, x: 150, y: 315, button: 'left', clickCount: 1 }, sid)
      await sleep(600)
    }
    // an agent opens a list on a page under the curtain, then on the page he watches: the list is drawn over neither
    for (const target of [green, watched]) {
      await press(target)
      expect(await wm.shown(false), target === green ? 'another page' : 'the watched page').toEqual(front)
      expect(pixelAt(await seen(), 150, 350)).toBe(COLOURS.red)
      await press(target, 'Escape')
    }
    // he drives, and a list opens with no input of his before it: still another page's, for all the display knows
    await rig.stage.drive(watched)
    await sleep(600)
    await press(green)
    expect(await wm.shown(false)).toEqual(front)
    await press(green, 'Escape')
    // his own click, then the list it opened
    rig.stage.touched()
    await press(watched)
    expect((await wm.shown(false)).length).toBe(2)
    expect(pixelAt(await seen(), 150, 480)).not.toBe(COLOURS.red)
    await press(watched, 'Escape')
    await rig.stage.drive(null)
    await sleep(600)
    expect(await wm.shown(false)).toEqual(front)
  }, 60_000)

  it('never shows the carrier’s page, and it still runs behind the curtain', async () => {
    const wm = rig.browser.wm!
    const before = await wm.shown()
    const carrier = await rig.stage.open(page('blue'), 'carrier')
    const sid = await attach(carrier)
    await sleep(500)
    expect(pixelAt(await seen(), 640, 400)).toBe(COLOURS.red)
    expect(await wm.shown()).toEqual(before)
    expect(rig.stage.knows(carrier)).toBe(false)
    // it loads, runs script, fetches and paints where nobody sees it
    expect(await evaluate(sid, 'document.title')).toBe('blue')
    expect(await evaluate(sid, 'fetch("data:text/plain,ok").then((r) => r.text())')).toBe('ok')
    expect(await evaluate<number>(sid, 'new Promise((r) => { let n = 0; const t = performance.now(); (function f() { n++; performance.now() - t < 500 ? requestAnimationFrame(f) : r(n) })() })')).toBeGreaterThan(30)
    // its own ask to come forward is refused like any other
    await cdp.send('Target.activateTarget', { targetId: carrier })
    await sleep(300)
    expect(pixelAt(await seen(), 640, 400)).toBe(COLOURS.red)
    expect(await wm.shown()).toEqual(before)
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
    const back = await seen()
    expect(pixelAt(back, 640, 5)).toBe(COLOURS.red)
    expect(pixelAt(back, 1275, 795)).toBe(COLOURS.mark)
  }, 60_000)

  it('says so when the watched page goes to an address that is closed to agents', async () => {
    const watched = rig.stage.watching!
    const closed: string[] = []
    const off = rig.stage.onEnd((id) => closed.push(id))
    const sid = await attach(watched)
    // the address alone decides: nothing has to load from it
    await cdp.send('Page.navigate', { url: 'https://outlook.office.com/mail/' }, sid).catch(() => {})
    for (let i = 0; i < 100 && !closed.length; i++) await sleep(50)
    off()
    expect(closed).toEqual([watched])
    await cdp.send('Page.navigate', { url: page('red') }, sid)
  }, 60_000)

  it('shows the curtain, and ends what he is shown, when the watched page closes', async () => {
    const wm = rig.browser.wm!
    const kept = rig.stage.watching!
    const doomed = await rig.stage.open(page('green'))
    await rig.stage.watch(doomed)
    await sleep(300)
    expect(pixelAt(await seen(), 640, 400)).toBe(COLOURS.green)
    const ended: string[] = []
    const off = rig.stage.onEnd((id) => ended.push(id))
    await cdp.send('Target.closeTarget', { targetId: doomed })
    for (let i = 0; i < 100 && !ended.length; i++) await sleep(50)
    off()
    expect(ended).toEqual([doomed])
    expect(rig.stage.watching).toBeNull()
    // every other page is still behind the curtain: he is shown none of them
    expect(await wm.shown(false)).toEqual([])
    expect(pixelAt(await seen(), 640, 400)).toBe('0,0,0')
    await rig.stage.watch(kept)
    await sleep(300)
    expect(pixelAt(await seen(), 640, 400)).toBe(COLOURS.red)
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
