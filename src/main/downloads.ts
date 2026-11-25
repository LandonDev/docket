import { app, ipcMain } from 'electron'
import { randomUUID } from 'node:crypto'
import { constants, existsSync } from 'node:fs'
import { copyFile, link, open, rm, writeFile, type FileHandle } from 'node:fs/promises'
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
 * A download written part by part as the window reads it (the Files place's Download): begun under a short name of its
 * own in `dir` ("TempCode download <id>.download", so a long name that fits the folder still fits while it is
 * written), each part added in turn, and ended kept (named then: the file under its
 * own free name, its path answered) or taken away, so a file of any size never sits whole in the window, "Downloaded"
 * is said only once the file is on the disk, and a part-written file never wears the real name. `watch` hands the
 * caller the way to take it away when the window that reads it goes (closed or reloaded mid-file). A part for an id
 * it never began, or one already ended, is refused.
 */
export function partWriter(dir: () => string): {
  begin(name: unknown, watch?: (gone: () => void) => (() => void) | void): Promise<string>
  part(id: unknown, bytes: unknown): Promise<void>
  end(id: unknown, keep: unknown): Promise<string | null>
} {
  const writing = new Map<string, { at: string; name: string; path: string; file: FileHandle; unwatch?: () => void }>()
  const of = (id: unknown): { at: string; name: string; path: string; file: FileHandle; unwatch?: () => void } => {
    const one = typeof id === 'string' ? writing.get(id) : undefined
    if (!one) throw new Error('that download is not open')
    return one
  }
  const end = async (id: unknown, keep: unknown): Promise<string | null> => {
    const one = of(id)
    writing.delete(id as string)
    one.unwatch?.()
    await one.file.close()
    if (keep === true) {
      try {
        // Named under a name free now; `link` never goes over a file that took it since the check.
        for (;;) {
          const path = join(one.at, freeName(one.name, (candidate) => existsSync(join(one.at, candidate))))
          try {
            await link(one.path, path)
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code === 'EEXIST') continue
            // A disk with no links (FAT): copied to a file made anew, never renamed over one that took the name since.
            try {
              await copyFile(one.path, path, constants.COPYFILE_EXCL)
            } catch (copyErr) {
              if ((copyErr as NodeJS.ErrnoException).code === 'EEXIST') continue
              throw copyErr
            }
          }
          await rm(one.path, { force: true })
          return path
        }
      } catch (err) {
        // The disk refused the name: the download fails, and its part goes with it rather than stranded.
        await rm(one.path, { force: true }).catch(() => undefined)
        throw err
      }
    }
    await rm(one.path, { force: true })
    return null
  }
  return {
    async begin(name, watch) {
      const at = dir()
      const safe = safeFileName(String(name ?? ''))
      const id = randomUUID()
      // A short name of its own, never the real one with ".download" after it: a long name that fits the folder
      // would not fit with the ending, and the download would fail before its first part.
      const part = `TempCode download ${id.slice(0, 8)}.download`
      const path = join(at, freeName(part, (candidate) => existsSync(join(at, candidate))))
      // `wx`: never over a file that appeared since the check.
      const file = await open(path, 'wx')
      writing.set(id, { at, name: safe, path, file })
      const unwatch = watch?.(() => void end(id, false).catch(() => undefined))
      if (unwatch) writing.get(id)!.unwatch = unwatch
      return id
    },
    async part(id, bytes) {
      if (!(bytes instanceof Uint8Array) && !(bytes instanceof ArrayBuffer)) throw new Error('nothing to save')
      await of(id).file.write(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes))
    },
    end,
  }
}

export function registerDownloads(): void {
  const parts = partWriter(() => app.getPath('downloads'))
  // A window closed or reloaded mid-file takes its part-written file away.
  ipcMain.handle('files:download-begin', (e, name: unknown) =>
    parts.begin(name, (gone) => {
      const sender = e.sender
      sender.once('destroyed', gone)
      sender.once('did-navigate', gone)
      return () => {
        if (sender.isDestroyed()) return
        sender.off('destroyed', gone)
        sender.off('did-navigate', gone)
      }
    })
  )
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
