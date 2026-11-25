import { app, ipcMain } from 'electron'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { open, rm, writeFile, type FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import { freeName, safeFileName } from '@shared/fileName'

/**
 * Saving a file the window already holds into the person's Downloads folder
 * (Mail's Save and Save all). The window sends the bytes; main only names
 * the file and writes it, so nothing here fetches an address. The name is
 * the sender's, so it is made safe first, and a name already taken gets a
 * number rather than replacing what is there.
 */

/** Bytes one save may carry: Gmail's own limit for a whole mail, with room. */
export const SAVE_MAX_BYTES = 64 * 1024 * 1024

export { freeName, safeFileName } from '@shared/fileName'

/**
 * A download written part by part as the window reads it (the Files place's Download): begun under a safe, free
 * name in `dir`, each part added in turn, and ended kept (its path) or taken away, so a file of any size never sits
 * whole in the window and "Downloaded" is said only once the file is on the disk. A part for an id it never began,
 * or one already ended, is refused.
 */
export function partWriter(dir: () => string): {
  begin(name: unknown): Promise<string>
  part(id: unknown, bytes: unknown): Promise<void>
  end(id: unknown, keep: unknown): Promise<string | null>
} {
  const writing = new Map<string, { path: string; file: FileHandle }>()
  const of = (id: unknown): { path: string; file: FileHandle } => {
    const one = typeof id === 'string' ? writing.get(id) : undefined
    if (!one) throw new Error('that download is not open')
    return one
  }
  return {
    async begin(name) {
      const at = dir()
      const path = join(at, freeName(safeFileName(String(name ?? '')), (candidate) => existsSync(join(at, candidate))))
      // `wx`: never over a file that appeared since the check.
      const file = await open(path, 'wx')
      const id = randomUUID()
      writing.set(id, { path, file })
      return id
    },
    async part(id, bytes) {
      if (!(bytes instanceof Uint8Array) && !(bytes instanceof ArrayBuffer)) throw new Error('nothing to save')
      await of(id).file.write(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes))
    },
    async end(id, keep) {
      const one = of(id)
      writing.delete(id as string)
      await one.file.close()
      if (keep === true) return one.path
      await rm(one.path, { force: true })
      return null
    },
  }
}

export function registerDownloads(): void {
  const parts = partWriter(() => app.getPath('downloads'))
  ipcMain.handle('files:download-begin', (_e, name: unknown) => parts.begin(name))
  ipcMain.handle('files:download-part', (_e, id: unknown, bytes: unknown) => parts.part(id, bytes))
  ipcMain.handle('files:download-end', (_e, id: unknown, keep: unknown) => parts.end(id, keep))
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
