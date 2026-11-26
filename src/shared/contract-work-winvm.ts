import { z } from 'zod'
import { request, type CapsOf, type RelayOf } from './work/wire'

/**
 * The Windows VM's wire (docs/agents/work-winvm.md): the keeper of the box's
 * standing Windows machine. Its methods are `work.winvm.<verb>` and its push
 * `work.winvm`, sent on every change of state.
 *
 * - `none`: not set up here (or this host cannot run it: `cannot` says why)
 * - `setting-up`: the disk is being made and the guest set up
 * - `asleep`: hibernated, or stopped; the next use wakes it
 * - `waking`: starting, the service checked and the door knocked
 * - `awake`: running, the door open through the keeper's SSH forward
 * - `going-to-sleep`: Windows was asked to hibernate
 */
export const WINVM_STATES = ['none', 'setting-up', 'asleep', 'waking', 'awake', 'going-to-sleep'] as const
export type WinvmStateName = (typeof WINVM_STATES)[number]

/** How long the machine stays awake with no thread's call, no viewer and him not driving. */
export const WINVM_SLEEP_AFTER = ['15m', '30m', '2h', 'never'] as const
export type WinvmSleepAfter = (typeof WINVM_SLEEP_AFTER)[number]

/**
 * The guest's screen: Fit to window (the size follows his picture's room while he drives, live resize alone), or
 * one size of its pixels: the std VGA's own 1280×800, 1920×1200 (the dragged-window scene measured 51.7 frames a
 * second there, over the 45 that offers it; live-video.md "The Windows VM") or 2560×1600. On std VGA a size is
 * used by a new Set up: Windows keeps the size it was set up at through every sleep.
 */
export const WINVM_SCREENS = ['fit', '1280x800', '1920x1200', '2560x1600'] as const
export type WinvmScreen = (typeof WINVM_SCREENS)[number]

/** Sharp: Windows at 200% on twice the points' pixels; Faster: at 100%, one pixel a point (guestSize.ts). */
export const WINVM_DETAILS = ['sharp', 'faster'] as const
export type WinvmDetail = (typeof WINVM_DETAILS)[number]

/**
 * The guest's display device (docs/agents/work-winvm.md "The picture"): `vga`, QEMU's std VGA under Windows' Basic
 * Display Driver, one size until a cold boot; `virtio`, virtio-vga under Red Hat's viogpudo, any size while it runs
 * (live resize). Named by the run's machine.json; a machine with none is `vga`.
 */
export type WinvmDevice = 'vga' | 'virtio'

/** The guest's screen as the keeper knows it now, and the choice he made. */
export interface WinvmDisplay {
  device: WinvmDevice
  /** the size Windows draws at now, in its pixels */
  width: number
  height: number
  /** Windows' scale, in percent */
  scale: number
  /** the choice is Fit to window */
  fit: boolean
  detail: WinvmDetail
  /** Windows takes a new size while it runs: live resize is on */
  canResize: boolean
}

/**
 * What the row says while live resize is turned on, a step at a time (the keeper's `upgrade`, "The standing VM"
 * in the plan): the driver fetched on the box, staged in Windows, a clean shutdown, the restore point, the start on
 * virtio-vga, the hardware pointer. Turn off says `restart` and `startVga`; a failed start goes back to the point.
 */
export const LIVE_RESIZE_WORDS = {
  driver: 'Getting the display driver',
  stage: 'Adding the display driver to Windows',
  restart: 'Restarting Windows',
  point: 'Saving a restore point',
  start: 'Starting Windows with live resize',
  cursor: 'Turning on the pointer',
  startVga: 'Starting Windows',
  back: 'Going back to the restore point'
} as const

/** What a call that wakes the machine waits with, and what the state says meanwhile. */
export const WAKING_WORDS = 'Waking the Windows VM'
/** The wake the keeper makes by itself after a restart of the box's service, when the machine was awake at the stop. */
export const WAKING_AFTER_UPDATE_WORDS = 'Waking after an update…'

export interface WinvmState {
  state: WinvmStateName
  /** what it is doing now, in a few words ("Waking the Windows VM", "Copying the service in"); null when settled */
  step: string | null
  /** the last thing that went wrong, in words; null when the last change went through */
  error: string | null
  /** why this host cannot have the VM at all (no base image, not the box); null when it can */
  cannot: string | null
  /** why no wake or setup can go through on this build (it has no service to copy in): the page says it and asks for none; null when one can, absent from a host before it */
  blocked?: string | null
  sleepAfter: WinvmSleepAfter
  /** when `state` last changed */
  since: number
  /** the usual wake, in ms: the median of the last five; null before one (the page's "6 s of about 13") */
  wakeMs?: number | null
  /** asleep by a person's Sleep: the page waits for his Wake rather than waking it by itself */
  heldAsleep?: boolean
  /** the guest's screen; absent from a host before live resize, and while it is not set up */
  display?: WinvmDisplay
}

