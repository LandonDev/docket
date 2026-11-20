import { describe, expect, it } from 'vitest'
import { WAKING_WORDS, type WinvmSleepAfter, type WinvmState } from '@shared/contract-work-winvm'
import type { WinvmPoint } from '@shared/contract-work-winvm'
import { BEFORE_SETUP, Keeper, NO_DOOR, NO_POINT, NO_SERVICE, NOT_HIBERNATED, NOT_SET_UP, ONLY_ASLEEP, type DoorLink, type KeeperDeps, type VmGuest, type VmMachine } from './keeper'
import type { PointStore } from './points'
import { DISALLOWED, NO_RUN_FOLDERS, SETUP_STEPS, TERMINAL_DELEGATION } from './setup'

/**
 * The keeper's states over a fake machine and a fake guest (no QEMU): every
 * change of state, the idle hibernate, the service copied in only when its
 * hash differs, the door knocked, and setup's script.
 */

class FakeMachine implements VmMachine {
  disk = false
  up = false
  base = true
  starts = 0
  tpmKept = 0
  /** the guest's hibernate stops QEMU unless this is set */
  hangs = false
  /** what is on the disk, for the points */
  contents = 'v1'
  cannot = () => (this.base ? null : 'The box has no Windows base image yet.')
  hasDisk = () => this.disk
  running = () => this.up
  async makeDisk() {
    this.disk = true
  }
  async start() {
    this.starts++
    this.up = true
  }
  async stopped() {
    return !this.up
  }
  async keepTpm() {
    this.tpmKept++
  }
}

/** Points over the fake machine: each holds the machine's "disk" as it was. */
class FakePoints implements PointStore {
  kept: (WinvmPoint & { disk: string })[] = []
  restored: string[] = []
  constructor(private m: FakeMachine) {}
  list() {
    return this.kept.map(({ disk: _d, ...p }) => p).sort((a, b) => b.at - a.at)
  }
  async save(p: WinvmPoint) {
    if (this.m.up) throw new Error('running')
    this.kept.push({ ...p, disk: this.m.contents })
  }
  async restore(id: string) {
    this.m.contents = this.kept.find((p) => p.id === id)!.disk
    this.restored.push(id)
  }
  async remove(id: string) {
    this.kept = this.kept.filter((p) => p.id !== id)
  }
}

class FakeGuest implements VmGuest {
  log: string[] = []
  scripts: string[] = []
  hash: string | null = null
  doorOpens = true
  knocks = 0
  links: { closed: boolean }[] = []
  constructor(
    private m: FakeMachine,
    private token: () => string | null
  ) {}
  async ready() {
    if (!this.m.up) throw new Error('not running')
    this.log.push('ready')
  }
  async admin(script: string) {
    this.scripts.push(script)
    return 'step: one\nstep: two\nsetup done'
  }
  async hibernate() {
    this.log.push('hibernate')
    if (!this.m.hangs) this.m.up = false
  }
  async reboot() {
    this.log.push('reboot')
  }
  async serviceHash() {
    return this.hash
  }
  async installService() {
    this.log.push('install')
    this.hash = 'new'
    return '0.1.0'
  }
  async startService() {
    this.log.push('start-service')
  }
  async openDoor(): Promise<DoorLink> {
    this.log.push('open-door')
    const l = { closed: false }
    this.links.push(l)
    let close!: () => void
    const closed = new Promise<void>((r) => (close = r))
    return {
      close: () => {
        l.closed = true
        close()
      },
      closed
    }
  }
  async knock(_s: string, token: string) {
    this.knocks++
    return this.doorOpens && token === this.token()
  }
}

function make(o: { disk?: boolean; up?: boolean; exe?: string | null; token?: string | null } = {}) {
  let token: string | null = o.token === undefined ? 'T'.repeat(64) : o.token
  const machine = new FakeMachine()
  machine.disk = o.disk ?? true
  machine.up = o.up ?? false
  const guest = new FakeGuest(machine, () => token)
  const points = new FakePoints(machine)
  const pointPushes: WinvmPoint[][] = []
  const pushes: WinvmState[] = []
  let sleepAfter: WinvmSleepAfter = '30m'
  let now = 1_000_000
  const deps: KeeperDeps = {
    machine,
    guest,
    serviceExe: () => (o.exe === undefined ? '/box/tc-computer.exe' : o.exe),
    hashFile: () => 'new',
    token: { get: () => token, set: (t) => (token = t) },
    doorSocket: '/run/door.sock',
    sleepAfter: () => sleepAfter,
    setSleepAfter: (v) => (sleepAfter = v),
    points,
    push: (s) => pushes.push(s),
    pushPoints: (p) => pointPushes.push(p),
    log: () => {},
    now: () => now,
    timeouts: { knock: 0, knockEvery: 1 }
  }
  const keeper = new Keeper(deps)
  return {
    keeper,
    machine,
    guest,
    pushes,
    points,
    pointPushes,
    states: () => pushes.map((p) => p.state),
    advance: (ms: number) => (now += ms),
    token: () => token
  }
}

