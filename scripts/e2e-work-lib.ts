import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { createHmac, randomBytes } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { ConvexHttpClient } from 'convex/browser'
import { makeFunctionReference } from 'convex/server'

/**
 * What every `scripts/e2e-work-*.ts` job shares (milestone 49; docs/agents/work-proofs.md):
 * one isolated windowed instance of the BUILT tree under xvfb, with its own HOME, userData,
 * Work root, debug port and Work service port; Work on; signed in to the owner's real LifeOS
 * with a device session minted for the run (`auth:mint`, never printed) and signed out at the
 * end, which revokes it. The agent's side is called as a thread's bridge calls it
 * (`app.workCall`, `app.addonCall`) with that thread's own tokens, from seeds this run sets; the
 * owner's side is the wire (`work.outbox.send`, `work.meetings.decide` …) or a press in the
 * window. Every LifeOS record a job makes is named `E2E-49 …` and taken away through LifeOS's
 * API with a reason when the job ends, pass or fail.
 *
 * Run a job from the repo root after `electron-vite build`:
 *   env -u ELECTRON_RUN_AS_NODE bun scripts/e2e-work-<job>.ts [--out <dir>]
 */

export const REPO = resolve(import.meta.dir, '..')
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

type Cdp = { eval<T>(e: string): Promise<T>; send(m: string, p?: Record<string, unknown>): Promise<unknown>; close(): void }

export const freePort = (): Promise<number> =>
  new Promise((ok) => {
    const s = createServer()
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number }
      s.close(() => ok(port))
    })
  })

/** Mints a device session on the owner's LifeOS for one run; the run's sign-out revokes it. Its words never reach a log. */
export function mint(name: string): string {
  let token: unknown
  try {
    const out = execFileSync('sudo', ['-n', '/usr/local/bin/lifeos-deploy', 'run', LIFEOS_CHECKOUT, 'auth:mint', JSON.stringify({ ownerId: 'landon', name })], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    })
    token = JSON.parse(out.trim().split('\n').at(-1) ?? '')
  } catch {
    throw new Error('auth:mint failed or answered something that is not a token')
  }
  if (typeof token !== 'string' || token.length < 20) throw new Error('auth:mint answered no token')
  return token
}

export class Run {
  readonly root: string
  readonly out: string
  readonly seed = randomBytes(32).toString('hex')
  readonly results: string[] = []
  readonly data: string
  readonly home: string
  readonly work: string
  port = 0
  workPort = 0
  serverPort = 0
  host = ''
  private proc: ChildProcess | null = null
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

  constructor(readonly job: string) {
    // A root of its own: two runs of one job never share, wipe or kill each other.
    this.root = realpathSync(mkdtempSync(`/tmp/e2e-work-${job}-`))
    const flag = process.argv.indexOf('--out')
    this.out = resolve(flag > 0 ? process.argv[flag + 1]! : join(REPO, '.temp-code/plans/landed/M49', job))
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
    const end = Date.now() + ms
    while (Date.now() < end) {
      if (await Promise.resolve(test()).catch(() => false)) return true
      await sleep(400)
    }
    this.note(`timed out: ${label}`)
    return false
  }
  /** Registers a cleanup; `finish` runs them newest first, whatever happened. */
  later(label: string, fn: () => Promise<unknown>): void {
    this.undo.unshift({ label, fn })
  }

