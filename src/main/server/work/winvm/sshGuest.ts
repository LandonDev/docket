import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, rmSync } from 'node:fs'
import { connect } from 'node:net'
import { ADMIN_USER, STANDARD_USER, daemonEnv, type RigConfig, type RigPaths } from './machine/config'
import { encodePowerShell, psQuote, psStdin, waitedProgramScript, winQuote } from './machine/guest'
import { SERVICE_PATH, TASK_FOLDER, TASK_NAME } from './setup'
import type { DoorLink, VmGuest } from './keeper'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

interface Ran {
  code: number | null
  out: string
  err: string
}

/**
 * The guest as the keeper reaches it: SSH to the machine's forwarded port
 * with the rig's key, as the admin for every command (after setup tcuser has
 * no command line, so its own SSH runs nothing), and as tcuser only for the
 * one lasting connection that carries the door's forward.
 */
export class SshGuest implements VmGuest {
  constructor(
    private readonly c: RigConfig,
    private readonly p: RigPaths
  ) {}

  private base(user: string): string[] {
    return [
      '-i', this.p.key, '-p', String(this.c.sshPort),
      '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', '-o', 'LogLevel=ERROR',
      '-o', 'StrictHostKeyChecking=accept-new', '-o', `UserKnownHostsFile=${this.p.knownHosts}`,
      `${user}@127.0.0.1`
    ]
  }

  private run(cmd: string, args: string[], input = '', timeoutMs = 120_000): Promise<Ran> {
    return new Promise((resolve) => {
      const child = spawn(cmd, args, { env: daemonEnv(), stdio: ['pipe', 'pipe', 'pipe'] })
      let out = ''
      let err = ''
      const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
      child.stdout.on('data', (d: Buffer) => (out += d.toString()))
      child.stderr.on('data', (d: Buffer) => (err = (err + d.toString()).slice(-4000)))
      child.on('error', (e) => {
        clearTimeout(timer)
        resolve({ code: null, out, err: String(e) })
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        resolve({ code, out: out.trim(), err: err.trim() })
      })
      child.stdin.end(input)
    })
  }

  private ssh(user: string, command: string, input = '', timeoutMs?: number): Promise<Ran> {
    return this.run('ssh', [...this.base(user), command], input, timeoutMs)
  }

  async admin(script: string, timeoutMs = 600_000): Promise<string> {
    const { command, input } = psStdin(script)
    const r = await this.ssh(ADMIN_USER, command, input, timeoutMs)
    if (r.code !== 0) throw new Error(`the guest's script failed (exit ${r.code}): ${(r.err || r.out).slice(-800)}`)
    return r.out
  }

  async ready(timeoutMs: number, signal?: AbortSignal): Promise<void> {
    const end = Date.now() + timeoutMs
    const desktop = `if (Get-Process explorer -IncludeUserName -ErrorAction SilentlyContinue | Where-Object UserName -like '*\\${STANDARD_USER}') { 'desktop' }`
    while (Date.now() < end) {
      signal?.throwIfAborted()
      const r = await this.ssh(ADMIN_USER, psStdin(desktop).command, psStdin(desktop).input, 30_000).catch(() => null)
      if (r?.code === 0 && r.out.includes('desktop')) return
      await sleep(2000)
    }
    throw new Error(`Windows did not come up within ${Math.round(timeoutMs / 1000)} s`)
  }

  async hibernate(): Promise<void> {
    // QEMU exits once the image is written, and SSH with it (255, "closed by remote host")
    await this.ssh(ADMIN_USER, 'shutdown /h', '', 30_000)
  }

  async reboot(): Promise<void> {
    await this.ssh(ADMIN_USER, 'shutdown /r /t 0', '', 30_000)
    // wait for SSH to go before the caller waits for it to come back
    const end = Date.now() + 120_000
    while (Date.now() < end && (await this.ssh(ADMIN_USER, 'echo ok', '', 10_000)).out.endsWith('ok')) await sleep(2000)
  }

  async serviceHash(): Promise<string | null> {
    const out = await this.admin(`$f = ${psQuote(SERVICE_PATH)}; if (Test-Path -LiteralPath $f) { (Get-FileHash -Algorithm SHA256 -LiteralPath $f).Hash.ToLower() } else { 'none' }`)
    const hash = out.trim().split(/\s+/).pop() ?? ''
    return /^[0-9a-f]{64}$/.test(hash) ? hash : null
  }