describe('the states at start', () => {
  it('is none with no disk, asleep with a stopped disk (after a box restart), awake beside a running machine', () => {
    expect(make({ disk: false }).keeper.state().state).toBe('none')
    expect(make({ disk: true }).keeper.state().state).toBe('asleep')
    expect(make({ disk: true, up: true }).keeper.state().state).toBe('awake')
  })

  it('says why a host cannot have it', () => {
    const r = make()
    r.machine.base = false
    expect(r.keeper.state()).toMatchObject({ cannot: 'The box has no Windows base image yet.', sleepAfter: '30m' })
  })
})

describe('wake', () => {
  it('goes asleep → waking (with the words) → awake: starts the machine, waits for Windows, starts the door and knocks', async () => {
    const r = make()
    r.guest.hash = 'new'
    const s = await r.keeper.wake()
    expect(s.state).toBe('awake')
    expect(r.pushes[0]).toMatchObject({ state: 'waking', step: WAKING_WORDS })
    expect(r.states()).toEqual(['waking', 'awake'])
    expect(r.machine.starts).toBe(1)
    expect(r.guest.log).toEqual(['ready', 'start-service', 'open-door'])
    expect(r.guest.knocks).toBe(1)
  })

  it('copies the service in only when its hash differs from the box build', async () => {
    const r = make()
    r.guest.hash = 'old'
    await r.keeper.wake()
    expect(r.guest.log).toContain('install')
    expect(r.pushes.map((p) => p.step)).toContain('Copying the service in')
    await r.keeper.sleep()
    r.guest.log = []
    await r.keeper.wake()
    expect(r.guest.log).not.toContain('install')
  })

  it('a second wake while awake does nothing; two at once start the machine once', async () => {
    const r = make()
    await Promise.all([r.keeper.wake(), r.keeper.wake()])
    expect(r.machine.starts).toBe(1)
    const pushes = r.pushes.length
    await r.keeper.wake()
    expect(r.pushes.length).toBe(pushes)
  })

  it('refuses a machine not set up, and one whose build has no service', async () => {
    await expect(make({ disk: false }).keeper.wake()).rejects.toThrow(NOT_SET_UP)
    const r = make({ exe: null })
    await expect(r.keeper.wake()).rejects.toThrow(NO_SERVICE)
    // the machine runs: it reads awake, with what went wrong
    expect(r.keeper.state()).toMatchObject({ state: 'awake', error: NO_SERVICE })
  })

  it('fails when the door never keeps the knock, and closes the forward', async () => {
    const r = make()
    r.guest.doorOpens = false
    await expect(r.keeper.wake()).rejects.toThrow(NO_DOOR)
    expect(r.guest.links.every((l) => l.closed)).toBe(true)
  })

  it('gives the door to the VM service, waking it first', async () => {
    const r = make()
    expect(await r.keeper.door()).toEqual({ socket: '/run/door.sock', token: 'T'.repeat(64) })
    expect(r.keeper.state().state).toBe('awake')
  })
})

describe('sleep', () => {
  it('goes awake → going to sleep → asleep: closes the forward, hibernates, waits for QEMU, keeps the TPM', async () => {
    const r = make()
    await r.keeper.wake()
    r.pushes.length = 0
    expect((await r.keeper.sleep()).state).toBe('asleep')
    expect(r.states()).toEqual(['going-to-sleep', 'asleep'])
    expect(r.guest.log.at(-1)).toBe('hibernate')
    expect(r.guest.links[0].closed).toBe(true)
    expect(r.machine.tpmKept).toBe(1)
  })

  it('says so when Windows does not hibernate, and stays awake', async () => {
    const r = make()
    await r.keeper.wake()
    r.machine.hangs = true
    await expect(r.keeper.sleep()).rejects.toThrow(NOT_HIBERNATED)
    expect(r.keeper.state()).toMatchObject({ state: 'awake', error: NOT_HIBERNATED })
  })

  it('a wake asked while it goes to sleep waits for the sleep, then wakes it', async () => {
    const r = make()
    await r.keeper.wake()
    r.pushes.length = 0
    await Promise.all([r.keeper.sleep(), r.keeper.wake()])
    expect(r.states()).toEqual(['going-to-sleep', 'asleep', 'waking', 'awake'])
    expect(r.machine.starts).toBe(2)
  })

  it('a sleep of a machine already asleep changes nothing', async () => {
    const r = make()
    expect((await r.keeper.sleep()).state).toBe('asleep')
    expect(r.pushes).toEqual([])
  })
})

