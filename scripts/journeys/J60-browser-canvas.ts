import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BrowserState, BrowserVideo } from '../../src/shared/contract-work-browser'
import { BROWSER_PROMPT } from './lib/fakeProvider'
import { journey, step, type Context } from './lib/record'
import { createThread, hostRows, workTool } from './lib/thread'
import { json, shown } from './lib/tierThree'

const TITLE = 'Practice browser'
const VIEW = '[data-slot="browser-view"]'
type Visit = { id: string; pressed: string }
const visits = new WeakMap<Context, Visit>()

export function headedResult(log: string, tools: boolean): string | null {
  if (/box browser: started headed on /.test(log)) return null
  const failure = log.split('\n').find(line => line.includes('box browser: its display did not start'))
  return failure?.trim() ?? (tools ? 'The browser did not start on its private display' : 'The isolated box has no headed browser tools')
}

const browserState = ({ pair }: Context, sessionId: string) =>
  pair.rpc<BrowserState>(pair.box, 'work.browser.state', { sessionId })

export default journey({
  id: 'J60',
  title: 'Open the box browser beside a chat, take it over and hand it back',
  tier: 3,
  shapes: ['A'],
  steps: [
    step('Open a loopback page through the headed box browser beside the chat', async (context) => {
      const { pair, workspace, folder } = context
      const { page } = pair
      const pressed = join(folder, 'page-press.txt')
      const site = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        fetch(request) {
          if (new URL(request.url).pathname === '/pressed' && request.method === 'POST') {
            writeFileSync(pressed, 'Count cones was pressed\n')
            return new Response('Counted the cones')
          }
          if (new URL(request.url).pathname !== '/') return new Response(null, { status: 404 })
          return new Response(`<!doctype html><title>${TITLE}</title>
            <body style="display:grid;place-items:center;height:100vh;margin:0;background:#e4efe4">
            <button style="font:32px system-ui;padding:40px" onclick="fetch('/pressed',{method:'POST'}).then(r=>r.text()).then(text=>{this.textContent=text;document.body.style.background='#d496f0'})">Count cones</button>`,
          { headers: { 'content-type': 'text/html' } })
        }
      })
      pair.later(async () => { pair.releaseFakeBrowserTurn(); await site.stop(true) })
      pair.trackPort(site.port!)
      const { id } = await createThread(pair, workspace.id, TITLE + ' chat')
      const url = site.url.href
      visits.set(context, { id, pressed })
      await pair.showWork(workspace, 'Plays')
      await page.clickOn('[data-thread-row] [data-row-open]', TITLE + ' chat')
      const messages = pair.fakeMessages
      const composer = '[data-composer]:not([data-files-dock] [data-composer])'
      await page.clickOn(composer + ' [data-composer-input]')
      await page.typeKeys(BROWSER_PROMPT)
      await page.clickOn(composer + ' button', 'Send')
      await page.until('the dummy browser turn to reach the loopback provider', 35_000, () => pair.fakeMessages > messages)
      const opened = await workTool(pair, id, 'browser_open', { name: TITLE, title: TITLE, url })
      if (opened.error) throw new Error(opened.text)
      const video = await pair.rpc<BrowserVideo>(pair.box, 'work.browser.video', { on: true })
      const launch = await workTool(pair, id, 'box_browser_open', { launch: 'Chromium' })
      if (launch.error && !launch.text.includes('Chromium did not answer')) {
        json(context, 'browser-open', { opened, launch, video })
        throw new Error('Box Chromium could not start: ' + launch.text)
      }
      const app = await workTool(pair, id, 'box_browser_open', { launch: 'Chromium', open: [url] })
      const log = readFileSync(pair.box.log, 'utf8')
      const cause = headedResult(log, video.tools)
      json(context, 'browser-open', { opened, launch, app, video, cause })
      if (app.error) throw new Error('Box Chromium could not open the dummy page: ' + app.text)
      if (cause) throw new Error(cause)
      const observed = await workTool(pair, id, 'box_browser_observe', { app: 'Chromium', window: TITLE })
      json(context, 'browser-observe', { observed, computer: await pair.rpc(pair.box, 'computer.sessions'),
        thread: (await hostRows(pair, 'SELECT id, status FROM sessions WHERE id = ?', id))[0] })
      if (observed.error || !observed.text.includes('Count cones')) throw new Error('The box browser did not read the dummy page: ' + observed.text)
      await page.until('the browser canvas beside the chat and the box browser state', 20_000, async () =>
        !!await page.centre(VIEW) && await shown(page, 'body', TITLE) &&
        await shown(page, 'body', BROWSER_PROMPT) && (await browserState(context, id)).site?.url === url)
      if (existsSync(pressed)) throw new Error('The dummy page received a press before Take over')
    }),
    // A Linux window draws no picture of a computer (src/renderer/src/lib/computerSessions.ts `drawsSessions`: a Mac's and
    // a PC's desktop only), so from the box's own windows the walk cannot drive the page from the picture. It ends on what
    // a Linux window promises: Take over and Hand back move the driver on the host, and the canvas says in words where
    // the picture shows. On a Mac's or a PC's window the walk drives the page through the picture instead.
    step('Take over: the host gives him the browser, and the canvas says where its picture shows or draws it', async context => {
      const { page } = context.pair
      const { id, pressed } = visits.get(context)!
      await page.press('button', 'Take over')
      await page.until('Hand back and the owner driver on box', 20_000, async () =>
        !!await page.centre('button', 'Hand back') && (await browserState(context, id)).driver === 'owner')
      const platform = await page.eval<string>('window.api.platform')
      if (platform === 'linux') {
        let line: string | null = null
        await page.until('the canvas line naming where the picture shows', 12_000, async () => !!(line = await page.eval<string | null>(
          `[...document.querySelectorAll(${JSON.stringify(VIEW + ' *')})].map((e) => e.textContent.trim()).find((t) => /^Shown on .+ only$/.test(t)) ?? null`)))
        json(context, 'take-over', { platform, line, state: await browserState(context, id) })
        if (existsSync(pressed)) throw new Error('Take over pressed the dummy page')
        return
      }
      await page.clickOn(VIEW + ' button[data-viewport-open]')
      await page.until('the picture taking input', 22_000, () => page.centre('[data-full-window] [data-driving]'))
      const sample = await page.eval<{ x: number; y: number }>(`(() => {
        const rect = document.querySelector('[data-full-window] canvas').getBoundingClientRect();
        return { x: rect.x + rect.width / 5, y: rect.y + rect.height / 5 };
      })()`)
      const before = await page.pixelAt(sample)
      // The button is at the centre of the page. The sampled background changes after the page handles the click.
      await page.clickOn('[data-full-window] [data-driving]')
      await page.until('the dummy page to receive the click through Work', 20_000, () => existsSync(pressed))
      await page.until('the updated background in the live picture', 12_000, async () => await page.pixelAt(sample) !== before)
      if (readFileSync(pressed, 'utf8').trim() !== 'Count cones was pressed') throw new Error('The click did not reach the page while the owner was driving')
      await page.key('Escape')
    }),
    step('end: Hand back gives the browser to the agent on box', async context => {
      const { page } = context.pair
      const { id } = visits.get(context)!
      await page.press('button', 'Hand back')
      await page.until('Take over and the agent driver on box', 20_000, async () =>
        !!await page.centre('button', 'Take over') && (await browserState(context, id)).driver === 'agent')
    })
  ]
})
