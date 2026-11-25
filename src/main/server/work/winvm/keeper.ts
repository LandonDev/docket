import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { LIVE_RESIZE_WORDS, WAKING_WORDS, WINVM_POINTS_KEPT, type WinvmDetail, type WinvmDevice, type WinvmDisplay, type WinvmPoint, type WinvmScreen, type WinvmSleepAfter, type WinvmState, type WinvmStateName } from '@shared/contract-work-winvm'
import type { PointStore } from './points'
import { psQuote } from './machine/guest'
import { VGA_DEFAULT } from './machine/qemu'
import { DOOR_PORT, SETUP_LOG, setupScript } from './setup'
import { ADAPTERS_SCRIPT, CURSOR_SCRIPT, DRIVER_FILES, IBEAM_FILE, stageScript, VIRTIO_ADAPTER } from './liveResize'

/**
 * The keeper of the box's standing Windows machine (docs/agents/work-winvm.md):
 * the one thing that starts it, wakes it, sets it up and puts it to sleep.
 * Sleep is hibernate, so the apps and sign-ins are there at the next wake.
 * One change runs at a time: a wake asked while it goes to sleep waits for the
 * sleep, then wakes it.
 *
 * The machine and the guest are interfaces, so the states can be proven over
 * fakes (keeper.test.ts); standing.ts and sshGuest.ts are the real ones.
 */

export interface VmMachine {
  /** why this host cannot have the VM; null when it can */
  cannot(): string | null
  hasDisk(): boolean
  running(): boolean
  /** makes the lasting disk from the base image */
  makeDisk(): Promise<void>
  /** starts the machine, resuming a hibernated guest, with its stop watcher beside it */
  start(): Promise<void>
  /** waits for QEMU to exit; false when it still runs at the timeout */
  stopped(timeoutMs: number): Promise<boolean>
  /** after QEMU has exited: keeps the TPM's live state in the machine's lasting copy */
  keepTpm(): Promise<void>
  /** keys pressed on the machine's own keyboard (QEMU's key names): they reach what takes no input from a program in the guest */
  key?(...qcodes: string[]): Promise<void>
  /** QMP's screendump of the guest's display: its size, or null when it is empty */
  shows?(): Promise<{ width: number; height: number } | null>
  /** pulls the plug: only for a machine that will not shut down and is about to go back to a restore point */
  forceStop?(): Promise<void>
}

/** The SSH connection that carries the forward to the door. */
export interface DoorLink {
  close(): void
  closed: Promise<void>
}

export interface VmGuest {
  /** SSH answers and tcuser's desktop is up */
  ready(timeoutMs: number, signal?: AbortSignal): Promise<void>
  /** a PowerShell script as the admin; its output, or a throw when it failed or ran past `timeoutMs` */
  admin(script: string, timeoutMs?: number): Promise<string>
  hibernate(): Promise<void>
  /** restarts Windows and returns once it has gone down */
  reboot(): Promise<void>
  /** a clean, full shutdown (`shutdown /s /full /t 0`): never a hibernate, never forced, so an app may refuse it */
  shutdown(): Promise<void>
  /** sha256 of the service in the guest; null when it has none */
  serviceHash(): Promise<string | null>
  /** copies the box's service in over the guest's; its version */
  installService(exe: string): Promise<string>
  /** starts the logon task's door on tcuser's desktop unless it runs */
  startService(): Promise<void>
  /** `also`: more forwards on the same connection (the helper's door, helperDoor.ts) */
  openDoor(socket: string, guestPort: number, also?: readonly { socket: string; port: number }[]): Promise<DoorLink>
  /** knocks with the token; true when the door kept the connection */
  knock(socket: string, token: string): Promise<boolean>
  /** copies a file under tcuser's profile (`rel`, forward slashes) to `local` over the forward's connection */
  fetch(rel: string, local: string): Promise<void>
  /** copies `local` to a file under tcuser's profile (`rel`, forward slashes) over the same connection */
  send(local: string, rel: string): Promise<void>
  /** copies `local` into the admin's profile as `name`: content too large for a script's stdin */
  upload(local: string, name: string): Promise<void>
}

