import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import type { PassThrough } from 'node:stream'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parseObservation } from '@shared/computer/observation'
import { COMPUTER_PROTOCOL, resultFrameSchema, RpcErrorResponseSchema, type ComputerMethod, type ComputerResult, type Observation } from '@shared/computer/protocol'
import { BoxChromium, findChromium } from './chromium'
import { BoxComputerService, inProcessSpawn } from './service'
import { serveTestSite, type TestSite } from './testSite'

/**
 * The wire conformance test for the Linux service (docs/computer-protocol.md
 * §28.4): every method of §3 answered over the stdio pair, each frame
 * checked against the wire's zod (`resultFrameSchema`, `RpcErrorResponseSchema`),
 * every observation's text through the grammar's own parser, against the
 * box's real Chromium on a local test site. Skipped where no Chromium is.
 */

const bin = findChromium()
const d = bin && process.platform === 'linux' ? describe : describe.skip

type Frame = { id: number; result?: unknown; error?: unknown }

d('the box computer service speaks the wire', () => {
  let root: string
  let browser: BoxChromium
  let site: TestSite
  let child: { stdin: PassThrough; stdout: PassThrough; kill(): boolean }
  const answers = new Map<number, (f: Frame) => void>()
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
    browser = new BoxChromium({ root, bin: () => bin })
    site = await serveTestSite()
    const spawn = inProcessSpawn(() => new BoxComputerService({ browser: { endpoint: () => browser.endpoint(), pid: () => null, touch: () => browser.touch() } }))
    child = spawn('box', ['serve']) as never
    createInterface({ input: child.stdout }).on('line', (line) => {
      const f = JSON.parse(line) as Frame
      expect((f as { jsonrpc?: string }).jsonrpc).toBe('2.0')
      answers.get(f.id)?.(f)
    })
  }, 30_000)

  afterAll(async () => {
    child?.kill()
    browser?.stop()
    await site?.close()
    rmSync(root, { recursive: true, force: true })
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
    expect((await no('capture.stream.start', { session: 's1', app: { app: 'Chromium' }, stream: 'x' })).data?.kind).toBe('capture_failed')
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

  it('refuses stale and unknown elements before anything runs', async () => {
    expect((await no('action.run', { session: 's1', app: { app: 'Chromium' }, epoch: 'old', tiers: ['process'], action: { action: 'left_click', element: 3 } })).data).toMatchObject({ kind: 'stale_element', reason: 'service-restarted' })
    expect((await no('action.run', { session: 's1', app: { app: 'Chromium' }, epoch, tiers: ['process'], action: { action: 'left_click', element: 99_999 } })).data?.kind).toBe('no_such_element')
  })

  it('takes pictures, reads a subtree, and shuts down', async () => {
    const shot = await ok('capture.screenshot', { session: 's1', app: { app: 'Chromium' }, maxEdge: 640 })
    expect(Math.max(shot.width, shot.height)).toBeLessThanOrEqual(640)
    // the page was navigated since: its old elements are gone, and say so
    const old = lineOf(obs.text, /button "Next"/)
    expect((await no('state.get', { session: 's1', app: { app: 'Chromium' }, element: old, epoch })).data).toMatchObject({ kind: 'stale_element', reason: 'gone' })
    const now = await ok('state.get', { session: 's1', app: { app: 'Chromium' } })
    const form = lineOf(now.text, /button "Next"/)
    const sub = await ok('state.get', { session: 's1', app: { app: 'Chromium' }, element: form, epoch })
    expect(sub.kind).toBe('subtree')
    await ok('session.close', { session: 's1' })
    await ok('capture.stream.stop', { stream: 'x' })
    await ok('shutdown')
  })
})
