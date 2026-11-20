/**
 * What the keeper's rig proofs ask of the guest (scripts/e2e-winvm-keeper.ts, scripts/e2e-winvm-stop.ts):
 * Notepad started with a file's text on tcuser's desktop, and read back after a sleep. A hibernated guest
 * keeps the same Notepad process and the same boot time; a cold boot would not, even where Notepad
 * restores its tabs by itself.
 */
import type { SshGuest } from '../../src/main/server/work/winvm/sshGuest'
import { psQuote } from '../../src/main/server/work/winvm/machine/guest'

export const PROOF_TEXT = 'Left here before the Windows VM slept: 4711'
export const PROOF_FILE = 'C:\\Users\\tcuser\\Documents\\keeper-proof.txt'

export const log = (msg: string) => console.log(`[winvm-proof ${new Date().toISOString().slice(11, 19)}] ${msg}`)

export async function startNotepad(guest: SshGuest): Promise<void> {
  await guest.admin(`[IO.File]::WriteAllText(${psQuote(PROOF_FILE)}, ${psQuote(PROOF_TEXT)})`)
  await guest.onDesktop(['notepad.exe', PROOF_FILE], false)
  await new Promise((r) => setTimeout(r, 6000))
}

/**
 * Notepad's process, its edit control's text (WM_GETTEXT on its RichEdit child, read on tcuser's desktop: the
 * managed UI Automation client fails with E_UNEXPECTED from a task's PowerShell), and Windows' boot time.
 */
export async function readDesktop(guest: SshGuest): Promise<{ pid: string; text: string; boot: string }> {
  const read = [
    'Add-Type @"',
    'using System; using System.Text; using System.Runtime.InteropServices;',
    'public static class W {',
    '  public delegate bool EnumProc(IntPtr h, IntPtr l);',
    '  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr p, EnumProc f, IntPtr l);',
    '  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);',
    '  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr SendMessage(IntPtr h, int m, IntPtr w, StringBuilder l);',
    '  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h, int m, IntPtr w, IntPtr l);',
    '  public static string Text(IntPtr top) {',
    '    string found = null;',
    '    EnumChildWindows(top, (h, l) => { var c = new StringBuilder(256); GetClassName(h, c, 256);',
    '      if (found == null && (c.ToString().StartsWith("RichEdit") || c.ToString() == "Edit")) { int n = (int)SendMessage(h, 0x0E, IntPtr.Zero, IntPtr.Zero); var s = new StringBuilder(n + 1); SendMessage(h, 0x0D, (IntPtr)(n + 1), s); found = s.ToString(); }',
    '      return true; }, IntPtr.Zero);',
    '    return found;',
    '  }',
    '}',
    '"@',
    '$p = Get-Process notepad -ErrorAction SilentlyContinue | Where-Object MainWindowHandle -ne 0 | Select-Object -First 1',
    'if (-not $p) { "pid=none"; exit 0 }',
    '"pid=$($p.Id)"',
    '"text=$([W]::Text($p.MainWindowHandle))"'
  ].join('\n')
  const encoded = Buffer.from(`$ProgressPreference = 'SilentlyContinue'\n${read}`, 'utf16le').toString('base64')
  const out = await guest.onDesktop(['powershell.exe', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], true, 90)
  const boot = (await guest.admin('(Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString("o")')).trim()
  return { pid: /pid=(\S+)/.exec(out)?.[1] ?? '?', text: /text=(.*)/.exec(out)?.[1]?.trim() ?? '?', boot }
}