export interface KeeperDeps {
  machine: VmMachine
  guest: VmGuest
  /** the box's own tc-computer.exe (serviceBin.ts); null when this build has none */
  serviceExe(): string | null
  hashFile(path: string): string
  /** the door's token, kept on the box; made at the first setup */
  token: { get(): string | null; set(token: string): void }
  /** the unix socket the SSH forward to the door listens on */
  doorSocket: string
  /** other doors of the guest carried by the same connection: each a unix socket here and a loopback port there */
  forwards?: readonly { socket: string; port: number }[]
  sleepAfter(): WinvmSleepAfter
  setSleepAfter(v: WinvmSleepAfter): void
  /** the restore points (points.ts) */
  points: PointStore
  push(state: WinvmState): void
  /** the points changed */
  pushPoints?(points: WinvmPoint[]): void
  log(line: string): void
  now?: () => number
  /** a save of ours there that OneDrive has not uploaded yet (files/uploads.ts): idle, the machine still stays awake for it */
  owed?(): boolean
  /** keeps the guest's picture just before it hibernates (still.ts); a failure or a wait past STILL_WAIT_MS never holds the sleep */
  beforeSleep?(): Promise<void>
  /** how long a wake waits for Windows; default 5 min, setup's first boot and restart 10 min */
  timeouts?: Partial<Timeouts>
  /** live resize (liveResize.ts); a keeper without it offers none */
  display?: KeeperDisplay
}

/** The guest's display, as the box keeps it beside the run (guestScreen.ts), and what live resize needs of the box. */
export interface KeeperDisplay {
  /** the device the run's machine.json names */
  device(): WinvmDevice
  /** written before a start on a device, never after */
  setDevice(device: WinvmDevice): void
  /** the size and scale the guest last took (screen.json); null before one */
  screen(): { width: number; height: number; scale?: number } | null
  setScreen(size: { width: number; height: number }): void
  /** his choice: Fit or a size, Sharp or Faster */
  choice(): { screen: WinvmScreen; detail: WinvmDetail }
  /** the virtio-win tool's driver folder on the box, installed first when it is missing; `progress` hears its lines */
  driver(progress: (line: string) => void): Promise<string>
  /** the box's colour I-beam (resources/winvm/tc-ibeam.cur) */
  cursor(): string
}

interface Timeouts {
  /** one run of the setup script */
  setupScript: number
  ready: number
  setupReady: number
  hibernate: number
  knock: number
  knockEvery: number
  /** a clean shutdown before live resize's start: past it, the move is called off */
  shutdown: number
}
const TIMEOUTS: Timeouts = { setupScript: 240_000, ready: 300_000, setupReady: 600_000, hibernate: 180_000, knock: 30_000, knockEvery: 1000, shutdown: 180_000 }

export const SLEEP_AFTER_MS: Record<WinvmSleepAfter, number | null> = { '15m': 15 * 60_000, '30m': 30 * 60_000, '2h': 120 * 60_000, never: null }

export const NOT_SET_UP = 'The Windows VM is not set up. Set it up in Settings → Work.'
export const NO_SERVICE = "This box's build has no tc-computer.exe for the Windows VM."
export const NO_DOOR = 'The service in the Windows VM did not answer.'
export const NOT_HIBERNATED = 'Windows did not hibernate.'
export const ONLY_ASLEEP = 'Restore points are made and used only while the Windows VM sleeps. Put it to sleep first.'
export const NO_POINT = 'That restore point is gone.'
export const BEFORE_SETUP = 'Before setup'
export const HELD = 'A thread is using the Windows VM. Stop it or take over first.'
export const RESTARTING_WORDS = 'Restarting Windows'
export const DRIVES = 'You are driving the Windows VM. Hand it back first.'
export const OWED = 'Windows is still sending a saved file to OneDrive. Try again in a minute.'
export const NO_LIVE_RESIZE = 'This host has no live resize.'
/** Windows did not stop within the shutdown's wait: an app holds unsaved work. Nothing new is started. */
export const SHUTDOWN_REFUSED = 'An app in Windows kept it from restarting. Save your work and try again.'
export const BEFORE_LIVE_RESIZE = 'Before live resize'
/** How many wakes the usual wake is the median of. */
export const WAKES_KEPT = 5
/** The longest a sleep waits for its picture. */
const STILL_WAIT_MS = 3000

/** The median of a few numbers; null of none. */
export function median(xs: readonly number[]): number | null {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m]! : Math.round((s[m - 1]! + s[m]!) / 2)
}

const words = (e: unknown): string => (e instanceof Error ? e.message : String(e))

