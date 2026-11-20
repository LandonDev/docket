#!/usr/bin/env bun
/**
 * The keeper's proof on the STANDING instance (docs/agents/work-winvm.md): the real Keeper over the real
 * machine and guest, as the server builds it, with a scratch data folder for its token.
 *
 *   1. setup: the disk from the base image, the admin steps, the service copied in, a restart, the door
 *      knocked (so the service runs under tcuser's new policies);
 *   2. the policies hold for tcuser: cmd refused, a program in Downloads refused, Windows Terminal the
 *      default terminal;
 *   3. Notepad with a file's text; sleep (hibernate); wake; the same Notepad process with its text and the
 *      same boot time, and the door knocked again.
 *
 * TEMP_CODE_WINVM_EXE names the tc-computer.exe to copy in. `--keep` leaves the standing disk; by default it
 * is deleted after, so the owner's own setup starts clean. Run it under the standing machine's lock:
 *   flock -o -n /srv/agents/win-vm/standing/.lock bun scripts/e2e-winvm-keeper.ts
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WinvmSleepAfter } from '../src/shared/contract-work-winvm'
import { hashFile } from '../src/main/server/work/winvm/index'
import { Keeper } from '../src/main/server/work/winvm/keeper'
import { psQuote } from '../src/main/server/work/winvm/machine/guest'
import { tcComputerExe } from '../src/main/server/work/winvm/serviceBin'
import { SshGuest } from '../src/main/server/work/winvm/sshGuest'
import { StandingMachine } from '../src/main/server/work/winvm/standing'
import { log, PROOF_TEXT, readDesktop, startNotepad } from './lib/winvmProof'

const keep = process.argv.includes('--keep')
const machine = new StandingMachine('standing')
const guest = new SshGuest(machine.c, machine.p)
const data = mkdtempSync(join(tmpdir(), 'winvm-keeper-proof-'))
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
  push: (s) => log(`push: ${s.state}${s.step ? ` (${s.step})` : ''}${s.error ? ` error: ${s.error}` : ''}`),
  log
})

async function asTcuser(ps: string): Promise<string> {
  const encoded = Buffer.from(`$ProgressPreference = 'SilentlyContinue'\n${ps}`, 'utf16le').toString('base64')
  return guest.onDesktop(['powershell.exe', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], true, 90)
}

async function main(): Promise<number> {
  if (machine.running()) throw new Error('the standing machine is running: another thread holds it')
  if (machine.hasDisk()) throw new Error('the standing machine has a disk already; this proof starts from none')
  const exe = tcComputerExe()
  if (!exe) throw new Error('no tc-computer.exe (TEMP_CODE_WINVM_EXE)')
  log(`service: ${exe} sha256 ${hashFile(exe).slice(0, 16)}…`)
  mkdirSync(data, { recursive: true })

  let t = Date.now()
  await keeper.setup()
  log(`setup done in ${((Date.now() - t) / 1000).toFixed(0)} s; state ${keeper.state().state}`)

  const cmd = await asTcuser("try { $o = & cmd.exe /c 'echo cmd-ran' 2>&1; \"cmd: $o\" } catch { \"cmd: refused $($_.Exception.Message)\" }")
  log(`tcuser runs cmd: ${cmd.split('\n').find((l) => l.startsWith('cmd:'))}`)
  await guest.admin("Copy-Item -Force C:\\Windows\\System32\\whoami.exe C:\\Users\\tcuser\\Downloads\\tc-srp-test.exe")
  const srp = await asTcuser("try { $o = & 'C:\\Users\\tcuser\\Downloads\\tc-srp-test.exe' 2>&1; \"srp: ran $o\" } catch { \"srp: refused $($_.Exception.Message)\" }")
  log(`tcuser runs a program from Downloads: ${srp.split('\n').find((l) => l.startsWith('srp:'))}`)
  const policies = await guest.admin(`
$sid = (New-Object Security.Principal.NTAccount('tcuser')).Translate([Security.Principal.SecurityIdentifier]).Value
$e = Get-ItemProperty "Registry::HKEY_USERS\\$sid\\Software\\Microsoft\\Windows\\CurrentVersion\\Policies\\Explorer"
$c = Get-ItemProperty -LiteralPath "Registry::HKEY_USERS\\$sid\\Console\\%%Startup"
$s = Get-ItemProperty "Registry::HKEY_USERS\\$sid\\Software\\Policies\\Microsoft\\Windows\\System"
"policies: DisableCMD=$($s.DisableCMD) NoRun=$($e.NoRun) DisallowRun=$($e.DisallowRun) entries=$((Get-Item "Registry::HKEY_USERS\\$sid\\Software\\Microsoft\\Windows\\CurrentVersion\\Policies\\Explorer\\DisallowRun").ValueCount) terminal=$($c.DelegationTerminal)"
"service: $((Get-Process tc-computer -IncludeUserName -ErrorAction SilentlyContinue | ForEach-Object { "$($_.Path) as $($_.UserName) in session $($_.SessionId)" }) -join '; ')"
"lock on resume: $((powercfg /query SCHEME_CURRENT SUB_NONE CONSOLELOCK | Select-String 'Current AC Power Setting Index').ToString().Trim())"
"hibernate: $((powercfg /a | Select-String -SimpleMatch 'Hibernate' | Select-Object -First 1).ToString().Trim())"
Remove-Item -Force ${psQuote('C:\\Users\\tcuser\\Downloads\\tc-srp-test.exe')}
`)
  for (const l of policies.split('\n').filter((l) => /^(policies|service|lock on resume|hibernate):/.test(l))) log(l.trim())

  await startNotepad(guest)
  const before = await readDesktop(guest)
  log(`before: notepad pid ${before.pid}, text "${before.text}", boot ${before.boot}`)
  if (before.text !== PROOF_TEXT) throw new Error('Notepad did not show the text')

  t = Date.now()
  await keeper.sleep()
  log(`asleep in ${((Date.now() - t) / 1000).toFixed(1)} s; QEMU ${machine.running() ? 'still runs' : 'exited'}`)
  t = Date.now()
  await keeper.wake()
  log(`awake in ${((Date.now() - t) / 1000).toFixed(1)} s (the door knocked)`)
  const back = await readDesktop(guest)
  log(`after: notepad pid ${back.pid}, text "${back.text}", boot ${back.boot}`)
  const ok = back.pid === before.pid && back.text === PROOF_TEXT && back.boot === before.boot && keeper.state().state === 'awake'
  log(ok ? 'PASS: set up, slept, woke; Notepad and its text are as left, the same boot' : 'FAIL: the guest did not come back as left')
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
    log('shutting the standing machine down')
    await guest.admin('shutdown /s /f /t 0').catch(() => {})
    if (!(await machine.stopped(180_000))) await machine.forceStop()
    await machine.keepTpm().catch(() => {})
  }
  if (!keep && !machine.running()) {
    rmSync(machine.c.dir, { recursive: true, force: true })
    rmSync(machine.c.tpmDir, { recursive: true, force: true })
    log('deleted the standing disk: the owner\'s setup starts clean')
  }
  rmSync(data, { recursive: true, force: true })
  log(`the standing machine is ${machine.running() ? 'STILL RUNNING' : 'stopped'}`)
}
process.exit(code)
