import { createHash } from 'node:crypto'
import { connect } from 'node:net'
import type { WinvmState } from '@shared/contract-work-winvm'
import { STANDARD_USER } from './machine/config'
import { psQuote } from './machine/guest'
import { OFFICE_POLICY, ONEDRIVE_POLICY, SERVICE_DIR, TASK_FOLDER, TOKEN_PATH } from './setup'

/**
 * The guest's second door (docs/agents/work-winvm.md "The helper"): tc-office.exe, the Office helper
 * (native/tc-office-win/TcOffice.cs), running as tcuser on its desktop and listening on the guest's
 * loopback behind the door's own token. It reads OneDrive's folders as tcuser, the one caller Files
 * On-Demand surely downloads for, and drives Office by COM in tcuser's session; the Teams files and
 * the Office tools reach it through a second forward on the keeper's SSH connection.
 *
 * Nothing of it ships as a program: the box carries the helper's C# source, and the guest's own
 * csc.exe compiles it as the admin whenever the guest's copy differs (its sha256 beside it), so the
 * helper is always this build's. tcuser can run it and cannot replace it.
 */

/** The guest's loopback port the helper listens on. */
export const HELPER_PORT = 47801
export const HELPER_PATH = `${SERVICE_DIR}\\tc-office.exe`
export const HELPER_SHA_PATH = `${SERVICE_DIR}\\tc-office.sha`
export const HELPER_TASK = 'office'
export const NO_HELPER = 'The helper in the Windows VM did not answer.'
export const VM_ASLEEP = 'The Windows VM is asleep.'

/** The guest's copy is this build's when this matches: the source and how it is compiled. */
export const helperHash = (source: string): string => createHash('sha256').update(`uia-1\n${source}`).digest('hex')

/**
 * What makes the helper ready, as the admin, safe to run again: compile it when the guest's differs
 * from `source`, register its logon task (tcuser, on its desktop), and start it unless it runs. A
 * window-less build (`/target:winexe`), so no console shows on his desktop. Prints `compiled` when it built one.
 */
export function helperScript(source: string, port = HELPER_PORT, user = STANDARD_USER): string {
  const want = helperHash(source)
  return `
$ErrorActionPreference = 'Stop'
# a machine set up before these policies gets them here
${ONEDRIVE_POLICY}
${OFFICE_POLICY}
$exe = ${psQuote(HELPER_PATH)}
$shaFile = ${psQuote(HELPER_SHA_PATH)}
$want = ${psQuote(want)}
$have = if (Test-Path -LiteralPath $shaFile) { (Get-Content -Raw -LiteralPath $shaFile).Trim() } else { '' }
if ($have -ne $want -or -not (Test-Path -LiteralPath $exe)) {
  $src = Join-Path $env:TEMP "tc-office-$want.cs"
  $out = Join-Path $env:TEMP "tc-office-$want.exe"
  [IO.File]::WriteAllText($src, [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(${psQuote(Buffer.from(source, 'utf8').toString('base64'))})), (New-Object Text.UTF8Encoding($false)))
  $csc = Join-Path $env:SystemRoot 'Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe'
  $wpf = Join-Path $env:SystemRoot 'Microsoft.NET\\Framework64\\v4.0.30319\\WPF'
  # /define:UIA: the guest's build alone walks a sign-in window by the words on it (the Ui class in TcOffice.cs)
  $said = & $csc /nologo /optimize /target:winexe /define:UIA /r:System.Core.dll /r:System.Web.Extensions.dll /r:System.Windows.Forms.dll "/lib:$wpf" /r:UIAutomationClient.dll /r:UIAutomationTypes.dll /r:WindowsBase.dll "/out:$out" $src 2>&1 | Out-String
  if ($LASTEXITCODE) { throw "csc: $said" }
  Get-Process tc-office -ErrorAction SilentlyContinue | Stop-Process -Force
  Start-Sleep -Milliseconds 500
  # a copy, not a move: a moved file keeps the admin profile's ACL, which tcuser may not run
  Remove-Item -Force -LiteralPath $exe -ErrorAction SilentlyContinue
  Copy-Item -LiteralPath $out -Destination $exe
  icacls $exe /reset /Q | Out-Null
  if ($LASTEXITCODE) { throw "icacls exited $LASTEXITCODE" }
  [IO.File]::WriteAllText($shaFile, $want)
  Remove-Item -Force -LiteralPath $src, $out -ErrorAction SilentlyContinue
  'compiled'
}
$account = "$env:COMPUTERNAME\\${user}"
$svc = New-Object -ComObject Schedule.Service
$svc.Connect()
try { $folder = $svc.GetFolder(${psQuote(TASK_FOLDER)}) } catch { $folder = $svc.GetFolder('\\').CreateFolder(${psQuote(TASK_FOLDER)}) }
$helperArgs = ${psQuote(`serve --listen 127.0.0.1:${port} --token-file "${TOKEN_PATH}"`)}
try { $task = $folder.GetTask(${psQuote(HELPER_TASK)}) } catch { $task = $null }
if (-not $task -or $task.Definition.Actions.Item(1).Arguments -ne $helperArgs) {
  $def = $svc.NewTask(0)
  $def.RegistrationInfo.Description = 'TempCode: the Office and OneDrive helper the box reaches (serve --listen)'
  $def.Principal.UserId = $account
  $def.Principal.LogonType = 3
  $def.Principal.RunLevel = 0
  $def.Settings.ExecutionTimeLimit = 'PT0S'
  $def.Settings.MultipleInstances = 2
  $def.Settings.DisallowStartIfOnBatteries = $false
  $def.Settings.StopIfGoingOnBatteries = $false
  $trigger = $def.Triggers.Create(9)
  $trigger.UserId = $account
  $action = $def.Actions.Create(0)
  $action.Path = $exe
  $action.Arguments = $helperArgs
  $action.WorkingDirectory = "C:\\Users\\${user}\\Documents"
  $folder.RegisterTaskDefinition(${psQuote(HELPER_TASK)}, $def, 6, $account, $null, 3) | Out-Null
  $task = $folder.GetTask(${psQuote(HELPER_TASK)})
}
if (-not (Get-Process tc-office -ErrorAction SilentlyContinue)) { $task.Run($null) | Out-Null }
'ready'
`
}

