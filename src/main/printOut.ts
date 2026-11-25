import { lstatSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { spawn as nodeSpawn } from 'node:child_process'
import { safeFileName } from '@shared/fileName'

/**
 * Print… (docs/agents/work-editors.md "Print"): the PDF Preview drew, handed
 * to this computer's own PDF viewer. On macOS Preview.app is asked to print it
 * with the system's print dialog in front; elsewhere, or when Preview cannot
 * be asked, the viewer opens the file and its print dialog is one key away.
 * The window sends the previewed bytes; this writes them to a file of its own.
 *
 * Why not Electron's own print: on the owner's Mac (macOS 27.2, Electron
 * 39.8.10, no printer set up) `webContents.print` refuses before any dialog
 * shows ("No printers available on the network"), from a hidden window, a
 * shown one and a window of page pictures alike (the DOC1.3 proof). The
 * system's viewer prints, and saves as PDF, with or without a printer.
 *
 * The file is a copy for the viewer to hold open. It lives under the
 * system's temp folder, never beside the document, and copies older than a
 * day go at the next print and at launch.
 */

export interface PrintDeps {
  /** the system's temp folder */
  temp: string
  /** opens a file in the system's own app for it; answers an error's words, or '' */
  open(path: string): Promise<string>
  /** macOS: asks the system's print dialog for a file, in front; `onLateRefusal` hears an Automation grant he refused after the answer */
  print?(path: string, onLateRefusal: () => void): Promise<PrintAsk>
  now?(): number
}

/** `refused`: the viewer stands in because he refused TempCode the Automation grant for Preview; the window says where to allow it. */
export type PrintAnswer = { ok: true; via: 'dialog' | 'viewer'; refused?: true } | { ok: false; error: string }

/** What asking Preview for its print dialog came to: up (or still asking), the Automation grant refused, or another failure. */
export type PrintAsk = 'dialog' | 'refused' | 'failed'

/** The most a print may be: what a preview's PDF can reach, and no more than a window should hand over. */
export const PRINT_MAX_BYTES = 256 * 1024 * 1024
const DAY = 24 * 60 * 60_000

export const printDir = (temp: string): string => join(temp, 'TempCode-print')

/** The most copies kept for the viewer at once: the oldest go first. */
export const PRINT_KEEP = 20
/** A name's length in bytes as a file system counts it (255 on APFS and ext4), with room to spare. */
const NAME_BYTES = 200

/** `text` cut to at most `max` UTF-8 bytes, never through a character. */
function clipBytes(text: string, max: number): string {
  let out = ''
  let used = 0
  for (const char of text) {
    used += Buffer.byteLength(char)
    if (used > max) break
    out += char
  }
  return out
}

/**
 * A name as a file's: nothing a path, a device or a file list could make of
 * it (`safeFileName`), short enough for any file system, and always a `.pdf`.
 */
export function printName(name: unknown): string {
  const given = (typeof name === 'string' ? name : '').replace(/\s+/g, ' ').trim().replace(/\.pdf$/i, '')
  // The stem is judged alone, so a device's name ("con") is never the file's, whatever follows the dot.
  const safe = given ? safeFileName(given) : 'file'
  const stem = clipBytes(safe === 'file' ? 'Document' : safe, NAME_BYTES).replace(/[. ]+$/, '') || 'Document'
  return `${stem}.pdf`
}

/** The copies' folder, only when it is a real folder of this user's: a link planted in its place is never followed. */
function ownDir(temp: string): string | null {
  const dir = printDir(temp)
  try {
    const stat = lstatSync(dir)
    if (!stat.isDirectory()) return null
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) return null
    return dir
  } catch {
    return null
  }
}

/**
 * Copies handed to the viewer more than a day ago go (it has long since read
 * them), and of the rest only the newest `PRINT_KEEP` stay. Never throws: a
 * folder it cannot read is left as it is.
 */