  async installService(exe: string): Promise<string> {
    const incoming = `tc-computer.exe.${randomBytes(4).toString('hex')}`
    const scpArgs = this.base(ADMIN_USER).slice(0, -1).map((a) => (a === '-p' ? '-P' : a))
    const r = await this.run('scp', [...scpArgs, exe, `${ADMIN_USER}@127.0.0.1:${incoming}`], '', 300_000)
    if (r.code !== 0) throw new Error(`copying the service into the guest failed: ${r.err.slice(-400)}`)
    // the running door holds the file: stop it, replace it, and say the new one's version
    return (
      await this.admin(`
$new = Join-Path $env:USERPROFILE ${psQuote(incoming)}
$dest = ${psQuote(SERVICE_PATH)}
Get-Process tc-computer -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Milliseconds 800
# a copy, not a move: a moved file keeps the admin profile's ACL, which tcuser may not run
Remove-Item -Force -LiteralPath $dest -ErrorAction SilentlyContinue
Copy-Item -LiteralPath $new -Destination $dest
Remove-Item -Force -LiteralPath $new
icacls $dest /reset /Q | Out-Null
if ($LASTEXITCODE) { throw "icacls exited $LASTEXITCODE" }
& $dest version
`)
    ).trim()
  }

  async startService(): Promise<void> {
    // the logon task as the admin starts it on tcuser's desktop; a running one is left as it is
    await this.admin(`
$svc = New-Object -ComObject Schedule.Service
$svc.Connect()
$task = $svc.GetFolder(${psQuote(TASK_FOLDER)}).GetTask(${psQuote(TASK_NAME)})
if ($task.State -ne 4) { $task.Run($null) | Out-Null }
`)
  }

  /** The forward's control socket: the pictures come back over the same connection (`fetch`). */
  private control: string | null = null

  openDoor(socket: string, guestPort: number): Promise<DoorLink> {
    rmSync(socket, { force: true })
    const control = `${socket}.ctl`
    rmSync(control, { force: true })
    const child: ChildProcess = spawn(
      'ssh',
      [
        '-N', '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3',
        '-o', 'StreamLocalBindMask=0177', '-o', 'StreamLocalBindUnlink=yes',
        // the one connection is also the master the picture copies run over
        '-o', 'ControlMaster=yes', '-o', `ControlPath=${control}`, '-o', 'ControlPersist=no',
        '-L', `${socket}:127.0.0.1:${guestPort}`,
        // as the admin: sshd starts the SFTP subsystem through cmd.exe, which tcuser's DisableCMD refuses
        ...this.base(ADMIN_USER)
      ],
      // the forward is the keeper's own and dies with the server: no daemon environment needed, and no marks either
      { env: daemonEnv(), stdio: ['ignore', 'ignore', 'pipe'] }
    )
    let err = ''
    child.stderr?.on('data', (d: Buffer) => (err = (err + d.toString()).slice(-1000)))
    const closed = new Promise<void>((resolve) => child.on('close', () => resolve()))
    return new Promise((resolve, reject) => {
      const end = Date.now() + 20_000
      const poll = () => {
        if (child.exitCode !== null || child.signalCode !== null) return reject(new Error(`the SSH forward to the door ended: ${err.trim() || `exit ${child.exitCode}`}`))
        if (existsSync(socket)) {
          this.control = control
          void closed.then(() => {
            if (this.control === control) this.control = null
          })
          return resolve({ close: () => void child.kill('SIGTERM'), closed })
        }
        if (Date.now() > end) {
          child.kill('SIGTERM')
          return reject(new Error('the SSH forward to the door did not open'))
        }
        setTimeout(poll, 200)
      }
      poll()
    })
  }

  knock(socket: string, token: string): Promise<boolean> {
    return knockDoor(socket, token)
  }

  /**
   * Copies a file of tcuser's (`rel`, under its profile, with forward slashes) to `local`, over SFTP on the
   * forward's own connection: the service's pictures. The connection is the admin's, who reads tcuser's
   * files: sshd starts the SFTP subsystem through cmd.exe, and tcuser's DisableCMD would refuse it (its words
   * then break the SFTP stream: "Received message too long").
   */
  async fetch(rel: string, local: string): Promise<void> {
    if (!this.control) throw new Error('the Windows VM is not awake')
    const args = ['-q', '-o', `ControlPath=${this.control}`, '-o', 'ControlMaster=no', ...this.base(ADMIN_USER).slice(0, -1).map((a) => (a === '-p' ? '-P' : a))]
    const r = await this.run('scp', [...args, `${ADMIN_USER}@127.0.0.1:/C:/Users/${STANDARD_USER}/${rel}`, local], '', 600_000)
    if (r.code !== 0) throw new Error(`copying a file from the Windows VM failed: ${r.err.slice(-300)}`)
  }

