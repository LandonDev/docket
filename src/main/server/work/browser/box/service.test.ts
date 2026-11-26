import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import type { PassThrough } from 'node:stream'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parseObservation } from '@shared/computer/observation'
import { COMPUTER_PROTOCOL, ComputerNotificationSchema, resultFrameSchema, type ComputerNotification, RpcErrorResponseSchema, type ComputerMethod, type ComputerResult, type Observation } from '@shared/computer/protocol'
import { type BoxChromium, findChromium } from './chromium'
import { FORMS_HOSTS } from '@shared/work/msforms'
import { BoxComputerService, CARRIER_ONLY_HOSTS, CARRIER_TARGETS, carrierOnly, carrierSession, endCarrierSession, inProcessSpawn, isCarrierSession, setCarrierOnlyHostsForTest } from './service'
import { serveTestSite, type TestSite } from './testSite'
import { testBrowser } from './testTools'

/**
 * The wire conformance test for the Linux service (docs/computer-protocol.md
 * §28.4): every method of §3 answered over the stdio pair, each frame
 * checked against the wire's zod (`resultFrameSchema`, `RpcErrorResponseSchema`),
 * every observation's text through the grammar's own parser, against the
 * box's real Chromium on a local test site. Skipped where no Chromium is.
 */

describe('the carrier-only hosts', () => {
  it('are Forms hosts and their subdomains, whatever the case; nothing else', () => {
    expect([...CARRIER_ONLY_HOSTS]).toEqual([...FORMS_HOSTS])
    for (const url of ['https://forms.office.com/Pages/DesignPageV2.aspx?id=x', 'https://FORMS.cloud.microsoft/', 'https://eu.forms.microsoft.com/r/abc', 'http://forms.office.com./x'])
      expect(carrierOnly(url), url).toBe(true)
    for (const url of ['https://office.com/', 'https://notforms.office.com/', 'https://forms.office.com.evil.test/', 'not a url', 'about:blank'])
      expect(carrierOnly(url), url).toBe(false)
  })

  it('take a test list in place of Forms, and drop it', () => {
    setCarrierOnlyHostsForTest(['localhost'])
    expect(carrierOnly('http://localhost:9/forms')).toBe(true)
    expect(carrierOnly('https://forms.office.com/')).toBe(false)
    setCarrierOnlyHostsForTest(null)
    expect(carrierOnly('http://localhost:9/forms')).toBe(false)
  })

  it('open to a session only while the host has it marked', () => {
    const id = carrierSession()
    expect(id).toMatch(/^[A-Za-z0-9_-]{1,64}$/)
    expect(isCarrierSession(id)).toBe(true)
    expect(isCarrierSession('s1')).toBe(false)
    expect(isCarrierSession(undefined)).toBe(false)
    endCarrierSession(id)
    expect(isCarrierSession(id)).toBe(false)
  })
})

const bin = findChromium()
const d = bin && process.platform === 'linux' ? describe : describe.skip

type Frame = { id: number; result?: unknown; error?: unknown }