export function sweepPrints(temp: string, now = Date.now()): void {
  const dir = ownDir(temp)
  if (!dir) return
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return
  }
  const kept: { path: string; at: number }[] = []
  for (const name of names) {
    const path = join(dir, name)
    try {
      const at = lstatSync(path).mtimeMs
      if (now - at > DAY) rmSync(path, { recursive: true, force: true })
      else kept.push({ path, at })
    } catch {
      // gone already
    }
  }
  kept.sort((a, b) => b.at - a.at)
  for (const { path } of kept.slice(PRINT_KEEP)) {
    try {
      rmSync(path, { recursive: true, force: true })
    } catch {
      // held open by the viewer: it goes at a later sweep
    }
  }
}

/** Hands a PDF's bytes to the system's viewer to print. */
export async function printPdf(deps: PrintDeps, name: unknown, bytes: unknown): Promise<PrintAnswer> {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) return { ok: false, error: 'There is nothing to print' }
  if (bytes.byteLength > PRINT_MAX_BYTES) return { ok: false, error: 'That file is too large to print from here' }
  // A PDF and nothing else: the system opens a file by what it is.
  if (Buffer.from(bytes.subarray(0, 5)).toString('latin1') !== '%PDF-') return { ok: false, error: 'Only a PDF can be printed' }
  sweepPrints(deps.temp, deps.now?.())
  // A folder of its own each time: two prints of one name never share a file the viewer still holds.
  const dir = join(printDir(deps.temp), randomUUID())
  const path = join(dir, printName(name))
  try {
    mkdirSync(printDir(deps.temp), { recursive: true, mode: 0o700 })
    // Not a link someone left where the folder should be.
    if (!ownDir(deps.temp)) return { ok: false, error: 'The file could not be written' }
    mkdirSync(dir, { mode: 0o700 })
    writeFileSync(path, bytes, { mode: 0o600 })
  } catch {
    rmSync(dir, { recursive: true, force: true })
    return { ok: false, error: 'The file could not be written' }
  }
  // A refusal of the first Print's Automation ask can come after the answer (he read it past the moment): the viewer then.
  const asked = deps.print ? await deps.print(path, () => void deps.open(path).catch(() => '')).catch((): PrintAsk => 'failed') : 'failed'
  if (asked === 'dialog') return { ok: true, via: 'dialog' }
  const error = await deps.open(path).catch((err: unknown) => (err instanceof Error ? err.message : String(err)) || 'The file could not be opened')
  if (error) {
    rmSync(dir, { recursive: true, force: true })
    return { ok: false, error }
  }
  return asked === 'refused' ? { ok: true, via: 'viewer', refused: true } : { ok: true, via: 'viewer' }
}

/** What `print:pdf` is told of who asked: only a window's own page may print, never a frame inside it. */
export interface PrintSender {
  sender: { mainFrame: unknown }
  senderFrame: unknown
}

/** One call of `print:pdf`. */
export function answerPrint(deps: PrintDeps, event: PrintSender, name: unknown, bytes: unknown): Promise<PrintAnswer> {
  if (event.senderFrame !== event.sender.mainFrame) return Promise.resolve({ ok: false, error: 'Only the window itself can print' })
  return printPdf(deps, name, bytes)
}

/** How long xdg-open, or osascript, is heard before the PDF counts as handed over. */
export const XDG_SETTLE_MS = 3_000
export const NO_VIEWER = 'No app on this computer opens a PDF'

/**
 * Runs a command and hears it for `settleMs`: '' when it exits well or is
 * still running then, 'failed' when it exits badly or cannot start.
 */
function settled(command: string, args: string[], spawn: typeof nodeSpawn, settleMs: number): Promise<'' | 'failed'> {
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const answer = (result: '' | 'failed'): void => {
      clearTimeout(timer)
      resolve(result)
    }
    try {
      const child = spawn(command, args, { detached: true, stdio: 'ignore' })
      child.once('error', () => answer('failed'))
      child.once('exit', (code) => answer(code === 0 ? '' : 'failed'))
      child.unref()
      timer = setTimeout(() => answer(''), settleMs)
    } catch {
      answer('failed')
    }
  })
}

