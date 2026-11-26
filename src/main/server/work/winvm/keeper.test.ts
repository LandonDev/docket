import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LIVE_RESIZE_WORDS, WAKING_AFTER_UPDATE_WORDS, WAKING_WORDS, type WinvmDetail, type WinvmDevice, type WinvmScreen, type WinvmSleepAfter, type WinvmState } from '@shared/contract-work-winvm'
import type { WinvmPoint } from '@shared/contract-work-winvm'
import { AFTER_STOP_WAKE_MS, BEFORE_LIVE_RESIZE, BEFORE_SETUP, DRIVES, HELD, Keeper, median, OWED, RESTARTING_WORDS, SHUTDOWN_REFUSED, WAKES_KEPT, NO_DOOR, NO_LIVE_RESIZE, NO_POINT, NO_SERVICE, NOT_HIBERNATED, NOT_SET_UP, ONLY_ASLEEP, type DoorLink, type KeeperDeps, type KeeperDisplay, type VmGuest, type VmMachine } from './keeper'
import { awakeMark, AWAKE_MARK, takeAwakeAtStop } from './afterStop'
import { CURSOR_SCRIPT, IBEAM_PATH, VIRTIO_ADAPTER } from './liveResize'
import type { PointStore } from './points'
import { DISALLOWED, NO_RUN_FOLDERS, SETUP_STEPS, TERMINAL_DELEGATION } from './setup'

/**
 * The keeper's states over a fake machine and a fake guest (no QEMU): every
 * change of state, the idle hibernate, the service copied in only when its
 * hash differs, the door knocked, and setup's script.
 */

/** The run's machine.json and screen.json, his choice, and the box's driver folder: what live resize reads and writes. */
class FakeDisplay implements KeeperDisplay {
  file: WinvmDevice = 'vga'
  size: { width: number; height: number; scale?: number } | null = null
  pick: { screen: WinvmScreen; detail: WinvmDetail } = { screen: 'fit', detail: 'sharp' }
  progress: string[] = []
  device = () => this.file
  setDevice(d: WinvmDevice) {
    this.file = d
  }
  screen = () => this.size
  setScreen(size: { width: number; height: number }) {
    this.size = size
  }
  choice = () => this.pick
  async driver(progress: (line: string) => void) {
    progress('installing')
    return '/box/work-tools/virtio-win/0.1.302/viogpudo'
  }
  cursor = () => '/app/resources/winvm/tc-ibeam.cur'
}

