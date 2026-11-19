import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdirSync, writeFileSync } from 'node:fs'
import { arch, release } from 'node:os'
import { join } from 'node:path'
import { PassThrough, type Readable, type Writable } from 'node:stream'
import { createInterface } from 'node:readline'
import type { spawn as nodeSpawn } from 'node:child_process'
import {
  COMPUTER_METHODS,
  COMPUTER_PROTOCOL,
  RPC_ERROR,
  type ComputerAction,
  type ComputerError,
  type ComputerMethod,
  type ComputerParams,
  type ComputerResult,
  type Observation,
  type Shot,
  type StepResult,
  type Tier,
  type WaitOptions,
  type WaitReport
} from '@shared/computer/protocol'
import { hasRoleDefault, parseKeyCombo, parseModifiers, type LineFrame, type Modifier } from '@shared/computer/observation'
import { ADDRESS_NAME, IndexBook, observationText, readTree, withChrome, type AxNode, type ReadTree } from './ax'
import { Cdp } from './cdp'

/**
 * The Linux computer-use service (docs/computer-protocol.md §28): the wire
 * of `tc-computer` (newline JSON-RPC 2.0, every method of §3, the
 * observation grammar of §4), answered for the box's Chromium over the
 * DevTools protocol. It runs in the host's process behind a stdio pair, so
 * the host's `ComputerService`, sessions, tools and the hold (run.ts) drive
 * it exactly as they drive the Mac's service.
 *
 * One app, "Chromium", whose windows are its pages. Input goes into the
 * page by DevTools (`process` tier): it never touches a person's pointer
 * or keyboard, and the box has none. Only http and https pages open.
 */

export const BOX_BROWSER_APP = { name: 'Chromium', bundleId: 'org.chromium.Chromium' } as const

export interface BrowserLink {
  endpoint(): Promise<string>
  pid(): number | null
  touch(): void
}

class Refused extends Error {
  constructor(readonly error: ComputerError) {
    super(error.message)
  }
}
const refuse = (kind: ComputerError['kind'], message: string, more: Partial<ComputerError> = {}): never => {
  throw new Refused({ kind, message, ...more })
}

interface Page {
  targetId: string
  window: number
  title: string
  url: string
}

interface SessionState {
  book: IndexBook
  seq: number
  pointer: [number, number] | null
  /** the address bar: focused, and what was typed into it */
  address: { focused: boolean; draft: string | null; page: string | null }
  shots: number
  /** the named elements of the last read, controls first: what a `named` target finds */
  names: { name: string; index: number }[]
}

const SAFE_URL = /^(https?:\/\/|about:blank$)/i

export const MODIFIER_BITS: Record<Modifier, number> = { alt: 1, ctrl: 2, super: 4, shift: 8 }

/** A key as DevTools dispatches it. */
export function keyOf(name: string): { key: string; code: string; keyCode: number; text?: string } {
  const named: Record<string, [string, string, number, string?]> = {
    Return: ['Enter', 'Enter', 13, '\r'],
    Tab: ['Tab', 'Tab', 9],
    Escape: ['Escape', 'Escape', 27],
    BackSpace: ['Backspace', 'Backspace', 8],
    Delete: ['Delete', 'Delete', 46],
    space: [' ', 'Space', 32, ' '],
    Up: ['ArrowUp', 'ArrowUp', 38],
    Down: ['ArrowDown', 'ArrowDown', 40],
    Left: ['ArrowLeft', 'ArrowLeft', 37],
    Right: ['ArrowRight', 'ArrowRight', 39],
    Home: ['Home', 'Home', 36],
    End: ['End', 'End', 35],
    Page_Up: ['PageUp', 'PageUp', 33],
    Page_Down: ['PageDown', 'PageDown', 34]
  }
  const n = named[name]
  if (n) return { key: n[0], code: n[1], keyCode: n[2], ...(n[3] ? { text: n[3] } : {}) }
  if (/^F([1-9]|1[0-2])$/.test(name)) return { key: name, code: name, keyCode: 111 + Number(name.slice(1)) }
  if ([...name].length === 1) {
    const up = name.toUpperCase()
    const code = /[a-z]/i.test(name) ? `Key${up}` : /\d/.test(name) ? `Digit${name}` : ''
    return { key: name, code, keyCode: up.charCodeAt(0), text: name }
  }
  return refuse('invalid_key', `"${name}" is not a key this service knows`)
}

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true })
  })

export interface BoxServiceOptions {
  browser: BrowserLink
  /** run on every use of the browser, after its connection is up: the login import's check */
  use?: (cdp: Cdp) => Promise<unknown>
  now?: () => number
  log?: (line: string) => void
}

export class BoxComputerService {
  readonly epoch = randomUUID()
  private cdp: Cdp | null = null
  private connecting: Promise<Cdp> | null = null
  private readonly attached = new Map<string, string>()
  private readonly windows = new Map<string, number>()
  private nextWindow = 1
  private mainTarget: string | null = null
  private readonly sessions = new Map<string, SessionState>()
  private initialized = false
  private dataDir = ''
  private readonly startedAt: number
  private readonly running = new Map<number, AbortController>()

  constructor(private readonly opts: BoxServiceOptions) {
    this.startedAt = this.now()
  }

  private now(): number {
    return (this.opts.now ?? Date.now)()
  }

  // ── the wire ─────────────────────────────────────────────────────────

