import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { ADMIN_USER, daemonEnv, rigConfig, rigPaths, type Instance, type RigConfig, type RigPaths } from './machine/config'
import { keepLiveTpm, qemuPid, saveTpm, startQemu, startTpm, stopTpm } from './machine/daemons'
import { qmp, quit } from './machine/qmp'
import { startWatcher } from './watcher'
import type { VmMachine } from './keeper'

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

  constructor(instance: Instance = 'standing', env: NodeJS.ProcessEnv = process.env) {
    this.c = rigConfig(env, undefined, instance)
    this.p = rigPaths(this.c)
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
    await startTpm(this.c, this.p, existsSync(this.p.runTpm) ? this.p.runTpm : this.p.baseTpm, { blockStop: true })
    const pid = await startQemu(this.c, this.p, { disk: this.p.runDisk, vars: this.p.runVars }, { blockStop: true })
    if (pid === null) throw new Error('QEMU did not stay up')
    const watcher = startWatcher(join(this.p.run, 'watcher.sh'), join(this.p.run, 'watcher.log'), {
      qemuPid: pid,
      qemuComm: this.c.process,
      ssh: { key: this.p.key, port: this.c.sshPort, knownHosts: this.p.knownHosts, user: ADMIN_USER },
      tpmPidFile: this.p.tpmPid,
      tpmState: this.p.tpmState,
      runTpm: this.p.runTpm
    })
    writeFileSync(join(this.p.run, 'watcher.pid'), `${watcher ?? ''}\n`)
  }

  async stopped(timeoutMs: number): Promise<boolean> {
    const end = Date.now() + timeoutMs
    while (this.running()) {
      if (Date.now() > end) return false
      await sleep(1000)
    }
    return true
  }

  async keepTpm(): Promise<void> {
    await saveTpm(this.p, this.p.runTpm)
  }

  /** Pulls the plug: for a proof's cleanup, never the keeper's sleep. */
  async forceStop(): Promise<void> {
    if (!this.running()) return stopTpm(this.p)
    await qmp(this.p.qmp, quit).catch(() => {})
    await this.stopped(10_000)
    const pid = qemuPid(this.c, this.p)
    if (pid !== null) process.kill(pid, 'SIGKILL')
  }

  /** The QEMU pid, for a proof that signals it. */
  pid(): number | null {
    return qemuPid(this.c, this.p)
  }
}
