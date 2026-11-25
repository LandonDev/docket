import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { ADMIN_USER, daemonEnv, rigConfig, rigPaths, scratchMachineRefusal, type Instance, type RigConfig, type RigPaths } from './machine/config'
import { keepLiveTpm, qemuPid, saveTpm, startQemu, startTpm, stopTpm } from './machine/daemons'
import { qmp, quit, screendump, sendKey } from './machine/qmp'
import { startWatcher } from './watcher'
import type { VmMachine } from './keeper'
import { QcowPoints, type PointStore } from './points'
import type { VmScreen } from './window'
import { readGuestScreen, readMachineDevice } from './guestScreen'

const run = promisify(execFile)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * The machine itself, through the rig's own code (machine/): the standing
 * instance's lasting disk on the base image, its TPM, and QEMU started with
 * the clean environment and through `sg kvm` as vm.ts starts it, so the
 * process guard leaves both alone. Unlike vm.ts, both start with the stop
 * signals blocked and a watcher beside them (watcher.ts). The rig instance
 * takes the same driver in the stop's proof.
 */
export class StandingMachine implements VmMachine {
  readonly c: RigConfig
  readonly p: RigPaths

  /** `screen`: QEMU's window and its display (window.ts); without one the machine runs with no window */
  constructor(
    instance: Instance = 'standing',
    env: NodeJS.ProcessEnv = process.env,
    private readonly screen: VmScreen | null = null,
    private readonly log: (line: string) => void = () => {},
    /** a bench's or a proof's scratch machine (qemu.ts `throwaway`), and QEMU arguments of its own for a run */
    private readonly scratch: { throwaway?: boolean; extra?: () => string[] } = {}
  ) {
    this.c = rigConfig(env, undefined, instance)
    this.p = rigPaths(this.c)
    // the throwaway's disk survives no crash of the box: never a machine outside a scratch root
    const why = scratch.throwaway || scratch.extra ? scratchMachineRefusal(env) : null
    if (why) throw new Error(`a throwaway machine needs a scratch root: ${why}`)
  }

  cannot(): string | null {
    if (process.platform !== 'linux') return 'The Windows VM runs on the box.'
    if (!existsSync(this.p.baseReady)) return 'The box has no Windows base image yet.'
    return null
  }

  hasDisk(): boolean {
    return existsSync(this.p.runDisk)
  }

  running(): boolean {
    return qemuPid(this.c, this.p) !== null
  }

  async makeDisk(): Promise<void> {
    if (this.running()) throw new Error('the machine is running')
    rmSync(this.p.run, { recursive: true, force: true })
    // a new disk has none of the old one's snapshots
    rmSync(this.pointsDir, { recursive: true, force: true })
    mkdirSync(this.p.run, { recursive: true })
    await run('qemu-img', ['create', '-q', '-f', 'qcow2', '-b', this.p.baseDisk, '-F', 'qcow2', this.p.runDisk], { env: daemonEnv() })
    copyFileSync(this.p.baseVars, this.p.runVars)
    writeFileSync(join(this.p.run, 'FROM'), 'base\n')
    writeFileSync(this.p.runId, randomBytes(8).toString('hex') + '\n')
  }

