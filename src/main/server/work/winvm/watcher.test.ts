import { spawn, type ChildProcess } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { stopBlocked } from './machine/daemons'
import { HIBERNATE_COMMAND, startWatcher, watcherScript, type WatcherSpec } from './watcher'

/**
 * The stop watcher run for real under bash, with a stand-in for QEMU (a
 * `sleep`) and a stub `ssh` that records its arguments and, as the guest's
 * hibernate would, ends the stand-in.
 */

let dir: string
let qemu: ChildProcess
const kids: ChildProcess[] = []
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function exited(pid: number, ms = 8000): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    try {
      process.kill(pid, 0)
    } catch {
      return true
    }
    // a zombie of ours counts as gone
    if (readFileSync(`/proc/${pid}/stat`, 'utf8').split(' ')[2] === 'Z') return true
    await sleep(50)
  }
  return false
}

function spec(): WatcherSpec {
  return {
    qemuPid: qemu.pid!,
    qemuComm: 'sleep',
    ssh: { key: join(dir, 'key'), port: 22230, knownHosts: join(dir, 'kh'), user: 'tcadmin' },
    tpmPidFile: join(dir, 'swtpm.pid'),
    tpmState: join(dir, 'tpm-live'),
    runTpm: join(dir, 'run-tpm'),
    waitSec: 3
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'winvm-watcher-'))
  mkdirSync(join(dir, 'bin'))
  // the stub ssh: writes its arguments, then ends "QEMU" as the guest's hibernate does
  writeFileSync(join(dir, 'bin', 'ssh'), `#!/bin/bash\necho "$@" > ${join(dir, 'ssh.args')}\nkill "$(cat ${join(dir, 'qemu.pid')})"\n`)
  chmodSync(join(dir, 'bin', 'ssh'), 0o755)
  mkdirSync(join(dir, 'tpm-live'))
  writeFileSync(join(dir, 'tpm-live', 'tpm2-00.permall'), 'live state')
  qemu = spawn('sleep', ['300'], { stdio: 'ignore' })
  kids.push(qemu)
  writeFileSync(join(dir, 'qemu.pid'), String(qemu.pid))
})

afterEach(() => {
  for (const k of kids.splice(0)) k.kill('SIGKILL')
  rmSync(dir, { recursive: true, force: true })
})

const env = () => ({ PATH: `${join(dir, 'bin')}:/usr/bin:/bin`, HOME: dir })

