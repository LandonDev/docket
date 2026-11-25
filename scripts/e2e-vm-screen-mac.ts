#!/usr/bin/env bun
/**
 * M8's box side (the VM screen plan, "The real path, from his Mac"): ONE isolated headless instance of the BUILT
 * tree, Work on, its keeper's own Set up of a fresh standing disk on a THROWAWAY scratch machine (virtio by itself,
 * the hardware cursor on), and one pairing code a Mac redeems over `ssh -L`. It holds until DONE_FILE appears or
 * the run's 30 minutes end, then puts everything down and deletes the disk, the TPM folder and the userData.
 *
 * The live app comes first. The machine is a throwaway (`WINVM_THROWAWAY=1`, granted by the host only on a scratch
 * root under /dev/shm: `throwawayHost`): its disk is an overlay in memory with cache=unsafe, QEMU in the idle I/O
 * class at nice 19. Every 5 s the watch times `tc-local admission.get '{}'` and reads /proc/pressure/io, and pulls
 * everything down past 800 ms twice running, io pressure 30, or 30 minutes (`watchTick`; exit 3).
 *
 * Ahead, once (each through the heavy queue): `electron-vite build`; the VM's service in resources/native; the
 * display driver into the run's own tools (or the box's has it):
 *
 *   bun scripts/build-tc-computer-win.ts --into resources/native
 *   bun scripts/work-tools/install.ts --data /tmp/vm-screen-mac-tools --only virtio-win
 *
 * The run (one VM at a time; `anon` of agents.slice under 38 GiB):
 *
 *   WINVM_DIR=/dev/shm/vm-screen-mac WINVM_TPM_DIR=/tmp/vm-screen-mac-tpm WINVM_SSH_PORT=22251 \
 *     env -u ELECTRON_RUN_AS_NODE bun scripts/e2e-vm-screen-mac.ts
 *
 * Its one line beginning `{` is the Mac's: `ssh` (the tunnel), `link` (Settings → Hosts → Add a host, or
 * `remote.environments.pair`), and `done` (the end, from the Mac).
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join, resolve } from 'node:path'
import type { WinvmState } from '../src/shared/contract-work-winvm'
import { requireScratchMachine, throwawayHost } from '../src/main/server/work/winvm/machine/config'
import { readMachineDevice } from '../src/main/server/work/winvm/guestScreen'
import { SshGuest } from '../src/main/server/work/winvm/sshGuest'
import { StandingMachine } from '../src/main/server/work/winvm/standing'
import { liveAppTrouble, WATCH_MS, watchTick, type LiveReading } from './perf/vmScreenRows'
import { liveAppReading } from './lib/liveApp'
import { ANON_MAX_BYTES, anonBytes, DONE_FILE, holdEnd, instanceEnv, mergeToolStates, otherScratchVms, PAIR_CAPS, pairLine, pairMinutes } from './lib/vmScreenMac'

// Before anything else: with WINVM_DIR, WINVM_TPM_DIR or WINVM_SSH_PORT unset the standing machine is the owner's.
requireScratchMachine()
const refused = throwawayHost({ ...process.env, WINVM_THROWAWAY: '1' }).refused
if (refused) {
  console.error(`refused: ${refused}`)
  process.exit(2)
}

const REPO = resolve(import.meta.dir, '..')
const SHARED = '/srv/agents/win-vm'
const BOX_TOOLS = process.env.E2E_WORK_TOOLS ?? '/srv/agents/temp-code-data/work-tools'
const TOOLS_CACHE = process.env.VM_SCREEN_TOOLS ?? '/tmp/vm-screen-mac-tools'
const DRIVER = 'virtio-win'
const ROOT_MS = 30 * 60_000
const t0 = Date.now()
const deadline = t0 + ROOT_MS
const log = (m: string): void => console.log(`[m8 ${String(Math.round((Date.now() - t0) / 1000)).padStart(4)}s] ${m}`)
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

const freePort = (): Promise<number> =>
  new Promise((ok) => {
    const srv = createServer()
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as { port: number }
      srv.close(() => ok(port))
    })
  })

async function until(ms: number, test: () => Promise<boolean> | boolean, every = 1000): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end && !ending) {
    if (await Promise.resolve(test()).catch(() => false)) return true
    await sleep(every)
  }
  return false
}

const readJson = <T>(path: string): T | null => (existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as T) : null)

// ---------------------------------------------------------------- the isolated instance

class Instance {
  readonly root = realpathSync(mkdtempSync('/tmp/vm-screen-mac-'))
  readonly data = join(this.root, 'data')
  readonly home = join(this.root, 'home')
  readonly logFile = join(this.root, 'instance.log')
  port = 0
  remotePort = 0
  private proc: ChildProcess | null = null

  async start(exe: string | null): Promise<void> {
    this.remotePort = await freePort()
    for (const d of [this.data, this.home, join(this.home, 'work'), join(this.root, 'tmp')]) mkdirSync(d, { recursive: true })
    this.linkTools()
    const env = instanceEnv(process.env, { root: this.root, data: this.data, home: this.home, remotePort: this.remotePort, exe, uid: process.getuid?.() ?? 0 })
    const electron = join(REPO, 'node_modules', '.bin', 'electron')
    const argv = ['xvfb-run', '-a', '-s', '-screen 0 1280x800x24 -nolisten tcp', 'dbus-run-session', '--', electron, '.']
    this.proc = spawn(argv[0]!, argv.slice(1), { cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
    this.proc.stdout?.on('data', (c: Buffer) => appendFileSync(this.logFile, c))
    this.proc.stderr?.on('data', (c: Buffer) => appendFileSync(this.logFile, c))
    if (!(await until(180_000, () => existsSync(join(this.data, 'server.json')), 500))) throw new Error(`the instance did not start: ${this.tail()}`)
    this.port = readJson<{ port: number }>(join(this.data, 'server.json'))!.port
    if (!(await until(60_000, () => this.call('work.get').then(() => true)))) throw new Error('the instance does not answer')
    log(`instance up: local ${this.port}, listener 127.0.0.1:${this.remotePort}, root ${this.root}`)
  }

  tail(n = 3000): string {
    return existsSync(this.logFile) ? readFileSync(this.logFile, 'utf8').slice(-n) : ''
  }

  /** The box's tools linked in (never copied), the driver from the run's own cache; state.json is the instance's own. */
  private linkTools(): void {
    const mine = join(this.data, 'work-tools')
    mkdirSync(mine, { recursive: true })
    const cache = join(TOOLS_CACHE, 'work-tools')
    const cached = readJson<Parameters<typeof mergeToolStates>[0]>(join(cache, 'state.json'))
    for (const [from, names] of [[cache, cached && Object.values(cached.tools).filter((t) => t.ok && t.dir).map((t) => t.dir!.split('/')[0]!)], [BOX_TOOLS, null]] as const) {
      if (!existsSync(from)) continue
      for (const name of readdirSync(from)) {
        if (names && !names.includes(name)) continue
        if (['jobs', 'run', 'downloads', 'state.json'].includes(name) || existsSync(join(mine, name))) continue
        symlinkSync(join(from, name), join(mine, name))
      }
    }
    for (const name of ['jobs', 'run', 'downloads']) mkdirSync(join(mine, name), { recursive: true })
    writeFileSync(join(mine, 'state.json'), JSON.stringify(mergeToolStates(readJson(join(BOX_TOOLS, 'state.json')) ?? { tools: {} }, cached), null, 2))
  }

  /** One request on the instance's local socket (the implicit admin). */
  call<T>(method: string, params: unknown = {}, timeoutMs = 120_000): Promise<T> {
    const ws = new WebSocket(`ws://127.0.0.1:${this.port}/`)
    const id = `m8-${Math.random().toString(36).slice(2)}`
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

  /** Every process of this instance, by its userData in the environ or its root in the command line. */
  pids(): number[] {
    const marker = `TEMP_CODE_USER_DATA=${this.data}`
    return procs().flatMap((p) => {
      if (p.pid === process.pid) return []
      try {
        return readFileSync(`/proc/${p.pid}/environ`, 'utf8').split('\0').includes(marker) || p.cmdline.includes(this.root) ? [p.pid] : []
      } catch {
        return []
      }
    })
  }

  kill(): void {
    for (let i = 0; i < 3; i++) {
      for (const pid of this.pids()) signal(pid)
      if (this.proc?.pid) signal(-this.proc.pid)
    }
  }
}

