/** Headless host measurements. Run through .temp-code/bin/heavy --low. */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { appendFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import type { AgentEvent, SessionMeta } from '../../src/shared/events'
import type { EventsPage } from '../../src/shared/wire'
import { openDb, Store, tailStart } from '../../src/main/server/db'
import { CheckpointStore } from '../../src/main/server/checkpoint'
import { attach, freePort, proofRpc } from '../e2e-work-lib'
import { mainCheckout } from '../journeys/lib/record'
import { PRACTICE_ACCOUNTS, seedFakeAccount } from '../journeys/lib/fakeProvider'
import { instancePids, isolatedEnvironment, KEY_CAPS, words } from '../journeys/lib/shape'
import { toolCall } from '../journeys/lib/thread'
import { connectProbes, openClient, remoteSocketUrl, type ProbeClient, type ProbeSeed, type Timed } from '../lib/connectProbe'
import { batchRowMidRun } from '../lib/ios-seeds'
import { perfThread } from '../lib/ios-perf-seeds'
import { restoreCopyPaths, stageCopyPaths } from './lib/copyPaths'
import { guardLiveBox } from './lib/guard'
import { perfProvider, startLoad } from './lib/load'
import { requireScrubbed } from './scrubCopy'

export const HOST_SCENES = { connect: 'H01', loop: 'H02', read: 'H03', flush: 'H04', settle: 'H05', watch: 'H09', boot: 'H06' } as const
type Scene = keyof typeof HOST_SCENES
const THREADS = 40
const ADMISSION_ROOM = 2
const MAX_MS = 60_000
const DEFAULT_MAX_LOAD = 40
const MAX_ANON_GIB = 68
const OFFLINE = 'http://127.0.0.1:9'
const REPO = fileURLToPath(new URL('../..', import.meta.url))
const USAGE = 'perf:host --scene connect|loop|read|flush|settle|watch [--browser] | --boot [--seed-size small|real | --copy <userData>] [--max-load <n>]'

export function hostFlags(args: string[]) {
  let scene: Scene | undefined
  let browser = false
  let seedSize: 'small' | 'real' | undefined
  let copy: string | undefined
  let maxLoad = DEFAULT_MAX_LOAD
  const seen = new Set<string>()
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]!
    if (seen.has(flag)) throw new Error(`Repeated flag ${flag}`)
    seen.add(flag)
    switch (flag) {
      case '--boot':
        if (scene) throw new Error('Choose one scene or --boot')
        scene = 'boot'
        break
      case '--scene': {
        if (scene) throw new Error('Choose one scene or --boot')
        const value = args[++i]
        if (!value || value === 'boot' || !Object.hasOwn(HOST_SCENES, value)) throw new Error(USAGE)
        scene = value as Scene
        break
      }
      case '--browser':
        browser = true
        break
      case '--seed-size': {
        const value = args[++i]
        if (value !== 'small' && value !== 'real') throw new Error('--seed-size takes small or real')
        seedSize = value
        break
      }
      case '--max-load': {
        const value = Number(args[++i])
        if (!Number.isFinite(value) || value <= 0) throw new Error('--max-load takes a positive number')
        maxLoad = value
        break
      }
      case '--copy':
        copy = args[++i]
        if (!copy || copy.startsWith('--')) throw new Error('--copy needs a userData path')
        break
      default:
        throw new Error(`Unknown flag ${flag}`)
    }
  }
  if (!scene || (browser && scene !== 'loop') || ((copy || seedSize) && scene !== 'boot') || (copy && seedSize))
    throw new Error(USAGE)
  return { scene, browser, copy, seedSize: seedSize ?? 'small', maxLoad }
}

/** Nearest rank, so even a single sample has a percentile. */
export function percentile(values: readonly number[], rank: number): number | null {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.max(0, Math.ceil(sorted.length * rank / 100) - 1)]!
}

function stats(values: readonly number[]) {
  return {
    count: values.length,
    p50: percentile(values, 50), p95: percentile(values, 95), p99: percentile(values, 99),
    max: percentile(values, 100)
  }
}

export function onceInOrder(seqs: readonly number[], first: number, last: number): boolean {
  return seqs.length === last - first + 1 && seqs.every((seq, i) => seq === first + i)
}

export function expectedTailStart(events: readonly AgentEvent[], blocks: number, beforeSeq = events.length + 1): number {
  const scan = events.slice(0, beforeSeq - 1).map((event, index) => ({
    seq: index + 1, type: event.type,
    callId: 'callId' in event ? event.callId ?? null : null,
    msgId: 'msgId' in event ? event.msgId ?? null : null,
    blockIndex: 'blockIndex' in event ? event.blockIndex ?? null : null
  })).reverse()
  return tailStart(scan, blocks) ?? 1
}

type Slice = { at: number; ms: number }
type Stall = Slice & { cause: string; line: string }
export function stallSlices(log: string, from: number, to: number): Stall[] {
  return log.split('\n').flatMap((line) => {
    const match = /^(\S+) (?:loop max=(\d+)ms|timed (.+?) (\d+)ms)(?: |$)/.exec(line)
    if (!match) return []
    const at = Date.parse(match[1]!)
    return at >= from && at <= to ? [{ at, ms: Number(match[2] ?? match[4]), cause: match[3] ?? 'loop', line }] : []
  })
}

export function over(slices: readonly Slice[], threshold: number, from: number, to: number): Slice[] {
  return slices.filter(({ at, ms }) => ms > threshold && at >= from && at <= to)
}

export function copyIndexRows(log: string): number | null {
  const match = /^\[boot\] \d+ turn-index done (\d+) rows$/m.exec(log)
  return match ? Number(match[1]) : null
}

export function lastAllowedCores(list: string): string {
  return list.trim().split(',').flatMap((span) => {
    const [first, last = first] = span.split('-').map(Number)
    return Array.from({ length: last! - first! + 1 }, (_, i) => first! + i)
  }).slice(-8).join(',')
}

function read(path: string): string {
  try {
    return readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw error
  }
}

function loadOne(): number {
  return Number(read('/proc/loadavg').split(' ')[0])
}

function agentsAnonGiB(): number | null {
  const bytes = /^anon (\d+)$/m.exec(read('/sys/fs/cgroup/agents.slice/memory.stat'))?.[1]
  return bytes === undefined ? null : Number(bytes) / (1024 ** 3)
}

function ownsPid(pid: number, group: number): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    return Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[2]) === group
  } catch {
    return false
  }
}

