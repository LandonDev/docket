#!/usr/bin/env bun
/**
 * The Windows rig on the box: one Windows 11 Enterprise Evaluation machine under QEMU/KVM, run by the agents
 * user with no root. Every command here is also a .sh beside this file; docs/agents/windows-vm.md is the manual.
 *
 *   fetch                             download the evaluation ISO from Microsoft and Git for Windows
 *   install [--force]                 build the base image from the ISO (unattended, about 15 min)
 *   up [--keep | --from NAME] [--no-wait]   boot a fresh overlay on the base (or a snapshot, or resume the last run)
 *   down [--force]                    shut Windows down and stop the machine
 *   status                            whether it runs, its ports, and the evaluation's days left
 *   ssh [-a] [--ps] [CMD...]          a command as the standard user (-a: the admin); `winver` answers who and what
 *   scp [-a] ARGS...                  scp with guest:PATH meaning the guest
 *   shot [FILE.png]                   a QMP screenshot of the desktop
 *   run-in-session [--wait] [--timeout S] [--cwd DIR] PROGRAM [ARGS...]   start a program on the logged-on desktop
 *   snapshot NAME | --list | --rm NAME   keep the stopped run as a named starting point
 */
import { spawnSync, type SpawnSyncOptions } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { accessSync, constants } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { ADMIN_USER, GIT, ISO_URL, STANDARD_USER, daemonEnv, rigConfig, rigPaths, snapshotName } from './config'
import { makePassword, renderAnswerFile } from './answer'
import { WINVER_SCRIPT, psStdin, runInSessionScript } from './guest'
import { qemuArgs, swtpmArgs } from './qemu'
import { powerdown, qmp, quit, screendump, sendKey } from './qmp'

const HERE = dirname(new URL(import.meta.url).pathname)
const c = rigConfig()
const p = rigPaths(c)

class Refusal extends Error {}
const log = (msg: string) => console.log(`[win-vm ${new Date().toISOString().slice(11, 19)}] ${msg}`)
const die = (msg: string): never => {
  throw new Refusal(msg)
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function run(cmd: string, args: string[], opts: SpawnSyncOptions = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts })
  if (r.error) throw r.error
  return r
}
function must(cmd: string, args: string[], opts: SpawnSyncOptions = {}) {
  const r = run(cmd, args, opts)
  if (r.status !== 0) die(`${cmd} exited ${r.status}`)
  return r
}

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

/** A shell started before `usermod -aG kvm agents` lacks the group; `sg kvm` gives it to the child without a restart. */
function kvmWrapped(cmd: string, args: string[]): [string, string[]] {
  try {
    accessSync('/dev/kvm', constants.R_OK | constants.W_OK)
    return [cmd, args]
  } catch {
    return ['sg', ['kvm', '-c', [cmd, ...args].map(shq).join(' ')]]
  }
}

/** The pid in a pid file, only while that pid is still the process it names (a pid comes round again after a restart). */
function livePid(file: string, isIt: (pid: number) => boolean): number | null {
  try {
    const pid = Number(readFileSync(file, 'utf8').trim())
    process.kill(pid, 0)
    return isIt(pid) ? pid : null
  } catch {
    return null
  }
}
const procFile = (pid: number, f: string) => readFileSync(`/proc/${pid}/${f}`, 'utf8')
const qemuPid = () => livePid(p.pid, (pid) => procFile(pid, 'comm').trim() === 'tc-win11')
const tpmPid = () => livePid(p.tpmPid, (pid) => procFile(pid, 'cmdline').includes(p.tpmSock))

async function waitFor(what: string, timeoutSec: number, check: () => boolean | Promise<boolean>, everySec = 5): Promise<void> {
  const end = Date.now() + timeoutSec * 1000
  while (Date.now() < end) {
    if (await check()) return
    await sleep(everySec * 1000)
  }
  die(`timed out after ${timeoutSec} s waiting for ${what}`)
}

// ---- ssh -------------------------------------------------------------------------------------------------

