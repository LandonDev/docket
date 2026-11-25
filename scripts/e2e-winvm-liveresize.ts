#!/usr/bin/env bun
/**
 * Live resize proven on a scratch machine (docs/agents/work-winvm.md "The device, and live resize";
 * .temp-code/plans/vm-screen/proofs/M3d/PROOF-STEPS.md): the real Keeper and its live-resize code over the scratch
 * library's StandingMachine and a real SshGuest. Each part makes its own fresh disk on std VGA, prepared just
 * enough for the keeper's door (the service's folder, the token, hibernate on: setup's first and third steps, not
 * its policies or its restart), so each fits well under 25 minutes.
 *
 *   --part 1  a file in tcuser's Documents; Turn on (its six step words in order, the point "Before live resize"
 *             listed on std VGA, machine.json and QEMU on virtio, the adapter, the file there, HWCursor 1, the
 *             I-beam); the file changed; a resize through VmDisplay and the door's display.set (skipped, and said
 *             so, where the guest's service has no display.get); Turn off (std VGA at 1280x800, machine.json vga);
 *             Turn on again and asleep on virtio, then back to the first point (machine.json vga before the wake, a
 *             wake on std VGA, the file as it was). About 15 minutes: two cold boots and three restarts.
 *   --part 2  Turn on stopped between steps 5 and 6: the keeper is dropped the moment it asks for the hardware
 *             pointer, its call left hanging, as a stop of the box's service leaves it (in process: a real kill hands
 *             QEMU to the stop watcher, which hibernates it). machine.json and QEMU still agree; a new keeper over
 *             the same machine reads it awake on virtio, and its first wake turns the pointer on, once. About 8
 *             minutes.
 *
 * One JSON of rows out (`--out` writes it too); it records times and never asserts one. Exit 0 when every check
 * held, 1 when one did not, 3 when the live app slowed (the scratch library's watch), 4 past `--minutes` (25).
 * The driver comes from an unpacked folder (`--driver`, /tmp/vm-screen-driver: viogpudo.inf, .cat, .sys), so
 * nothing is downloaded; the guest's service is tcComputerExe() (TEMP_CODE_WINVM_EXE names a build with M3c's
 * display.set for the resize). Scratch only (`scratchMachineRefusal`), and only with the master's yes for a VM:
 *
 *   WINVM_DIR=/dev/shm/vm-screen-rig-l WINVM_TPM_DIR=/tmp/win-vm-tpm-vmscreen-l WINVM_SSH_PORT=22244 \
 *     taskset -c 24-31 ionice -c 3 nice -n 19 bun scripts/e2e-winvm-liveresize.ts --part 1 [--driver <dir>] [--out rows.json]
 */
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { WinvmSleepAfter } from '../src/shared/contract-work-winvm'
import { ComputerService } from '../src/main/server/computer/service'
import { VideoRelay } from '../src/main/server/video/relay'
import { VmDisplay } from '../src/main/server/work/winvm/display'
import { doorSpawn, guestDisplay } from '../src/main/server/work/winvm/door'
import { ibeamCursor } from '../src/main/server/work/winvm/driver'
import { GUEST_SCREEN_SCRIPT, parseGuestScreen, readGuestScreen, readMachineDevice, writeGuestScreen, writeMachineDevice } from '../src/main/server/work/winvm/guestScreen'
import { hashFile } from '../src/main/server/work/winvm/index'
import { BEFORE_LIVE_RESIZE, Keeper, type KeeperDisplay, type VmGuest } from '../src/main/server/work/winvm/keeper'
import { ADAPTERS_SCRIPT, CURSOR_SCRIPT, DRIVER_FILES, IBEAM_PATH, VIRTIO_ADAPTER } from '../src/main/server/work/winvm/liveResize'
import { requireScratchMachine, STANDARD_USER } from '../src/main/server/work/winvm/machine/config'
import { psQuote } from '../src/main/server/work/winvm/machine/guest'
import { VM_COMPUTER } from '../src/main/server/work/winvm/picture'
import { tcComputerExe } from '../src/main/server/work/winvm/serviceBin'
import { DATA_DIR, SERVICE_DIR, TOKEN_PATH } from '../src/main/server/work/winvm/setup'
import { scratchMachine, shutDown } from './lib/winvmScratch'
import { partOf, qemuDevice, report, saidInOrder, stepsSeen, UPGRADE_WORDS, valueOf, type ProofRow } from './lib/winvmLiveResize'

