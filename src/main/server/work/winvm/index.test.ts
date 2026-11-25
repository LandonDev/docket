import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { METHOD_CAPABILITY } from '@shared/capabilities'
import type { WinvmPoint, WinvmSettings, WinvmState } from '@shared/contract-work-winvm'
import { makeRig, type Rig } from '../outbox/rig'
import type { DoorLink, KeeperDeps } from './keeper'
import { WinvmRequestSchemas } from '@shared/contract-work-winvm'
import { vmClipboardWired } from './drive'
import { vmPasteWired } from './picture'
import { HELD } from './keeper'
import { configureVmStill, type VmStill } from './still'
import { configureVmHeld, configureWinvmDesktop, configureWinvmKeeper, detailSetting, NOT_A_PERSON, screenSetting, screenSize, setSleepAfter, sleepAfterSetting, winvm, winvmKeeper } from './index'

/**
 * The pillar on a real database through the Work router, over a fake
 * machine and guest: its methods, who may call them, the push on every
 * change, and the setting in the host settings.
 */

let rig: Rig
const machine = { disk: true, up: false, device: 'vga' as 'vga' | 'virtio' }
let kept: WinvmPoint[] = []

function fakeDeps(ctx: Parameters<Parameters<typeof configureWinvmKeeper>[0] & object>[0]): Omit<KeeperDeps, 'push'> {
  let token: string | null = 't'.repeat(64)
  return {
    machine: {
      cannot: () => null,
      hasDisk: () => machine.disk,
      running: () => machine.up,
      makeDisk: async () => void (machine.disk = true),
      start: async () => void (machine.up = true),
      stopped: async () => !machine.up,
      keepTpm: async () => {}
    },
    guest: {
      ready: async () => {},
      admin: async (script) => (script.includes('Win32_VideoController') ? (machine.device === 'virtio' ? 'Red Hat VirtIO GPU DOD controller' : 'Microsoft Basic Display Adapter') : 'setup done'),
      hibernate: async () => void (machine.up = false),
      reboot: async () => {},
      shutdown: async () => void (machine.up = false),
      serviceHash: async () => 'h',
      installService: async () => '0.1.0',
      startService: async () => {},
      openDoor: async (): Promise<DoorLink> => ({ close: () => {}, closed: new Promise(() => {}) }),
      knock: async () => true,
      fetch: async () => {},
      send: async () => {},
      upload: async () => {}
    },
    serviceExe: () => '/box/tc-computer.exe',
    hashFile: () => 'h',
    token: { get: () => token, set: (t) => (token = t) },
    doorSocket: '/run/door.sock',
    // the real host setting, as realKeeperDeps keeps it
    sleepAfter: () => sleepAfterSetting(ctx.db),
    setSleepAfter: (v) => setSleepAfter(ctx.db, v),
    points: {
      list: () => [...kept].sort((a, b) => b.at - a.at),
      save: async (p) => void kept.push(p),
      restore: async () => {},
      remove: async (id) => void (kept = kept.filter((p) => p.id !== id))
    },
    log: () => {},
    display: {
      device: () => machine.device,
      setDevice: (d) => void (machine.device = d),
      screen: () => null,
      setScreen: () => {},
      // the real host settings, as realKeeperDeps reads them
      choice: () => ({ screen: screenSetting(ctx.db), detail: detailSetting(ctx.db) }),
      driver: async () => '/box/viogpudo',
      cursor: () => '/app/resources/winvm/tc-ibeam.cur'
    }
  }
}

const workCtx = () => (rig.work as unknown as { ctx: Parameters<NonNullable<typeof winvm.handle>>[1] }).ctx
const model = { kind: 'model', caps: [], sessionId: 't-work' } as const
const states = () => rig.pushes.filter((p) => p.push === 'work.winvm').map((p) => (p as { state: WinvmState }).state.state)

beforeEach(async () => {
  machine.disk = true
  machine.up = false
  machine.device = 'vga'
  kept = []
  configureWinvmKeeper(fakeDeps)
  rig = await makeRig({ modules: [winvm] })
})
afterEach(async () => {
  await rig.close()
  configureWinvmKeeper(null)
})

