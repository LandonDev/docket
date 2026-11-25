#!/usr/bin/env bun
/**
 * M3c's proof at the door (docs/computer-protocol.md §29.9, docs/agents/work-winvm.md "The picture"), with no Work
 * thread and no model, on a scratch machine (scripts/lib/winvmScratch.ts):
 *
 *   1. a fresh scratch disk, moved to virtio-vga (`moveToVirtio`) and started at 1280×800;
 *   2. the keeper's own setup over it (`Keeper.setup`: the setup script, tc-computer.exe copied in by
 *      `installService`, its logon task started by `startService`, a restart, the door opened and knocked);
 *   3. through the door: `display.get` (adapter and mode), then 3456×2234 at 200% asked through `VmPicture`'s
 *      drive stream and `VmDisplay`, whose `display.set` must answer `taken: true`, then `display.get` again; the
 *      time of each call, the time from the ask to the first frame at 3456×2234, and QMP's picture of the guest;
 *   4. a click at 200%: Edge opens a box-served page (10.0.2.2) with one button, "Add one"; the door's own picture
 *      of Edge's window (`state.get` as `windows_observe` reads it, and `capture.screenshot` of the same window in
 *      PNG at the same size); the button's centre found in that picture; one `action.run` `left_click` at that
 *      point in the picture's space, as `windows_act` sends it; the box counts the page's POSTs and must count 1;
 *   5. `display.set` 5120×2880 sent raw must answer the wire's -32602, and `display.get` must not change;
 *   6. everything torn down; one JSON of rows out. It records times and never judges one.
 *
 * The door's client here is a raw JSON-RPC one over `doorSpawn`, since the host's own connection checks params and
 * would refuse step 5's ask before it reached the guest. The exe must be one `--build-exe` built and stamped
 * (commit and sha256 beside it) from a clean tree that holds M3c; any other is refused.
 *
 * Scratch only (`scratchMachineRefusal`, a disk in /dev/shm), and only with the master's yes for a VM. The run
 * stops itself at 25 minutes. Build the exe first (cargo-xwin, through the heavy queue), then run:
 *   heavy bun scripts/e2e-winvm-door-display.ts --build-exe
 *   WINVM_DIR=/dev/shm/vm-screen-rig-d WINVM_TPM_DIR=/tmp/win-vm-tpm-vmscreen-d WINVM_SSH_PORT=22244 \
 *     taskset -c 24-31 ionice -c 3 nice -n 19 bun scripts/e2e-winvm-door-display.ts --driver <viogpudo dir> [--out <dir>]
 */
import { spawnSync, type ChildProcess } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { PNG } from 'pngjs'
import { LOCAL_PRINCIPAL } from '../src/shared/capabilities'
import { COMPUTER_METHODS, COMPUTER_PROTOCOL, type ComputerMethod, type ComputerResult } from '../src/shared/computer/protocol'
import type { WinvmState } from '../src/shared/contract-work-winvm'
import type { StreamClaim } from '../src/main/server/remote/auth'
import { VideoRelay, type StreamInfo } from '../src/main/server/video/relay'
import { VideoRpc } from '../src/main/server/video/rpc'
import { VmDisplay } from '../src/main/server/work/winvm/display'
import { doorSpawn, type GuestDisplay, type GuestModeAsk } from '../src/main/server/work/winvm/door'
import { vmTiers } from '../src/main/server/work/winvm/gate'
import { readMachineDevice } from '../src/main/server/work/winvm/guestScreen'
import { Keeper } from '../src/main/server/work/winvm/keeper'
import { VM_COMPUTER, VmPicture } from '../src/main/server/work/winvm/picture'
import { tcComputerExe } from '../src/main/server/work/winvm/serviceBin'
import { builtExe, buildCommand, crate } from './build-tc-computer-win'
import { BenchViewer, moveToVirtio, nowUs, scratchMachine, shutDown, sleep, type Scratch } from './lib/winvmScratch'
import { fitAsk, resizeRow } from './lib/winvmResize'
import { BUTTON_RGB, colourCentre, exeRefusal, M3C_COMMIT, modeWord, pngSize, proofPage, summary, type ExeStamp, type Row } from './lib/winvmDoorDisplay'

const arg = (name: string, d: string): string => {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 ? process.argv[i + 1]! : d
}
const ROOT = resolve(import.meta.dirname, '..')
const log = (m: string) => console.log(`[e2e-winvm-door-display ${new Date().toISOString().slice(11, 19)}] ${m}`)
const sha256 = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex')
const git = (...args: string[]) => spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' })