export class Keeper {
  private name: WinvmStateName
  private step: string | null = null
  private error: string | null = null
  private since: number
  private queue: Promise<unknown> = Promise.resolve()
  /** changes asked and not yet done: a wake may answer at once only when none is */
  private pending = 0
  private link: DoorLink | null = null
  private lastUse: number
  private viewers = 0
  private driving = false
  private closedDown = false
  /** how long the last wakes took, newest last (WAKES_KEPT of them) */
  private wakes: number[] = []
  /** asleep by a person's Sleep: the page waits for his Wake */
  private heldAsleep = false
  /** on virtio, whether this keeper has seen the hardware pointer on: a service stopped before step 6 is finished at the next wake */
  private cursorChecked = false
  private readonly t: Timeouts

  constructor(private readonly d: KeeperDeps) {
    this.t = { ...TIMEOUTS, ...d.timeouts }
    this.since = this.now()
    this.lastUse = this.now()
    // after a box restart the machine sleeps until its next use; a keeper started beside a running one takes it as awake
    this.name = d.machine.cannot() || !d.machine.hasDisk() ? 'none' : d.machine.running() ? 'awake' : 'asleep'
  }

  private now(): number {
    return this.d.now?.() ?? Date.now()
  }

  state(): WinvmState {
    const display = this.displayNow()
    return { state: this.name, step: this.step, error: this.error, cannot: this.d.machine.cannot(), sleepAfter: this.d.sleepAfter(), since: this.since, wakeMs: median(this.wakes), heldAsleep: this.heldAsleep && this.name === 'asleep', ...(display ? { display } : {}) }
  }

  /** The guest's screen and his choice; none before it is set up. Only virtio takes a new size while it runs. */
  private displayNow(): WinvmDisplay | null {
    const d = this.d.display
    if (!d || this.name === 'none') return null
    const device = d.device()
    const size: { width: number; height: number; scale?: number } = d.screen() ?? VGA_DEFAULT
    const choice = d.choice()
    return { device, width: size.width, height: size.height, scale: size.scale ?? 100, fit: choice.screen === 'fit', detail: choice.detail, canResize: device === 'virtio' }
  }

  /** His screen choice changed (index.ts keeps it): the state says so. */
  refresh(): void {
    const state = this.state()
    this.d.push(state)
    for (const fn of [...this.stateListeners]) fn(state)
  }

  private readonly stateListeners = new Set<(state: WinvmState) => void>()

  /** Hears every change of state: the VM's service stops with the machine (vm.ts). */
  onState(fn: (state: WinvmState) => void): () => void {
    this.stateListeners.add(fn)
    return () => this.stateListeners.delete(fn)
  }

  private set(name: WinvmStateName, step: string | null = null, error: string | null = this.error): void {
    const changed = name !== this.name
    this.name = name
    this.step = step
    this.error = error
    if (changed) this.since = this.now()
    // coming awake (a setup, a wake, a failed setup that left it running) is a use: the idle clock starts now, not
    // at the keeper's own start, which a box's service may have had hours before (1.0.356 hibernated a minute after setup)
    if (changed && name === 'awake') this.lastUse = this.now()
    const state = this.state()
    this.d.push(state)
    for (const fn of [...this.stateListeners]) fn(state)
  }

  /** A picture of the service's, copied home over the door's connection (door.ts). */
  fetch(rel: string, local: string): Promise<void> {
    return this.d.guest.fetch(rel, local)
  }

  /** A file into tcuser's profile over the door's connection (files.ts). */
  send(local: string, rel: string): Promise<void> {
    return this.d.guest.send(local, rel)
  }

  /** A file into the admin's profile: the helper's source on its way to csc (helperDoor.ts). */
  upload(local: string, name: string): Promise<void> {
    return this.d.guest.upload(local, name)
  }

  /** A PowerShell script as the guest's admin: the file tools' checks (files.ts). */
  admin(script: string, timeoutMs?: number): Promise<string> {
    return this.d.guest.admin(script, timeoutMs)
  }

  /** Keys from the machine's own keyboard, while it is awake: Windows' security prompts take them where they take no program's click (office/vm/signin.ts). */
  async key(...qcodes: string[]): Promise<void> {
    if (this.name !== 'awake' || !this.d.machine.key) throw new Error('The Windows VM is not awake.')
    await this.d.machine.key(...qcodes)
  }

