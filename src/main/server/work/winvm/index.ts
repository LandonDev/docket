import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { WINVM_SCREENS, WINVM_SLEEP_AFTER, type WinvmScreen, type WinvmSettings, type WinvmSleepAfter, type WinvmState } from '@shared/contract-work-winvm'
import { handled, NOT_HANDLED } from '@shared/work'
import type { WorkCtx, WorkModule } from '../modules'
import { Keeper, type KeeperDeps } from './keeper'
import { tcComputerExe } from './serviceBin'
import { SshGuest } from './sshGuest'
import { StandingMachine } from './standing'
import { PendingCalls } from '../../computer/pending'
import { VM_PREAMBLE, vmOffered, vmTools } from './tools'
import { restoreClipboard, saveClipboard, startVm, vmPaste } from './vm'
import { configureVmClipboard } from './drive'
import { configureVmPaste } from './picture'
import { vmScreen } from './window'
import { ensurePuts } from './files'

/**
 * The Windows VM pillar's server module (docs/agents/work-winvm.md): the
 * keeper of the box's standing Windows machine, its methods and its push.
 * The windows_* tools that drive it come with the service on the box (B5).
 */

export const NOT_A_PERSON = 'refused: only a person sets the Windows VM up, puts it to sleep, changes its settings or its restore points'

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

/** The host setting that holds the guest's screen size, taken at the next wake. */
export const SCREEN_SETTING = 'work.winvm.screen'

export function screenSetting(db: DatabaseSync): WinvmScreen {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(SCREEN_SETTING) as { value?: string } | undefined
    return (WINVM_SCREENS as readonly string[]).includes(row?.value ?? '') ? (row!.value as WinvmScreen) : '1280x800'
  } catch {
    return '1280x800'
  }
}

export function setScreen(db: DatabaseSync, v: WinvmScreen): void {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(SCREEN_SETTING, v)
}

/** A screen setting in the guest's pixels. */
export const screenSize = (v: WinvmScreen): { width: number; height: number } => {
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
  const machine = new StandingMachine('standing', process.env, screen, (line) => ctx.log(line))
  return {
    machine,
    guest: new SshGuest(machine.c, machine.p),
    serviceExe: () => tcComputerExe(),
    hashFile,
    token: tokenFile(join(ctx.dataDir, 'winvm')),
    // under the machine's own folder: a unix socket's path must stay under 108 bytes
    doorSocket: join(machine.p.run, 'door.sock'),
    sleepAfter: () => sleepAfterSetting(ctx.db),
    setSleepAfter: (v) => setSleepAfter(ctx.db, v),
    points: machine.points(),
    log: (line) => ctx.log(line)
  }
}

type KeeperFactory = (ctx: WorkCtx) => Omit<KeeperDeps, 'push' | 'pushPoints'>
let factory: KeeperFactory = realKeeperDeps
let keeper: Keeper | null = null

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
    pushPoints: (points) => ctx.push({ push: 'work.winvm.points', points })
  })
  return keeper
}

/** The running keeper, for the VM's service on the box (B5); null while Work is off. */
export const winvmKeeper = (): Keeper | null => keeper

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
      case 'work.winvm.setup': {
        if (by.kind === 'model') throw new Error(NOT_A_PERSON)
        const k = keeperOf(ctx)
        // minutes long: it answers at once, and its progress and end come as pushes
        k.setup().catch((e) => ctx.log(`winvm: setup failed: ${e instanceof Error ? e.message : String(e)}`))
        return handled(k.state())
      }
      case 'work.winvm.settings': {
        if (by.kind === 'model') throw new Error(NOT_A_PERSON)
        if (req.params.screen !== undefined) setScreen(ctx.db, req.params.screen)
        const answer: WinvmSettings = { ...keeperOf(ctx).settings(req.params.sleepAfter), screen: screenSetting(ctx.db) }
        return handled(answer)
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
    // a keeper started beside a running machine takes it as awake, and says so to nobody else
    told(k.state())
    return () => {
      configureVmClipboard(null)
      configureVmPaste(null)
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