/** The size the proof asks: the MacBook's screen at 200%, §29.9's own example. */
const BIG = { width: 3456, height: 2234, scale: 200 }
/** Past GUEST_DISPLAY: the wire's -32602, never the driver's. */
const TOO_BIG = { width: 5120, height: 2880, scale: 200 }
const DEADLINE_MS = 25 * 60_000
const FRAME_WAIT_MS = 10_000

// ------------------------------------------------------------------ --build-exe: build and stamp the service

if (process.argv.includes('--build-exe')) {
  const dirty = git('status', '--porcelain', '--', 'native/tc-computer-win').stdout.trim()
  if (dirty) throw new Error(`native/tc-computer-win has changes not committed; build from a clean tree:\n${dirty}`)
  const commit = git('rev-parse', 'HEAD').stdout.trim()
  if (git('merge-base', '--is-ancestor', M3C_COMMIT, commit).status !== 0) throw new Error(`HEAD ${commit} does not hold M3c (${M3C_COMMIT})`)
  const { cmd, args, env } = buildCommand()
  log(`building tc-computer.exe at ${commit.slice(0, 9)}: ${cmd} ${args.join(' ')} (in ${crate})`)
  const r = spawnSync(cmd, args, { cwd: crate, env, stdio: 'inherit' })
  if (r.status !== 0) process.exit(r.status ?? 1)
  const stamp: ExeStamp = { commit, sha256: sha256(builtExe), builtAt: new Date().toISOString() }
  writeFileSync(`${builtExe}.build.json`, JSON.stringify(stamp, null, 1) + '\n')
  log(`stamped ${builtExe}: ${stamp.sha256}`)
  process.exit(0)
}

// ------------------------------------------------------------------ the run

const DRIVER = arg('driver', '')
const DATA = arg('data', process.env.TEMP_CODE_USER_DATA ?? '/srv/agents/temp-code-data')
const OUT = resolve(arg('out', `/tmp/e2e-winvm-door-display-${Date.now()}`))
if (!DRIVER) throw new Error('--driver <the unpacked viogpudo folder>')

const EXE = tcComputerExe({ root: ROOT })
const stamp = EXE && existsSync(`${EXE}.build.json`) ? (JSON.parse(readFileSync(`${EXE}.build.json`, 'utf8')) as ExeStamp) : null
const refused = exeRefusal({ exe: EXE, sha256: EXE ? sha256(EXE) : null, stamp, holdsM3c: !!stamp && git('merge-base', '--is-ancestor', M3C_COMMIT, stamp.commit).status === 0 })
if (refused) {
  console.error(`refused: ${refused}`)
  process.exit(2)
}
mkdirSync(OUT, { recursive: true })

const rows: Row[] = []
const row = (r: Row): Row => (rows.push(r), log(`${r.ok ? 'PASS' : 'FAIL'} ${r.step} ${JSON.stringify({ ...r, step: undefined, ok: undefined })}`), r)
const timed = async <T>(fn: () => Promise<T>): Promise<{ value: T; ms: number }> => {
  const t0 = performance.now()
  const value = await fn()
  return { value, ms: Math.round((performance.now() - t0) * 10) / 10 }
}

/** A wire error as the door answered it. */
class WireError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown
  ) {
    super(message)
  }
}

/** JSON-RPC over the door's spawn, one line a frame, with nothing between the script and the guest's service. */
class DoorClient {
  private next = 1
  private buf = ''
  private readonly waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>()
  constructor(private readonly child: ChildProcess) {
    child.stdout!.on('data', (b: Buffer) => {
      this.buf += b.toString()
      let nl: number
      while ((nl = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, nl)
        this.buf = this.buf.slice(nl + 1)
        let f: { id?: number; result?: unknown; error?: { code: number; message: string; data?: unknown } }
        try {
          f = JSON.parse(line)
        } catch {
          continue
        }
        const w = f.id === undefined ? undefined : this.waiting.get(f.id)
        if (!w) continue
        this.waiting.delete(f.id!)
        clearTimeout(w.timer)
        if (f.error) w.reject(new WireError(f.error.code, f.error.message, f.error.data))
        else w.resolve(f.result)
      }
    })
    child.once('exit', () => {
      for (const w of this.waiting.values()) w.reject(new Error('the door closed'))
      this.waiting.clear()
    })
  }
  /** Any params, sent as they are; the answer checked against the method's result schema. */
  async raw<M extends ComputerMethod>(method: M, params: unknown, timeoutMs = 60_000): Promise<ComputerResult<M>> {
    const id = this.next++
    const answer = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => (this.waiting.delete(id), reject(new Error(`${method} did not answer in ${timeoutMs} ms`))), timeoutMs)
      this.waiting.set(id, { resolve, reject, timer })
    })
    this.child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    return COMPUTER_METHODS[method].result.parse(await answer) as ComputerResult<M>
  }
  close(): void {
    this.child.kill()
  }
}

