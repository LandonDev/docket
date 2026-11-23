import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readSync, realpathSync, renameSync, rmSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { freeKeptName, keptFileName } from '../../attachmentUploads'
import { safeFileName } from '@shared/fileName'
import type { CanvasItem, CanvasSource } from '@shared/work'
import type { WorkCtx } from '../modules'
import { canvasItemDir } from './store'

/**
 * An item whose bytes live elsewhere and come to this host before a kind
 * opens them (docs/agents/work-canvas.md "Fetched sources"): a mail's
 * attachment from LifeOS's file store. The bytes go into the item's own
 * folder (`canvas/<owner>/<item>/file/<name>`), which goes with the thread
 * or the pane, never into his folder. A pillar registers the fetcher for
 * its `at`; a kind finds the file with `fetchedPath` and opens it as it
 * would a file of his.
 */

export interface CanvasFetcher {
  at: CanvasSource['at']
  /** Whose file a `mail` source is, when not a mail's own: `chat` for a chat message's (work-messages.md "Files"). */
  from?: 'chat'
  /** Writes the item's bytes to `dest`, saying how far it got; refuses (throws a sentence) what the owner may not read. */
  fetch(item: CanvasItem, ctx: WorkCtx, to: { dest: string; progress(received: number, total: number | null): void; signal: AbortSignal }): Promise<void>
}

const fetchers = new Map<string, CanvasFetcher>()

/** A fetcher's place: its source's `at`, and for a mail source whose file it is (`from ?? 'mail'`). */
const placeOf = (at: CanvasSource['at'], from: string | undefined): string => (at === 'mail' ? `mail:${from ?? 'mail'}` : at)
const fetcherFor = (source: CanvasSource): CanvasFetcher | undefined => fetchers.get(placeOf(source.at, source.at === 'mail' ? source.from : undefined))

/** Registers a fetcher; a second for the same place replaces it. Returns its off. */
export function registerCanvasFetcher(fetcher: CanvasFetcher): () => void {
  const place = placeOf(fetcher.at, fetcher.from)
  fetchers.set(place, fetcher)
  return () => {
    if (fetchers.get(place) === fetcher) fetchers.delete(place)
  }
}

/** Where a fetched file comes from, in a sentence's words: "the mail", or "the conversation" for a chat's file. */
const cameFrom = (source: CanvasSource): string => (source.at === 'mail' && source.from === 'chat' ? 'the conversation' : 'the mail')

/** Whether an item's bytes are fetched rather than read where they are. */
export const isFetched = (source: CanvasSource): boolean => source.at === 'mail'

/** The name the item's file takes on disk: the source's own, made safe. */
const nameOf = (item: CanvasItem): string => safeFileName(item.source.at === 'mail' ? item.source.name : item.title)

/** Where a fetched item's file is, whether or not it has come yet. */
export const fetchedFile = (dataDir: string, item: CanvasItem): string => join(canvasItemDir(dataDir, item.sessionId, item.id), 'file', nameOf(item))

/** The fetched item's file, which must be here: a kind asks after the pane has fetched it. */
export function fetchedPath(dataDir: string, item: CanvasItem): string {
  const path = fetchedFile(dataDir, item)
  if (!existsSync(path)) throw new Error(`${item.title} has not come from ${cameFrom(item.source)} yet.`)
  return path
}

/** One fetch per item at a time: a second ask waits on the first. */
const running = new Map<string, Promise<{ size: number }>>()

/** Pushes at most this often while bytes come. */
const PROGRESS_MS = 150

/**
 * The item's bytes on this host: at once when they are here, else fetched
 * through its source's fetcher into a part file that is renamed into place
 * only once whole, so a kind never opens half a file.
 */