function sshBase(user: string): string[] {
  return [
    '-i', p.key, '-p', String(c.sshPort),
    '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', '-o', 'LogLevel=ERROR',
    '-o', 'StrictHostKeyChecking=accept-new', '-o', `UserKnownHostsFile=${p.knownHosts}`,
    `${user}@127.0.0.1`
  ]
}
function sshCapture(user: string, command: string, input?: string, timeoutMs = 60_000): { status: number | null; out: string } {
  const r = spawnSync('ssh', [...sshBase(user), command], { encoding: 'utf8', timeout: timeoutMs, input: input ?? '' })
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() }
}
function psCapture(user: string, script: string, timeoutMs = 60_000) {
  const { command, input } = psStdin(script)
  return sshCapture(user, command, input, timeoutMs)
}
/** A PowerShell script as `user`, its output straight through, its exit code back. */
function psRun(user: string, script: string): number {
  const { command, input } = psStdin(script)
  return run('ssh', [...sshBase(user), command], { input, stdio: ['pipe', 'inherit', 'inherit'] }).status ?? 1
}
const sshOk = (user: string) => sshCapture(user, 'echo ok', undefined, 20_000).out.endsWith('ok')
function desktopUp(user = STANDARD_USER): boolean {
  const script = `if (Get-Process explorer -IncludeUserName -ErrorAction SilentlyContinue | Where-Object UserName -like '*\\${user}') { 'desktop' }`
  return psCapture(ADMIN_USER, script, 30_000).out.includes('desktop')
}

// ---- the machine -----------------------------------------------------------------------------------------

function stopTpm(): void {
  const pid = tpmPid()
  if (pid !== null) process.kill(pid, 'SIGTERM')
}
async function startTpm(from: string | null): Promise<void> {
  stopTpm()
  await waitFor('the old swtpm to exit', 10, () => tpmPid() === null, 0.2)
  rmSync(c.tpmDir, { recursive: true, force: true })
  mkdirSync(p.tpmState, { recursive: true, mode: 0o700 })
  if (from && existsSync(from)) cpSync(from, p.tpmState, { recursive: true })
  must('swtpm', swtpmArgs(p), { env: daemonEnv() })
}
async function saveTpm(to: string): Promise<void> {
  await waitFor('swtpm to exit', 30, () => tpmPid() === null, 1)
  rmSync(to, { recursive: true, force: true })
  cpSync(p.tpmState, to, { recursive: true })
}

function startQemu(disk: string, vars: string, install?: { iso: string; configDir: string }): void {
  mkdirSync(p.run, { recursive: true })
  const [cmd, args] = kvmWrapped('qemu-system-x86_64', qemuArgs(c, p, { disk, vars, install }))
  const r = run(cmd, args, { env: daemonEnv() })
  if (r.status !== 0) {
    stopTpm()
    die(`qemu-system-x86_64 exited ${r.status}`)
  }
  log(`machine up (pid ${qemuPid()}): ${c.cpus} cores, ${c.memory}, ssh on 127.0.0.1:${c.sshPort}`)
}

async function stopMachine(force: boolean): Promise<void> {
  if (qemuPid() === null) return stopTpm()
  if (!force) {
    log('shutting Windows down')
    if (sshCapture(ADMIN_USER, 'shutdown /s /f /t 0', undefined, 20_000).status !== 0) await qmp(p.qmp, powerdown).catch(() => {})
    const end = Date.now() + 180_000
    while (qemuPid() !== null && Date.now() < end) await sleep(2000)
  }
  if (qemuPid() !== null) {
    log('stopping the machine')
    await qmp(p.qmp, quit).catch(() => {})
    await sleep(2000)
    const pid = qemuPid()
    try {
      if (pid !== null) process.kill(pid, 'SIGKILL')
    } catch {
      // it exited on its own in between
    }
  }
}

/** On a failed install or up: keep a screenshot of where it stood, then stop the machine so 8 cores and 16 GB go back. */
async function stopAfterFailure(): Promise<void> {
  if (qemuPid() === null) return stopTpm()
  const file = join(p.shots, 'failed.png')
  mkdirSync(p.shots, { recursive: true })
  await qmp(p.qmp, screendump(file)).then(() => log(`last screen: ${file}`)).catch(() => {})
  await stopMachine(true)
}

// ---- commands --------------------------------------------------------------------------------------------

