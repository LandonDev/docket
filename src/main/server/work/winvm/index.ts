import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { WINVM_DETAILS, WINVM_SCREENS, WINVM_SLEEP_AFTER, type WinvmDetail, type WinvmScreen, type WinvmSettings, type WinvmSleepAfter, type WinvmState } from '@shared/contract-work-winvm'
import { handled, NOT_HANDLED } from '@shared/work'
import type { WorkCtx, WorkModule } from '../modules'
import { Keeper, type KeeperDeps } from './keeper'
import { tcComputerExe } from './serviceBin'
import { SshGuest } from './sshGuest'
import { StandingMachine } from './standing'
import { PendingCalls } from '../../computer/pending'
import { VM_PREAMBLE, vmOffered, vmTools } from './tools'
import { restoreClipboard, saveClipboard, startVm, vmCopied, vmPaste } from './vm'
import { configureVmClipboard } from './drive'
import { configureVmCopy, configureVmPaste } from './picture'
import { vmScreen } from './window'
import { ensurePuts } from './files'
import { HELPER_PORT, HelperDoor } from './helperDoor'
import { rigConfig, rigPaths, throwawayHost } from './machine/config'
import { TC_OFFICE_CS } from '../office/com/source'
import { uploadsOwed } from './owed'
import { stillRefusal, vmStill } from './still'
import { personsDesktop } from '../../../headless'
import { readGuestScale, readGuestScreen, readMachineDevice, writeGuestScreen, writeMachineDevice } from './guestScreen'
import { VGA_DEFAULT } from './machine/qemu'
import { ibeamCursor, virtioDriver } from './driver'
import { heldMark, takeAwakeAtStop } from './afterStop'

/**
 * The Windows VM pillar's server module (docs/agents/work-winvm.md): the
 * keeper of the box's standing Windows machine, its methods and its push.
 * The windows_* tools that drive it come with the service on the box (B5).
 */

export const NOT_A_PERSON = 'refused: only a person sets the Windows VM up, puts it to sleep, restarts it, changes its settings, its display or its restore points'

/** The host setting that holds how long an idle machine stays awake. */
export const SLEEP_AFTER_SETTING = 'work.winvm.sleepAfter'
const DEFAULT_SLEEP_AFTER: WinvmSleepAfter = '30m'

export function sleepAfterSetting(db: DatabaseSync): WinvmSleepAfter {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(SLEEP_AFTER_SETTING) as { value?: string } | undefined
    return (WINVM_SLEEP_AFTER as readonly string[]).includes(row?.value ?? '') ? (row!.value as WinvmSleepAfter) : DEFAULT_SLEEP_AFTER
  } catch {
    return DEFAULT_SLEEP_AFTER
  }
}

export function setSleepAfter(db: DatabaseSync, v: WinvmSleepAfter): void {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(SLEEP_AFTER_SETTING, v)
}

/** The host setting that holds the guest's screen: Fit to window until he picks a size. On std VGA a size is used by a new Set up. */
export const SCREEN_SETTING = 'work.winvm.screen'
/** The host setting that holds Sharp or Faster. */
export const DETAIL_SETTING = 'work.winvm.detail'

function setting<T extends string>(db: DatabaseSync, key: string, values: readonly T[], fallback: T): T {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value?: string } | undefined
    return (values as readonly string[]).includes(row?.value ?? '') ? (row!.value as T) : fallback
  } catch {
    return fallback
  }
}
const put = (db: DatabaseSync, key: string, v: string): void => {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(key, v)
}

export const screenSetting = (db: DatabaseSync): WinvmScreen => setting(db, SCREEN_SETTING, WINVM_SCREENS, 'fit')
export const setScreen = (db: DatabaseSync, v: WinvmScreen): void => put(db, SCREEN_SETTING, v)
export const detailSetting = (db: DatabaseSync): WinvmDetail => setting(db, DETAIL_SETTING, WINVM_DETAILS, 'sharp')
export const setDetail = (db: DatabaseSync, v: WinvmDetail): void => put(db, DETAIL_SETTING, v)

/** A screen setting in the guest's pixels: Fit starts a new machine at the std VGA's own 1280×800, and live resize sizes it from there. */
export const screenSize = (v: WinvmScreen): { width: number; height: number } => {
  if (v === 'fit') return { ...VGA_DEFAULT }
  const [width, height] = v.split('x').map(Number) as [number, number]
  return { width, height }
}

/** The door's token, in the keeper's folder under the app's data, readable by this user alone. */
function tokenFile(dir: string): KeeperDeps['token'] {
  const file = join(dir, 'token')
  return {
    get: () => (existsSync(file) ? readFileSync(file, 'utf8').trim() || null : null),
    set: (token) => {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      writeFileSync(file, token + '\n', { mode: 0o600 })
      chmodSync(file, 0o600)
    }
  }
}

export const hashFile = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex')