  /** One change at a time, in the order asked. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    this.pending++
    const run = () => fn().finally(() => this.pending--)
    const next = this.queue.then(run, run)
    this.queue = next.catch(() => {})
    return next
  }

  /** A thread's call, a viewer or his driving: the machine is in use now. */
  touch(): void {
    this.lastUse = this.now()
  }

  /** How many watch its picture (B7); while any do, it does not sleep. */
  setViewers(n: number): void {
    this.viewers = Math.max(0, n)
    this.touch()
  }

  /** Whether he drives it (B8); while he does, it does not sleep. */
  setDriving(on: boolean): void {
    this.driving = on
    this.touch()
  }

  settings(sleepAfter?: WinvmSleepAfter): { sleepAfter: WinvmSleepAfter } {
    if (sleepAfter !== undefined && sleepAfter !== this.d.sleepAfter()) {
      this.d.setSleepAfter(sleepAfter)
      this.d.push(this.state())
    }
    return { sleepAfter: this.d.sleepAfter() }
  }

  /** Wakes the machine (a thread's first call, his Wake press) and opens the door. Resolves once it is awake. */
  wake(): Promise<WinvmState> {
    this.touch()
    if (this.name === 'awake' && this.link && this.pending === 0) return Promise.resolve(this.state())
    return this.serial(async () => {
      this.touch()
      if (this.name === 'awake' && this.link) return this.state()
      const cannot = this.d.machine.cannot()
      if (cannot) throw new Error(cannot)
      if (!this.d.machine.hasDisk()) throw new Error(NOT_SET_UP)
      this.heldAsleep = false
      const began = this.now()
      // only a wake from sleep is a wake to count: a door opened again on a running machine says nothing of one
      const cold = !this.d.machine.running()
      this.set('waking', WAKING_WORDS, null)
      try {
        if (cold) await this.d.machine.start()
        await this.d.guest.ready(this.t.ready)
        await this.serviceUp()
        await this.openDoor()
        await this.cursorOnce()
        this.touch()
        if (cold) this.wakes = [...this.wakes, this.now() - began].slice(-WAKES_KEPT)
        this.set('awake', null, null)
        return this.state()
      } catch (e) {
        this.fail(e)
        throw e
      }
    })
  }

  /** The door for the box's service of the VM (B5): wakes the machine first. */
  async door(): Promise<{ socket: string; token: string }> {
    await this.wake()
    const token = this.d.token.get()
    if (!token) throw new Error(NOT_SET_UP)
    return { socket: this.d.doorSocket, token }
  }

  /** Hibernates the guest. Resolves once QEMU has exited and the TPM is kept. `by`: a person's press holds it asleep until his Wake; the idle sleep does not. */
  sleep(by: 'person' | 'idle' = 'person'): Promise<WinvmState> {
    return this.serial(async () => {
      this.heldAsleep = by === 'person'
      return this.hibernate()
    })
  }

  /**
   * Restarts Windows cleanly through its own shutdown (`shutdown /r`, never forced): the guest's apps are asked to
   * close, so one that holds unsaved work keeps it from going down rather than losing it. Refused while a thread
   * holds the machine (`held`). Resolves once the door is open again.
   */
  restart(held: () => boolean): Promise<WinvmState> {
    if (held()) return Promise.reject(new Error(HELD))
    return this.serial(async () => {
      if (held()) throw new Error(HELD)
      if (this.name !== 'awake' || !this.d.machine.running()) throw new Error('The Windows VM is not awake.')
      this.set('waking', RESTARTING_WORDS, null)
      this.closeLink()
      try {
        await this.d.guest.reboot()
        await this.d.guest.ready(this.t.setupReady)
        await this.d.guest.startService()
        await this.openDoor()
        this.touch()
        this.set('awake', null, null)
        return this.state()
      } catch (e) {
        this.fail(e)
        throw e
      }
    })
  }