/**
 * Opens a file on Linux through xdg-open, heard only for a moment. Electron's
 * `shell.openPath` never settled there (the box, Electron 39: xdg-open ran
 * and exited 0, and the window waited until its call was dropped, "reply was
 * never sent"); and xdg-open's generic mode stays in the foreground until the
 * viewer closes. So: an exit that fails, or no xdg-open at all, says why; an
 * exit that succeeds, or one still running after `settleMs`, is the viewer
 * holding the file.
 */
export function xdgOpen(path: string, spawn: typeof nodeSpawn = nodeSpawn, settleMs = XDG_SETTLE_MS): Promise<string> {
  return settled('xdg-open', [path], spawn, settleMs).then((result) => (result ? NO_VIEWER : ''))
}

/**
 * The AppleScript that brings Preview.app in front and asks it to print the
 * file it is handed (its one argument, never written into the script) with
 * the system's print dialog. The wait is long: Preview answers only once he
 * closes the dialog.
 */
export const PREVIEW_PRINT_SCRIPT = [
  'on run argv',
  'set f to POSIX file (item 1 of argv)',
  'tell application "Preview"',
  'activate',
  'with timeout of 86400 seconds',
  'print f with print dialog',
  'end timeout',
  'end tell',
  'end run'
] as const

/** osascript's words when macOS refused TempCode its Automation grant for Preview (errAEEventNotPermitted). */
const REFUSED = /\(-1743\)/

/**
 * macOS: Print… in one step, the system's print dialog in front through
 * Preview.app. osascript is heard for a moment: a refusal (no Automation
 * grant, -1743, read from its error words) answers 'refused', no osascript
 * or another failure 'failed', and the viewer stands in; still running is
 * the dialog up, or the first Print's Automation ask, waiting on him. A
 * grant he refuses after the moment calls `onLateRefusal`, which opens the
 * viewer; a dialog he cancels (-128) does not.
 */
export function previewPrint(path: string, spawn: typeof nodeSpawn = nodeSpawn, settleMs = XDG_SETTLE_MS, onLateRefusal?: () => void): Promise<PrintAsk> {
  const args = [...PREVIEW_PRINT_SCRIPT.flatMap((line) => ['-e', line]), path]
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    let answered = false
    let said = ''
    const answer = (result: PrintAsk): void => {
      clearTimeout(timer)
      if (!answered) resolve(result)
      answered = true
    }
    try {
      const child = spawn('/usr/bin/osascript', args, { detached: true, stdio: ['ignore', 'ignore', 'pipe'] })
      child.stderr?.on('data', (chunk) => (said += String(chunk)))
      child.once('error', () => answer('failed'))
      // 'close', not 'exit': its error words are read whole by then.
      child.once('close', (code) => {
        const refused = code !== 0 && REFUSED.test(said)
        if (answered) {
          if (refused) onLateRefusal?.()
          return
        }
        answer(code === 0 ? 'dialog' : refused ? 'refused' : 'failed')
      })
      child.unref()
      timer = setTimeout(() => answer('dialog'), settleMs)
    } catch {
      answer('failed')
    }
  })
}

/** `print:pdf` for every window, then a sweep of what an earlier run left. */
export async function registerPrintOut(): Promise<void> {
  const { app, ipcMain, shell } = await import('electron')
  const deps: PrintDeps = {
    temp: app.getPath('temp'),
    open: (path) => (process.platform === 'linux' ? xdgOpen(path) : shell.openPath(path)),
    ...(process.platform === 'darwin' ? { print: (path: string, onLateRefusal: () => void) => previewPrint(path, nodeSpawn, XDG_SETTLE_MS, onLateRefusal) } : {})
  }
  ipcMain.handle('print:pdf', (event, name: unknown, bytes: unknown) => answerPrint(deps, event, name, bytes))
  sweepPrints(deps.temp)
}
