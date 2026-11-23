import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
 * helper is always this build's. tcuser can run it and cannot replace it. The source crosses as a file
 * over scp, only then; each wake sends the small check alone.
 */

/** The guest's loopback port the helper listens on. */
export const HELPER_PORT = 47801
export const HELPER_PATH = `${SERVICE_DIR}\\tc-office.exe`
export const HELPER_SHA_PATH = `${SERVICE_DIR}\\tc-office.sha`
export const HELPER_TASK = 'office'
export const NO_HELPER = 'The helper in the Windows VM did not answer.'
/** No helper runs and another process holds its port, so a new one cannot start (programs an older helper started kept it). */
export const portHeld = (names: string): string =>
  `The helper in the Windows VM cannot start while ${names || 'another program'} ${names.includes(',') ? 'hold' : 'holds'} its port ${HELPER_PORT}. Close ${names.includes(',') ? 'them' : 'it'} in the VM, then try again.`
export const VM_ASLEEP = 'The Windows VM is asleep.'

/** The guest's copy is this build's when this matches: the source and how it is compiled. */
export const helperHash = (source: string): string => createHash('sha256').update(`uia-1\n${source}`).digest('hex')

/**
 * The check at each new awake spell, as the admin, small and safe to run again: machine policies, then `stale` (and
 * nothing more) when the guest's copy is not this build's, else the helper's logon task (tcuser, on its desktop)
 * registered with these arguments and the helper started unless it runs, then `ready`. A wake with a current helper
 * sends this alone, a few KB, never the source (the source rode in this script until 2026-11-22: 111 KB on stdin,
 * which this guest's sshd now and then never finished: "The helper door's hang on wake" in F-vm-files.md).
 */
export function helperCheckScript(want: string, port = HELPER_PORT, user = STANDARD_USER): string {
  return `
$ErrorActionPreference = 'Stop'
# a machine set up before these policies gets them here
${ONEDRIVE_POLICY}
${OFFICE_POLICY}
$exe = ${psQuote(HELPER_PATH)}
$shaFile = ${psQuote(HELPER_SHA_PATH)}
$have = if (Test-Path -LiteralPath $shaFile) { (Get-Content -Raw -LiteralPath $shaFile).Trim() } else { '' }
if ($have -ne ${psQuote(want)} -or -not (Test-Path -LiteralPath $exe)) { 'stale'; return }
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
if (-not (Get-Process tc-office -ErrorAction SilentlyContinue)) {
  # a helper started with no helper running exits when another process holds its port: say who, not "no answer"
  $held = @(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue)
  if ($held) {
    $owner = $held[0].OwningProcess
    # a helper just started by another caller already listens: that one serves
    if ((Get-Process -Id $owner -ErrorAction SilentlyContinue).Name -eq 'tc-office') { 'ready'; return }
    "port-held: $(@(Get-CimInstance Win32_Process -Filter "ProcessId=$owner or ParentProcessId=$owner" | ForEach-Object { $_.Name }) -join ', ')"
    return
  }
  $task.Run($null) | Out-Null
}
'ready'
`
}

/** The name the source takes in the admin's profile on its way in (scp's own home). */
export const helperSourceName = (want: string): string => `tc-office-${want.slice(0, 16)}.cs`

/**
 * Compiles the source the host copied into the admin's profile (`helperSourceName`) with the guest's own csc and
 * puts it in place of the guest's copy, as the admin. A window-less build (`/target:winexe`), so no console shows on
 * his desktop. Prints `compiled`; the check after it registers the task and starts the new helper.
 */
export function helperCompileScript(want: string): string {
  return `
$ErrorActionPreference = 'Stop'
$exe = ${psQuote(HELPER_PATH)}
$src = Join-Path $env:USERPROFILE ${psQuote(helperSourceName(want))}
$out = Join-Path $env:TEMP ${psQuote(`tc-office-${want}.exe`)}
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
[IO.File]::WriteAllText(${psQuote(HELPER_SHA_PATH)}, ${psQuote(want)})
Remove-Item -Force -LiteralPath $src, $out -ErrorAction SilentlyContinue
'compiled'
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

/** What the door needs of the keeper: its wake, its state, the admin's shell and a copy into the admin's profile. */
export interface HelperKeeper {
  door(): Promise<{ socket: string; token: string }>
  state(): WinvmState
  admin(script: string, timeoutMs?: number): Promise<string>
  /** copies `local` into the admin's profile as `name`, over scp */
  upload(local: string, name: string): Promise<void>
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
/** One run of the check: it answers in well under a second, so a run past this is a hang, not a slow guest. */
export const CHECK_MS = 15_000
/** One compile: csc takes a few seconds on the 80 KB source. */
const COMPILE_MS = 120_000

const words = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 300)

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
    const want = helperHash(this.d.source)
    let said = await this.check(keeper, want)
    if (said.includes('stale')) {
      await this.compile(keeper, want)
      said = await this.check(keeper, want)
      if (said.includes('stale')) throw new Error("The helper in the Windows VM was compiled, but the guest's copy still reads as another build.")
    }
    const held = /port-held: ?(.*)/.exec(said)
    if (held) throw new Error(portHeld(held[1]!.trim()))
    const end = Date.now() + (this.d.knockMs ?? 20_000)
    for (;;) {
      if (await knock(this.d.socket, token)) break
      if (Date.now() >= end) throw new Error(NO_HELPER)
      await new Promise((r) => setTimeout(r, this.d.knockEvery ?? 500))
    }
    this.readyFor = spell
  }

  /** The small check, given CHECK_MS and run once more: a hang costs seconds, and the error says which step failed. */
  private async check(keeper: HelperKeeper, want: string): Promise<string> {
    const script = helperCheckScript(want)
    try {
      return await keeper.admin(script, CHECK_MS)
    } catch (first) {
      this.d.log(`winvm: the helper's check did not finish (${words(first)}); running it once more`)
      return keeper.admin(script, CHECK_MS).catch((e) => {
        throw new Error(`The helper check in the Windows VM failed twice: ${words(e)}`)
      })
    }
  }

  /** The source across as a file over scp (never on a script's stdin), then the guest's csc. */
  private async compile(keeper: HelperKeeper, want: string): Promise<void> {
    const dir = mkdtempSync(join(tmpdir(), 'tc-office-'))
    try {
      const local = join(dir, helperSourceName(want))
      writeFileSync(local, this.d.source)
      await keeper.upload(local, helperSourceName(want)).catch((e) => {
        throw new Error(`Copying the helper's source into the Windows VM failed: ${words(e)}`)
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
    await keeper.admin(helperCompileScript(want), COMPILE_MS).catch((e) => {
      throw new Error(`Compiling the helper in the Windows VM failed: ${words(e)}`)
    })
    this.d.log('winvm: compiled the Office helper in the guest')
  }
}
