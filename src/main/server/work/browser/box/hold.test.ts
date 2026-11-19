import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { SessionMeta } from '@shared/events'
import { configureComputerHold, type HeldComputerCall } from '../../../computer/run'
import { ComputerService } from '../../../computer/service'
import { ComputerSessions } from '../../../computer/sessions'
import { type BoxChromium, findChromium } from './chromium'
import { BoxComputerService, inProcessSpawn } from './service'
import { serveTestSite, type TestSite } from './testSite'
import { testBrowser } from './testTools'

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
    const rig = testBrowser(root, bin!)
    browser = rig.browser
    site = await serveTestSite()
    const service = new ComputerService({
      dataDir: join(root, 'computer'),
      bin: () => 'box-browser',
      spawn: inProcessSpawn(() => new BoxComputerService({ browser: rig.link }))
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

  describe('steps the service carries out exactly as the hold read them', () => {
    const t = 'w3'
    let text = ''
    const fresh = async () => {
      await run(t, 'computer_apps', { launch: 'Chromium', open: [site.url + '/tricks'] })
      text = (await run(t, 'computer_observe', { app: 'Chromium' })).body!
    }

    it('pastes a line break as text: nothing is sent', async () => {
      metas.set(t, { id: t, permission: 'auto', scope: 'work' } as Partial<SessionMeta>)
      await fresh()
      const before = held.length
      const r = await run(t, 'computer_act', { app: 'Chromium', action: 'paste', element: idOf(text, /input "Note"/), text: 'ok\n' })
      expect(r.isError, r.body ?? '').toBe(false)
      expect(held.length).toBe(before)
      await new Promise((r) => setTimeout(r, 300))
      expect(site.posts).not.toContain('/sent')
    }, 60_000)

    it('refuses a menu step, a key into a control that takes no focus, and typing that would have clicked', async () => {
      await fresh()
      const menu = await run(t, 'computer_act', { app: 'Chromium', action: 'left_click', menu: 'View > Zoom' })
      expect(menu.steps.join('\n')).toMatch(/no menu bar/)
      const div = idOf(text, /button "Send now"/)
      // the hold reads typing as text; the service never clicks a control that takes no focus in its place
      const typed = await run(t, 'computer_act', { app: 'Chromium', action: 'type', element: div, text: 'x' })
      expect(typed.steps.join('\n')).toMatch(/can't take keyboard focus/)
      await new Promise((r) => setTimeout(r, 300))
      expect(site.posts).not.toContain('/sent')
    }, 60_000)

    it('refuses a click on a control another lies over, and holds a click on a frame named for an outward act', async () => {
      await fresh()
      const cancel = idOf(text, /button "Cancel"/)
      const r = await run(t, 'computer_act', { app: 'Chromium', action: 'left_click', element: cancel })
      // the read may show the overlaid Send itself, which the hold would keep; either way nothing is sent
      expect(r.steps.join('\n')).toMatch(/something else covers/)
      const frames = await run(t, 'computer_observe', { app: 'Chromium', mode: 'full' })
      // the frame shows as a group by its title; a click on it lands inside, which the read never showed
      const into = await run(t, 'computer_act', { app: 'Chromium', action: 'left_click', element: idOf(frames.body!, /group "Pay"/) })
      await new Promise((r) => setTimeout(r, 300))
      expect(site.posts).not.toContain('/paid')
      expect(site.posts).not.toContain('/sent')
      // "Pay" is itself an outward word: the hold keeps the click on the frame whatever lies inside it
      expect(into.body).toMatch(/^held:/)
    }, 60_000)

    it('keeps keys from the address bar out of the page, and his mailbox closed', async () => {
      await fresh()
      await run(t, 'computer_act', { app: 'Chromium', action: 'left_click', element: idOf(text, /input "Note"/) })
      const address = idOf(text, /input "Address and search bar"/)
      await run(t, 'computer_act', { app: 'Chromium', action: 'left_click', element: address })
      const chord = await run(t, 'computer_act', { app: 'Chromium', action: 'key', text: 'ctrl+Return' })
      expect(chord.steps.join('\n')).toMatch(/failed: (the keys would go to \[\d+\], not the page|.*focus)/)
      const mailbox = await run(t, 'computer_apps', { launch: 'Chromium', open: ['https://outlook.office.com/mail/'] })
      expect(`${mailbox.body}`).toMatch(/open refused/)
      expect(site.posts).not.toContain('/sent')
    }, 60_000)
  })

  it('reads, types into and holds a form drawn in frames, of this origin and of another, and the press submits each once', async () => {
    metas.set('w4', { id: 'w4', permission: 'auto', scope: 'work' } as Partial<SessionMeta>)
    const run4 = (tool: string, args: Record<string, unknown>) => sessions.run({ threadId: 'w4', permission: () => 'auto' }, tool, args)
    await run4('computer_apps', { launch: 'Chromium', open: [site.url + '/frames'] })
    let text = ''
    // the other origin's frame comes in its own process: read until it is there
    for (let i = 0; i < 30 && !/button "Pay now"/.test(text); i++) {
      text = (await run4('computer_observe', { app: 'Chromium' })).body ?? ''
      if (!/button "Pay now"/.test(text)) await new Promise((r) => setTimeout(r, 200))
    }
    expect(text).toMatch(/group "Comments"[\s\S]*input "Comment"[\s\S]*button "Post comment"/)
    expect(text).toMatch(/group "Payment"[\s\S]*input "Card name"[\s\S]*password "Card PIN"[\s\S]*button "Pay now"/)
    const filled = await run4('computer_batch', {
      app: 'Chromium',
      actions: [
        { action: 'type', element: idOf(text, /input "Comment"/), text: 'Looks right' },
        { action: 'type', element: idOf(text, /input "Card name"/), text: 'Dana Lee' }
      ]
    })
    expect(filled.isError, filled.body ?? '').toBe(false)
    expect(filled.body).toContain('input "Comment" = "Looks right"')
    expect(filled.body).toContain('input "Card name" = "Dana Lee"')

    // each submit leaves the page, so each is read and pressed in a thread of its own on a fresh page
    for (const [thread, button, posted] of [['w4', /button "Post comment"/, '/commented'], ['w5', /button "Pay now"/, '/paid']] as const) {
      metas.set(thread, { id: thread, permission: 'auto', scope: 'work' } as Partial<SessionMeta>)
      const go = (tool: string, args: Record<string, unknown>) => sessions.run({ threadId: thread, permission: () => 'auto' }, tool, args)
      if (thread === 'w5') await go('computer_apps', { launch: 'Chromium', open: [site.url + '/frames'] })
      let now = ''
      for (let i = 0; i < 30 && !button.test(now); i++) {
        now = (await go('computer_observe', { app: 'Chromium' })).body ?? ''
        if (!button.test(now)) await new Promise((r) => setTimeout(r, 200))
      }
      const before = held.length
      const r = await go('computer_act', { app: 'Chromium', action: 'left_click', element: idOf(now, button) })
      expect(r.body, r.steps.join('\n')).toMatch(/^held:/)
      expect(held.length).toBe(before + 1)
      await new Promise((r) => setTimeout(r, 300))
      expect(site.posts).not.toContain(posted)
      const pressed = await held.at(-1)!.carryOut()
      expect(pressed.isError, `${pressed.body} ${pressed.steps.join(' ')}`).toBe(false)
      expect(pressed.steps.join('\n')).not.toMatch(/failed/)
      for (let i = 0; i < 20 && !site.posts.includes(posted); i++) await new Promise((r) => setTimeout(r, 100))
      expect(site.posts.filter((p) => p === posted)).toEqual([posted])
    }
  }, 90_000)

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
    new DriveStore(db).drive('other-pane', 'owner')
    const ctx = { db, sessionId: 'w1', signal: new AbortController().signal, canvas: { paneOf: () => 'pane' } } as never
    const act = tools.find((t) => t.name === 'box_browser_act')!
    // he drives another thread's page of the one browser: no thread acts in it
    const r = await act.run({ app: 'Chromium', action: 'left_click', element: 3 }, ctx)
    expect(r).toMatchObject({ isError: true, content: [{ type: 'text', text: BOX_OWNER_DRIVES }] })
    await tools.find((t) => t.name === 'box_browser_observe')!.run({ app: 'Chromium' }, ctx)
    expect(ran).toEqual(['computer_observe'])
    setBoxBrowser(null)
  })
})
