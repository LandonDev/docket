import { app, ipcMain } from 'electron'
import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Saving a file the window already holds into the person's Downloads folder
 * (Mail's Save and Save all). The window sends the bytes; main only names
 * the file and writes it, so nothing here fetches an address. The name is
 * the sender's, so it is made safe first, and a name already taken gets a
 * number rather than replacing what is there.
 */

/** Bytes one save may carry: Gmail's own limit for a whole mail, with room. */
export const SAVE_MAX_BYTES = 64 * 1024 * 1024

/** A file name with nothing in it a file system or a shell would read as more than a name. */
export function safeFileName(name: string): string {
  const cleaned = String(name)
    // Path separators, control characters, and what Windows refuses in a name.
    .replace(/[\\/\u0000-\u001f\u007f<>:"|?*]/g, '_')
    .replace(/^\.+/, '_')
    .replace(/[. ]+$/, '')
    .trim()
    .slice(0, 180)
  return cleaned && !/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(cleaned) ? cleaned : 'file'
}

/** `name` if free, else "name (2).ext", "name (3).ext", … */
export function freeName(name: string, taken: (candidate: string) => boolean): string {
  if (!taken(name)) return name
  const dot = name.lastIndexOf('.')
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, '']
  for (let n = 2; n < 10_000; n++) {
    const candidate = `${stem} (${n})${ext}`
    if (!taken(candidate)) return candidate
  }
  throw new Error('too many files with that name')
}

export function registerDownloads(): void {
  ipcMain.handle('files:save-download', async (_e, name: unknown, bytes: unknown): Promise<string> => {
    if (!(bytes instanceof Uint8Array) && !(bytes instanceof ArrayBuffer)) throw new Error('nothing to save')
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
    if (data.byteLength > SAVE_MAX_BYTES) throw new Error('that file is too large to save from here')
    const dir = app.getPath('downloads')
    const file = freeName(safeFileName(String(name ?? '')), (candidate) => existsSync(join(dir, candidate)))
    // `wx`: never over a file that appeared since the check.
    await writeFile(join(dir, file), data, { flag: 'wx' })
    return join(dir, file)
  })
}
