import { existsSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { CaptureFiled, CaptureState } from '../../src/shared/contract-work-capture'
import { openCapture } from './lib/capture'
import { desktopDrop } from './lib/drop'
import { journey, step, type Context } from './lib/record'
import { rowsAt } from './lib/thread'
import { json, shown } from './lib/tierThree'

const TITLE = 'Bring spare cones to practice'
const HOME = 'Purdue capture practice'
const FILE = 'Practice capture.png'
const captureState = new WeakMap<Context, { page: Awaited<ReturnType<typeof openCapture>>; home: { id: string; path: string }; bytes: Buffer }>()

export default journey({
  id: 'J49',
  title: 'Capture a file and record the landing hosts',
  tier: 3,
  shapes: ['A'],
  steps: [
    step('Open the app’s Capture window on win and choose the dummy Purdue workspace', async (context) => {
      const { pair } = context
      const home = await pair.rpc<{ id: string; path: string }>(pair.win, 'workspace.create', { kind: 'work', sector: 'purdue', name: HOME })
      const capture = await openCapture(pair)
      context.evidencePage = capture
      const homeState = await pair.rpc<CaptureState>(pair.win, 'work.capture.state')
      if (homeState.host !== pair.win.host || !homeState.connected || !homeState.homes.includes('purdue') || !existsSync(home.path)) {
        throw new Error('The capture host does not see its dummy Purdue workspace and sandbox')
      }
      const bytes = readFileSync(join(pair.repo, 'src/main/server/work/money/fixtures/coffee.png'))
      captureState.set(context, { page: capture, home, bytes })
      await capture.press('button', 'Purdue')
      await capture.clickOn('textarea', 'Capture')
      await capture.typeKeys(TITLE)
      await desktopDrop(capture, '[data-capture]', FILE, 'image/png', bytes)
      await capture.until('the Capture text and image chip', 15_000, async () =>
        await shown(capture, '[aria-label="Files"]', '.png') &&
        await capture.eval(`document.querySelector('textarea')?.value === ${JSON.stringify(TITLE)}`))
    }),
    step('end: record the hosts that hold the thread and file and see where they landed', async (context) => {
      const { pair } = context
      const { page, home, bytes } = captureState.get(context)!
      await page.key('Control+Enter')
      const seats = [pair.win, pair.box]
      let capture: CaptureFiled | undefined
      let filePath: string | undefined
      let fileHost: string | undefined
      let threadHost: string | undefined
      await page.until('the Capture filing record on an isolated host', 25_000, async () => {
        for (const seat of seats) {
          const [row] = await rowsAt<{ result: string }>(seat.data, 'SELECT result FROM work_capture_filed ORDER BY at DESC LIMIT 1')
          if (row) capture = JSON.parse(row.result) as CaptureFiled
        }
        return !!capture
      })
      for (const seat of seats) {
        if (capture!.threadId && (await rowsAt(seat.data, 'SELECT id FROM sessions WHERE id = ?', capture!.threadId)).length) threadHost = seat.name
        for (const root of [home.path, context.workspace.path]) {
          if (!root.startsWith(seat.work + '/')) continue
          for (const name of capture!.kept) {
            if (basename(name) !== name) continue
            const path = join(root, name)
            if (existsSync(path) && readFileSync(path).equals(bytes)) {
              filePath = path
              fileHost = seat.name
            }
          }
        }
      }
      json(context, 'landed', { threadHost: threadHost ?? null, fileHost: fileHost ?? null, filePath, capture })
      if (!threadHost || !fileHost) throw new Error('Capture did not leave both a kept file and a thread: ' + (capture!.threadError ?? 'see landed.json'))
      context.evidencePage = undefined
      await pair.page.eval(`void window.__docket.open(${JSON.stringify(capture!.threadId)})`)
      await pair.page.until('the captured thread’s message and kept path on screen', 20_000, async () =>
        await shown(pair.page, 'body', TITLE) && await shown(pair.page, 'body', filePath!))
    })
  ]
})