class FakeMachine implements VmMachine {
  disk = false
  up = false
  /** the device the guest last ran on: read from the display's file at each start, as standing.ts does */
  ranOn: WinvmDevice = 'vga'
  /** how it last stopped */
  lastStop: 'hibernate' | 'shutdown' | 'pulled' | null = null
  /** Windows refuses a shutdown (an app with unsaved work) */
  refuses = false
  order: string[] = []
  waits: number[] = []
  files: FakeDisplay | null = null
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
    this.ranOn = this.files?.file ?? 'vga'
    this.order.push(`start ${this.ranOn}`)
    this.up = true
  }
  async stopped(timeoutMs: number) {
    this.waits.push(timeoutMs)
    return !this.up
  }
  async keepTpm() {
    this.tpmKept++
    this.order.push('keepTpm')
  }
  async forceStop() {
    this.up = false
    this.lastStop = 'pulled'
  }
  keys: string[] = []
  async key(...qcodes: string[]) {
    this.keys.push(...qcodes)
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
    this.m.order.push('point')
    // as points.ts records the run's device and size
    this.kept.push({ ...p, disk: this.m.contents, device: this.m.files?.file ?? 'vga', screen: this.m.files?.size ?? { width: 1280, height: 800 } })
  }
  async restore(id: string) {
    const p = this.kept.find((p) => p.id === id)!
    this.m.contents = p.disk
    if (this.m.files) {
      this.m.files.file = p.device ?? 'vga'
      this.m.files.size = p.screen ?? null
    }
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
  uploads: string[] = []
  async admin(script: string): Promise<string> {
    this.scripts.push(script)
    if (script.includes('Win32_VideoController')) return this.m.ranOn === 'virtio' ? `${VIRTIO_ADAPTER}\r\n` : 'Microsoft Basic Display Adapter\r\n'
    return 'step: one\nstep: two\nsetup done'
  }
  async hibernate() {
    this.log.push('hibernate')
    if (!this.m.hangs) {
      this.m.up = false
      this.m.lastStop = 'hibernate'
    }
  }
  async shutdown() {
    this.log.push('shutdown')
    if (!this.m.refuses) {
      this.m.up = false
      this.m.lastStop = 'shutdown'
    }
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
  also: readonly { socket: string; port: number }[] | undefined
  async openDoor(_socket: string, _port: number, also?: readonly { socket: string; port: number }[]): Promise<DoorLink> {
    this.also = also
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
  async fetch() {}
  async send() {}
  async upload(local: string, name: string) {
    this.uploads.push(`${local} → ${name}`)
  }
  async knock(_s: string, token: string) {
    this.knocks++
    return this.doorOpens && token === this.token()
  }
}

function make(o: { disk?: boolean; up?: boolean; exe?: string | null; token?: string | null; owed?: () => boolean; beforeSleep?: () => Promise<void>; device?: WinvmDevice; liveResize?: boolean; awakeAtStop?: boolean; held?: boolean; run?: string } = {}) {
  let token: string | null = o.token === undefined ? 'T'.repeat(64) : o.token
  const machine = new FakeMachine()
  machine.disk = o.disk ?? true
  machine.up = o.up ?? false
  const display = new FakeDisplay()
  display.file = machine.ranOn = o.device ?? 'vga'
  if (o.liveResize !== false) machine.files = display
  const guest = new FakeGuest(machine, () => token)
  const points = new FakePoints(machine)
  const pointPushes: WinvmPoint[][] = []
  const pushes: WinvmState[] = []
  let sleepAfter: WinvmSleepAfter = '30m'
  let now = 1_000_000
  // the watcher's record and his Sleep's hold, as the files afterStop.ts keeps
  const afterStop = { record: o.awakeAtStop ?? false, held: o.held ?? false, reads: 0 }
  const logs: string[] = []
  const deps: KeeperDeps = {
    machine,
    guest,
    serviceExe: () => (o.exe === undefined ? '/box/tc-computer.exe' : o.exe),
    hashFile: () => 'new',
    token: { get: () => token, set: (t) => (token = t) },
    doorSocket: '/run/door.sock',
    forwards: [{ socket: '/run/office.sock', port: 47801 }],
    sleepAfter: () => sleepAfter,
    setSleepAfter: (v) => (sleepAfter = v),
    points,
    push: (s) => pushes.push(s),
    pushPoints: (p) => pointPushes.push(p),
    log: (line) => logs.push(line),
    now: () => now,
    timeouts: { knock: 0, knockEvery: 1 },
    awakeAtStop: () => {
      afterStop.reads++
      const was = afterStop.record
      afterStop.record = false
      return was
    },
    held: { get: () => afterStop.held, set: (on) => (afterStop.held = on) },
    // the real files of afterStop.ts in a run folder of the test's, as index.ts wires them
    ...(o.run ? { awakeAtStop: () => takeAwakeAtStop(o.run!, machine.running()), awakeMark: awakeMark(o.run) } : {}),
    ...(o.owed ? { owed: o.owed } : {}),
    ...(o.beforeSleep ? { beforeSleep: o.beforeSleep } : {}),
    ...(o.liveResize !== false ? { display } : {})
  }
  const keeper = new Keeper(deps)
  return {
    keeper,
    deps,
    display,
    machine,
    guest,
    pushes,
    points,
    pointPushes,
    states: () => pushes.map((p) => p.state),
    advance: (ms: number) => (now += ms),
    token: () => token,
    afterStop,
    logs
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
    expect(r.pushes.map((p) => p.step)).toContain("Copying TempCode's helper into Windows")
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

describe("the guest's other doors and the machine's keyboard", () => {
  it("carries the helper's forward on the door's own connection", async () => {
    const t = make({ disk: true })
    await t.keeper.wake()
    expect(t.guest.also).toEqual([{ socket: '/run/office.sock', port: 47801 }])
  })
  it("presses keys on the machine's own keyboard only while it is awake", async () => {
    const t = make({ disk: true })
    await expect(t.keeper.key('esc')).rejects.toThrow('not awake')
    await t.keeper.wake()
    await t.keeper.key('esc')
    expect(t.machine.keys).toEqual(['esc'])
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

  it('stays awake while a save of ours is still owed to the cloud, and sleeps once it is not (files/uploads.ts)', async () => {
    let owed = true
    const r = make({ owed: () => owed })
    await r.keeper.wake()
    r.advance(31 * 60_000)
    r.keeper.tick()
    for (let i = 0; i < 20; i++) await new Promise((done) => setTimeout(done, 0))
    expect(r.guest.log).not.toContain('hibernate')
    owed = false
    r.keeper.tick()
    await r.keeper.sleep()
    expect(r.guest.log.filter((l) => l === 'hibernate')).toHaveLength(1)
  })

  it('counts its idle time from when it came awake, not from the keeper\'s start hours before, a failed setup too (1.0.356 hibernated a minute after setup)', async () => {
    // the box's service has run for hours before he presses Set up, and the build has no service to copy in
    const r = make({ disk: false, token: null, exe: null })
    r.advance(4 * 3600_000)
    await expect(r.keeper.setup()).rejects.toThrow(NO_SERVICE)
    expect(r.keeper.state()).toMatchObject({ state: 'awake', error: NO_SERVICE })
    r.advance(60_000)
    r.keeper.tick()
    // an idle hibernate the tick started would be done by now
    for (let i = 0; i < 20; i++) await new Promise((done) => setTimeout(done, 0))
    expect(r.guest.log).not.toContain('hibernate')
    expect(r.keeper.state().state).toBe('awake')
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
    expect(r.pushes.map((p) => p.step).filter(Boolean)).toEqual(['Making the disk', LIVE_RESIZE_WORDS.driver, 'Starting Windows', 'Setting Windows up', "Copying TempCode's helper into Windows", 'Restarting Windows', 'Connecting to Windows'])
    expect(r.machine.disk).toBe(true)
    expect(r.token()).toMatch(/^[0-9a-f]{64}$/)
    expect(r.guest.log).toEqual(['ready', 'install', 'start-service', 'reboot', 'ready', 'start-service', 'open-door'])
  })

  it('a new disk comes up on virtio by itself: machine.json before its first start, the driver bound during setup, the pointer after its restart', async () => {
    const r = make({ disk: false })
    expect((await r.keeper.setup()).display).toMatchObject({ device: 'virtio', canResize: true })
    expect(r.machine.order).toEqual(['start virtio'])
    const stage = r.guest.scripts.findIndex((x) => x.includes('pnputil /add-driver'))
    expect(r.guest.scripts[stage]).toContain("viogpudo.inf' /install")
    // after the setup script, before the restart; the pointer once Windows is back
    expect(stage).toBeGreaterThan(0)
    expect(r.guest.scripts.at(-1)).toBe(CURSOR_SCRIPT)
  })

  it('a new disk on a box that cannot have the driver is set up on std VGA', async () => {
    const r = make({ disk: false })
    r.display.driver = async () => Promise.reject(new Error('fetch failed'))
    expect((await r.keeper.setup()).display).toMatchObject({ device: 'vga', canResize: false })
    expect(r.machine.order).toEqual(['start vga'])
    expect(r.guest.scripts.some((x) => x.includes('pnputil'))).toBe(false)
  })

  it('a disk that exists keeps its device when set up again, virtio too', async () => {
    const r = make({ disk: true, device: 'virtio' })
    await r.keeper.setup()
    expect(r.machine.order).toEqual(['point', 'start virtio'])
    expect(r.guest.scripts.some((x) => x.includes('pnputil /add-driver'))).toBe(false)
  })

  it("carries every admin step, tcuser's policies first among the second line's", async () => {
    const r = make({ disk: false })
    await r.keeper.setup()
    const script = r.guest.scripts[0]
    for (const step of SETUP_STEPS) expect(script).toContain(`Step "${step}"`)
    expect(script).toContain("'DisableCMD' 1 DWord")
    // what the service starts runs in tcuser's Documents, so a Save dialog opens there and not in System32
    expect(script).toContain(String.raw`$action.WorkingDirectory = 'C:\Users\tcuser\Documents'`)
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
    expect(r.keeper.state()).toMatchObject({ state: 'awake', error: "the guest's script failed (exit 1): no (it reached no step)", step: null })
  })

  it('runs a setup script that does not finish once more, and a second failure says the step it reached', async () => {
    const r = make({ disk: false })
    let runs = 0
    const admin = r.guest.admin.bind(r.guest)
    r.guest.admin = async (script: string) => {
      if (script.includes('Get-Content')) return '2026-11-20T09:33:01 started\n2026-11-20T09:33:02 service folder and token'
      if (script.includes("Step 'started'") && ++runs === 1) throw new Error("the guest's script failed (exit null): ")
      return admin(script)
    }
    expect((await r.keeper.setup()).state).toBe('awake')
    expect(runs).toBe(2)
    const again = make({ disk: false })
    again.guest.admin = async (script: string) => {
      if (script.includes('Get-Content')) return '2026-11-20T09:33:01 started'
      throw new Error("the guest's script failed (exit null): ")
    }
    await expect(again.keeper.setup()).rejects.toThrow("(it reached: 2026-11-20T09:33:01 started)")
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


describe('what the Computers page reads of it', () => {
  it('says the usual wake: the median of the last five wakes from sleep, none before one', async () => {
    const r = make()
    expect(r.keeper.state().wakeMs).toBeNull()
    for (const ms of [20_000, 12_000, 13_000, 14_000, 11_000, 13_500]) {
      r.machine.start = async () => {
        r.advance(ms)
        r.machine.up = true
      }
      await r.keeper.wake()
      await r.keeper.sleep()
    }
    // the first of six has gone: 12, 13, 14, 11, 13.5
    expect(WAKES_KEPT).toBe(5)
    expect(r.keeper.state().wakeMs).toBe(13_000)
    expect(median([1, 4])).toBe(3)
  })

  it('holds a person\'s Sleep asleep for his Wake, and not the idle sleep; a wake clears it', async () => {
    const r = make()
    await r.keeper.wake()
    await r.keeper.sleep()
    expect(r.keeper.state().heldAsleep).toBe(true)
    await r.keeper.wake()
    expect(r.keeper.state().heldAsleep).toBe(false)
    r.advance(31 * 60_000)
    r.keeper.tick()
    await r.keeper.sleep('idle')
    expect(r.keeper.state()).toMatchObject({ state: 'asleep', heldAsleep: false })
  })

  it('keeps the picture before it hibernates, and sleeps anyway when that fails', async () => {
    const order: string[] = []
    const r = make({ beforeSleep: async () => void order.push('still') })
    await r.keeper.wake()
    r.guest.hibernate = async () => {
      order.push('hibernate')
      r.machine.up = false
    }
    await r.keeper.sleep()
    expect(order).toEqual(['still', 'hibernate'])
    const broken = make({ beforeSleep: async () => Promise.reject(new Error('qmp busy')) })
    await broken.keeper.wake()
    expect((await broken.keeper.sleep()).state).toBe('asleep')
  })
})

describe('restart', () => {
  it('restarts Windows cleanly and opens the door again, saying so while it runs', async () => {
    const r = make()
    await r.keeper.wake()
    r.pushes.length = 0
    r.guest.log.length = 0
    expect((await r.keeper.restart(() => false)).state).toBe('awake')
    expect(r.pushes.map((p) => [p.state, p.step])).toEqual([
      ['waking', RESTARTING_WORDS],
      ['awake', null]
    ])
    expect(r.guest.log).toEqual(['reboot', 'ready', 'start-service', 'open-door'])
    expect(r.guest.links[0].closed).toBe(true)
  })

  it('is refused while a thread holds it, and while it is not awake', async () => {
    const r = make()
    await r.keeper.wake()
    await expect(r.keeper.restart(() => true)).rejects.toThrow(HELD)
    expect(r.guest.log).not.toContain('reboot')
    await r.keeper.sleep()
    await expect(r.keeper.restart(() => false)).rejects.toThrow('not awake')
  })
})

describe('live resize: Turn on', () => {
  const W = LIVE_RESIZE_WORDS
  const awakeOnVga = async () => {
    const r = make()
    await r.keeper.wake()
    r.pushes.length = 0
    r.guest.log.length = 0
    r.machine.order.length = 0
    return r
  }
  /** a stop of the box's service: the keeper is gone and a new one reads the machine as it is */
  const fileMatchesLastRun = (r: ReturnType<typeof make>) =>
    r.display.file === r.machine.ranOn ||
    // written before the start on virtio, and the start not reached: Windows was shut down cleanly, never hibernated,
    // so it boots afresh on either device
    (!r.machine.up && r.machine.lastStop === 'shutdown')

  it('goes through its six steps, each said as it runs, and wakes on virtio-vga with the door open', async () => {
    const r = await awakeOnVga()
    const s = await r.keeper.upgrade(() => false)
    expect(s).toMatchObject({ state: 'awake', step: null, error: null, display: { device: 'virtio', canResize: true } })
    expect(r.pushes.map((p) => p.step).filter(Boolean)).toEqual([W.driver, W.stage, W.restart, W.point, W.start, W.cursor])
    // the driver and the I-beam copied in, then staged; a clean shutdown, never a hibernate
    expect(r.guest.uploads).toEqual(['viogpudo.inf', 'viogpudo.cat', 'viogpudo.sys'].map((f) => `/box/work-tools/virtio-win/0.1.302/viogpudo/${f} → ${f}`).concat('/app/resources/winvm/tc-ibeam.cur → tc-ibeam.cur'))
    expect(r.guest.scripts.find((x) => x.includes('pnputil /add-driver'))).toContain("'IBeam' -Value 'C:\\ProgramData\\TempCode\\tc-ibeam.cur' -Type ExpandString")
    expect(IBEAM_PATH).toBe('C:\\ProgramData\\TempCode\\tc-ibeam.cur')
    expect(r.guest.log).toContain('shutdown')
    expect(r.guest.log).not.toContain('hibernate')
    // the TPM kept, then the point; machine.json virtio before the one start on it
    expect(r.machine.order).toEqual(['keepTpm', 'point', 'start virtio'])
    expect(r.keeper.points()[0]).toMatchObject({ name: BEFORE_LIVE_RESIZE, by: 'keeper', device: 'vga' })
    // step 6: HWCursor=1 in viogpudo's key, the device restarted to read it
    expect(r.guest.scripts.at(-1)).toBe(CURSOR_SCRIPT)
    expect(CURSOR_SCRIPT).toContain("-Name 'HWCursor' -Value 1 -Type DWord")
    expect(CURSOR_SCRIPT).toContain('pnputil /restart-device')
    expect(r.guest.links.at(-1)?.closed).toBe(false)
  })

  it('wakes a sleeping machine for its driver, and waits 3 minutes for Windows to shut down', async () => {
    const r = make()
    await r.keeper.upgrade(() => false)
    expect(r.machine.order).toEqual(['start vga', 'keepTpm', 'point', 'start virtio'])
    expect(r.machine.waits[0]).toBe(180_000)
  })

  it('in place of the oldest of three points', async () => {
    const r = make()
    for (const n of ['a', 'b', 'c']) {
      await r.keeper.savePoint(n)
      r.advance(1000)
    }
    await r.keeper.upgrade(() => false)
    expect(r.keeper.points().map((p) => p.name)).toEqual([BEFORE_LIVE_RESIZE, 'c', 'b'])
  })

  it('is refused while a thread holds it, while he drives, while a OneDrive write is owed, and where there is no live resize', async () => {
    let owed = false
    const r = make({ owed: () => owed })
    await expect(r.keeper.upgrade(() => true)).rejects.toThrow(HELD)
    r.keeper.setDriving(true)
    await expect(r.keeper.upgrade(() => false)).rejects.toThrow(DRIVES)
    await expect(r.keeper.downgrade(() => false)).rejects.toThrow(DRIVES)
    r.keeper.setDriving(false)
    owed = true
    await expect(r.keeper.upgrade(() => false)).rejects.toThrow(OWED)
    expect(r.machine.starts).toBe(0)
    expect(r.display.file).toBe('vga')
    await expect(make({ liveResize: false }).keeper.upgrade(() => false)).rejects.toThrow(NO_LIVE_RESIZE)
    await expect(make({ disk: false }).keeper.upgrade(() => false)).rejects.toThrow(NOT_SET_UP)
  })

  it('calls itself off when Windows has not stopped in 3 minutes: nothing new starts, it stays on std VGA', async () => {
    const r = await awakeOnVga()
    r.machine.refuses = true
    await expect(r.keeper.upgrade(() => false)).rejects.toThrow(SHUTDOWN_REFUSED)
    expect(SHUTDOWN_REFUSED).toBe('An app in Windows kept it from restarting. Save your work and try again.')
    expect(r.machine.order).toEqual([])
    expect(r.keeper.points()).toEqual([])
    expect(r.display.file).toBe('vga')
    expect(r.keeper.state()).toMatchObject({ state: 'awake', error: SHUTDOWN_REFUSED, display: { device: 'vga', canResize: false } })
  })

  it('goes back to its restore point by itself when the start on virtio fails its check, std VGA with it, and says so', async () => {
    const r = await awakeOnVga()
    r.machine.contents = 'before'
    const admin = r.guest.admin.bind(r.guest)
    r.guest.admin = async (script: string) => (script.includes('Win32_VideoController') ? 'Microsoft Basic Display Adapter' : admin(script))
    await expect(r.keeper.upgrade(() => false)).rejects.toThrow(/Live resize did not start \(Windows did not take the VirtIO GPU adapter.*\)\. Windows is back as it was, from the restore point "Before live resize"\./)
    expect(r.pushes.map((p) => p.step)).toContain(W.back)
    expect(r.points.restored).toHaveLength(1)
    expect(r.display.file).toBe('vga')
    expect(r.machine.up).toBe(false)
    expect(r.keeper.state()).toMatchObject({ state: 'asleep', display: { device: 'vga' } })
  })

  it("pulls the plug only on a start on virtio that will not shut down, before going back to the point", async () => {
    const r = await awakeOnVga()
    let started = 0
    const start = r.machine.start.bind(r.machine)
    r.machine.start = async () => {
      await start()
      // the start on virtio hangs at boot: no SSH, no shutdown
      if (++started === 1) {
        r.guest.ready = async () => {
          throw new Error('Windows did not come up within 600 s')
        }
        r.machine.refuses = true
      }
    }
    await expect(r.keeper.upgrade(() => false)).rejects.toThrow('Windows did not come up within 600 s')
    expect(r.machine.lastStop).toBe('pulled')
    expect(r.display.file).toBe('vga')
  })

  it("a pointer that does not turn on leaves Windows on virtio, and is tried again at a later service's first wake", async () => {
    const r = await awakeOnVga()
    const admin = r.guest.admin.bind(r.guest)
    r.guest.admin = async (script: string) => {
      if (script === CURSOR_SCRIPT) throw new Error('pnputil exited 1')
      return admin(script)
    }
    expect(await r.keeper.upgrade(() => false)).toMatchObject({ state: 'awake', error: null, display: { device: 'virtio' } })
    r.guest.admin = admin
    await r.keeper.sleep()
    const again = new Keeper(r.deps)
    r.guest.scripts.length = 0
    await again.wake()
    expect(r.guest.scripts).toContain(CURSOR_SCRIPT)
    // once a keeper
    await again.sleep()
    r.guest.scripts.length = 0
    await again.wake()
    expect(r.guest.scripts).not.toContain(CURSOR_SCRIPT)
  })

  it('a failure at each step leaves machine.json as the guest last ran', async () => {
    const fails: Record<string, (r: ReturnType<typeof make>) => void> = {
      driver: (r) => (r.display.driver = async () => Promise.reject(new Error('fetch failed'))),
      stage: (r) => {
        const admin = r.guest.admin.bind(r.guest)
        r.guest.admin = async (s: string) => (s.includes('pnputil /add-driver') ? Promise.reject(new Error('pnputil exited 1')) : admin(s))
      },
      restart: (r) => void (r.machine.refuses = true),
      point: (r) => (r.points.save = async () => Promise.reject(new Error('qemu-img failed'))),
      start: (r) => {
        const start = r.machine.start.bind(r.machine)
        r.machine.start = async () => (r.display.file === 'virtio' ? Promise.reject(new Error('QEMU did not stay up')) : start())
      },
      cursor: (r) => {
        const admin = r.guest.admin.bind(r.guest)
        r.guest.admin = async (s: string) => (s === CURSOR_SCRIPT ? Promise.reject(new Error('no')) : admin(s))
      }
    }
    for (const [step, fail] of Object.entries(fails)) {
      const r = await awakeOnVga()
      fail(r)
      await r.keeper.upgrade(() => false).catch(() => {})
      expect(fileMatchesLastRun(r), step).toBe(true)
      expect(r.keeper.state().step, step).toBeNull()
    }
  })

  it("a stop of the box's service at each step leaves machine.json as the guest last ran, and the next keeper reads it so", async () => {
    const never = () => new Promise<never>(() => {})
    const hangs: Record<string, (r: ReturnType<typeof make>) => void> = {
      driver: (r) => (r.display.driver = never),
      stage: (r) => {
        const admin = r.guest.admin.bind(r.guest)
        r.guest.admin = async (s: string) => (s.includes('pnputil /add-driver') ? never() : admin(s))
      },
      restart: (r) => (r.machine.stopped = never),
      point: (r) => (r.points.save = never),
      'start, before QEMU runs': (r) => {
        const start = r.machine.start.bind(r.machine)
        r.machine.start = async () => (r.display.file === 'virtio' ? never() : start())
      },
      'start, Windows booting': (r) => {
        const ready = r.guest.ready.bind(r.guest)
        r.guest.ready = async () => (r.display.file === 'virtio' ? never() : ready())
      },
      cursor: (r) => {
        const admin = r.guest.admin.bind(r.guest)
        r.guest.admin = async (s: string) => (s === CURSOR_SCRIPT ? never() : admin(s))
      }
    }
    for (const [step, hang] of Object.entries(hangs)) {
      const r = await awakeOnVga()
      hang(r)
      void r.keeper.upgrade(() => false)
      for (let i = 0; i < 30; i++) await new Promise((done) => setTimeout(done, 0))
      expect(fileMatchesLastRun(r), step).toBe(true)
      // the service starts again: its keeper reads the machine as it is, and its display as the file says
      const next = new Keeper(r.deps)
      expect(next.state().display?.device, step).toBe(r.display.file)
      expect(next.state().state, step).toBe(r.machine.up ? 'awake' : 'asleep')
    }
  })
})

describe('live resize: Turn off', () => {
  it('a clean shutdown, then a start on std VGA at 1280×800 with screen.json to match', async () => {
    const r = make({ device: 'virtio' })
    r.display.size = { width: 3456, height: 2234, scale: 200 }
    await r.keeper.wake()
    r.machine.order.length = 0
    r.pushes.length = 0
    expect(await r.keeper.downgrade(() => false)).toMatchObject({ state: 'awake', error: null, display: { device: 'vga', width: 1280, height: 800, scale: 100, canResize: false } })
    expect(r.pushes.map((p) => p.step).filter(Boolean)).toEqual([LIVE_RESIZE_WORDS.restart, LIVE_RESIZE_WORDS.startVga])
    expect(r.machine.order).toEqual(['keepTpm', 'start vga'])
    expect(r.machine.lastStop).toBe('shutdown')
    expect(r.guest.log).not.toContain('hibernate')
  })

  it('wakes a hibernated guest on the device it slept on before it shuts it down', async () => {
    const r = make({ device: 'virtio' })
    await r.keeper.downgrade(() => false)
    expect(r.machine.order).toEqual(['start virtio', 'keepTpm', 'start vga'])
  })

  it('calls itself off as Turn on does, still on virtio, and is refused as Turn on is', async () => {
    const r = make({ device: 'virtio' })
    await r.keeper.wake()
    r.machine.refuses = true
    await expect(r.keeper.downgrade(() => false)).rejects.toThrow(SHUTDOWN_REFUSED)
    expect(r.display.file).toBe('virtio')
    expect(r.machine.ranOn).toBe('virtio')
    await expect(r.keeper.downgrade(() => true)).rejects.toThrow(HELD)
  })

  it('then Turn on again goes through every step once more', async () => {
    const r = make({ device: 'virtio' })
    await r.keeper.downgrade(() => false)
    await r.keeper.upgrade(() => false)
    expect(r.display.file).toBe('virtio')
    expect(r.machine.ranOn).toBe('virtio')
  })
})

describe("the state's display", () => {
  it('says the device, the size Windows has, his choice, and that only virtio resizes; nothing before setup', async () => {
    const r = make({ device: 'virtio' })
    r.display.size = { width: 2560, height: 1600, scale: 200 }
    r.display.pick = { screen: 'fit', detail: 'faster' }
    expect(r.keeper.state().display).toEqual({ device: 'virtio', width: 2560, height: 1600, scale: 200, fit: true, detail: 'faster', canResize: true })
    r.display.pick = { screen: '1920x1200', detail: 'sharp' }
    r.keeper.refresh()
    expect(r.pushes.at(-1)?.display).toMatchObject({ fit: false, detail: 'sharp' })
    expect(make().keeper.state().display).toEqual({ device: 'vga', width: 1280, height: 800, scale: 100, fit: true, detail: 'sharp', canResize: false })
    expect(make({ disk: false }).keeper.state().display).toBeUndefined()
    expect(make({ liveResize: false }).keeper.state().display).toBeUndefined()
  })
})

describe('after a restart of the service', () => {
  afterEach(() => vi.useRealTimers())

  it('wakes a machine that was awake at the stop, once, 25 s after the start, saying so; the record is read once', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const r = make({ awakeAtStop: true })
    expect(r.keeper.state().state).toBe('asleep')
    const done = r.keeper.wakeAfterStop()
    expect(r.afterStop.record).toBe(false)
    await vi.advanceTimersByTimeAsync(AFTER_STOP_WAKE_MS - 1)
    expect(r.machine.starts).toBe(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(await done).toMatchObject({ state: 'awake', error: null })
    expect(r.machine.starts).toBe(1)
    // the usual wake, under its own words throughout: the service copied in after an update says no other step
    expect(r.guest.log).toEqual(['ready', 'install', 'start-service', 'open-door'])
    expect(r.pushes.filter((p) => p.state === 'waking').map((p) => p.step)).toEqual([WAKING_AFTER_UPDATE_WORDS])
    expect(WAKING_AFTER_UPDATE_WORDS).toBe('Waking after an update…')
    // a second start of Work finds no record
    expect(await r.keeper.wakeAfterStop(0)).toBeNull()
    expect(r.afterStop.reads).toBe(2)
  })

  it('leaves it asleep with no record: a machine asleep at the stop stays asleep', async () => {
    const r = make()
    expect(await r.keeper.wakeAfterStop(0)).toBeNull()
    expect(r.machine.starts).toBe(0)
    expect(r.keeper.state().state).toBe('asleep')
  })

  it('his Sleep wins: a hold from before the restart keeps it asleep, and his Wake lifts the hold', async () => {
    const r = make({ awakeAtStop: true, held: true })
    expect(r.keeper.state()).toMatchObject({ state: 'asleep', heldAsleep: true })
    expect(await r.keeper.wakeAfterStop(0)).toBeNull()
    expect(r.machine.starts).toBe(0)
    await r.keeper.wake()
    expect(r.afterStop.held).toBe(false)
  })

  it('his Sleep is kept in the file that outlasts the service; the idle sleep is not', async () => {
    const r = make()
    await r.keeper.wake()
    await r.keeper.sleep()
    expect(r.afterStop.held).toBe(true)
    await r.keeper.wake()
    await r.keeper.sleep('idle')
    expect(r.afterStop.held).toBe(false)
  })

  it('his Sleep asked before the timer, or a wake that already ran, leaves it as it is', async () => {
    const a = make({ awakeAtStop: true })
    const waiting = a.keeper.wakeAfterStop(0)
    await a.keeper.sleep()
    expect(await waiting).toBeNull()
    expect(a.machine.starts).toBe(0)
    expect(a.keeper.state().heldAsleep).toBe(true)

    const b = make({ awakeAtStop: true })
    const later = b.keeper.wakeAfterStop(0)
    await b.keeper.wake()
    expect(await later).toBeNull()
    expect(b.machine.starts).toBe(1)
  })

  it('a hold left on a machine that runs is from before, and goes', () => {
    const r = make({ up: true, held: true })
    expect(r.keeper.state()).toMatchObject({ state: 'awake', heldAsleep: false })
    expect(r.afterStop.held).toBe(false)
  })

  it('a failed wake says its cause in the state and is never tried again', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const r = make({ awakeAtStop: true })
    r.machine.start = async () => {
      r.machine.starts++
      throw new Error('QEMU did not stay up')
    }
    const done = r.keeper.wakeAfterStop()
    await vi.advanceTimersByTimeAsync(AFTER_STOP_WAKE_MS)
    expect(await done).toMatchObject({ state: 'asleep', error: 'QEMU did not stay up' })
    await vi.advanceTimersByTimeAsync(10 * AFTER_STOP_WAKE_MS)
    expect(r.machine.starts).toBe(1)
    expect(r.logs.some((l) => l.includes('the wake after the restart failed: QEMU did not stay up'))).toBe(true)
  })

  it('the idle timer still applies to the machine it woke, and never is never', async () => {
    const r = make({ awakeAtStop: true })
    await r.keeper.wakeAfterStop(0)
    r.advance(29 * 60_000)
    r.keeper.tick()
    expect(r.guest.log).not.toContain('hibernate')
    r.advance(60_000)
    r.keeper.tick()
    await r.keeper.sleep('idle')
    expect(r.guest.log.filter((l) => l === 'hibernate')).toHaveLength(1)
    expect(r.keeper.state()).toMatchObject({ state: 'asleep', heldAsleep: false })

    const n = make({ awakeAtStop: true })
    n.keeper.settings('never')
    await n.keeper.wakeAfterStop(0)
    n.advance(30 * 3600_000)
    n.keeper.tick()
    for (let i = 0; i < 20; i++) await new Promise((done) => setTimeout(done, 0))
    expect(n.guest.log).not.toContain('hibernate')
    expect(n.keeper.state().state).toBe('awake')
  })

  it('Work turned off before the timer: no wake', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const r = make({ awakeAtStop: true })
    const done = r.keeper.wakeAfterStop()
    r.keeper.close()
    expect(await done).toBeNull()
    await vi.advanceTimersByTimeAsync(AFTER_STOP_WAKE_MS)
    expect(r.machine.starts).toBe(0)
  })
})

describe('after a restart, by the keeper\'s own mark', () => {
  let run = ''
  afterEach(() => rmSync(run, { recursive: true, force: true }))
  const fresh = () => (run = mkdtempSync(join(tmpdir(), 'winvm-run-')))

  it('the deploy of 2026-11-25: woken under one build, hibernated by that build\'s watcher with no record, woken by the next', async () => {
    fresh()
    const before = make({ run })
    await before.keeper.wake()
    expect(existsSync(join(run, AWAKE_MARK))).toBe(true)
    // the stop: the watcher QEMU started with hibernates it and writes no record; the server is gone and its keeper sees nothing
    before.machine.up = false
    const after = make({ run, up: false })
    expect(after.keeper.state().state).toBe('asleep')
    expect(await after.keeper.wakeAfterStop(0)).toMatchObject({ state: 'awake', error: null })
    expect(after.machine.starts).toBe(1)
    expect(after.pushes.find((p) => p.state === 'waking')?.step).toBe(WAKING_AFTER_UPDATE_WORDS)
    // awake again, so marked again for the next stop
    expect(existsSync(join(run, AWAKE_MARK))).toBe(true)
  })

  it('reads the mark once: a second start after the same stop wakes nothing', async () => {
    fresh()
    awakeMark(run).set(true)
    expect(takeAwakeAtStop(run, false)).toBe(true)
    const r = make({ run })
    expect(await r.keeper.wakeAfterStop(0)).toBeNull()
    expect(r.machine.starts).toBe(0)
  })

  it('his Sleep and the idle sleep take the mark away, so the next start leaves it asleep', async () => {
    fresh()
    const a = make({ run })
    await a.keeper.wake()
    await a.keeper.sleep()
    expect(existsSync(join(run, AWAKE_MARK))).toBe(false)
    expect(await make({ run }).keeper.wakeAfterStop(0)).toBeNull()
    const b = make({ run })
    await b.keeper.wake()
    await b.keeper.sleep('idle')
    const c = make({ run })
    expect(await c.keeper.wakeAfterStop(0)).toBeNull()
    expect(c.machine.starts).toBe(0)
  })

  it('a keeper beside a running machine (Work off and on, a deploy\'s trial before the stop) wakes nothing and leaves the mark', async () => {
    fresh()
    const r = make({ run, up: true })
    expect(existsSync(join(run, AWAKE_MARK))).toBe(true)
    expect(await r.keeper.wakeAfterStop(0)).toBeNull()
    expect(existsSync(join(run, AWAKE_MARK))).toBe(true)
  })
})
