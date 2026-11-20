import { STANDARD_USER } from './machine/config'
import { psQuote } from './machine/guest'

/**
 * What setup does inside the guest, as the admin, in one PowerShell script
 * (docs/agents/work-winvm.md "Setup"). Every step can run again on a guest
 * that has it: setup on a machine already set up changes nothing that is
 * right. A restart follows, since tcuser's policies are read at logon.
 */

/** Where the service lives: the standard user can run it and cannot replace it. */
export const SERVICE_DIR = 'C:\\Program Files\\TempCode'
export const SERVICE_PATH = `${SERVICE_DIR}\\tc-computer.exe`
/** The token file and the service's incoming copy: admins write, tcuser only reads. */
export const DATA_DIR = 'C:\\ProgramData\\TempCode'
export const TOKEN_PATH = `${DATA_DIR}\\token`
/** The guest's loopback port the door listens on; the keeper's SSH forward reaches it. */
export const DOOR_PORT = 47800
/** The logon task, in its own folder of the Task Scheduler. */
export const TASK_FOLDER = '\\TempCode'
export const TASK_NAME = 'door'

/**
 * What tcuser may not start from Explorer (the address bar, Run, Start, a
 * double-click): the consoles, the script hosts and the programs that run a
 * document as code. `DisallowRun` reads the file name only.
 */
export const DISALLOWED = [
  'cmd.exe', 'powershell.exe', 'pwsh.exe', 'powershell_ise.exe', 'wt.exe', 'WindowsTerminal.exe', 'wsl.exe', 'bash.exe',
  'mshta.exe', 'wscript.exe', 'cscript.exe', 'regedit.exe', 'reg.exe', 'rundll32.exe', 'regsvr32.exe', 'msiexec.exe',
  'schtasks.exe', 'mmc.exe', 'certutil.exe', 'bitsadmin.exe', 'msbuild.exe', 'installutil.exe', 'ftp.exe', 'hh.exe',
  'msconfig.exe', 'forfiles.exe'
] as const

/** tcuser's own folders nothing may run from (Software Restriction Policies, path rules at Disallowed). */
export const NO_RUN_FOLDERS = ['Downloads', 'Documents', 'Desktop', 'AppData\\Local\\Temp'] as const

/** The file types those rules cover: SRP's own list with the script types added. */
export const RESTRICTED_TYPES = [
  'ADE', 'ADP', 'BAS', 'BAT', 'CHM', 'CMD', 'COM', 'CPL', 'CRT', 'EXE', 'HLP', 'HTA', 'INF', 'INS', 'ISP', 'JS', 'JSE',
  'LNK', 'MDB', 'MDE', 'MSC', 'MSI', 'MSP', 'MST', 'OCX', 'PCD', 'PIF', 'PS1', 'REG', 'SCR', 'SHS', 'URL', 'VB', 'VBE',
  'VBS', 'WSC', 'WSF', 'WSH'
] as const

/** Windows Terminal as the default terminal: every console is hosted by it, so a console always reports as WindowsTerminal.exe. */
export const TERMINAL_DELEGATION = {
  DelegationConsole: '{2EACA947-7F5F-4CFA-BA87-8F7FBEEFBE69}',
  DelegationTerminal: '{E12CFF52-A866-4C77-9A90-F570A7AA2C6B}'
} as const

export interface SetupInput {
  token: string
  port?: number
  user?: string
}

const list = (xs: readonly string[]) => `@(${xs.map(psQuote).join(', ')})`