function signalPid(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
  }
}

type Options = ReturnType<typeof hostFlags>
type Metric = { metric: string; count?: number; p50?: number | null; p95?: number | null; p99?: number | null; max?: number | null; ms?: number | null }
type Result = {
  scene: Scene
  budget: string
  at: string
  cores?: string
  liveHelloMs?: (number | null)[]
  measuredMs?: number
  load1?: number
  load1End?: number
  peakLoad1?: number
  anonGiB?: number | null
  anonGiBEnd?: number | null
  streams?: number
  rows: Metric[]
  details: Record<string, unknown>
  error?: string
  remainingPids?: number[]
}

class Rig {
  readonly root = mkdtempSync('/tmp/docket-host-')
  readonly repo = join(this.root, 'repo')
  readonly seed = randomBytes(32).toString('hex')
  readonly signal: AbortSignal
  readonly finishStreams = new AbortController()
  readonly box = { port: 0 }
  readonly data: string
  readonly remotePort: number
  private readonly children: ChildProcess[] = []
  private readonly sockets = new Set<ProbeClient>()
  private readonly services: { stop(force?: boolean): unknown }[] = []
  streams = 0
  remoteKey?: string
  started = 0
  private inspectPort = 0
  private appPid?: number
  private copyPathsStaged = false
  private readonly boxLog: string
  readonly env: NodeJS.ProcessEnv

  constructor(readonly options: Options, readonly abort: AbortController, copy: string | undefined, remotePort: number, chromium?: string) {
    this.signal = abort.signal
    this.data = copy ?? join(this.root, 'data')
    this.remotePort = remotePort
    this.boxLog = join(this.root, 'box.log')
    const home = join(this.root, 'home')
    const tmp = join(this.root, 'tmp')
    const bin = join(this.root, 'bin')
    const vm = join(this.root, 'no-vm')
    for (const dir of [home, tmp, bin, vm, this.data, this.repo]) mkdirSync(dir, { recursive: true })
    this.env = {
      ...isolatedEnvironment(process.env),
      PATH: [bin, '/srv/agents/home/.local/bin', process.env.PATH].join(':'),
      HOME: home, TMPDIR: tmp, WINVM_DIR: vm,
      CLAUDE_CONFIG_DIR: join(home, '.claude'), CODEX_HOME: join(home, '.codex'),
      TEMP_CODE_USER_DATA: this.data, TEMP_CODE_HEADLESS: '1',
      TEMP_CODE_REMOTE_PORT: String(remotePort), TEMP_CODE_CLAIM_SHIM: '0',
      TEMP_CODE_ALIAX_DATA_DIR: join(this.root, 'aliax'),
      TEMP_CODE_LIFEOS_URL: OFFLINE, TEMP_CODE_LIFEOS_MCP_URL: OFFLINE + '/mcp',
      TEMP_CODE_WORK_ROOT: join(home, 'work'), TEMP_CODE_WARM_HARNESS: '0',
      TEMP_CODE_APP_TOKEN_SEED: this.seed, TEMP_CODE_WORK_TOKEN_SEED: this.seed,
      ...(options.scene === 'read' ? { TEMP_CODE_E2E_STATUS: '1' } : {}),
      ...(chromium ? { TEMP_CODE_BOX_CHROMIUM: chromium } : {}),
      AGENT_CLI_CREDENTIAL_STORE: 'file', NODE_ENV: 'production', SHELL: '/bin/bash',
      DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1', DISABLE_NONESSENTIAL_MODEL_CALLS: '1'
    }
  }

  spawn(command: string, args: string[], log?: string): ChildProcess {
    this.signal.throwIfAborted()
    const child = spawn(command, args, {
      cwd: REPO, env: this.env, detached: true, stdio: ['ignore', log ? 'pipe' : 'ignore', log ? 'pipe' : 'ignore']
    })
    this.children.push(child)
    child.once('error', (error) => this.abort.abort(error))
    if (log) {
      const record = (bytes: Buffer): void => appendFileSync(log, bytes)
      child.stdout?.on('data', record)
      child.stderr?.on('data', record)
    }
    return child
  }

  async boot(): Promise<number> {
    if (!existsSync(join(REPO, 'out/main/index.js'))) throw new Error('Build Electron in this worktree before running perf:host')
    const sampleLoop = ['loop', 'settle', 'watch'].includes(this.options.scene)
    if (sampleLoop) this.inspectPort = await freePort()
    const provider = perfProvider(240, {
      finish: this.finishStreams.signal,
      resume: this.options.scene === 'boot',
      onStream: () => { this.streams++ }
    })(() => {})
    this.services.push(provider)
    this.env.TEMP_CODE_FAKE_PROVIDERS = provider.url.origin
    this.env.TEMP_CODE_DEBUG_PORT = String(await freePort())
    this.env.TEMP_CODE_WORK_PORT = String(await freePort())
    if (!this.options.copy) seedFakeAccount(this.env.TEMP_CODE_ALIAX_DATA_DIR!, true)
    const electron = join(REPO, 'node_modules', 'electron', 'dist', 'electron')
    if (this.options.copy) {
      const db = new DatabaseSync(this.dbPath)
      try {
        stageCopyPaths(db, this.root)
        this.copyPathsStaged = true
      } finally {
        db.close()
      }
    }
    this.started = performance.now()
    const args = sampleLoop ? [`--inspect=127.0.0.1:${this.inspectPort}`, '.'] : ['.']
    const app = this.spawn('xvfb-run', [
      '-a', '-s', '-screen 0 1440x900x24 -nolisten tcp', 'dbus-run-session', '--', electron, ...args
    ], this.boxLog)
    app.once('exit', (code, signal) => this.abort.abort(new Error(`box exited (${signal ?? code})${this.bootLogTail()}`)))
    const deadline = this.started + MAX_MS
    while (performance.now() < deadline) {
      this.signal.throwIfAborted()
      const status = read(join(this.data, 'server.json'))
      try {
        const { port, pid } = JSON.parse(status) as { port: number; pid: number }
        if (app.pid && ownsPid(pid, app.pid) && Number.isInteger(port) && port > 0 && port <= 65535) {
          this.appPid = pid
          this.box.port = port
          const remaining = Math.max(1, deadline - performance.now())
          const hello = await openClient(`ws://127.0.0.1:${port}/`, Math.min(1000, remaining), { signal: this.signal, hello: true })
          hello.close()
          return performance.now() - this.started
        }
      } catch {
        this.signal.throwIfAborted()
      }
      await sleep(25, undefined, { signal: this.signal })
    }
    throw new Error(`No hello from the headless instance${this.bootLogTail()}`)
  }

