import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { networkInterfaces } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_THREAD_DEFAULTS } from '../../../src/shared/defaults'
import { freePort, linkTools, sleep, TOOLS } from '../../e2e-work-lib'
import { withAppToken } from '../../lib/appToken'
import { dummyLibrary, gioStub } from './files'
import { seedFakeAccount, startFakeProvider, type MailReplyFixture } from './fakeProvider'
import { until, Window } from './window'
import { relay, shapedRelay } from './relay'
import { settingsOpen } from './settings'
import { FIRST_MAIL, ZONE } from './lifeosSeed'
import type { Sandbox } from './lifeos'

export const SHAPES = ['A', 'B1', 'B2', 'V', 'S', 'K', 'U'] as const
export type Shape = typeof SHAPES[number]
export const KEY_CAPS = {
  owner: ['read', 'operate', 'approve', 'admin'],
  device: ['operate', 'approve', 'device'],
  read: ['read']
} as const

type Seat = 'win' | 'box' | 'desk' | 'given' | 'giver'
type Instance = {
  name: Seat
  home: string
  data: string
  tmp: string
  work: string
  remote: number
  debug?: number
  workPort: number
  log: string
  port: number
  host: string
  proc?: ChildProcess
  halted?: boolean
}
type Workspace = { id: string; path: string; name: string }
type Reply<T> = { ok: true; value: T } | { ok: false; error: string }
export type Cleanup = { revoked: string[]; remainingPids: number[]; errors: string[]; portsChecked: number[]; remainingPorts: number[] }

export const words = (error: unknown): string => error instanceof Error ? error.message : String(error)

/** Keep the tool search path and locale. All app, CLI and provider settings come from the run. */
export function isolatedEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(source).filter(([key]) => /^(PATH|LANG|LC_[A-Z_]+)$/.test(key)))
}

async function instance(root: string, tmpRoot: string, name: Seat): Promise<Instance> {
  const home = join(root, name + '-home')
  const data = join(root, name + '-data')
  const tmp = join(tmpRoot, name)
  const work = join(home, 'work')
  for (const dir of [home, data, tmp, work, join(data, 'no-vm'), join(home, '.claude'), join(home, '.codex')]) mkdirSync(dir, { recursive: true })
  return {
    name, home, data, tmp, work,
    remote: await freePort(),
    ...(name === 'win' || name === 'given' ? { debug: await freePort() } : {}),
    workPort: await freePort(),
    log: join(root, name + '.log'),
    port: 0,
    host: ''
  }
}

/** xvfb also gives the headless host a display for its hidden preview windows. */
const OFFLINE = 'http://127.0.0.1:0'
type LaunchOptions = { serveLifeos?: boolean; zone?: string; chromium?: string; fakeOrigin?: string; publicOrigin?: string; sandbox?: Sandbox }

