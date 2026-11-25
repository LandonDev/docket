import { STANDARD_USER } from './machine/config'
import { psQuote } from './machine/guest'
import { DATA_DIR } from './setup'

/**
 * What live resize does inside the guest, as the admin (docs/agents/work-winvm.md "Live resize"): Red Hat's
 * viogpudo staged before the move to virtio-vga, and the hardware pointer after it. The keeper runs the steps
 * (keeper.ts `upgrade`); every script here is safe to run again.
 */

/** The driver's files the keeper copies in: the INF, its signed catalogue and the driver. */
export const DRIVER_FILES = ['viogpudo.inf', 'viogpudo.cat', 'viogpudo.sys'] as const
/** Where they are staged from, under the folder only admins write. */
export const DRIVER_DIR = `${DATA_DIR}\\viogpu`
/** The box's colour I-beam with alpha (resources/winvm): Windows hands it to the driver as a hardware pointer, where its own monochrome I-beam is drawn into the picture beside the last hardware shape. */
export const IBEAM_FILE = 'tc-ibeam.cur'
/** tcuser reads it there: the folder grants tcuser read and run, and a copy takes the folder's rights (a moved file keeps the admin profile's). */
export const IBEAM_PATH = `${DATA_DIR}\\${IBEAM_FILE}`
/** The adapter Windows names once viogpudo has bound virtio-vga (the M0 spike). */
export const VIRTIO_ADAPTER = 'Red Hat VirtIO GPU DOD controller'

/** Loads tcuser's hive when it is not (tcuser logged off), as setup does; leaves `$hive` and `$loaded`. */
const userHive = (user: string): string => `$sid = (New-Object Security.Principal.NTAccount(${psQuote(user)})).Translate([Security.Principal.SecurityIdentifier]).Value
$loaded = Test-Path -LiteralPath "Registry::HKEY_USERS\\$sid"
if ($loaded) { $hive = "Registry::HKEY_USERS\\$sid" } else {
  reg load "HKU\\tc-${user}" "C:\\Users\\${user}\\NTUSER.DAT" | Out-Null
  if ($LASTEXITCODE) { throw "reg load exited $LASTEXITCODE" }
  $hive = "Registry::HKEY_USERS\\tc-${user}"
}`

/**
 * Step 2: the files the keeper uploaded into the admin's profile copied into place, the driver staged with pnputil
 * (the device is not there yet, so it binds nothing), and tcuser's I-beam set to the box's colour one, read at the
 * logon of the start on virtio. A new disk's setup runs on virtio-vga from its first boot, under the Basic Display
 * Driver: `install` binds viogpudo to the device there now, taken at setup's restart. Prints `staged` last.
 */
export function stageScript({ user = STANDARD_USER, install = false }: { user?: string; install?: boolean } = {}): string {
  return `
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force ${psQuote(DRIVER_DIR)} | Out-Null
foreach ($f in @(${DRIVER_FILES.map(psQuote).join(', ')})) {
  Copy-Item -Force (Join-Path $env:USERPROFILE $f) ${psQuote(DRIVER_DIR)}
  Remove-Item -Force (Join-Path $env:USERPROFILE $f)
}
Copy-Item -Force (Join-Path $env:USERPROFILE ${psQuote(IBEAM_FILE)}) ${psQuote(IBEAM_PATH)}
Remove-Item -Force (Join-Path $env:USERPROFILE ${psQuote(IBEAM_FILE)})
pnputil /add-driver ${psQuote(`${DRIVER_DIR}\\viogpudo.inf`)}${install ? ' /install' : ''}
if ($LASTEXITCODE -and $LASTEXITCODE -ne 3010) { throw "pnputil exited $LASTEXITCODE" }
${userHive(user)}
try {
  $cursors = "$hive\\Control Panel\\Cursors"
  if (-not (Test-Path -LiteralPath $cursors)) { New-Item -Path $cursors -Force | Out-Null }
  Set-ItemProperty -LiteralPath $cursors -Name 'IBeam' -Value ${psQuote(IBEAM_PATH)} -Type ExpandString
} finally {
  if (-not $loaded) { [gc]::Collect(); reg unload "HKU\\tc-${user}" | Out-Null }
}
'staged'
`
}

/** Step 5's check: the display adapters Windows names, one a line. */
export const ADAPTERS_SCRIPT = 'Get-CimInstance Win32_VideoController | ForEach-Object { $_.Name }'

/**
 * Step 6: `HWCursor=1` in viogpudo's driver key (its INF writes 0), so Windows sends the pointer apart from the
 * picture, and the device restarted to read it. Nothing is restarted when it is 1 already. Prints `hwcursor on`.
 */
export const CURSOR_SCRIPT = `
$ErrorActionPreference = 'Stop'
$dev = Get-PnpDevice -Class Display -PresentOnly | Where-Object FriendlyName -eq ${psQuote(VIRTIO_ADAPTER)} | Select-Object -First 1
if (-not $dev) { throw 'no VirtIO GPU adapter' }
$key = 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\' + (Get-PnpDeviceProperty -InstanceId $dev.InstanceId -KeyName DEVPKEY_Device_Driver).Data
if ((Get-ItemProperty -LiteralPath $key -Name HWCursor -ErrorAction SilentlyContinue).HWCursor -ne 1) {
  Set-ItemProperty -LiteralPath $key -Name 'HWCursor' -Value 1 -Type DWord
  pnputil /restart-device $dev.InstanceId | Out-Null
  if ($LASTEXITCODE -and $LASTEXITCODE -ne 3010) { throw "pnputil exited $LASTEXITCODE" }
}
'hwcursor on'
`