  /** Reads frames from `input` and answers on `output` until EOF or `shutdown`. */
  serve(input: Readable, output: Writable): Promise<void> {
    const write = (frame: object) => output.write(`${JSON.stringify(frame)}\n`)
    return new Promise((resolve) => {
      const lines = createInterface({ input })
      const end = () => {
        lines.close()
        this.close()
        resolve()
      }
      lines.on('close', end)
      lines.on('line', (line) => {
        let frame: { id?: number; method?: string; params?: Record<string, unknown> }
        try {
          frame = JSON.parse(line)
        } catch {
          return void write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } })
        }
        if (frame.method === '$/cancel') return void this.running.get(Number(frame.params?.id))?.abort()
        if (frame.id === undefined || !frame.method) return
        const id = frame.id
        void this.answer(frame.method, frame.params ?? {}, id).then((reply) => {
          write({ jsonrpc: '2.0', id, ...reply })
          if (frame.method === 'shutdown' && 'result' in reply) setImmediate(end)
        })
      })
    })
  }

  private async answer(method: string, raw: unknown, id: number): Promise<{ result: unknown } | { error: { code: number; message: string; data?: ComputerError } }> {
    if (!(method in COMPUTER_METHODS)) return { error: { code: -32601, message: `no method ${method}` } }
    const m = method as ComputerMethod
    const parsed = COMPUTER_METHODS[m].params.safeParse(raw)
    if (!parsed.success) return { error: { code: -32602, message: `invalid params: ${parsed.error.issues[0]?.message ?? 'bad shape'}` } }
    if (m !== 'initialize' && !this.initialized)
      return { error: { code: RPC_ERROR.computer, message: 'initialize first', data: { kind: 'not_initialized', message: 'initialize first' } } }
    const abort = new AbortController()
    this.running.set(id, abort)
    try {
      return { result: await this.handle(m, parsed.data as never, abort.signal) }
    } catch (err) {
      const data: ComputerError =
        err instanceof Refused ? err.error : abort.signal.aborted ? { kind: 'cancelled', message: 'cancelled' } : { kind: 'timeout', message: `the browser did not answer: ${(err as Error).message}` }
      return { error: { code: RPC_ERROR.computer, message: data.message, data } }
    } finally {
      this.running.delete(id)
    }
  }

  private async handle<M extends ComputerMethod>(method: M, p: ComputerParams<M>, signal: AbortSignal): Promise<ComputerResult<M>> {
    const params = p as Record<string, unknown> & ComputerParams<M>
    switch (method) {
      case 'initialize': {
        const q = params as ComputerParams<'initialize'>
        if (q.protocol !== COMPUTER_PROTOCOL) refuse('protocol_mismatch', `this service speaks protocol ${COMPUTER_PROTOCOL}`)
        this.initialized = true
        this.dataDir = q.dataDir
        return {
          protocol: COMPUTER_PROTOCOL,
          service: { version: '1', build: 'box-cdp' },
          epoch: this.epoch,
          os: { version: `Linux ${release()}`, arch: arch() },
          permissions: { accessibility: true, screenRecording: true },
          displays: [{ id: 1, frame: { x: 0, y: 0, w: 1280, h: 800 }, scale: 1 }],
          features: []
        } as ComputerResult<M>
      }
      case 'shutdown':
      case 'escape.watch':
      case 'capture.stream.stop':
        return {} as ComputerResult<M>
      case 'permissions.get':
      case 'permissions.request':
        return { accessibility: true, screenRecording: true } as ComputerResult<M>
      case 'session.open':
        this.session(String(params.session))
        return {} as ComputerResult<M>
      case 'session.close':
        this.sessions.delete(String(params.session))
        return {} as ComputerResult<M>
      case 'clipboard.state':
        return { changeCount: 0, foreignChangeAt: null, watchingSince: this.startedAt } as ComputerResult<M>
      case 'input.restoreSession':
        return { frontmost: 'nothing', pointer: 'nothing', held: null } as ComputerResult<M>
      case 'input.probe': {
        const q = params as ComputerParams<'input.probe'>
        this.appOf(q.app)
        return {
          pid: this.pid(),
          bundleId: BOX_BROWSER_APP.bundleId,
          keyWindow: 'target',
          results: (q.classes ?? ['scroll', 'key', 'click']).map((c) => ({ class: c, outcome: 'honoured' as const, restored: true, ms: 0 }))
        } as ComputerResult<M>
      }
      case 'capture.stream.start':
        return refuse('capture_failed', 'the box browser has no live stream yet; read the page or take a screenshot')
      case 'apps.list': {
        const pages = await this.pages()
        return { apps: [this.appInfo(pages, (params as ComputerParams<'apps.list'>).windows === true)] } as ComputerResult<M>
      }
      case 'apps.launch':
        return (await this.launch(params as ComputerParams<'apps.launch'>)) as ComputerResult<M>
      case 'state.get':
        return (await this.stateGet(params as ComputerParams<'state.get'>, signal)) as ComputerResult<M>
      case 'action.run': {
        const q = params as ComputerParams<'action.run'>
        const r = await this.runSteps(q, [q.action], q.wait, q.wait, signal)
        return { step: r.steps[0]!, ...r.closing } as ComputerResult<M>
      }
      case 'action.batch': {
        const q = params as ComputerParams<'action.batch'>
        const r = await this.runSteps(q, q.actions, q.stepWait, q.wait, signal)
        return { steps: r.steps, waited: r.waited, ...r.closing } as ComputerResult<M>
      }
      case 'capture.screenshot': {
        const q = params as ComputerParams<'capture.screenshot'>
        this.appOf(q.app)
        const page = await this.pageOf(q.window)
        return (await this.shot(q.session, page, { maxEdge: q.maxEdge, region: q.region, format: q.format })) as ComputerResult<M>
      }
    }
    return refuse('action_unsupported', `${method} is not served on the box`)
  }

  close(): void {
    for (const a of this.running.values()) a.abort()
    this.cdp?.close()
    this.cdp = null
  }

  // ── the browser ──────────────────────────────────────────────────────

  private async browser(): Promise<Cdp> {
    const cdp = await this.connect()
    await this.opts.use?.(cdp).catch((err) => this.opts.log?.(`box browser: ${(err as Error).message}`))
    return cdp
  }

  private async connect(): Promise<Cdp> {
    this.opts.browser.touch()
    if (this.cdp?.alive) return this.cdp
    this.connecting ??= (async () => {
      const cdp = await Cdp.open(await this.opts.browser.endpoint())
      this.attached.clear()
      cdp.onClose(() => {
        if (this.cdp === cdp) this.cdp = null
        this.attached.clear()
      })
      cdp.on('Target.detachedFromTarget', (p) => {
        for (const [t, s] of this.attached) if (s === p.sessionId) this.attached.delete(t)
      })
      this.cdp = cdp
      return cdp
    })().finally(() => (this.connecting = null))
    return this.connecting
  }

  private pid(): number {
    return this.opts.browser.pid() ?? 1
  }

  private async pages(): Promise<Page[]> {
    const cdp = await this.browser()
    const { targetInfos } = await cdp.send<{ targetInfos: { targetId: string; type: string; title: string; url: string }[] }>('Target.getTargets')
    const pages = targetInfos.filter((t) => t.type === 'page')
    for (const id of [...this.windows.keys()]) if (!pages.some((t) => t.targetId === id)) this.forgetPage(id)
    return pages.map((t) => {
      if (!this.windows.has(t.targetId)) this.windows.set(t.targetId, this.nextWindow++)
      return { targetId: t.targetId, window: this.windows.get(t.targetId)!, title: t.title, url: t.url }
    })
  }

  private forgetPage(targetId: string): void {
    this.windows.delete(targetId)
    this.attached.delete(targetId)
    if (this.mainTarget === targetId) this.mainTarget = null
    for (const s of this.sessions.values()) s.book.forget(`${targetId}:`)
  }

  private appInfo(pages: Page[], windows: boolean) {
    const main = this.mainOf(pages)
    return {
      pid: this.pid(),
      bundleId: BOX_BROWSER_APP.bundleId,
      name: BOX_BROWSER_APP.name,
      active: true,
      hidden: false,
      ...(windows
        ? {
            windows: pages.map((p) => ({
              id: p.window,
              title: p.title,
              frame: { x: 0, y: 0, w: 1280, h: 800 },
              main: p === main,
              focused: p === main,
              minimized: false,
              onScreen: true,
              space: 'current' as const
            }))
          }
        : {})
    }
  }

  private mainOf(pages: Page[]): Page | undefined {
    return pages.find((p) => p.targetId === this.mainTarget) ?? pages[0]
  }

  /** Only the box's Chromium answers, by its name, its bundle id, a prefix of its name or its pid. */
  private appOf(ref: { app?: string; pid?: number }): void {
    if (ref.pid !== undefined) {
      if (ref.pid !== this.pid()) refuse('app_not_found', `no app with pid ${ref.pid} on the box`, { candidates: [BOX_BROWSER_APP.name] })
      return
    }
    const q = (ref.app ?? '').trim().toLowerCase()
    const names = [BOX_BROWSER_APP.name.toLowerCase(), BOX_BROWSER_APP.bundleId.toLowerCase(), 'chrome', 'google chrome', 'browser']
    if (!q || !(names.includes(q) || BOX_BROWSER_APP.name.toLowerCase().startsWith(q))) refuse('app_not_found', `the box has one app, its browser: "${BOX_BROWSER_APP.name}"`, { candidates: [BOX_BROWSER_APP.name] })
  }

  private async pageOf(ref: { id?: number; title?: string } | undefined): Promise<Page> {
    let pages = await this.pages()
    if (!pages.length) {
      await (await this.browser()).send('Target.createTarget', { url: 'about:blank' })
      pages = await this.pages()
    }
    let page: Page | undefined
    if (ref?.id !== undefined) page = pages.find((p) => p.window === ref.id)
    else if (ref?.title !== undefined) page = pages.find((p) => p.title === ref.title) ?? pages.find((p) => p.title.includes(ref.title!))
    else page = this.mainOf(pages)
    if (!page) return refuse('window_not_found', 'no such window in the box browser', { candidates: pages.map((p) => p.title) })
    this.mainTarget = page.targetId
    return page
  }

  /** A flat DevTools session on the page, its domains on. */
  private async on(page: Page): Promise<{ cdp: Cdp; sid: string }> {
    const cdp = await this.browser()
    let sid = this.attached.get(page.targetId)
    if (!sid) {
      sid = (await cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId: page.targetId, flatten: true })).sessionId
      this.attached.set(page.targetId, sid)
      await Promise.all(['Page.enable', 'DOM.enable', 'Accessibility.enable', 'Runtime.enable'].map((m) => cdp.send(m, {}, sid)))
    }
    return { cdp, sid }
  }

  private session(id: string): SessionState {
    let s = this.sessions.get(id)
    if (!s) {
      s = { book: new IndexBook(), seq: 0, pointer: null, address: { focused: false, draft: null, page: null }, shots: 0, names: [] }
      this.sessions.set(id, s)
    }
    return s
  }

  private async launch(q: ComputerParams<'apps.launch'>): Promise<ComputerResult<'apps.launch'>> {
    this.appOf({ app: q.app })
    if (q.refuse?.includes(BOX_BROWSER_APP.bundleId)) refuse('open_refused', 'that app is off limits to this call')
    const before = await this.pages()
    const launched = !this.opts.browser.pid()
    const open = q.open ?? []
    const bad = open.find((u) => !SAFE_URL.test(u))
    if (bad) refuse('open_refused', 'the box browser opens only http and https pages')
    const cdp = await this.browser()
    let window: { id: number; title: string } | undefined
    for (const url of open) {
      const blank = before.find((p) => p.url === 'about:blank')
      if (blank && !window) {
        const { cdp: c, sid } = await this.on(blank)
        await c.send('Page.navigate', { url }, sid)
        window = { id: blank.window, title: blank.title }
      } else {
        const { targetId } = await cdp.send<{ targetId: string }>('Target.createTarget', { url })
        const pages = await this.pages()
        const p = pages.find((x) => x.targetId === targetId)
        if (p && !window) window = { id: p.window, title: p.title }
      }
    }
    if (window) this.mainTarget = [...this.windows].find(([, w]) => w === window!.id)?.[0] ?? this.mainTarget
    return { pid: this.pid(), launched, ...(window ? { window } : {}) }
  }

  // ── reading ──────────────────────────────────────────────────────────

  private async read(sessionId: string, page: Page, o: { root?: number; geometry: boolean; screenshot: 'auto' | 'always' | 'never'; maxEdge?: number; budget?: number; full: boolean }): Promise<Observation> {
    const started = this.now()
    const s = this.session(sessionId)
    const { cdp, sid } = await this.on(page)
    const [{ nodes }, doc, metrics, state] = await Promise.all([
      cdp.send<{ nodes: AxNode[] }>('Accessibility.getFullAXTree', {}, sid),
      cdp.send<{ root: DomNode }>('DOM.getDocument', { depth: -1, pierce: true }, sid),
      cdp.send<{ cssVisualViewport: { clientWidth: number; clientHeight: number } }>('Page.getLayoutMetrics', {}, sid),
      cdp.send<{ result: { value?: { ready: string; title: string; url: string } } }>('Runtime.evaluate', { expression: '({ready: document.readyState, title: document.title, url: location.href})', returnByValue: true }, sid)
    ])
    const facts = state.result.value ?? { ready: 'complete', title: page.title, url: page.url }
    const passwords = new Set<number>()
    const walk = (n: DomNode) => {
      if (n.nodeName === 'INPUT' && attr(n, 'type')?.toLowerCase() === 'password') passwords.add(n.backendNodeId)
      for (const c of [...(n.children ?? []), ...(n.shadowRoots ?? []), ...(n.contentDocument ? [n.contentDocument] : [])]) walk(c)
    }
    walk(doc.root)
    const addressHere = s.address.focused && s.address.page === page.targetId
    let tree: ReadTree = readTree(nodes, s.book, { page: page.targetId, passwords, ...(o.root !== undefined ? { root: o.root } : {}) })
    const subtree = o.root !== undefined
    if (subtree && !tree.kept.length) {
      if (!s.book.nodes.has(o.root!)) refuse('no_such_element', `there is no element ${o.root}`, { element: o.root })
      if (!this.isChrome(s, o.root!, page)) refuse('stale_element', `element ${o.root} is gone`, { element: o.root, reason: 'gone' })
    }
    if (!subtree) tree = withChrome(tree, s.book, page.targetId, facts.title, facts.url, addressHere)
    if (!subtree) {
      const named = tree.kept.filter((k) => k.line.name).map((k) => ({ name: k.line.name!.toLowerCase(), index: k.line.index, control: hasRoleDefault(k.line.role) }))
      s.names = [...named.filter((n) => n.control), ...named.filter((n) => !n.control)]
    }
    const width = Math.max(1, Math.round(metrics.cssVisualViewport.clientWidth))
    const height = Math.max(1, Math.round(metrics.cssVisualViewport.clientHeight))
    const pre = observationText({ app: BOX_BROWSER_APP.name, window: facts.title, width, height, loading: facts.ready !== 'complete', others: [] }, tree, null, o.budget)
    const picture = o.screenshot === 'always' || (o.screenshot === 'auto' && pre.thin)
    const frames = o.geometry || picture ? await this.frames(cdp, sid, tree, width, height) : null
    const pages = await this.pages()
    const others = pages.filter((p) => p.targetId !== page.targetId).map((p) => p.title || p.url)
    const t = observationText({ app: BOX_BROWSER_APP.name, window: facts.title, width, height, loading: facts.ready !== 'complete', others }, tree, frames, o.budget)
    let shot: Shot | undefined
    let shotError: ComputerError | undefined
    if (picture)
      try {
        shot = await this.shot(sessionId, page, { maxEdge: o.maxEdge })
      } catch (err) {
        shotError = err instanceof Refused ? err.error : { kind: 'capture_failed', message: (err as Error).message }
      }
    if (!subtree) s.seq += 1
    return {
      epoch: this.epoch,
      session: sessionId,
      app: { pid: this.pid(), bundleId: BOX_BROWSER_APP.bundleId, name: BOX_BROWSER_APP.name },
      window: { id: page.window, title: facts.title, frame: { x: 0, y: 0, w: width, h: height } },
      kind: subtree ? 'subtree' : 'full',
      seq: s.seq,
      text: t.text,
      space: { width, height, scale: 1 },
      stats: { elements: tree.kept.length, lines: t.lines, bytes: Buffer.byteLength(t.text), omitted: t.omitted, thin: t.thin, partial: false, readMs: Math.max(0, Math.round(this.now() - started)) },
      ...(shot ? { shot } : {}),
      ...(shotError ? { shotError } : {})
    }
  }

  private isChrome(s: SessionState, index: number, page: Page): boolean {
    const k = s.book.nodes.get(index)?.key
    return k === `${page.targetId}:window` || k === `${page.targetId}:address`
  }

  /** Each kept element's box in the page's pixels; the window and the address bar sit over the whole page and its top. */
  private async frames(cdp: Cdp, sid: string, tree: ReadTree, width: number, height: number): Promise<Map<number, LineFrame>> {
    const out = new Map<number, LineFrame>()
    const nodes = tree.kept.filter((k) => k.backend !== null).slice(0, 600)
    await Promise.all(
      nodes.map(async (k) => {
        try {
          const { model } = await cdp.send<{ model: { border: number[] } }>('DOM.getBoxModel', { backendNodeId: k.backend }, sid)
          const xs = model.border.filter((_, i) => i % 2 === 0)
          const ys = model.border.filter((_, i) => i % 2 === 1)
          const x = Math.round(Math.min(...xs))
          const y = Math.round(Math.min(...ys))
          out.set(k.line.index, { x, y, w: Math.max(0, Math.round(Math.max(...xs)) - x), h: Math.max(0, Math.round(Math.max(...ys)) - y) })
        } catch {
          // not laid out: no frame
        }
      })
    )
    for (const k of tree.kept) if (k.backend === null && k.line.role === 'window') out.set(k.line.index, { x: 0, y: 0, w: width, h: height })
    return out
  }

  private async stateGet(q: ComputerParams<'state.get'>, signal: AbortSignal): Promise<Observation> {
    this.appOf(q.app)
    this.checkEpoch(q.epoch, q.element !== undefined ? [q.element] : [])
    const page = await this.pageOf(q.window)
    if (q.wait) await this.settle(page, q.wait, signal)
    return this.read(q.session, page, { ...(q.element !== undefined ? { root: q.element } : {}), geometry: q.geometry === true, screenshot: q.screenshot ?? 'auto', maxEdge: q.maxEdge, budget: q.budget?.bytes, full: true })
  }

  private checkEpoch(epoch: string | undefined, elements: number[]): void {
    if (elements.length && epoch !== undefined && epoch !== this.epoch)
      refuse('stale_element', 'the service restarted since that read; read the window again', { element: elements[0], reason: 'service-restarted' })
  }

  /** The smart wait (§7), for a page: until the document is complete and nothing moved for `quietMs`, at most `maxMs`. */
  private async settle(page: Page, w: WaitOptions, signal?: AbortSignal): Promise<WaitReport> {
    const start = this.now()
    await sleep(w.minMs, signal)
    if (signal?.aborted) return { waitedMs: Math.round(this.now() - start), settled: false, busy: false, reason: 'cancelled' }
    const { cdp, sid } = await this.on(page)
    let quietSince = this.now()
    let last = ''
    while (this.now() - start < w.maxMs) {
      if (signal?.aborted) return { waitedMs: Math.round(this.now() - start), settled: false, busy: false, reason: 'cancelled' }
      const r = await cdp
        .send<{ result: { value?: string } }>('Runtime.evaluate', { expression: 'document.readyState + "|" + location.href + "|" + document.getElementsByTagName("*").length', returnByValue: true }, sid)
        .catch(() => ({ result: { value: 'loading' } }))
      const now = r.result.value ?? ''
      if (now !== last) {
        last = now
        quietSince = this.now()
      }
      if (now.startsWith('complete') && this.now() - quietSince >= w.quietMs) return { waitedMs: Math.round(this.now() - start), settled: true, busy: false, reason: 'quiet' }
      await sleep(50, signal)
    }
    return { waitedMs: Math.round(this.now() - start), settled: false, busy: false, reason: 'max' }
  }

  private async shot(sessionId: string, page: Page, o: { maxEdge?: number; region?: number[]; format?: 'jpeg' | 'png' }): Promise<Shot> {
    const { cdp, sid } = await this.on(page)
    const m = await cdp.send<{ cssVisualViewport: { clientWidth: number; clientHeight: number } }>('Page.getLayoutMetrics', {}, sid)
    const vw = Math.round(m.cssVisualViewport.clientWidth)
    const vh = Math.round(m.cssVisualViewport.clientHeight)
    const [x0, y0, x1, y1] = o.region ?? [0, 0, vw, vh]
    const w = Math.max(1, x1! - x0!)
    const h = Math.max(1, y1! - y0!)
    const scale = Math.min(1, (o.maxEdge ?? 1568) / Math.max(w, h))
    const format = o.format ?? 'jpeg'
    let data: string
    try {
      ;({ data } = await cdp.send<{ data: string }>('Page.captureScreenshot', { format, ...(format === 'jpeg' ? { quality: 80 } : {}), clip: { x: x0, y: y0, width: w, height: h, scale } }, sid))
    } catch (err) {
      return refuse('capture_failed', `the page could not be captured: ${(err as Error).message}`)
    }
    const s = this.session(sessionId)
    const dir = join(this.dataDir, 'shots', sessionId)
    mkdirSync(dir, { recursive: true })
    const path = join(dir, `${++s.shots}.${format === 'jpeg' ? 'jpg' : 'png'}`)
    const bytes = Buffer.from(data, 'base64')
    writeFileSync(path, bytes)
    return {
      path,
      format,
      width: Math.max(1, Math.round(w * scale)),
      height: Math.max(1, Math.round(h * scale)),
      bytes: bytes.length,
      scale,
      window: { id: page.window, frame: { x: 0, y: 0, w: vw, h: vh } },
      ...(o.region ? { region: o.region } : {}),
      blank: false,
      capturedAt: Math.round(this.now())
    }
  }

  // ── acting ───────────────────────────────────────────────────────────

  private async runSteps(
    q: ComputerParams<'action.run'> | ComputerParams<'action.batch'>,
    actions: ComputerAction[],
    stepWait: WaitOptions | undefined,
    wait: WaitOptions | undefined,
    signal: AbortSignal
  ): Promise<{ steps: StepResult[]; waited: WaitReport; closing: { observation?: Observation; observationError?: ComputerError } }> {
    this.appOf(q.app)
    const named = actions.flatMap((a) => [a.element, a.start_element].filter((e): e is number => e !== undefined))
    this.checkEpoch(q.epoch, named)
    const page = await this.pageOf(q.window)
    const s = this.session(q.session)
    for (const i of named) if (!s.book.nodes.has(i)) refuse('no_such_element', `there is no element ${i}; read the window`, { element: i })
    const tier: Tier = q.tiers.includes('process') ? 'process' : (q.tiers[0] ?? 'ax')
    const steps: StepResult[] = []
    let stopped = false
    for (const [index, a] of actions.entries()) {
      if (stopped) {
        steps.push({ index, action: a.action, status: 'not-run' })
        continue
      }
      if (signal.aborted) {
        steps.push({ index, action: a.action, status: 'failed', error: { kind: 'cancelled', message: 'cancelled' } })
        stopped = true
        continue
      }
      try {
        const extra = await this.step(q.session, page, a, signal)
        const input = ['ax', 'process', 'session'].includes(tier) && !['screenshot', 'zoom', 'cursor_position', 'wait'].includes(a.action)
        steps.push({ index, action: a.action, status: 'ok', tier: input ? tier : null, effect: 'unknown', ...extra })
        if (stepWait && index < actions.length - 1 && !['screenshot', 'zoom', 'cursor_position', 'wait'].includes(a.action)) await this.settle(page, stepWait, signal)
      } catch (err) {
        const error: ComputerError = err instanceof Refused ? err.error : signal.aborted ? { kind: 'cancelled', message: 'cancelled' } : { kind: 'timeout', message: (err as Error).message }
        steps.push({ index, action: a.action, status: 'failed', error })
        stopped = true
      }
    }
    const waited: WaitReport = wait && !signal.aborted ? await this.settle(await this.pageOf({ id: page.window }).catch(() => page), wait, signal) : { waitedMs: 0, settled: true, busy: false, reason: 'skipped' }
    const observe = q.observe ?? {}
    if (observe.mode === 'none') return { steps, waited, closing: {} }
    if (signal.aborted) return { steps, waited, closing: { observationError: { kind: 'cancelled', message: 'cancelled' } } }
    try {
      const now = await this.pageOf(undefined)
      const observation = await this.read(q.session, now, { geometry: observe.geometry === true, screenshot: observe.screenshot ?? 'auto', maxEdge: observe.maxEdge, budget: observe.budget?.bytes, full: true })
      return { steps, waited, closing: { observation } }
    } catch (err) {
      return { steps, waited, closing: { observationError: err instanceof Refused ? err.error : { kind: 'window_not_found', message: (err as Error).message } } }
    }
  }

  /** Where an element is, in the page: its box's centre, scrolled into view first. */
  private async pointOf(s: SessionState, page: Page, index: number): Promise<[number, number]> {
    if (this.isChrome(s, index, page)) return [640, 0]
    const node = s.book.nodes.get(index)
    if (!node) return refuse('no_such_element', `there is no element ${index}; read the window`, { element: index })
    if (node.backend === null || !node.key.startsWith(`${page.targetId}:`)) return refuse('stale_element', `element ${index} is not in this window`, { element: index, reason: 'gone' })
    const { cdp, sid } = await this.on(page)
    try {
      await cdp.send('DOM.scrollIntoViewIfNeeded', { backendNodeId: node.backend }, sid)
      const { model } = await cdp.send<{ model: { border: number[] } }>('DOM.getBoxModel', { backendNodeId: node.backend }, sid)
      const xs = model.border.filter((_, i) => i % 2 === 0)
      const ys = model.border.filter((_, i) => i % 2 === 1)
      return [Math.round((Math.min(...xs) + Math.max(...xs)) / 2), Math.round((Math.min(...ys) + Math.max(...ys)) / 2)]
    } catch {
      return refuse('stale_element', `element ${index} is gone; read the window again`, { element: index, reason: 'gone' })
    }
  }

  /** A target by its words (§27.9): the first element of the last read whose name is that, a control first. */
  private namedIndex(s: SessionState, named: string): number {
    const want = named.trim().toLowerCase()
    const hit = s.names.find((n) => n.name === want)
    return hit ? hit.index : refuse('named_target', `nothing named "${named}" in the window; read it`)
  }

  private async step(sessionId: string, page: Page, a: ComputerAction, signal: AbortSignal): Promise<Partial<Extract<StepResult, { status: 'ok' }>>> {
    const s = this.session(sessionId)
    const { cdp, sid } = await this.on(page)
    const isAddress = (i: number | undefined) => i !== undefined && s.book.nodes.get(i)?.key === `${page.targetId}:address`
    let element = a.element
    let resolved: number | undefined
    if (a.named !== undefined) {
      await this.read(sessionId, page, { geometry: false, screenshot: 'never', full: true })
      element = resolved = this.namedIndex(s, a.named)
    }
    const mods = a.text && ['left_click', 'right_click', 'middle_click', 'double_click', 'triple_click', 'scroll', 'left_click_drag'].includes(a.action) ? bits(parseModifiers(a.text)) : 0
    const at = async (): Promise<[number, number]> => {
      if (element !== undefined) return this.pointOf(s, page, element)
      if (a.coordinate) return [a.coordinate[0]!, a.coordinate[1]!]
      if (s.pointer) return s.pointer
      return refuse('out_of_bounds', 'name an element or a point')
    }
    const mouse = (type: string, [x, y]: [number, number], more: Record<string, unknown> = {}) => cdp.send('Input.dispatchMouseEvent', { type, x, y, modifiers: mods, ...more }, sid)
    const click = async (button: 'left' | 'right' | 'middle', count: number) => {
      if (isAddress(element)) {
        s.address = { focused: true, draft: null, page: page.targetId }
        return
      }
      s.address.focused = false
      const p = await at()
      s.pointer = p
      await mouse('mouseMoved', p)
      for (let c = 1; c <= count; c++) {
        await mouse('mousePressed', p, { button, clickCount: c })
        await mouse('mouseReleased', p, { button, clickCount: c })
      }
    }
    const key = async (name: string, modifiers: Modifier[]) => {
      if (s.address.focused && s.address.page === page.targetId && name === 'Return' && !modifiers.length) return this.navigate(s, page)
      const k = keyOf(name)
      const m = bits(modifiers)
      const text = m & (MODIFIER_BITS.ctrl | MODIFIER_BITS.super | MODIFIER_BITS.alt) ? undefined : k.text
      await cdp.send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', key: k.key, code: k.code, windowsVirtualKeyCode: k.keyCode, modifiers: m, ...(text ? { text, unmodifiedText: text } : {}) }, sid)
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k.key, code: k.code, windowsVirtualKeyCode: k.keyCode, modifiers: m }, sid)
    }
    const focusOn = async (i: number) => {
      if (isAddress(i)) {
        s.address = { focused: true, draft: s.address.page === page.targetId && s.address.focused ? s.address.draft : null, page: page.targetId }
        return
      }
      s.address.focused = false
      const node = s.book.nodes.get(i)
      if (node?.backend == null) return refuse('stale_element', `element ${i} is gone`, { element: i, reason: 'gone' })
      await cdp.send('DOM.focus', { backendNodeId: node.backend }, sid).catch(() => click('left', 1))
    }
    const type = async (text: string) => {
      if (element !== undefined) await focusOn(element)
      if (s.address.focused && s.address.page === page.targetId) {
        const [line, ...rest] = text.split('\n')
        s.address.draft = (s.address.draft ?? '') + line
        if (rest.length) await this.navigate(s, page)
        return
      }
      const parts = text.split('\n')
      for (const [i, part] of parts.entries()) {
        if (part) await cdp.send('Input.insertText', { text: part }, sid)
        if (i < parts.length - 1) await key('Return', [])
      }
    }
    switch (a.action) {
      case 'left_click':
        await click('left', 1)
        break
      case 'double_click':
        await click('left', 2)
        break
      case 'triple_click':
        await click('left', 3)
        break
      case 'right_click':
        await click('right', 1)
        break
      case 'middle_click':
        await click('middle', 1)
        break
      case 'mouse_move': {
        const p = await at()
        s.pointer = p
        await mouse('mouseMoved', p)
        break
      }
      case 'left_mouse_down':
      case 'left_mouse_up': {
        const p = await at()
        s.pointer = p
        await mouse(a.action === 'left_mouse_down' ? 'mousePressed' : 'mouseReleased', p, { button: 'left', clickCount: 1 })
        break
      }
      case 'left_click_drag': {
        const from = a.start_element !== undefined ? await this.pointOf(s, page, a.start_element) : a.start_coordinate ? ([a.start_coordinate[0]!, a.start_coordinate[1]!] as [number, number]) : (s.pointer ?? refuse('out_of_bounds', 'name where the drag starts'))
        const to = await at()
        await mouse('mouseMoved', from)
        await mouse('mousePressed', from, { button: 'left', clickCount: 1 })
        await mouse('mouseMoved', to, { button: 'left' })
        await mouse('mouseReleased', to, { button: 'left', clickCount: 1 })
        s.pointer = to
        break
      }
      case 'scroll': {
        const p = element !== undefined || a.coordinate ? await at() : ([640, 400] as [number, number])
        const n = (a.scroll_amount ?? 3) * 100
        const d = a.scroll_direction ?? 'down'
        await mouse('mouseWheel', p, { deltaX: d === 'left' ? -n : d === 'right' ? n : 0, deltaY: d === 'up' ? -n : d === 'down' ? n : 0 })
        break
      }
      case 'type':
      case 'paste':
        await type(a.text ?? '')
        return { input: { via: a.action === 'paste' ? 'ax-insert' : 'keys' }, ...(resolved ? { resolved } : {}) }
      case 'key':
      case 'hold_key': {
        let combo
        try {
          combo = parseKeyCombo(a.text ?? '')
        } catch (err) {
          return refuse('invalid_key', (err as Error).message)
        }
        const times = a.action === 'key' ? (a.repeat ?? 1) : 1
        for (let i = 0; i < times; i++) await key(combo.key, combo.modifiers)
        if (a.action === 'hold_key') await sleep((a.duration ?? 0) * 1000, signal)
        break
      }
      case 'set_value': {
        if (element === undefined) return refuse('no_such_element', 'set_value needs an element')
        if (isAddress(element)) {
          s.address = { focused: true, draft: a.value ?? '', page: page.targetId }
          break
        }
        const node = s.book.nodes.get(element)!
        if (node.backend === null) return refuse('action_unsupported', 'that element takes no value')
        const { object } = await cdp.send<{ object: { objectId: string } }>('DOM.resolveNode', { backendNodeId: node.backend }, sid).catch(() => refuse('stale_element', `element ${element} is gone`, { element, reason: 'gone' }))
        await cdp.send(
          'Runtime.callFunctionOn',
          {
            objectId: object.objectId,
            functionDeclaration:
              'function (v) { this.focus(); const p = Object.getPrototypeOf(this); const d = Object.getOwnPropertyDescriptor(p, "value"); if (d && d.set) d.set.call(this, v); else this.value = v; this.dispatchEvent(new Event("input", { bubbles: true })); this.dispatchEvent(new Event("change", { bubbles: true })) }',
            arguments: [{ value: a.value ?? '' }]
          },
          sid
        )
        return { input: { via: 'ax-value' }, ...(resolved ? { resolved } : {}) }
      }
      case 'perform': {
        const name = a.name ?? 'press'
        if (name === 'press') await click('left', 1)
        else if (name === 'confirm') {
          if (element !== undefined) await focusOn(element)
          await key('Return', [])
        } else if (name === 'show menu') await click('right', 1)
        else if (name === 'scroll to visible') {
          if (element !== undefined) await this.pointOf(s, page, element)
        } else return refuse('action_unsupported', `"${name}" is not served on the box`)
        break
      }
      case 'wait':
        await sleep((a.duration ?? 1) * 1000, signal)
        break
      case 'cursor_position': {
        const [x, y] = s.pointer ?? [0, 0]
        return { text: `X=${x}, Y=${y}` }
      }
      case 'screenshot':
        return { shot: await this.shot(sessionId, page, {}) }
      case 'zoom':
        return { shot: await this.shot(sessionId, page, { ...(a.region ? { region: a.region } : {}) }) }
      default:
        return refuse('action_unsupported', `${a.action} is not served on the box`)
    }
    return { ...(s.pointer ? { cursor: [...s.pointer] } : {}), ...(resolved ? { resolved } : {}) }
  }

  /** Return in the address bar: the page goes where it says, if that is a web page. */
  private async navigate(s: SessionState, page: Page): Promise<void> {
    const draft = (s.address.draft ?? '').trim()
    s.address = { focused: false, draft: null, page: null }
    if (!draft) return
    const url = /^[a-z][a-z0-9+.-]*:/i.test(draft) ? draft : `https://${draft}`
    if (!SAFE_URL.test(url)) refuse('open_refused', 'the box browser opens only http and https pages')
    const { cdp, sid } = await this.on(page)
    await cdp.send('Page.navigate', { url }, sid)
  }
}