describe('the Windows VM pillar', () => {
  it('reads its state, wakes and sleeps it, pushing work.winvm on every change', async () => {
    expect((await rig.rpc<WinvmState>('work.winvm.state', {})).state).toBe('asleep')
    expect((await rig.rpc<WinvmState>('work.winvm.wake', {})).state).toBe('awake')
    expect((await rig.rpc<WinvmState>('work.winvm.sleep', {})).state).toBe('asleep')
    expect(states()).toEqual(['waking', 'awake', 'going-to-sleep', 'asleep'])
  })

  it('setup answers at once and its end comes as a push', async () => {
    machine.disk = false
    await rig.rpc<WinvmState>('work.winvm.setup', {})
    await new Promise((r) => setTimeout(r, 20))
    expect(states()[0]).toBe('setting-up')
    expect(states().at(-1)).toBe('awake')
  })

  it('keeps sleep-after in the host settings, 30 minutes until he sets it', async () => {
    expect(await rig.rpc<WinvmSettings>('work.winvm.settings', {})).toEqual({ sleepAfter: '30m', screen: 'fit', detail: 'sharp' })
    expect(await rig.rpc<WinvmSettings>('work.winvm.settings', { sleepAfter: '2h' })).toEqual({ sleepAfter: '2h', screen: 'fit', detail: 'sharp' })
    expect(sleepAfterSetting(workCtx().db)).toBe('2h')
    expect((await rig.rpc<WinvmState>('work.winvm.state', {})).sleepAfter).toBe('2h')
  })

  it('keeps the screen and its detail in the host settings, Fit and Sharp until he picks, and the state says them', async () => {
    expect(await rig.rpc<WinvmSettings>('work.winvm.settings', { screen: '1920x1200' })).toEqual({ sleepAfter: '30m', screen: '1920x1200', detail: 'sharp' })
    expect(screenSetting(workCtx().db)).toBe('1920x1200')
    expect(screenSize(screenSetting(workCtx().db))).toEqual({ width: 1920, height: 1200 })
    // Fit starts a new machine at the std VGA's own size
    expect(screenSize('fit')).toEqual({ width: 1280, height: 800 })
    expect(screenSize('2560x1600')).toEqual({ width: 2560, height: 1600 })
    rig.pushes.length = 0
    expect(await rig.rpc<WinvmSettings>('work.winvm.settings', { screen: 'fit', detail: 'faster' })).toMatchObject({ screen: 'fit', detail: 'faster' })
    expect(detailSetting(workCtx().db)).toBe('faster')
    const pushed = rig.pushes.filter((p) => p.push === 'work.winvm').map((p) => (p as { state: WinvmState }).state.display)
    expect(pushed.at(-1)).toMatchObject({ device: 'vga', fit: true, detail: 'faster', canResize: false })
    // the wire offers Fit and the three sizes, Sharp and Faster, no other
    const settings = WinvmRequestSchemas.find((r) => r.shape.method.value === 'work.winvm.settings')!
    const parses = (params: object) => settings.safeParse({ id: '1', method: 'work.winvm.settings', params }).success
    expect(parses({ screen: '2560x1600', detail: 'sharp' })).toBe(true)
    expect(parses({ screen: '3840x2400' })).toBe(false)
    expect(parses({ detail: 'blurry' })).toBe(false)
  })

  it('turns live resize on and off for a person: the answer at once, the steps as pushes; refused for a thread and while one holds it', async () => {
    await rig.rpc('work.winvm.wake', {})
    rig.pushes.length = 0
    await rig.rpc<WinvmState>('work.winvm.display.upgrade', {})
    await new Promise((r) => setTimeout(r, 20))
    const pushed = rig.pushes.filter((p) => p.push === 'work.winvm').map((p) => (p as { state: WinvmState }).state)
    expect(pushed[0]).toMatchObject({ state: 'setting-up', step: 'Getting the display driver' })
    expect(pushed.at(-1)).toMatchObject({ state: 'awake', display: { device: 'virtio', canResize: true } })
    expect(machine.device).toBe('virtio')
    await rig.rpc('work.winvm.display.downgrade', {})
    await new Promise((r) => setTimeout(r, 20))
    expect(machine.device).toBe('vga')
    configureVmHeld(() => true)
    await expect(rig.rpc('work.winvm.display.upgrade', {})).rejects.toThrow(HELD)
    configureVmHeld(null)
    for (const m of ['work.winvm.display.upgrade', 'work.winvm.display.downgrade']) {
      await expect(winvm.handle!({ id: '1', method: m, params: {} } as never, workCtx(), model)).rejects.toThrow(NOT_A_PERSON)
      expect(METHOD_CAPABILITY[m as 'work.winvm.display.upgrade']).toBe('admin')
    }
  })

  it('a model caller may wake it but not set it up, put it to sleep or change its settings', async () => {
    const call = (method: string, params: unknown = {}) => winvm.handle!({ id: '1', method, params } as never, workCtx(), model)
    for (const m of ['work.winvm.setup', 'work.winvm.sleep', 'work.winvm.settings', 'work.winvm.point.save']) await expect(call(m)).rejects.toThrow(NOT_A_PERSON)
    for (const m of ['work.winvm.point.restore', 'work.winvm.point.delete']) await expect(call(m, { id: 'abcdef' })).rejects.toThrow(NOT_A_PERSON)
    expect(await call('work.winvm.points')).toMatchObject({ handled: true })
    expect(await call('work.winvm.wake')).toMatchObject({ handled: true })
  })

  it('declares a capability for each method: reading, waking and sleeping for an operator, setup and settings for an admin', () => {
    expect(METHOD_CAPABILITY['work.winvm.state']).toBe('read')
    expect(METHOD_CAPABILITY['work.winvm.wake']).toBe('operate')
    expect(METHOD_CAPABILITY['work.winvm.sleep']).toBe('operate')
    expect(METHOD_CAPABILITY['work.winvm.setup']).toBe('admin')
    expect(METHOD_CAPABILITY['work.winvm.settings']).toBe('admin')
    expect(METHOD_CAPABILITY['work.winvm.points']).toBe('read')
    expect(METHOD_CAPABILITY['work.winvm.point.save']).toBe('operate')
    expect(METHOD_CAPABILITY['work.winvm.point.restore']).toBe('admin')
    expect(METHOD_CAPABILITY['work.winvm.point.delete']).toBe('admin')
  })

  it('saves, lists, goes back to and deletes restore points while it sleeps, pushing the list', async () => {
    const p = await rig.rpc<WinvmPoint>('work.winvm.point.save', { name: 'Clean' })
    expect(p).toMatchObject({ name: 'Clean', by: 'owner' })
    expect((await rig.rpc<{ points: WinvmPoint[] }>('work.winvm.points', {})).points.map((x) => x.id)).toEqual([p.id])
    expect((await rig.rpc<WinvmState>('work.winvm.point.restore', { id: p.id })).state).toBe('asleep')
    expect((await rig.rpc<{ points: WinvmPoint[] }>('work.winvm.point.delete', { id: p.id })).points).toEqual([])
    const lists = rig.pushes.filter((x) => x.push === 'work.winvm.points').map((x) => (x as { points: WinvmPoint[] }).points.length)
    expect(lists).toEqual([1, 0])
    await rig.rpc('work.winvm.wake', {})
    await expect(rig.rpc('work.winvm.point.save', {})).rejects.toThrow('only while the Windows VM sleeps')
  })

  it('the keeper the VM service will use is there while Work is on, and gone when it turns off', async () => {
    expect(winvmKeeper()).not.toBeNull()
    await rig.close()
    expect(winvmKeeper()).toBeNull()
    rig = await makeRig({ modules: [winvm] })
  })
})

