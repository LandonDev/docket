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

/** What a call that wakes the machine waits with, and what the state says meanwhile. */
export const WAKING_WORDS = 'Waking the Windows VM'

export interface WinvmState {
  state: WinvmStateName
  /** what it is doing now, in a few words ("Waking the Windows VM", "Copying the service in"); null when settled */
  step: string | null
  /** the last thing that went wrong, in words; null when the last change went through */
  error: string | null
  /** why this host cannot have the VM at all (no base image, not the box); null when it can */
  cannot: string | null
  sleepAfter: WinvmSleepAfter
  /** when `state` last changed */
  since: number
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
}

/** How many restore points are kept: a new one past this drops the oldest. */
export const WINVM_POINTS_KEPT = 3

export interface WinvmSettings {
  sleepAfter: WinvmSleepAfter
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
  /** → WinvmSettings, with `sleepAfter` set when given. A person's alone. */
  request('work.winvm.settings', z.object({ sleepAfter: z.enum(WINVM_SLEEP_AFTER).optional() })),
  /** → { points: WinvmPoint[] }, newest first */
  request('work.winvm.points', z.object({})),
  /** → WinvmPoint: only while it sleeps; past three, the oldest goes. A person's alone. */
  request('work.winvm.point.save', z.object({ name: z.string().trim().min(1).max(80).optional() })),
  /** → WinvmState: the disk, firmware and TPM put back as the point holds them; only while it sleeps. The confirm is the screen's. A person's alone. */
  request('work.winvm.point.restore', z.object({ id: z.string().min(1).max(64) })),
  /** → { points: WinvmPoint[] }: only while it sleeps. A person's alone. */
  request('work.winvm.point.delete', z.object({ id: z.string().min(1).max(64) }))
] as const

export type WinvmPush = { push: 'work.winvm'; state: WinvmState } | { push: 'work.winvm.points'; points: WinvmPoint[] }

export const WINVM_CAPS = {
  'work.winvm.state': 'read',
  'work.winvm.wake': 'operate',
  'work.winvm.sleep': 'operate',
  // changes the machine itself: an admin's
  'work.winvm.setup': 'admin',
  // reads and sets a host setting: an admin's
  'work.winvm.settings': 'admin',
  'work.winvm.points': 'read',
  'work.winvm.point.save': 'operate',
  // each puts the machine back or drops a point for good: an admin's
  'work.winvm.point.restore': 'admin',
  'work.winvm.point.delete': 'admin'
} satisfies CapsOf<typeof WinvmRequestSchemas>
export const WINVM_RELAY = {} satisfies RelayOf<typeof WinvmRequestSchemas>