function signal(pid: number): void {
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    /* gone */
  }
}

function procs(): { pid: number; comm: string; cmdline: string }[] {
  return readdirSync('/proc')
    .filter((p) => /^\d+$/.test(p))
    .flatMap((p) => {
      try {
        return [{ pid: Number(p), comm: readFileSync(`/proc/${p}/comm`, 'utf8').trim(), cmdline: readFileSync(`/proc/${p}/cmdline`, 'utf8').replace(/\0/g, ' ') }]
      } catch {
        return []
      }
    })
}

// ---------------------------------------------------------------- the rules before a machine starts

const root = process.env.WINVM_DIR!
const machine = new StandingMachine('standing', process.env, null, log, { throwaway: true })
const inst = new Instance()
let ending = false
let watchWhy: string | null = null
/** set once the checks pass: teardown never touches a disk, TPM folder or root it did not make */
let mine = false

function preflight(): string | null {
  if (!existsSync(join(REPO, 'out', 'main', 'index.js'))) return 'no build: run electron-vite build first (through heavy)'
  if (machine.running() || machine.hasDisk()) return `${machine.c.dir} has a disk or a running machine: another run's`
  const others = otherScratchVms(procs())
  if (others.length) return `another scratch machine runs (QEMU ${others.join(', ')}): one at a time`
  const anon = existsSync('/sys/fs/cgroup/agents.slice/memory.stat') ? anonBytes(readFileSync('/sys/fs/cgroup/agents.slice/memory.stat', 'utf8')) : null
  if (anon !== null && anon >= ANON_MAX_BYTES) return `agents.slice holds ${(anon / 1024 ** 3).toFixed(1)} GiB anonymous memory (38 at most)`
  const driverIn = (dir: string) => readJson<{ tools: Record<string, { ok?: boolean }> }>(join(dir, 'state.json'))?.tools[DRIVER]?.ok === true
  if (!driverIn(BOX_TOOLS) && !driverIn(join(TOOLS_CACHE, 'work-tools'))) return `no ${DRIVER}: bun scripts/work-tools/install.ts --data ${TOOLS_CACHE} --only ${DRIVER} (through heavy)`
  const first = liveAppReading()
  return liveAppTrouble([first, first])
}

