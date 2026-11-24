import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_THREAD_DEFAULTS } from '../../../src/shared/defaults'
import { freePort, linkTools, sleep, TOOLS } from '../../e2e-work-lib'
import { withAppToken } from '../../lib/appToken'
import { dummyLibrary, gioStub } from './files'
import { seedFakeAccount, startFakeProvider } from './fakeProvider'
import { until, Window } from './window'

export const SHAPES = ['A', 'B1', 'B2', 'V', 'S', 'K', 'U'] as const
export type Shape = typeof SHAPES[number]
export const KEY_CAPS = {
  owner: ['read', 'operate', 'approve', 'admin'],
  device: ['operate', 'approve', 'device'],
  read: ['read']
} as const

type Seat = 'win' | 'box' | 'desk'
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
}
type Workspace = { id: string; path: string; name: string }
type Reply<T> = { ok: true; value: T } | { ok: false; error: string }
export type Cleanup = { revoked: string[]; remainingPids: number[]; errors: string[] }

export const words = (error: unknown): string => error instanceof Error ? error.message : String(error)

/** Keep the tool search path and locale. All app, CLI and provider settings come from the run. */
export function isolatedEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(source).filter(([key]) => /^(PATH|LANG|LC_[A-Z_]+)$/.test(key)))
}

async function instance(root: string, name: Seat): Promise<Instance> {
  const home = join(root, name + '-home')
  const data = join(root, name + '-data')
  const tmp = join(root, name + '-tmp')
  const work = join(home, 'work')
  for (const dir of [home, data, tmp, work, join(home, '.claude'), join(home, '.codex')]) mkdirSync(dir, { recursive: true })
  return {
    name, home, data, tmp, work,
    remote: await freePort(),
    ...(name === 'win' ? { debug: await freePort() } : {}),
    workPort: await freePort(),
    log: join(root, name + '.log'),
    port: 0,
    host: ''
  }
}