/** The keeper over the real standing machine and its guest. */
export function realKeeperDeps(ctx: WorkCtx): Omit<KeeperDeps, 'push' | 'pushPoints'> {
  // QEMU's window on a display of its own, where its tools are installed (window.ts)
  const screen = vmScreen(ctx.dataDir, (line) => ctx.log(line), () => screenSize(screenSetting(ctx.db)))
  // an isolated proof instance's machine may be a throwaway (config.ts); his never is
  const scratch = throwawayHost()
  if (scratch.refused) ctx.log(`winvm: WINVM_THROWAWAY refused: ${scratch.refused}`)
  const machine = new StandingMachine('standing', process.env, screen, (line) => ctx.log(line), scratch.throwaway ? { throwaway: true } : {})
  return {
    machine,
    guest: new SshGuest(machine.c, machine.p),
    serviceExe: () => tcComputerExe(),
    hashFile,
    token: tokenFile(join(ctx.dataDir, 'winvm')),
    // under the machine's own folder: a unix socket's path must stay under 108 bytes
    doorSocket: join(machine.p.run, 'door.sock'),
    forwards: [{ socket: helperSocket(machine.p.run), port: HELPER_PORT }],
    sleepAfter: () => sleepAfterSetting(ctx.db),
    setSleepAfter: (v) => setSleepAfter(ctx.db, v),
    points: machine.points(),
    log: (line) => ctx.log(line),
    // the watcher's record of a machine awake at the stop, in its run folder; his Sleep's hold beside the token
    awakeAtStop: () => takeAwakeAtStop(machine.p.run),
    held: heldMark(join(ctx.dataDir, 'winvm')),
    // the run's machine.json and screen.json (guestScreen.ts), his choice, and what live resize takes from the box
    display: {
      device: () => readMachineDevice(machine.p.run),
      setDevice: (device) => writeMachineDevice(machine.p.run, device),
      screen: () => {
        const size = readGuestScreen(machine.p.run)
        const scale = readGuestScale(machine.p.run)
        return size && scale ? { ...size, scale } : size
      },
      setScreen: (size) => writeGuestScreen(machine.p.run, size),
      choice: () => ({ screen: screenSetting(ctx.db), detail: detailSetting(ctx.db) }),
      driver: (progress) => virtioDriver({ dataDir: ctx.dataDir }, progress),
      cursor: () => ibeamCursor()
    }
  }
}

type KeeperFactory = (ctx: WorkCtx) => Omit<KeeperDeps, 'push' | 'pushPoints'>
let factory: KeeperFactory = realKeeperDeps
let keeper: Keeper | null = null

/** Whether a thread holds the machine now (vm.ts's lease, wired by the host): his Restart waits for it. */
let vmHeld: () => boolean = () => false
export function configureVmHeld(fn: (() => boolean) | null): void {
  vmHeld = fn ?? (() => false)
}
/** This host's own socket is a person's desktop (never the box): a test's say in place of the platform's. */
let desktop: () => boolean = () => personsDesktop()
export function configureWinvmDesktop(fn: (() => boolean) | null): void {
  desktop = fn ?? (() => personsDesktop())
}

/** A test's fake machine and guest in place of the real ones; null puts the real ones back. */
export function configureWinvmKeeper(f: KeeperFactory | null): void {
  keeper?.close()
  keeper = null
  factory = f ?? realKeeperDeps
}

const stateListeners = new Set<(state: WinvmState | null) => void>()
const told = (state: WinvmState | null): void => {
  for (const fn of [...stateListeners]) fn(state)
}

/** Every change of the keeper's state, as pushed, and null when Work goes off: the VM's picture and row follow it (picture.ts). */
export function onWinvmState(fn: (state: WinvmState | null) => void): () => void {
  stateListeners.add(fn)
  return () => void stateListeners.delete(fn)
}

function keeperOf(ctx: WorkCtx): Keeper {
  keeper ??= new Keeper({
    ...factory(ctx),
    push: (state) => {
      ctx.push({ push: 'work.winvm', state })
      told(state)
    },
    pushPoints: (points) => ctx.push({ push: 'work.winvm.points', points }),
    owed: () => uploadsOwed(),
    beforeSleep: async () => {
      await vmStill()?.keep()
    }
  })
  return keeper
}

/** The running keeper, for the VM's service on the box (B5); null while Work is off. */
export const winvmKeeper = (): Keeper | null => keeper

/** Where the forward to the guest's helper listens: beside the door's, under the machine's run folder. */
export const helperSocket = (run: string): string => join(run, 'office.sock')

let helper: HelperDoor | null = null
let helperFactory: (() => HelperDoor) | null = null
/** A test's own door to a stand-in helper; null puts the real one back. */
export function configureVmHelper(f: (() => HelperDoor) | null): void {
  helperFactory = f
  helper = null
}

/**
 * The helper's door in the standing machine (helperDoor.ts): the Teams files and the Office tools of
 * this host reach OneDrive and Office in the guest through it.
 */
export function vmHelper(): HelperDoor {
  helper ??= helperFactory?.() ?? new HelperDoor({ keeper: () => keeper, socket: helperSocket(rigPaths(rigConfig(process.env, undefined, 'standing')).run), source: TC_OFFICE_CS, log: (line) => started?.log(line) })
  return helper
}