async function install(force: boolean): Promise<void> {
  if (qemuPid() !== null) die('the machine is running; down.sh first')
  if (existsSync(p.baseReady) && !force) die(`a base image exists (${p.baseReady}); install --force rebuilds it`)
  if (snapshotNames().length) die(`snapshots are built on the base image; remove them first (snapshot.sh --rm ${snapshotNames().join(', ')})`)
  if (!existsSync(p.iso)) die(`no ISO at ${p.iso}; run fetch.sh first`)
  const git = join(p.payload, GIT.name)
  if (!existsSync(git)) die(`no ${GIT.name} in ${p.payload}; run fetch.sh first`)

  mkdirSync(p.keys, { recursive: true, mode: 0o700 })
  if (!existsSync(p.key)) must('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'tc-win-vm', '-f', p.key])
  rmSync(p.base, { recursive: true, force: true })
  rmSync(p.run, { recursive: true, force: true })
  mkdirSync(p.base, { recursive: true })

  const secrets = { adminUser: ADMIN_USER, adminPassword: makePassword(), standardUser: STANDARD_USER, standardPassword: makePassword() }
  writeFileSync(p.secrets, JSON.stringify(secrets, null, 2) + '\n', { mode: 0o600 })

  // The answer-file stick: autounattend.xml, the setup script, its settings and the Git installer.
  const stick = join(p.build, 'config')
  rmSync(p.build, { recursive: true, force: true })
  mkdirSync(stick, { recursive: true, mode: 0o700 })
  const template = readFileSync(join(HERE, 'autounattend.xml'), 'utf8')
  const values = { ADMIN_USER, ADMIN_PASSWORD: secrets.adminPassword, STANDARD_USER, STANDARD_PASSWORD: secrets.standardPassword }
  writeFileSync(join(stick, 'autounattend.xml'), renderAnswerFile(template, values))
  copyFileSync(join(HERE, 'tc-setup.ps1'), join(stick, 'tc-setup.ps1'))
  copyFileSync(git, join(stick, GIT.name))
  const publicKey = readFileSync(`${p.key}.pub`, 'utf8').trim()
  const setup = { adminUser: ADMIN_USER, standardUser: STANDARD_USER, standardPassword: secrets.standardPassword, publicKey, gitInstaller: GIT.name }
  writeFileSync(join(stick, 'setup.json'), JSON.stringify(setup))

  must('qemu-img', ['create', '-q', '-f', 'qcow2', p.baseDisk, c.diskSize])
  copyFileSync(c.ovmfVars, p.baseVars)
  const started = Date.now()
  try {
    await startTpm(null)
    startQemu(p.baseDisk, p.baseVars, { iso: p.iso, configDir: stick })
    // The ISO's boot loader asks for a key before it boots from the disc.
    for (let i = 0; i < 30; i++) {
      await qmp(p.qmp, sendKey('ret')).catch(() => {})
      await sleep(1000)
    }
    mkdirSync(p.shots, { recursive: true })
    log(`Windows Setup is running; screenshots go to ${join(p.shots, 'install-latest.png')}`)
    let setupDone = false
    await waitFor('Windows Setup and tc-setup.ps1', 120 * 60, async () => {
      if (qemuPid() === null) die('the machine powered off during install (tc-setup.ps1 powers off on a failure); see shots/install-latest.png')
      await qmp(p.qmp, screendump(join(p.shots, 'install-latest.png'))).catch(() => {})
      if (!setupDone) {
        const r = sshCapture(ADMIN_USER, 'if exist C:\\tc\\setup-failed (echo SETUP-FAILED & type C:\\tc\\setup-failed) else if exist C:\\tc\\setup-done echo SETUP-DONE', undefined, 20_000)
        if (r.out.includes('SETUP-FAILED')) die(`tc-setup.ps1 failed: ${r.out.replace('SETUP-FAILED', '').trim()}`)
        if (r.out.includes('SETUP-DONE')) {
          log(`tc-setup.ps1 done after ${Math.round((Date.now() - started) / 60000)} min; waiting for ${STANDARD_USER}'s desktop`)
          setupDone = true
        }
        return false
      }
      return sshOk(STANDARD_USER) && desktopUp()
    }, 30)
    log(`${STANDARD_USER} is logged on; letting the first logon settle`)
    await sleep(90_000)
    await stopMachine(false)
    await saveTpm(p.baseTpm)
  } catch (e) {
    await stopAfterFailure()
    throw e
  } finally {
    rmSync(p.build, { recursive: true, force: true })
  }
  chmodSync(p.baseDisk, 0o444)
  writeFileSync(p.baseReady, JSON.stringify({ builtAt: new Date().toISOString(), iso: isoInfo(), git: GIT.name }, null, 2) + '\n')
  log(`base image ready in ${Math.round((Date.now() - started) / 60000)} min: ${p.baseDisk}`)
}

function isoInfo(): { file: string; sha256: string } {
  const sumFile = `${p.iso}.sha256`
  if (!existsSync(sumFile)) writeFileSync(sumFile, must('sha256sum', [p.iso], { stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8' }).stdout)
  return { file: p.iso, sha256: readFileSync(sumFile, 'utf8').split(/\s+/)[0] }
}

async function up(mode: { keep: boolean; from: string | null; wait: boolean }): Promise<void> {
  const pid = qemuPid()
  if (pid !== null) die(`already running (pid ${pid}); down.sh first, or use it as it is`)
  let tpmFrom: string
  if (mode.keep) {
    if (!existsSync(p.runDisk)) die('no run to keep; up.sh starts a fresh one')
    tpmFrom = existsSync(p.runTpm) ? p.runTpm : p.baseTpm
    log('resuming the last run')
  } else {
    const src = mode.from ? join(p.snapshots, mode.from) : p.base
    if (!existsSync(mode.from ? join(src, 'FROM') : p.baseReady)) die(mode.from ? `no snapshot ${mode.from}` : 'no base image; run install.sh')
    rmSync(p.run, { recursive: true, force: true })
    mkdirSync(p.run, { recursive: true })
    must('qemu-img', ['create', '-q', '-f', 'qcow2', '-b', join(src, 'disk.qcow2'), '-F', 'qcow2', p.runDisk])
    copyFileSync(join(src, 'OVMF_VARS.fd'), p.runVars)
    writeFileSync(join(p.run, 'FROM'), (mode.from ?? 'base') + '\n')
    tpmFrom = existsSync(join(src, 'tpm')) ? join(src, 'tpm') : p.baseTpm
    log(`fresh overlay on ${mode.from ? `snapshot ${mode.from}` : 'the base image'}`)
  }
  try {
    await startTpm(tpmFrom)
    startQemu(p.runDisk, p.runVars)
    if (!mode.wait) return
    await waitFor('ssh', 300, () => sshOk(STANDARD_USER))
    await waitFor(`${STANDARD_USER}'s desktop`, 180, () => desktopUp())
  } catch (e) {
    if (mode.keep && qemuPid() !== null) {
      // A kept run is the user's: shut it down properly and keep its TPM, rather than pull the plug.
      log('stopping the kept run cleanly')
      await stopMachine(false)
      await saveTpm(p.runTpm).catch(() => {})
    } else await stopAfterFailure()
    throw e
  }
  log(`ready: ${STANDARD_USER} is logged on at the desktop`)
}

async function down(force: boolean): Promise<void> {
  if (qemuPid() === null) {
    stopTpm()
    log('not running')
    return
  }
  await stopMachine(force)
  await saveTpm(p.runTpm)
  log('stopped')
}

function status(): void {
  const pid = qemuPid()
  if (pid === null) {
    console.log(`stopped${existsSync(p.runDisk) ? ' (a run is kept: up.sh --keep resumes it)' : ''}`)
    console.log(`base image: ${existsSync(p.baseReady) ? readFileSync(p.baseReady, 'utf8').trim() : 'none'}`)
    return
  }
  const from = existsSync(join(p.run, 'FROM')) ? readFileSync(join(p.run, 'FROM'), 'utf8').trim() : '?'
  console.log(`running: pid ${pid}, overlay on ${from}, ${c.cpus} cores, ${c.memory}`)
  console.log(`ssh 127.0.0.1:${c.sshPort}, CDP forward 127.0.0.1:${c.cdpPort}`)
  console.log(psCapture(ADMIN_USER, WINVER_SCRIPT).out || '(guest not answering on ssh yet)')
}

function ssh(argv: string[]): number {
  let user = STANDARD_USER
  let ps = false
  while (argv[0]?.startsWith('-')) {
    const f = argv.shift()!
    if (f === '-a' || f === '--admin') user = ADMIN_USER
    else if (f === '--ps') ps = true
    else if (f === '--') break
    else die(`unknown flag ${f}`)
  }
  if (argv.length === 0) return run('ssh', ['-t', ...sshBase(user)]).status ?? 1
  // winver opens a window that nobody over ssh can close; here it answers in text instead.
  if (argv.length === 1 && argv[0] === 'winver') return psRun(user, WINVER_SCRIPT)
  if (ps) return psRun(user, argv.join(' '))
  return run('ssh', [...sshBase(user), argv.join(' ')]).status ?? 1
}

function scp(argv: string[]): number {
  let user = STANDARD_USER
  if (argv[0] === '-a' || argv[0] === '--admin') {
    argv.shift()
    user = ADMIN_USER
  }
  const target = `${user}@127.0.0.1:`
  const args = argv.map((a) => (a.startsWith('guest:') ? target + a.slice(6) : a))
  const base = sshBase(user).slice(0, -1).map((a) => (a === '-p' ? '-P' : a))
  return run('scp', [...base, ...args]).status ?? 1
}

async function shot(file?: string): Promise<void> {
  if (qemuPid() === null) die('not running')
  // QEMU writes the file itself, from its own working folder (/), so the path must be absolute.
  const out = resolve(file ?? join(p.shots, `${new Date().toISOString().replace(/[:.]/g, '-')}.png`))
  mkdirSync(dirname(out), { recursive: true })
  await qmp(p.qmp, screendump(out))
  console.log(out)
}

function runInSession(argv: string[]): number {
  let wait = false
  let timeoutSec = 600
  let cwd: string | undefined
  while (argv[0]?.startsWith('--')) {
    const f = argv.shift()!
    if (f === '--wait') wait = true
    else if (f === '--timeout') {
      timeoutSec = Number(argv.shift())
      if (!Number.isInteger(timeoutSec) || timeoutSec <= 0) die('--timeout takes whole seconds')
    } else if (f === '--cwd') cwd = argv.shift() ?? die('--cwd takes a folder')
    else if (f === '--') break
    else die(`unknown flag ${f}`)
  }
  if (argv.length === 0) die('run-in-session needs a program')
  const name = `tc-run-${randomBytes(4).toString('hex')}`
  return psRun(STANDARD_USER, runInSessionScript({ argv, wait, timeoutSec, cwd }, name))
}

/** The finished snapshots: folders with a FROM file (one being made is NAME.part and has none yet). */
function snapshotNames(): string[] {
  if (!existsSync(p.snapshots)) return []
  return readdirSync(p.snapshots).filter((n) => existsSync(join(p.snapshots, n, 'FROM')))
}

function snapshot(argv: string[]): void {
  mkdirSync(p.snapshots, { recursive: true })
  const named = snapshotNames
  const fromOf = (n: string) => readFileSync(join(p.snapshots, n, 'FROM'), 'utf8').trim()
  if (argv[0] === '--list') {
    for (const n of named()) console.log(`${n}\t(on ${fromOf(n)}, ${statSync(join(p.snapshots, n, 'disk.qcow2')).mtime.toISOString()})`)
    return
  }
  if (argv[0] === '--rm') {
    const name = snapshotName(argv[1])
    if (!named().includes(name)) die(`no snapshot ${name}`)
    const children = named().filter((n) => n !== name && fromOf(n) === name)
    if (children.length) die(`snapshot ${children.join(', ')} is built on ${name}`)
    if (existsSync(join(p.run, 'FROM')) && readFileSync(join(p.run, 'FROM'), 'utf8').trim() === name) die(`the current run is built on ${name}`)
    rmSync(join(p.snapshots, name), { recursive: true, force: true })
    log(`removed snapshot ${name}`)
    return
  }
  const name = snapshotName(argv[0])
  if (qemuPid() !== null) die('stop the machine first (down.sh); a snapshot is taken of a stopped run')
  if (!existsSync(p.runDisk)) die('no run to keep')
  const dest = join(p.snapshots, name)
  if (existsSync(dest)) die(`snapshot ${name} exists`)
  const tmp = `${dest}.part`
  rmSync(tmp, { recursive: true, force: true })
  mkdirSync(tmp)
  must('cp', ['--sparse=always', p.runDisk, join(tmp, 'disk.qcow2')])
  copyFileSync(p.runVars, join(tmp, 'OVMF_VARS.fd'))
  cpSync(existsSync(p.runTpm) ? p.runTpm : p.baseTpm, join(tmp, 'tpm'), { recursive: true })
  writeFileSync(join(tmp, 'FROM'), readFileSync(join(p.run, 'FROM'), 'utf8'))
  chmodSync(join(tmp, 'disk.qcow2'), 0o444)
  renameSync(tmp, dest)
  log(`snapshot ${name} kept; up.sh --from ${name} starts on it`)
}

function fetch(): void {
  mkdirSync(dirname(p.iso), { recursive: true })
  mkdirSync(p.payload, { recursive: true })
  if (!existsSync(p.iso)) {
    log(`downloading the evaluation ISO from Microsoft (${ISO_URL})`)
    must('curl', ['-fL', '-C', '-', '-A', 'Mozilla/5.0', '-o', `${p.iso}.part`, ISO_URL])
    renameSync(`${p.iso}.part`, p.iso)
    rmSync(`${p.iso}.sha256`, { force: true })
    writeFileSync(join(dirname(p.iso), 'SOURCE'), `${ISO_URL}\nfetched ${new Date().toISOString()}\n`)
  }
  log(`ISO sha256 ${isoInfo().sha256}`)
  const git = join(p.payload, GIT.name)
  if (!existsSync(git)) {
    must('curl', ['-fsSL', '-o', `${git}.part`, GIT.url])
    const sum = must('sha256sum', [`${git}.part`], { stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8' }).stdout.toString().split(/\s+/)[0]
    if (sum !== GIT.sha256) die(`${GIT.name} has sha256 ${sum}, expected ${GIT.sha256}`)
    renameSync(`${git}.part`, git)
  }
  log(`${GIT.name} ok`)
}

/** Flags of a command that takes no free arguments; an unknown one is refused rather than ignored. */
function flags(argv: string[], known: Record<string, 'bool' | 'value'>): Record<string, string | true> {
  const out: Record<string, string | true> = {}
  for (let i = 0; i < argv.length; i++) {
    const kind = known[argv[i]] ?? die(`unknown argument ${argv[i]}`)
    out[argv[i]] = kind === 'bool' ? true : (argv[++i] ?? die(`${argv[i - 1]} takes a value`))
  }
  return out
}

async function main(): Promise<number> {
  const [cmd, ...argv] = process.argv.slice(2)
  switch (cmd) {
    case 'fetch':
      flags(argv, {})
      fetch()
      return 0
    case 'install':
      await install(!!flags(argv, { '--force': 'bool' })['--force'])
      return 0
    case 'up': {
      const f = flags(argv, { '--keep': 'bool', '--from': 'value', '--no-wait': 'bool' })
      if (f['--keep'] && f['--from']) die('--keep resumes the last run; --from starts a fresh one; not both')
      await up({ keep: !!f['--keep'], from: f['--from'] ? snapshotName(f['--from'] as string) : null, wait: !f['--no-wait'] })
      return 0
    }
    case 'down':
      await down(!!flags(argv, { '--force': 'bool' })['--force'])
      return 0
    case 'status':
      flags(argv, {})
      status()
      return 0
    case 'ssh':
      return ssh(argv)
    case 'scp':
      return scp(argv)
    case 'shot':
      await shot(argv[0])
      return 0
    case 'run-in-session':
      return runInSession(argv)
    case 'snapshot':
      snapshot(argv)
      return 0
    default:
      console.error(readFileSync(new URL(import.meta.url).pathname, 'utf8').split('*/')[0].replace(/^#!.*\n\/\*\*/, '').replace(/^ \* ?/gm, ''))
      return cmd ? 1 : 0
  }
}

try {
  process.exit(await main())
} catch (e) {
  console.error(`win-vm: ${e instanceof Error ? (process.env.WINVM_DEBUG && !(e instanceof Refusal) ? e.stack : e.message) : String(e)}`)
  process.exit(1)
}
