import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { METHOD_CAPABILITY } from '@shared/capabilities'
import type { WinvmPoint, WinvmSettings, WinvmState } from '@shared/contract-work-winvm'
import { makeRig, type Rig } from '../outbox/rig'
import type { DoorLink, KeeperDeps } from './keeper'
import { configureWinvmKeeper, NOT_A_PERSON, setSleepAfter, sleepAfterSetting, winvm, winvmKeeper } from './index'

/**
 * The pillar on a real database through the Work router, over a fake
 * machine and guest: its methods, who may call them, the push on every
 * change, and the setting in the host settings.
 */

let rig: Rig
const machine = { disk: true, up: false }
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
      admin: async () => 'setup done',
      hibernate: async () => void (machine.up = false),
      reboot: async () => {},
      serviceHash: async () => 'h',
      installService: async () => '0.1.0',
      startService: async () => {},
      openDoor: async (): Promise<DoorLink> => ({ close: () => {}, closed: new Promise(() => {}) }),
      knock: async () => true,
      fetch: async () => {}
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
    log: () => {}
  }
}

const workCtx = () => (rig.work as unknown as { ctx: Parameters<NonNullable<typeof winvm.handle>>[1] }).ctx
const model = { kind: 'model', caps: [], sessionId: 't-work' } as const
const states = () => rig.pushes.filter((p) => p.push === 'work.winvm').map((p) => (p as { state: WinvmState }).state.state)

beforeEach(async () => {
  machine.disk = true
  machine.up = false
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
    expect(await rig.rpc<WinvmSettings>('work.winvm.settings', {})).toEqual({ sleepAfter: '30m' })
    expect(await rig.rpc<WinvmSettings>('work.winvm.settings', { sleepAfter: '2h' })).toEqual({ sleepAfter: '2h' })
    expect(sleepAfterSetting(workCtx().db)).toBe('2h')
    expect((await rig.rpc<WinvmState>('work.winvm.state', {})).sleepAfter).toBe('2h')
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