/**
 * The helper's knock: the token, then its `ready` frame. True only when the helper itself answers,
 * since the forward accepts a connection whether or not anything listens behind it.
 */
export function knockHelper(socket: string, token: string, timeoutMs = 5000): Promise<boolean> {
  return new Promise((resolve) => {
    const s = connect(socket)
    let buf = ''
    let done = false
    const finish = (ok: boolean) => {
      if (done) return
      done = true
      clearTimeout(timer)
      s.destroy()
      resolve(ok)
    }
    const timer = setTimeout(() => finish(false), timeoutMs)
    s.on('connect', () => s.write(`${token}\n`))
    s.on('data', (d: Buffer) => {
      buf += d.toString()
      if (buf.includes('"ready"')) finish(true)
    })
    s.on('error', () => finish(false))
    s.on('close', () => finish(false))
  })
}

/** What the door needs of the keeper: its wake, its state and the admin's shell. */
export interface HelperKeeper {
  door(): Promise<{ socket: string; token: string }>
  state(): WinvmState
  admin(script: string): Promise<string>
  touch(): void
}

export interface HelperDoorDeps {
  keeper(): HelperKeeper | null
  /** the unix socket the keeper's forward to the helper listens on */
  socket: string
  /** the helper's C# source, as this build carries it */
  source: string
  log(line: string): void
  knock?: (socket: string, token: string) => Promise<boolean>
  /** how long the helper has to answer after its start, and between knocks */
  knockMs?: number
  knockEvery?: number
}

export const WORK_OFF = 'Work is off on this host'

export class HelperDoor {
  /** the keeper's `since` of the awake spell the helper was made ready in: a new wake checks it again */
  private readyFor: number | null = null
  private opening: Promise<void> | null = null

  constructor(private readonly d: HelperDoorDeps) {}

  /** Wakes the machine, makes the helper this build's and running, and answers its door. */
  async open(): Promise<{ socket: string; token: string }> {
    const keeper = this.d.keeper()
    if (!keeper) throw new Error(WORK_OFF)
    const { token } = await keeper.door()
    keeper.touch()
    const spell = keeper.state().since
    if (this.readyFor !== spell) {
      this.opening ??= this.ready(keeper, token, spell).finally(() => (this.opening = null))
      await this.opening
    }
    return { socket: this.d.socket, token }
  }

  /** The door while the machine is awake; null while it is not. Never wakes it. */
  async openIfAwake(): Promise<{ socket: string; token: string } | null> {
    const keeper = this.d.keeper()
    if (!keeper || keeper.state().state !== 'awake') return null
    return this.open()
  }

  /** Forget that the helper was ready: its connection failed, so the next call checks the guest again. */
  doubt(): void {
    this.readyFor = null
  }

  private async ready(keeper: HelperKeeper, token: string, spell: number): Promise<void> {
    const knock = this.d.knock ?? knockHelper
    // The helper of an awake machine usually runs already (its logon task): one knock saves the admin's script.
    if (this.readyFor !== null && (await knock(this.d.socket, token))) {
      this.readyFor = spell
      return
    }
    const said = await keeper.admin(helperScript(this.d.source))
    if (said.includes('compiled')) this.d.log('winvm: compiled the Office helper in the guest')
    const end = Date.now() + (this.d.knockMs ?? 20_000)
    for (;;) {
      if (await knock(this.d.socket, token)) break
      if (Date.now() >= end) throw new Error(NO_HELPER)
      await new Promise((r) => setTimeout(r, this.d.knockEvery ?? 500))
    }
    this.readyFor = spell
  }
}
