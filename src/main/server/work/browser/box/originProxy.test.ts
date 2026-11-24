import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { WebSocketServer } from 'ws'
import { TEMPCODE_ORIGIN_REFUSAL, type TempCodeOrigins } from '../../../remote/tempcodeOrigins'
import { ComputerService } from '../../../computer/service'
import { Cdp } from './cdp'
import { BoxChromium, findChromium } from './chromium'
import { BoxComputerService, inProcessSpawn } from './service'
import { serveTestSite } from './testSite'
import { testVideoTools } from './testTools'

const bin = findChromium()
const tools = testVideoTools()

it.each(['headless', 'headed'] as const)(
  'fences browser traffic in %s Chromium',
  async (mode) => {
    if (!bin || process.platform !== 'linux' || (mode === 'headed' && !tools)) return
    const root = mkdtempSync(join(tmpdir(), 'tc-browser-origins-'))
    const forbidden: string[] = []
    const protectedHost = createServer((req, res) => {
      forbidden.push(req.url!)
      res.writeHead(200, {
        'Set-Cookie': 'tc_session=paired-test; Path=/; HttpOnly',
        'Content-Type': 'text/html'
      })
      res.end('<title>Owner page</title><button>Approve</button>')
    })
    protectedHost.on('upgrade', (req, socket) => {
      forbidden.push(req.url!)
      socket.destroy()
    })
    await new Promise<void>((resolve) => protectedHost.listen(0, '127.0.0.1', resolve))
    const port = (protectedHost.address() as { port: number }).port
    const blocked = `http://127.0.0.1:${port}`
    const linked = await serveTestSite({ '/ui': '<title>Linked host</title>' })
    // This allowed fixture has a redirect into the protected host.
    const redirects = createServer((_req, res) =>
      res.writeHead(302, { Location: `${blocked}/ui` }).end()
    )
    const allowedWs = new WebSocketServer({ noServer: true, clientTracking: false })
    redirects.on('upgrade', (request, socket, head) => {
      allowedWs.handleUpgrade(request, socket, head, (ws) => ws.close())
    })
    await new Promise<void>((resolve) => redirects.listen(0, '127.0.0.1', resolve))
    const redirect = `http://127.0.0.1:${(redirects.address() as { port: number }).port}/hop`
    const site = await serveTestSite({ '/': '<title>Ordinary site</title><h1>Ordinary site</h1>' })
    const origins: TempCodeOrigins = {
      listenerPorts: [],
      lanAddresses: ['127.0.0.1'],
      remoteRoutes: [linked.url]
    }
    const browser = new BoxChromium({
      root,
      bin: () => bin,
      origins: () => origins,
      video: () => (mode === 'headed' ? tools : null)
    })
    const service = new ComputerService({
      bin: () => 'box-browser',
      dataDir: join(root, 'computer'),
      spawn: inProcessSpawn(
        () =>
          new BoxComputerService({
            origins: () => origins,
            refusedRequests: () => browser.refusedRequests,
            refreshOriginFence: () => browser.refreshOriginFence(),
            browser: {
              endpoint: () => browser.endpoint(),
              pid: () => browser.pid,
              touch: () => browser.touch(),
              headed: () => mode === 'headed'
            }
          })
      )
    })
    const target = { session: 'test', app: { app: 'Chromium' } }

    let cdp: Cdp | undefined
    try {
      cdp = await Cdp.open(await browser.endpoint())
      expect(browser.display !== null).toBe(mode === 'headed')
      await service.request('session.open', { session: target.session })

      // Establish a pre-existing paired tab with an explicitly open policy, then apply the fence.
      const { targetId: ownerTab } = await cdp.send<{ targetId: string }>('Target.createTarget', {
        url: 'about:blank'
      })
      const { sessionId: ownerSession } = await cdp.send<{ sessionId: string }>(
        'Target.attachToTarget',
        { targetId: ownerTab, flatten: true }
      )
      await cdp.send('Page.navigate', { url: `${blocked}/ui` }, ownerSession)
      await expect.poll(() => forbidden.slice()).toContain('/ui')
      await expect
        .poll(async () =>
          (await cdp!.send<{ cookies: { name: string }[] }>('Storage.getCookies')).cookies.map(
            (cookie) => cookie.name
          )
        )
        .toContain('tc_session')
      origins.listenerPorts = [port]
      await expect(
        service.request('state.get', { ...target, window: { title: 'Owner page' } })
      ).rejects.toThrow(TEMPCODE_ORIGIN_REFUSAL)
      await cdp.send('Target.closeTarget', { targetId: ownerTab })
      forbidden.length = 0

      const launch = (url: string) =>
        service.request('apps.launch', { app: 'Chromium', session: target.session, open: [url] })
      await expect(launch(`${blocked}/ui`)).rejects.toThrow(TEMPCODE_ORIGIN_REFUSAL)
      await expect(launch(redirect)).rejects.toThrow(TEMPCODE_ORIGIN_REFUSAL)
      await expect(launch(`${linked.url}/ui`)).rejects.toThrow(TEMPCODE_ORIGIN_REFUSAL)

      const { window } = await launch(site.url)
      expect(window).toBeDefined()
      const observation = await service.request('state.get', {
        ...target,
        window: { id: window!.id },
        screenshot: 'never'
      })
      expect(observation.text).toContain('Ordinary site')
      const { targetInfos } = await cdp.send<{ targetInfos: { targetId: string; url: string }[] }>(
        'Target.getTargets'
      )
      const ordinaryTab = targetInfos.find((tab) => tab.url === `${site.url}/`)!
      const { sessionId } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', {
        targetId: ordinaryTab.targetId,
        flatten: true
      })
      const networkRefusal = async (send: () => Promise<unknown>): Promise<void> => {
        const before = browser.refusedRequests
        await send()
        await expect.poll(() => browser.refusedRequests, { timeout: 3000 }).toBeGreaterThan(before)
        expect(forbidden).toEqual([])
      }
      const evaluate = (expression: string) =>
        cdp!.send('Runtime.evaluate', { expression, userGesture: true }, sessionId)
      const openSocket = await cdp.send<{ result: { value?: boolean } }>(
        'Runtime.evaluate',
        {
          expression: `new Promise(resolve => { const ws = new WebSocket("${redirect.replace('http:', 'ws:')}"); ws.onopen = () => resolve(true); ws.onerror = () => resolve(false) })`,
          awaitPromise: true,
          returnByValue: true
        },
        sessionId
      )
      expect(openSocket.result.value).toBe(true)
      await networkRefusal(() =>
        evaluate(
          `document.body.append(Object.assign(document.createElement('iframe'), {src: "${blocked}/frame"}))`
        )
      )
      await networkRefusal(() => evaluate(`window.open("${blocked}/popup")`))
      await networkRefusal(() =>
        evaluate(`window.fixtureSocket = new WebSocket("ws://127.0.0.1:${port}/ws")`)
      )
      await networkRefusal(() => cdp!.send('Page.navigate', { url: `${linked.url}/ui` }, sessionId))
      await networkRefusal(() => cdp!.send('Page.navigate', { url: `${blocked}/ui` }, sessionId))
      expect(linked.asked).not.toContain('/ui')

      // A browser running outside this proxy can still reach the owner listener.
      expect(
        await (
          await fetch(`${blocked}/ui`, { headers: { Cookie: 'tc_session=paired-test' } })
        ).text()
      ).toContain('Approve')
    } finally {
      cdp?.close()
      await service.close()
      await browser.stop()
      allowedWs.close()
      await Promise.all([
        site.close(),
        linked.close(),
        new Promise<void>((done) => protectedHost.close(() => done())),
        new Promise<void>((done) => redirects.close(() => done()))
      ])
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    }
  },
  25_000
)
