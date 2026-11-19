import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { SessionMeta } from '@shared/events'
import { configureComputerHold, type HeldComputerCall } from '../../../computer/run'
import { ComputerService } from '../../../computer/service'
import { ComputerSessions } from '../../../computer/sessions'
import { BoxChromium, findChromium } from './chromium'
import { BoxComputerService, inProcessSpawn } from './service'
import { serveTestSite, type TestSite } from './testSite'

/**
 * The done-when on the box with no Mac awake: a Work thread drives a test
 * site in the box's Chromium through the host's own computer sessions, and
 * the final submit is held by run.ts's reading of the screen, whatever the
 * model flagged; nothing reaches the site until the press, and the press
 * submits once. A code thread's same click runs.
 */

const bin = findChromium()
const d = bin && process.platform === 'linux' ? describe : describe.skip

d('the hold on the box browser', () => {
  let root: string
  let browser: BoxChromium
  let site: TestSite
  let sessions: ComputerSessions
  const metas = new Map<string, Partial<SessionMeta>>()
  const held: HeldComputerCall[] = []

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'm38-hold-'))
    browser = new BoxChromium({ root, bin: () => bin })
    site = await serveTestSite()
    const service = new ComputerService({
      dataDir: join(root, 'computer'),
      bin: () => 'box-browser',
      spawn: inProcessSpawn(() => new BoxComputerService({ browser: { endpoint: () => browser.endpoint(), pid: () => browser.pid, touch: () => browser.touch() } }))
    })
    sessions = new ComputerSessions({
      service,
      registry: { get: (id) => (metas.get(id) as SessionMeta) ?? null, requestApproval: async () => true, awayOn: () => false },
      store: { getSetting: () => null, setSetting: () => {} } as never,
      dataDir: join(root, 'computer'),
      landing: (id) => join(root, 'landing', id),
      log: () => {}
    })
    configureComputerHold({
      hold(call) {
        held.push(call)
        return `held: ${call.label} waits for the owner's press`
      }
    })
  }, 30_000)

  afterAll(async () => {
    configureComputerHold(null)
    await browser?.stop()
    await site?.close()
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  })

  const run = (thread: string, tool: string, args: Record<string, unknown>) => sessions.run({ threadId: thread, permission: () => 'auto' }, tool, args)
  const idOf = (text: string, re: RegExp): number => Number(/\[(\d+)\]/.exec(text.split('\n').find((l) => re.test(l)) ?? '')?.[1])

  it('fills the form, holds the final submit with nothing sent, and submits once on the press', async () => {
    metas.set('w1', { id: 'w1', permission: 'auto', scope: 'work' } as Partial<SessionMeta>)
    const opened = await run('w1', 'computer_apps', { launch: 'Chromium', open: [site.url + '/'] })
    expect(opened.isError, opened.body ?? '').toBe(false)
    let read = await run('w1', 'computer_observe', { app: 'Chromium' })
    const text = read.body!
    const filled = await run('w1', 'computer_batch', {
      app: 'Chromium',
      actions: [
        { action: 'left_click', element: idOf(text, /input "Name"/) },
        { action: 'type', text: 'Dana Lee' },
        { action: 'left_click', element: idOf(text, /input "Amount"/) },
        { action: 'type', text: '42.10' },
        { action: 'left_click', element: idOf(text, /button "Next"/) }
      ]
    })
    expect(filled.isError, filled.body ?? '').toBe(false)
    expect(filled.body).toContain('window "Review expense"')
    expect(held).toHaveLength(0)

    read = await run('w1', 'computer_observe', { app: 'Chromium' })
    // Unflagged: the model says nothing of what the button does. The host reads it on the screen.
    const submit = await run('w1', 'computer_act', { app: 'Chromium', action: 'left_click', element: idOf(read.body!, /button "Submit expense"/) })
    expect(submit.isError).toBe(false)
    expect(submit.body).toMatch(/^held:/)
    expect(held).toHaveLength(1)
    expect(held[0]!).toMatchObject({ threadId: 'w1', why: 'screen', label: 'Submit', app: { bundleId: 'org.chromium.Chromium', name: 'Chromium' } })
    expect(held[0]!.read?.on).toBe('button "Submit expense"')
    await new Promise((r) => setTimeout(r, 300))
    expect(site.posts).toEqual([])

    const pressed = await held[0]!.carryOut()
    expect(pressed.isError, pressed.body ?? '').toBe(false)
    expect(pressed.stale).toBeUndefined()
    expect(site.posts).toEqual(['/done'])
    expect(pressed.body).toContain('window "Expense submitted"')
  }, 60_000)

  it('holds Return pressed in a message box beside Send', async () => {
    metas.set('w2', { id: 'w2', permission: 'auto', scope: 'work' } as Partial<SessionMeta>)
    await run('w2', 'computer_apps', { launch: 'Chromium', open: [site.url + '/chat'] })
    const read = await run('w2', 'computer_observe', { app: 'Chromium' })
    const before = held.length
    const r = await run('w2', 'computer_batch', {
      app: 'Chromium',
      actions: [
        { action: 'left_click', element: idOf(read.body!, /text area "Message"/) },
        { action: 'type', text: 'On my way' },
        { action: 'key', text: 'Return' }
      ]
    })
    expect(r.body).toMatch(/^held:/)
    expect(held.length).toBe(before + 1)
    expect(site.posts).not.toContain('/sent')
  }, 60_000)

  it("runs a code thread's submit: the hold is Work's", async () => {
    metas.set('c1', { id: 'c1', permission: 'auto' } as Partial<SessionMeta>)
    await run('c1', 'computer_apps', { launch: 'Chromium', open: [site.url + '/review?name=a&amount=1'] })
    const read = await run('c1', 'computer_observe', { app: 'Chromium' })
    const before = site.posts.length
    const r = await run('c1', 'computer_act', { app: 'Chromium', action: 'left_click', element: idOf(read.body!, /button "Submit expense"/) })
    expect(r.isError, r.body ?? '').toBe(false)
    expect(r.body).not.toMatch(/^held:/)
    expect(site.posts.length).toBe(before + 1)
  }, 60_000)
})