  /** Copies `local` to a file of tcuser's (`rel`, under its profile, forward slashes), over the same connection. */
  async send(local: string, rel: string): Promise<void> {
    if (!this.control) throw new Error('the Windows VM is not awake')
    const args = ['-q', '-o', `ControlPath=${this.control}`, '-o', 'ControlMaster=no', ...this.base(ADMIN_USER).slice(0, -1).map((a) => (a === '-p' ? '-P' : a))]
    const r = await this.run('scp', [...args, local, `${ADMIN_USER}@127.0.0.1:/C:/Users/${STANDARD_USER}/${rel}`], '', 600_000)
    if (r.code !== 0) throw new Error(`copying a file into the Windows VM failed: ${r.err.slice(-300)}`)
  }

  /**
   * Runs a program on tcuser's desktop, started by the admin through a one-off task of tcuser's (its
   * interactive token), and with `wait` its output: the proofs start Notepad and read windows this way.
   */
  async onDesktop(argv: string[], wait: boolean, timeoutSec = 120): Promise<string> {
    const name = `tc-keeper-${randomBytes(4).toString('hex')}`
    const [program, ...rest] = argv
    const [path, args] = wait
      ? ['powershell.exe', `-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -EncodedCommand ${encodePowerShell(waitedProgramScript(argv, name))}`]
      : [program, rest.map(winQuote).join(' ')]
    return this.admin(
      `
$ErrorActionPreference = 'Stop'
$account = "$env:COMPUTERNAME\\${STANDARD_USER}"
New-Item -ItemType Directory -Force "C:\\Users\\${STANDARD_USER}\\AppData\\Local\\tc-run" | Out-Null
$svc = New-Object -ComObject Schedule.Service
$svc.Connect()
$root = $svc.GetFolder('\\')
$def = $svc.NewTask(0)
$def.Principal.UserId = $account
$def.Principal.LogonType = 3
$def.Settings.ExecutionTimeLimit = 'PT0S'
$def.Settings.DisallowStartIfOnBatteries = $false
$action = $def.Actions.Create(0)
$action.Path = ${psQuote(path)}
$action.Arguments = ${psQuote(args)}
$root.RegisterTaskDefinition(${psQuote(name)}, $def, 6, $account, $null, 3) | Out-Null
$root.GetTask(${psQuote(name)}).Run($null) | Out-Null
$end = (Get-Date).AddSeconds(${timeoutSec})
do { Start-Sleep -Milliseconds 300; $t = $root.GetTask(${psQuote(name)}) } while (${wait ? '$true' : '$false'} -and ($t.State -eq 4 -or $t.LastTaskResult -eq 267011) -and (Get-Date) -lt $end)
$res = $t.LastTaskResult
$root.DeleteTask(${psQuote(name)}, 0)
$out = "C:\\Users\\${STANDARD_USER}\\AppData\\Local\\tc-run\\${name}.out"
if (Test-Path -LiteralPath $out) { Get-Content -Raw -LiteralPath $out; Remove-Item -LiteralPath $out }
"exit: $res"
`,
      (timeoutSec + 60) * 1000
    )
  }
}

/** The id of the knock's one request: an unknown method, which the service answers with an error before `initialize` too. */
export const KNOCK_ID = 'keeper-knock'

/**
 * The door's knock (docs/computer-protocol.md §29.1) and one request behind it: true only when the service
 * answers. A wrong token, nothing listening behind the forward, or a service that cannot start all end the
 * connection with no answer; the connection staying open proves nothing, since the forward accepts it first.
 */
export function knockDoor(socket: string, token: string, timeoutMs = 8000): Promise<boolean> {
  return new Promise((resolve) => {
    const s = connect(socket)
    let done = false
    let buf = ''
    const finish = (ok: boolean) => {
      if (done) return
      done = true
      clearTimeout(timer)
      s.destroy()
      resolve(ok)
    }
    const timer = setTimeout(() => finish(false), timeoutMs)
    s.on('connect', () => {
      s.write(`${token}\n`)
      s.write(JSON.stringify({ jsonrpc: '2.0', id: KNOCK_ID, method: 'keeper.knock', params: {} }) + '\n')
    })
    s.on('data', (d: Buffer) => {
      buf += d.toString()
      if (buf.includes(`"${KNOCK_ID}"`)) finish(true)
    })
    s.on('error', () => finish(false))
    s.on('close', () => finish(false))
  })
}