describe('the stop watcher', () => {
  it('on the stop signal asks the guest to hibernate as the admin, waits for QEMU to exit, and keeps the TPM', async () => {
    const pid = startWatcher(join(dir, 'watcher.sh'), join(dir, 'watcher.log'), spec(), env())!
    await sleep(300)
    process.kill(pid, 'SIGTERM')
    expect(await exited(pid)).toBe(true)
    const args = readFileSync(join(dir, 'ssh.args'), 'utf8')
    expect(args).toContain(`tcadmin@127.0.0.1 ${HIBERNATE_COMMAND}`)
    expect(args).toContain('-p 22230')
    expect(readFileSync(join(dir, 'run-tpm', 'tpm2-00.permall'), 'utf8')).toBe('live state')
    const log = readFileSync(join(dir, 'watcher.log'), 'utf8')
    expect(log).toContain('stop signal: asking Windows to hibernate')
    expect(log).toContain('QEMU exited: the guest hibernated')
  })

  it('a second signal does not cut the hibernate short', async () => {
    writeFileSync(join(dir, 'bin', 'ssh'), `#!/bin/bash\necho "$@" > ${join(dir, 'ssh.args')}\n(sleep 0.6; kill "$(cat ${join(dir, 'qemu.pid')})") &\n`)
    const pid = startWatcher(join(dir, 'watcher.sh'), join(dir, 'watcher.log'), spec(), env())!
    await sleep(300)
    process.kill(pid, 'SIGTERM')
    await sleep(100)
    process.kill(pid, 'SIGTERM')
    expect(await exited(pid)).toBe(true)
    expect(existsSync(join(dir, 'run-tpm'))).toBe(true)
  })

  it('exits by itself when QEMU exits on its own, asking nothing of the guest', async () => {
    const pid = startWatcher(join(dir, 'watcher.sh'), join(dir, 'watcher.log'), spec(), env())!
    await sleep(300)
    qemu.kill('SIGTERM')
    expect(await exited(pid, 4000)).toBe(true)
    expect(existsSync(join(dir, 'ssh.args'))).toBe(false)
    expect(readFileSync(join(dir, 'watcher.log'), 'utf8')).toContain('QEMU exited on its own')
  })

  it('says so when QEMU outlives its wait (the stop will cut its power)', async () => {
    writeFileSync(join(dir, 'bin', 'ssh'), '#!/bin/bash\nexit 255\n')
    const pid = startWatcher(join(dir, 'watcher.sh'), join(dir, 'watcher.log'), { ...spec(), waitSec: 0.5 }, env())!
    await sleep(300)
    process.kill(pid, 'SIGTERM')
    expect(await exited(pid)).toBe(true)
    expect(readFileSync(join(dir, 'watcher.log'), 'utf8')).toContain('QEMU still runs')
    expect(existsSync(join(dir, 'run-tpm'))).toBe(false)
  })

  /** A stand-in for the window's X server: started on its config, with the stop signals blocked as the real one is. */
  function display(config: string): ChildProcess {
    const [cmd, args] = stopBlocked('bash', ['-c', 'sleep 300; :', 'Xorg', '-config', config])
    const p = spawn(cmd, args, { stdio: 'ignore' })
    kids.push(p)
    return p
  }

  it("ends the window's display once QEMU has gone, at the stop and when QEMU exits on its own", async () => {
    const config = join(dir, 'xorg.conf')
    const x = display(config)
    const pid = startWatcher(join(dir, 'watcher.sh'), join(dir, 'watcher.log'), { ...spec(), display: { pid: x.pid!, config } }, env())!
    await sleep(300)
    process.kill(pid, 'SIGTERM')
    expect(await exited(pid)).toBe(true)
    expect(await exited(x.pid!, 2000)).toBe(true)
    expect(readFileSync(join(dir, 'watcher.log'), 'utf8')).toContain("ended the window's display")

    // QEMU on its own (the keeper's sleep): the same
    qemu = spawn('sleep', ['300'], { stdio: 'ignore' })
    kids.push(qemu)
    const y = display(config)
    const again = startWatcher(join(dir, 'watcher2.sh'), join(dir, 'watcher2.log'), { ...spec(), display: { pid: y.pid!, config } }, env())!
    await sleep(300)
    qemu.kill('SIGTERM')
    expect(await exited(again, 4000)).toBe(true)
    expect(await exited(y.pid!, 2000)).toBe(true)
  })

  it('never ends a process that is not the display it was started beside', async () => {
    const other = display(join(dir, 'another.conf'))
    const pid = startWatcher(join(dir, 'watcher.sh'), join(dir, 'watcher.log'), { ...spec(), display: { pid: other.pid!, config: join(dir, 'xorg.conf') } }, env())!
    await sleep(300)
    qemu.kill('SIGTERM')
    expect(await exited(pid, 4000)).toBe(true)
    expect(await exited(other.pid!, 500)).toBe(false)
  })

  it('does not take a pid that came round again as QEMU', () => {
    expect(watcherScript({ ...spec(), qemuComm: 'tc-win11-stand' })).toContain(`[ "$(cat /proc/$QEMU/comm 2>/dev/null)" = 'tc-win11-stand' ]`)
  })
})

describe('the daemons start with the stop signals blocked', () => {
  it('a process started through stopBlocked survives SIGTERM, SIGINT and SIGHUP, and SIGKILL still ends it', async () => {
    const [cmd, args] = stopBlocked('sleep', ['300'])
    const p = spawn(cmd, args, { stdio: 'ignore' })
    kids.push(p)
    await sleep(300)
    const blocked = BigInt('0x' + /SigBlk:\s+([0-9a-f]+)/.exec(readFileSync(`/proc/${p.pid}/status`, 'utf8'))![1])
    // SIGHUP 1, SIGINT 2, SIGTERM 15: bits 0, 1, 14
    expect(blocked & 0x4003n).toBe(0x4003n)
    for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) p.kill(sig)
    expect(await exited(p.pid!, 500)).toBe(false)
    p.kill('SIGKILL')
    expect(await exited(p.pid!)).toBe(true)
  })
})
