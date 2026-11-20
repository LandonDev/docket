import { spawn as nodeSpawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WAKING_WORDS, type WinvmState, type WinvmStateName } from '@shared/contract-work-winvm'
import type { SessionMeta, SessionStatus } from '@shared/events'
import type { WorkScope, WorkToolResult } from '@shared/work'
import { computerHarness } from '../../computer/runHarness'
import { fakeServiceBin, ManualClock } from '../../computer/testFake'
import { REFUSE_SESSION_TIER } from '../../computer/tierGate'
import { PendingCalls } from '../../computer/pending'
import type { ToolCtx, WorkCtx } from '../modules'
import { VM_TIER_GATE } from './gate'
import type { Keeper } from './keeper'
import { LEASE_AFTER_TURN_MS, VM_FREE_NOTICE, VM_OWNER_DRIVES } from './lease'
import { NOT_ON_VM, VM_PREAMBLE, vmOffered, vmTools } from './tools'
import { setVmHost, startVm, VM_COMPUTER, wireVm, type VmHost } from './vm'

/**
 * The Windows VM's service on the box over the fake computer service: its
 * sessions' own gate, the tools offered and refused by the workspace's
 * setting, one thread at a time, the waking words, Windows' words, and the
 * VM's launch list through the tool.
 */

class FakeKeeper {
  name: WinvmStateName = 'awake'
  wakes = 0
  touches = 0
  listeners = new Set<(s: WinvmState) => void>()
  wakeGate: Promise<void> = Promise.resolve()
  state(): WinvmState {
    return { state: this.name, step: null, error: null, cannot: null, sleepAfter: '30m', since: 0 }
  }
  async wake(): Promise<WinvmState> {
    this.wakes++
    await this.wakeGate
    this.set('awake')
    return this.state()
  }
  async door() {
    return { socket: '/nowhere', token: 't'.repeat(64) }
  }
  async fetch() {}
  touch() {
    this.touches++
  }
  onState(fn: (s: WinvmState) => void) {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }
  set(name: WinvmStateName) {
    this.name = name
    for (const fn of this.listeners) fn(this.state())
  }
}

let dir: string
let host: VmHost
let keeper: FakeKeeper
let clock: ManualClock
let windowsVm: boolean
let woken: { id: string; notice: string }[]
let stopVm: () => void
const metaListeners: ((m: SessionMeta) => void)[] = []
const titles: Record<string, string> = { 't-a': 'Expense report', 't-b': 'Order supplies' }

const ctx = {
  settings: { workspace: () => ({ mayUseDesktop: [], voice: false, windowsVm }), set: () => {} }
} as unknown as WorkCtx
const scope = (sessionId: string, workspaceId: string | null = 'ws-purdue'): WorkScope => ({ sessionId, workspaceId, sector: 'purdue', host: 'box', away: false, routineRunId: null, shared: () => false })
const toolCtx = (sessionId: string): ToolCtx => ({ ...ctx, scope: scope(sessionId), sessionId, signal: new AbortController().signal }) as unknown as ToolCtx
const text = (r: WorkToolResult) => (r.content as { text?: string }[]).map((c) => c.text ?? '').join('\n')
const pending = new PendingCalls()
const tools = (sessionId = 't-a', workspaceId: string | null = 'ws-purdue') => vmTools(scope(sessionId, workspaceId), { ctx: () => ctx, keeper: () => keeper as unknown as Keeper, pending })
const call = (name: string, args: unknown, sessionId = 't-a') => tools(sessionId).find((t) => t.name === name)!.run(args, toolCtx(sessionId))
const settle = (id: string, status: SessionStatus) => metaListeners.forEach((fn) => fn({ id, status } as SessionMeta))

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'winvm-vm-'))
  keeper = new FakeKeeper()
  clock = new ManualClock()
  windowsVm = true
  woken = []
  metaListeners.length = 0
  host = wireVm({
    registry: {
      get: (id) => ({ id, title: titles[id], status: 'running', permission: 'auto', archived: false }) as unknown as SessionMeta,
      requestApproval: async () => true,
      awayOn: () => false,
      rootSessionOf: (id) => id,
      onMeta: (fn) => metaListeners.push(fn),
      onRemoved: () => {}
    },
    store: { getSetting: () => null, setSetting: () => {}, settingsWithPrefix: () => new Map() },
    dataDir: dir,
    log: () => {},
    // the fake service in place of the guest's: the door's own path is door.test.ts's
    spawn: ((_bin: string, args: string[], opts: object) => nodeSpawn(fakeServiceBin(), args, opts)) as never,
    leaseClock: clock
  })
  stopVm = startVm(() => keeper as unknown as Keeper, (id, notice) => woken.push({ id, notice }))
})
afterEach(async () => {
  stopVm()
  await host.service.close()
  setVmHost(null)
  rmSync(dir, { recursive: true, force: true })
})

describe("the VM's sessions", () => {
  it('admit the session tier: a held key runs in the guest where a headless box refuses it', async () => {
    const vm = computerHarness({ vm: true, gate: VM_TIER_GATE })
    const box = computerHarness({ vm: true, gate: REFUSE_SESSION_TIER })
    try {
      const inVm = await vm.run('computer_act', { app: 'Sessiony', action: 'hold_key', text: 'shift', duration: 0.1 })
      expect(inVm.steps).toEqual(['hold_key shift for 0.1 s · session · changed'])
      expect(vm.requests().find((q) => q.method === 'action.run')!.params.tiers).toEqual(['ax', 'process', 'front', 'session'])
      const onBox = await box.run('computer_act', { app: 'Sessiony', action: 'hold_key', text: 'shift', duration: 0.1 })
      expect(onBox.steps[0]).toMatch(/failed: needs the session tier/)
    } finally {
      await vm.close()
      await box.close()
    }
  }, 30_000)

  it("name their rows as the VM's computer", async () => {
    await call('windows_observe', { app: 'TextEdit' })
    expect(host.rows.rows()).toMatchObject([{ threadId: 't-a', computer: VM_COMPUTER }])
  }, 30_000)
})