function serviceExe(): string | null | undefined {
  if (process.env.TEMP_CODE_WINVM_EXE) return existsSync(process.env.TEMP_CODE_WINVM_EXE) ? resolve(process.env.TEMP_CODE_WINVM_EXE) : undefined
  // the instance finds it as the deployed box does (serviceBin.ts)
  return existsSync(join(REPO, 'resources', 'native', 'tc-computer.exe')) ? null : undefined
}

const HWCURSOR_READ = `
$dev = Get-PnpDevice -Class Display -PresentOnly | Where-Object FriendlyName -like '*VirtIO*' | Select-Object -First 1
if (-not $dev) { 'none' } else {
  $key = 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\' + (Get-PnpDeviceProperty -InstanceId $dev.InstanceId -KeyName DEVPKEY_Device_Driver).Data
  'HWCursor=' + (Get-ItemProperty -LiteralPath $key -Name HWCursor -ErrorAction SilentlyContinue).HWCursor
}`

// ---------------------------------------------------------------- the run

async function main(): Promise<string> {
  const why = preflight()
  if (why) throw new Error(`not starting: ${why}`)
  const exe = serviceExe()
  if (exe === undefined) throw new Error('no tc-computer.exe: bun scripts/build-tc-computer-win.ts --into resources/native (through heavy), or TEMP_CODE_WINVM_EXE')
  mine = true
  rmSync(DONE_FILE, { force: true })
  mkdirSync(join(DONE_FILE, '..'), { recursive: true })
  mkdirSync(root, { recursive: true })
  for (const name of ['base', 'keys']) if (!existsSync(join(root, name))) symlinkSync(join(SHARED, name), join(root, name))

  // the watch, from here to the end: the live app and the disk first, and 30 minutes at most
  const kept: LiveReading[] = []
  let told = 0
  const watch = setInterval(() => {
    if (ending || watchWhy) return
    const now = liveAppReading()
    if (Date.now() - told >= 60_000) {
      told = Date.now()
      log(`live app ${now.appMs === null ? 'silent' : `${Math.round(now.appMs)} ms`}, io ${now.ioSome}%`)
    }
    watchWhy = watchTick(kept, now, Date.now() - t0)
    if (!watchWhy) return
    log(`STOPPING: ${watchWhy}`)
    void teardown().finally(() => process.exit(3))
  }, WATCH_MS)
  try {
    await inst.start(exe)
    await inst.call('work.set', { enabled: true })

    // the keeper's own Set up on a fresh disk: a new disk comes up on virtio with the hardware cursor on
    const setupAt = Date.now()
    log(`setup asked: ${(await inst.call<WinvmState>('work.winvm.setup', {})).state}`)
    let state = {} as WinvmState
    let last = ''
    await until(
      deadline - Date.now(),
      async () => {
        state = await inst.call<WinvmState>('work.winvm.state', {})
        const line = `${state.state}${state.step ? ` (${state.step})` : ''}${state.error ? ` error: ${state.error}` : ''}`
        if (line !== last) log(`keeper: ${line}`)
        last = line
        return state.state === 'awake' || (state.state !== 'setting-up' && !!state.error)
      },
      3000
    )
    if (state.state !== 'awake' || state.error) throw new Error(`setup did not end awake: ${last}`)
    const setupSeconds = Math.round((Date.now() - setupAt) / 1000)
    const guest = new SshGuest(machine.c, machine.p)
    const cursor = (await guest.admin(HWCURSOR_READ).catch((e: Error) => e.message)).trim()
    const vm = { device: readMachineDevice(machine.p.run), display: state.display ?? null, hwCursor: cursor === 'HWCursor=1', setupSeconds }
    log(`awake in ${setupSeconds} s: ${JSON.stringify(vm)}`)
    if (vm.device !== 'virtio' || !vm.hwCursor) log(`NOTE: a new disk should be on virtio with HWCursor=1 (${cursor})`)

    // one pairing code for a desktop client key, the product's own method; the key is named by the Mac's redeem
    const made = await inst.call<{ code: string; pairing: { expiresAt: number } }>('remote.pairings.create', { name: 'M8 Mac', audience: 'client', caps: [...PAIR_CAPS], ttlMinutes: pairMinutes(Date.now(), deadline) })
    console.log(pairLine({ port: inst.remotePort, code: made.code, codeExpires: made.pairing.expiresAt, holdsUntil: deadline, vm }))

    let end: string | null = null
    while (!(end = holdEnd({ done: existsSync(DONE_FILE), now: Date.now(), deadline }))) await sleep(1000)
    return end
  } finally {
    clearInterval(watch)
  }
}