  /** The sleep itself, inside a change already running. */
  private async hibernate(): Promise<WinvmState> {
    if (!this.d.machine.running()) {
      if (this.name === 'awake') this.set('asleep', null)
      return this.state()
    }
    this.set('going-to-sleep', 'Hibernating Windows', null)
    // the desk as he leaves it: the page shows it washed back while it sleeps
    if (this.d.beforeSleep) await Promise.race([this.d.beforeSleep().catch((e) => this.d.log(`winvm: the picture at sleep was not kept: ${words(e)}`)), new Promise((r) => setTimeout(r, STILL_WAIT_MS))])
    this.closeLink()
    try {
      await this.d.guest.hibernate()
      if (!(await this.d.machine.stopped(this.t.hibernate))) throw new Error(NOT_HIBERNATED)
      await this.d.machine.keepTpm()
      this.set('asleep', null, null)
      return this.state()
    } catch (e) {
      this.fail(e)
      throw e
    }
  }

  points(): WinvmPoint[] {
    return this.d.points.list()
  }

  /** A restore point of the sleeping machine; past three, the oldest goes first. */
  savePoint(name?: string, by: WinvmPoint['by'] = 'owner'): Promise<WinvmPoint> {
    return this.serial(async () => {
      this.mustSleep()
      return this.keepPoint(name ?? 'Restore point', by)
    })
  }

  /** Puts the disk, the firmware variables and the TPM back as the point holds them. The machine stays asleep; its next wake resumes the point. */
  restorePoint(id: string): Promise<WinvmState> {
    return this.serial(async () => {
      this.mustSleep()
      const point = this.d.points.list().find((p) => p.id === id)
      if (!point) throw new Error(NO_POINT)
      this.set('asleep', `Going back to ${point.name}`, null)
      try {
        await this.d.points.restore(id)
        this.d.log(`winvm: went back to the restore point ${point.name} of ${new Date(point.at).toISOString()}`)
        this.set('asleep', null, null)
        return this.state()
      } catch (e) {
        this.set('asleep', null, words(e))
        throw e
      }
    })
  }

  deletePoint(id: string): Promise<WinvmPoint[]> {
    return this.serial(async () => {
      this.mustSleep()
      if (!this.d.points.list().some((p) => p.id === id)) throw new Error(NO_POINT)
      await this.d.points.remove(id)
      return this.pointsChanged()
    })
  }

  private mustSleep(): void {
    const cannot = this.d.machine.cannot()
    if (cannot) throw new Error(cannot)
    if (!this.d.machine.hasDisk()) throw new Error(NOT_SET_UP)
    if (this.d.machine.running() || this.name !== 'asleep') throw new Error(ONLY_ASLEEP)
  }

  private async keepPoint(name: string, by: WinvmPoint['by']): Promise<WinvmPoint> {
    const kept = this.d.points.list()
    for (const old of kept.slice(WINVM_POINTS_KEPT - 1)) await this.d.points.remove(old.id)
    const point: WinvmPoint = { id: randomBytes(6).toString('hex'), name, at: this.now(), by }
    await this.d.points.save(point)
    this.pointsChanged()
    return point
  }

  private pointsChanged(): WinvmPoint[] {
    const points = this.d.points.list()
    this.d.pushPoints?.(points)
    return points
  }

  /**
   * Makes the disk from the base image (unless it has one) and sets the guest up as the admin: the service,
   * its logon task, hibernate, no lock on resume, Windows Update, tcuser's policies. Then a restart, so the
   * policies hold from tcuser's logon, and the door is knocked: the service still runs under them.
   *
   * A new disk comes up on virtio-vga by itself (live resize): machine.json is written before its first start,
   * a cold boot of the base image, the driver bound during setup and taken at its restart, the hardware pointer
   * after it. A box that cannot have the driver sets it up on std VGA and says why in the log. A disk that
   * exists keeps the device it has.
   */
  setup(): Promise<WinvmState> {
    return this.serial(async () => {
      const cannot = this.d.machine.cannot()
      if (cannot) throw new Error(cannot)
      let driver: string | null = null
      try {
        if (this.d.machine.hasDisk()) {
          // the keeper's own point before it changes the guest's setup, taken asleep
          if (this.d.machine.running()) await this.hibernate()
          this.set('setting-up', 'Keeping a restore point', null)
          await this.keepPoint(BEFORE_SETUP, 'keeper')
        } else {
          this.set('setting-up', 'Making the disk', null)
          await this.d.machine.makeDisk()
          driver = await this.newDiskDriver()
        }
        this.set('setting-up', 'Starting Windows')
        this.closeLink()
        if (!this.d.machine.running()) await this.d.machine.start()
        await this.d.guest.ready(this.t.setupReady)
        let token = this.d.token.get()
        if (!token) this.d.token.set((token = randomBytes(32).toString('hex')))
        this.set('setting-up', 'Setting Windows up')
        this.d.log(`winvm: setup: ${(await this.setupScript(token)).split('\n').filter((l) => l.startsWith('step:')).join(', ')}`)
        if (driver) await this.stageDriver(driver, true)
        this.set('setting-up', "Copying TempCode's helper into Windows")
        await this.serviceUp()
        this.set('setting-up', 'Restarting Windows')
        await this.d.guest.reboot()
        await this.d.guest.ready(this.t.setupReady)
        this.set('setting-up', 'Connecting to Windows')
        await this.d.guest.startService()
        await this.openDoor()
        if (driver) await this.cursorOn()
        this.touch()
        this.set('awake', null, null)
        return this.state()
      } catch (e) {
        this.fail(e)
        throw e
      }
    })
  }