interface DomNode {
  nodeName: string
  backendNodeId: number
  attributes?: string[]
  children?: DomNode[]
  shadowRoots?: DomNode[]
  contentDocument?: DomNode
}
const attr = (n: DomNode, name: string): string | undefined => {
  const a = n.attributes ?? []
  for (let i = 0; i < a.length; i += 2) if (a[i] === name) return a[i + 1]
  return undefined
}
const bits = (mods: readonly Modifier[]): number => mods.reduce((n, m) => n | MODIFIER_BITS[m], 0)

/**
 * A `spawn` for `ComputerService` that runs the service in this process
 * behind a stdio pair: the host's connection reads and checks every frame
 * against the wire's zod as it would a child's.
 */
export function inProcessSpawn(make: () => BoxComputerService): typeof nodeSpawn {
  return (() => {
    const child = new EventEmitter() as EventEmitter & {
      stdin: PassThrough
      stdout: PassThrough
      stderr: PassThrough
      pid: number
      exitCode: number | null
      signalCode: NodeJS.Signals | null
      kill(sig?: NodeJS.Signals): boolean
    }
    child.stdin = new PassThrough()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.pid = process.pid
    child.exitCode = null
    child.signalCode = null
    const service = make()
    let done = false
    const exit = (code: number | null, signal: NodeJS.Signals | null) => {
      if (done) return
      done = true
      child.exitCode = code
      child.signalCode = signal
      child.stdout.end()
      child.stderr.end()
      setImmediate(() => child.emit('exit', code, signal))
    }
    child.kill = (sig: NodeJS.Signals = 'SIGTERM') => {
      service.close()
      child.stdin.end()
      exit(null, sig)
      return true
    }
    setImmediate(() => {
      child.emit('spawn')
      void service.serve(child.stdin, child.stdout).then(() => exit(0, null))
    })
    return child
  }) as unknown as typeof nodeSpawn
}

export { ADDRESS_NAME }
