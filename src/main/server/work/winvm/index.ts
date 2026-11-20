import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { WINVM_SLEEP_AFTER, type WinvmSettings, type WinvmSleepAfter } from '@shared/contract-work-winvm'
import { handled, NOT_HANDLED } from '@shared/work'
import type { WorkCtx, WorkModule } from '../modules'
import { Keeper, type KeeperDeps } from './keeper'
import { tcComputerExe } from './serviceBin'
import { SshGuest } from './sshGuest'
import { StandingMachine } from './standing'

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
  const machine = new StandingMachine('standing')
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

function keeperOf(ctx: WorkCtx): Keeper {
  keeper ??= new Keeper({
    ...factory(ctx),
    push: (state) => ctx.push({ push: 'work.winvm', state }),
    pushPoints: (points) => ctx.push({ push: 'work.winvm.points', points })
  })
  return keeper
}

/** The running keeper, for the VM's service on the box (B5); null while Work is off. */
export const winvmKeeper = (): Keeper | null => keeper

export const winvm: WorkModule = {
  id: 'winvm',
  ensure() {},
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
        const answer: WinvmSettings = keeperOf(ctx).settings(req.params.sleepAfter)
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
    const k = keeperOf(ctx)
    const timer = setInterval(() => k.tick(), 60_000)
    timer.unref()
    return () => {
      clearInterval(timer)
      k.close()
      if (keeper === k) keeper = null
    }
  }
}