function launch(repo: string, inst: Instance, seed: string, bin: string, options: LaunchOptions, tools?: string): ChildProcess {
  const inherited = isolatedEnvironment(process.env)
  const env = {
    ...inherited,
    PATH: bin + ':' + inherited.PATH,
    HOME: inst.home,
    TMPDIR: inst.tmp,
    WINVM_DIR: join(inst.data, 'no-vm'),
    CLAUDE_CONFIG_DIR: join(inst.home, '.claude'),
    CODEX_HOME: join(inst.home, '.codex'),
    TEMP_CODE_USER_DATA: inst.data,
    ...(['giver', 'given'].includes(inst.name) ? { TEMP_CODE_E2E_DEVICES: '1' } : {}),
    ...(inst.name === 'giver' ? { TEMP_CODE_BUILD_PLATFORM: 'darwin' } : {}),
    ...(inst.name === 'box' && options.chromium ? { TEMP_CODE_BOX_CHROMIUM: options.chromium } : {}),
    TEMP_CODE_HEADLESS: inst.name === 'box' ? '1' : '0',
    TEMP_CODE_REMOTE_PORT: String(inst.remote),
    ...(inst.debug ? { TEMP_CODE_DEBUG_PORT: String(inst.debug) } : {}),
    TEMP_CODE_ALIAX_DATA_DIR: join(inst.data, 'aliax'),
    TEMP_CODE_CLAIM_SHIM: '0',
    TEMP_CODE_FAKE_PROVIDERS: options.fakeOrigin ?? 'http://127.0.0.1:9',
    TEMP_CODE_LIFEOS_URL: options.sandbox?.url ?? OFFLINE,
    TEMP_CODE_LIFEOS_MCP_URL: options.sandbox?.mcpUrl ?? OFFLINE + '/mcp',
    ...(options.sandbox || options.zone ? { TZ: options.zone ?? ZONE } : {}),
    ...(options.sandbox ? { TEMP_CODE_WARM_HARNESS: '0' } : {}),
    ...(inst.name === 'box' && options.serveLifeos ? { TEMP_CODE_WORK_LIFEOS_SERVER: 'here' } : {}),
    TEMP_CODE_WORK_ROOT: inst.work,
    TEMP_CODE_WORK_PORT: String(inst.workPort),
    ...(inst.name === 'box' && options.publicOrigin ? { TEMP_CODE_WORK_PUBLIC_ORIGIN: options.publicOrigin } : {}),
    TEMP_CODE_APP_TOKEN_SEED: seed,
    TEMP_CODE_WORK_TOKEN_SEED: seed,
    AGENT_CLI_CREDENTIAL_STORE: 'file',
    PYTHONDONTWRITEBYTECODE: '1',
    NODE_ENV: 'production',
    SHELL: '/bin/bash'
  }
  const electron = join(repo, 'node_modules', '.bin', 'electron')
  const app = ['xvfb-run', '-a', '-s', '-screen 0 1440x900x24 -nolisten tcp', 'dbus-run-session', '--', electron, '.']
  // A mount namespace makes the shared tool links read-only for box and its children.
  const argv = tools ? [
    'unshare', '--map-current-user', '--mount', '--keep-caps', 'bash', '-c',
    'mount -o bind,ro -- "$1" "$1" || exit; shift; exec "$@"', 'journey-tools', tools, ...app
  ] : app
  const proc = spawn(argv[0]!, argv.slice(1), {
    cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true
  })
  proc.stdout?.on('data', (bytes: Buffer) => appendFileSync(inst.log, bytes))
  proc.stderr?.on('data', (bytes: Buffer) => appendFileSync(inst.log, bytes))
  return proc
}

function rpc<T>(inst: Instance, method: string, params: unknown, seed: string, ms: number, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    signal?.throwIfAborted()
    if (!inst.port) return reject(new Error(`${inst.name}: no local port`))
    const ws = new WebSocket(`ws://127.0.0.1:${inst.port}/`)
    const finish = (error: Error | null, value?: T): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', aborted)
      ws.onclose = ws.onerror = null
      ws.close()
      if (error) reject(error)
      else resolve(value as T)
    }
    const aborted = (): void => finish(new Error(words(signal?.reason)))
    const timer = setTimeout(() => finish(new Error(`${inst.name}: no answer to ${method}`)), ms)
    signal?.addEventListener('abort', aborted, { once: true })
    ws.onopen = () => ws.send(JSON.stringify({ id: 'journey', method, params: withAppToken(method, params, seed) }))
    ws.onmessage = (event) => {
      try {
        const frame = JSON.parse(String(event.data)) as { id?: string; ok?: boolean; result?: T; error?: string }
        if (frame.id !== 'journey') return
        finish(frame.ok ? null : new Error(frame.error ?? `${method} failed`), frame.result)
      } catch (error) {
        finish(new Error(words(error)))
      }
    }
    ws.onerror = ws.onclose = () => finish(new Error(`${inst.name}: socket closed on ${method}`))
  })
}

export function instancePids(folder: string): number[] {
  return readdirSync('/proc').filter((entry) => /^\d+$/.test(entry)).map(Number).filter((pid) => {
    if (pid === process.pid) return false
    try {
      return readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').some((entry) => entry.includes(folder + '/') || entry.endsWith('=' + folder))
    } catch {
      return false
    }
  })
}

function kill(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
  }
}