  /** Launches the instance, attaches to its window, turns Work on (unless `work: false`). `env` adds the run's own test seams (a job that needs no real LifeOS names its stand-in there). */
  async start(opts: { work?: boolean; env?: Record<string, string> } = {}): Promise<void> {
    this.port = await freePort()
    this.workPort = await freePort()
    if (await fetch(`http://127.0.0.1:${this.port}/json/version`).then(() => true, () => false)) throw new Error(`debug port ${this.port} is in use`)
    for (const d of [this.data, this.home, this.work, join(this.root, 'tmp'), join(this.home, '.claude'), this.out]) mkdirSync(d, { recursive: true })
    this.linkTools()
    const env: Record<string, string> = {
      ...Object.fromEntries(Object.entries(process.env as Record<string, string>).filter(([k]) => !/^(TEMP_CODE_|CLAUDE|ANTHROPIC_)/.test(k) && k !== 'ELECTRON_RUN_AS_NODE')),
      HOME: this.home,
      TMPDIR: join(this.root, 'tmp'),
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
    const electron = join(REPO, 'node_modules', '.bin', 'electron')
    // Linux draws into xvfb; a Mac opens a real window (a Mac child runs only after the idle gate).
    const argv = process.platform === 'linux' ? ['xvfb-run', '-a', '-s', '-screen 0 1440x900x24 -nolisten tcp', 'dbus-run-session', '--', electron, '.'] : [electron, '.']
    this.proc = spawn(argv[0]!, argv.slice(1), {
      cwd: REPO,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true
    })
    const log = join(this.root, 'instance.log')
    this.proc.stdout?.on('data', (c: Buffer) => appendFileSync(log, c))
    this.proc.stderr?.on('data', (c: Buffer) => appendFileSync(log, c))
    this.cdp = await attach(this.port, 120_000)
    const up = await this.until('window connected', 120_000, () => this.page<boolean>(`window.__monocode?.registry?.statusOf?.(window.__monocode.registry.primaryEnvironmentId)?.transport === 'open'`))
    if (!this.check('the instance is up', up)) throw new Error(readFileSync(log, 'utf8').slice(-1500))
    this.serverPort = (await this.page<number | null>('window.api.getServerPort()')) ?? 0
    await this.cdp.send('Page.enable')
    await this.cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
    if (opts.work !== false) await this.call('work.set', { enabled: true })
    await this.until('environment.json', 30_000, () => existsSync(join(this.data, 'environment.json')))
    this.host = (JSON.parse(readFileSync(join(this.data, 'environment.json'), 'utf8')) as { id: string }).id
  }

  /** The box's tools, each folder linked; the run keeps its own jobs, run and downloads folders. */
  private linkTools(): void {
    if (!existsSync(join(TOOLS, 'state.json'))) return
    const mine = join(this.data, 'work-tools')
    mkdirSync(mine, { recursive: true })
    for (const name of readdirSync(TOOLS)) {
      if (['jobs', 'run', 'downloads'].includes(name)) mkdirSync(join(mine, name), { recursive: true })
      else if (name === 'state.json') writeFileSync(join(mine, name), readFileSync(join(TOOLS, name)))
      else symlinkSync(join(TOOLS, name), join(mine, name))
    }
  }

  /** Signs in with a session minted for this run, and keeps the owner's client for checks and cleanup. */
  async signIn(name: string): Promise<void> {
    this.sessionName = `${PREFIX} ${name} ${new Date().toISOString()}`
    const token = mint(this.sessionName)
    // Run last to first: whatever a job left named E2E-49, then every key this instance minted (its Work
    // Chats key, which reads every sector, among them), then the session itself.
    this.later('sign out (revokes the minted session)', async () => {
      const after = await this.call<{ lifeos: { state: string } }>('work.lifeos.signOut', {})
      this.check('signed out: the minted session is revoked', after.lifeos.state === 'signed-out', after.lifeos.state)
    })
    this.later('retire the keys this run minted', () => this.retireKeys())
    this.later('take away anything named E2E-49 a job left', () => this.leftovers())
    const s = await this.call<{ lifeos: { state: string } }>('work.lifeos.setToken', { token })
    this.check('signed in to LifeOS with a session minted for this run', s.lifeos.state === 'connected', JSON.stringify(s.lifeos))
    this.owner = new ConvexHttpClient(LIFEOS, { logger: false })
  }

  /** The owner's own LifeOS client with a JWT asked for now. */
  async lifeos(): Promise<ConvexHttpClient> {
    const { jwt } = await this.call<{ jwt?: string }>('work.lifeos.jwt', {})
    if (!this.owner || !jwt) throw new Error('not signed in')
    this.owner.setAuth(jwt)
    return this.owner
  }
  async query<T>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
    return (await (await this.lifeos()).query(makeFunctionReference<'query'>(fn), args)) as T
  }
  async mutation<T>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
    return (await (await this.lifeos()).mutation(makeFunctionReference<'mutation'>(fn), args)) as T
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
  tool(sessionId: string, name: string, args: Record<string, unknown> = {}): Promise<Tool> {
    return this.call<Tool>('app.workCall', { sessionId, token: this.workToken(sessionId), appToken: this.appToken(sessionId), call: ++this.calls, tool: name, args }, 300_000)
  }

  /** One request on the instance's local socket (the implicit admin, the owner's own seat). */
  call<T>(method: string, params: unknown = {}, timeoutMs = 120_000): Promise<T> {
    const ws = new WebSocket(`ws://127.0.0.1:${this.serverPort}/`)
    const id = `e2e-${Math.random().toString(36).slice(2)}`
    return new Promise<T>((ok, fail) => {
      const timer = setTimeout(() => (ws.close(), fail(new Error(`no answer to ${method}`))), timeoutMs)
      ws.addEventListener('open', () => ws.send(JSON.stringify({ id, method, params })))
      ws.addEventListener('message', (ev) => {
        const frame = JSON.parse(String(ev.data)) as { id?: string; ok?: boolean; result?: T; error?: string }
        if (frame.id !== id) return
        clearTimeout(timer)
        ws.close()
        if (frame.ok) ok(frame.result as T)
        else fail(new Error(`${method}: ${frame.error}`))
      })
      ws.addEventListener('error', () => (clearTimeout(timer), fail(new Error(`socket error on ${method}`))))
    })
  }

