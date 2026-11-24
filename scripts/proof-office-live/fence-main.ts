/**
 * The fence proof's Electron main (scripts/proof-office-live-fence.ts bundles and runs it under xvfb). It is the real
 * fence (src/main/officeLive.ts) and the real Origin rule (src/main/server/originAllowed.ts) in real Chromium, with
 * a page of its own in the app's place and a loopback server in the local server's.
 */
import { app, BrowserWindow, type WebContents } from 'electron'
import { createServer } from 'node:http'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { attachLiveFence, registerOfficeLive } from '../../src/main/officeLive'
import { originAllowed } from '../../src/main/server/originAllowed'

const out = process.env.PROOF_OUT!
const dir = process.env.PROOF_DIR!
const result: Record<string, unknown> = { upgrades: [] as unknown[], attached: 0 }
const finish = (): void => {
  writeFileSync(out, JSON.stringify(result, null, 2))
  app.exit(0)
}
setTimeout(() => {
  result.timedOut = true
  finish()
}, 150_000).unref()

app.whenReady().then(async () => {
  const server = createServer((_req, res) => res.end('the local server answered'))
  server.on('upgrade', (req, socket) => {
    const ok = originAllowed(req.headers.origin, undefined)
    ;(result.upgrades as unknown[]).push({ origin: req.headers.origin ?? null, ok })
    socket.end(ok ? 'HTTP/1.1 101 Switching Protocols\r\n\r\n' : 'HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const port = (server.address() as { port: number }).port
  result.port = port
  registerOfficeLive()

  const win = new BrowserWindow({ width: 1200, height: 800, webPreferences: { preload: join(dir, 'preload.js'), sandbox: false, webviewTag: true } })
  attachLiveFence(win)
  win.webContents.on('did-attach-webview', (_e, g) => {
    result.attached = (result.attached as number) + 1
    g.once('dom-ready', () => void probe(g))
  })
  const probe = async (g: WebContents): Promise<void> => {
    await new Promise((r) => setTimeout(r, 3000))
    result.guestUrl = g.getURL()
    result.guestPartitionAgent = g.getUserAgent()
    result.inGuest = await g.executeJavaScript(`(async () => {
      const r = { api: typeof window.api, require: typeof require, process: typeof process, tcLive: typeof window.tcLive, electron: typeof window.electron }
      const tryFetch = async (u) => { try { await fetch(u); return 'reached' } catch (e) { return 'failed' } }
      r.fetchHttp = await tryFetch('http://127.0.0.1:${port}/')
      r.fetchHttps = await tryFetch('https://127.0.0.1:${port}/')
      r.fetchLocalhost = await tryFetch('https://localhost:${port}/')
      const trySocket = (u) => new Promise((res) => { try { const ws = new WebSocket(u); ws.onopen = () => res('open'); ws.onerror = () => res('failed') } catch (e) { res('threw') } setTimeout(() => res('no answer'), 5000) })
      r.ws = await trySocket('ws://127.0.0.1:${port}/ws')
      r.wss = await trySocket('wss://127.0.0.1:${port}/ws')
      return r
    })()`)
    // The outer page (a page of no app origin) tries the server: the Origin rule refuses it.
    result.outerSocket = await win.webContents.executeJavaScript(`new Promise((res) => { const ws = new WebSocket('ws://127.0.0.1:${port}/ws'); ws.onopen = () => res('open'); ws.onerror = () => res('refused'); setTimeout(() => res('no answer'), 5000) })`)
    result.page = await win.webContents.executeJavaScript('window.__proof')
    finish()
  }
  writeFileSync(join(dir, 'page.html'), `<!doctype html><body style="margin:0"><div id="a" style="height:780px"></div><script>
    window.__proof = {}
    ;(async () => {
      // A <webview> with no ticket: refused at attach.
      const bare = document.createElement('webview')
      bare.setAttribute('src', 'https://purdue0-my.sharepoint.com/')
      bare.setAttribute('partition', 'persist:office-live-purdue0')
      document.body.appendChild(bare)
      const t = await window.tcLive.ticket('https://purdue0-my.sharepoint.com/')
      window.__proof.ticket = t
      // One from an iframe in the page: refused before it is issued.
      const f = document.createElement('iframe'); f.srcdoc = '<p>frame</p>'; document.body.appendChild(f)
      await new Promise((r) => setTimeout(r, 1500))
      const w = document.createElement('webview')
      w.setAttribute('src', t.src); w.setAttribute('partition', t.partition); w.setAttribute('allowpopups', '')
      w.style.cssText = 'width:1180px;height:760px;display:inline-flex'
      document.getElementById('a').appendChild(w)
      w.addEventListener('did-navigate', (e) => { window.__proof.navigated = e.url })
    })()
  </script></body>`)
  await win.loadFile(join(dir, 'page.html'))
})