/** xvfb also gives the headless host a display for its hidden preview windows. */
type LaunchOptions = { fakeOrigin?: string; fullEditor?: boolean }

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
    TEMP_CODE_HEADLESS: inst.name === 'box' ? '1' : '0',
    TEMP_CODE_REMOTE_PORT: String(inst.remote),
    ...(inst.debug ? { TEMP_CODE_DEBUG_PORT: String(inst.debug) } : {}),
    TEMP_CODE_ALIAX_DATA_DIR: join(inst.data, 'aliax'),
    TEMP_CODE_CLAIM_SHIM: '0',
    TEMP_CODE_FAKE_PROVIDERS: options.fakeOrigin ?? 'http://127.0.0.1:9',
    TEMP_CODE_WORK_ROOT: inst.work,
    TEMP_CODE_WORK_PORT: String(inst.workPort),
    ...(inst.name === 'box' && options.fullEditor ? { TEMP_CODE_WORK_PUBLIC_ORIGIN: `http://127.0.0.1:${inst.workPort}` } : {}),
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
  private readonly keys: string[] = []
  private readonly instances: Instance[] = []
  private window?: Window
  private fakeProvider?: ReturnType<typeof startFakeProvider>
  fakeMessages = 0
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
      if (!this.stopping) this.abort.abort(new Error(`${inst.name} exited early (${detail}). See ${inst.log}`))
    }
    proc.once('error', (error) => early(words(error)))
    proc.once('exit', (code, signal) => early(String(signal ?? code)))
  }

  rpc<T = unknown>(inst: Instance, method: string, params: unknown = {}, ms = 15_000): Promise<T> {
    this.abort.signal.throwIfAborted()
    return rpc(inst, method, params, this.seed, ms, this.abort.signal)
  }

  async fromWindow<T>(method: string, params: unknown = {}): Promise<Reply<T>> {
    try {
      return await this.page.eval(`(async () => {
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

  async open(withDesk: boolean, name: string, options: { fake?: boolean; fullEditor?: boolean } = {}): Promise<Workspace> {
    this.win = await instance(this.root, 'win')
    this.box = await instance(this.root, 'box')
    this.desk = withDesk ? await instance(this.root, 'desk') : undefined
    this.instances.push(this.win, this.box, ...(this.desk ? [this.desk] : []))
    this.l1 = dummyLibrary(this.win.home, 'Journey Teams L1')
    if (this.desk) this.l2 = dummyLibrary(this.desk.home, 'Journey Teams L2')
    const tools = existsSync(join(TOOLS, 'state.json')) ? realpathSync(TOOLS) : undefined
    linkTools(this.box.data)
    const bin = gioStub(this.root)
    this.abort.signal.throwIfAborted()
    if (options.fake) {
      seedFakeAccount(join(this.box.data, 'aliax'))
      this.fakeProvider = startFakeProvider(() => { this.fakeMessages++ })
    }
    const fakeOrigin = this.fakeProvider?.url.origin
    for (const inst of this.instances) this.start(inst, bin, { fullEditor: options.fullEditor, fakeOrigin }, inst === this.box ? tools : undefined)
    this.window = await Window.attach(this.win.debug!, this.abort.signal)
    const wait = (label: string, test: () => unknown | Promise<unknown>) => until(label, 90_000, test, this.abort.signal)
    await wait('local ports', async () => {
      this.win.port ||= (await this.page.eval<number | null>('window.api?.getServerPort?.()')) ?? 0
      const file = join(this.box.data, 'server.json')
      if (!this.box.port && existsSync(file)) this.box.port = (JSON.parse(readFileSync(file, 'utf8')) as { port: number }).port
      if (this.desk) this.desk.port ||= await deskPort(this.desk, this.seed)
      return this.win.port && this.box.port && (!this.desk || this.desk.port)
    })
    await this.page.clickOn('[role="dialog"] button', 'Skip')
    for (const inst of this.instances) inst.host = (await this.rpc<{ environmentId: string }>(inst, 'remote.status')).environmentId
    for (const inst of this.instances) await this.rpc(inst, 'work.set', { enabled: true })
    const workspace = await this.workspace(name)
    await this.link(this.win)
    if (this.desk) await this.link(this.desk)
    await this.page.eval('window.__monocode.loadSavedEnvironments()')
    const host = JSON.stringify(this.box.host)
    await wait('the window link to box', () => this.page.eval(`window.__monocode.registry.has(${host}) && window.__monocode.registry.statusOf(${host}).transport === 'open'`))
    await this.rpc(this.box, 'defaults.set', { workspaceId: null, defaults: { ...DEFAULT_THREAD_DEFAULTS, permission: 'auto' } })
    return workspace
  }

  async workspace(name: string): Promise<Workspace> {
    const { id, path } = await this.rpc<Workspace>(this.box, 'workspace.create', { kind: 'work', sector: name.toLowerCase().replaceAll(' ', '-'), name })
    await this.rpc(this.box, 'work.office.filesCopySet', { workspaceId: id, on: true })
    await this.rpc(this.box, 'work.workspace.set', { workspaceId: id, patch: { mayUseDesktop: [this.win.host, ...(this.desk ? [this.desk.host] : [])] } })
    return { id, path, name }
  }

  async mint(kind: keyof typeof KEY_CAPS, name: string): Promise<string> {
    this.abort.signal.throwIfAborted()
    // Finish reading a mint even if a child exits, so the finally can revoke it.
    const key = await rpc<{ token: string; id?: string; key?: { id: string } }>(this.box, 'remote.keys.create', {
      name, audience: 'client', caps: KEY_CAPS[kind]
    }, this.seed, 15_000)
    const id = key.id ?? key.key?.id
    if (!id) throw new Error('Key creation returned no key id')
    this.keys.push(id)
    return key.token
  }

  private async link(inst: Instance): Promise<void> {
    const key = await this.mint('owner', `Journey ${inst.name}`)
    await this.rpc(inst, 'remote.environments.add', { url: `http://127.0.0.1:${this.box.remote}`, key, name: 'box' })
    await until(`${inst.name} registers with box`, 90_000, async () => {
      const rows = await this.rpc<{ environmentId: string; registered: boolean }[]>(inst, 'macBridge.policy.get')
      return rows.some((row) => row.environmentId === this.box.host && row.registered)
    }, this.abort.signal)
    await this.rpc(inst, 'macBridge.policy.set', { environmentId: this.box.host, policy: 'read+run' })
  }

  async stop(): Promise<Cleanup> {
    this.stopping = true
    const result: Cleanup = { revoked: [], remainingPids: [], errors: [] }
    try {
      for (const id of this.keys) {
        try {
          const revoked = await rpc<boolean>(this.box, 'remote.keys.revoke', { id }, this.seed, 5000)
          if (!revoked) throw new Error(`Revocation of ${id} returned false`)
          result.revoked.push(id)
          console.log(`Revoked key ${id}`)
        } catch (error) {
          result.errors.push(words(error))
        }
      }
      if (this.keys.length) {
        try {
          const live = await rpc<{ id: string }[]>(this.box, 'remote.keys.list', {}, this.seed, 5000)
          if (live.some(({ id }) => this.keys.includes(id))) result.errors.push('A journey key is still live')
        } catch (error) {
          result.errors.push(words(error))
        }
      }
    } finally {
      await this.fakeProvider?.stop(true)
      this.window?.close()
      for (const inst of this.instances) if (inst.proc?.pid) kill(-inst.proc.pid, 'SIGTERM')
      await sleep(750)
      for (const inst of this.instances) if (inst.proc?.pid) kill(-inst.proc.pid, 'SIGKILL')
      for (let i = 0; i < 10; i++) {
        result.remainingPids = instancePids(this.root)
        if (!result.remainingPids.length) break
        for (const pid of result.remainingPids) kill(pid, 'SIGKILL')
        await sleep(100)
      }
      result.remainingPids = instancePids(this.root)
    }
    return result
  }
}
