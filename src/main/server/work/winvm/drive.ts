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
 * whatever its state. While he drives, the keeper keeps the machine awake,
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
  const handBack = async (): Promise<VmDriveAnswer> => {
    if (d.picture.driving()) {
      // every key and button he holds goes first, then the clipboard he may have filled
      d.picture.setDriving(false)
      await keep('restore')
    }
    d.keeper()?.setDriving(false)
    d.lease.ownerDrives(false)
    return { computer: VM_COMPUTER, driver: 'agent' }
  }
  return {
    // every thread's session on the VM: there is one machine, and he takes all of it
    holds: () => (threadId) => d.sessions().some((r) => r.threadId === threadId),
    async drive(id, driver) {
      if (`vm:${id}` !== VM_COMPUTER) throw new Error(unknownComputer(`vm:${id}`))
      if (driver === 'agent') return handBack()
      const keeper = d.keeper()
      if (!keeper) throw new Error(WORK_OFF)
      // asleep, going to sleep or waking: his one press wakes it, then takes over (a VM not set up says so)
      if (keeper.state().state !== 'awake') await keeper.wake()
      if (d.picture.windowless()) throw new Error(VM_NO_WINDOW)
      if (d.picture.driving()) return { computer: VM_COMPUTER, driver: 'owner' }
      d.lease.ownerDrives(true)
      keeper.setDriving(true)
      d.picture.setDriving(true, () => void handBack().catch((err) => d.log?.(`winvm: hand back failed: ${String(err)}`)))
      await keep('save')
      return { computer: VM_COMPUTER, driver: 'owner' }
    }
  }
}