describe('the Computers page: the still, Sleep and Restart', () => {
  afterEach(() => {
    configureVmStill(null)
    configureVmHeld(null)
    configureWinvmDesktop(null)
  })

  it('keeps the picture as it goes to sleep, and gives it to whoever may watch the VM: never a thread or the box\'s own socket', async () => {
    let kept = 0
    const picture = { data: 'AAAA', width: 1920, height: 1200, at: 7 }
    configureVmStill({ keep: async () => void kept++, read: () => (kept ? picture : null) } as unknown as VmStill)
    await rig.rpc('work.winvm.wake', {})
    await rig.rpc('work.winvm.sleep', {})
    expect(kept).toBe(1)
    const call = (by: Parameters<NonNullable<typeof winvm.handle>>[2]) => winvm.handle!({ id: '1', method: 'work.winvm.still', params: {} } as never, workCtx(), by)
    expect(await call({ kind: 'remote', caps: ['read', 'approve'], audience: 'client', keyId: 'k' })).toMatchObject({ handled: true, result: { still: picture } })
    await expect(call({ kind: 'remote', caps: ['read'], audience: 'client', keyId: 'k' })).rejects.toThrow('needs approve')
    await expect(call(model)).rejects.toThrow('not a thread')
    // the box's own socket is any process of its user, not his desktop
    configureWinvmDesktop(() => false)
    await expect(rig.rpc('work.winvm.still', {})).rejects.toThrow("own socket")
    configureWinvmDesktop(() => true)
    expect(await rig.rpc('work.winvm.still', {})).toEqual({ still: picture })
    // a person's Sleep holds it asleep for his Wake
    expect((await rig.rpc<WinvmState>('work.winvm.state', {})).heldAsleep).toBe(true)
  })

  it('restarts Windows for a person, never for a thread, and not while a thread holds it', async () => {
    await rig.rpc('work.winvm.wake', {})
    expect((await rig.rpc<WinvmState>('work.winvm.restart', {})).state).toBe('awake')
    configureVmHeld(() => true)
    await expect(rig.rpc('work.winvm.restart', {})).rejects.toThrow(HELD)
    await expect(winvm.handle!({ id: '1', method: 'work.winvm.restart', params: {} } as never, workCtx(), model)).rejects.toThrow(NOT_A_PERSON)
    expect(METHOD_CAPABILITY['work.winvm.restart']).toBe('operate')
    expect(METHOD_CAPABILITY['work.winvm.still']).toBe('read')
  })
})

describe("his paste and the guest's clipboard", () => {
  it("are wired while the pillar runs and let go when it stops", async () => {
    // the rig above started the pillar
    expect(vmPasteWired()).toBe(true)
    expect(vmClipboardWired()).toBe(true)
    // a start's stop lets both go
    const stop = winvm.start!(workCtx() as never) as () => void
    stop()
    expect(vmPasteWired()).toBe(false)
    expect(vmClipboardWired()).toBe(false)
  })
})