export function ensureFetched(ctx: WorkCtx, item: CanvasItem): Promise<{ size: number }> {
  const dest = fetchedFile(ctx.dataDir, item)
  if (existsSync(dest)) return Promise.resolve({ size: statSync(dest).size })
  const fetcher = fetcherFor(item.source)
  if (!fetcher) return Promise.reject(new Error(isFetched(item.source) ? 'Files cannot be fetched on this host while Work is off.' : `${item.title} is not fetched: it is read where it is.`))
  const known = running.get(item.id)
  if (known) return known
  const run = (async () => {
    mkdirSync(join(dest, '..'), { recursive: true, mode: 0o700 })
    const part = `${dest}.part`
    rmSync(part, { force: true })
    let last = 0
    const say = (received: number, total: number | null): void => ctx.push({ push: 'work.canvas.fetch', sessionId: item.sessionId, itemId: item.id, received, total })
    const progress = (received: number, total: number | null): void => {
      const now = Date.now()
      if (now - last < PROGRESS_MS) return
      last = now
      say(received, total)
    }
    try {
      await fetcher.fetch(item, ctx, { dest: part, progress, signal: AbortSignal.timeout(10 * 60_000) })
      renameSync(part, dest)
    } catch (err) {
      rmSync(part, { force: true })
      throw err
    }
    const size = statSync(dest).size
    say(size, size)
    return { size }
  })().finally(() => running.delete(item.id))
  running.set(item.id, run)
  return run
}

/** Bytes of a fetched item's file by range, base64, for the window's Download. */
export function readFetched(dataDir: string, item: CanvasItem, offset: number, length: number): { data: string; size: number } {
  const path = fetchedPath(dataDir, item)
  const size = statSync(path).size
  const n = Math.max(0, Math.min(length, size - offset))
  const buf = Buffer.alloc(n)
  const fd = openSync(path, 'r')
  try {
    let got = 0
    while (got < n) {
      const r = readSync(fd, buf, got, n - got, offset + got)
      if (r === 0) break
      got += r
    }
  } finally {
    closeSync(fd)
  }
  return { data: buf.toString('base64'), size }
}

/** The folder of the workspace the item's pane belongs to, when this host has it on disk; null for a Work Chat's. */
export function workspaceFolderOfItem(ctx: Pick<WorkCtx, 'db'>, item: CanvasItem): string | null {
  if (!item.workspaceId) return null
  const row = ctx.db.prepare('SELECT path FROM workspaces WHERE id = ?').get(item.workspaceId) as { path?: string } | undefined
  return row?.path && existsSync(row.path) ? row.path : null
}

/**
 * Save to workspace: a copy of the fetched file in the workspace's own folder under the attachment's name, made safe
 * and numbered as a kept upload is (`keptFileName`, `freeKeptName`: "Budget (1).xlsx"). Refused for a pane with no
 * workspace folder (a Work Chat's).
 */
export async function keepFetched(ctx: WorkCtx, item: CanvasItem): Promise<{ path: string; name: string }> {
  const folder = workspaceFolderOfItem(ctx, item)
  if (!folder) throw new Error('This pane has no workspace folder to save into.')
  await ensureFetched(ctx, item)
  const from = fetchedPath(ctx.dataDir, item)
  const name = freeKeptName(folder, keptFileName(item.source.at === 'mail' ? item.source.name : item.title))
  const path = join(folder, name)
  copyFileSync(from, path)
  return { path, name }
}

/**
 * The item whose fetched folder holds `path` (`canvas/<owner>/<item>/file/…`): a mail's attachment, or a file made
 * from one there (its document's `.tcdoc`). Null for anything else. Read by the real path, so a link cannot pass.
 */
export function fetchedItemOfPath(ctx: Pick<WorkCtx, 'dataDir' | 'canvas'>, path: string): CanvasItem | null {
  let real: string
  let root: string
  try {
    real = realpathSync(path)
    root = realpathSync(join(ctx.dataDir, 'canvas'))
  } catch {
    return null
  }
  const parts = relative(root, real).split(sep)
  if (parts.length < 4 || parts[0] === '..' || parts[2] !== 'file') return null
  const item = ctx.canvas.get(parts[1]!)
  return item && item.sessionId === parts[0] && isFetched(item.source) ? item : null
}