/**
 * A restore point: the disk's snapshot taken while the machine slept, with its firmware variables and its
 * TPM's state beside it. `by`: his press, or the keeper's own before it changed the guest's setup.
 */
export interface WinvmPoint {
  id: string
  name: string
  at: number
  by: 'owner' | 'keeper'
  /** the device and size the machine had at the save, written back by a restore; a point from before live resize has neither and is `vga` at 1280×800 */
  device?: WinvmDevice
  screen?: { width: number; height: number }
}

/** The guest's screen as it was when it last went to sleep: a JPEG, base64, at most 1920 on its long edge. */
export interface WinvmStill {
  data: string
  width: number
  height: number
  at: number
}

/** The Windows evaluation the base image was built from ends about this day (docs/agents/windows-vm.md); after it, a real key or a rebuild. */
export const WINVM_EVALUATION_ENDS = '2027-02-17'

/** How many restore points are kept: a new one past this drops the oldest. */
export const WINVM_POINTS_KEPT = 3

export interface WinvmSettings {
  sleepAfter: WinvmSleepAfter
  screen: WinvmScreen
  detail: WinvmDetail
}

export const WinvmRequestSchemas = [
  /** → WinvmState */
  request('work.winvm.state', z.object({})),
  /** → WinvmState once it is awake: a thread's first call or his Wake press. Waits about 13 s from hibernate, 20 to 26 s cold. */
  request('work.winvm.wake', z.object({})),
  /** → WinvmState once it sleeps: Windows hibernates, its apps and sign-ins kept for the next wake. A person's alone. */
  request('work.winvm.sleep', z.object({})),
  /** → WinvmState: makes the disk from the base image and sets the guest up (the service, its logon task, hibernate, the policies). A person's alone. */
  request('work.winvm.setup', z.object({})),
  /** → WinvmSettings, with each given one set; on std VGA a new screen is used by a new Set up. A person's alone. */
  request('work.winvm.settings', z.object({ sleepAfter: z.enum(WINVM_SLEEP_AFTER).optional(), screen: z.enum(WINVM_SCREENS).optional(), detail: z.enum(WINVM_DETAILS).optional() })),
  /** → { still: WinvmStill | null }: the guest's last picture, kept as it went to sleep; to whoever may watch it (`mayWatch`) */
  request('work.winvm.still', z.object({})),
  /** → WinvmState once Windows is back: a clean restart through its own shutdown, never forced; refused while a thread holds it. */
  request('work.winvm.restart', z.object({})),
  /** → { points: WinvmPoint[] }, newest first */
  request('work.winvm.points', z.object({})),
  /** → WinvmPoint: only while it sleeps; past three, the oldest goes. A person's alone. */
  request('work.winvm.point.save', z.object({ name: z.string().trim().min(1).max(80).optional() })),
  /** → WinvmState: the disk, firmware and TPM put back as the point holds them; only while it sleeps. The confirm is the screen's. A person's alone. */
  request('work.winvm.point.restore', z.object({ id: z.string().min(1).max(64) })),
  /** → { points: WinvmPoint[] }: only while it sleeps. A person's alone. */
  request('work.winvm.point.delete', z.object({ id: z.string().min(1).max(64) })),
  /**
   * → WinvmState once Windows runs on virtio-vga (Turn on live resize): the driver staged, a clean shutdown, a restore
   * point, a start on the new device, the hardware pointer; its steps come as pushes. Refused while a thread holds it,
   * while he drives and while a OneDrive write is owed. A person's alone.
   */
  request('work.winvm.display.upgrade', z.object({})),
  /** → WinvmState once Windows runs on std VGA again at 1280×800 (Turn off): a clean shutdown and a start. Refused as upgrade is. A person's alone. */
  request('work.winvm.display.downgrade', z.object({}))
] as const

export type WinvmPush = { push: 'work.winvm'; state: WinvmState } | { push: 'work.winvm.points'; points: WinvmPoint[] }

export const WINVM_CAPS = {
  'work.winvm.state': 'read',
  'work.winvm.wake': 'operate',
  'work.winvm.sleep': 'operate',
  // the same rule as its video: read here, and `mayWatch` in the handler
  'work.winvm.still': 'read',
  'work.winvm.restart': 'operate',
  // changes the machine itself: an admin's
  'work.winvm.setup': 'admin',
  // reads and sets a host setting: an admin's
  'work.winvm.settings': 'admin',
  'work.winvm.points': 'read',
  'work.winvm.point.save': 'operate',
  // each puts the machine back or drops a point for good: an admin's
  'work.winvm.point.restore': 'admin',
  'work.winvm.point.delete': 'admin',
  // each restarts Windows on another display device
  'work.winvm.display.upgrade': 'admin',
  'work.winvm.display.downgrade': 'admin'
} satisfies CapsOf<typeof WinvmRequestSchemas>
export const WINVM_RELAY = {} satisfies RelayOf<typeof WinvmRequestSchemas>