  /** A new disk's driver, and machine.json `virtio` before its first start; null leaves it on std VGA. */
  private async newDiskDriver(): Promise<string | null> {
    const d = this.d.display
    if (!d) return null
    this.set('setting-up', LIVE_RESIZE_WORDS.driver)
    try {
      const folder = await d.driver((line) => this.d.log(`winvm: virtio-win: ${line}`))
      d.setDevice('virtio')
      return folder
    } catch (e) {
      this.d.log(`winvm: the new disk is set up on std VGA, with no live resize: ${words(e)}`)
      return null
    }
  }

  /** Step 2 of live resize, and a new disk's setup: the driver and the I-beam copied in, the driver staged (`install`: bound to the device there now). */
  private async stageDriver(folder: string, install = false): Promise<void> {
    const d = this.d.display!
    for (const f of DRIVER_FILES) await this.d.guest.upload(join(folder, f), f)
    await this.d.guest.upload(d.cursor(), IBEAM_FILE)
    this.d.log(`winvm: live resize: ${(await this.d.guest.admin(stageScript({ install }), 120_000)).trim().split(/\r?\n/).slice(-3).join(' | ')}`)
  }

  /** Why live resize may not be turned on or off now; null when it may. */
  liveResizeRefusal(held: () => boolean): string | null {
    if (!this.d.display) return NO_LIVE_RESIZE
    const cannot = this.d.machine.cannot()
    if (cannot) return cannot
    if (!this.d.machine.hasDisk()) return NOT_SET_UP
    if (held()) return HELD
    if (this.driving) return DRIVES
    // the idle sleep waits for it too: a restart now would cut OneDrive's upload of his save
    if (this.d.owed?.()) return OWED
    return null
  }

  /**
   * Turn on live resize: moves Windows from std VGA to virtio-vga ("The standing VM" in the plan). The steps, each
   * said in the state as it runs: (1) the virtio-win tool installed on the box when missing; (2) awake, the driver
   * copied in and staged, tcuser's I-beam set; (3) a clean shutdown, called off when Windows has not stopped in 3
   * minutes (nothing new is started: it stays on std VGA); (4) the TPM kept, then a restore point of the stopped
   * machine, which records std VGA; (5) machine.json written `virtio`, and only then the start, checked over SSH and
   * by QMP's picture: a failed check goes back to the point by itself, std VGA with it; (6) the hardware pointer.
   * machine.json changes once, just before the one start on virtio: at any stop before it the guest last ran on
   * std VGA and the file says so; after it, both say virtio.
   */
  upgrade(held: () => boolean): Promise<WinvmState> {
    const no = this.liveResizeRefusal(held)
    if (no) return Promise.reject(new Error(no))
    return this.serial(async () => {
      const no = this.liveResizeRefusal(held)
      if (no) throw new Error(no)
      const d = this.d.display!
      if (d.device() === 'virtio') return this.state()
      const W = LIVE_RESIZE_WORDS
      try {
        this.set('setting-up', W.driver, null)
        const folder = await d.driver((line) => this.d.log(`winvm: virtio-win: ${line}`))
        this.set('setting-up', W.stage)
        if (!this.d.machine.running()) await this.d.machine.start()
        await this.d.guest.ready(this.t.ready)
        await this.stageDriver(folder)
        this.set('setting-up', W.restart)
        await this.shutDown()
        await this.d.machine.keepTpm()
        this.set('setting-up', W.point)
        const point = await this.keepPoint(BEFORE_LIVE_RESIZE, 'keeper')
        this.set('setting-up', W.start)
        d.setDevice('virtio')
        try {
          await this.d.machine.start()
          await this.d.guest.ready(this.t.setupReady)
          await this.onVirtio()
        } catch (e) {
          await this.backToPoint(point, e)
        }
        this.set('setting-up', W.cursor)
        await this.cursorOn()
        await this.serviceUp()
        await this.openDoor()
        this.touch()
        this.set('awake', null, null)
        return this.state()
      } catch (e) {
        this.fail(e)
        throw e
      }
    })
  }

