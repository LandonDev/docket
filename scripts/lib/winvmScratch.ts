/**
 * A scratch Windows VM for a bench or a proof: the standing machine's own code (StandingMachine with its
 * VmScreen, the picture's source and a relay) on a root, a TPM folder and a port that are not the owner's.
 * `scratchMachineRefusal` stands in front: with WINVM_DIR, WINVM_TPM_DIR or WINVM_SSH_PORT unset, the machine
 * would be his. The live app comes first: the disk is an overlay kept in memory (/dev/shm) and attached with
 * `cache=unsafe`, QEMU runs in the idle I/O class, and a watch pulls the machine down the moment the app slows.
 */
import { dlopen, FFIType, ptr } from 'bun:ffi'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LOCAL_PRINCIPAL } from '../../src/shared/capabilities'
import type { WinvmState } from '../../src/shared/contract-work-winvm'
import { encodeAck, messageType, MESSAGE_TYPES, parseFrame } from '../../src/shared/video/nsl1'
import type { StreamClaim } from '../../src/main/server/remote/auth'
import { VideoRelay, type ViewerSocket } from '../../src/main/server/video/relay'
import { VideoRpc } from '../../src/main/server/video/rpc'
import { EngineFeed } from '../../src/main/server/work/browser/box/engineFeed'
import { writeMachineDevice } from '../../src/main/server/work/winvm/guestScreen'
import { requireScratchMachine } from '../../src/main/server/work/winvm/machine/config'
import { psQuote } from '../../src/main/server/work/winvm/machine/guest'
import type { DisplayDevice } from '../../src/main/server/work/winvm/machine/qemu'
import { Qmp } from '../../src/main/server/work/winvm/machine/qmp'
import { VM_COMPUTER, VmPicture } from '../../src/main/server/work/winvm/picture'
import { FULL_SHUTDOWN, SshGuest } from '../../src/main/server/work/winvm/sshGuest'
import { StandingMachine } from '../../src/main/server/work/winvm/standing'
import { pictureToolsAt, vmEngineTune, VmScreen } from '../../src/main/server/work/winvm/window'
import type { EngineTune } from '../../src/main/server/work/browser/box/engine'
import type { VmWindow } from '../../src/main/server/work/winvm/machine/qemu'
import { liveAppTrouble, WATCH_MS, watchTick, type LiveReading, type SeenFrame } from '../perf/vmScreenRows'
import { liveAppReading } from './liveApp'

/** The owner's machines' folder: the base image and the keys are read from it, never written. */
const SHARED = '/srv/agents/win-vm'

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const libc = dlopen('libc.so.6', { clock_gettime: { args: [FFIType.i32, FFIType.ptr], returns: FFIType.i32 } })
const monotonicUs = (): number => {
  const spec = new BigInt64Array(2)
  libc.symbols.clock_gettime(1, ptr(spec))
  return Number(spec[0]! * 1_000_000n + spec[1]! / 1000n)
}
const ownUs = (): number => Number(process.hrtime.bigint() / 1000n)
const clockOffsetUs = Math.min(...Array.from({ length: 16 }, () => monotonicUs() - ownUs()))
/** Now on the engine's clock (CLOCK_MONOTONIC), in microseconds: a frame's own timestamp is on it. */
export const nowUs = (): number => ownUs() + clockOffsetUs

/** What the engine sent that was not a frame, by NSL1 type and when: the relay drops these today. */
export const otherRecords: { type: number; us: number; bytes: number }[] = []
const start = EngineFeed.prototype.start
EngineFeed.prototype.start = function (sink) {
  start.call(this, {
    frame: (bytes) => {
      const type = messageType(bytes)
      if (type !== MESSAGE_TYPES.frame) otherRecords.push({ type, us: nowUs(), bytes: bytes.byteLength })
      sink.frame(bytes)
    },
    end: (reason) => sink.end(reason)
  })
}

/**
 * A viewer that draws at once: every frame recorded and acked. `linkMs` stands for a link: a frame is seen that much
 * after the relay sends it, and its ack reaches the engine that much after it is seen.
 */
