import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ComputerClickPush, ComputerFramePush, ComputerPreviewPush } from '@shared/contract-computer'
import type { SessionMeta } from '@shared/events'
import { ComputerPreviews } from '../../../computer/preview'
import { ComputerRpc } from '../../../computer/rpc'
import { ComputerService } from '../../../computer/service'
import { ComputerSessions } from '../../../computer/sessions'
import { type BoxChromium, findChromium } from './chromium'
import { BoxComputerService, inProcessSpawn } from './service'
import { serveTestSite, type TestSite } from './testSite'
import { testBrowser } from './testTools'

/**
 * Watch and Take over on a box thread's page: the host's own preview relay
 * (`ComputerPreviews`) over the box's sessions streams the page from the
 * box's Chromium (`Page.startScreencast`), and `ComputerRpc` lists and stops
 * those sessions. `M38_SHOT=<dir>` keeps the first frame as a picture.
 */

const bin = findChromium()
const d = bin && process.platform === 'linux' ? describe : describe.skip

d('the live picture of the box browser', () => {
  let root: string
  let browser: BoxChromium
  let site: TestSite
  let sessions: ComputerSessions
  let service: ComputerService

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'm38-live-'))
    const rig = testBrowser(root, bin!)
    browser = rig.browser
    site = await serveTestSite()
    service = new ComputerService({
      dataDir: join(root, 'computer'),
      bin: () => 'box-browser',
      spawn: inProcessSpawn(() => new BoxComputerService({ browser: rig.link }))
    })
    sessions = new ComputerSessions({
      service,
      registry: { get: (id) => ({ id, permission: 'auto', scope: 'work' }) as unknown as SessionMeta, requestApproval: async () => true, awayOn: () => false },
      store: { getSetting: () => null, setSetting: () => {} } as never,
      dataDir: join(root, 'computer'),
      landing: (id) => join(root, 'landing', id),
      log: () => {}
    })
  }, 30_000)

  afterAll(async () => {
    await browser?.stop()
    await site?.close()
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  })

  it('streams the page a thread drives to a watcher, lists its row, and stops it', async () => {
    const run = (tool: string, args: Record<string, unknown>) => sessions.run({ threadId: 'w1', permission: () => 'auto' }, tool, args)
    await run('computer_apps', { launch: 'Chromium', open: [site.url + '/'] })
    await run('computer_observe', { app: 'Chromium' })

    const rpc = new ComputerRpc(null, () => 'computer use runs on a Mac')
    rpc.setBox(sessions)
    expect(rpc.sessions().sessions.map((r) => [r.threadId, r.apps[0]?.bundleId])).toEqual([['w1', 'org.chromium.Chromium']])

    const pushes: (ComputerFramePush | ComputerClickPush | ComputerPreviewPush)[] = []
    const viewer = { connection: {}, send: (p: ComputerFramePush | ComputerClickPush | ComputerPreviewPush) => void pushes.push(p) }
    const previews = new ComputerPreviews({ service, sessions })
    const started = await previews.start(viewer, { threadId: 'w1', maxEdge: 640 })
    expect(started).toMatchObject({ app: 'Chromium', window: 'Expense portal' })
    const frame = async (): Promise<ComputerFramePush> => {
      for (let i = 0; i < 100; i++) {
        const f = pushes.find((p): p is ComputerFramePush => p.push === 'computer-frame')
        if (f) return f
        await new Promise((r) => setTimeout(r, 100))
      }
      throw new Error(`no frame: ${JSON.stringify(pushes.map((p) => p.push))}`)
    }
    const f = await frame()
    const jpeg = Buffer.from(f.data, 'base64')
    expect(jpeg.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]))
    expect(Math.max(f.width, f.height)).toBeLessThanOrEqual(640)
    if (process.env.M38_SHOT) {
      mkdirSync(process.env.M38_SHOT, { recursive: true })
      writeFileSync(join(process.env.M38_SHOT, 'box-live-frame.jpg'), jpeg)
    }
    previews.ack(viewer.connection, f.preview, f.seq)

    // Take over stops the thread's session: its row goes, and its watchers hear the stream end
    expect(await rpc.stop('w1')).toEqual({ stopped: true })
    await previews.close()
  }, 60_000)
})
