import { AsyncLocalStorage } from 'node:async_hooks'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { createHmac, randomBytes } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { ConvexHttpClient } from 'convex/browser'
import { makeFunctionReference } from 'convex/server'

/**
 * What every `scripts/e2e-work-*.ts` job shares (milestone 49; docs/agents/work-proofs.md):
 * one isolated windowed instance of the BUILT tree under xvfb, with its own HOME, userData,
 * Work root, debug port and Work service port. Jobs that need the owner's real LifeOS must opt in
 * and use a device session minted for the run (`auth:mint`, never printed) and signed out at the
 * end, which revokes it. The agent's side is called as a thread's bridge calls it
 * (`app.workCall`, `app.addonCall`) with that thread's own tokens, from seeds this run sets; the
 * owner's side is the wire (`work.outbox.send`, `work.meetings.decide` …) or a press in the
 * window. Every LifeOS record a job makes is named with that run’s `E2E-49 <id>` prefix and taken away through LifeOS's
 * API with a reason when the job ends, pass or fail.
 *
 * Run a job from the repo root after `electron-vite build`:
 *   env -u ELECTRON_RUN_AS_NODE bun scripts/e2e-work-<job>.ts [--out <dir>]
 */

export const REPO = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')
export const LIFEOS = 'https://lifeos.landonhale.com'
export const LIFEOS_CHECKOUT = process.env.E2E_LIFEOS_CHECKOUT ?? '/srv/agents/work/lifeos'
/** The host's installed conversion and meeting tools, linked read-only into each run's own work-tools. */
export const TOOLS =
  process.env.E2E_WORK_TOOLS ?? (process.platform === 'darwin' ? join(homedir(), 'Library/Application Support/temp-code/work-tools') : '/srv/agents/temp-code-data/work-tools')
/** A Python with python-docx, openpyxl and pypdfium2: the toolchain's document venv unless E2E_PYTHON names another. */
export const PYTHON = process.env.E2E_PYTHON ?? join(TOOLS, 'docling-venv/3.12.16/bin/python3')
/** Every LifeOS record a job makes starts with this. */
export const PREFIX = 'E2E-49'
export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export interface Tool {
  content: { type: string; text?: string }[]
  isError?: boolean
  structuredContent?: unknown
}
export const textOf = (r: Tool): string => (r.content ?? []).map((c) => c.text ?? `[${c.type}]`).join('\n')

export type Cdp = {
  eval<T>(expression: string, timeoutMs?: number, signal?: AbortSignal): Promise<T>
  send(method: string, params?: Record<string, unknown>, timeoutMs?: number, signal?: AbortSignal): Promise<unknown>
  close(): void
  onEvent(listener: (method: string, params: unknown) => void): void
}

export class ProofTimeout extends Error {}

export async function withinDeadline<T>(label: string, ms: number, work: (signal: AbortSignal) => T | Promise<T>, parent?: AbortSignal): Promise<T> {
  const controller = new AbortController()
  const signal = parent ? AbortSignal.any([parent, controller.signal]) : controller.signal
  signal.throwIfAborted()
  const timer = setTimeout(() => controller.abort(new ProofTimeout(`${label} timed out after ${ms} ms`)), ms)
  const aborted = Promise.withResolvers<never>()
  const onAbort = (): void => aborted.reject(signal.reason)
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    return await Promise.race([aborted.promise, Promise.resolve().then(() => {
      signal.throwIfAborted()
      return work(signal)
    })])
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', onAbort)
  }
}

export function proofPrefix(id: string): string {
  return `${PREFIX} ${id}`
}

export function ownsProofRecord(prefix: string, title: string | undefined): boolean {
  return title?.startsWith(`${prefix} `) === true
}

export function sessionIds(reply: unknown): string[] {
  if (!Array.isArray(reply) || reply.some((row) => typeof row?.id !== 'string' || !row.id)) throw new Error('session.list returned no session list')
  return reply.map((row: { id: string }) => row.id).sort()
}

export function watchProofChild(child: Pick<ChildProcess, 'once'>, label: string): Promise<Error | null> {
  return new Promise((resolve) => {
    child.once('error', (error: Error) => resolve(new Error(`${label} could not start: ${error.message}`, { cause: error })))
    child.once('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      resolve(code === 0 ? null : new Error(`${label} exited (${signal ?? code})`))
    })
  })
}