export class BenchViewer implements ViewerSocket {
  bufferedAmount = 0
  frames: (SeenFrame & { key: boolean; w: number; h: number })[] = []
  private say: ((data: Buffer, isBinary: boolean) => void) | null = null
  constructor(private readonly linkMs = 0) {}
  send(bytes: Uint8Array): void {
    const f = parseFrame(bytes)
    const seen = (): void => {
      this.frames.push({ us: nowUs(), ts: f.timestamp, bytes: bytes.byteLength, key: f.keyframe, w: f.width, h: f.height })
      const ack = (): void => this.say?.(Buffer.from(encodeAck(f.generation, f.sequence, 0)), true)
      if (this.linkMs) setTimeout(ack, this.linkMs)
      else ack()
    }
    if (this.linkMs) setTimeout(seen, this.linkMs)
    else seen()
  }
  close(): void {}
  on(event: 'message' | 'close', fn: never): void {
    if (event === 'message') this.say = fn
  }
}

export { liveAppReading }

export interface Scratch {
  machine: StandingMachine
  guest: SshGuest
  screen: VmScreen
  /** the size the next start's display takes */
  setSize(size: [number, number]): void
  /** QEMU arguments of the run's own for the next start (a trace) */
  setExtra(args: string[]): void
  /** the engines' flags from the next stream on (null: the VM's own); every engine running is stopped */
  setTune(tune: ((size: VmWindow) => EngineTune) | null): Promise<void>
  /** Opens one stream of the VM, its engine pinned to `cores`; `end` closes it. */
  view(cores: string): Promise<{ viewer: BenchViewer; engines: number[]; end(): Promise<void> }>
  /** One QMP call on a connection of its own. */
  qmp<T = unknown>(execute: string, args?: Record<string, unknown>): Promise<T>
  /** Everything down and the scratch disk deleted. */
  remove(): Promise<void>
}

/**
 * The machine on its scratch root (made here: `base` and `keys` linked in from the shared folder). It refuses a
 * root that already holds a disk: another run's.
 */
