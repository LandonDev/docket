/** What the host sends into the guest: PowerShell scripts carried whole, so nothing is re-quoted by cmd.exe. */

/** powershell.exe's -EncodedCommand takes base64 of UTF-16LE. */
export function encodePowerShell(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64')
}

export function psCommand(script: string): string {
  return `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encodePowerShell(script)}`
}

/**
 * Reads base64 of a UTF-8 script from stdin and runs it, so a script of any length passes cmd.exe's 8191-character
 * line. With its stdin piped, powershell.exe writes errors, warnings and progress to stderr as CLIXML; this writes
 * errors and warnings as plain lines, drops progress and verbose output, and exits like a script would: with its
 * own `exit` code, else the last native program's failing code, else 1 if an error was written.
 */
const STDIN_BOOT = [
  "$ProgressPreference = 'SilentlyContinue'; $global:failed = $false;",
  'try { & ([scriptblock]::Create([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd())))) *>&1 |',
  'ForEach-Object {',
  'if ($_ -is [Management.Automation.ErrorRecord]) { $global:failed = $true; [Console]::Error.WriteLine($_.ToString()) }',
  "elseif ($_ -is [Management.Automation.WarningRecord]) { [Console]::Error.WriteLine('WARNING: ' + $_.Message) }",
  'elseif ($_ -isnot [Management.Automation.InformationalRecord]) { $_ } } |',
  'Out-String -Stream -Width 4096 }',
  'catch { [Console]::Error.WriteLine($_.ToString()); exit 1 }',
  'if ($LASTEXITCODE) { exit $LASTEXITCODE } elseif ($global:failed) { exit 1 }'
].join(' ')

/** A PowerShell script for ssh: a short fixed command line, the script itself on stdin. */
export function psStdin(script: string): { command: string; input: string } {
  return { command: psCommand(STDIN_BOOT), input: Buffer.from(script, 'utf8').toString('base64') }
}

/** A PowerShell single-quoted literal: nothing inside expands, a quote is doubled. */
export function psQuote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`
}

/** One argument as CommandLineToArgvW reads it back: quoted when it holds a space, tab or quote, backslashes before a quote doubled. */
export function winQuote(arg: string): string {
  if (arg !== '' && !/[\s"]/.test(arg)) return arg
  let out = '"'
  let slashes = 0
  for (const ch of arg) {
    if (ch === '\\') {
      slashes++
      continue
    }
    out += ch === '"' ? '\\'.repeat(slashes * 2 + 1) + '"' : '\\'.repeat(slashes) + ch
    slashes = 0
  }
  return out + '\\'.repeat(slashes * 2) + '"'
}

/** Who answers and on what: the user, whether elevated, the Windows build, the evaluation's days left, the session id. */
export const WINVER_SCRIPT = `
$v = Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion'
$name = $v.ProductName
if ([int]$v.CurrentBuild -ge 22000) { $name = $name -replace 'Windows 10', 'Windows 11' }
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
"user:       $(whoami) (elevated: $admin)"
"windows:    $name $($v.DisplayVersion), build $($v.CurrentBuild).$($v.UBR)"
# Only an admin may read the licence over ssh.
$lic = Get-CimInstance SoftwareLicensingProduct -Filter "PartialProductKey IS NOT NULL AND ApplicationID='55c92734-d682-4d71-983e-d6ec3f16059f'" -ErrorAction SilentlyContinue | Select-Object -First 1
if ($lic) { "evaluation: $([math]::Floor($lic.GracePeriodRemaining / 1440)) days left" }
"session:    $((Get-Process -Id $PID).SessionId) (ssh runs outside the desktop session)"
`

export interface InSessionRun {
  argv: string[]
  /** Wait for the program to exit, then print its output and pass on its exit code. */
  wait: boolean
  timeoutSec: number
  cwd?: string
}

/** How long a task may take to start before the desktop session is taken to be missing. */
export const START_TIMEOUT_SEC = 20

/**
 * What a --wait task runs on the desktop: the program (environment variables in its path expanded) with the
 * command line Windows reads back as exactly these arguments (PowerShell 5.1's own native-call quoting drops
 * embedded quotes), its stdout then its stderr to a file the ssh side reads back, and its exit code.
 */
export function waitedProgramScript(argv: string[], name: string): string {
  const [program, ...args] = argv
  return [
    `$out = Join-Path $env:LOCALAPPDATA ${psQuote(`tc-run\\${name}.out`)}`,
    '$psi = New-Object Diagnostics.ProcessStartInfo',
    `$psi.FileName = [Environment]::ExpandEnvironmentVariables(${psQuote(program)})`,
    `$psi.Arguments = ${psQuote(args.map(winQuote).join(' '))}`,
    '$psi.UseShellExecute = $false',
    '$psi.RedirectStandardOutput = $true',
    '$psi.RedirectStandardError = $true',
    'try { $proc = [Diagnostics.Process]::Start($psi) } catch { "not found: $($psi.FileName)" | Out-File -Encoding utf8 $out; exit 127 }',
    '$stdout = $proc.StandardOutput.ReadToEndAsync()',
    '$stderr = $proc.StandardError.ReadToEndAsync()',
    '$proc.WaitForExit()',
    '[IO.File]::WriteAllText($out, $stdout.Result + $stderr.Result)',
    'exit $proc.ExitCode'
  ].join('\n')
}

/**
 * Starts a program on the logged-on user's desktop. A program started over SSH runs outside the interactive
 * session, where no window opens and UI Automation sees nothing; a scheduled task with an Interactive logon
 * (what schtasks /IT makes) runs inside it. The SSH user registers the task for itself, so no password is
 * needed, through the Task Scheduler's own COM API: the ScheduledTasks cmdlets go through WMI, which Windows
 * refuses a standard user over SSH. Tasks are named tc-run-*; a --wait run removes its own, others are cleared
 * an hour after they were registered, unless still running.
 * Exit codes: the program's own with --wait; 124 still running at --timeout; 125 no desktop session took
 * it; 126 it ended at once with an error (no --wait).
 */
export function runInSessionScript(r: InSessionRun, name: string): string {
  if (r.argv.length === 0) throw new Error('run-in-session needs a program')
  const [program, ...rest] = r.argv
  const [path, args] = r.wait
    ? ['powershell.exe', `-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -EncodedCommand ${encodePowerShell(waitedProgramScript(r.argv, name))}`]
    : [program, rest.map(winQuote).join(' ')]
  return `