// Before anything else: with WINVM_DIR, WINVM_TPM_DIR or WINVM_SSH_PORT unset the standing machine is the owner's.
requireScratchMachine()

const arg = (name: string, d: string): string => {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 ? process.argv[i + 1]! : d
}
const PART = partOf(process.argv)
const DRIVER = arg('driver', '/tmp/vm-screen-driver')
const DATA = arg('data', process.env.TEMP_CODE_USER_DATA ?? '/srv/agents/temp-code-data')
const OUT = arg('out', '')
const MINUTES = Number(arg('minutes', '25'))
const FILE = 'C:\\Users\\tcuser\\Documents\\liveresize-proof.txt'
const BEFORE = 'before live resize'
const AFTER = 'after live resize'
/** the resize's ask: Windows at 100%, the scale a std VGA guest kept */
const RESIZE = { width: 1920, height: 1200, scale: 100 } as const

for (const f of DRIVER_FILES) if (!existsSync(join(DRIVER, f))) throw new Error(`${DRIVER} has no ${f}: give --driver the unpacked viogpudo\\w11\\amd64 folder`)
if (!tcComputerExe()) throw new Error("no tc-computer.exe for the guest: set TEMP_CODE_WINVM_EXE")

const log = (m: string) => console.log(`[e2e-winvm-liveresize ${new Date().toISOString().slice(11, 19)}] ${m}`)
const s = scratchMachine({ data: DATA, size: [1280, 800], log })
const run = s.machine.p.run
const began = Date.now()
const rows: ProofRow[] = []
const record = (step: string, ok: boolean | null, detail: string): void => {
  const row = { part: PART, step, ok, detail, at: Date.now() - began }
  rows.push(row)
  log(`${ok === null ? '·' : ok ? 'ok' : 'FAILED'} ${step}: ${detail}`)
}
const took = (step: string, since: number): void => record(step, null, `${((Date.now() - since) / 1000).toFixed(1)} s`)

// ── the guest: the real one, its admin calls counted, and the hardware pointer's held back when asked ──

let cursorAsks = 0
let holdCursor: (() => void) | null = null
const guest: VmGuest = new Proxy(s.guest as unknown as VmGuest, {
  get(target, name) {
    if (name === 'admin')
      return (script: string, timeoutMs?: number): Promise<string> => {
        if (script === CURSOR_SCRIPT) {
          cursorAsks++
          if (holdCursor) {
            const stop = holdCursor
            holdCursor = null
            stop()
            // the stopped service's call: never answered
            return new Promise<string>(() => {})
          }
        }
        return target.admin(script, timeoutMs)
      }
    const v = Reflect.get(target, name) as unknown
    return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v
  }
})

// ── the keeper, as realKeeperDeps builds it, over the scratch machine ──

const token = randomBytes(32).toString('hex')
let sleepAfter: WinvmSleepAfter = 'never'
const steps: (string | null)[] = []
const display: KeeperDisplay = {
  device: () => readMachineDevice(run),
  setDevice: (d) => writeMachineDevice(run, d),
  screen: () => readGuestScreen(run),
  setScreen: (size) => writeGuestScreen(run, size),
  choice: () => ({ screen: 'fit', detail: 'sharp' }),
  // the unpacked folder: nothing is downloaded
  driver: async () => DRIVER,
  cursor: () => ibeamCursor()
}
const makeKeeper = (): Keeper =>
  new Keeper({
    machine: s.machine,
    guest,
    serviceExe: () => tcComputerExe(),
    hashFile,
    token: { get: () => token, set: () => {} },
    doorSocket: join(run, 'door.sock'),
    sleepAfter: () => sleepAfter,
    setSleepAfter: (v) => (sleepAfter = v),
    points: s.machine.points(),
    push: (st) => {
      steps.push(st.step)
      log(`push: ${st.state}${st.step ? ` (${st.step})` : ''}${st.error ? ` error: ${st.error}` : ''}`)
    },
    log,
    display
  })

