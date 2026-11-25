import { join } from 'node:path'
import type { ComputerSessionRow } from '@shared/contract-computer'
import type { ComputerSessions } from '../../computer/sessions'
import type { VideoRelay } from '../../video/relay'
import type { VideoRpc } from '../../video/rpc'
import { configureVmHeld, winvmKeeper, onWinvmState } from './index'
import { configureVmStill, VmStill } from './still'
import { rigConfig, rigPaths } from './machine/config'
import { qmp, screendump } from './machine/qmp'
import { configureComputerDrive } from '../../computer/drive'
import { vmWheel } from './drive'
import type { VmLease } from './lease'
import { electronJpeg, qmpScreenshot, VM_COMPUTER, VmPicture } from './picture'
import { vmScreen } from './window'
import { readMachineDevice, watchGuestScreen } from './guestScreen'
import { VmDisplay } from './display'
import { guestDisplay } from './door'
import { vmHost } from './vm'

type Rows = Pick<ComputerSessions, 'rows' | 'onRows' | 'stop'>

/**
 * The Windows VM's picture on the box's host (index.ts): its video source
 * beside the box browser's, its row beside the box browser's rows, and its
 * 4 fps picture beside theirs. Wired once at boot on a Linux host; the
 * machine itself is the Work pillar's (index.ts here).
 */
export function wireVmPicture(o: {
  dataDir: string
  video: { relay: VideoRelay; rpc: Pick<VideoRpc, 'addSource'> }
  /** the thread that holds the machine (the lease's), which titles its idle row */
  holder?: () => string | null
  log?: (line: string) => void
}): VmPicture {
  const p = rigPaths(rigConfig(process.env, undefined, 'standing'))
  const screen = vmScreen(o.dataDir, o.log)
  // the guest follows his picture's room on virtio-gpu: one change at a time, through the door (display.ts)
  const display = new VmDisplay({
    run: p.run,
    guest: () =>
      guestDisplay(() => {
        const host = vmHost()
        if (!host) throw new Error('the Windows VM is not on this host')
        return host.service
      }),
    screen,
    relay: o.video.relay,
    isVm: (s) => s.tag === VM_COMPUTER,
    log: o.log
  })
  const device = () => readMachineDevice(p.run)
  const picture = new VmPicture({
    state: () => winvmKeeper()?.state() ?? null,
    onState: onWinvmState,
    setViewers: (n) => winvmKeeper()?.setViewers(n),
    screen,
    hardwareCursor: () => readMachineDevice(p.run) === 'virtio',
    relay: o.video.relay,
    screenshot: qmpScreenshot(join(o.dataDir, 'winvm', 'picture', 'shots'), async (file) => void (await qmp(p.qmp, screendump(file)))),
    jpeg: electronJpeg,
    ...(o.holder ? { holder: o.holder } : {}),
    display,
    device,
    log: o.log
  })
  o.video.rpc.addSource(picture)
  // the desk as he left it, kept at each sleep for the page (still.ts); his Restart waits for a thread that holds it
  configureVmStill(new VmStill({ dir: join(o.dataDir, 'winvm', 'picture'), screenshot: qmpScreenshot(join(o.dataDir, 'winvm', 'picture', 'still-shots'), async (file) => void (await qmp(p.qmp, screendump(file)))), jpeg: electronJpeg }))
  configureVmHeld(() => !!o.holder?.())
  // QEMU's display at the size Windows draws at, learned after every wake
  watchGuestScreen({
    onState: onWinvmState,
    keeper: winvmKeeper,
    shown: () => screen.size,
    run: p.run,
    free: () => !picture.driving() && !o.holder?.(),
    device,
    follow: (size) => display.follow(size),
    log: o.log
  })
  return picture
}

/**
 * His Take over of the VM through `computer.drive` (drive.ts): the `vm` kind's hook, for the host's whole life, so
 * a Take over while Work is off is refused in words rather than unknown.
 */
export function wireVmDrive(o: { picture: VmPicture; lease: Pick<VmLease, 'ownerDrives'>; sessions: Pick<Rows, 'rows'>; log?: (line: string) => void }): void {
  configureComputerDrive('vm', vmWheel({ picture: o.picture, lease: o.lease, keeper: winvmKeeper, sessions: () => o.sessions.rows(), log: o.log }))
}

/**
 * The VM's rows for the host's Computers: his own while he drives it; else the sessions of the threads that drive it
 * (vm.ts) while there are any, else the VM's own idle row while it is awake (picture.ts). Every one says
 * `pictureOnly` while the VM has no window. Stop goes to the sessions; his row and the idle row have nothing to stop.
 */
export function joinRows(sessions: Rows, vm: Pick<VmPicture, 'rows' | 'onRows' | 'stop' | 'windowless' | 'driving'>): Rows {
  const all = (): ComputerSessionRow[] => {
    const driven = vm.driving() ? [] : sessions.rows()
    const rows = driven.length ? driven : vm.rows()
    return vm.windowless() ? rows.map((r) => ({ ...r, pictureOnly: true as const })) : rows
  }
  return {
    rows: all,
    onRows: (fn) => {
      const a = sessions.onRows(() => fn(all()))
      const b = vm.onRows(() => fn(all()))
      return () => {
        a()
        b()
      }
    },
    stop: async (threadId) => (sessions.rows().some((r) => r.threadId === threadId) ? sessions.stop(threadId) : vm.stop())
  }
}