export const freePort = (): Promise<number> =>
  withinDeadline('reserve a loopback port', 5000, (signal) => new Promise((ok, fail) => {
    const s = createServer()
    s.once('error', fail)
    s.listen({ port: 0, host: '127.0.0.1', signal }, () => {
      const { port } = s.address() as { port: number }
      s.close((error) => error ? fail(error) : ok(port))
    })
  }))

export function proofRpc<T>(port: number, method: string, params: unknown, ms = 120_000, parent?: AbortSignal): Promise<T> {
  return withinDeadline(method, ms, (signal) => new Promise<T>((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/`)
    const id = `e2e-${randomBytes(8).toString('hex')}`
    const finish = (): void => {
      signal.removeEventListener('abort', finish)
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null
      if (ws.readyState < WebSocket.CLOSING) ws.close()
    }
    signal.addEventListener('abort', finish, { once: true })
    ws.onopen = () => {
      try {
        ws.send(JSON.stringify({ id, method, params }))
      } catch (error) {
        reject(error)
        finish()
      }
    }
    ws.onmessage = (ev) => {
      try {
        const frame = JSON.parse(String(ev.data)) as { id?: string; ok?: boolean; result?: T; error?: string }
        if (frame.id !== id) return
        if (frame.ok === true) resolve(frame.result as T)
        else reject(new Error(`${method}: ${frame.error ?? 'invalid reply'}`))
      } catch (error) {
        reject(error)
      }
      finish()
    }
    ws.onclose = ws.onerror = () => {
      reject(new Error(`socket closed while asking ${method}`))
      finish()
    }
  }), parent)
}

/** Mints a device session on the owner's LifeOS for one run; the run's sign-out revokes it. Its words never reach a log. */
export function mint(name: string): string {
  let token: unknown
  try {
    const out = execFileSync('sudo', ['-n', '/usr/local/bin/lifeos-deploy', 'run', LIFEOS_CHECKOUT, 'auth:mint', JSON.stringify({ ownerId: 'landon', name })], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000
    })
    token = JSON.parse(out.trim().split('\n').at(-1) ?? '')
  } catch {
    throw new Error('auth:mint failed or answered something that is not a token')
  }
  if (typeof token !== 'string' || token.length < 20) throw new Error('auth:mint answered no token')
  return token
}

/** The box's tools, each folder linked; the run keeps its own jobs, run and downloads folders. */
export function linkTools(data: string): void {
  if (!existsSync(join(TOOLS, 'state.json'))) return
  const mine = join(data, 'work-tools')
  mkdirSync(mine, { recursive: true })
  for (const name of readdirSync(TOOLS)) {
    if (['jobs', 'run', 'downloads'].includes(name)) mkdirSync(join(mine, name), { recursive: true })
    else if (name === 'state.json') writeFileSync(join(mine, name), readFileSync(join(TOOLS, name)))
    else if (!existsSync(join(mine, name))) symlinkSync(join(TOOLS, name), join(mine, name))
  }
}

/** These scratch windows start without a setup link. Dismiss only the first-run setup offer. */
export const skipSetupOffer = `(() => {
  localStorage.setItem('docket.setupOffered', '1')
  for (const dialog of document.querySelectorAll('[role="dialog"]')) {
    if (!dialog.textContent.includes('Use a setup link')) continue
    const skip = [...dialog.querySelectorAll('button')].find((button) => button.textContent.trim() === 'Skip')
    if (skip) skip.click()
  }
})()`

export class Run {
  readonly root: string
  readonly out: string
  readonly seed = randomBytes(32).toString('hex')
  readonly prefix = proofPrefix(randomBytes(8).toString('hex'))
  readonly results: string[] = []
  readonly data: string
  readonly home: string
  readonly work: string
  port = 0
  workPort = 0
  serverPort = 0
  host = ''
  private proc: ChildProcess | null = null
  private exited: Promise<Error | null> | null = null
  private child = new AbortController()
  private expectedExit = false
  private readonly budget = AbortSignal.timeout(20 * 60_000)
  private readonly scope = new AsyncLocalStorage<AbortSignal>()
  private stopping: Promise<void> | null = null
  private get signal(): AbortSignal {
    return this.scope.getStore() ?? AbortSignal.any([this.child.signal, this.budget])
  }
  private cdp: Cdp | null = null
  private calls = 0
  private owner: ConvexHttpClient | null = null
  /** Cleanups, newest first: each job registers what it made as it makes it. */
  private readonly undo: { label: string; fn: () => Promise<unknown> }[] = []
  private failures = 0
  /** Texts kept out of every check line and picture: his address. */
  private readonly hidden: string[] = []
  /** The minted session's name: one per run, so the sweep can tell its own from one a run left. */
  sessionName = ''

  /** The built tree the instance runs from: this script's own unless `repo` names another (an older build, scripts/proof-doc-gate.ts). */
  readonly repo: string

  constructor(readonly job: string, opts: { repo?: string; out?: string } = {}) {
    // A root of its own: two runs of one job never share, wipe or kill each other.
    this.root = realpathSync(mkdtempSync(`/tmp/e2e-work-${job}-`))
    this.repo = opts.repo ?? REPO
    const flag = process.argv.indexOf('--out')
    this.out = resolve(opts.out ?? (flag > 0 ? process.argv[flag + 1]! : join(REPO, '.temp-code/plans/landed/M49', job)))
    this.data = join(this.root, 'data')
    this.home = join(this.root, 'home')
    this.work = join(this.home, 'work')
  }

  /** Keeps `text` (his address) out of every later check line and picture. */
  hide(text: string): void {
    if (text && !this.hidden.includes(text)) this.hidden.push(text)
  }
  private clean(text: string): string {
    return this.hidden.reduce((t, h) => t.split(h).join('his own address'), text)
  }

  check(label: string, ok: boolean, detail = ''): boolean {
    const line = this.clean(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? `: ${detail.slice(0, 400)}` : ''}`)
    this.results.push(line)
    console.log(`[${this.job}] ${line}`)
    if (!ok) this.failures++
    return ok
  }
  note(line: string): void {
    line = this.clean(line)
    this.results.push(`NOTE ${line}`)
    console.log(`[${this.job}] ${line}`)
  }
  async until(label: string, ms: number, test: () => Promise<boolean> | boolean): Promise<boolean> {
    let lastError: unknown
    try {
      return await withinDeadline(label, ms, (signal) => this.scope.run(signal, async () => {
        while (true) {
          signal.throwIfAborted()
          try {
            if (await test()) return true
          } catch (error) {
            lastError = error
          }
          await delay(400, undefined, { signal })
        }
      }), this.signal)
    } catch (error) {
      if (!(error instanceof ProofTimeout)) throw error
      this.note(`${error.message}${lastError ? `; last error: ${String(lastError)}` : ''}`)
      return false
    }
  }
  /** Registers a cleanup; `finish` runs them newest first, whatever happened. */
  later(label: string, fn: () => Promise<unknown>): void {
    this.undo.unshift({ label, fn })
  }

  /** Launches the instance, attaches to its window, turns Work on (unless `work: false`). `env` adds the run's own test seams (a job that needs no real LifeOS names its stand-in there). */
  async start(opts: { work?: boolean; env?: Record<string, string> } = {}): Promise<void> {
    if (this.proc) throw new Error('stop the current instance before starting another')
    this.signal.throwIfAborted()
    this.port = await freePort()
    this.workPort = await freePort()
    if (await fetch(`http://127.0.0.1:${this.port}/json/version`, { signal: AbortSignal.timeout(3000) }).then(() => true, () => false)) throw new Error(`debug port ${this.port} is in use`)
    for (const d of [this.data, this.home, this.work, join(this.root, 'tmp'), join(this.home, '.claude'), this.out]) mkdirSync(d, { recursive: true })
    linkTools(this.data)
    const env: Record<string, string> = {
      ...Object.fromEntries(Object.entries(process.env as Record<string, string>).filter(([k]) => !/^(TEMP_CODE_|CLAUDE|ANTHROPIC_)/.test(k) && k !== 'ELECTRON_RUN_AS_NODE')),
      HOME: this.home,
      TMPDIR: join(this.root, 'tmp'),
      WINVM_DIR: `${this.data}/no-vm`,
      TEMP_CODE_USER_DATA: this.data,
      TEMP_CODE_REMOTE_PORT: '0',
      TEMP_CODE_ALIAX_DATA_DIR: join(this.data, 'aliax'),
      TEMP_CODE_CLAIM_SHIM: '0',
      CLAUDE_CONFIG_DIR: join(this.home, '.claude'),
      CODEX_HOME: join(this.home, '.codex'),
      AGENT_CLI_CREDENTIAL_STORE: 'file',
      NODE_ENV: 'production',
      SHELL: '/bin/bash',
      TEMP_CODE_HEADLESS: '0',
      TEMP_CODE_DEBUG_PORT: String(this.port),
      TEMP_CODE_WORK_ROOT: this.work,
      TEMP_CODE_WORK_PORT: String(this.workPort),
      TEMP_CODE_APP_TOKEN_SEED: this.seed,
      TEMP_CODE_WORK_TOKEN_SEED: this.seed,
      // No model runs: a thread's turn would act on his real mail with words no cleanup knows.
      TEMP_CODE_FAKE_PROVIDERS: 'http://127.0.0.1:9',
      ...opts.env
    }
    env.WINVM_DIR = join(this.root, 'no-vm')
    mkdirSync(env.WINVM_DIR, { recursive: true })
    const electron = join(this.repo, 'node_modules', '.bin', 'electron')
    // Linux draws into xvfb; a Mac opens a real window (a Mac child runs only after the idle gate).
    const argv = process.platform === 'linux' ? ['xvfb-run', '-a', '-s', '-screen 0 1440x900x24 -nolisten tcp', 'dbus-run-session', '--', electron, '.'] : [electron, '.']
    this.proc = spawn(argv[0]!, argv.slice(1), {
      cwd: this.repo,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true
    })
    const child = this.child
    this.exited = watchProofChild(this.proc, `${this.job} instance`).then((error) => {
      if (!this.expectedExit) {
        const failure = error ?? new Error(`${this.job} instance exited before the proof ended`)
        this.check('the instance stayed up', false, failure.message)
        child.abort(failure)
      }
      return error
    })
    const log = join(this.root, 'instance.log')
    this.proc.stdout?.on('data', (c: Buffer) => appendFileSync(log, c))
    this.proc.stderr?.on('data', (c: Buffer) => appendFileSync(log, c))
    const connected = `window.__docket?.registry?.statusOf?.(window.__docket.registry.primaryEnvironmentId)?.transport === 'open'`
    const up = await this.until('window connected', 180_000, async () => {
      this.cdp ??= await attach(this.port, 15_000, this.signal)
      try {
        return await this.cdp.eval<boolean>(connected, 8_000, this.signal)
      } catch (error) {
        this.cdp.close()
        this.cdp = null
        throw error
      }
    })
    if (!this.check('the instance is up', up)) throw new Error(existsSync(log) ? readFileSync(log, 'utf8').slice(-1500) : 'The instance wrote no log')
    this.serverPort = (await this.page<number | null>('window.api.getServerPort()')) ?? 0
    if (!this.serverPort) throw new Error('The instance has no local server port')
    await this.send('Page.enable')
    await this.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
    if (opts.work !== false) await this.call('work.set', { enabled: true })
    if (!(await this.until('environment.json', 30_000, () => existsSync(join(this.data, 'environment.json'))))) throw new Error('No environment.json')
    this.host = (JSON.parse(readFileSync(join(this.data, 'environment.json'), 'utf8')) as { id: string }).id
  }

  /** Signs in with a session minted for this run, and keeps the owner's client for checks and cleanup. */
  async signIn(name: string): Promise<void> {
    this.signal.throwIfAborted()
    if (process.env.E2E_REAL_LIFEOS !== '1') throw new Error('Set E2E_REAL_LIFEOS=1 to run against the owner’s LifeOS')
    this.sessionName = `${this.prefix} ${name} ${new Date().toISOString()}`
    const token = mint(this.sessionName)
    // Run last to first: whatever this run left, then every key this instance minted (its Work
    // Chats key, which reads every sector, among them), then the session itself.
    this.later('sign out (revokes the minted session)', async () => {
      const after = await this.call<{ lifeos: { state: string } }>('work.lifeos.signOut', {})
      this.check('signed out: the minted session is revoked', after.lifeos.state === 'signed-out', after.lifeos.state)
    })
    this.later('retire the keys this run minted', () => this.retireKeys())
    this.later('take away records left by this run', () => this.leftovers())
    const s = await this.call<{ lifeos: { state: string } }>('work.lifeos.setToken', { token })
    this.check('signed in to LifeOS with a session minted for this run', s.lifeos.state === 'connected', JSON.stringify(s.lifeos))
    this.owner = new ConvexHttpClient(LIFEOS, {
      logger: false,
      fetch: (input, init) => fetch(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, this.signal]) : this.signal })
    })
  }

  /** The owner's own LifeOS client with a JWT asked for now. */
  async lifeos(): Promise<ConvexHttpClient> {
    const { jwt } = await this.call<{ jwt?: string }>('work.lifeos.jwt', {})
    if (!this.owner || !jwt) throw new Error('not signed in')
    this.owner.setAuth(jwt)
    return this.owner
  }
  async query<T>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
    return withinDeadline(`LifeOS query ${fn}`, 30_000, (signal) => this.scope.run(signal, async () => (await (await this.lifeos()).query(makeFunctionReference<'query'>(fn), args)) as T), this.signal)
  }
  async mutation<T>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
    return withinDeadline(`LifeOS mutation ${fn}`, 30_000, (signal) => this.scope.run(signal, async () => (await (await this.lifeos()).mutation(makeFunctionReference<'mutation'>(fn), args)) as T), this.signal)
  }

  /** Cleanup is idempotent when the proof already discarded or sent the draft through the Outbox. */
  cleanupDraft(id: string): void {
    this.later(`discard draft ${id.slice(-6)}`, async () => {
      const draft = await this.query<{ row: { status: string } } | null>('compose:get', { id })
      if (draft?.row.status === 'draft') await this.mutation('compose:discard', { id })
    })
  }

  /** A Work workspace for `sector`, its LifeOS key and add-on ready; deleted at the end (the host revokes its key). */
  async workspace(sector: string, name: string): Promise<string> {
    const ws = await this.call<{ id: string }>('workspace.create', { kind: 'work', sector, name })
    this.later(`delete workspace ${name}`, () => this.call('workspace.delete', { workspaceId: ws.id }))
    const ready = await this.until('key ready', 120_000, async () => {
      const s = await this.call<{ keys: { workspaceId: string; addonId?: string }[] }>('work.lifeos.status', {})
      const id = s.keys.find((k) => k.workspaceId === ws.id)?.addonId
      if (!id) return false
      const l = await this.call<{ status: Record<string, { state: string }> }>('addons.list', {})
      return l.status[id]?.state === 'ready'
    })
    this.check(`the ${sector} Work workspace's LifeOS key is ready`, ready)
    return ws.id
  }

  /** A Work thread in `workspaceId` (or a Work Chat for null). No model runs unless E2E_MODEL_TURN=1. */
  async thread(workspaceId: string | null, title: string, extra: Record<string, unknown> = {}): Promise<string> {
    const s = await this.call<{ id: string; scope?: string }>('session.create', {
      provider: 'claude',
      ...(workspaceId ? { workspaceId } : { scope: 'work', workspaceId: null }),
      threadType: 'chat',
      permission: 'auto',
      title,
      ...extra
    })
    this.check(`"${title}" is a Work thread`, s.scope === 'work')
    this.later(`delete thread ${title}`, () => this.call('session.delete', { sessionId: s.id }))
    return s.id
  }

  appToken = (sessionId: string): string => createHmac('sha256', Buffer.from(this.seed, 'hex')).update(`app-bridge:${sessionId}`).digest('base64url')
  workToken = (sessionId: string): string => createHmac('sha256', Buffer.from(this.seed, 'hex')).update(sessionId).digest('base64url')

  /** A LifeOS tool, as the thread's add-on call reaches it. */
  addon(sessionId: string, name: string, args: Record<string, unknown> = {}): Promise<Tool> {
    return this.call<Tool>('app.addonCall', { sessionId, appToken: this.appToken(sessionId), tool: `lifeos__${name}`, arguments: args })
  }
  /** A Work tool, as the thread's bridge calls it. */
  tool(sessionId: string, name: string, args: Record<string, unknown> = {}, timeoutMs = 300_000): Promise<Tool> {
    return this.call<Tool>('app.workCall', { sessionId, token: this.workToken(sessionId), appToken: this.appToken(sessionId), call: ++this.calls, tool: name, args }, timeoutMs)
  }

  /** One request on the instance's local socket (the implicit admin, the owner's own seat). */
  call<T>(method: string, params: unknown = {}, timeoutMs = 120_000): Promise<T> {
    return proofRpc<T>(this.serverPort, method, params, timeoutMs, this.signal)
  }

  page<T>(expression: string): Promise<T> {
    return this.cdp!.eval<T>(expression, undefined, this.signal)
  }
  send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    return this.cdp!.send(method, params, undefined, this.signal)
  }
  /** Opens a thread in the window, by id. */
  async show(sessionId: string): Promise<void> {
    await this.page(`window.__docket.open(${JSON.stringify(sessionId)})`)
    await sleep(2500)
  }
  /** A real press (pointer down and up) at the middle of the first control whose text is `text`; `rail` takes only the rail's. */
  async press(text: string, where: 'any' | 'rail' = 'any'): Promise<boolean> {
    const at = await this.page<{ x: number; y: number } | null>(
      `(() => { const el = [...document.querySelectorAll('button, a, [role=button], [role=link], [role=menuitem]')].find((e) => e.textContent.trim() === ${JSON.stringify(text)} && !e.disabled && e.offsetParent && (${where === 'rail'} ? e.getBoundingClientRect().left < 200 : true)); if (!el) return null; el.scrollIntoView({ block: 'nearest' }); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } })()`
    )
    if (!at) return false
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y: at.y })
    for (const type of ['mousePressed', 'mouseReleased']) await this.send('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button: 'left', clickCount: 1 })
    return true
  }
  async key(key: string, code: string, windowsVirtualKeyCode: number, modifiers = 0): Promise<void> {
    const params = { key, code, windowsVirtualKeyCode, modifiers }
    const text = modifiers ? undefined : key.length === 1 ? key : key === 'Enter' ? '\r' : undefined
    await this.send('Input.dispatchKeyEvent', { ...params, type: 'keyDown', text })
    await this.send('Input.dispatchKeyEvent', { ...params, type: 'keyUp' })
  }

  has(text: string): Promise<boolean> {
    return this.page<boolean>(`document.body.textContent.includes(${JSON.stringify(text)})`)
  }
  /** Both themes of what the window shows now, into the job's out folder. `clipLeft` leaves out the rail and the column, which show his real lists; every hidden text is swapped out first, and a picture that still shows one is not written. */
  async shot(name: string, opts: { clipLeft?: number } = {}): Promise<void> {
    const clip = opts.clipLeft ? { clip: { x: opts.clipLeft, y: 0, width: 1440 - opts.clipLeft, height: 900, scale: 1 } } : {}
    const hidden = JSON.stringify(this.hidden)
    // Swaps each hidden text (his address) in what is drawn, just before each picture; answers whether any is still there.
    const scrub = `(() => { const hide = ${hidden}; const swap = (t) => hide.reduce((a, h) => a.split(h).join('his own address'), t); const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); for (let n = w.nextNode(); n; n = w.nextNode()) if (hide.some((h) => n.nodeValue.includes(h))) n.nodeValue = swap(n.nodeValue); for (const el of document.querySelectorAll('body *')) if (el.children.length && hide.includes(el.textContent.trim())) el.textContent = 'his own address'; const vals = [...document.querySelectorAll('input, textarea')].map((e) => e.value); return hide.some((h) => document.body.innerText.includes(h) || vals.some((v) => v.includes(h))) })()`
    for (const light of [false, true]) {
      await this.page(`document.documentElement.classList.toggle('theme-light', ${light})`)
      await sleep(400)
      if (this.hidden.length && (await this.page<boolean>(scrub))) {
        this.check(`picture ${name} keeps his address out`, false, 'still on screen after the swap: no picture written')
        continue
      }
      const { data } = (await this.send('Page.captureScreenshot', { format: 'png', ...clip })) as { data: string }
      writeFileSync(join(this.out, `${name}.${light ? 'light' : 'dark'}.png`), Buffer.from(data, 'base64'))
    }
    await this.page(`document.documentElement.classList.toggle('theme-light', false)`)
  }

  /** Every LifeOS key this instance minted, by name, from its own database. */
  keyNames(): string[] {
    const names = new Set<string>()
    for (const file of existsSync(this.data) ? readdirSync(this.data).filter((f) => f.endsWith('.db')) : []) {
      try {
        const rows = execFileSync('sqlite3', [join(this.data, file), 'SELECT bot_name FROM work_lifeos_keys'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 })
        for (const line of rows.split('\n')) if (line.trim()) names.add(line.trim())
      } catch {
        /* not the app's database */
      }
    }
    return [...names]
  }
  private async retireKeys(): Promise<void> {
    const names = this.keyNames()
    const live = async () => ((await this.query<{ _id: string; name: string; revokedAt?: number }[]>('bots:list')).filter((b) => b.revokedAt === undefined && names.includes(b.name)))
    await this.until('keys revoked by the host', 20_000, async () => (await live()).length === 0)
    for (const bot of await live()) {
      await this.mutation('bots:revoke', { id: bot._id }).catch((error: unknown) => this.check('revoke a run key', false, String(error)))
    }
    const left = await live()
    this.check(`every LifeOS key this run minted is retired (${names.length})`, left.length === 0, JSON.stringify(left.map((b) => b.name)))
  }

  /** A task or draft with this run’s prefix still in LifeOS after the job's own cleanups: taken away, and a failure. */
  private async leftovers(): Promise<void> {
    const tasks = (await this.query<{ _id: string; title: string; status: string }[]>('tasks:search', { text: this.prefix })).filter((t) => ownsProofRecord(this.prefix, t.title) && t.status !== 'dropped')
    for (const t of tasks) {
      await this.mutation('tasks:drop', { id: t._id, reason: 'E2E-49 proof: left by its job, taken away at its end' }).catch((error: unknown) => this.check('drop a leftover task', false, String(error)))
    }
    const drafts = (await this.query<{ _id: string; message?: { subject?: string } }[]>('compose:list', { view: 'drafts' })).filter((d) => ownsProofRecord(this.prefix, d.message?.subject))
    for (const d of drafts) {
      await this.mutation('compose:discard', { id: d._id }).catch((error: unknown) => this.check('discard a leftover draft', false, String(error)))
    }
    this.check('the job left no task or draft with its prefix in LifeOS', tasks.length + drafts.length === 0, [...tasks.map((t) => t.title), ...drafts.map((d) => d.message?.subject)].join('; '))
  }

  /** Runs the cleanups, stops the instance, writes the results; exits non-zero on any failure. */
  async finish(err?: unknown): Promise<never> {
    await this.stop(err)
    mkdirSync(this.out, { recursive: true })
    const summary = this.failures ? `${this.failures} FAILED` : 'ALL PASS'
    this.results.push(summary)
    writeFileSync(join(this.out, `run-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`), this.results.join('\n') + '\n')
    console.log(`[${this.job}] ${summary}`)
    process.exit(this.failures ? 1 : 0)
  }

  /** The failures so far. */
  get failed(): number {
    return this.failures
  }

  /** The restart proof asks the child to quit and waits for the exact child it started. */
  async quit(): Promise<void> {
    if (!this.exited) throw new Error('No instance to quit')
    this.expectedExit = true
    await this.page('setTimeout(() => window.api.app.confirmQuit(), 0); true')
    const error = await withinDeadline('quit the Work instance', 30_000, () => this.exited!, this.signal)
    if (error) throw error
    await this.stopGroup()
    this.expectedExit = false
    this.child = new AbortController()
  }

  /** Runs cleanups and stops the instance without exiting. */
  stop(err?: unknown): Promise<void> {
    return this.stopping ??= this.stopOnce(err)
  }

  private async stopOnce(err?: unknown): Promise<void> {
    if (err !== undefined) this.check('the job ran to its end', false, err instanceof Error ? (err.stack ?? err.message) : String(err))
    const cleanupBudget = AbortSignal.timeout(120_000)
    try {
      for (const { label, fn } of this.undo.splice(0)) {
        try {
          const result = await withinDeadline(label, 30_000, (signal) => this.scope.run(signal, fn), cleanupBudget)
          if (result && typeof result === 'object' && 'isError' in result && result.isError) throw new Error(textOf(result as Tool))
        } catch (error) {
          this.check(`cleanup "${label}"`, false, String(error))
        }
      }
    } finally {
      this.expectedExit = true
      try {
        await this.stopGroup()
      } catch (error) {
        this.check('stop the instance group', false, String(error))
      }
    }
    if (!this.failures && process.env.E2E_KEEP !== '1') rmSync(this.root, { recursive: true, force: true })
  }

  private async stopGroup(): Promise<void> {
    this.cdp?.close()
    this.cdp = null
    const pid = this.proc?.pid
    if (!pid) {
      this.proc = null
      this.exited = null
      return
    }
    const signalGroup = (signal: NodeJS.Signals): void => {
      try {
        process.kill(-pid, signal)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
      }
    }
    const exited = this.exited!
    try {
      signalGroup('SIGTERM')
      await withinDeadline('stop the instance', 3000, () => exited).catch((error: unknown) => {
        if (!(error instanceof ProofTimeout)) throw error
      })
    } finally {
      signalGroup('SIGKILL')
      await withinDeadline('reap the instance', 5000, () => exited)
      this.proc = null
      this.exited = null
    }
  }
}

