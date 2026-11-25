import type { ComputerSessionRow } from '@shared/contract-computer'
import { unknownComputer, type ComputerDriveHook, type ComputerDriver } from '../../computer/drive'
import type { Keeper } from './keeper'
import type { VmLease } from './lease'
import { VM_COMPUTER, type VmPicture } from './picture'

/**
 * His Take over of the Windows VM (docs/agents/live-video.md "Driving",
 * work-winvm.md "Take over"): `computer.drive { computer: 'vm:windows' }`
 * through computer/drive.ts, which stops every thread's session on the VM
 * once he has the wheel. A machine asleep is woken first: Take over is one press
 * whatever its state, and it answers at once, since a wake outlasts a caller's
 * deadline (42 s on his box, past a window's 30): he holds the wheel from the
 * press, and the picture is his once Windows is up. While he drives, the keeper keeps the machine awake,
 * the lease refuses every thread's call, and his pointer and keys go down his
 * drive streams: the engine types them on the VM's X display, QEMU's window
 * hands them to the guest as a real keyboard and tablet. Hand back lets every
 * key and button he holds go, puts the guest's clipboard back as it was
 * before he took over (B9), and wakes the threads that were turned away.
 */

export const VM_NO_WINDOW = 'The Windows VM has no window of its own on this host, so it takes no input from the picture.'
export const WORK_OFF = 'Work is off on this host.'

/**
 * The guest's clipboard kept across his Take over (vm.ts `saveClipboard`, `restoreClipboard`, set by the pillar's
 * start): at Take over it is kept, at Hand back it is put back, so nothing he copied is left for a thread. Null
 * while Work is off.
 */
export interface VmClipboard {
  save(): Promise<void>
  restore(): Promise<void>
}
let clipboard: VmClipboard | null = null
export function configureVmClipboard(c: VmClipboard | null): void {
  clipboard = c
}
/** Whether his Take over keeps the guest's clipboard now: the pillar's start set it. */
export const vmClipboardWired = (): boolean => clipboard !== null

export interface VmDriveAnswer {
  computer: typeof VM_COMPUTER
  driver: ComputerDriver
}

export interface VmWheelDeps {
  picture: Pick<VmPicture, 'setDriving' | 'driving' | 'windowless'>
  lease: Pick<VmLease, 'ownerDrives'>
  /** the keeper while Work is on */
  keeper(): Pick<Keeper, 'state' | 'setDriving' | 'wake'> | null
  /** the sessions of the threads that drive the VM now (vm.ts) */
  sessions(): readonly ComputerSessionRow[]
  log?: (line: string) => void
}

export function vmWheel(d: VmWheelDeps): ComputerDriveHook<VmDriveAnswer> {
  const keep = async (what: 'save' | 'restore'): Promise<void> => {
    try {
      await clipboard?.[what]()
    } catch (err) {
      d.log?.(`winvm: the guest's clipboard was not ${what === 'save' ? 'kept' : 'put back'}: ${(err as Error).message}`)
    }
  }
  /** he asked for the wheel and has not handed it back: a wake that ends gives it to him only then */
  let wanted = false
  const handBack = async (): Promise<VmDriveAnswer> => {
    wanted = false
    if (d.picture.driving()) {
      // every key and button he holds goes first, then the clipboard he may have filled
      d.picture.setDriving(false)
      await keep('restore')
    }
    d.keeper()?.setDriving(false)
    d.lease.ownerDrives(false)
    return { computer: VM_COMPUTER, driver: 'agent' }
  }
  const hold = (keeper: Pick<Keeper, 'setDriving'>): void => {
    if (wanted) return
    wanted = true
    d.lease.ownerDrives(true)
    keeper.setDriving(true)
  }
  /** The picture his, on a machine awake. */
  const takeAwake = async (keeper: Pick<Keeper, 'setDriving'>): Promise<VmDriveAnswer> => {
    if (d.picture.windowless()) throw new Error(VM_NO_WINDOW)
    if (d.picture.driving()) return { computer: VM_COMPUTER, driver: 'owner' }
    hold(keeper)
    d.picture.setDriving(true, () => void handBack().catch((err) => d.log?.(`winvm: hand back failed: ${String(err)}`)))
    await keep('save')
    return { computer: VM_COMPUTER, driver: 'owner' }
  }
  return {
    // every thread's session on the VM: there is one machine, and he takes all of it
    holds: () => (threadId) => d.sessions().some((r) => r.threadId === threadId),
    async drive(id, driver) {
      if (`vm:${id}` !== VM_COMPUTER) throw new Error(unknownComputer(`vm:${id}`))
      if (driver === 'agent') return handBack()
      const keeper = d.keeper()
      if (!keeper) throw new Error(WORK_OFF)
      const state = keeper.state().state
      // not set up: the keeper says so at once
      if (state === 'none') await keeper.wake()
      if (state === 'awake') return takeAwake(keeper)
      // asleep, going to sleep or waking: he holds the wheel now, so no thread takes the machine as it wakes, and the
      // picture is his once it is awake (a Hand back meanwhile lets it go); a failed wake says its cause in the state
      hold(keeper)
      void keeper
        .wake()
        .then(() => (wanted ? takeAwake(keeper) : undefined))
        .catch(async (err) => {
          d.log?.(`winvm: Take over after the wake failed: ${(err as Error).message}`)
          await handBack()
        })
        .catch((err) => d.log?.(`winvm: hand back failed: ${String(err)}`))
      return { computer: VM_COMPUTER, driver: 'owner' }
    }
  }
}
