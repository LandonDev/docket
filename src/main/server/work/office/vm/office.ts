import type { WorkScope } from '@shared/work'
import type { WorkCtx } from '../../modules'
import { SuggestionStore } from '../../sheets/suggestions'
import { vmHelper, winvmKeeper } from '../../winvm'
import { VM_ASLEEP } from '../../winvm/helperDoor'
import { OfficeError, type OfficeCarrier } from '../carrier'
import { comCarrier, type ComCarrier, type HelperProcess } from '../com/carrier'
import { ExcelHelper } from '../excel'
import { storedStatus } from './files'
import { helperSocket } from './link'

/**
 * Office in the Windows VM this host keeps (docs/agents/work-office.md "The Windows VM"): the
 * Windows carrier, its helper not a child of this process but the one behind the guest's door
 * (winvm/helperDoor.ts). Excel, Word and PowerPoint there are driven by COM in tcuser's session, as
 * on any Windows PC; the box's own carrier (Outlook on the web) keeps mail and calendar.
 *
 * The carrier never wakes the machine by itself, so a watched workbook's safety pass leaves a
 * sleeping VM asleep: a tool call wakes it first (`vmAwake`).
 */

export interface VmHere {
  carrier: OfficeCarrier
  excel: ExcelHelper
  suggestions: SuggestionStore
}

/** The guest's helper as the carrier's process: one socket is both its stdin and its stdout. */
async function start(): Promise<HelperProcess> {
  const door = await vmHelper().openIfAwake()
  if (!door) throw new Error(VM_ASLEEP)
  const s = await helperSocket(door)
  return {
    stdin: s,
    stdout: s,
    kill: () => {
      s.destroy()
      return true
    },
    once: ((event: 'close' | 'error', fn: (arg: never) => void) => (event === 'close' ? s.once('close', () => (fn as (code: number | null) => void)(null)) : s.once('error', fn as (err: Error) => void))) as HelperProcess['once']
  }
}

let startFor: () => Promise<HelperProcess> = start
let made = new WeakMap<WorkCtx['db'], VmHere>()
/** A test's stand-in helper; null puts the guest's back. */
export function setVmHelperStart(fn: (() => Promise<HelperProcess>) | null): void {
  startFor = fn ?? start
  made = new WeakMap()
}

export const NO_LICENCE = 'Office in the Windows VM is not signed in yet, so it opens files to view only: the owner signs in to it once (Settings → Connections).'

/**
 * The VM's carrier with two things said plainly. A call the helper never answered left it sitting on a dialog
 * in Office: the helper is ended as the admin, and its door made ready again at the next call. And an Office
 * with no licence refuses a save or a write with a bare code (0x800A03EC, "the license … has expired"): only
 * while the VM's last read says Office holds no licence (`licensed` false, not unknown) does such a failure say
 * why. 0x800A03EC is Excel's answer to anything it will not do (a dynamic-array member on an Excel without
 * them, a bad formula, a locked cell), so a licensed or unread Office's failure stays as it is.
 */
function restartOnStall(carrier: ComCarrier, log: (line: string) => void, licensed: () => boolean | null): OfficeCarrier {
  const stalled = (err: unknown): boolean => err instanceof OfficeError && /did not answer .* within|has not said within/.test(err.message)
  const unlicensed = (err: unknown): err is OfficeError => err instanceof OfficeError && err.code === 'failed' && licensed() === false && /0x800A03EC|licen[cs]e/i.test(err.message)
  return new Proxy(carrier, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver) as unknown
      if (typeof v !== 'function' || prop === 'changes' || prop === 'stop') return v
      return (...args: unknown[]) => {
        const out = (v as (...a: unknown[]) => unknown).apply(target, args)
        if (!(out instanceof Promise)) return out
        return out.catch((err: unknown) => {
          if (stalled(err)) {
            log('office: the helper in the Windows VM stalled; ending it')
            vmHelper().doubt()
            void winvmKeeper()?.admin('Get-Process tc-office -ErrorAction SilentlyContinue | Stop-Process -Force').catch(() => undefined)
          }
          if (unlicensed(err)) throw new OfficeError(NO_LICENCE, 'not-allowed')
          throw err
        })
      }
    }
  })
}

/** The VM's Office on this host, made once per database. */
export function vmHereOf(ctx: WorkCtx): VmHere {
  const had = made.get(ctx.db)
  if (had) return had
  const carrier = restartOnStall(comCarrier({ start: () => startFor(), log: (line) => ctx.log(line) }), ctx.log, () => storedStatus(ctx.db)?.status.office.licensed ?? null)
  const suggestions = new SuggestionStore(ctx.db)
  const here: VmHere = { carrier, suggestions, excel: new ExcelHelper(carrier, ctx.db, suggestions) }
  made.set(ctx.db, here)
  return here
}

/** Lets go of the VM's carrier when the module stops. */
export function stopVmOffice(ctx: WorkCtx): void {
  const here = made.get(ctx.db)
  here?.excel.stop()
  here?.carrier.stop?.()
  made.delete(ctx.db)
}

/** The VM's state as its keeper says it; null where Work is off or this host keeps none. */
let stateOf: () => { state: string; cannot: string | null } | null = () => winvmKeeper()?.state() ?? null
/** A test's own VM state; null puts the keeper's back. */
export const setVmState = (fn: (() => { state: string; cannot: string | null } | null) | null): void => void (stateOf = fn ?? (() => winvmKeeper()?.state() ?? null))
export const vmState = (): { state: string; cannot: string | null } | null => stateOf()

/** Keys from the machine's own keyboard (the keeper's `key`). */
export const vmKey = async (...qcodes: string[]): Promise<void> => {
  const keeper = winvmKeeper()
  if (!keeper) throw new Error('The Windows VM is not awake.')
  await keeper.key(...qcodes)
}

/** Whether a thread of this scope may use what is in the Windows VM: a workspace with "Computer use on the Windows VM" on, on the host whose VM is set up. A Work Chat never. */
export function vmAllowed(ctx: Pick<WorkCtx, 'settings'>, scope: Pick<WorkScope, 'workspaceId'>): boolean {
  const s = vmState()
  if (!scope.workspaceId || !s) return false
  if (s.cannot || s.state === 'none') return false
  try {
    return ctx.settings.workspace(scope.workspaceId).windowsVm === true
  } catch {
    return false
  }
}

/** Whether the VM has Office, as last read: a thread's file tools go there only then. */
export const vmHasOffice = (ctx: Pick<WorkCtx, 'db'>): boolean => storedStatus(ctx.db)?.status.office.installed === true

/** Wakes the machine and makes the helper ready: what a tool call does before it runs in the VM. */
export async function vmAwake(): Promise<void> {
  await vmHelper().open()
}