export function setupScript({ token, port = DOOR_PORT, user = STANDARD_USER }: SetupInput): string {
  if (!/^[\x21-\x7e]{32,}$/.test(token)) throw new Error('the door token must be 32 printable characters at least')
  return `
$ErrorActionPreference = 'Stop'
$user = ${psQuote(user)}
$account = "$env:COMPUTERNAME\\$user"
function Ensure-Key($path) { if (-not (Test-Path -LiteralPath $path)) { New-Item -Path $path -Force | Out-Null } }
function Set-Value($path, $name, $value, $type) { Ensure-Key $path; Set-ItemProperty -LiteralPath $path -Name $name -Value $value -Type $type }

# 1. The service's folder (Program Files: tcuser runs it and cannot replace it) and the token, which tcuser only reads.
New-Item -ItemType Directory -Force ${psQuote(SERVICE_DIR)} | Out-Null
New-Item -ItemType Directory -Force ${psQuote(DATA_DIR)} | Out-Null
icacls ${psQuote(DATA_DIR)} /inheritance:r /grant:r 'Administrators:(OI)(CI)F' 'SYSTEM:(OI)(CI)F' "$($user):(OI)(CI)RX" | Out-Null
if ($LASTEXITCODE) { throw "icacls exited $LASTEXITCODE" }
[IO.File]::WriteAllText(${psQuote(TOKEN_PATH)}, ${psQuote(token)} + [Environment]::NewLine)
"step: service folder and token"

# 2. The logon task: at each logon of tcuser, the door on its desktop.
$svc = New-Object -ComObject Schedule.Service
$svc.Connect()
try { $folder = $svc.GetFolder(${psQuote(TASK_FOLDER)}) } catch { $folder = $svc.GetFolder('\\').CreateFolder(${psQuote(TASK_FOLDER)}) }
$def = $svc.NewTask(0)
$def.RegistrationInfo.Description = 'TempCode: the service the box drives (serve --listen)'
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
$action.Path = ${psQuote(SERVICE_PATH)}
$action.Arguments = ${psQuote(`serve --listen 127.0.0.1:${port} --token-file "${TOKEN_PATH}"`)}
$folder.RegisterTaskDefinition(${psQuote(TASK_NAME)}, $def, 6, $account, $null, 3) | Out-Null
"step: logon task"

# 3. Hibernate on (the keeper's sleep), never by Windows itself, and no sign-in asked on resume.
powercfg /hibernate on
powercfg /hibernate /type full
powercfg /change hibernate-timeout-ac 0
powercfg /setacvalueindex SCHEME_CURRENT SUB_NONE CONSOLELOCK 0
powercfg /setdcvalueindex SCHEME_CURRENT SUB_NONE CONSOLELOCK 0
powercfg /setactive SCHEME_CURRENT
$wake = 'HKLM:\\SOFTWARE\\Policies\\Microsoft\\Power\\PowerSettings\\0e796bdb-100d-47d6-a2d5-f7d2daa51f51'
Set-Value $wake 'ACSettingIndex' 0 DWord
Set-Value $wake 'DCSettingIndex' 0 DWord
"step: hibernate, no lock on resume"

# 4. Windows Update on (the rig's image turned it off).
Remove-ItemProperty -LiteralPath 'HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows\\WindowsUpdate\\AU' -Name NoAutoUpdate -ErrorAction SilentlyContinue
Set-Service wuauserv -StartupType Manual
"step: Windows Update"

# 5. tcuser's own policies: no command line. Its hive is loaded while it is logged on; otherwise load it here.
$sid = (New-Object Security.Principal.NTAccount($user)).Translate([Security.Principal.SecurityIdentifier]).Value
$loaded = Test-Path -LiteralPath "Registry::HKEY_USERS\\$sid"
if ($loaded) { $hive = "Registry::HKEY_USERS\\$sid" } else {
  reg load "HKU\\tc-$user" "C:\\Users\\$user\\NTUSER.DAT" | Out-Null
  if ($LASTEXITCODE) { throw "reg load exited $LASTEXITCODE" }
  $hive = "Registry::HKEY_USERS\\tc-$user"
}
try {
  Set-Value "$hive\\Software\\Policies\\Microsoft\\Windows\\System" 'DisableCMD' 1 DWord
  $explorer = "$hive\\Software\\Microsoft\\Windows\\CurrentVersion\\Policies\\Explorer"
  Set-Value $explorer 'NoRun' 1 DWord
  Set-Value $explorer 'DisallowRun' 1 DWord
  if (Test-Path -LiteralPath "$explorer\\DisallowRun") { Remove-Item -LiteralPath "$explorer\\DisallowRun" -Recurse -Force }
  $i = 1
  foreach ($exe in ${list(DISALLOWED)}) { Set-Value "$explorer\\DisallowRun" "$i" $exe String; $i++ }
  $console = "$hive\\Console\\%%Startup"
  Set-Value $console 'DelegationConsole' ${psQuote(TERMINAL_DELEGATION.DelegationConsole)} String
  Set-Value $console 'DelegationTerminal' ${psQuote(TERMINAL_DELEGATION.DelegationTerminal)} String
} finally {
  if (-not $loaded) { [gc]::Collect(); reg unload "HKU\\tc-$user" | Out-Null }
}
"step: tcuser's policies"

# 6. Software Restriction Policies: nothing of these types runs from tcuser's own folders (admins are not bound).
$safer = 'HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows\\Safer\\CodeIdentifiers'
Set-Value $safer 'DefaultLevel' 0x40000 DWord
Set-Value $safer 'PolicyScope' 1 DWord
Set-Value $safer 'TransparentEnabled' 1 DWord
Set-Value $safer 'AuthenticodeEnabled' 0 DWord
Set-Value $safer 'ExecutableTypes' ${list(RESTRICTED_TYPES)} MultiString
$paths = "$safer\\0\\Paths"
Ensure-Key $paths
foreach ($k in @(Get-ChildItem -LiteralPath $paths)) { if ((Get-ItemProperty -LiteralPath $k.PSPath).Description -like 'TempCode:*') { Remove-Item -LiteralPath $k.PSPath -Recurse -Force } }
foreach ($sub in ${list(NO_RUN_FOLDERS)}) {
  $key = "$paths\\{$([guid]::NewGuid())}"
  Set-Value $key 'Description' "TempCode: nothing runs from $sub" String
  Set-Value $key 'ItemData' "C:\\Users\\$user\\$sub" ExpandString
  Set-Value $key 'SaferFlags' 0 DWord
}
"step: software restriction"
"setup done"
`
}

/** The steps a setup script must carry, by a line each prints; the keeper's test reads them back. */
export const SETUP_STEPS = ['service folder and token', 'logon task', 'hibernate, no lock on resume', 'Windows Update', "tcuser's policies", 'software restriction'] as const