// ── what the proof reads ──

const qemu = (): 'virtio' | 'vga' | null => {
  const pid = s.machine.pid()
  return pid === null ? null : qemuDevice(readFileSync(`/proc/${pid}/cmdline`, 'utf8'))
}
const adapters = async (): Promise<string> => (await s.guest.admin(ADAPTERS_SCRIPT, 60_000)).trim().replace(/\r?\n/g, ', ')
const mode = async (): Promise<string> => {
  const m = parseGuestScreen(await s.guest.admin(GUEST_SCREEN_SCRIPT, 60_000))
  return m ? `${m.width}x${m.height}` : 'none'
}
const write = (text: string) => s.guest.admin(`[IO.File]::WriteAllText(${psQuote(FILE)}, ${psQuote(text)})`, 60_000)
const read = async () => (await s.guest.admin(`[IO.File]::ReadAllText(${psQuote(FILE)})`, 60_000)).trim()
const hwCursor = async (): Promise<string | null> =>
  valueOf(
    await s.guest.admin(
      `$dev = Get-PnpDevice -Class Display -PresentOnly | Where-Object FriendlyName -eq ${psQuote(VIRTIO_ADAPTER)} | Select-Object -First 1
if ($dev) { $key = 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\' + (Get-PnpDeviceProperty -InstanceId $dev.InstanceId -KeyName DEVPKEY_Device_Driver).Data; "hwcursor=$((Get-ItemProperty -LiteralPath $key -Name HWCursor -ErrorAction SilentlyContinue).HWCursor)" } else { 'hwcursor=no adapter' }`,
      60_000
    ),
    'hwcursor'
  )
const ibeam = async (): Promise<string | null> =>
  valueOf(
    await s.guest.admin(
      `$sid = (New-Object Security.Principal.NTAccount(${psQuote(STANDARD_USER)})).Translate([Security.Principal.SecurityIdentifier]).Value
"ibeam=$((Get-ItemProperty -LiteralPath "Registry::HKEY_USERS\\$sid\\Control Panel\\Cursors" -Name IBeam -ErrorAction SilentlyContinue).IBeam)"`,
      60_000
    ),
    'ibeam'
  )

/**
 * A fresh disk on std VGA, prepared for the keeper's door: the service's folder, the token tcuser reads, and
 * hibernate on with no sign-in on resume (setup's first and third steps); then the keeper's wake copies the service
 * in, starts the door and knocks.
 */
async function fresh(): Promise<Keeper> {
  const t = Date.now()
  await s.machine.makeDisk()
  await s.machine.start()
  await s.guest.ready(300_000)
  took('a fresh disk up on std VGA', t)
  await s.guest.admin(
    `$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force ${psQuote(SERVICE_DIR)} | Out-Null
New-Item -ItemType Directory -Force ${psQuote(DATA_DIR)} | Out-Null
icacls ${psQuote(DATA_DIR)} /inheritance:r /grant:r 'Administrators:(OI)(CI)F' 'SYSTEM:(OI)(CI)F' "${STANDARD_USER}:(OI)(CI)RX" | Out-Null
[IO.File]::WriteAllText(${psQuote(TOKEN_PATH)}, ${psQuote(token)} + [Environment]::NewLine)
powercfg /hibernate on
powercfg /hibernate /type full
powercfg /setacvalueindex SCHEME_CURRENT SUB_NONE CONSOLELOCK 0
powercfg /setactive SCHEME_CURRENT
'prepared'`,
    120_000
  )
  const keeper = makeKeeper()
  const w = Date.now()
  await keeper.wake()
  took("the keeper's door open", w)
  record('starts on std VGA', readMachineDevice(run) === 'vga' && qemu() === 'vga', `machine.json ${readMachineDevice(run)}, QEMU ${qemu()}, ${await adapters()}`)
  await write(BEFORE)
  return keeper
}