d('the box computer service speaks the wire', () => {
  let root: string
  let browser: BoxChromium
  let site: TestSite
  let child: { stdin: PassThrough; stdout: PassThrough; kill(): boolean }
  /** the service behind the stdio pair, for the carrier's own calls (not on the wire) */
  let svc: BoxComputerService
  const answers = new Map<number, (f: Frame) => void>()
  /** the service's notifications, each held to the wire's schema */
  const notes: ComputerNotification[] = []
  let next = 0

  const call = (method: string, params: Record<string, unknown> = {}): Promise<Frame> => {
    const id = ++next
    const p = new Promise<Frame>((r) => answers.set(id, r))
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    return p
  }
  /** a success, its frame held to the method's result schema */
  const ok = async <M extends ComputerMethod>(method: M, params: Record<string, unknown> = {}) => {
    const f = await call(method, params)
    expect(f.error, JSON.stringify(f.error)).toBeUndefined()
    return (resultFrameSchema(method).parse(f) as { result: ComputerResult<M> }).result
  }
  /** a refusal, its frame held to the error schema, answering its kind */
  const no = async (method: string, params: Record<string, unknown> = {}) => {
    const f = await call(method, params)
    return RpcErrorResponseSchema.parse(f).error
  }

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'm38-svc-'))
    const rig = testBrowser(root, bin!, { pid: false })
    browser = rig.browser
    site = await serveTestSite()
    const spawn = inProcessSpawn(() => (svc = new BoxComputerService({ browser: rig.link })))
    child = spawn('box', ['serve']) as never
    createInterface({ input: child.stdout }).on('line', (line) => {
      const f = JSON.parse(line) as Frame
      expect((f as { jsonrpc?: string }).jsonrpc).toBe('2.0')
      if ((f as { method?: string }).method) notes.push(ComputerNotificationSchema.parse(f))
      else answers.get(f.id)?.(f)
    })
  }, 30_000)

  afterAll(async () => {
    child?.kill()
    await browser?.stop()
    await site?.close()
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  })

  let epoch = ''
  let obs: Observation
  const lineOf = (text: string, re: RegExp): number => {
    const m = text.split('\n').find((l) => re.test(l))
    expect(m, `no line ${re} in\n${text}`).toBeTruthy()
    return Number(/\[(\d+)\]/.exec(m!)![1])
  }

  it('refuses everything before initialize, then initializes', async () => {
    expect((await no('apps.list')).data?.kind).toBe('not_initialized')
    const init = await ok('initialize', { protocol: COMPUTER_PROTOCOL, client: { name: 'test', version: '0' }, dataDir: join(root, 'svc') })
    epoch = init.epoch
    expect(init.permissions).toEqual({ accessibility: true, screenRecording: true })
    expect((await no('nothing.here')).code).toBe(-32601)
    expect((await no('session.open', { session: 7 })).code).toBe(-32602)
  })

  it('answers the reads that need no page', async () => {
    await ok('permissions.get')
    await ok('session.open', { session: 's1' })
    await ok('clipboard.state')
    await ok('escape.watch', { on: true })
    await ok('input.restoreSession', {})
    await ok('input.probe', { session: 's1', app: { app: 'Chromium' } })
  })

  it('opens the test site and reads it in the observation grammar, with frames and a picture', async () => {
    expect((await no('apps.launch', { app: 'Chromium', open: ['file:///etc/passwd'] })).data?.kind).toBe('open_refused')
    expect((await no('apps.launch', { app: 'TextEdit' })).data?.kind).toBe('app_not_found')
    await ok('apps.launch', { app: 'Chromium', open: [site.url + '/'] })
    const apps = await ok('apps.list', { windows: true })
    expect(apps.apps[0]!.bundleId).toBe('org.chromium.Chromium')
    obs = await ok('state.get', { session: 's1', app: { app: 'Chromium' }, mode: 'full', geometry: true, screenshot: 'always', wait: { minMs: 0, quietMs: 100, maxMs: 3000, busyMaxMs: 3000 } })
    expect(() => parseObservation(obs.text)).not.toThrow()
    expect(obs.text).toMatch(/^app "Chromium" · window "Expense portal" · \d+×\d+/)
    expect(obs.text).toContain(`input "Address and search bar" = "${site.url}/"`)
    expect(obs.text).toMatch(/\[\d+\] password "Password"/)
    expect(obs.text).toMatch(/\[\d+\] button "Next" @\d+,\d+ \d+×\d+/)
    expect(obs.text).toMatch(/checkbox "Receipt attached" unchecked/)
    expect(obs.shot && existsSync(obs.shot.path)).toBe(true)
  })

  it('acts by element and by point, and the closing read shows it', async () => {
    const name = lineOf(obs.text, /input "Name"/)
    const amount = lineOf(obs.text, /input "Amount"/)
    const box = lineOf(obs.text, /checkbox "Receipt attached"/)
    const r = await ok('action.batch', {
      session: 's1',
      app: { app: 'Chromium' },
      epoch,
      tiers: ['ax', 'process'],
      actions: [
        { action: 'left_click', element: name },
        { action: 'type', text: 'Dana Lee' },
        { action: 'set_value', element: amount, value: '42.10' },
        { action: 'left_click', element: box }
      ],
      wait: { minMs: 0, quietMs: 100, maxMs: 2000, busyMaxMs: 2000 }
    })
    expect(r.steps.map((s) => s.status)).toEqual(['ok', 'ok', 'ok', 'ok'])
    expect(r.observation!.text).toContain(`[${name}] input "Name" = "Dana Lee"`)
    expect(r.observation!.text).toContain(`[${amount}] input "Amount" = "42.10"`)
    expect(r.observation!.text).toMatch(new RegExp(`\\[${box}\\] checkbox "Receipt attached"( focused)? checked`))
    // the same element keeps its number across reads
    obs = r.observation!
  })

  it('names steps by words, takes keys, and navigates by the address bar', async () => {
    const r = await ok('action.run', { session: 's1', app: { app: 'Chromium' }, tiers: ['process'], action: { action: 'left_click', named: 'Next' }, wait: { minMs: 0, quietMs: 150, maxMs: 3000, busyMaxMs: 3000 } })
    expect(r.step.status).toBe('ok')
    expect(r.observation!.text).toContain('window "Review expense"')
    expect(r.observation!.text).toContain('Dana Lee — 42.10')
    const address = lineOf(r.observation!.text, /input "Address and search bar"/)
    const back = await ok('action.batch', {
      session: 's1',
      app: { app: 'Chromium' },
      epoch,
      tiers: ['process'],
      actions: [
        { action: 'set_value', element: address, value: site.url + '/' },
        { action: 'key', text: 'Return' }
      ],
      wait: { minMs: 0, quietMs: 150, maxMs: 3000, busyMaxMs: 3000 }
    })
    expect(back.observation!.text).toContain('window "Expense portal"')
    const bad = await ok('action.batch', {
      session: 's1',
      app: { app: 'Chromium' },
      epoch,
      tiers: ['process'],
      actions: [{ action: 'set_value', element: address, value: 'file:///etc/passwd' }, { action: 'key', text: 'Return' }, { action: 'key', text: 'Tab' }]
    })
    expect(bad.steps.map((s) => s.status)).toEqual(['ok', 'failed', 'not-run'])
    expect(bad.steps[1]!.status === 'failed' && bad.steps[1]!.error.kind).toBe('open_refused')
  })

  it('lands a click only on what the read showed: never under a covering control; a frame is read and reached', async () => {
    await ok('apps.launch', { app: 'Chromium', open: [site.url + '/tricks'], session: 's1' })
    const read = await ok('state.get', { session: 's1', app: { app: 'Chromium' }, geometry: true, wait: { minMs: 0, quietMs: 150, maxMs: 3000, busyMaxMs: 3000 } })
    const frame = /\[\d+\] group "Pay"[^@]*@(\d+),(\d+) (\d+)×(\d+)/.exec(read.text)
    expect(frame, read.text).toBeTruthy()
    const run = (action: Record<string, unknown>) => ok('action.run', { session: 's1', app: { app: 'Chromium' }, epoch, tiers: ['process'], action, observe: { mode: 'none' } })
    // the frame's own controls are read under it, and a point in it lands there (away from its button: this is no Work thread)
    expect(read.text).toMatch(/\[\d+\] group "Pay"[^\n]*\n\s+\[\d+\] web area[^\n]*\n\s+\[\d+\] button "Pay now" @\d+,\d+/)
    const into = await run({ action: 'left_click', coordinate: [Number(frame![1]) + Number(frame![3]) - 10, Number(frame![2]) + Number(frame![4]) - 10] })
    expect(into.step).toMatchObject({ status: 'ok' })
    const covered = await run({ action: 'left_click', element: lineOf(read.text, /button "Cancel"/) })
    expect(covered.step).toMatchObject({ status: 'failed', error: { kind: 'action_unsupported', message: expect.stringMatching(/something else covers/) } })
    expect(site.posts).toEqual([])
  })

  it('reads frames of this origin and of another in place, and clicks inside both', async () => {
    await ok('apps.launch', { app: 'Chromium', open: [site.url + '/frames'], session: 's1' })
    let read = { text: '' } as Observation
    for (let i = 0; i < 30 && !/button "Pay now"/.test(read.text); i++)
      read = await ok('state.get', { session: 's1', app: { app: 'Chromium' }, geometry: true, wait: { minMs: 100, quietMs: 150, maxMs: 2000, busyMaxMs: 2000 } })
    expect(() => parseObservation(read.text)).not.toThrow()
    const box = (re: RegExp) => {
      const m = new RegExp(`${re.source}[^\\n]*@(\\d+),(\\d+) (\\d+)×(\\d+)`).exec(read.text)
      expect(m, `${re} in\n${read.text}`).toBeTruthy()
      return m!.slice(1).map(Number)
    }
    const within = (inner: number[], outer: number[]) =>
      inner[0]! >= outer[0]! && inner[1]! >= outer[1]! && inner[0]! + inner[2]! <= outer[0]! + outer[2]! && inner[1]! + inner[3]! <= outer[1]! + outer[3]!
    expect(within(box(/button "Post comment"/), box(/group "Comments"/))).toBe(true)
    expect(within(box(/button "Pay now"/), box(/group "Payment"/))).toBe(true)
    for (const field of [/input "Comment"/, /input "Card name"/]) {
      const r = await ok('action.run', { session: 's1', app: { app: 'Chromium' }, epoch, tiers: ['process'], action: { action: 'left_click', element: lineOf(read.text, field) }, observe: { mode: 'full' } })
      expect(r.step, JSON.stringify(r.step)).toMatchObject({ status: 'ok' })
      expect(r.observation!.text).toMatch(new RegExp(`${field.source} focused`))
    }
  })

  const quiet = { minMs: 0, quietMs: 150, maxMs: 3000, busyMaxMs: 3000 }
  const app = { app: 'Chromium' }

  it('clicks an input laid under its own card, and a button under a layer that takes no pointer events', async () => {
    await ok('apps.launch', { app: 'Chromium', open: [site.url + '/cards'], session: 's1' })
    const read = await ok('state.get', { session: 's1', app, wait: quiet })
    const title = lineOf(read.text, /input "Question title"/)
    const tile = lineOf(read.text, /button "RecWell Total"/)
    const r = await ok('action.batch', {
      session: 's1',
      app,
      epoch,
      tiers: ['process'],
      actions: [{ action: 'left_click', element: title }, { action: 'type', text: 'Pick a night' }, { action: 'left_click', element: tile }],
      wait: quiet
    })
    expect(r.steps.map((s) => s.status), JSON.stringify(r.steps)).toEqual(['ok', 'ok', 'ok'])
    expect(r.observation!.text).toContain(`[${title}] input "Question title" = "Pick a night"`)
    expect(r.observation!.text).toMatch(/button "Opened"/)
  })

  it('keeps a window by its id when its title changes, and takes the id as words', async () => {
    const before = await ok('state.get', { session: 's1', app })
    expect(before.window.title).toBe('Pick a night')
    const id = before.window.id
    const title = lineOf(before.text, /input "Question title"/)
    const r = await ok('action.run', { session: 's1', app, epoch, tiers: ['process'], action: { action: 'set_value', element: title, value: 'Which night?' }, observe: { mode: 'none' } })
    expect(r.step.status).toBe('ok')
    expect((await ok('state.get', { session: 's1', app, window: { id } })).window).toMatchObject({ id, title: 'Which night?' })
    expect((await ok('state.get', { session: 's1', app, window: { title: `#${id}` } })).window).toMatchObject({ id, title: 'Which night?' })
    expect((await no('state.get', { session: 's1', app, window: { title: 'Pick a night' } })).data?.kind).toBe('window_not_found')
    const listed = await ok('apps.list', { windows: true })
    expect(listed.apps[0]!.windows!.find((w) => w.id === id)?.title).toBe('Which night?')
  })

  it("refuses a thread Forms pages before the request leaves and at a batch's later step; the carrier's session goes in", async () => {
    // the test site's other name stands in for Forms
    setCarrierOnlyHostsForTest(['localhost'])
    try {
      const forms = `${site.url.replace('127.0.0.1', 'localhost')}/forms`
      expect((await no('apps.launch', { app: 'Chromium', open: [forms], session: 's1' })).data).toMatchObject({
        kind: 'open_refused',
        message: 'refused: Microsoft Forms pages are reached only through the msform tools; nothing was opened.'
      })
      const here = await ok('state.get', { session: 's1', app })
      const address = lineOf(here.text, /input "Address and search bar"/)
      const typed = await ok('action.batch', {
        session: 's1',
        app,
        epoch,
        tiers: ['process'],
        actions: [{ action: 'set_value', element: address, value: forms }, { action: 'key', text: 'Return' }, { action: 'type', text: 'x' }]
      })
      expect(typed.steps.map((s) => s.status)).toEqual(['ok', 'failed', 'not-run'])
      expect(typed.steps[1]!.status === 'failed' && typed.steps[1]!.error.kind).toBe('open_refused')
      expect(site.asked).not.toContain('/forms')
      // a link the page follows itself: the step after it is refused, and so is the closing read
      const followed = await ok('action.batch', {
        session: 's1',
        app,
        epoch,
        tiers: ['process'],
        actions: [{ action: 'left_click', element: lineOf(here.text, /link "Open the form"/) }, { action: 'type', text: 'x' }],
        stepWait: quiet
      })
      expect(followed.steps.map((s) => s.status), JSON.stringify(followed.steps)).toEqual(['ok', 'failed'])
      expect(followed.steps[1]!.status === 'failed' && followed.steps[1]!.error.message).toMatch(/^refused: Microsoft Forms pages .*nothing on that page was read or done\.$/)
      expect(followed.observationError?.kind).toBe('open_refused')
      // the thread is shown no window on Forms, and its own page there is not read
      const shown = await ok('apps.list', { windows: true })
      expect(shown.apps[0]!.windows!.some((w) => w.title === 'Microsoft Forms')).toBe(false)
      expect((await no('state.get', { session: 's1', app })).data?.kind).toBe('open_refused')

      const carrier = carrierSession()
      try {
        const opened = await ok('apps.launch', { app: 'Chromium', open: [forms], session: carrier })
        expect(opened.window).toBeTruthy()
        const read = await ok('state.get', { session: carrier, app, wait: quiet })
        expect(read.window).toMatchObject({ id: opened.window!.id, title: 'Microsoft Forms' })
        const q = lineOf(read.text, /input "Question title"/)
        const r = await ok('action.batch', { session: carrier, app, epoch, tiers: ['process'], actions: [{ action: 'left_click', element: q }, { action: 'type', text: 'Which night?' }], wait: quiet })
        expect(r.steps.map((s) => s.status)).toEqual(['ok', 'ok'])
        expect(r.observation!.text).toContain(`[${q}] input "Question title" = "Which night?"`)
        // its own page loads again at its own address (a kept builder, msforms carrier/wire.ts); no other session's reload reaches it
        await expect(svc.carrierReload(read.window.id, 's1')).rejects.toThrow('no such window')
        await svc.carrierReload(read.window.id, carrier)
        const again = await ok('state.get', { session: carrier, app, wait: quiet })
        expect(again.text).not.toContain('"Which night?"')
        // the carrier takes no picture of what it drives, asked or not (review 21), and follows no redirect (review 24)
        expect((await no('capture.screenshot', { session: carrier, app, window: { id: read.window.id } })).data?.kind).toBe('capture_failed')
        expect((await ok('state.get', { session: carrier, app, screenshot: 'always' })).shot).toBeUndefined()
        expect(await svc.carrierFetch(read.window.id, `${site.url.replace('127.0.0.1', 'localhost')}/hop`, {}, carrier)).toMatchObject({ status: 0 })
        // the carrier's window is no thread's, by id or as its last page: to a thread it is not there at all (review 2)
        expect((await no('state.get', { session: 's1', app, window: { id: read.window.id } })).data?.kind).toBe('window_not_found')
      } finally {
        await svc.carrierRelease(carrier)
        endCarrierSession(carrier)
      }
    } finally {
      setCarrierOnlyHostsForTest(null)
    }
  })

  it('keeps every page the carrier opens, and the popups they open, from every other session, and closes them all at its release (review 2)', async () => {
    const carrier = carrierSession()
    try {
      const opened = await ok('apps.launch', { app: 'Chromium', open: [site.url + '/'], session: carrier })
      const mine = opened.window!.id
      // the carrier's page opens a popup (Excel for the web's workbook, in a pull): it is the carrier's from the first list
      const service = svc as unknown as { pages(): Promise<{ targetId: string; window: number }[]>; on(p: unknown): Promise<{ cdp: { send(m: string, p: unknown, s: string): Promise<unknown> }; sid: string }> }
      const page = (await service.pages()).find((p) => p.window === mine)!
      const { cdp, sid } = await service.on(page)
      await cdp.send('Runtime.evaluate', { expression: `window.open(${JSON.stringify(site.url + '/')}, '_blank'); 1`, userGesture: true }, sid)
      const owned = () => [...CARRIER_TARGETS].filter(([, s]) => s === carrier).map(([t]) => t)
      for (let i = 0; i < 50 && owned().length < 2; i++) {
        await service.pages()
        await new Promise((r) => setTimeout(r, 100))
      }
      expect(owned()).toHaveLength(2)
      const windows = (await service.pages()).filter((p) => owned().includes(p.targetId)).map((p) => p.window)
      // no thread lists either, reads either by its id, or takes either as its page
      const listed = (await ok('apps.list', { windows: true })).apps[0]!.windows!.map((w) => w.id)
      for (const w of windows) {
        expect(listed).not.toContain(w)
        expect((await no('state.get', { session: 's1', app, window: { id: w } })).data?.kind).toBe('window_not_found')
        expect((await no('capture.screenshot', { session: 's1', app, window: { id: w } })).data?.kind).toBe('window_not_found')
      }
      expect((await ok('state.get', { session: 's1', app })).window.id).not.toBe(mine)
      // nor does another carrier
      const other = carrierSession()
      expect((await svc.carrierPages(other)).map((p) => p.window).filter((w) => windows.includes(w))).toEqual([])
      endCarrierSession(other)
      // its own list holds both, and its release closes both
      expect((await svc.carrierPages(carrier)).map((p) => p.window)).toEqual(expect.arrayContaining(windows))
      expect(await svc.carrierRelease(carrier)).toEqual({ closed: 2, kept: 0 })
      // a closed page is never shown to another while Chromium still lists it, and is gone soon after
      const left = async () => (await service.pages()).map((p) => p.window).filter((w) => windows.includes(w))
      for (let i = 0; i < 30 && (await left()).length; i++) {
        expect((await ok('apps.list', { windows: true })).apps[0]!.windows!.map((w) => w.id).filter((w) => windows.includes(w))).toEqual([])
        await new Promise((r) => setTimeout(r, 100))
      }
      expect(await left()).toEqual([])
      expect(owned()).toEqual([])
    } finally {
      endCarrierSession(carrier)
    }
  })

  it('refuses stale and unknown elements before anything runs', async () => {
    expect((await no('action.run', { session: 's1', app: { app: 'Chromium' }, epoch: 'old', tiers: ['process'], action: { action: 'left_click', element: 3 } })).data).toMatchObject({ kind: 'stale_element', reason: 'service-restarted' })
    expect((await no('action.run', { session: 's1', app: { app: 'Chromium' }, epoch, tiers: ['process'], action: { action: 'left_click', element: 99_999 } })).data?.kind).toBe('no_such_element')
  })

  it('takes pictures, reads a subtree, and shuts down', async () => {
    const shot = await ok('capture.screenshot', { session: 's1', app: { app: 'Chromium' }, maxEdge: 640 })
    expect(Math.max(shot.width, shot.height)).toBeLessThanOrEqual(640)
    // the page was navigated since: its old elements are gone, and say so
    const old = lineOf(obs.text, /button "Next"/)
    expect((await no('state.get', { session: 's1', app: { app: 'Chromium' }, window: { title: 'Expense portal' }, element: old, epoch })).data).toMatchObject({ kind: 'stale_element', reason: 'gone' })
    const portal = { title: 'Expense portal' }
    const now = await ok('state.get', { session: 's1', app: { app: 'Chromium' }, window: portal })
    const form = lineOf(now.text, /button "Next"/)
    const sub = await ok('state.get', { session: 's1', app: { app: 'Chromium' }, window: portal, element: form, epoch })
    expect(sub.kind).toBe('subtree')
    await ok('session.close', { session: 's1' })
    // the live picture: frames as notifications, paced by the host's acks, until the stop
    const started = await ok('capture.stream.start', { session: 's1', app: { app: 'Chromium' }, window: portal, stream: 'pv_1', fps: 4, maxEdge: 480 })
    expect(Math.max(started.width, started.height)).toBe(480)
    for (let i = 0; i < 50 && !notes.some((n) => n.method === 'capture/frame'); i++) await new Promise((r) => setTimeout(r, 100))
    const frame = notes.find((n) => n.method === 'capture/frame')
    expect(frame?.params).toMatchObject({ stream: 'pv_1', seq: 1, format: 'jpeg' })
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'capture.stream.ack', params: { stream: 'pv_1', seq: 1 } })}\n`)
    await ok('capture.stream.stop', { stream: 'pv_1' })
  })

  it("empties the browser's last page rather than close it, so a headed browser does not quit with it (P1)", async () => {
    for (const p of (await svc.carrierPages()).slice(1)) await svc.carrierClose(p.window)
    const [last] = await svc.carrierPages()
    await svc.carrierClose(last!.window)
    let after = await svc.carrierPages()
    for (let i = 0; i < 30 && after[0]?.url !== 'about:blank'; i++) {
      await new Promise((r) => setTimeout(r, 100))
      after = await svc.carrierPages()
    }
    expect(after).toEqual([{ window: last!.window, url: 'about:blank', target: last!.target }])
    await ok('shutdown')
  })
})