describe('the tools', () => {
  it('are the five computer tools and the three file tools, windows_*, offered only to a workspace thread with the setting on and the VM set up; never to a Work Chat', () => {
    expect(tools().map((t) => t.name)).toEqual(['windows_apps', 'windows_observe', 'windows_act', 'windows_batch', 'windows_result', 'windows_put', 'windows_get', 'windows_put_undo'])
    expect(tools()[0].description).toMatch(/^A Windows 11 PC on this host, his own, signed in as he left it/)
    expect(tools()[0].description).not.toMatch(/\bcomputer_apps\b/)
    expect(tools('t-a', null)).toEqual([])
    keeper.name = 'none'
    expect(tools()).toEqual([])
    keeper.name = 'asleep'
    expect(tools()).toHaveLength(8)
    windowsVm = false
    expect(tools()).toEqual([])
    expect(vmOffered(ctx, scope('t-a'), keeper as unknown as Keeper)).toBe(false)
  })

  it('read the setting again at every call', async () => {
    const [, observe] = tools()
    windowsVm = false
    const r = await observe.run({ app: 'TextEdit' }, toolCtx('t-a'))
    expect(r.isError).toBe(true)
    expect(text(r)).toBe(NOT_ON_VM)
  })

  it('wake a sleeping machine first, its row saying the waking words while it waits', async () => {
    keeper.name = 'asleep'
    let open!: () => void
    keeper.wakeGate = new Promise((r) => (open = r))
    const run = call('windows_observe', { app: 'TextEdit' })
    await new Promise((r) => setTimeout(r, 20))
    expect(keeper.wakes).toBe(1)
    open()
    const r = await run
    expect(r.isError).toBe(false)
    expect(text(r)).toMatch(/TextEdit/)
    expect(WAKING_WORDS).toBe('Waking the Windows VM')
  }, 30_000)

  it("refuse a console's launch through windows_apps, in Windows' words", async () => {
    const r = await call('windows_apps', { launch: 'cmd' })
    expect(r.isError).toBe(true)
    expect(text(r)).toMatch(/^no command line, shell or script host/)
    expect(text(r)).not.toMatch(/\bMac\b/)
  }, 30_000)

  it("say Windows, not the Mac: an app outside the VM's list is refused in the VM's own words", async () => {
    const r = await call('windows_apps', { launch: 'Nope.app' })
    expect(text(r)).toMatch(/^in the Windows VM an app is launched by its name alone, and only these: Microsoft Edge, Notepad/)
    expect(text(r)).not.toMatch(/\bMac\b/)
  }, 30_000)

  it('name their own tools in what they answer', async () => {
    const r = await call('windows_observe', { app: 'No Such App' })
    expect(text(r)).toMatch(/\(windows_apps lists them all\)/)
    expect(text(r)).not.toMatch(/computer_/)
  }, 30_000)
})

describe('one thread at a time', () => {
  it("answers another thread with the holder's title, and wakes it two minutes after the holder's turn ends", async () => {
    expect((await call('windows_observe', { app: 'TextEdit' }, 't-a')).isError).toBe(false)
    const refused = await call('windows_observe', { app: 'TextEdit' }, 't-b')
    expect(refused.isError).toBe(true)
    expect(text(refused)).toMatch(/^The Windows VM is in use by 'Expense report'\./)
    settle('t-a', 'idle')
    await clock.advance(LEASE_AFTER_TURN_MS - 1000)
    expect(woken).toEqual([])
    expect((await call('windows_observe', { app: 'TextEdit' }, 't-b')).isError).toBe(true)
    await clock.advance(1000)
    expect(woken).toEqual([{ id: 't-b', notice: VM_FREE_NOTICE }])
    expect((await call('windows_observe', { app: 'TextEdit' }, 't-b')).isError).toBe(false)
  }, 30_000)

  it('keeps the machine for a holder whose turn starts again inside the two minutes', async () => {
    await call('windows_observe', { app: 'TextEdit' }, 't-a')
    settle('t-a', 'idle')
    await clock.advance(60_000)
    settle('t-a', 'running')
    await clock.advance(LEASE_AFTER_TURN_MS)
    expect(host.lease.holderPane()).toBe('t-a')
  }, 30_000)

  it('his Take over outranks every thread; handing back frees it', async () => {
    await call('windows_observe', { app: 'TextEdit' }, 't-a')
    host.lease.ownerDrives(true)
    const r = await call('windows_observe', { app: 'TextEdit' }, 't-a')
    expect(text(r)).toBe(VM_OWNER_DRIVES)
    host.lease.ownerDrives(false)
    expect(host.lease.holderPane()).toBeNull()
  }, 30_000)
})

describe('the machine', () => {
  it('going to sleep ends the service with it', async () => {
    await call('windows_observe', { app: 'TextEdit' })
    let closed = 0
    host.closeDoor = () => void closed++
    keeper.set('going-to-sleep')
    expect(closed).toBe(1)
  }, 30_000)

  it('the preamble names the VM in a word the tools use', () => {
    expect(VM_PREAMBLE).toMatch(/`windows_\*` tools/)
  })
})