  /**
   * Turn off live resize: a clean shutdown and a start on std VGA at 1280×800 (screen.json written to match).
   * Windows goes back to its Basic Display Driver by itself: viogpudo binds only the virtio device. A hibernated
   * guest is woken first, on the device it slept on, so it is never resumed on the other.
   */
  downgrade(held: () => boolean): Promise<WinvmState> {
    const no = this.liveResizeRefusal(held)
    if (no) return Promise.reject(new Error(no))
    return this.serial(async () => {
      const no = this.liveResizeRefusal(held)
      if (no) throw new Error(no)
      const d = this.d.display!
      if (d.device() === 'vga') return this.state()
      const W = LIVE_RESIZE_WORDS
      try {
        this.set('setting-up', W.restart, null)
        if (!this.d.machine.running()) await this.d.machine.start()
        await this.d.guest.ready(this.t.ready)
        await this.shutDown()
        await this.d.machine.keepTpm()
        this.set('setting-up', W.startVga)
        d.setDevice('vga')
        d.setScreen(VGA_DEFAULT)
        await this.d.machine.start()
        await this.d.guest.ready(this.t.setupReady)
        await this.serviceUp()
        await this.openDoor()
        this.touch()
        this.set('awake', null, null)
        return this.state()
      } catch (e) {
        this.fail(e)
        throw e
      }
    })
  }

  /** A clean shutdown, waited for; past the wait the move is called off and nothing new starts. */
  private async shutDown(): Promise<void> {
    this.closeLink()
    // SSH goes with Windows: the call's own end says nothing
    await this.d.guest.shutdown().catch((e) => this.d.log(`winvm: shutdown: ${words(e)}`))
    if (!(await this.d.machine.stopped(this.t.shutdown))) throw new Error(SHUTDOWN_REFUSED)
  }

  /** Step 5's check: Windows names the VirtIO GPU adapter, and QMP's picture has the desktop. */
  private async onVirtio(): Promise<void> {
    const adapters = await this.d.guest.admin(ADAPTERS_SCRIPT, 60_000)
    if (!adapters.includes(VIRTIO_ADAPTER)) throw new Error(`Windows did not take the VirtIO GPU adapter (it names ${adapters.trim().split(/\r?\n/).join(', ') || 'none'})`)
    if (this.d.machine.shows && !(await this.d.machine.shows())) throw new Error("QEMU's picture of Windows is empty")
  }

  /** Step 5 failed: the machine stopped, and the disk, firmware, TPM and std VGA put back as the point holds them. */
  private async backToPoint(point: WinvmPoint, cause: unknown): Promise<never> {
    this.set('setting-up', LIVE_RESIZE_WORDS.back)
    this.d.log(`winvm: live resize did not start (${words(cause)}): going back to ${point.name}`)
    if (this.d.machine.running()) {
      await this.d.guest.shutdown().catch(() => {})
      if (!(await this.d.machine.stopped(this.t.shutdown))) await this.d.machine.forceStop?.()
      if (!(await this.d.machine.stopped(10_000))) throw new Error(`Live resize did not start (${words(cause)}), and Windows did not stop.`)
    }
    await this.d.machine.keepTpm().catch((e) => this.d.log(`winvm: keeping the TPM failed: ${words(e)}`))
    await this.d.points.restore(point.id)
    throw new Error(`Live resize did not start (${words(cause)}). Windows is back as it was, from the restore point "${point.name}".`)
  }

  /** Step 6: the hardware pointer. A failure leaves the pointer in the picture and is tried again at the next wake. */
  private async cursorOn(): Promise<void> {
    try {
      await this.d.guest.admin(CURSOR_SCRIPT, 120_000)
      this.cursorChecked = true
    } catch (e) {
      this.d.log(`winvm: the hardware pointer did not turn on: ${words(e)}`)
    }
  }

