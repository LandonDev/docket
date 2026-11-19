import { createHash } from 'node:crypto'
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readSync, renameSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { canvasSourcePath, type CanvasItem, type CanvasKind } from '@shared/work'
import { FenceError } from '../../remote/fence'
import { canvasItemDir } from '../canvas/store'
import type { Caller, PushTo, WorkCtx } from '../modules'

/**
 * A canvas item's file on this host, for the two kinds that are files (a
 * PDF, a deck): which path its source names, a folder of the item's own
 * for what we keep beside it, and bytes by range. Shared by the pdf and
 * the slides pillars.
 */

type Ctx = Pick<WorkCtx, 'host' | 'dataDir' | 'canvas'>

/** A plain sentence the canvas shows as it is. */
export class ItemFileError extends Error {
  constructor(
    message: string,
    /** `missing`: the file is not where the item says. `stale`: a read named a version no longer kept. `fenced`: outside the caller's roots. */
    readonly why: 'missing' | 'not-here' | 'not-built' | 'wrong' | 'stale' | 'fenced' = 'wrong'
  ) {
    super(message)
  }
}

/** The item, which must be of this kind. */
export function itemOf(ctx: Ctx, itemId: string, kind: CanvasKind): CanvasItem {
  const item = ctx.canvas.get(itemId)
  if (!item) throw new ItemFileError(`There is no canvas item ${itemId}.`)
  if (item.kind !== kind) throw new ItemFileError(`${item.title} is not a ${kind === 'pdf' ? 'PDF' : 'deck'}.`)
  return item
}

/** The item a thread may act on by id: one of its own pane's (a subagent's pane is its root thread's). */
export function paneItem(ctx: Ctx, sessionId: string, itemId: string, kind: CanvasKind): CanvasItem {
  const item = itemOf(ctx, itemId, kind)
  if (item.sessionId !== ctx.canvas.paneOf(sessionId)) throw new ItemFileError(`This thread has no canvas item ${itemId}.`)
  return item
}

/** The item's own folder (`canvas/<thread>/<item>/`), which rides a move and goes with the thread; made on first use. */
export async function itemDir(ctx: Pick<WorkCtx, 'dataDir'>, item: CanvasItem, ...sub: string[]): Promise<string> {
  const dir = join(canvasItemDir(ctx.dataDir, item.sessionId, item.id), ...sub)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  return dir
}

/**
 * The path an item's source names on this host. `own`: the file's name
 * inside the item's folder, for an item a thread made (`{ at: 'thread' }`).
 */
export async function sourcePath(ctx: Ctx, item: CanvasItem, own: string): Promise<string> {
  const source = item.source
  if (source.at === 'thread') return join(await itemDir(ctx, item), own)
  if (source.at === 'file' || (source.at === 'microsoft' && source.ref.kind === 'path')) {
    const path = source.at === 'file' ? source.path : (source.ref as { path: string }).path
    // An agent's word for the host is loose; the file being here settles it.
    if (source.host !== ctx.host && !existsSync(path)) throw new ItemFileError(`${item.title} is on another host (${source.host}).`, 'not-here')
    return path
  }
  if (source.at === 'microsoft') throw new ItemFileError(`${item.title} lives in PowerPoint on the web. Opening it from there is not built yet.`, 'not-built')
  if (source.at === 'google') throw new ItemFileError(`${item.title} lives in Google: open it there. Agents read it and revise a copy with the google tools.`, 'not-built')
  throw new ItemFileError(`${item.title} is not a file.`)
}

export interface FileStamp {
  path: string
  name: string
  size: number
  /** changes when the file's size or time does */
  rev: string
  mtimeMs: number
}

export function stampOf(path: string, name = basename(path)): FileStamp {
  let st
  try {
    st = statSync(path)
  } catch {
    throw new ItemFileError(`${name} is not where it was.`, 'missing')
  }
  if (!st.isFile()) throw new ItemFileError(`${name} is not a file.`)
  return { path, name, size: st.size, mtimeMs: st.mtimeMs, rev: createHash('sha1').update(`${st.size}:${Math.round(st.mtimeMs)}`).digest('hex').slice(0, 16) }
}

/** Whether a file opens as this kind: a PDF says so in its first bytes, a .pptx is a zip. A file that is neither is never served. */
export function hasMagic(path: string, kind: 'pdf' | 'zip'): boolean {
  let fd: number | null = null
  try {
    fd = openSync(path, 'r')
    const head = Buffer.alloc(1024)
    const n = readSync(fd, head, 0, head.length, 0)
    return kind === 'pdf' ? head.subarray(0, n).includes('%PDF-') : n >= 4 && head[0] === 0x50 && head[1] === 0x4b && (head[2] === 3 || head[2] === 5) && (head[3] === 4 || head[3] === 6)
  } catch {
    return false
  } finally {
    if (fd !== null) closeSync(fd)
  }
}

/** A copy that is whole or absent: written beside its place, then moved onto it. */
export function copyWhole(from: string, to: string): void {
  const tmp = `${to}.${process.pid}.${Date.now().toString(36)}.tmp`
  copyFileSync(from, tmp)
  renameSync(tmp, to)
}

/** Bytes of a file by range, as the wire carries them. */
export function readRange(path: string, offset: number, length: number): { data: string; size: number } {
  const size = statSync(path).size
  const want = Math.max(0, Math.min(length, size - offset))
  const buf = Buffer.alloc(want)
  if (want > 0) {
    const fd = openSync(path, 'r')
    try {
      let got = 0
      while (got < want) {
        const n = readSync(fd, buf, got, want - got, offset + got)
        if (n <= 0) break
        got += n
      }
      if (got < want) return { data: buf.subarray(0, got).toString('base64'), size }
    } finally {
      closeSync(fd)
    }
  }
  return { data: buf.toString('base64'), size }
}

/**
 * The listener's path fence (`ctx.reaches`), for a file a method reaches
 * through an item id: a remote key reads an item's file only when it could
 * have named the path itself. A thread-made item's file is in its own
 * folder and names no path; this host's own window always passes.
 */
export function fenceItem(ctx: Pick<WorkCtx, 'reaches'>, by: Caller, item: CanvasItem, method: string): void {
  const path = canvasSourcePath(item.source)
  if (path !== null && !ctx.reaches(by, path)) throw new FenceError(method)
}

/** Who a push about the item's file is for: the sockets whose caller could name the file (a thread-made item's goes to every socket). */
export function pushFor(item: CanvasItem): PushTo | undefined {
  const path = canvasSourcePath(item.source)
  return path === null ? undefined : { path }
}