describe('the box browser tools', () => {
  it('are listed only where the box has a browser, and refuse to act while he drives', async () => {
    const { DatabaseSync } = await import('node:sqlite')
    const { ensureBrowserTables, DriveStore } = await import('../drive')
    const { boxBrowserTools, setBoxBrowser, BOX_OWNER_DRIVES } = await import('./index')
    setBoxBrowser(null)
    expect(boxBrowserTools()).toEqual([])
    const ran: string[] = []
    setBoxBrowser({ sessions: { run: async (_c: unknown, tool: string) => (ran.push(tool), { steps: [], shots: [], body: 'ok', isError: false }) } } as never)
    const tools = boxBrowserTools()
    expect(tools.map((t) => t.name)).toEqual(['box_browser_open', 'box_browser_observe', 'box_browser_act', 'box_browser_batch'])
    const db = new DatabaseSync(':memory:')
    ensureBrowserTables(db)
    new DriveStore(db).drive('pane', 'owner')
    const ctx = { db, sessionId: 'w1', signal: new AbortController().signal, canvas: { paneOf: () => 'pane' } } as never
    const act = tools.find((t) => t.name === 'box_browser_act')!
    const r = await act.run({ app: 'Chromium', action: 'left_click', element: 3 }, ctx)
    expect(r).toMatchObject({ isError: true, content: [{ type: 'text', text: BOX_OWNER_DRIVES }] })
    await tools.find((t) => t.name === 'box_browser_observe')!.run({ app: 'Chromium' }, ctx)
    expect(ran).toEqual(['computer_observe'])
    setBoxBrowser(null)
  })
})