export function scratchMachine(o: { data: string; size: [number, number]; log: (line: string) => void; linkMs?: number }): Scratch {
  requireScratchMachine()
  const root = process.env.WINVM_DIR!
  if (!root.startsWith('/dev/shm/')) throw new Error(`WINVM_DIR ${root}: a scratch machine's disk lives in memory, under /dev/shm, never on the box's one disk`)
  const first = liveAppReading()
  const trouble = liveAppTrouble([first, first])
  if (trouble) throw new Error(`not starting a machine: ${trouble}`)
  mkdirSync(root, { recursive: true })
  for (const name of ['base', 'keys']) if (!existsSync(join(root, name))) symlinkSync(join(SHARED, name), join(root, name))
  const tools = pictureToolsAt(o.data)
  if (tools.missing !== null) throw new Error(`${tools.missing} is not installed under ${o.data}`)
  const own = mkdtempSync(join(tmpdir(), 'tc-winvm-scratch-'))
  symlinkSync(join(o.data, 'work-tools'), join(own, 'work-tools'))
  let size = o.size
  let tune: ((size: VmWindow) => EngineTune) | undefined
  const screen = new VmScreen({ root: join(own, 'winvm', 'picture'), tools: () => pictureToolsAt(own), size: () => ({ width: size[0], height: size[1] }), log: o.log, tune: (size) => (tune ?? vmEngineTune)(size) })
  let extra: string[] = []
  const machine = new StandingMachine('standing', process.env, screen, o.log, { throwaway: true, extra: () => extra })
  if (machine.cannot()) throw new Error(machine.cannot()!)
  if (machine.hasDisk() || machine.running()) throw new Error(`${machine.c.dir} has a disk already: another run's`)
  const guest = new SshGuest(machine.c, machine.p)
  const relay = new VideoRelay()
  const minted: StreamClaim[] = []
  const rpc = new VideoRpc(relay, { mintStreamTicket: (c) => (minted.push(c), { ticket: 't', expiresIn: 30 }) }, () => true)
  const state: WinvmState = { state: 'awake', step: null, error: null, cannot: null, sleepAfter: '30m', since: Date.now() }
  const picture = new VmPicture({ state: () => state, onState: () => () => {}, setViewers: () => {}, screen, relay, screenshot: async () => Buffer.alloc(0), jpeg: async () => ({ data: '', width: 1, height: 1 }) })
  rpc.addSource(picture)
  const remove = async (): Promise<void> => {
    clearInterval(watch)
    await machine.forceStop().catch(() => {})
    await screen.down()
    picture.close()
    rmSync(machine.c.dir, { recursive: true, force: true })
    rmSync(own, { recursive: true, force: true })
    o.log(`removed the scratch disk (${machine.c.dir})`)
  }
  let stopping = false
  const readings: LiveReading[] = []
  const started = Date.now()
  let told = 0
  const stop = (why: string): void => {
    stopping = true
    o.log(`STOPPING: ${why}`)
    void remove().finally(() => process.exit(3))
  }
  const watch = setInterval(() => {
    if (stopping) return
    const now = liveAppReading()
    if (Date.now() - told >= 60_000) {
      told = Date.now()
      o.log(`live app ${now.appMs === null ? 'silent' : `${Math.round(now.appMs)} ms`}, io ${now.ioSome}%`)
    }
    // the master's rules: the live app first, and no scratch machine past 30 minutes
    const why = watchTick(readings, now, Date.now() - started)
    if (why) stop(why)
  }, WATCH_MS)
  return {
    machine,
    guest,
    screen,
    setSize: (s) => (size = s),
    setExtra: (args) => (extra = args),
    async setTune(next) {
      tune = next ?? undefined
      // warm engines keep the flags they started with
      await screen.engines.stopAll()
    },
    async view(cores) {
      const answer = await rpc.open({ threadId: 'bench', computer: VM_COMPUTER, maxEdge: 3840 }, { principal: LOCAL_PRINCIPAL, connection: {}, connectionId: '1' })
      if (!answer.ok) throw new Error(`video.open refused: ${answer.reason}`)
      const viewer = new BenchViewer(o.linkMs)
      if (!relay.attach(minted.at(-1)!, viewer)) throw new Error('the viewer did not join')
      await sleep(300)
      const engines = pinEngines(cores)
      return {
        viewer,
        engines,
        end: async () => {
          relay.endWhere((s) => s.tag === VM_COMPUTER, 'ended')
          await sleep(300)
        }
      }
    },
    async qmp<T>(execute: string, args?: Record<string, unknown>): Promise<T> {
      const q = await Qmp.open(machine.p.qmp)
      try {
        return (await q.run({ execute, ...(args ? { arguments: args } : {}) })) as T
      } finally {
        q.destroy()
      }
    },
    remove
  }
}

/** relay-engine processes this process started, pinned to `cores`. */
function pinEngines(cores: string): number[] {
  const pids: number[] = []
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue
    try {
      const stat = readFileSync(`/proc/${name}/stat`, 'utf8')
      const comm = /\((.*)\)/.exec(stat)?.[1]
      const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1])
      if (comm === 'relay-engine' && ppid === process.pid) pids.push(Number(name))
    } catch {
      // gone
    }
  }
  for (const pid of pids) Bun.spawnSync(['taskset', '-a', '-p', '-c', cores, String(pid)], { stdout: 'ignore', stderr: 'ignore' })
  return pids
}

/** utime + stime of a process, in clock ticks; 0 once it has gone. */
export function cpuTicks(pid: number): number {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const f = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    return Number(f[11]) + Number(f[12])
  } catch {
    return 0
  }
}