/** Turn on, and the facts after it. */
async function turnOn(keeper: Keeper): Promise<void> {
  steps.length = 0
  const t = Date.now()
  const st = await keeper.upgrade(() => false)
  took('Turn on', t)
  const seen = stepsSeen(steps)
  record('turn on: the six steps said in order', saidInOrder(seen, UPGRADE_WORDS), seen.join(' → '))
  record('turn on: awake on virtio', st.state === 'awake' && st.display?.device === 'virtio' && st.display.canResize, JSON.stringify(st.display))
  const point = keeper.points().find((p) => p.name === BEFORE_LIVE_RESIZE)
  record('turn on: the point listed, on std VGA', !!point && point.by === 'keeper' && point.device === 'vga', point ? `${point.name} by ${point.by}, ${point.device} at ${point.screen?.width}x${point.screen?.height}` : `points: ${keeper.points().map((p) => p.name).join(', ') || 'none'}`)
  record('turn on: machine.json and QEMU on virtio', readMachineDevice(run) === 'virtio' && qemu() === 'virtio', `machine.json ${readMachineDevice(run)}, QEMU ${qemu()}`)
  const a = await adapters()
  record('turn on: the VirtIO GPU adapter', a.includes(VIRTIO_ADAPTER), a)
  const f = await read()
  record('turn on: the file there after', f === BEFORE, f)
  const hw = await hwCursor()
  record('turn on: HWCursor 1', hw === '1', `HWCursor ${hw}`)
  const ib = await ibeam()
  record("turn on: tcuser's I-beam", ib === IBEAM_PATH, ib ?? 'none')
}

async function part1(): Promise<void> {
  const keeper = await fresh()
  await turnOn(keeper)
  const point = keeper.points().find((p) => p.name === BEFORE_LIVE_RESIZE)
  await write(AFTER)

  // a resize through VmDisplay and the door's display.set, where the guest's service has them
  const service = new ComputerService({
    dataDir: join(DATA, 'winvm', 'liveresize-proof'),
    bin: () => 'tc-computer.exe (the Windows VM)',
    spawn: doorSpawn({ door: () => keeper.door(), fetch: (rel, local) => keeper.fetch(rel, local), hostDataDir: join(DATA, 'winvm', 'liveresize-proof'), log }).spawn
  })
  const door = guestDisplay(() => service)
  const was = await door.get().then(
    (m) => ({ ok: true as const, words: `${m.width}x${m.height} at ${m.scale}% (${m.adapter})` }),
    (e: Error) => ({ ok: false as const, words: e.message })
  )
  if (!was.ok) record('a resize through VmDisplay', null, `skipped: the guest's service has no display.get (${was.words})`)
  else {
    const vmDisplay = new VmDisplay({ run, guest: () => door, screen: s.screen, relay: new VideoRelay(), isVm: (st) => st.tag === VM_COMPUTER, log })
    const t = Date.now()
    const set = await vmDisplay.set(RESIZE).then((m) => `${m.width}x${m.height} at ${m.scale}%, taken ${m.taken}`, (e: Error) => `error: ${e.message}`)
    took('the resize', t)
    const now = await mode()
    record('a resize through VmDisplay', now === `${RESIZE.width}x${RESIZE.height}` && JSON.stringify(readGuestScreen(run)) === JSON.stringify({ width: RESIZE.width, height: RESIZE.height }), `was ${was.words}; set ${set}; Windows ${now}; screen.json ${JSON.stringify(readGuestScreen(run))}; the box's display ${JSON.stringify(s.screen.size)}`)
  }
  await service.close().catch(() => {})

  // Turn off
  steps.length = 0
  const t = Date.now()
  const st = await keeper.downgrade(() => false)
  took('Turn off', t)
  record('turn off: steps', null, stepsSeen(steps).join(' → '))
  const m = await mode()
  record('turn off: std VGA at 1280x800', readMachineDevice(run) === 'vga' && qemu() === 'vga' && m === '1280x800' && st.display?.width === 1280 && st.display.height === 800, `machine.json ${readMachineDevice(run)}, QEMU ${qemu()}, Windows ${m}, ${await adapters()}`)
  const f = await read()
  record('turn off: the file there', f === AFTER, f)

  // back to the point from virtio: Turn on again (its own point, the file as it is now), asleep on virtio, then the
  // first point, taken on std VGA with the file as it was
  if (!point) return record('back to the point', false, 'no point "Before live resize"')
  const again = Date.now()
  await keeper.upgrade(() => false)
  took('Turn on again', again)
  await keeper.sleep()
  record('asleep on virtio before going back', readMachineDevice(run) === 'virtio', `machine.json ${readMachineDevice(run)}`)
  const b = Date.now()
  await keeper.restorePoint(point.id)
  took('going back', b)
  record('back to the point: machine.json vga before the wake', readMachineDevice(run) === 'vga' && JSON.stringify(readGuestScreen(run)) === '{"width":1280,"height":800}', `machine.json ${readMachineDevice(run)}, screen.json ${JSON.stringify(readGuestScreen(run))}`)
  const w = Date.now()
  await keeper.wake()
  took('the wake after going back', w)
  record('back to the point: wakes on std VGA', qemu() === 'vga' && (await adapters()).includes('Basic Display'), `QEMU ${qemu()}, ${await adapters()}`)
  const back = await read()
  record('back to the point: the file as it was', back === BEFORE, back)
  keeper.close()
}

