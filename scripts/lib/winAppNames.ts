/**
 * Where the app sits on a PC, under either of its names (src/shared/appName.ts KNOWN_APP_NAMES): a fresh
 * install is Programs\Docket\Docket.exe; an update over an install from before the rename keeps the folder the
 * installer recorded, Programs\TempCode, with Docket.exe in it; an install never updated is TempCode\TempCode.exe.
 * The rig proofs find the app through these, never by one fixed path.
 */
import { KNOWN_APP_NAMES } from '../../src/shared/appName'

/** Every exe the app may be under %LOCALAPPDATA% (`local`), the newest name first. */
export function appExeCandidates(local: string): string[] {
  return KNOWN_APP_NAMES.flatMap((dir) => KNOWN_APP_NAMES.map((exe) => `${local}\\Programs\\${dir}\\${exe}.exe`))
}

/** PowerShell that prints the first of those that exists, or nothing. */
export const findAppExePs = (local: string): string =>
  `${appExeCandidates(local).map((p) => `'${p}'`).join(',')} | Where-Object { Test-Path $_ } | Select-Object -First 1`

/** The app's processes by either name, for Get-Process. */
export const APP_PROCESSES = KNOWN_APP_NAMES.join(',')

/** The folder and the exe's stem of a found exe; the stem is also its shortcut's name. */
export function appOf(exe: string): { dir: string; exe: string; name: string } {
  const at = exe.lastIndexOf('\\')
  return { dir: exe.slice(0, at), exe, name: exe.slice(at + 1).replace(/\.exe$/i, '') }
}
