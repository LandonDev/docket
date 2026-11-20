import { randomBytes } from 'node:crypto'
import { WAKING_WORDS, WINVM_POINTS_KEPT, type WinvmPoint, type WinvmSleepAfter, type WinvmState, type WinvmStateName } from '@shared/contract-work-winvm'
import type { PointStore } from './points'
import { psQuote } from './machine/guest'
import { DOOR_PORT, SETUP_LOG, setupScript } from './setup'

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
  /** sha256 of the service in the guest; null when it has none */
  serviceHash(): Promise<string | null>
  /** copies the box's service in over the guest's; its version */
  installService(exe: string): Promise<string>
  /** starts the logon task's door on tcuser's desktop unless it runs */
  startService(): Promise<void>
  openDoor(socket: string, guestPort: number): Promise<DoorLink>
  /** knocks with the token; true when the door kept the connection */
  knock(socket: string, token: string): Promise<boolean>
  /** copies a file under tcuser's profile (`rel`, forward slashes) to `local` over the forward's connection */
  fetch(rel: string, local: string): Promise<void>
  /** copies `local` to a file under tcuser's profile (`rel`, forward slashes) over the same connection */
  send(local: string, rel: string): Promise<void>
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
  sleepAfter(): WinvmSleepAfter
  setSleepAfter(v: WinvmSleepAfter): void
  /** the restore points (points.ts) */
  points: PointStore
  push(state: WinvmState): void
  /** the points changed */
  pushPoints?(points: WinvmPoint[]): void
  log(line: string): void
  now?: () => number
  /** how long a wake waits for Windows; default 5 min, setup's first boot and restart 10 min */
  timeouts?: Partial<Timeouts>
}

interface Timeouts {
  /** one run of the setup script */
  setupScript: number
  ready: number
  setupReady: number
  hibernate: number
  knock: number
  knockEvery: number
}
const TIMEOUTS: Timeouts = { setupScript: 240_000, ready: 300_000, setupReady: 600_000, hibernate: 180_000, knock: 30_000, knockEvery: 1000 }

export const SLEEP_AFTER_MS: Record<WinvmSleepAfter, number | null> = { '15m': 15 * 60_000, '30m': 30 * 60_000, '2h': 120 * 60_000, never: null }

export const NOT_SET_UP = 'The Windows VM is not set up. Set it up in Settings → Work.'
export const NO_SERVICE = "This box's build has no tc-computer.exe for the Windows VM."
export const NO_DOOR = 'The service in the Windows VM did not answer.'
export const NOT_HIBERNATED = 'Windows did not hibernate.'
export const ONLY_ASLEEP = 'Restore points are made and used only while the Windows VM sleeps. Put it to sleep first.'
export const NO_POINT = 'That restore point is gone.'
export const BEFORE_SETUP = 'Before setup'

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
    return { state: this.name, step: this.step, error: this.error, cannot: this.d.machine.cannot(), sleepAfter: this.d.sleepAfter(), since: this.since }
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

  /** A PowerShell script as the guest's admin: the file tools' checks (files.ts). */
  admin(script: string): Promise<string> {
    return this.d.guest.admin(script)
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
      this.set('waking', WAKING_WORDS, null)
      try {
        if (!this.d.machine.running()) await this.d.machine.start()
        await this.d.guest.ready(this.t.ready)
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

  /** The door for the box's service of the VM (B5): wakes the machine first. */
  async door(): Promise<{ socket: string; token: string }> {
    await this.wake()
    const token = this.d.token.get()
    if (!token) throw new Error(NOT_SET_UP)
    return { socket: this.d.doorSocket, token }
  }

  /** Hibernates the guest. Resolves once QEMU has exited and the TPM is kept. */
  sleep(): Promise<WinvmState> {
    return this.serial(() => this.hibernate())
  }

  /** The sleep itself, inside a change already running. */
  private async hibernate(): Promise<WinvmState> {
    if (!this.d.machine.running()) {
      if (this.name === 'awake') this.set('asleep', null)
      return this.state()
    }
    this.set('going-to-sleep', 'Hibernating Windows', null)
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
   */
  setup(): Promise<WinvmState> {
    return this.serial(async () => {
      const cannot = this.d.machine.cannot()
      if (cannot) throw new Error(cannot)
      try {
        if (this.d.machine.hasDisk()) {
          // the keeper's own point before it changes the guest's setup, taken asleep
          if (this.d.machine.running()) await this.hibernate()
          this.set('setting-up', 'Keeping a restore point', null)
          await this.keepPoint(BEFORE_SETUP, 'keeper')
        } else {
          this.set('setting-up', 'Making the disk', null)
          await this.d.machine.makeDisk()
        }
        this.set('setting-up', 'Starting Windows')
        this.closeLink()
        if (!this.d.machine.running()) await this.d.machine.start()
        await this.d.guest.ready(this.t.setupReady)
        let token = this.d.token.get()
        if (!token) this.d.token.set((token = randomBytes(32).toString('hex')))
        this.set('setting-up', 'Setting Windows up')
        this.d.log(`winvm: setup: ${(await this.setupScript(token)).split('\n').filter((l) => l.startsWith('step:')).join(', ')}`)
        this.set('setting-up', 'Copying the service in')
        await this.serviceUp()
        this.set('setting-up', 'Restarting Windows')
        await this.d.guest.reboot()
        await this.d.guest.ready(this.t.setupReady)
        this.set('setting-up', 'Opening the door')
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
    this.d.log('winvm: idle; hibernating')
    this.sleep().catch((e) => this.d.log(`winvm: idle hibernate failed: ${words(e)}`))
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
      if (this.name === 'waking') this.set('waking', 'Copying the service in')
      this.d.log(`winvm: copied the service in (version ${await this.d.guest.installService(exe)})`)
    }
    await this.d.guest.startService()
  }

  /** The one SSH connection and its forward, then the knock: the door keeps a connection that brings the token. */
  private async openDoor(): Promise<void> {
    const token = this.d.token.get()
    if (!token) throw new Error(NOT_SET_UP)
    this.closeLink()
    const link = await this.d.guest.openDoor(this.d.doorSocket, DOOR_PORT)
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
