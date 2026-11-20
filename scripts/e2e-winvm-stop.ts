#!/usr/bin/env bun
/**
 * The stop's proof, on the RIG instance (docs/agents/work-winvm.md "The stop"). A stop of the box's service
 * signals its whole cgroup at once; this signals a test group the same way and never the service:
 *
 *   1. a fresh overlay on the base, started by the keeper's own driver (StandingMachine on the rig): QEMU and
 *      swtpm with the stop signals blocked, the watcher beside them; hibernate turned on in the guest;
 *   2. Notepad with a file's text on tcuser's desktop;
 *   3. SIGTERM at once to QEMU, swtpm, the watcher and a stand-in for the server's main process, then
 *      SIGKILL to whatever is left 30 s later, as systemd does (TimeoutStopSec=30);
 *   4. QEMU must have exited before the SIGKILL, by the guest's hibernate (the watcher's log);
 *   5. started again: the same Notepad process with its text, and the same boot time.
 *
 * Then Windows is shut down and the rig left stopped. Run it under the rig's lock:
 *   flock -o -n /srv/agents/win-vm/.lock bun scripts/e2e-winvm-stop.ts
 */
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { SshGuest } from '../src/main/server/work/winvm/sshGuest'
import { StandingMachine } from '../src/main/server/work/winvm/standing'
import { tpmPid } from '../src/main/server/work/winvm/machine/daemons'
import { log, PROOF_TEXT, readDesktop, startNotepad } from './lib/winvmProof'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const machine = new StandingMachine('rig')
const guest = new SshGuest(machine.c, machine.p)
const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function main(): Promise<number> {
  if (machine.running()) throw new Error('the rig is running: another thread holds it')
  await machine.makeDisk()
  const t0 = Date.now()
  await machine.start()
  await guest.ready(300_000)
  log(`rig up from cold in ${((Date.now() - t0) / 1000).toFixed(1)} s`)
  await guest.admin('powercfg /hibernate on; powercfg /hibernate /type full; powercfg /setacvalueindex SCHEME_CURRENT SUB_NONE CONSOLELOCK 0; powercfg /setactive SCHEME_CURRENT')
  await startNotepad(guest)
  const before = await readDesktop(guest)
  log(`before: notepad pid ${before.pid}, text "${before.text}", boot ${before.boot}`)
  if (before.text !== PROOF_TEXT) throw new Error('Notepad did not show the text')

  const qemu = machine.pid()!
  const tpm = tpmPid(machine.p)!
  const watcher = Number(readFileSync(join(machine.p.run, 'watcher.pid'), 'utf8'))
  const stand = spawn('sleep', ['600'], { stdio: 'ignore' })
  const group = { qemu, swtpm: tpm, watcher, 'server stand-in': stand.pid! }
  log(`signalling the test group with SIGTERM at once: ${JSON.stringify(group)}`)
  const sigAt = Date.now()
  for (const pid of Object.values(group)) {
    try {
      process.kill(pid, 'SIGTERM')
    } catch (e) {
      log(`SIGTERM ${pid}: ${String(e)}`)
    }
  }
  let qemuGoneAt: number | null = null
  while (Date.now() - sigAt < 30_000) {
    if (!alive(qemu)) {
      qemuGoneAt = Date.now()
      break
    }
    await sleep(250)
  }
  if (qemuGoneAt === null) {
    log('30 s: SIGKILL to what is left, as systemd would')
    for (const pid of Object.values(group)) if (alive(pid)) process.kill(pid, 'SIGKILL')
  }
  const after = (name: string, pid: number) => `${name} ${alive(pid) ? 'alive' : 'gone'}`
  log(`QEMU exited ${qemuGoneAt ? `${((qemuGoneAt - sigAt) / 1000).toFixed(1)} s after the signal, before any SIGKILL` : 'only at the SIGKILL'}`)
  await sleep(1500)
  log(`then: ${Object.entries(group).map(([n, p]) => after(n, p)).join(', ')}`)
  log(`watcher log:\n${readFileSync(join(machine.p.run, 'watcher.log'), 'utf8').trim()}`)
  if (qemuGoneAt === null) return 1

  const t1 = Date.now()
  await machine.start()
  await guest.ready(300_000)
  log(`resumed in ${((Date.now() - t1) / 1000).toFixed(1)} s`)
  const back = await readDesktop(guest)
  log(`after: notepad pid ${back.pid}, text "${back.text}", boot ${back.boot}`)
  const ok = back.pid === before.pid && back.text === PROOF_TEXT && back.boot === before.boot
  log(ok ? 'PASS: the stop hibernated the guest; Notepad and its text are as left, the same boot' : 'FAIL: the guest did not come back as left')
  return ok ? 0 : 1
}

let code = 1
try {
  code = await main()
} catch (e) {
  log(`FAIL: ${e instanceof Error ? e.message : String(e)}`)
} finally {
  if (machine.running()) {
    log('shutting the rig down')
    await guest.admin('shutdown /s /f /t 0').catch(() => {})
    if (!(await machine.stopped(180_000))) await machine.forceStop()
    await machine.keepTpm().catch(() => {})
  }
  log(`the rig is ${machine.running() ? 'STILL RUNNING' : 'stopped'}`)
}
process.exit(code)
