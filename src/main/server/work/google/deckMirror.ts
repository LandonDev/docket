import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { WorkCtx } from '../modules'
import { hasMagic } from '../pdf/file'
import { GOOGLE_MIME } from './client'
import type { GoogleSource } from './docs'
import { GoogleFiles, googleOf } from './google'
import { watch } from './poll'

export const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation'

/** Decks whose last open could not reach Drive, so the mirror read before is shown: cleared by the next read that does. */
const unreached = new Set<string>()
const fileKey = (source: GoogleSource): string => `${source.account.toLowerCase()}/${source.fileId}`
export const mirrorUnreached = (source: GoogleSource): boolean => unreached.has(fileKey(source))

class NotSlidesError extends Error {}

/** Renders and range reads use the same mirror until an open or Read again checks Drive. */
export function cachedSlidesMirror(ctx: Pick<WorkCtx, 'db'>, source: GoogleSource): string {
  const path = new GoogleFiles(ctx.db).get(source.account, source.fileId)?.mirror
  if (!path || !existsSync(path)) throw new Error('Open this Google deck to read it from Drive.')
  return path
}

const reads = new Map<string, Promise<string>>()

/** Read once per Drive version, or export anew when the owner chooses Read again. */
export function readSlidesMirror(ctx: WorkCtx, source: GoogleSource, force = false): Promise<string> {
  const key = fileKey(source)
  const lock = join(ctx.dataDir, key)
  const next = (reads.get(lock) ?? Promise.resolve()).catch(() => {}).then(async () => {
    const g = googleOf(ctx)
    const api = g.api(source.account)
    const file = await api.file(source.fileId)
    if (file.mimeType !== GOOGLE_MIME.slides) throw new NotSlidesError('That Google file is not a Slides deck.')
    const row = g.files.get(source.account, source.fileId)
    unreached.delete(key)
    if (!force && row?.mirror && existsSync(row.mirror) && row.version === file.version) return row.mirror

    const bytes = await api.export(source.fileId, PPTX_MIME)
    const dir = join(ctx.dataDir, 'google', createHash('sha256').update(key).digest('hex').slice(0, 20))
    const path = join(dir, 'deck.pptx')
    const tmp = join(dir, `${randomUUID()}.pptx`)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    try {
      writeFileSync(tmp, bytes, { mode: 0o600 })
      if (!hasMagic(tmp, 'zip')) throw new Error('Google did not export a PowerPoint deck.')
      renameSync(tmp, path)
      g.files.put({ account: source.account, fileId: source.fileId, kind: 'slides', name: file.name, version: file.version, mirror: path, base: null, behind: null })
      return path
    } finally {
      rmSync(tmp, { force: true })
    }
  })
  reads.set(lock, next)
  const done = () => {
    if (reads.get(lock) === next) reads.delete(lock)
  }
  void next.then(done, done)
  return next
}

/**
 * Reads the deck from Drive when it is opened. When Drive cannot be reached (offline, LifeOS's Google session gone)
 * and a mirror was read before, that mirror opens and the view says so; with none, the failure is the open's.
 */
export async function openSlidesMirror(ctx: WorkCtx, itemId: string, title: string, source: GoogleSource): Promise<void> {
  try {
    await readSlidesMirror(ctx, source)
  } catch (err) {
    const row = new GoogleFiles(ctx.db).get(source.account, source.fileId)
    if (!row?.mirror || !existsSync(row.mirror) || err instanceof NotSlidesError) throw err
    unreached.add(fileKey(source))
  }
  watch(source.account, source.fileId, title, itemId)
}