async function part2(): Promise<void> {
  const first = await fresh()
  // the keeper's service stops the moment it asks for the hardware pointer, between steps 5 and 6
  const stopped = new Promise<void>((r) => (holdCursor = r))
  const t = Date.now()
  const up = first.upgrade(() => false)
  up.catch(() => {})
  await Promise.race([stopped, up.then(() => Promise.reject(new Error('Turn on ended without asking for the pointer')))])
  took('Turn on, up to step 6', t)
  first.close()
  const seen = stepsSeen(steps)
  record('stopped between steps 5 and 6', seen.at(-1) === UPGRADE_WORDS.at(-1) && saidInOrder(seen, UPGRADE_WORDS.slice(0, 5)), seen.join(' → '))
  record('after the stop: machine.json matches the run', readMachineDevice(run) === 'virtio' && qemu() === 'virtio', `machine.json ${readMachineDevice(run)}, QEMU ${qemu()}`)
  record('after the stop: the pointer not yet on', null, `HWCursor ${await hwCursor()}`)

  // the service starts again: a new keeper over the same machine
  const next = makeKeeper()
  const st = next.state()
  record('the new keeper reads it awake on virtio', st.state === 'awake' && st.display?.device === 'virtio', `${st.state}, ${JSON.stringify(st.display)}`)
  const asked = cursorAsks
  const w = Date.now()
  await next.wake()
  took("the new keeper's first wake", w)
  const hw = await hwCursor()
  record("its first wake finishes step 6", cursorAsks === asked + 1 && hw === '1', `the pointer asked ${cursorAsks - asked} time(s), HWCursor ${hw}`)
  const f = await read()
  record('the file there', f === BEFORE, f)
  await next.sleep()
  const r = Date.now()
  await next.wake()
  took('a sleep and wake after it', r)
  record('a later wake resumes on virtio, the pointer not asked again', qemu() === 'virtio' && cursorAsks === asked + 1, `QEMU ${qemu()}, the pointer asked ${cursorAsks - asked} time(s) in all`)
  next.close()
}

let error: string | null = null
let code = 1
const finish = async (): Promise<void> => {
  await shutDown(s, log).catch(() => {})
  await s.remove().catch(() => {})
  const out = JSON.stringify({ at: new Date().toISOString(), ...report(PART, rows, error) }, null, 1)
  if (OUT) writeFileSync(OUT, out + '\n')
  console.log(out)
}
const cap = setTimeout(() => {
  error = `stopped past ${MINUTES} minutes`
  log(error)
  void finish().finally(() => process.exit(4))
}, MINUTES * 60_000)
try {
  await (PART === 1 ? part1() : part2())
} catch (e) {
  error = e instanceof Error ? e.message : String(e)
  log(`FAILED: ${error}`)
}
clearTimeout(cap)
await finish()
code = report(PART, rows, error).ok ? 0 : 1
process.exit(code)