/** The guest's folder the display driver is staged from, and where `viogpures.exe` stays. */
export const GUEST_DRIVER_DIR = 'C:\\ProgramData\\tc-viogpu'
/** The driver's own size tool, where tcuser may run it: a file moved into ProgramData keeps the admin profile's rights. */
export const GUEST_SIZE_TOOL = 'C:\\Program Files\\tc-viogpu\\viogpures.exe'
const DRIVER_FILES = ['viogpudo.inf', 'viogpudo.cat', 'viogpudo.sys', 'viogpures.exe']

/**
 * Moves a machine that runs on std VGA to virtio-vga, as the keeper's Turn on will: the driver folder copied in
 * and staged (`pnputil /add-driver`: the device is not there yet), a clean shutdown (never a hibernate: a
 * resume on changed hardware is the one thing that may not happen), the TPM kept, `machine.json` written, and
 * only then a start on the new device. Answers pnputil's words.
 */
export async function moveToVirtio(s: Scratch, driverDir: string, log: (line: string) => void): Promise<string> {
  for (const f of DRIVER_FILES) await s.guest.upload(join(driverDir, f), f)
  const staged = await s.guest.admin(
    [
      `New-Item -ItemType Directory -Force ${psQuote(GUEST_DRIVER_DIR)} | Out-Null`,
      ...DRIVER_FILES.map((f) => `Move-Item -Force (Join-Path $env:USERPROFILE ${psQuote(f)}) ${psQuote(GUEST_DRIVER_DIR)}`),
      `New-Item -ItemType Directory -Force ${psQuote(GUEST_SIZE_TOOL.replace(/\\[^\\]+$/, ''))} | Out-Null`,
      `Copy-Item -Force ${psQuote(`${GUEST_DRIVER_DIR}\\viogpures.exe`)} ${psQuote(GUEST_SIZE_TOOL)}`,
      `pnputil /add-driver ${psQuote(`${GUEST_DRIVER_DIR}\\viogpudo.inf`)}`
    ].join('\n')
  )
  log(`pnputil: ${staged.trim().split(/\r?\n/).slice(-4).join(' | ')}`)
  await shutDown(s, log)
  writeMachineDevice(s.machine.p.run, 'virtio')
  return staged
}

/** A clean, full shutdown of Windows (no hibernate, no Fast Startup), waited for; the plug is pulled only for a scratch machine that will not stop. */
export async function shutDown(s: Scratch, log: (line: string) => void, device?: DisplayDevice): Promise<void> {
  // from the command line /s is a full shutdown (/hybrid is Fast Startup's); Windows has no /full and refuses a line with it
  const t0 = Date.now()
  await s.guest.admin(FULL_SHUTDOWN).catch(() => '')
  // what Windows shows while it stops, kept beside the logs: a full shutdown has taken past 3 minutes
  for (const at of [45_000, 150_000]) {
    if (await s.machine.stopped(Math.max(0, t0 + at - Date.now()))) break
    const file = `/tmp/vmscreen-logs/shutdown-${new Date().toISOString().slice(11, 19).replace(/:/g, '')}.png`
    const status = await s.qmp<{ status: string }>('query-status').catch((e: Error) => ({ status: e.message }))
    await s.qmp('screendump', { filename: file, format: 'png' }).catch(() => undefined)
    log(`still stopping after ${Math.round((Date.now() - t0) / 1000)} s: QEMU ${status.status}, picture ${file}`)
  }
  if (!(await s.machine.stopped(Math.max(0, t0 + 180_000 - Date.now())))) {
    log('Windows did not stop in 3 minutes: pulling the plug')
    await s.machine.forceStop()
  } else log(`Windows stopped in ${Math.round((Date.now() - t0) / 1000)} s`)
  await s.machine.keepTpm().catch(() => {})
  if (device) writeMachineDevice(s.machine.p.run, device)
}

/** The display adapters Windows names, with their modes: `name|WxH|driver version|status`, one a line. */
export const ADAPTERS_SCRIPT =
  "Get-CimInstance Win32_VideoController | ForEach-Object { '{0}|{1}x{2}|{3}|{4}' -f $_.Name, $_.CurrentHorizontalResolution, $_.CurrentVerticalResolution, $_.DriverVersion, $_.Status }"