$ErrorActionPreference = 'Stop'
$name = ${psQuote(name)}
function Fail($code, $msg) { [Console]::Error.WriteLine($msg); exit $code }
$svc = New-Object -ComObject Schedule.Service
$svc.Connect()
$root = $svc.GetFolder('\')
foreach ($t in @($root.GetTasks(0))) {
  if ($t.Name -like 'tc-run-*' -and $t.State -ne 4) {
    $when = [datetime]::MinValue
    if ([datetime]::TryParse($t.Definition.RegistrationInfo.Description, [ref]$when) -and $when -lt (Get-Date).AddHours(-1)) { $root.DeleteTask($t.Name, 0) }
  }
}
$dir = Join-Path $env:LOCALAPPDATA 'tc-run'
New-Item -ItemType Directory -Force $dir | Out-Null
$out = Join-Path $dir "$name.out"
$def = $svc.NewTask(0)
$def.RegistrationInfo.Description = (Get-Date).ToString('o')
$def.Principal.UserId = $env:USERNAME
$def.Principal.LogonType = 3
$def.Principal.RunLevel = 0
$def.Settings.ExecutionTimeLimit = 'PT0S'
$def.Settings.MultipleInstances = 0
$def.Settings.DisallowStartIfOnBatteries = $false
$def.Settings.StopIfGoingOnBatteries = $false
$action = $def.Actions.Create(0)
$action.Path = ${psQuote(path)}
$action.Arguments = ${psQuote(args)}
${r.cwd ? `$action.WorkingDirectory = ${psQuote(r.cwd)}` : ''}
$task = $root.RegisterTaskDefinition($name, $def, 6, $null, $null, 3)
$task.Run($null) | Out-Null
$wait = $${r.wait ? 'true' : 'false'}
$startBy = (Get-Date).AddSeconds(${START_TIMEOUT_SEC})
$endBy = (Get-Date).AddSeconds(${r.timeoutSec})
$started = $false
while ($true) {
  $t = $root.GetTask($name)
  $res = [int]$t.LastTaskResult
  $running = $t.State -eq 4
  $started = $started -or $running -or $res -ne 267011
  if (-not $started) {
    if ((Get-Date) -gt $startBy) { $root.DeleteTask($name, 0); Fail 125 "did not start: is $env:USERNAME logged on at the desktop?" }
  } elseif (-not $running -and $res -ne 267009) { break }
  elseif (-not $wait) { break }
  elseif ((Get-Date) -gt $endBy) { Fail 124 "still running after ${r.timeoutSec} s (task $name)" }
  Start-Sleep -Milliseconds 250
}
if ($wait) {
  if (Test-Path $out) { Get-Content -Raw $out | Write-Output; Remove-Item $out }
  $root.DeleteTask($name, 0)
  exit $res
}
if (-not $running -and $res -ne 0) { Fail 126 ('ended at once with 0x{0:X8} (task {1})' -f $res, $name) }
"started $name in session $((Get-Process -Name explorer -ErrorAction SilentlyContinue | Select-Object -First 1).SessionId)"
`
}
