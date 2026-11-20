import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ComputerFramePush, ComputerPreviewPush } from '@shared/contract-computer'
import type { SessionMeta } from '@shared/events'
import { setAttachmentDirContext } from '../../../attachmentDir'
import { ComputerPreviews } from '../../../computer/preview'
import type { WorkCtx } from '../../modules'
import { DriveStore, ensureBrowserTables } from '../drive'
import { findChromium } from './chromium'
import { boxDriveChanged, setBoxBrowser, startBoxBrowser, wireBoxBrowser, type BoxBrowserHost } from './index'
import { serveTestSite, type TestSite } from './testSite'

/**
 * Take over on a box whose browser is headless (the video tools are not
 * installed): the host's own wiring on the real Chromium. The page he took
 * stays listed and its 4 fps picture goes on, though the session it was
 * drawn from is stopped; Hand back ends both.
 */
const bin = findChromium()
const d = bin ? describe : describe.skip

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const until = async (what: () => boolean, ms = 10_000): Promise<void> => {
  const end = Date.now() + ms
  while (!what()) {
    if (Date.now() > end) throw new Error('timed out')
    await sleep(20)
  }
}
/** A page that repaints all the time, so the screencast always has a frame to send. */
const MOVING = `<!doctype html><title>moving</title><body style="margin:0"><div id="b" style="height:700px"></div><script>let n=0;(function f(){n++;document.getElementById('b').style.background='hsl('+(n%360)+' 80% 50%)';requestAnimationFrame(f)})()</script>`

d('take over on a headless box browser', () => {
  let dataDir: string
  let host: BoxBrowserHost
  let site: TestSite
  let db: DatabaseSync
  let stopWork: () => void
  let previews: ComputerPreviews
  const connection = {}
  const frames: ComputerFramePush[] = []
  const states: ComputerPreviewPush[] = []
  const pushedRows: string[][] = []
  const run = (threadId: string, tool: string, args: Record<string, unknown>) => host.sessions.run({ threadId, permission: () => 'auto' }, tool, args)
  const listed = (): { threadId: string; driver?: string }[] => host.rows.rows().map((r) => ({ threadId: r.threadId, ...(r.driver ? { driver: r.driver } : {}) }))

  beforeAll(async () => {
    // no work-tools under it: the browser starts headless
    dataDir = mkdtempSync(join(tmpdir(), 'tc-box-headless-'))
    mkdirSync(join(dataDir, 'attachments'), { recursive: true })
    setAttachmentDirContext({ dataDir, session: () => null, projectCwd: () => null, workspacePath: () => null })
    site = await serveTestSite({ '/moving': MOVING })
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
      log: () => {}
    })!
    db = new DatabaseSync(':memory:')
    ensureBrowserTables(db)
    stopWork = startBoxBrowser({ db, held: { onDecided: () => () => {} } } as unknown as WorkCtx)
    await run('w1', 'computer_apps', { launch: 'Chromium', open: [`${site.url}/moving`] })
    await run('w1', 'computer_observe', { app: 'Chromium' })
    previews = new ComputerPreviews({ service: host.service, sessions: host.previews })
    host.rows.onRows((rows) => void pushedRows.push(rows.map((r) => r.threadId)))
  }, 90_000)

  afterAll(async () => {
    await previews?.close()
    stopWork?.()
    await host?.browser.stop()
    setBoxBrowser(null)
    setAttachmentDirContext(null)
    await site?.close()
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  })

  it('keeps the page listed and its picture playing through Take over, and ends both at Hand back', async () => {
    expect(host.browser.display).toBeNull()
    expect(listed()).toEqual([{ threadId: 'w1' }])
    const viewer = {
      connection,
      send: (push: ComputerFramePush | ComputerPreviewPush | { push: 'computer-click' }): void => {
        if (push.push === 'computer-frame') {
          frames.push(push)
          previews.ack(connection, push.preview, push.seq)
        } else if (push.push === 'computer-preview') states.push(push)
      }
    }
    const started = await previews.start(viewer as never, { threadId: 'w1', maxEdge: 960 })
    await until(() => frames.length > 1)

    // Take over, as the app does it: he is the driver first, then the agent's session of the pane is stopped
    new DriveStore(db).drive('w1', 'owner')
    boxDriveChanged('w1', true)
    await until(() => listed()[0]?.driver === 'owner')
    expect(listed()).toEqual([{ threadId: 'w1', driver: 'owner' }])
    pushedRows.length = 0
    expect(await host.rows.stop('w1')).toBe(true)
    // the row never left the list: every push since he took over names the pane
    expect(listed()).toEqual([{ threadId: 'w1', driver: 'owner' }])
    await until(() => pushedRows.length > 0)
    expect(pushedRows.every((ids) => ids.includes('w1'))).toBe(true)
    // nothing of his to stop: Hand back is how it ends
    expect(await host.rows.stop('w1')).toBe(false)

    // the picture goes on under the same preview, from a session of the service that only looks
    await sleep(300)
    const before = frames.length
    await until(() => frames.length > before + 1)
    expect(frames.at(-1)!.preview).toBe(started.preview)
    expect(states.some((s) => s.state === 'ended')).toBe(false)
    // and a place that opens it now (a tile mounted after) gets it by the pane's thread
    expect(host.previews.previewTarget('w1')).toMatchObject({ serviceSession: 'owner:w1' })

    // Hand back: the page is nobody's until the agent acts again, and the picture ends
    new DriveStore(db).drive('w1', 'agent')
    boxDriveChanged('w1', false)
    await until(() => listed().length === 0)
    await until(() => states.some((s) => s.state === 'ended'))
    expect(host.previews.previewTarget('w1')).toBeNull()
  }, 60_000)
})