  private bootLogTail(): string {
    const log = read(this.boxLog)
    if (!this.options.copy) return '\n' + log.slice(-4000)
    // Keep the Chromium fatal's source location only. A copied host can
    // log transcript or workspace content and that must stay in scratch.
    const fatal = /FATAL:([a-z0-9_/.]+\.cc):(\d+)\]/i.exec(log)
    return fatal ? ` (${fatal[1]}:${fatal[2]})` : ''
  }

  async waitForCopyIndex(): Promise<number | null> {
    // Hello precedes the background catch-up. Let it finish before the
    // second copy boot, without adding its wait to the hello measurement.
    const deadline = this.started + MAX_MS
    while (performance.now() < deadline) {
      this.signal.throwIfAborted()
      const rows = copyIndexRows(read(this.boxLog))
      if (rows !== null) return rows
      await sleep(250, undefined, { signal: this.signal })
    }
    return null
  }

  get dbPath(): string {
    const renamed = join(this.data, 'docket.db')
    return existsSync(renamed) ? renamed : join(this.data, 'temp-code.db')
  }

  rpc<T>(host: { port: number }, method: string, params: unknown = {}, ms = 10_000): Promise<T> {
    return proofRpc<T>(host.port, method, params, ms, this.signal)
  }

  async mint(name: string): Promise<string> {
    const { token } = await this.rpc<{ token: string }>(this.box, 'remote.keys.create', { name, audience: 'client', caps: KEY_CAPS.owner })
    return token
  }

  async remote(key = this.remoteKey!, signal = this.signal, onPush?: (message: { push?: string; projectId?: string }) => void) {
    const ticketDeadline = AbortSignal.any([signal, AbortSignal.timeout(1500)])
    const url = await remoteSocketUrl(`http://127.0.0.1:${this.remotePort}`, key, ticketDeadline)
    const socket = await openClient(url, 1500, { signal, hello: true, onPush })
    this.sockets.add(socket)
    return socket
  }

  close(socket: ProbeClient): void {
    socket.close()
    this.sockets.delete(socket)
  }

  burner(seconds: number): void {
    // timeout and its shell share our detached process group.
    this.spawn('timeout', ['--foreground', '-s', 'KILL', String(seconds), 'sh', '-c', 'while :; do :; done'])
  }

  stalls(from: number, to: number): Stall[] {
    const log = join(this.data, 'logs', 'stalls.log')
    return stallSlices(read(log + '.1') + read(log), from, to)
  }

  async sampler(from: number, to: number) {
    // Inspect only the Node target this bench started. The timer runs on box's
    // main loop, and saves each late tick without polling the host over RPC.
    if (!read(this.boxLog).includes(`Debugger listening on ws://127.0.0.1:${this.inspectPort}/`)) {
      throw new Error('The isolated Electron main process did not publish its inspector')
    }
    const cdp = await attach(this.inspectPort, 3000, this.signal, () => true, 'node')
    try {
      await cdp.eval(`(() => {
        const slices = [];
        const windows = [];
        let deadline = performance.now() + 10;
        let count = 0, max = 0, sum = 0, until = ${from} + 1000;
        globalThis.hostBenchDelay = { slices, windows, timer: setInterval(() => {
          const at = Date.now();
          const now = performance.now(), ms = Math.max(0, now - deadline);
          deadline = now + 10;
          if (at <= ${from}) return;
          if (ms > 50 && at - ms <= ${to}) slices.push({ at, ms });
          if (at <= ${to}) {
            count++; max = Math.max(max, ms); sum += ms;
            if (at >= until) {
              windows.push({ at, ms: max, meanMs: sum / count, count });
              until = at + 1000;
              count = 0; max = 0; sum = 0;
            }
          } else {
            if (count) windows.push({ at: ${to}, ms: max, meanMs: sum / count, count });
            clearInterval(globalThis.hostBenchDelay.timer);
          }
        }, 10).unref() };
      })()`, 3000, this.signal)
    } catch (error) {
      cdp.close()
      throw error
    }
    this.services.push({ stop: () => cdp.close() })
    return () => cdp.eval<{ slices: Slice[]; windows: (Slice & { meanMs: number; count: number })[] }>(
      '({ slices: hostBenchDelay.slices, windows: hostBenchDelay.windows })', 5000, this.signal
    )
  }

  site(): string {
    const site = Bun.serve({
      hostname: '127.0.0.1', port: 0,
      fetch: () => new Response('<!doctype html><title>Host bench dummy</title><p>Practice cones</p>', { headers: { 'content-type': 'text/html' } })
    })
    this.services.push(site)
    return site.url.href
  }

  async stop(): Promise<number[]> {
    for (const socket of this.sockets) socket.close()
    const stopped = await Promise.allSettled(this.services.reverse().map(async (service) => service.stop(true)))
    const groups = this.children.flatMap(({ pid }) => pid ? [-pid] : [])
    // Give Electron on the scrubbed copy its chance to quit while its
    // display and D-Bus still work. The second boot needs a closed profile.
    const appPid = this.appPid
    if (this.options.copy && appPid && groups.some((group) => ownsPid(appPid, -group))) {
      signalPid(appPid, 'SIGTERM')
      for (let pass = 0; pass < 30 && groups.some((group) => ownsPid(appPid, -group)); pass++) await sleep(100)
    }
    for (const group of groups) signalPid(group, 'SIGTERM')
    if (groups.length) await sleep(750)
    for (const group of groups) signalPid(group, 'SIGKILL')
    // Some children create a new session. Their inherited run paths mark them.
    for (let pass = 0; pass < 10; pass++) {
      const pids = instancePids(this.root)
      if (!pids.length) break
      for (const pid of pids) signalPid(pid, 'SIGKILL')
      await sleep(100)
    }
    const remaining = instancePids(this.root)
    if (!remaining.length && this.options.copy) {
      if (appPid) this.cleanCopyIdentity(appPid)
      if (this.copyPathsStaged) {
        const db = new DatabaseSync(this.dbPath)
        try {
          restoreCopyPaths(db)
        } finally {
          db.close()
        }
      }
    }
    const failed = stopped.find((item) => item.status === 'rejected')
    if (failed) throw failed.reason
    return remaining
  }

  private cleanCopyIdentity(appPid: number): void {
    // The scrub gate confirmed there was no identity or profile lock
    // before our launch. Remove only this finished run's temporary markers.
    const serverFile = join(this.data, 'server.json')
    const server = read(serverFile)
    if (server && (JSON.parse(server) as { pid?: number }).pid !== appPid) throw new Error('The copy published a different owner during shutdown')
    for (const name of ['environment.json', 'server.json']) rmSync(join(this.data, name), { force: true })
    const lock = join(this.data, 'SingletonLock')
    try {
      if (readlinkSync(lock).endsWith(`-${appPid}`)) {
        for (const name of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) rmSync(join(this.data, name), { force: true })
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
}

function git(rig: Rig, ...args: string[]): void {
  execFileSync('git', ['-C', rig.repo, '-c', 'user.name=Host bench', '-c', 'user.email=bench@example.test', ...args], {
    env: rig.env, stdio: 'ignore', timeout: 5000
  })
}

function scratchRepo(rig: Rig): void {
  git(rig, 'init', '-q')
  writeFileSync(join(rig.repo, 'README.md'), 'Host benchmark practice checkout\n')
  git(rig, 'add', 'README.md')
  git(rig, 'commit', '-qm', 'Start the scratch checkout')
}

const WORKSPACE = 'host-bench-workspace'
const SECOND_WORKSPACE = 'host-bench-workspace-two'
const PROJECT = 'host-bench-project'
const FOCUSED = 'host-bench-focused'
const READ_ROWS = 600
const readFixture = (): AgentEvent[] => perfThread(FOCUSED, { rows: READ_ROWS, turns: 12, seed: 4 })
const BOOT_PREFIX = 'host-bench-boot-'

function meta(id: string, cwd: string, patch: Partial<SessionMeta> = {}): SessionMeta {
  const now = Date.now()
  return {
    id, cwd, projectId: null, workspaceId: WORKSPACE, parentId: null,
    provider: 'claude', model: 'claude-sonnet-5-5', reasoning: 'low', agentType: 'implementer',
    threadType: 'chat', planPath: null, title: id, status: 'idle', archived: false, pinned: false, permission: 'auto',
    fast: false, ultrafast: false, context1m: false, busySince: null, pausedAt: null, frozenActiveElapsed: null,
    nativeId: null, createdAt: now, updatedAt: now, ...patch
  }
}

function database(rig: Rig) {
  return openDb(rig.dbPath)
}

function seedProject(rig: Rig, store: Store): void {
  const createdAt = Date.now()
  store.insertWorkspace({ id: WORKSPACE, name: 'Host bench', path: rig.repo, git: true, createdAt })
  const other = join(rig.repo, 'second-account')
  mkdirSync(other, { recursive: true })
  store.insertWorkspace({ id: SECOND_WORKSPACE, name: 'Host bench two', path: other, git: false, createdAt })
  store.setWorkspaceAccounts(WORKSPACE, { claude: PRACTICE_ACCOUNTS[0] })
  store.setWorkspaceAccounts(SECOND_WORKSPACE, { claude: PRACTICE_ACCOUNTS[1] })
  store.insertProject({ id: PROJECT, name: 'Host bench', workspaceId: WORKSPACE, mode: 'local', branch: null, cwd: rig.repo, createdAt })
}

function persistRows(db: ReturnType<typeof openDb>, id: string, events: ReturnType<typeof perfThread>): void {
  const put = db.prepare('INSERT INTO events (session_id, seq, ts, payload) VALUES (?, ?, ?, ?)')
  const ts = Date.now()
  db.exec('BEGIN')
  try {
    for (const [index, event] of events.entries()) put.run(id, index + 1, ts, JSON.stringify(event))
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

async function seedScene(rig: Rig): Promise<ProbeSeed> {
  const unfocused = 'host-bench-unfocused'
  const masterId = 'host-bench-master'
  const children = Array.from({ length: 3 }, (_, i) => `host-bench-child-${i}`)
  const db = database(rig)
  try {
    const store = new Store(db)
    seedProject(rig, store)
    if (rig.options.scene === 'connect' || rig.options.scene === 'read') {
      for (const id of [FOCUSED, unfocused, masterId, ...children]) {
        store.insertSession(meta(id, rig.repo, { projectId: PROJECT, isMaster: id === masterId, ...(children.includes(id) ? { masterId, startedBy: masterId } : {}) }))
      }
      persistRows(db, FOCUSED, readFixture())
      store.setSetting(`batch:${masterId}`, JSON.stringify(batchRowMidRun(masterId, { landed: [], pending: children }, Date.now())))
    }
  } finally {
    db.close()
  }
  const fillerDirs: string[] = []
  if (rig.options.scene === 'connect') {
    const checkpoints = new CheckpointStore(join(rig.data, 'checkpoints'))
    for (const id of [FOCUSED, unfocused]) {
      const path = `${id}.txt`
      await checkpoints.ensure(id, rig.repo)
      writeFileSync(join(rig.repo, path), 'A scratch change\n')
      await checkpoints.record(id, rig.repo, [{ relative: path, inHead: false }])
    }
    for (let i = 0; i < 8; i++) {
      const folder = join(rig.repo, `host-bench-filler-${i}`)
      mkdirSync(folder)
      fillerDirs.push(folder)
    }
    // Only filler git reads wait. Keep the bulk slots occupied without
    // injecting fake loop lag or changing the host's answering paths.
    const realGit = execFileSync('which', ['git'], { env: rig.env, encoding: 'utf8' }).trim()
    writeFileSync(join(rig.root, 'bin', 'git'), `#!/bin/sh
case "$3" in
  "${rig.repo}"/host-bench-filler-*)
    printf '%s\n' "$3" >> "${rig.root}/filler-starts"
    sleep 3 ;;
esac
exec "${realGit}" "$@"
`, { mode: 0o700 })
  }
  return { repo: rig.repo, projectId: PROJECT, focused: FOCUSED, unfocused, masterId, children, fillerDirs }
}

export function bootLayout(size: Options['seedSize']) {
  return size === 'real' ? { threads: 2000, rows: 1_000_000, long: 30_000 } : { threads: 48, rows: 6000, long: 900 }
}

export function bootRows({ threads, rows, long }: ReturnType<typeof bootLayout>, index: number): number {
  if (index === 0) return long
  const remaining = rows - long
  return Math.floor(remaining / (threads - 1)) + Number(index <= remaining % (threads - 1))
}

async function seedBoot(rig: Rig): Promise<Record<string, number>> {
  const layout = bootLayout(rig.options.seedSize)
  const { threads, rows, long } = layout
  const db = database(rig)
  try {
    const store = new Store(db)
    seedProject(rig, store)
    store.setSetting('admission.maxRunning', String(THREADS + ADMISSION_ROOM))
    const ledger: Parameters<Store['recordResumeAfterBoot']>[0] = []
    for (let i = 0; i < threads; i++) {
      if (i % 16 === 0) await sleep(0, undefined, { signal: rig.signal })
      const id = BOOT_PREFIX + i
      const resume = i < THREADS
      const count = bootRows(layout, i)
      const workspaceId = i < THREADS / 2 ? WORKSPACE : SECOND_WORKSPACE
      store.insertSession(meta(id, rig.repo, { workspaceId, status: resume ? 'stopped' : 'idle' }))
      const events = perfThread(id, { rows: count, turns: i === 0 ? 2 : 3, seed: i + 1 })
      if (resume) {
        events.splice(-3, 3, { type: 'user-text', text: 'Count the practice cones.' }, { type: 'status', status: 'running' }, { type: 'status', status: 'stopped' })
        ledger.push({ sessionId: id, recordedAt: Date.now(), lastUserSeq: count - 2, shutdownAt: null })
      }
      persistRows(db, id, events)
    }
    store.recordResumeAfterBoot(ledger)
    return { threads, rows, long, resume: ledger.length }
  } finally {
    db.close()
  }
}

function recordMethods(result: Result, samples: Map<string, Timed[]>): void {
  for (const [metric, replies] of samples) result.rows.push({ metric, ...stats(replies.map(({ ms }) => ms)) })
  result.details.methods = Object.fromEntries([...samples].map(([method, replies]) => [method, {
    ok: replies.filter(({ frame }) => frame?.ok).length,
    timeouts: replies.filter(({ frame }) => !frame).length,
    errors: replies.flatMap(({ frame }) => frame && !frame.ok ? [frame.error ?? 'request failed'] : [])
  }]))
}

async function measureConnect(rig: Rig, seed: ProbeSeed, result: Result): Promise<void> {
  const probes = connectProbes(seed)
  const samples = new Map(probes.map(({ name }) => [name, [] as Timed[]]))
  const warm = await rig.remote()
  for (const probe of probes) await warm.request(probe.method, probe.params, 1500)
  rig.close(warm)
  const filler = await openClient(`ws://127.0.0.1:${rig.box.port}`, 1500, { signal: rig.signal })
  const done = new AbortController()
  const signal = AbortSignal.any([rig.signal, done.signal])
  const workers = seed.fillerDirs.map(async (cwd) => {
    while (!signal.aborted) {
      await filler.request('git.diffStats', { cwd }, 5000)
      if (!signal.aborted) await sleep(25)
    }
  })
  try {
    // Each git call holds one child and one bulk slot. Confirm two reached
    // git before timing so a missed wrapper cannot look like a fast baseline.
    const fillerStarts = join(rig.root, 'filler-starts')
    const warmUntil = performance.now() + 4000
    while (new Set(read(fillerStarts).trim().split('\n').filter(Boolean)).size < 2) {
      if (performance.now() > warmUntil) throw new Error('Two scratch git requests did not reach the bulk queue')
      await sleep(25, undefined, { signal })
    }
    const from = performance.now()
    for (let i = 0; i < 20 && performance.now() - from < 15_000; i++) {
      let client: ProbeClient
      try {
        client = await rig.remote()
      } catch (error) {
        rig.signal.throwIfAborted()
        const errors = (result.details.connectionErrors ??= []) as string[]
        errors.push(words(error))
        continue
      }
      try {
        for (const probe of probes) {
          const remaining = 30_000 - (performance.now() - from)
          if (remaining <= 0) break
          const reply = await client.request(probe.method, probe.params, Math.min(1500, remaining))
          samples.get(probe.name)!.push(reply)
        }
      } finally {
        rig.close(client)
      }
      await sleep(250, undefined, { signal })
    }
    result.measuredMs = performance.now() - from
  } finally {
    done.abort()
    filler.close()
    await Promise.all(workers)
    recordMethods(result, samples)
    result.details.fillerRequests = seed.fillerDirs.length
    result.details.fillerGitCalls = read(join(rig.root, 'filler-starts')).split('\n').filter(Boolean).length
  }
  if ([...samples.values()].some((list) => !list.length)) throw new Error('At least one connect ask had no samples')
}

function pageSequences(reply: Timed): number[] {
  if (!reply.frame?.ok) return []
  const page = reply.frame.result as EventsPage
  return page.reset ? [] : page.rows.map(({ seq }) => seq)
}

async function measureRead(rig: Rig, result: Result): Promise<void> {
  const samples = new Map(['tail', 'resume', 'history'].map((name) => [name, [] as Timed[]]))
  const checks: { tail: boolean; resume: boolean; history: boolean }[] = []
  const peerKeys = await Promise.all([rig.mint('Bench peer one'), rig.mint('Bench peer two')])
  const done = new AbortController()
  const signal = AbortSignal.any([rig.signal, done.signal])
  const reconnects = [0, 0]
  const peerErrors: string[] = []
  const peers = peerKeys.map(async (key, i) => {
    const from = 'env_' + randomBytes(12).toString('hex')
    while (!signal.aborted) {
      try {
        const peer = await rig.remote(key, signal)
        try {
          const reply = await peer.request('peer.register', { from, offers: [] }, 1500)
          if (!reply.frame?.ok) throw new Error(reply.frame?.error ?? 'peer.register timed out')
          reconnects[i]!++
        } finally {
          rig.close(peer)
        }
      } catch (error) {
        if (!signal.aborted) peerErrors.push(words(error))
      }
      if (!signal.aborted) await sleep(180, undefined, { signal }).catch(() => {})
    }
  })

  const from = performance.now()
  const record = async (client: ProbeClient, name: string, params: object) => {
    const reply = await client.request('session.events', { sessionId: FOCUSED, ...params }, 1500)
    samples.get(name)!.push(reply)
    return pageSequences(reply)
  }
  const fixture = readFixture()
  const blocks = 40
  try {
    for (let i = 0; i < 20 && performance.now() - from < 20_000; i++) {
      const last = fixture.length
      const first = expectedTailStart(fixture, blocks)
      const historyFirst = expectedTailStart(fixture, blocks, first)
      const client = await rig.remote()
      const tail = await record(client, 'tail', { tail: blocks, subscribe: true })
      rig.close(client)
      // The two fixture rows arrive while the remote reader is disconnected.
      const callId = `read-${i}`
      const command = 'printf fixture'
      const output = 'fixture'
      await rig.rpc(rig.box, 'session.proofShellCall', { sessionId: FOCUSED, callId, command, output }, 1500)
      fixture.push({ type: 'tool-call', callId, name: 'Bash', input: { command } }, { type: 'tool-result', callId, output, isError: false })
      const resumed = await rig.remote()
      try {
        const resume = await record(resumed, 'resume', { afterSeq: tail.at(-1) ?? last, subscribe: true })
        const history = await record(resumed, 'history', { beforeSeq: tail[0] ?? first, tail: blocks })
        checks.push({
          tail: onceInOrder(tail, first, last),
          resume: onceInOrder(resume, last + 1, fixture.length),
          history: onceInOrder(history, historyFirst, first - 1)
        })
      } finally {
        rig.close(resumed)
      }
      await sleep(250, undefined, { signal })
    }
  } finally {
    result.measuredMs = performance.now() - from
    done.abort()
    await Promise.all(peers)
    recordMethods(result, samples)
    Object.assign(result.details, { checks, reconnects, peerErrors })
  }
  if (reconnects.some((count) => !count) || !checks.length || checks.some((check) => Object.values(check).includes(false)))
    throw new Error('The read scene did not confirm both peer reconnects and complete rows in order')
}

async function openBrowser(rig: Rig, sessionId: string): Promise<void> {
  const url = rig.site()
  const tool = async (call: number, name: string, args: object) => {
    const reply = await rig.rpc<{ isError?: boolean; content?: { text: string }[] }>(
      rig.box, 'app.workCall', toolCall(sessionId, rig.seed, call, name, args), 25_000
    )
    const text = reply.content?.map((item) => item.text).join('\n') ?? ''
    if (reply.isError) throw new Error(`${name}: ${text}`)
    return text
  }
  await tool(1, 'browser_open', { name: 'Host bench dummy', title: 'Host bench dummy', url })
  await tool(2, 'box_browser_open', { launch: 'Chromium', open: [url] })
  const observed = await tool(3, 'box_browser_observe', { app: 'Chromium', window: 'Host bench dummy' })
  if (!observed.includes('Practice cones')) throw new Error('The box browser carrier did not read the dummy page')
}

function sliceCauses(slices: Slice[], stalls: Stall[]) {
  return slices.map((slice) => ({
    ...slice,
    causes: stalls.filter(({ cause, at }) => cause !== 'loop' && at >= slice.at - slice.ms && at <= slice.at).map(({ cause }) => cause)
  }))
}

async function measureLoop(rig: Rig, result: Result, ms: number, action?: () => void | Promise<void>): Promise<void> {
  const from = Date.now() + 500
  const to = from + ms
  const sample = await rig.sampler(from, to)
  if (Date.now() >= from) throw new Error('The loop sampler missed the start of the scene')
  await sleep(from - Date.now(), undefined, { signal: rig.signal })
  await action?.()
  await sleep(Math.max(0, to - Date.now() + 80), undefined, { signal: rig.signal })
  const { slices, windows } = await sample()
  const stalls = rig.stalls(from, Math.max(to, ...slices.map(({ at }) => at)))
  const threshold = rig.options.scene === 'loop' ? 100 : 50
  const blocks = over(slices, threshold, from, Infinity)
  result.measuredMs = ms
  result.rows.push({ metric: 'loop window maxima', ...stats(windows.map(({ ms }) => ms)) })
  result.rows.push({ metric: `loop blocks over ${threshold} ms`, ...stats(blocks.map(({ ms }) => ms)) })
  Object.assign(result.details, { from, to, windows, blocks: sliceCauses(blocks, stalls), stalls })
}

async function measureFlush(rig: Rig, result: Result): Promise<void> {
  result.details.slowDisk = 'slow disk: not run, needs root'
  const from = Date.now()
  for (let i = 0; i < 4; i++) rig.burner(31)
  await sleep(30_000, undefined, { signal: rig.signal })
  const to = Date.now()
  const flushes = rig.stalls(from, to).filter(({ cause }) => cause.startsWith('event flush'))
  result.measuredMs = 30_000
  result.details.burners = 4
  result.details.flushes = flushes
  result.details.flushLoggingFloorMs = 50
  const loopMs = flushes.reduce((sum, { ms }) => sum + ms, 0)
  result.details.loggedFlushShare = loopMs / (to - from)
  result.rows.push({ metric: 'logged event flushes', ...stats(flushes.map(({ ms }) => ms)) })
  result.rows.push({ metric: 'logged flush time', ms: loopMs })
}

async function measureWatch(rig: Rig, result: Result): Promise<void> {
  const base = join(rig.repo, '.claude', 'worktrees')
  mkdirSync(base, { recursive: true })
  const writers: string[] = []
  for (let i = 0; i < THREADS; i++) {
    rig.signal.throwIfAborted()
    const path = join(base, `writer-${i}`)
    git(rig, 'worktree', 'add', '--quiet', '--detach', path, 'HEAD')
    writers.push(path)
  }
  const pushes = new Map<string, number>()
  const client = await rig.remote(undefined, rig.signal, ({ push, projectId }) => {
    if (push && (projectId === PROJECT || /^(file-event|git-changed)$/.test(push))) {
      pushes.set(push, (pushes.get(push) ?? 0) + 1)
    }
  })
  try {
    const watch = await client.request('fs.watch', { projectId: PROJECT, subscribe: true }, 1500)
    if (!watch.frame?.ok) throw new Error(watch.frame?.error ?? 'fs.watch did not answer')
    const { watches } = await rig.rpc<{ watches: { held: number } }>(rig.box, 'doctor.get')
    pushes.clear()
    await measureLoop(rig, result, 5000, async () => {
      await Promise.all(writers.map(async (folder) => {
        for (let i = 0; i < 25; i++) {
          rig.signal.throwIfAborted()
          await writeFile(join(folder, `change-${i}.txt`), 'Scratch change\n')
        }
      }))
    })
    result.details.fileChanges = writers.length * 25
    result.details.watches = watches
    result.details.pushes = Object.fromEntries(pushes)
    result.rows.push({ metric: 'file pushes', count: [...pushes.values()].reduce((a, b) => a + b, 0) })
    result.rows.push({ metric: 'folder watches', count: watches.held })
  } finally {
    rig.close(client)
  }
}

async function waitForStreams(rig: Rig, ids: string[]): Promise<void> {
  const { Database } = await import('bun:sqlite')
  const reader = new Database(rig.dbPath, { readonly: true })
  try {
    const query = reader.query<{ count: number }, [string]>(
      "SELECT COUNT(*) AS count FROM sessions WHERE id IN (SELECT value FROM json_each(?)) AND status = 'running'"
    )
    const list = JSON.stringify(ids)
    const end = performance.now() + 30_000
    let running = 0
    while (performance.now() < end) {
      rig.signal.throwIfAborted()
      running = query.get(list)?.count ?? 0
      if (rig.streams >= THREADS && running === ids.length) return
      await sleep(250, undefined, { signal: rig.signal })
    }
    const statuses = reader.query<{ status: string; count: number }, [string]>(
      'SELECT status, COUNT(*) AS count FROM sessions WHERE id IN (SELECT value FROM json_each(?)) GROUP BY status'
    ).all(list)
    const counts = statuses.map(({ status, count }) => `${status}=${count}`).join(', ')
    throw new Error(`Only ${running}/${ids.length} stand-ins running (${counts}) and ${rig.streams} streams reached the provider`)
  } finally {
    reader.close()
  }
}

async function measureBoot(rig: Rig, result: Result): Promise<void> {
  if (!rig.options.copy) {
    scratchRepo(rig)
    result.details.seed = await seedBoot(rig)
  }
  const hello = await rig.boot()
  result.rows.push({ metric: 'process to first hello', ms: hello })
  if (rig.options.copy) {
    result.measuredMs = hello
    result.details.mode = 'scrubbed copy, hello only'
    result.details.copyIndexRows = await rig.waitForCopyIndex()
    return
  }
  const { Database } = await import('bun:sqlite')
  const db = new Database(rig.dbPath, { readonly: true })
  const resumed = new Map<string, number>()
  try {
    const query = db.query<{ ts: number }, [string, number]>(
      "SELECT ts FROM events WHERE session_id = ? AND seq > ? AND json_extract(payload, '$.detail') LIKE 'Resumed after the host restarted at %' ORDER BY seq LIMIT 1"
    )
    const layout = bootLayout(rig.options.seedSize)
    const from = Date.now() - (performance.now() - rig.started)
    while ((resumed.size < THREADS || rig.streams < THREADS) && performance.now() - rig.started < MAX_MS) {
      rig.signal.throwIfAborted()
      for (let index = 0; index < THREADS; index++) {
        const id = BOOT_PREFIX + index
        if (resumed.has(id)) continue
        const row = query.get(id, bootRows(layout, index))
        if (row && row.ts <= from + MAX_MS) resumed.set(id, Math.max(0, row.ts - from))
      }
      if (resumed.size < THREADS || rig.streams < THREADS) await sleep(250, undefined, { signal: rig.signal })
    }
    result.details.resumed = Object.fromEntries(resumed)
    const focused = resumed.get(BOOT_PREFIX + '0') ?? null
    const all = resumed.size === THREADS ? Math.max(...resumed.values()) : null
    result.rows.push({ metric: 'process to first resumed (any)', ms: percentile([...resumed.values()], 0) })
    result.rows.push({ metric: 'process to focused resumed', ms: focused })
    result.rows.push({ metric: 'process to all resumed', count: resumed.size, ms: all })
    result.measuredMs = all ?? MAX_MS
    if (all === null || rig.streams < THREADS) throw new Error(`Only ${resumed.size}/${THREADS} threads resumed and ${rig.streams} streams reached the provider`)
  } finally {
    db.close()
  }
}

async function runScene(rig: Rig, result: Result): Promise<void> {
  if (rig.options.scene === 'boot') return measureBoot(rig, result)
  scratchRepo(rig)
  const seed = await seedScene(rig)
  await rig.boot()
  rig.remoteKey = await rig.mint('Host bench reader')
  const scope = rig.options.browser ? 'work' : 'code'
  let workspaces = [WORKSPACE, SECOND_WORKSPACE]
  if (scope === 'work') {
    await rig.rpc(rig.box, 'work.set', { enabled: true })
    workspaces = []
    for (const [index, account] of PRACTICE_ACCOUNTS.entries()) {
      const { id } = await rig.rpc<{ id: string }>(rig.box, 'workspace.create', { kind: 'work', sector: `host-bench-${index}`, name: `Host bench browser ${index}` })
      await rig.rpc(rig.box, 'workspace.setAccounts', { workspaceId: id, pins: { claude: account } })
      workspaces.push(id)
    }
  }
  console.log('Starting 40 loopback streams')
  // Two dummy accounts use independent upstream pools. Loopback speaks
  // HTTP/1, where one account's 32 sockets cannot stream all 40 at once.
  const group = { scope, signal: rig.signal } as const
  const half = THREADS / 2
  // The fixture can warm another harness before the stand-ins start.
  const first = await startLoad(rig, workspaces[0]!, half, { ...group, room: half + ADMISSION_ROOM })
  const second = await startLoad(rig, workspaces[1]!, half, group)
  const ids = [...first, ...second]
  await waitForStreams(rig, ids)
  if (rig.options.browser) await openBrowser(rig, ids[0]!)
  console.log(`Measuring ${rig.options.scene} with 40 running threads`)
  switch (rig.options.scene) {
    case 'connect': return measureConnect(rig, seed, result)
    case 'loop': return measureLoop(rig, result, MAX_MS)
    case 'read': return measureRead(rig, result)
    case 'flush': return measureFlush(rig, result)
    case 'settle': {
      await measureLoop(rig, result, 10_000, () => rig.finishStreams.abort())
      const { Database } = await import('bun:sqlite')
      const db = new Database(rig.dbPath, { readonly: true })
      try {
        const rows = db.query<{ status: string; count: number }, [string]>(
          "SELECT status, COUNT(*) AS count FROM sessions WHERE id IN (SELECT value FROM json_each(?)) GROUP BY status"
        ).all(JSON.stringify(ids))
        result.details.endingStatuses = rows
        result.rows.push({ metric: 'settled by end of window', count: rows.find(({ status }) => status === 'idle')?.count ?? 0 })
      } finally {
        db.close()
      }
      return
    }
    case 'watch': return measureWatch(rig, result)
  }
}

async function confirmedCopy(path: string): Promise<string> {
  const data = realpathSync(path)
  // Reject prod and any ancestor or child of it before calling the marker check.
  for (const prod of ['/srv/agents/docket-data', '/srv/agents/temp-code-data']) {
    const real = existsSync(prod) ? realpathSync(prod) : prod
    if (data === real || data.startsWith(real + '/') || real.startsWith(data + '/')) throw new Error('not scrubbed')
  }
  for (const file of readdirSync(data)) {
    if (/\.db(?:-|$)/.test(file) && lstatSync(join(data, file)).isSymbolicLink()) {
      if (!realpathSync(join(data, file)).startsWith(data + '/')) throw new Error('not scrubbed')
    }
  }
  await requireScrubbed(data)
  const { Database } = await import('bun:sqlite')
  for (const name of ['docket.db', 'temp-code.db']) {
    const file = join(data, name)
    if (!existsSync(file)) continue
    const db = new Database(file, { readonly: true })
    try {
      const ledger = db.query("SELECT 1 FROM sqlite_master WHERE name = 'resume_after_boot' AND type = 'table'").get()
      if (ledger && db.query('SELECT 1 FROM resume_after_boot LIMIT 1').get()) throw new Error('The scrubbed copy still has threads marked to resume')
    } finally {
      db.close()
    }
  }
  return data
}

async function main(args: string[]): Promise<void> {
  if (args.length === 1 && args[0] === '--list') {
    console.table(Object.entries(HOST_SCENES).map(([scene, budget]) => ({ scene, budget })))
    return
  }
  const options = hostFlags(args)
  const at = new Date().toISOString()
  const runs = join(mainCheckout(REPO), '.temp-code', 'plans', 'perf2', 'runs')
  mkdirSync(runs, { recursive: true })
  const path = join(runs, `host-${options.scene}-${at.replace(/[:.]/g, '-')}-${process.pid}.json`)
  const result: Result = { scene: options.scene, budget: HOST_SCENES[options.scene], at, rows: [], details: { browser: options.browser } }
  let rig: Rig | undefined
  let guard: ReturnType<typeof guardLiveBox> | undefined
  let checks: ReturnType<typeof setInterval> | undefined
  const abort = new AbortController()
  const onInt = () => abort.abort(new Error('SIGINT'))
  const onTerm = () => abort.abort(new Error('SIGTERM'))
  process.on('SIGINT', onInt)
  process.on('SIGTERM', onTerm)
  try {
    result.load1 = loadOne()
    result.peakLoad1 = result.load1
    result.anonGiB = agentsAnonGiB()
    if (!Number.isFinite(result.load1) || result.load1 > options.maxLoad)
      throw new Error(`Host load ${result.load1} exceeds the limit of ${options.maxLoad}`)
    if (result.anonGiB !== null && result.anonGiB >= MAX_ANON_GIB)
      throw new Error(`Agents slice anonymous memory is at least ${MAX_ANON_GIB} GiB`)
    const cpus = /^Cpus_allowed_list:\s*(.+)$/m.exec(read('/proc/self/status'))?.[1]
    if (!cpus) throw new Error('No Linux CPU affinity found')
    result.cores = lastAllowedCores(cpus)
    const pid = String(process.pid)
    execFileSync('taskset', ['-apc', result.cores, pid], { stdio: 'ignore' })
    execFileSync('ionice', ['-c', '3', '-p', pid], { stdio: 'ignore' })
    execFileSync('renice', ['-n', '19', '-p', pid], { stdio: 'ignore' })
    const copy = options.copy ? await confirmedCopy(options.copy) : undefined
    const chromium = options.browser
      ? (await import('../../src/main/server/work/browser/box/chromium')).findChromium()
      : undefined
    if (options.browser && !chromium) throw new Error('No Chromium for the isolated box browser')
    const port = copy ? 0 : await freePort()
    abort.signal.throwIfAborted()
    rig = new Rig(options, abort, copy, port, chromium ?? undefined)
    guard = guardLiveBox(rig.abort)
    const checked = rig
    checks = setInterval(() => {
      const load = loadOne()
      result.peakLoad1 = Math.max(result.peakLoad1 ?? 0, load)
      const anon = agentsAnonGiB()
      if (anon !== null && anon >= MAX_ANON_GIB) checked.abort.abort(new Error(`Agents slice anonymous memory reached ${MAX_ANON_GIB} GiB`))
      const pressure = Number(/^some avg10=([\d.]+)/m.exec(read('/proc/pressure/io'))?.[1] ?? 0)
      if (pressure > 30) checked.abort.abort(new Error(`Live I/O pressure crossed 30 (${pressure})`))
    }, 1000)
    await runScene(rig, result)
    rig.signal.throwIfAborted()
  } catch (error) {
    result.error = words(abort.signal.aborted ? abort.signal.reason : error)
  } finally {
    clearInterval(checks)
    result.load1End = loadOne()
    result.peakLoad1 = Math.max(result.peakLoad1 ?? 0, result.load1End)
    result.anonGiBEnd = agentsAnonGiB()
    result.liveHelloMs = guard?.stop()
    if (rig) {
      result.streams = rig.streams
      try {
        result.remainingPids = await rig.stop()
        if (result.remainingPids.length) throw new Error('Owned processes remain')
        if (result.error && !options.copy) {
          const log = read(join(rig.root, 'box.log'))
          if (log) result.details.boxLogTail = log.slice(-5000)
        }
        rmSync(rig.root, { force: true, recursive: true })
      } catch (error) {
        result.error = [result.error, words(error)].filter(Boolean).join('. ')
      }
    }
    process.off('SIGINT', onInt)
    process.off('SIGTERM', onTerm)
    writeFileSync(path, JSON.stringify(result, null, 2) + '\n')
    const host = { load1: result.load1, load1End: result.load1End, peakLoad1: result.peakLoad1, anonGiB: result.anonGiB, anonGiBEnd: result.anonGiBEnd }
    const rows = result.rows.length ? result.rows : [{ metric: options.scene }]
    console.table(rows.map((row) => Object.fromEntries(Object.entries({ ...row, ...host }).map(([key, value]) => [
      key, typeof value === 'number' ? Math.round(value * 100) / 100 : value
    ]))))
    console.log(path)
  }
  if (result.error) throw new Error(result.error)
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(words(error))
    process.exitCode = 1
  })
}