  /** On virtio, once a keeper: the pointer of a move whose service stopped before step 6. */
  private async cursorOnce(): Promise<void> {
    if (this.cursorChecked || this.d.display?.device() !== 'virtio') return
    await this.cursorOn()
  }

  /** Every minute: hibernates an idle machine, and notices one that stopped by itself. */
  tick(): void {
    if (this.closedDown) return
    if (this.name === 'awake' && !this.d.machine.running()) {
      // Windows shut down or hibernated by itself (his Take over): keep its TPM, and it sleeps
      void this.serial(async () => {
        if (this.name !== 'awake' || this.d.machine.running()) return
        this.closeLink()
        await this.d.machine.keepTpm().catch((e) => this.d.log(`winvm: keeping the TPM failed: ${words(e)}`))
        this.set('asleep', null)
      })
      return
    }
    const after = SLEEP_AFTER_MS[this.d.sleepAfter()]
    if (this.name !== 'awake' || after === null || this.viewers > 0 || this.driving) return
    if (this.now() - this.lastUse < after) return
    // Asleep, OneDrive there uploads nothing: a write of ours still on its way to Teams holds the machine awake.
    if (this.d.owed?.()) return
    this.d.log('winvm: idle; hibernating')
    this.sleep('idle').catch((e) => this.d.log(`winvm: idle hibernate failed: ${words(e)}`))
  }

  /** Work turned off or the host closes: the forward goes; the machine is left as it is (the watcher covers a stop). */
  close(): void {
    this.closedDown = true
    this.closeLink()
  }

  private fail(e: unknown): void {
    this.closeLink()
    const name: WinvmStateName = this.d.machine.cannot() || !this.d.machine.hasDisk() ? 'none' : this.d.machine.running() ? 'awake' : 'asleep'
    this.set(name, null, words(e))
  }

  private closeLink(): void {
    const l = this.link
    this.link = null
    l?.close()
  }

  /**
   * The setup script, given SETUP_SCRIPT_MS and run once more when it does not finish: on a fresh guest it has
   * now and then hung before its first step, with nothing done, while Windows is busy after its first logon
   * (the rig runs of 2026-11-20). Every step is safe to run again. A last failure says the steps it reached.
   */
  private async setupScript(token: string): Promise<string> {
    const script = setupScript({ token, port: DOOR_PORT })
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.d.guest.admin(script, this.t.setupScript)
      } catch (e) {
        const reached = await this.d.guest.admin(`Get-Content -LiteralPath ${psQuote(SETUP_LOG)} -Tail 3 -ErrorAction SilentlyContinue`, 60_000).catch(() => '')
        this.d.log(`winvm: the setup script failed (attempt ${attempt}): ${words(e)}${reached.trim() ? `; it reached: ${reached.trim().split('\n').join(' | ')}` : ''}`)
        if (attempt >= 2) throw new Error(`${words(e)}${reached.trim() ? ` (it reached: ${reached.trim().split('\n').pop()})` : ' (it reached no step)'}`)
      }
    }
  }

  /** Copies the box's service in when the guest's differs from it (sha256 of the file), then starts its door. */
  private async serviceUp(): Promise<void> {
    const exe = this.d.serviceExe()
    if (!exe) throw new Error(NO_SERVICE)
    const want = this.d.hashFile(exe)
    if ((await this.d.guest.serviceHash()) !== want) {
      if (this.name === 'waking') this.set('waking', "Copying TempCode's helper into Windows")
      this.d.log(`winvm: copied the service in (version ${await this.d.guest.installService(exe)})`)
    }
    await this.d.guest.startService()
  }

  /** The one SSH connection and its forward, then the knock: the door keeps a connection that brings the token. */
  private async openDoor(): Promise<void> {
    const token = this.d.token.get()
    if (!token) throw new Error(NOT_SET_UP)
    this.closeLink()
    const link = await this.d.guest.openDoor(this.d.doorSocket, DOOR_PORT, this.d.forwards)
    this.link = link
    void link.closed.then(() => {
      if (this.link === link) this.link = null
    })
    const end = Date.now() + this.t.knock
    for (;;) {
      if (await this.d.guest.knock(this.d.doorSocket, token)) return
      if (Date.now() >= end) throw new Error(NO_DOOR)
      await new Promise((r) => setTimeout(r, this.t.knockEvery))
    }
  }
}