  page<T>(expression: string): Promise<T> {
    return this.cdp!.eval<T>(expression)
  }
  send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    return this.cdp!.send(method, params)
  }
  /** Opens a thread in the window, by id. */
  async show(sessionId: string): Promise<void> {
    await this.page(`window.__monocode.open(${JSON.stringify(sessionId)})`)
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
        const rows = execFileSync('sqlite3', [join(this.data, file), 'SELECT bot_name FROM work_lifeos_keys'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
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
    for (const bot of await live().catch(() => [])) await this.mutation('bots:revoke', { id: bot._id }).catch(() => null)
    const left = await live().catch(() => null)
    this.check(`every LifeOS key this run minted is retired (${names.length})`, left !== null && left.length === 0, JSON.stringify(left?.map((b) => b.name)))
  }

  /** A task or a draft named E2E-49 still in LifeOS after the job's own cleanups: taken away, and a failure. */
  private async leftovers(): Promise<void> {
    const tasks = (await this.query<{ _id: string; title: string; status: string }[]>('tasks:search', { text: PREFIX })).filter((t) => t.title.startsWith(PREFIX) && t.status !== 'dropped')
    for (const t of tasks) await this.mutation('tasks:drop', { id: t._id, reason: 'E2E-49 proof: left by its job, taken away at its end' })
    const drafts = (await this.query<{ _id: string; message?: { subject?: string } }[]>('compose:list', { view: 'drafts' })).filter((d) => d.message?.subject?.startsWith(PREFIX))
    for (const d of drafts) await this.mutation('compose:discard', { id: d._id })
    this.check('the job left no task or draft named E2E-49 in LifeOS', tasks.length + drafts.length === 0, [...tasks.map((t) => t.title), ...drafts.map((d) => d.message?.subject)].join('; '))
  }

  /** Runs the cleanups, stops the instance, writes the results; exits non-zero on any failure. */
  async finish(err?: unknown): Promise<never> {
    if (err) this.check('the job ran to its end', false, err instanceof Error ? (err.stack ?? err.message) : String(err))
    // A cleanup that throws, or a tool that answers an error, leaves something behind: that fails the run.
    for (const { label, fn } of this.undo) {
      try {
        const r = (await fn()) as { isError?: boolean } | undefined
        if (r && typeof r === 'object' && r.isError) this.check(`cleanup "${label}"`, false, textOf(r as Tool).slice(0, 200))
      } catch (e) {
        this.check(`cleanup "${label}"`, false, (e as Error).message.slice(0, 200))
      }
    }
    try {
      this.cdp?.close()
    } catch {
      /* gone */
    }
    this.stopStale()
    try {
      if (this.proc?.pid) process.kill(-this.proc.pid, 'SIGKILL')
    } catch {
      /* gone */
    }
    if (!this.failures && process.env.E2E_KEEP !== '1') rmSync(this.root, { recursive: true, force: true })
    const summary = this.failures ? `${this.failures} FAILED` : 'ALL PASS'
    this.results.push(summary)
    writeFileSync(join(this.out, `run-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`), this.results.join('\n') + '\n')
    console.log(`[${this.job}] ${summary}`)
    process.exit(this.failures ? 1 : 0)
  }

  /** Kills every process of an earlier run of this job, found by its userData in the environ. */
  private stopStale(): void {
    const marker = `TEMP_CODE_USER_DATA=${this.data}`
    if (!existsSync('/proc')) return
    for (const pid of readdirSync('/proc').filter((p) => /^\d+$/.test(p))) {
      try {
        if (Number(pid) !== process.pid && readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').includes(marker)) process.kill(Number(pid), 'SIGKILL')
      } catch {
        /* gone, or not ours */
      }
    }
  }
}

/**
 * The window's page over the debug port (the global WebSocket). The app's own window is the page at
 * `…/index.html`; others come and go while it boots (the capture window, a page that is replaced), and a
 * socket to one of those fails or drives the wrong page. A socket that fails is tried again until the time is up.
 */
async function attach(port: number, ms: number): Promise<Cdp> {
  const end = Date.now() + ms
  let found: WebSocket | null = null
  while (!found && Date.now() < end) {
    const list = (await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json(), () => [])) as { type: string; url: string; webSocketDebuggerUrl?: string }[]
    const url = list.find((t) => t.type === 'page' && /\/index\.html(\?|#|$)/.test(t.url))?.webSocketDebuggerUrl
    if (url) {
      const socket = new WebSocket(url)
      const open = await new Promise<boolean>((ok) => ((socket.onopen = () => ok(true)), (socket.onerror = () => ok(false))))
      if (open) found = socket
    }
    if (!found) await sleep(500)
  }
  if (!found) throw new Error('no page on the debug port')
  const ws = found
  let n = 0
  const waiting = new Map<number, { ok: (v: unknown) => void; fail: (e: Error) => void }>()
  ws.onmessage = (ev) => {
    const m = JSON.parse(String(ev.data)) as { id?: number; result?: unknown; error?: { message: string } }
    const w = m.id !== undefined ? waiting.get(m.id) : undefined
    if (!w) return
    waiting.delete(m.id!)
    if (m.error) w.fail(new Error(m.error.message))
    else w.ok(m.result)
  }
  const send = (method: string, params: Record<string, unknown> = {}) =>
    new Promise<unknown>((ok, fail) => {
      const id = ++n
      waiting.set(id, { ok, fail })
      ws.send(JSON.stringify({ id, method, params }))
    })
  return {
    send,
    async eval<T>(expression: string): Promise<T> {
      const r = (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })) as { result: { value?: T }; exceptionDetails?: { text: string; exception?: { description?: string } } }
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
      return r.result.value as T
    },
    close: () => ws.close()
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
