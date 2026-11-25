import { afterEach, describe, expect, it } from 'vitest'
import type { ComputerSessionRow } from '@shared/contract-computer'
import type { WinvmState } from '@shared/contract-work-winvm'
import { configureComputerDrive, configureDriveSessions, driveComputer } from '../../computer/drive'
import { configureVmClipboard, VM_NO_WINDOW, vmWheel, WORK_OFF } from './drive'
import { VmLease } from './lease'
import { VM_COMPUTER } from './picture'

/** His Take over of the Windows VM: the `vm` hook over a fake keeper and picture, through computer/drive.ts. */

const row = (threadId: string): ComputerSessionRow => ({ threadId, since: 1, lastCallAt: 1, apps: [], running: null, tier: null, computer: VM_COMPUTER })

function setup(o: { state?: WinvmState['state']; windowless?: boolean; keeper?: boolean; wake?: () => Promise<void> } = {}) {
  const log: string[] = []
  let driving = false
  const picture = {
    driving: () => driving,
    windowless: () => !!o.windowless,
    handBack: null as (() => void) | null,
    setDriving(on: boolean, handBack?: () => void) {
      driving = on
      this.handBack = handBack ?? null
      log.push(`picture ${on}`)
    }
  }
  let state: WinvmState['state'] = o.state ?? 'awake'
  const keeper = {
    state: () => ({ state }) as WinvmState,
    setDriving: (on: boolean) => void log.push(`keeper ${on}`),
    wake: async () => {
      log.push('wake')
      if (state === 'none') throw new Error('The Windows VM is not set up.')
      await o.wake?.()
      state = 'awake'
      return { state } as WinvmState
    }
  }
  const woken: string[] = []
  const lease = new VmLease({ pane: (id) => id, title: (id) => id, wake: (id) => void woken.push(id) })
  let sessions = [row('t1'), row('t2')]
  const stopped: string[] = []
  configureDriveSessions({
    sessions: () => ({ sessions: [...sessions, { ...row('browser-thread'), computer: 'browser:p' }] }),
    stop: async (id) => {
      stopped.push(id)
      sessions = sessions.filter((r) => r.threadId !== id)
      return { stopped: true }
    }
  })
  configureComputerDrive('vm', vmWheel({ picture, lease, keeper: () => (o.keeper === false ? null : keeper), sessions: () => sessions, log: (l) => log.push(l) }))
  return { picture, lease, log, stopped, woken, take: () => driveComputer('vm:windows', 'owner', () => {}), back: () => driveComputer('vm:windows', 'agent', () => {}) }
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))
function later(): { promise: Promise<void>; resolve: () => void; reject: (err: Error) => void } {
  let resolve!: () => void
  let reject!: (err: Error) => void
  const promise = new Promise<void>((res, rej) => ((resolve = res), (reject = rej)))
  return { promise, resolve, reject }
}

afterEach(() => {
  configureComputerDrive('vm', null)
  configureDriveSessions(null)
  configureVmClipboard(null)
})

describe("his Take over of the Windows VM", () => {
  it('gives him the wheel first, then stops every thread on the VM and nothing else', async () => {
    const t = setup()
    expect(await t.take()).toEqual({ computer: VM_COMPUTER, driver: 'owner' })
    expect(t.log).toEqual(['keeper true', 'picture true'])
    expect(t.stopped.sort()).toEqual(['t1', 't2'])
    // every thread's call is refused while he drives
    expect(t.lease.owns()).toBe(true)
    expect(t.lease.take('t3')).toMatch(/He is driving the Windows VM/)
  })

  it('hands back: his keys let go, the keeper and the lease freed, and a thread turned away woken', async () => {
    const t = setup()
    await t.take()
    t.lease.take('t3')
    expect(await t.back()).toEqual({ computer: VM_COMPUTER, driver: 'agent' })
    expect(t.log.slice(2)).toEqual(['picture false', 'keeper false'])
    expect(t.lease.owns()).toBe(false)
    expect(t.woken).toEqual(['t3'])
  })

  it('keeps the guest clipboard at Take over and puts it back at Hand back, where B9 set how', async () => {
    const t = setup()
    const said: string[] = []
    configureVmClipboard({ save: async () => void said.push('save'), restore: async () => void said.push('restore') })
    await t.take()
    await t.back()
    expect(said).toEqual(['save', 'restore'])
    // one that fails is said in the log and stops nothing
    configureVmClipboard({ save: async () => Promise.reject(new Error('no door')), restore: async () => {} })
    await t.take()
    expect(t.log.at(-1)).toMatch(/clipboard was not kept: no door/)
  })

  it('wakes a sleeping machine, then takes over: one press whatever its state', async () => {
    const t = setup({ state: 'asleep' })
    expect(await t.take()).toEqual({ computer: VM_COMPUTER, driver: 'owner' })
    await tick()
    expect(t.log).toEqual(['keeper true', 'wake', 'picture true'])
    await expect(setup({ state: 'none' }).take()).rejects.toThrow(/not set up/)
  })

  it("answers at once and gives him the picture when the wake ends, however long it takes: no caller's deadline decides", async () => {
    const woke = later()
    const t = setup({ state: 'asleep', wake: () => woke.promise })
    expect(await t.take()).toEqual({ computer: VM_COMPUTER, driver: 'owner' })
    // he holds the wheel from the press: no thread takes the machine as it wakes, and its sessions are stopped
    expect(t.lease.owns()).toBe(true)
    expect(t.stopped.sort()).toEqual(['t1', 't2'])
    expect(t.picture.driving()).toBe(false)
    woke.resolve()
    await tick()
    expect(t.picture.driving()).toBe(true)
  })

  it('lets the wheel go when the wake fails, and gives no picture to a Hand back made while it woke', async () => {
    const failed = later()
    const t = setup({ state: 'asleep', wake: () => failed.promise })
    await t.take()
    failed.reject(new Error('Windows did not start'))
    await tick()
    expect(t.lease.owns()).toBe(false)
    expect(t.log).toContain('winvm: Take over after the wake failed: Windows did not start')
    const woke = later()
    const u = setup({ state: 'asleep', wake: () => woke.promise })
    await u.take()
    await u.back()
    woke.resolve()
    await tick()
    expect(u.picture.driving()).toBe(false)
    expect(u.lease.owns()).toBe(false)
  })

  it('wakes the thread he took it from when he hands back', async () => {
    const t = setup()
    t.lease.take('t1')
    await t.take()
    expect(t.woken).toEqual([])
    await t.back()
    expect(t.woken).toEqual(['t1'])
  })

  it('is refused with no window, with Work off, and for another VM', async () => {
    await expect(setup({ windowless: true }).take()).rejects.toThrow(VM_NO_WINDOW)
    await expect(setup({ keeper: false }).take()).rejects.toThrow(WORK_OFF)
    setup()
    await expect(driveComputer('vm:linux', 'owner')).rejects.toThrow(/no computer vm:linux/)
  })

  it('hands back by itself when the machine leaves awake under him', async () => {
    const t = setup()
    await t.take()
    t.picture.handBack?.()
    await new Promise((r) => setTimeout(r, 0))
    expect(t.picture.driving()).toBe(false)
    expect(t.lease.owns()).toBe(false)
  })
})