describe('the idle hibernate', () => {
  it('hibernates after the setting with no call, no viewer and him not driving', async () => {
    const r = make()
    await r.keeper.wake()
    r.advance(29 * 60_000)
    r.keeper.tick()
    expect(r.guest.log).not.toContain('hibernate')
    r.advance(60_000)
    r.keeper.tick()
    await r.keeper.sleep() // queued behind the idle one: resolves once it is done
    expect(r.guest.log.filter((l) => l === 'hibernate')).toHaveLength(1)
    expect(r.keeper.state().state).toBe('asleep')
  })

  it('a call starts the wait again; a viewer or his driving holds it awake; never is never', async () => {
    const r = make()
    await r.keeper.wake()
    r.advance(25 * 60_000)
    r.keeper.touch()
    r.advance(25 * 60_000)
    r.keeper.tick()
    r.keeper.setViewers(1)
    r.advance(3 * 3600_000)
    r.keeper.tick()
    r.keeper.setViewers(0)
    r.keeper.setDriving(true)
    r.advance(3 * 3600_000)
    r.keeper.tick()
    r.keeper.setDriving(false)
    r.keeper.settings('never')
    r.advance(30 * 3600_000)
    r.keeper.tick()
    expect(r.guest.log).not.toContain('hibernate')
    r.keeper.settings('15m')
    r.advance(15 * 60_000)
    r.keeper.tick()
    await r.keeper.sleep()
    expect(r.guest.log).toContain('hibernate')
  })

  it('notices a machine that stopped by itself: keeps the TPM and sleeps', async () => {
    const r = make()
    await r.keeper.wake()
    r.machine.up = false
    r.keeper.tick()
    await r.keeper.sleep()
    expect(r.keeper.state().state).toBe('asleep')
    expect(r.machine.tpmKept).toBe(1)
  })

  it('the setting pushes the state when it changes', () => {
    const r = make()
    expect(r.keeper.settings()).toEqual({ sleepAfter: '30m' })
    expect(r.keeper.settings('2h')).toEqual({ sleepAfter: '2h' })
    expect(r.pushes.at(-1)).toMatchObject({ sleepAfter: '2h' })
  })
})

