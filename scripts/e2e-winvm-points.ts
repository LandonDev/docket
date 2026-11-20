#!/usr/bin/env bun
/**
 * The restore points' proof on the STANDING instance (docs/agents/work-winvm.md "Restore points"), on the disk
 * scripts/e2e-winvm-keeper.ts --keep left set up and asleep: a file written, the machine asleep, a point saved;
 * the file changed; the machine asleep again and taken back to the point; at the next wake the file is as it
 * was. Then the point is deleted, the machine shut down and, unless `--keep`, the standing disk deleted.
 *
 *   flock -o -n /srv/agents/win-vm/standing/.lock bun scripts/e2e-winvm-points.ts
 */
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import type { WinvmSleepAfter } from '../src/shared/contract-work-winvm'
import { hashFile } from '../src/main/server/work/winvm/index'
import { Keeper } from '../src/main/server/work/winvm/keeper'
import { psQuote } from '../src/main/server/work/winvm/machine/guest'
import { tcComputerExe } from '../src/main/server/work/winvm/serviceBin'
import { SshGuest } from '../src/main/server/work/winvm/sshGuest'
import { StandingMachine } from '../src/main/server/work/winvm/standing'
import { log } from './lib/winvmProof'

const keep = process.argv.includes('--keep')
const FILE = 'C:\\Users\\tcuser\\Documents\\point-proof.txt'
const machine = new StandingMachine('standing')
const guest = new SshGuest(machine.c, machine.p)
// the door's token as setup wrote it into the guest: this proof has no box data folder of its own
let token: string | null = null
let sleepAfter: WinvmSleepAfter = '30m'
const keeper = new Keeper({
  machine,
  guest,
  serviceExe: () => tcComputerExe(),
  hashFile,
  token: { get: () => token, set: (t) => (token = t) },
  doorSocket: join(machine.p.run, 'door.sock'),
  sleepAfter: () => sleepAfter,
  setSleepAfter: (v) => (sleepAfter = v),
  points: machine.points(),
  push: (s) => log(`push: ${s.state}${s.step ? ` (${s.step})` : ''}${s.error ? ` error: ${s.error}` : ''}`),
  pushPoints: (p) => log(`points: ${p.map((x) => `${x.name} (${x.by})`).join(', ') || 'none'}`),
  log
})
const write = (text: string) => guest.admin(`[IO.File]::WriteAllText(${psQuote(FILE)}, ${psQuote(text)})`)
const read = async () => (await guest.admin(`[IO.File]::ReadAllText(${psQuote(FILE)})`)).trim()

async function main(): Promise<number> {
  if (!machine.hasDisk()) throw new Error('no standing disk: run scripts/e2e-winvm-keeper.ts --keep first')
  if (machine.running()) throw new Error('the standing machine is running: another thread holds it')
  // the token setup left in the guest, read as the admin once the machine is up
  await machine.start()
  await guest.ready(300_000)
  token = (await guest.admin("[IO.File]::ReadAllText('C:\\ProgramData\\TempCode\\token')")).trim()
  await write('as it was at the point')
  await keeper.sleep()
  const point = await keeper.savePoint('Before the change')
  log(`saved ${point.name} (${point.id}) while asleep; kept: ${keeper.points().length}`)
  await keeper.wake()
  await write('changed after the point')
  log(`the file now reads: "${await read()}"`)
  await keeper.sleep()
  await keeper.restorePoint(point.id)
  await keeper.wake()
  const back = await read()
  log(`after going back, the file reads: "${back}"`)
  const ok = back === 'as it was at the point'
  await keeper.sleep()
  await keeper.deletePoint(point.id)
  log(ok ? 'PASS: went back to the point; the file is as it was' : 'FAIL: the file is not as it was at the point')
  return ok ? 0 : 1
}

let code = 1
try {
  code = await main()
} catch (e) {
  log(`FAIL: ${e instanceof Error ? e.message : String(e)}`)
} finally {
  keeper.close()
  if (machine.running()) {
    await guest.admin('shutdown /s /f /t 0').catch(() => {})
    if (!(await machine.stopped(180_000))) await machine.forceStop()
    await machine.keepTpm().catch(() => {})
  }
  if (!keep && !machine.running()) {
    rmSync(machine.c.dir, { recursive: true, force: true })
    rmSync(machine.c.tpmDir, { recursive: true, force: true })
    log("deleted the standing disk: the owner's setup starts clean")
  }
  log(`the standing machine is ${machine.running() ? 'STILL RUNNING' : 'stopped'}`)
}
process.exit(code)