/** How long one evaluate in the page may take; the longest a job asks of the page is a few seconds. */
const EVAL_TIMEOUT_MS = 60_000

/**
 * The window's page over the debug port (the global WebSocket). The app's own window is the page at
 * `…/index.html`; others come and go while it boots (the capture window, a page that is replaced), and a
 * socket to one of those fails or drives the wrong page. A socket that fails is tried again until the time is up.
 */
export async function attach(
  port: number, ms: number, signal?: AbortSignal,
  matchesPage: (url: string) => boolean = (url) => /\/index\.html(\?|#|$)/.test(url)
): Promise<Cdp> {
  const end = Date.now() + ms
  let found: WebSocket | null = null
  while (!found && Date.now() < end) {
    signal?.throwIfAborted()
    const deadline = AbortSignal.timeout(Math.max(1, Math.min(3000, end - Date.now())))
    const list = await fetch(`http://127.0.0.1:${port}/json/list`, {
      signal: signal ? AbortSignal.any([deadline, signal]) : deadline
    }).then((r) => r.json()).catch(() => []) as { type: string; url: string; webSocketDebuggerUrl?: string }[]
    signal?.throwIfAborted()
    const url = (Array.isArray(list) ? list : []).find((t) => t.type === 'page' && matchesPage(t.url))?.webSocketDebuggerUrl
    if (url) {
      const socket = new WebSocket(url)
      const open = await new Promise<boolean>((ok) => {
        const done = (opened: boolean): void => {
          clearTimeout(timer)
          signal?.removeEventListener('abort', abort)
          ok(opened)
        }
        const abort = (): void => done(false)
        const timer = setTimeout(abort, Math.min(3000, end - Date.now()))
        signal?.addEventListener('abort', abort, { once: true })
        socket.onopen = () => done(true)
        socket.onerror = socket.onclose = abort
      })
      if (open) found = socket
      else socket.close()
    }
    if (!found) await delay(Math.min(250, Math.max(0, end - Date.now())), undefined, { signal })
  }
  signal?.throwIfAborted()
  if (!found) throw new Error('no page on the debug port')
  const ws = found
  let n = 0
  const waiting = new Map<number, (error: Error | null, value?: unknown) => void>()
  let onEvent: ((method: string, params: unknown) => void) | undefined
  ws.onmessage = (ev) => {
    let m: { id?: number; result?: unknown; error?: { message: string }; method?: string; params?: unknown }
    try {
      m = JSON.parse(String(ev.data)) as typeof m
    } catch {
      ws.close()
      return
    }
    if (m.id !== undefined) waiting.get(m.id)?.(m.error ? new Error(m.error.message) : null, m.result)
    else if (m.method) onEvent?.(m.method, m.params)
  }
  ws.onclose = ws.onerror = () => {
    for (const finish of waiting.values()) finish(new Error('the debug socket closed'))
  }
  const send = (method: string, params: Record<string, unknown> = {}, timeoutMs = EVAL_TIMEOUT_MS, signal?: AbortSignal) =>
    new Promise<unknown>((ok, fail) => {
      if (signal?.aborted) return fail(signal.reason)
      if (ws.readyState !== WebSocket.OPEN) return fail(new Error('the debug socket is closed'))
      const id = ++n
      const finish = (error: Error | null, value?: unknown): void => {
        waiting.delete(id)
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
        if (error) fail(error)
        else ok(value)
      }
      const abort = (): void => finish(signal!.reason)
      const timer = setTimeout(() => finish(new Error(`the page did not answer ${method}`)), timeoutMs)
      waiting.set(id, finish)
      signal?.addEventListener('abort', abort, { once: true })
      try {
        ws.send(JSON.stringify({ id, method, params }))
      } catch (error) {
        finish(error as Error)
      }
    })
  return {
    send,
    async eval<T>(expression: string, timeoutMs?: number, signal?: AbortSignal): Promise<T> {
      const r = (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, timeoutMs, signal)) as { result: { value?: T }; exceptionDetails?: { text: string; exception?: { description: string } } }
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
      return r.result.value as T
    },
    close: () => ws.close(),
    onEvent: (listener) => { onEvent = listener }
  }
}

/** His own mailbox outside Purdue, preferring Life: the only account a job drafts from. */
export async function ownMailbox(run: Run): Promise<{ _id: string; address: string; defaultSector: string }> {
  const accounts = await run.query<{ _id: string; address: string; provider: string; defaultSector?: string }[]>('mail:accounts')
  const usable = accounts.filter((a) => a.provider !== 'outlook-forwarded' && a.defaultSector && a.defaultSector !== 'purdue')
  const mine = usable.find((a) => a.defaultSector === 'life') ?? usable[0]
  if (!mine) throw new Error('no mailbox of his own outside Purdue')
  run.hide(mine.address)
  return mine as { _id: string; address: string; defaultSector: string }
}