describe('setup', () => {
  it('none → setting up → awake: makes the disk, starts it, runs the admin script, copies the service in, restarts, knocks', async () => {
    const r = make({ disk: false, token: null })
    const s = await r.keeper.setup()
    expect(s.state).toBe('awake')
    expect(r.states()[0]).toBe('setting-up')
    expect(r.pushes.map((p) => p.step).filter(Boolean)).toEqual(['Making the disk', 'Starting Windows', 'Setting Windows up', 'Copying the service in', 'Restarting Windows', 'Opening the door'])
    expect(r.machine.disk).toBe(true)
    expect(r.token()).toMatch(/^[0-9a-f]{64}$/)
    expect(r.guest.log).toEqual(['ready', 'install', 'start-service', 'reboot', 'ready', 'start-service', 'open-door'])
  })

  it("carries every admin step, tcuser's policies first among the second line's", async () => {
    const r = make({ disk: false })
    await r.keeper.setup()
    const script = r.guest.scripts[0]
    for (const step of SETUP_STEPS) expect(script).toContain(`"step: ${step}"`)
    expect(script).toContain("'DisableCMD' 1 DWord")
    expect(script).toContain("'NoRun' 1 DWord")
    expect(script).toContain("'DisallowRun' 1 DWord")
    for (const exe of DISALLOWED) expect(script).toContain(`'${exe}'`)
    for (const folder of NO_RUN_FOLDERS) expect(script).toContain(`'${folder}'`)
    // execute denied to tcuser under its folders, its rights there cut to Modify, the folders owned by Administrators
    expect(script).toContain('icacls $d /deny "$($user):(OI)(CI)(IO)(X)"')
    expect(script).toContain('icacls $d /grant:r "$($user):(OI)(CI)M"')
    expect(script).toContain('icacls $d /setowner Administrators')
    expect(script).toContain(TERMINAL_DELEGATION.DelegationConsole)
    expect(script).toContain(TERMINAL_DELEGATION.DelegationTerminal)
    expect(script).toContain('powercfg /hibernate on')
    expect(script).toContain('CONSOLELOCK 0')
    expect(script).toContain('NoAutoUpdate')
    expect(script).toContain('T'.repeat(64))
  })

  it('on a machine already set up keeps its disk and its token, and keeps a point of its own first', async () => {
    const r = make({ disk: true })
    await r.keeper.setup()
    expect(r.token()).toBe('T'.repeat(64))
    expect(r.machine.starts).toBe(1)
    expect(r.keeper.points()).toMatchObject([{ name: BEFORE_SETUP, by: 'keeper' }])
    expect(r.pushes.map((p) => p.step)).toContain('Keeping a restore point')
  })

  it('on an awake machine hibernates it before its own point, then sets it up', async () => {
    const r = make({ disk: true })
    await r.keeper.wake()
    r.pushes.length = 0
    await r.keeper.setup()
    expect(r.states().slice(0, 3)).toEqual(['going-to-sleep', 'asleep', 'setting-up'])
    expect(r.points.kept).toHaveLength(1)
    expect(r.keeper.state().state).toBe('awake')
  })

  it('a failure leaves the state that is true, with what went wrong', async () => {
    const r = make({ disk: false })
    r.guest.admin = async () => {
      throw new Error("the guest's script failed (exit 1): no")
    }
    await expect(r.keeper.setup()).rejects.toThrow('no')
    expect(r.keeper.state()).toMatchObject({ state: 'awake', error: "the guest's script failed (exit 1): no", step: null })
  })

  it('refuses a host that cannot have it', async () => {
    const r = make({ disk: false })
    r.machine.base = false
    await expect(r.keeper.setup()).rejects.toThrow('no Windows base image')
  })
})

describe('restore points', () => {
  it('saves, lists newest first, and pushes the list', async () => {
    const r = make()
    const a = await r.keeper.savePoint('Clean')
    r.advance(1000)
    const b = await r.keeper.savePoint()
    expect(r.keeper.points().map((p) => p.id)).toEqual([b.id, a.id])
    expect(b).toMatchObject({ name: 'Restore point', by: 'owner' })
    expect(r.pointPushes.at(-1)?.map((p) => p.id)).toEqual([b.id, a.id])
  })

  it('keeps three at most: a fourth drops the oldest', async () => {
    const r = make()
    const ids: string[] = []
    for (let i = 0; i < 4; i++) {
      ids.push((await r.keeper.savePoint(`p${i}`)).id)
      r.advance(1000)
    }
    expect(r.keeper.points().map((p) => p.name)).toEqual(['p3', 'p2', 'p1'])
    expect(r.keeper.points().some((p) => p.id === ids[0])).toBe(false)
  })

  it('goes back to a point: the disk as it was, the machine still asleep', async () => {
    const r = make()
    const p = await r.keeper.savePoint('Clean')
    r.machine.contents = 'v2'
    const s = await r.keeper.restorePoint(p.id)
    expect(r.machine.contents).toBe('v1')
    expect(s).toMatchObject({ state: 'asleep', step: null, error: null })
    expect(r.pushes.map((x) => x.step)).toContain('Going back to Clean')
  })

  it('refuses all three unless it sleeps, and a point that is gone', async () => {
    const r = make()
    const p = await r.keeper.savePoint('Clean')
    await r.keeper.wake()
    await expect(r.keeper.savePoint()).rejects.toThrow(ONLY_ASLEEP)
    await expect(r.keeper.restorePoint(p.id)).rejects.toThrow(ONLY_ASLEEP)
    await expect(r.keeper.deletePoint(p.id)).rejects.toThrow(ONLY_ASLEEP)
    await r.keeper.sleep()
    await expect(r.keeper.restorePoint('nope00')).rejects.toThrow(NO_POINT)
    expect(await r.keeper.deletePoint(p.id)).toEqual([])
    await expect(make({ disk: false }).keeper.savePoint()).rejects.toThrow(NOT_SET_UP)
  })
})