/** Work's context while it is on: the tools read the workspace's setting through it. */
let started: WorkCtx | null = null
/** windows_* calls that answered early (a wake past 20 s): windows_result reads them */
const pending = new PendingCalls()

export const winvm: WorkModule = {
  id: 'winvm',
  ensure(db) {
    ensurePuts(db)
  },
  async handle(req, ctx, by) {
    switch (req.method) {
      case 'work.winvm.state':
        return handled(keeperOf(ctx).state())
      case 'work.winvm.wake':
        return handled(await keeperOf(ctx).wake())
      case 'work.winvm.sleep':
        if (by.kind === 'model') throw new Error(NOT_A_PERSON)
        return handled(await keeperOf(ctx).sleep())
      case 'work.winvm.still': {
        const refusal = stillRefusal(by, desktop())
        if (refusal) throw new Error(refusal)
        return handled({ still: vmStill()?.read() ?? null })
      }
      case 'work.winvm.restart':
        if (by.kind === 'model') throw new Error(NOT_A_PERSON)
        return handled(await keeperOf(ctx).restart(vmHeld))
      case 'work.winvm.setup': {
        if (by.kind === 'model') throw new Error(NOT_A_PERSON)
        const k = keeperOf(ctx)
        // minutes long: it answers at once, and its progress and end come as pushes
        k.setup().catch((e) => ctx.log(`winvm: setup failed: ${e instanceof Error ? e.message : String(e)}`))
        return handled(k.state())
      }
      case 'work.winvm.settings': {
        if (by.kind === 'model') throw new Error(NOT_A_PERSON)
        const k = keeperOf(ctx)
        const { screen, detail } = req.params
        if (screen !== undefined) setScreen(ctx.db, screen)
        if (detail !== undefined) setDetail(ctx.db, detail)
        if (screen !== undefined || detail !== undefined) k.refresh()
        const answer: WinvmSettings = { ...k.settings(req.params.sleepAfter), screen: screenSetting(ctx.db), detail: detailSetting(ctx.db) }
        return handled(answer)
      }
      case 'work.winvm.display.upgrade':
      case 'work.winvm.display.downgrade': {
        if (by.kind === 'model') throw new Error(NOT_A_PERSON)
        const k = keeperOf(ctx)
        // a refusal is the press's answer; the steps take minutes and come as pushes, as setup's do
        const no = k.liveResizeRefusal(vmHeld)
        if (no) throw new Error(no)
        const run = req.method === 'work.winvm.display.upgrade' ? k.upgrade(vmHeld) : k.downgrade(vmHeld)
        run.catch((e) => ctx.log(`winvm: live resize: ${e instanceof Error ? e.message : String(e)}`))
        return handled(k.state())
      }
      case 'work.winvm.points':
        return handled({ points: keeperOf(ctx).points() })
      case 'work.winvm.point.save':
        if (by.kind === 'model') throw new Error(NOT_A_PERSON)
        return handled(await keeperOf(ctx).savePoint(req.params.name))
      case 'work.winvm.point.restore':
        if (by.kind === 'model') throw new Error(NOT_A_PERSON)
        return handled(await keeperOf(ctx).restorePoint(req.params.id))
      case 'work.winvm.point.delete':
        if (by.kind === 'model') throw new Error(NOT_A_PERSON)
        return handled({ points: await keeperOf(ctx).deletePoint(req.params.id) })
      default:
        return NOT_HANDLED
    }
  },
  start(ctx) {
    started = ctx
    const k = keeperOf(ctx)
    const timer = setInterval(() => k.tick(), 60_000)
    timer.unref()
    const stopVm = startVm(winvmKeeper, (id, notice) => {
      ctx.threads.resume(id, notice).catch((e) => ctx.log(`winvm: could not tell ${id} the Windows VM is free: ${String(e)}`))
    })
    // his paste goes to the guest's clipboard and Ctrl+V through the service; the guest's clipboard is kept across his
    // Take over, so nothing he copied is left for a thread (drive.ts and picture.ts call these)
    const clip = { save: saveClipboard, restore: restoreClipboard }
    const paste = (text: string): Promise<void> => vmPaste(text)
    configureVmClipboard(clip)
    configureVmPaste(paste)
    configureVmCopy(vmCopied)
    // a keeper started beside a running machine takes it as awake, and says so to nobody else
    told(k.state())
    // awake when the service stopped (a deploy, a restart): woken once by itself, a little after the start
    void k.wakeAfterStop()
    return () => {
      configureVmClipboard(null)
      configureVmPaste(null)
      configureVmCopy(null)
      stopVm()
      pending.closeAll()
      clearInterval(timer)
      k.close()
      if (keeper === k) keeper = null
      if (started === ctx) started = null
      told(null)
    }
  },
  tools: (scope) => vmTools(scope, { ctx: () => started, keeper: winvmKeeper, pending }),
  preamble: (scope) => (started && vmOffered(started, scope, keeper) ? VM_PREAMBLE : null)
}