/** desk has no CDP and only headless box writes server.json. Find desk's own local listener. */
async function deskPort(inst: Instance, seed: string): Promise<number> {
  const pids = new Set(instancePids(inst.data))
  const sockets = execFileSync('ss', ['-H', '-ltnp'], { encoding: 'utf8', timeout: 3000 })
  const ports = sockets.split('\n').flatMap((line) => {
    const match = line.trim().match(/^LISTEN\s+\d+\s+\d+\s+127\.0\.0\.1:(\d+)\s.*\("electron",pid=(\d+),/)
    if (!match || !pids.has(Number(match[2]))) return []
    return [{ port: Number(match[1]), pid: Number(match[2]) }]
  })
  // The local listener can claim the requested remote port before the remote listener starts.
  // Either way the local listener answers the app's own status request.
  const candidates = ports.filter(({ port }) => port !== inst.workPort).sort((a, b) => Number(a.port === inst.remote) - Number(b.port === inst.remote))
  for (const { port } of candidates) {
    const status = await rpc<{ environmentId?: string }>({ ...inst, port }, 'remote.status', {}, seed, 1000).catch(() => null)
    if (status?.environmentId) return port
  }
  return 0
}

export class Pair {
  readonly seed = randomBytes(32).toString('hex')
  readonly abort = new AbortController()
  private readonly cleanups: (() => Promise<void>)[] = []
  private readonly relays: Awaited<ReturnType<typeof relay>>[] = []
  private readonly instances: Instance[] = []
  private window?: Window
  private winRelay?: Awaited<ReturnType<typeof relay>>
  /** The shaped hop between win and box, when the run slowed it (`open`'s `link`). */
  windowLink?: Awaited<ReturnType<typeof shapedRelay>>
  private tmpRoot?: string
  private chromiumTmp?: string
  private launchOptions: LaunchOptions = {}
  private bin = ''
  private givenWindow?: Window
  givenInstance?: Instance
  private givenIdentity?: string
  private giver?: Instance
  guestOrigin?: string
  sandbox?: Sandbox
  private fakeProvider?: ReturnType<typeof startFakeProvider>
  fakeMessages = 0
  private finishFakeBrowserTurn?: () => void
  fakeMailReply?: MailReplyFixture
  private stopping = false
  win!: Instance
  box!: Instance
  desk?: Instance
  l1!: string
  l2?: string

  constructor(readonly repo: string, readonly root: string) {}

  get page(): Window {
    if (!this.window) throw new Error('The window is still starting')
    return this.window
  }

  get hostErrors(): readonly string[] {
    return this.window?.hostErrors ?? []
  }

  private start(inst: Instance, bin: string, options: LaunchOptions, tools?: string): void {
    const proc = launch(this.repo, inst, this.seed, bin, options, tools)
    inst.proc = proc
    const early = (detail: string): void => {
      if (!this.stopping && !inst.halted && inst.proc === proc) this.abort.abort(new Error(`${inst.name} exited early (${detail}). See ${inst.log}`))
    }
    proc.once('error', (error) => early(words(error)))
    proc.once('exit', (code, signal) => early(String(signal ?? code)))
  }

  rpc<T = unknown>(inst: Instance, method: string, params: unknown = {}, ms = 15_000): Promise<T> {
    this.abort.signal.throwIfAborted()
    return rpc(inst, method, params, this.seed, ms, this.abort.signal)
  }

  async fromWindow<T>(method: string, params: unknown = {}, page = this.page): Promise<Reply<T>> {
    try {
      return await page.eval(`(async () => {
        try {
          const value = await window.__monocode.registry.linkOf(${JSON.stringify(this.box.host)})
            .request(${JSON.stringify(method)}, ${JSON.stringify(params)});
          return { ok: true, value };
        } catch (error) {
          return { ok: false, error: String(error?.message ?? error) };
        }
      })()`)
    } catch (error) {
      return { ok: false, error: words(error) }
    }
  }

  async open(withDesk: boolean, name: string, options: { fake?: boolean; hosted?: boolean; guests?: boolean; guestTheme?: boolean; cut?: boolean; sector?: string; capture?: boolean; localTools?: boolean; chromium?: string; zone?: string; browser?: boolean; link?: { delayMs: number; rateMbit: number }; provider?: typeof startFakeProvider } = {}): Promise<Workspace> {
    // Electron's singleton uses a Unix socket under TMPDIR. Keep its path short even when evidence is nested.
    const tmpRoot = this.tmpRoot = mkdtempSync('/tmp/tcj-')
    this.win = await instance(this.root, tmpRoot, 'win')
    this.box = await instance(this.root, tmpRoot, 'box')
    this.desk = withDesk ? await instance(this.root, tmpRoot, 'desk') : undefined
    this.instances.push(this.win, this.box, ...(this.desk ? [this.desk] : []))
    this.l1 = dummyLibrary(this.win.home, 'Journey Teams L1')
    if (this.desk) this.l2 = dummyLibrary(this.desk.home, 'Journey Teams L2')
    const tools = (!this.sandbox || options.localTools) && existsSync(join(TOOLS, 'state.json')) ? realpathSync(TOOLS) : undefined
    if (tools) linkTools(this.box.data)
    this.bin = gioStub(this.root)
    if (options.link) {
      this.winRelay = this.windowLink = await shapedRelay(this.box.remote, options.link)
      this.relays.push(this.winRelay)
    } else if (options.cut) {
      // A hop with no delay that presents box's own Host, as his tunnel does: box refuses a page's socket with another.
      this.winRelay = await shapedRelay(this.box.remote, { delayMs: 0, rateMbit: 0 })
      this.relays.push(this.winRelay)
    }
    if (options.guestTheme) {
      if (!this.sandbox) throw new Error('Guest theme requires the isolated LifeOS sandbox')
      this.guestOrigin = 'http://127.0.0.1:' + this.box.workPort
    }
    if (options.guests) {
      const address = Object.values(networkInterfaces()).flat().find((row) => row?.family === 'IPv4' && !row.internal)?.address
      if (address) {
        const publicLink = await relay(address, this.box.workPort)
        this.relays.push(publicLink)
        this.guestOrigin = 'http://' + address + ':' + publicLink.port
      } else {
        this.guestOrigin = 'http://127.0.0.1:' + this.box.workPort
      }
    }
    this.abort.signal.throwIfAborted()
    if (options.fake) {
      seedFakeAccount(join(this.box.data, 'aliax'))
      if (options.capture) seedFakeAccount(join(this.win.data, 'aliax'))
      const browserTurn = options.browser ? new Promise<void>(resolve => { this.finishFakeBrowserTurn = resolve }) : undefined
      this.fakeProvider = (options.provider ?? startFakeProvider)(() => { this.fakeMessages++ }, browserTurn, () => this.fakeMailReply)
    }
    let chromium: string | undefined
    if (options.chromium) {
      const quote = (path: string) => "'" + path.replaceAll("'", "'\"'\"'") + "'"
      chromium = join(this.bin, 'journey-chromium')
      // Chromium puts SingletonSocket under TMPDIR and Unix sockets have a short path limit.
      this.chromiumTmp = mkdtempSync('/tmp/tc-browser-')
      writeFileSync(chromium, '#!/bin/sh\nexport TMPDIR=' + quote(this.chromiumTmp) + '\nexec ' + quote(options.chromium) + ' "$@" 2>>' + quote(join(this.root, 'chromium.log')) + '\n', { mode: 0o700 })
    }
    this.launchOptions = {
      sandbox: this.sandbox,
      serveLifeos: !!this.sandbox && (options.guestTheme || options.guests),
      chromium,
      zone: options.zone,
      fakeOrigin: this.fakeProvider?.url.origin,
      publicOrigin: this.guestOrigin ?? (options.hosted ? 'http://127.0.0.1:' + this.box.workPort : undefined)
    }
    for (const inst of this.instances) this.start(inst, this.bin, this.launchOptions, inst === this.box ? tools : undefined)
    this.window = await Window.attach(this.win.debug!, this.abort.signal)
    const wait = (label: string, test: () => unknown | Promise<unknown>) => until(label, 90_000, test, this.abort.signal)
    await wait('local ports', async () => {
      this.win.port ||= (await this.page.eval<number | null>('window.api?.getServerPort?.()')) ?? 0
      const file = join(this.box.data, 'server.json')
      if (!this.box.port && existsSync(file)) this.box.port = (JSON.parse(readFileSync(file, 'utf8')) as { port: number }).port
      if (this.desk) this.desk.port ||= await deskPort(this.desk, this.seed)
      return this.win.port && this.box.port && (!this.desk || this.desk.port)
    })
    // Win has a loopback account for Capture. In that case onboarding can already be done.
    if (options.capture) {
      await wait('Skip or the app rail', async () => {
        const skip = await this.page.centre('[role="dialog"] button', 'Skip')
        if (skip) {
          await this.page.click(skip)
          return true
        }
        return await this.page.centre('button', 'Settings')
      })
    } else {
      await this.page.clickOn('[role="dialog"] button', 'Skip')
    }
    for (const inst of this.instances) inst.host = (await this.rpc<{ environmentId: string }>(inst, 'remote.status')).environmentId
    for (const inst of this.instances) await this.rpc(inst, 'work.set', { enabled: true })
    if (this.sandbox) {
      await this.rpc(this.box, 'work.lifeos.setToken', { token: this.sandbox.deviceToken })
      await wait('box signed in to sandbox LifeOS', async () =>
        (await this.rpc<{ lifeos: { state: string } }>(this.box, 'work.lifeos.status')).lifeos.state === 'connected')
    }
    if (options.capture && this.sandbox) {
      await this.rpc(this.win, 'work.lifeos.setToken', { token: await this.sandbox.mintDevice() })
      await wait('win signed in to sandbox LifeOS', async () =>
        (await this.rpc<{ lifeos: { state: string } }>(this.win, 'work.lifeos.status')).lifeos.state === 'connected')
    }
    const workspace = await this.workspace(name, options.sector)
    await this.link(this.win)
    if (this.desk) await this.link(this.desk)
    await this.page.eval('window.__monocode.loadSavedEnvironments()')
    const host = JSON.stringify(this.box.host)
    await wait('the window link to box', () => this.page.eval(`window.__monocode.registry.has(${host}) && window.__monocode.registry.statusOf(${host}).transport === 'open'`))
    await this.rpc(this.box, 'defaults.set', { workspaceId: null, defaults: { ...DEFAULT_THREAD_DEFAULTS, permission: 'auto' } })
    return workspace
  }

  async showWork(workspace: Workspace, view: string, page = this.page): Promise<void> {
    const rail = 'nav [data-rail-path] button'
    await page.dismissPopups()
    if (await settingsOpen(page)) await page.press('button', 'Back')
    if (!await page.centre(rail + '[aria-current="true"]', workspace.name)) await page.clickOn(rail, workspace.name)
    await page.until(workspace.name + ' selected', 15_000, () => page.centre(rail + '[aria-current="true"]', workspace.name))
    const label = '[data-rail-row] > button > span.truncate'
    if (!await page.centre('[data-rail-row] > button[aria-current="true"] > span.truncate', view)) {
      await page.clickOn(label, view)
    }
  }

  async checkSeededMail(workspace: Workspace): Promise<void> {
    await this.showWork(workspace, 'Mail')
    await this.page.until('seeded Spring LAN mail in the window', 20_000, () =>
      this.page.eval(`document.querySelector('[data-mail-list]')?.innerText.includes(${JSON.stringify(FIRST_MAIL)})`))
  }

  async workspace(name: string, sector?: string): Promise<Workspace> {
    const { id, path } = await this.rpc<Workspace>(this.box, 'workspace.create', { kind: 'work', sector: sector ?? name.toLowerCase().replaceAll(' ', '-'), name })
    await this.rpc(this.box, 'work.office.filesCopySet', { workspaceId: id, on: true })
    await this.rpc(this.box, 'work.workspace.set', { workspaceId: id, patch: { mayUseDesktop: [this.win.host, ...(this.desk ? [this.desk.host] : [])] } })
    return { id, path, name }
  }

  async mint(kind: keyof typeof KEY_CAPS, name: string): Promise<{ token: string; id: string }> {
    this.abort.signal.throwIfAborted()
    // Finish reading a mint even if a child exits, so the finally can revoke it.
    const key = await rpc<{ token: string; id?: string; key?: { id: string } }>(this.box, 'remote.keys.create', {
      name, audience: 'client', caps: KEY_CAPS[kind]
    }, this.seed, 15_000)
    const id = key.id ?? key.key?.id
    if (!id) throw new Error('Key creation returned no key id')
    return { token: key.token, id }
  }

  private async link(inst: Instance): Promise<void> {
    const { token: key } = await this.mint('owner', `Journey ${inst.name}`)
    await this.rpc(inst, 'remote.environments.add', { url: `http://127.0.0.1:${inst === this.win ? this.winRelay?.port ?? this.box.remote : this.box.remote}`, key, name: 'box' })
    await until(`${inst.name} registers with box`, 90_000, async () => {
      const rows = await this.rpc<{ environmentId: string; registered: boolean }[]>(inst, 'macBridge.policy.get')
      return rows.some((row) => row.environmentId === this.box.host && row.registered)
    }, this.abort.signal)
    await this.rpc(inst, 'macBridge.policy.set', { environmentId: this.box.host, policy: 'read+run' })
  }

  private readonly ports = new Set<number>()

  releaseFakeBrowserTurn(): void {
    this.finishFakeBrowserTurn?.()
  }

  trackPort(port: number): void {
    if (port) this.ports.add(port)
  }

  later(cleanup: () => Promise<void>): void {
    this.cleanups.push(cleanup)
  }

  async afterWalk(): Promise<void> {
    const errors: unknown[] = []
    for (const cleanup of this.cleanups.splice(0).reverse()) {
      try {
        await cleanup()
      } catch (error) {
        errors.push(error)
      }
    }
    if (errors.length) throw new Error(errors.map(words).join(' | '))
  }

  cutWindowLink(on: boolean): void {
    if (!this.winRelay) throw new Error('This run has no socket hop for win')
    this.winRelay.cut(on)
  }

  /** Stops an instance: asked first (SIGTERM), then by force; `abrupt` is a crash, by force at once, with no word to it. */
  async halt(inst: Instance, abrupt = false): Promise<void> {
    inst.halted = true
    const pid = inst.proc?.pid
    if (pid && !abrupt) kill(-pid, 'SIGTERM')
    if (!abrupt) await sleep(750)
    if (pid) kill(-pid, 'SIGKILL')
    inst.port = 0
    for (const owned of instancePids(inst.data)) kill(owned, 'SIGKILL')
    await until(inst.name + ' to stop', 5000, () => !instancePids(inst.data).length)
  }

  /**
   * Quits win as he does: its window is closed, and the app leaves by itself, writing what it keeps on the way out.
   * False when it did not leave in time and was stopped by force (`halt`), which is a crash, not a quit: Chromium
   * may then lose the last minute of what the window kept.
   */
  async quit(inst: Instance): Promise<boolean> {
    // Halted first: its leaving is asked for, not an early exit of the run.
    inst.halted = true
    await this.page.closePage().catch(() => undefined)
    const left = await until(inst.name + ' to quit by itself', 20_000, () => !instancePids(inst.data).length, this.abort.signal).then(() => true, () => false)
    if (!left) await this.halt(inst)
    inst.port = 0
    return left
  }

  async restart(inst: Instance): Promise<void> {
    if (!inst.halted) return
    inst.halted = false
    if (inst === this.win) this.window?.close()
    this.start(inst, this.bin, this.launchOptions)
    if (inst === this.win) {
      this.window = await Window.attach(inst.debug!, this.abort.signal)
      await this.page.until('win’s own listener after relaunch', 30_000, async () =>
        (inst.port = (await this.page.eval<number>('window.api?.getServerPort?.()')) ?? 0))
    } else {
      await until('desk’s own listener after relaunch', 35_000, async () => (inst.port = await deskPort(inst, this.seed)), this.abort.signal)
      await until('desk registers again', 35_000, async () => {
        const rows = await this.rpc<{ environmentId: string; registered: boolean }[]>(inst, 'macBridge.policy.get')
        return rows.some((row) => row.environmentId === this.box.host && row.registered)
      }, this.abort.signal)
    }
  }

  async deviceWindow(): Promise<Window> {
    if (this.givenWindow) return this.givenWindow
    if (!this.tmpRoot) throw new Error('Start the Work instances before giving a computer')
    const giver = this.giver = await instance(this.root, this.tmpRoot, 'giver')
    this.instances.push(giver)
    this.start(giver, this.bin, this.launchOptions)
    await until('the giver’s listener', 30_000, async () => (giver.port = await deskPort(giver, this.seed)), this.abort.signal)
    const box = { envId: this.box.host, origin: 'http://127.0.0.1:' + this.box.remote }
    const owner = await this.mint('owner', 'Journey giver')
    await this.rpc(this.box, 'devices.setGiver', { keyId: owner.id, name: 'Journey giver' })
    await this.rpc(giver, 'remote.environments.add', { url: box.origin, key: owner.token, name: 'box' })
    type Identity = { envId: string; identity: { signPublic: string; sealPublic: string } }
    const from = await this.rpc<Identity>(giver, 'devices.proof', { op: 'identity' })
    await until('the giver is claimed on box', 30_000, async () => {
      const { giver } = await this.rpc<{ giver: { identity?: Identity['identity'] } | null }>(this.box, 'devices.giver')
      return giver?.identity?.signPublic === from.identity.signPublic
    }, this.abort.signal)
    const inst = this.givenInstance = await instance(this.root, this.tmpRoot, 'given')
    this.instances.push(inst)
    this.start(inst, this.bin, this.launchOptions)
    const page = await Window.attach(inst.debug!, this.abort.signal)
    await page.until('the given computer’s listener', 35_000, async () =>
      (inst.port = (await page.eval<number>('window.api?.getServerPort?.()')) ?? 0))
    await page.clickOn('[role="dialog"] button', 'Skip')
    try {
      const key = await this.mint('read', 'Journey given computer')
      const who = await this.rpc<Identity>(inst, 'devices.proof', { op: 'identity' })
      this.givenIdentity = who.envId
      const give = await this.rpc<{ activated: boolean; manifested: boolean }>(giver, 'devices.proof', {
        op: 'give', args: { ...who, keyId: key.id, generation: 1, name: 'Journey given computer' }
      })
      if (!give.activated || !give.manifested) throw new Error('The isolated giver did not activate the computer')
      const pin = await this.rpc<{ environment: { id: string; caps: string[] } }>(inst, 'devices.proof', {
        op: 'pin', args: {
          giver: { signPublic: from.identity.signPublic, envId: from.envId, name: 'Journey giver' },
          box, boxKey: key.token, name: 'box', generation: 1
        }
      })
      if (pin.environment.id !== box.envId || !KEY_CAPS.device.every((cap) => pin.environment.caps.includes(cap)) || pin.environment.caps.includes('admin')) {
        throw new Error('The given computer did not receive its own device key')
      }
      await page.eval('window.__monocode.loadSavedEnvironments()')
      const host = JSON.stringify(this.box.host)
      await page.until('the given computer’s proved link to box', 35_000, () => page.eval(
        `window.__monocode.registry.has(${host}) && window.__monocode.registry.statusOf(${host}).transport === 'open'
          && window.__monocode.registry.linkOf(${host}).request('workspace.list').then(() => true, () => false)`
      ))
      this.givenWindow = page
      return page
    } catch (error) {
      page.close()
      throw error
    }
  }

  async stop(): Promise<Cleanup> {
    this.stopping = true
    const result: Cleanup = { revoked: [], remainingPids: [], errors: [], portsChecked: [], remainingPorts: [] }
    const listeners = () => execFileSync('ss', ['-H', '-ltnp'], { encoding: 'utf8', timeout: 5000 }).trim().split('\n')
    const portOf = (line: string) => Number(line.trim().split(/\s+/)[3]?.match(/:(\d+)$/)?.[1] ?? 0)
    const local = <T>(inst: Instance, method: string, params: unknown = {}) => rpc<T>(inst, method, params, this.seed, 5000)
    try {
      const pids = new Set(instancePids(this.root))
      for (const line of listeners()) {
        if ([...line.matchAll(/pid=(\d+)/g)].some(match => pids.has(Number(match[1])))) this.trackPort(portOf(line))
      }
      for (const inst of this.instances) {
        for (const port of [inst.port, inst.remote, inst.debug, inst.workPort]) if (port) this.trackPort(port)
      }
      for (const hop of this.relays) this.trackPort(hop.port)
      if (this.fakeProvider?.port) this.trackPort(this.fakeProvider.port)
      await this.afterWalk().catch((error) => result.errors.push(words(error)))
      if (this.givenIdentity && this.giver) {
        try {
          const envId = this.givenIdentity
          await local(this.giver, 'devices.computer', { envId, action: 'remove' })
          await until('the given computer’s key to be revoked', 25_000, async () => {
            const { bindings } = await local<{ bindings: { envId: string; keyId: string }[] }>(this.box, 'devices.list')
            const id = bindings.find((row) => row.envId === envId)?.keyId
            const keys = await local<{ id: string }[]>(this.box, 'remote.keys.list')
            if (id && keys.some((key) => key.id === id)) return false
            if (id) result.revoked.push(id)
            return true
          })
        } catch (error) {
          result.errors.push(words(error))
        }
      }
      if (this.box?.port && this.launchOptions.publicOrigin) {
        try {
          const list = async () => (await local<{ keys: { id: string; name: string }[] }>(this.box, 'work.office.addin.list')).keys
          for (const { id } of (await list()).filter(({ name }) => name === 'Journey Word')) {
            if (!(await local<{ removed: boolean }>(this.box, 'work.office.addin.remove', { id })).removed) throw new Error('The dummy Word key did not revoke')
            result.revoked.push(id)
          }
          if ((await list()).some(({ name }) => name === 'Journey Word')) result.errors.push('A dummy Word key is still live')
        } catch (error) {
          result.errors.push(words(error))
        }
      }
      // Only this run can mint credentials in these fresh databases, including portal and setup-link credentials.
      for (const inst of this.instances) {
        for (const [list, revoke] of [
          ['remote.pairings.list', 'remote.pairings.revoke'],
          ['remote.sessions.list', 'remote.sessions.revoke'],
          ['remote.keys.list', 'remote.keys.revoke'],
          ['work.guests.list', 'work.guests.revoke']
        ] as const) {
          if (!inst.port || inst.halted) break
          if (list === 'work.guests.list' && inst !== this.box) continue
          try {
            const live = async () => (await local<{ id: string; revokedAt?: number | null; endedAt?: number | null }[]>(inst, list))
              .filter((row) => !row.revokedAt && !row.endedAt)
            for (const { id } of await live()) {
              try {
                const reply = await local<boolean>(inst, revoke, list === 'work.guests.list' ? { linkId: id } : { id })
                if (reply === false) throw new Error(revoke + ' returned false for ' + id)
              } catch (error) {
                // Guest revoke writes first and waits for LifeOS before answering. Read the saved row if the answer was late.
                if (list !== 'work.guests.list' || (await live()).some(row => row.id === id)) throw error
              }
              result.revoked.push(id)
            }
            if ((await live()).length) result.errors.push(list + ' still has live entries')
          } catch (error) {
            result.errors.push(words(error))
          }
        }
      }
    } finally {
      await this.sandbox?.stop().catch(error => result.errors.push(words(error)))
      for (const hop of this.relays) await hop.stop().catch((error) => result.errors.push(words(error)))
      this.releaseFakeBrowserTurn()
      await this.fakeProvider?.stop(true)
      this.window?.close()
      this.givenWindow?.close()
      for (const inst of this.instances) if (!inst.halted && inst.proc?.pid) kill(-inst.proc.pid, 'SIGTERM')
      await sleep(750)
      for (const inst of this.instances) if (!inst.halted && inst.proc?.pid) kill(-inst.proc.pid, 'SIGKILL')
      for (let i = 0; i < 10; i++) {
        result.remainingPids = instancePids(this.root)
        if (!result.remainingPids.length) break
        for (const pid of result.remainingPids) kill(pid, 'SIGKILL')
        await sleep(100)
      }
      result.remainingPids = instancePids(this.root)
      if (!result.remainingPids.length) {
        for (const temp of [this.tmpRoot, this.chromiumTmp]) if (temp) rmSync(temp, { recursive: true, force: true })
      }
      result.portsChecked = [...this.ports].sort((a, b) => a - b)
      // A stopped sandbox's listeners can take a moment to close on a loaded box: look again for up to three seconds.
      for (let i = 0; i < 30; i++) {
        result.remainingPorts = listeners().map(portOf).filter(port => this.ports.has(port))
        if (!result.remainingPorts.length) break
        await sleep(100)
      }
      if (result.remainingPorts.length) result.errors.push('Listeners remain on ports ' + result.remainingPorts.join(', '))
    }
    return result
  }
}
