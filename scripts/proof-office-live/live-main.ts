/**
 * The live tab proof's Electron main (scripts/e2e-office-live.ts bundles and runs it under xvfb). The real fence
 * (src/main/officeLive.ts) on a window whose page runs the real LiveLayer (live-harness.ts), his Microsoft cookies set
 * into the tenant's session before any guest attaches. Input reaches Word only over the GUEST's DevTools, here in the
 * proof; nothing of the app types into a live view.
 */
import { app, BrowserWindow, session, type WebContents } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { attachLiveFence, registerOfficeLive } from '../../src/main/officeLive'

const dir = process.env.PROOF_DIR!
const out = process.env.PROOF_OUT!
const docUrl = process.env.PROOF_URL!
const seenUrl = process.env.PROOF_SEEN!
const result: Record<string, unknown> = { steps: [] as string[] }
const step = (s: string): void => {
  ;(result.steps as string[]).push(`${new Date().toISOString()} ${s}`)
  console.log(`[live-main] ${s}`)
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
let finished = false
const finish = (): void => {
  if (finished) return
  finished = true
  writeFileSync(out, JSON.stringify(result, null, 2))
  for (const w of BrowserWindow.getAllWindows()) w.destroy()
  app.exit(0)
}
setTimeout(() => {
  result.timedOut = true
  finish()
}, 420_000).unref()

interface CdpCookie {
  name: string
  value: string
  domain: string
  path: string
  expires: number
  httpOnly: boolean
  secure: boolean
  session: boolean
  sameSite?: 'Strict' | 'Lax' | 'None'
}

/** His exported cookies into the tenant's session, as the trial set them: host-only with no domain, `__Host-` bare. */
async function setCookies(partition: string): Promise<{ set: number; failed: number }> {
  const cookies = JSON.parse(readFileSync(join(dir, 'cookies.json'), 'utf8')) as CdpCookie[]
  const ses = session.fromPartition(partition)
  let set = 0
  let failed = 0
  for (const c of cookies) {
    const host = c.domain.replace(/^\./, '')
    const sameSite = c.sameSite === 'Strict' ? 'strict' : c.sameSite === 'Lax' ? 'lax' : c.sameSite === 'None' ? 'no_restriction' : 'unspecified'
    try {
      await ses.cookies.set({
        url: `https://${host}${c.path || '/'}`,
        name: c.name,
        value: c.value,
        ...(c.domain.startsWith('.') && !c.name.startsWith('__Host-') ? { domain: c.domain } : {}),
        path: c.path || '/',
        secure: c.secure,
        httpOnly: c.httpOnly,
        sameSite,
        ...(c.session || c.expires <= 0 ? {} : { expirationDate: c.expires })
      })
      set++
    } catch {
      failed++
    }
  }
  return { set, failed }
}

async function waitFor<T>(what: string, ms: number, probe: () => Promise<T | null | undefined | false> | T | null | undefined | false, every = 500): Promise<T | null> {
  const until = Date.now() + ms
  while (Date.now() < until) {
    const v = await Promise.resolve(probe()).catch(() => null)
    if (v) return v as T
    await sleep(every)
  }
  step(`timed out: ${what}`)
  return null
}

app.whenReady().then(async () => {
  registerOfficeLive()
  result.cookies = await setCookies('persist:office-live-purdue0')
  step(`cookies set ${JSON.stringify(result.cookies)}`)

  const win = new BrowserWindow({ width: 1400, height: 960, show: true, webPreferences: { preload: join(dir, 'preload.js'), sandbox: false, contextIsolation: true, webviewTag: true } })
  attachLiveFence(win)
  let guest: WebContents | null = null
  let topNavs = 0
  let startLoads = 0
  let inputs = 0
  const subNavs: string[] = []
  win.webContents.on('did-attach-webview', (_e, g) => {
    guest = g
    result.attached = ((result.attached as number) ?? 0) + 1
    g.on('did-start-loading', () => startLoads++)
    g.on('did-start-navigation', (_ev, url, isInPlace, isMainFrame) => {
      if (isMainFrame && !isInPlace) topNavs++
      else if (!isInPlace) subNavs.push(new URL(url).host || url.slice(0, 20))
    })
    g.on('before-input-event', () => inputs++)
  })
  const page = <T>(js: string): Promise<T> => win.webContents.executeJavaScript(js, true)

  writeFileSync(
    join(dir, 'page.html'),
    `<!doctype html><html><body style="margin:0;font:13px sans-serif;background:#1d1d1f;color:#ddd">
<div style="height:40px;display:flex;gap:16px;align-items:center;padding:0 12px">Tab strip: dummy · other</div>
<div id="body1" style="position:absolute;left:0;top:40px;width:1400px;height:880px"></div>
<div id="body2" hidden style="position:absolute;left:0;top:40px;width:1400px;height:880px">The other tab</div>
<div id="dialog" hidden style="position:fixed;left:400px;top:280px;width:600px;height:400px;z-index:90;background:#333">A dialog</div>
<div id="menu" hidden style="position:fixed;left:600px;top:380px;width:200px;height:200px;z-index:95;background:#444">A menu</div>
<script src="harness.js"></script></body></html>`
  )
  await win.loadFile(join(dir, 'page.html'))

  // 1. The dummy's tab: the guest over the body, through the real layer and the real ticket.
  await page(`__h.show(${JSON.stringify(docUrl)})`)
  step('shown')
  const t0 = Date.now()
  const ready = await waitFor('layer ready', 90_000, () => page<string>(`__h.state().stage`).then((s) => s === 'ready'), 250)
  result.readyMs = ready ? Date.now() - t0 : null
  result.stages = await page('__h.stages')
  result.stateAtReady = await page('__h.state()')
  step(`layer ${JSON.stringify(result.stages)} in ${result.readyMs} ms`)
  if (!guest) {
    step('no guest attached')
    return finish()
  }
  const g = guest as WebContents
  result.guestUrl = g.getURL()
  result.signIn = /login\.microsoftonline\.com|login\.live\.com/.test(g.getURL())

  // Word's editor frame, and the dummy's first line drawn in it.
  const editorFrame = (): Electron.WebFrameMain | undefined => g.mainFrame.framesInSubtree.find((f) => /wordeditorframe/i.test(f.url))
  const firstLine = await waitFor('Word drew the dummy', 90_000, async () => {
    const f = editorFrame()
    if (!f) return null
    return f.executeJavaScript(`(() => {
      const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
      for (let n = w.nextNode(); n; n = w.nextNode()) if (n.nodeValue.includes('TempCode proof dummy')) {
        const r = document.createRange(); r.selectNodeContents(n); const b = r.getBoundingClientRect()
        if (b.width > 0) return { x: b.right, y: b.top + b.height / 2 }
      }
      return null
    })()`) as Promise<{ x: number; y: number } | null>
  }, 1000)
  result.editorUp = !!editorFrame()
  result.wordReadyMs = firstLine ? Date.now() - t0 : null
  result.title = g.getTitle()
  step(`Word ${firstLine ? 'drew the dummy' : 'did not draw'} at ${result.wordReadyMs} ms, title ${JSON.stringify(result.title)}`)
  if (!firstLine) {
    result.editorText = await editorFrame()?.executeJavaScript('document.body.innerText.slice(0, 200)').catch(() => null)
    return finish()
  }
  result.editing = await editorFrame()!
    .executeJavaScript(`/Editing/.test(document.body.innerText) || !!document.querySelector('[contenteditable="true"]')`)
    .catch(() => null)

  // 2. Type a line over the guest's DevTools: click at the end of the first line, End, Enter, the line.
  const frameBox = (await g.executeJavaScript(`(() => {
    const f = [...document.querySelectorAll('iframe')].find((x) => /wordeditorframe/i.test(x.src) || x.name === 'WebApplicationFrame')
    if (!f) return null
    const b = f.getBoundingClientRect(); return { x: b.x + f.clientLeft, y: b.y + f.clientTop }
  })()`)) as { x: number; y: number } | null
  result.frameBox = frameBox
  const line = `TempCode proof line ${Date.now().toString(36)}`
  result.line = line
  await page('__h.focus()')
  g.focus()
  g.debugger.attach('1.3')
  const cdp = (method: string, params: Record<string, unknown> = {}): Promise<any> => g.debugger.sendCommand(method, params)
  // Word's editor fills the guest (the page's lookup finds no iframe of its own to offset by).
  const offset = frameBox ?? { x: 0, y: 0 }
  const at = { x: (offset?.x ?? 0) + firstLine.x - 2, y: (offset?.y ?? 0) + firstLine.y }
  // As a real key arrives: a raw key-down (what main's before-input-event hears), its char, the key-up.
  const key = async (k: string, code: string, vk: number, text?: string): Promise<void> => {
    await cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: k, code, windowsVirtualKeyCode: vk })
    if (text) await cdp('Input.dispatchKeyEvent', { type: 'char', key: k, code, windowsVirtualKeyCode: vk, text, unmodifiedText: text })
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk })
  }
  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y: at.y })
  await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: at.x, y: at.y, button: 'left', clickCount: 1 })
  await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: at.x, y: at.y, button: 'left', clickCount: 1 })
  await sleep(800)
  await key('End', 'End', 35)
  await key('Enter', 'Enter', 13, '\r')
  await cdp('Input.insertText', { text: line })
  result.inputsHeard = inputs
  step(`typed ${line} at ${JSON.stringify(at)}; main heard ${inputs} key events`)
  const inElectron = await waitFor('the line in our guest', 10_000, () => editorFrame()?.executeJavaScript(`document.body.innerText.includes(${JSON.stringify(line)})`))
  result.lineInGuest = !!inElectron
  const t1 = Date.now()
  const seen = await waitFor('the line in Chromium', 20_000, () => fetch(`${seenUrl}?text=${encodeURIComponent(line)}`).then((r) => r.json() as Promise<{ seen: boolean }>).then((j) => j.seen), 1000)
  result.coauthorMs = seen ? Date.now() - t1 : null
  step(`Chromium ${seen ? 'saw' : 'did not see'} the line (${result.coauthorMs} ms)`)
  g.debugger.detach()
  // DevTools input never passes main's before-input-event. One key the way the OS's keys arrive,
  // through Electron's input path, which is what the typed count is for.
  result.inputsByDevtools = inputs
  for (const type of ['keyDown', 'char', 'keyUp'] as const) g.sendInputEvent({ type, keyCode: '!' })
  await sleep(1500)
  result.inputsAfterOsPath = inputs
  result.osKeyInWord = await editorFrame()?.executeJavaScript(`document.body.innerText.includes(${JSON.stringify(line + '!')})`).catch(() => null)
  step(`main heard ${inputs} key events after one key by sendInputEvent (landed in Word: ${result.osKeyInWord})`)

  // The picture: the window, cropped to the guest, with the dummy and the typed line.
  const box = (await page('__h.guest()')) as { rect: { x: number; y: number; width: number; height: number } } | null
  if (box) {
    const rect = { x: Math.round(box.rect.x), y: Math.round(box.rect.y), width: Math.round(box.rect.width), height: Math.round(box.rect.height) }
    let img = await win.capturePage(rect)
    const bmp = img.toBitmap()
    let distinct = new Set<number>()
    for (let i = 0; i < bmp.length && distinct.size < 50; i += 4 * 997) distinct.add(bmp.readUInt32LE(i))
    result.windowPictureColours = distinct.size
    if (distinct.size < 5) {
      img = await g.capturePage()
      result.pictureFrom = 'guest'
    } else result.pictureFrom = 'window'
    writeFileSync(join(dir, 'live-word.png'), img.toPNG())
  }

  // 3. A dialog and a menu draw above the guest.
  result.over = await page('__h.over()')
  step(`over ${JSON.stringify(result.over)}`)

  // 4. Another tab, then back: the same guest, no reload.
  // First the same 6 s with no switch: what Word loads on its own.
  const idle0 = { startLoads, subNavs: subNavs.length }
  await sleep(6000)
  result.idleBaseline = { startLoads: startLoads - idle0.startLoads, subFrames: subNavs.slice(idle0.subNavs) }
  // A mark in the page and in Word's editor: a reload of either would wipe it.
  const mark = `tc-${Date.now()}`
  await g.executeJavaScript(`window.__tcMark = ${JSON.stringify(mark)}`)
  await editorFrame()?.executeJavaScript(`window.__tcMark = ${JSON.stringify(mark)}`)
  const marks = async (): Promise<{ top: unknown; editor: unknown }> => ({
    top: await g.executeJavaScript('window.__tcMark').catch(() => null),
    editor: await editorFrame()?.executeJavaScript('window.__tcMark').catch(() => null)
  })
  const subAt = subNavs.length
  const before = { id: g.id, topNavs, startLoads, layerId: ((await page('__h.guest()')) as { id: number }).id }
  await page('__h.other()')
  await sleep(3000)
  const hidden = (await page('__h.guest()')) as { visibility: string }
  await page(`__h.show(${JSON.stringify(docUrl)})`)
  await sleep(3000)
  const after = { id: g.id, destroyed: g.isDestroyed(), topNavs, startLoads, layerId: ((await page('__h.guest()')) as { id: number }).id, visibility: ((await page('__h.guest()')) as { visibility: string }).visibility }
  result.tabSwitch = { before, hiddenVisibility: hidden.visibility, after, marks: await marks(), mark, subFrames: subNavs.slice(subAt) }
  step(`tab switch ${JSON.stringify(result.tabSwitch)}`)

  // 5. The typed count, then leave.
  result.typed = await page('__h.typed()')
  const gone = new Promise<boolean>((r) => {
    if (g.isDestroyed()) return r(true)
    g.once('destroyed', () => r(true))
    setTimeout(() => r(false), 30_000)
  })
  result.leave = await page('__h.leave()')
  result.guestDestroyed = await gone
  step(`typed ${result.typed}, leave ${JSON.stringify(result.leave)}, destroyed ${result.guestDestroyed}`)
  finish()
})