  async start(): Promise<void> {
    if (this.running()) return
    // a crash or the guest's own stop left the TPM newer than the run's copy: keep it, never roll it back
    await keepLiveTpm(this.c, this.p)
    // the device the guest last ran on, whatever the code's default is now
    const device = readMachineDevice(this.p.run)
    const boot = async (shown: Awaited<ReturnType<VmScreen['up']>>): Promise<number | null> => {
      await startTpm(this.c, this.p, existsSync(this.p.runTpm) ? this.p.runTpm : this.p.baseTpm, { blockStop: true })
      const machine = { disk: this.p.runDisk, vars: this.p.runVars, device, ...(shown ? { window: shown.window } : {}), ...(this.scratch.throwaway ? { throwaway: true } : {}), extra: this.scratch.extra?.() ?? [] }
      return startQemu(this.c, this.p, machine, { blockStop: true, ...(shown ? { env: shown.env } : {}) })
    }
    // the window's display first: QEMU opens its window as it starts
    // at the size the guest slept at: a resumed Windows keeps it (guestScreen.ts)
    const shown = (await this.screen?.up(readGuestScreen(this.p.run) ?? undefined)) ?? null
    let pid: number | null
    try {
      pid = await boot(shown)
      if (pid === null && shown) throw new Error('it did not stay up')
    } catch (e) {
      if (!shown || this.running()) throw e
      // a window QEMU will not open is no reason the machine cannot run: it runs without one
      await this.screen!.broke(`QEMU did not start with its window: ${(e as Error).message}`)
      this.log(`winvm: starting the machine with no window`)
      pid = await boot(null)
    }
    if (pid === null) throw new Error('QEMU did not stay up')
    const watcher = startWatcher(join(this.p.run, 'watcher.sh'), join(this.p.run, 'watcher.log'), {
      qemuPid: pid,
      qemuComm: this.c.process,
      ssh: { key: this.p.key, port: this.c.sshPort, knownHosts: this.p.knownHosts, user: ADMIN_USER },
      tpmPidFile: this.p.tpmPid,
      tpmState: this.p.tpmState,
      runTpm: this.p.runTpm,
      ...(this.screen?.pid ? { display: { pid: this.screen.pid, config: this.screen.config } } : {})
    })
    writeFileSync(join(this.p.run, 'watcher.pid'), `${watcher ?? ''}\n`)
  }

  async stopped(timeoutMs: number): Promise<boolean> {
    const end = Date.now() + timeoutMs
    while (this.running()) {
      if (Date.now() > end) return false
      await sleep(1000)
    }
    // QEMU's window went with it: its display and engines go too
    await this.screen?.down()
    return true
  }

  /** After QEMU has exited (the keeper's sleep, or the guest's own stop): the TPM kept, and the window's display ended. */
  async key(...qcodes: string[]): Promise<void> {
    await qmp(this.p.qmp, sendKey(...qcodes))
  }

  async keepTpm(): Promise<void> {
    await this.screen?.down()
    await saveTpm(this.p, this.p.runTpm)
  }

  /** QMP's screendump: the size of the PNG it wrote, or null when it wrote none (live resize's check after its start). */
  async shows(): Promise<{ width: number; height: number } | null> {
    const file = join(this.p.run, 'check.png')
    try {
      await qmp(this.p.qmp, screendump(file))
      return pngSize(readFileSync(file))
    } catch {
      return null
    } finally {
      rmSync(file, { force: true })
    }
  }

  /** Pulls the plug: for a proof's cleanup, and for a start on virtio that failed before it goes back to its restore point; never the keeper's sleep. */
  async forceStop(): Promise<void> {
    if (!this.running()) return stopTpm(this.p)
    await qmp(this.p.qmp, quit).catch(() => {})
    await this.stopped(10_000)
    const pid = qemuPid(this.c, this.p)
    if (pid !== null) process.kill(pid, 'SIGKILL')
    await this.screen?.down()
  }

  /** The restore points' files, one folder each, beside the run (never in it: a new disk clears the run). */
  get pointsDir(): string {
    return join(this.c.dir, 'points')
  }

  /**
   * The restore points of this machine's disk. A point is taken of the stopped machine only, so the TPM's
   * live state is kept first when it is newer than the run's copy (a crash, the guest's own stop).
   */
  points(): PointStore {
    const qcow = new QcowPoints({ disk: this.p.runDisk, vars: this.p.runVars, tpm: this.p.runTpm, dir: this.pointsDir, run: this.p.run })
    const settled = async () => {
      if (this.running()) throw new Error('the machine is running')
      await keepLiveTpm(this.c, this.p)
    }
    return {
      list: () => qcow.list(),
      save: async (point) => {
        await settled()
        await qcow.save(point)
      },
      restore: async (id) => {
        await settled()
        await qcow.restore(id)
      },
      remove: (id) => qcow.remove(id)
    }
  }

  /** The QEMU pid, for a proof that signals it. */
  pid(): number | null {
    return qemuPid(this.c, this.p)
  }
}

/** A PNG's width and height from its header; null when it is not one or is empty. */
export function pngSize(png: Buffer): { width: number; height: number } | null {
  if (png.length < 24 || png.toString('latin1', 12, 16) !== 'IHDR') return null
  const width = png.readUInt32BE(16)
  const height = png.readUInt32BE(20)
  return width > 0 && height > 0 ? { width, height } : null
}
