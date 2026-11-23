import { lstatSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { safeFileName } from '@shared/fileName'

/**
 * Print… (docs/agents/work-editors.md "Print"): the PDF Preview drew, handed
 * to this computer's own PDF viewer, where the system's print dialog is one
 * key away. The window sends the previewed bytes; this writes them to a file
 * of its own and opens it.
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
  now?(): number
}

export type PrintAnswer = { ok: true; via: 'viewer' } | { ok: false; error: string }

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
  const error = await deps.open(path).catch((err: unknown) => (err instanceof Error ? err.message : String(err)) || 'The file could not be opened')
  if (error) {
    rmSync(dir, { recursive: true, force: true })
    return { ok: false, error }
  }
  return { ok: true, via: 'viewer' }
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

/** `print:pdf` for every window, then a sweep of what an earlier run left. */
export async function registerPrintOut(): Promise<void> {
  const { app, ipcMain, shell } = await import('electron')
  const deps: PrintDeps = { temp: app.getPath('temp'), open: (path) => shell.openPath(path) }
  ipcMain.handle('print:pdf', (event, name: unknown, bytes: unknown) => answerPrint(deps, event, name, bytes))
  sweepPrints(deps.temp)
}