/** Everything down, once: the instance, the machine (its plug: the disk is deleted), the TPM, the disk, the userData. */
async function teardown(): Promise<void> {
  if (ending) return
  ending = true
  log('putting everything down')
  inst.kill()
  if (mine) {
    await machine.forceStop().catch((e: Error) => log(`machine stop: ${e.message}`))
    const pidFile = join(machine.p.run, 'watcher.pid')
    const watcher = existsSync(pidFile) ? Number(readFileSync(pidFile, 'utf8').trim()) : 0
    if (watcher && procs().some((p) => p.pid === watcher && p.cmdline.includes(machine.p.run))) signal(watcher)
    await sleep(1000)
    inst.kill()
    rmSync(machine.c.dir, { recursive: true, force: true })
    rmSync(machine.c.tpmDir, { recursive: true, force: true })
    // the links first: a recursive remove never follows them into the owner's base and keys
    for (const name of ['base', 'keys']) rmSync(join(root, name), { force: true })
    rmSync(root, { recursive: true, force: true })
    rmSync(DONE_FILE, { force: true })
  }
  if (process.env.E2E_KEEP === '1') log(`kept the instance's root ${inst.root}`)
  else rmSync(inst.root, { recursive: true, force: true })
  const left = inst.pids()
  log(left.length || machine.running() ? `LEFT RUNNING: ${machine.running() ? 'QEMU ' : ''}${left.join(' ')}` : `down; ${machine.c.dir} and ${machine.c.tpmDir} deleted`)
}

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const)
  process.on(sig, () => {
    log(`${sig}`)
    void teardown().finally(() => process.exit(4))
  })

let code = 0
try {
  const end = await main()
  log(`ended: ${end}`)
} catch (e) {
  code = 1
  log(`FAILED: ${e instanceof Error ? e.message : String(e)}`)
  if (inst.port) log(inst.tail())
}
await teardown()
process.exit(code)