let s: Scratch | null = null
let keeper: Keeper | null = null
let door: DoorClient | null = null
const deadline = setTimeout(() => {
  row({ step: 'the run ended inside 25 minutes', ok: false })
  void teardown().finally(() => process.exit(4))
}, DEADLINE_MS)

async function teardown(): Promise<void> {
  clearTimeout(deadline)
  door?.close()
  keeper?.close()
  if (!s) return
  await shutDown(s, log).catch(() => {})
  await s.remove()
}

async function main(): Promise<void> {
  const began = Date.now()
  row({ step: 'exe', ok: true, exe: EXE, sha256: stamp!.sha256, commit: stamp!.commit })
  s = scratchMachine({ data: DATA, size: [1280, 800], log })
  const sc = s

  // 1. a fresh disk on std VGA, moved to virtio-vga; the keeper's setup starts it there at 1280×800
  log('a fresh scratch disk, on std VGA')
  await sc.machine.makeDisk()
  await sc.machine.start()
  await sc.guest.ready(300_000)
  await moveToVirtio(sc, DRIVER, log)
  row({ step: 'moved to virtio-vga', ok: readMachineDevice(sc.machine.p.run) === 'virtio' })

  // 2. the keeper's own setup: the script, the service copied in and started, a restart, the door knocked
  let token: string | null = null
  keeper = new Keeper({
    machine: sc.machine,
    guest: sc.guest,
    serviceExe: () => EXE,
    hashFile: sha256,
    token: { get: () => token, set: (t) => (token = t) },
    doorSocket: join(sc.machine.p.run, 'door.sock'),
    sleepAfter: () => 'never',
    setSleepAfter: () => {},
    // a throwaway keeps no restore points
    points: { list: () => [], save: async () => {}, restore: async () => {}, remove: async () => {} },
    push: () => {},
    log
  })
  const k = keeper
  const setup = await timed(() => k.setup())
  row({ step: 'the keeper set it up, on virtio, and its door answered', ok: setup.value.state === 'awake' && !setup.value.error, ms: setup.ms, state: setup.value.state, error: setup.value.error })
  if (setup.value.state !== 'awake') throw new Error('setup failed')
  row({ step: "the guest's service is the stamped exe", ok: (await sc.guest.serviceHash()) === stamp!.sha256 })

  const hostDir = join(OUT, 'computer')
  mkdirSync(hostDir, { recursive: true })
  const spawn = doorSpawn({ door: () => k.door(), fetch: (rel, local) => k.fetch(rel, local), hostDataDir: hostDir, log })
  const d = (door = new DoorClient(spawn.spawn('tc-computer.exe', []) as unknown as ChildProcess))
  await d.raw('initialize', { protocol: COMPUTER_PROTOCOL, client: { name: 'e2e-winvm-door-display', version: '1' }, dataDir: hostDir })

  // 3. the mode, then 3456×2234 at 200% through the drive stream
  const before = await timed(() => d.raw('display.get', {}))
  row({ step: 'display.get at the start', ok: /VirtIO GPU DOD/.test(before.value.adapter) && modeWord(before.value) === '1280x800@100', adapter: before.value.adapter, mode: modeWord(before.value), ms: before.ms })

  const sets: { ask: GuestModeAsk; answer: ComputerResult<'display.set'>; ms: number }[] = []
  const guest: GuestDisplay = {
    get: () => d.raw('display.get', {}),
    set: async (ask) => {
      const t = await timed(() => d.raw('display.set', ask))
      sets.push({ ask, answer: t.value, ms: t.ms })
      return t.value
    }
  }
  const relay = new VideoRelay()
  const minted: StreamClaim[] = []
  const rpc = new VideoRpc(relay, { mintStreamTicket: (c) => (minted.push(c), { ticket: 't', expiresIn: 30 }) }, () => true)
  const state: WinvmState = { state: 'awake', step: null, error: null, cannot: null, sleepAfter: 'never', since: Date.now() }
  const isVm = (st: StreamInfo): boolean => st.tag === VM_COMPUTER
  const display = new VmDisplay({ run: sc.machine.p.run, guest: () => guest, screen: sc.screen, relay, isVm, log })
  const picture = new VmPicture({
    state: () => state,
    onState: () => () => {},
    setViewers: () => {},
    screen: sc.screen,
    relay,
    screenshot: async () => Buffer.alloc(0),
    jpeg: async () => ({ data: '', width: 1, height: 1 }),
    display,
    device: () => readMachineDevice(sc.machine.p.run)
  })
  rpc.addSource(picture)
  picture.setDriving(true)
  const caller = { principal: LOCAL_PRINCIPAL, connection: {}, connectionId: '1' }
  const open = async (): Promise<{ stream: string; viewer: BenchViewer & { closedWith?: number | null } }> => {
    const answer = await rpc.open({ threadId: VM_COMPUTER, computer: VM_COMPUTER, maxEdge: 4096, drive: true }, caller)
    if (!answer.ok) throw new Error(`video.open refused: ${answer.reason}`)
    const viewer = Object.assign(new BenchViewer(), { closedWith: null as number | null })
    viewer.close = (code?: number) => void (viewer.closedWith = code ?? null)
    if (!relay.attach(minted.at(-1)!, viewer)) throw new Error('the viewer did not join')
    return { stream: answer.stream, viewer }
  }
  let live = await open()
  await sleep(1500)
  const askUs = nowUs()
  const sized = await rpc.size({ stream: live.stream, mode: 'fit', ...fitAsk(BIG), detail: 'sharp' }, caller).then(
    (a) => (a.ok ? modeWord(a) : a.reason),
    (e: Error) => `error: ${e.message}`
  )
  const closed = live.viewer.closedWith ?? null
  live = await open()
  const end = Date.now() + FRAME_WAIT_MS
  while (!live.viewer.frames.some((f) => f.w === BIG.width && f.h === BIG.height) && Date.now() < end) await sleep(20)
  await sleep(1000)
  const set = sets[0]
  row({ step: 'display.set 3456x2234@200 through the drive stream: taken', ok: !!set && modeWord(set.ask) === modeWord(BIG) && set.answer.taken && modeWord(set.answer) === modeWord(BIG), ask: set && modeWord(set.ask), answer: set?.answer, ms: set?.ms, sized })
  const after = await timed(() => d.raw('display.get', {}))
  row({ step: 'display.get after the set', ok: modeWord(after.value) === modeWord(BIG), mode: modeWord(after.value), ms: after.ms })
  const frames = resizeRow({ asked: BIG, took: sized, askUs, closed, frames: live.viewer.frames })
  row({ step: 'the stream reopened at 3456x2234', ok: frames.firstFrameMs !== null && frames.otherSize === 0, ...frames })
  const qmpShot = join(OUT, 'guest-3456x2234.png')
  await sc.qmp('screendump', { filename: qmpShot, format: 'png' })
  const qmpSize = pngSize(readFileSync(qmpShot))
  row({ step: "QMP's picture of the guest", ok: qmpSize?.width === BIG.width && qmpSize.height === BIG.height, file: qmpShot, size: qmpSize })

  // 4. a click at 200% on a box-served page, mapped from the door's own picture
  const posts: number[] = []
  const gets: number[] = []
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(req) {
      const url = new URL(req.url)
      if (req.method === 'POST' && url.pathname === '/add') return new Response(String(posts.push(Date.now())))
      if (url.pathname === '/ping') return new Response('pong')
      gets.push(Date.now())
      return new Response(proofPage(), { headers: { 'content-type': 'text/html' } })
    }
  })
  try {
    const port = server.port!
    const page = `http://10.0.2.2:${port}/`
    await sc.guest.admin(`Set-NetFirewallRule -Name 'tc-block-host-tcp' -RemotePort @('1-${port - 1}', '${port + 1}-65535')`)
    await sc.guest.admin(
      [
        `$k = 'HKLM:\\SOFTWARE\\Policies\\Microsoft\\Edge'`,
        'New-Item -Path $k -Force | Out-Null',
        'foreach ($v in @(@("HideFirstRunExperience", 1), @("BrowserSignin", 0), @("SyncDisabled", 1), @("DefaultBrowserSettingEnabled", 0), @("AutoImportAtFirstRun", 4), @("AutomaticHttpsDefault", 0))) { New-ItemProperty -Path $k -Name $v[0] -Value $v[1] -PropertyType DWord -Force | Out-Null }'
      ].join('\n')
    )
    const ping = (await sc.guest.admin(`(Invoke-WebRequest -UseBasicParsing -TimeoutSec 10 '${page}ping').Content`).catch((e) => String(e))).trim()
    row({ step: `the guest reaches the page at 10.0.2.2:${port}`, ok: ping === 'pong', ping: ping.slice(0, 200) })
    const session = `proof-${randomBytes(3).toString('hex')}`
    await d.raw('session.open', { session })
    const launched = await d.raw('apps.launch', { app: 'msedge.exe', open: [page], session }, 60_000)
    const pageEnd = Date.now() + 60_000
    while (!gets.length && Date.now() < pageEnd) await sleep(250)
    await sleep(2000)
    const target = { session, app: { pid: launched.pid }, ...(launched.window ? { window: { id: launched.window.id } } : {}) }
    const obs = await timed(() => d.raw('state.get', { ...target, mode: 'full', screenshot: 'always', tabs: 'background' }, 60_000))
    const shot = await d.raw('capture.screenshot', { ...target, format: 'png', tabs: 'background' }, 60_000)
    const png = PNG.sync.read(readFileSync(shot.path))
    writeFileSync(join(OUT, 'edge-before.png'), readFileSync(shot.path))
    const space = obs.value.space
    const centre = colourCentre(png.data, png.width, png.height, BUTTON_RGB)
    row({ step: "the door's picture of Edge, as windows_observe reads it", ok: !!centre && png.width === space.width && png.height === space.height, space, frame: obs.value.window.frame, png: { width: png.width, height: png.height }, button: centre, ms: obs.ms })
    if (!centre) throw new Error('the button is not in the picture')
    const act = await timed(() => d.raw('action.run', { ...target, action: { action: 'left_click', coordinate: [centre.x, centre.y] }, tiers: vmTiers(['process', 'front', 'session']), tabs: 'background' }, 60_000))
    const clickEnd = Date.now() + 10_000
    while (posts.length < 1 && Date.now() < clickEnd) await sleep(100)
    await sleep(1000)
    const again = await d.raw('state.get', { ...target, mode: 'full', screenshot: 'never', tabs: 'background' }, 60_000)
    const shown = /Count:\s*1\b/.test(again.text)
    const afterShot = await d.raw('capture.screenshot', { ...target, format: 'png', tabs: 'background' }, 60_000)
    writeFileSync(join(OUT, 'edge-after.png'), readFileSync(afterShot.path))
    row({ step: 'one left_click at the picture point adds one', ok: act.value.step.status === 'ok' && posts.length === 1, at: [centre.x, centre.y], status: act.value.step.status, tier: act.value.step.status === 'ok' ? act.value.step.tier : null, posts: posts.length, countReadInThePage: shown, ms: act.ms })
  } finally {
    void server.stop(true)
  }

  // 5. out of range on the wire: -32602, and the mode stays
  const tooBig = await d.raw('display.set', TOO_BIG).then(
    (a) => ({ code: null as number | null, answer: a }),
    (e: Error) => ({ code: e instanceof WireError ? e.code : null, message: e.message })
  )
  const still = await d.raw('display.get', {})
  row({ step: 'display.set 5120x2880 is the wire error -32602, and the mode stays', ok: tooBig.code === -32602 && modeWord(still) === modeWord(after.value), answer: tooBig, mode: modeWord(still) })

  relay.endWhere(isVm, 'ended')
  picture.close()
  row({ step: 'the whole run', ok: true, minutes: Math.round((Date.now() - began) / 600) / 100 })
}

main()
  .catch((e) => row({ step: 'the run went on to the end', ok: false, error: (e as Error).message }))
  .finally(async () => {
    await teardown()
    const out = summary(rows)
    writeFileSync(join(OUT, 'rows.json'), JSON.stringify({ at: new Date().toISOString(), ...out }, null, 1) + '\n')
    console.log(JSON.stringify(out, null, 1))
    log(`written to ${OUT}`)
    process.exit(out.ok ? 0 : 1)
  })
