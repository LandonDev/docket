import { randomUUID } from 'node:crypto'
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as WebStream } from 'node:stream/web'
import type { MediaPlay, MediaProbe } from '@shared/contract-work-media'
import type { CanvasItem, CanvasSource, Principal } from '@shared/work'
import { mediaUrl, workMediaRoot } from '../../media'
import { runnerOf } from '../formats/jobs'
import { probeFile } from '../media/probe'
import type { MediaSourceAdapter } from '../media/sources'
import type { NoteInput } from '../media/store'
import { liveOf as mediaOf, pushSoon } from '../media/view'
import type { WorkCtx } from '../modules'
import type { FioFile, FioLink } from './api'
import { frameioConfig } from './auth'
import { noteOfComment } from './map'
import { frameioItem, frameioOf, saveItem } from './live'

/**
 * A Frame.io file in the media canvas (docs/agents/work-frameio.md, "In the
 * canvas"). The adapter fetches Frame.io's own rendition (its best H.264, or
 * a picture's original) into Work's media root, where the media host serves
 * it, since the renderer may load no outside address and Frame.io's links
 * run out within a day; ffprobe reads the copy for its frame table. A file
 * in a version stack opens with every version of the stack, oldest first,
 * and its comments come in as notes on their frames, kept in step at open,
 * on a webhook and after a post. The item is shared: an agent's notes on it
 * wait for the person.
 */

type FrameioSource = Extract<CanvasSource, { at: 'frameio' }>
const PLAIN_IMAGES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif'])
const href = (l?: FioLink | null): string | null => l?.download_url ?? l?.url ?? l?.inline_url ?? null
const safe = (id: string): string => id.replace(/[^A-Za-z0-9_-]/g, '')

/** The rendition a viewer gets: a video's best transcode, a plain picture as it is, any other picture as Frame.io's high-quality still. */
export function renditionOf(file: FioFile): { url: string; kind: 'video' | 'image'; mime: string; which: 'original' | 'high_quality' | 'efficient' } {
  const links = file.media_links ?? {}
  const type = file.media_type ?? ''
  const best = (): { url: string; which: 'high_quality' | 'efficient' } | null => {
    const hq = href(links.high_quality)
    if (hq) return { url: hq, which: 'high_quality' }
    const small = href(links.efficient)
    return small ? { url: small, which: 'efficient' } : null
  }
  if (type.startsWith('image/')) {
    const original = PLAIN_IMAGES.has(type) ? href(links.original) : null
    if (original) return { url: original, kind: 'image', mime: type, which: 'original' }
    const b = best()
    if (!b) throw new Error(`Frame.io has no picture of ${file.name} to show yet`)
    return { ...b, kind: 'image', mime: 'image/jpeg' }
  }
  const b = best()
  if (!b) throw new Error(`Frame.io has not finished making ${file.name} playable`)
  return { ...b, kind: 'video', mime: 'video/mp4' }
}

/** What the copy beside a Frame.io file says of itself: which rendition, of what size of file, and the picture's height. */
interface Meta {
  size?: number
  dest?: string
  which?: string
  height?: number
}
const metaPathOf = (dataDir: string, fileId: string): string => join(workMediaRoot(dataDir), `frameio-${safe(fileId)}`, 'meta.json')
function readMeta(path: string): Meta | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Meta
  } catch {
    return null
  }
}

/** The picture's height a file's mark sizes are counted in: the probe's, else the one kept beside the copy, else 1080. */
export function heightOf(ctx: WorkCtx, fileId: string): number {
  return frameioOf(ctx).probes.get(fileId)?.height ?? readMeta(metaPathOf(ctx.dataDir, fileId))?.height ?? 1080
}

/** Downloads in flight, by copy: two items showing one file share one download. */
const downloads = new Map<string, Promise<void>>()

async function probeOf(ctx: WorkCtx, path: string, signal: AbortSignal): Promise<{ probe: MediaProbe; table?: import('@shared/contract-work-media').FrameTable }> {
  if (frameioConfig.probe) return frameioConfig.probe(path, signal)
  const runner = runnerOf(ctx)
  if (!runner) throw new Error('the conversion tools have not started on this host')
  const ffprobe = (await runner).tools.bin('ffmpeg', 'ffprobe')
  if (!ffprobe) throw new Error('ffprobe is not installed on this host')
  return probeFile(ffprobe, path, signal)
}

/** Downloads `url` to `dest` through a part file, so a cut download never stands as the copy. */
async function download(url: string, dest: string, signal: AbortSignal): Promise<void> {
  const res = await frameioConfig.fetch(url, { signal })
  if (!res.ok || !res.body) throw new Error(`Frame.io's copy did not download (${res.status})`)
  const part = `${dest}.${randomUUID()}.part`
  try {
    await pipeline(Readable.fromWeb(res.body as unknown as WebStream), createWriteStream(part, { mode: 0o600 }), { signal })
    renameSync(part, dest)
  } catch (err) {
    rmSync(part, { force: true })
    throw err
  }
}

export const frameioMedia: MediaSourceAdapter = {
  at: 'frameio',
  async resolve(source, ctx, signal) {
    const { account, fileId } = source as FrameioSource
    const live = frameioOf(ctx)
    const file = await live.api.file(account, fileId, 'media_links.original,media_links.high_quality,media_links.efficient', signal)
    const r = renditionOf(file)
    const dir = join(workMediaRoot(ctx.dataDir), `frameio-${safe(fileId)}`)
    const dest = join(dir, r.kind === 'video' ? 'rendition.mp4' : `rendition.${r.mime.split('/')[1]}`)
    const metaPath = metaPathOf(ctx.dataDir, fileId)
    // A copy stands until Frame.io's file changes (its size says so) or a better rendition is ready.
    const meta = readMeta(metaPath)
    if (!existsSync(dest) || meta?.size !== file.file_size || meta?.dest !== dest || meta?.which !== r.which || file.file_size === undefined) {
      let running = downloads.get(dest)
      if (!running) {
        mkdirSync(dir, { recursive: true, mode: 0o700 })
        running = download(r.url, dest, signal).finally(() => downloads.delete(dest))
        downloads.set(dest, running)
      }
      await running
    }
    const probed = await probeOf(ctx, dest, signal)
    live.probes.set(fileId, probed.probe)
    writeFileSync(metaPath, JSON.stringify({ size: file.file_size, dest, which: r.which, height: probed.probe.height } satisfies Meta))
    const url = mediaUrl(dest, { kind: r.kind, mime: r.mime }, statSync(dest).mtimeMs)
    let play: MediaPlay
    if (r.kind === 'image') play = { via: 'image', url, width: probed.probe.width, height: probed.probe.height }
    else if (probed.table) play = { via: 'original', url, mime: r.mime, table: probed.table }
    else throw new Error(`${file.name} has no frames to show`)
    return { name: file.name, play, probe: probed.probe, shared: true }
  }
}

/** Opens a Frame.io file in the thread's pane: one media item for its version stack, shared, its comments in. */
export async function openFile(ctx: WorkCtx, sessionId: string, account: string, fileId: string, by: Principal = 'owner'): Promise<CanvasItem> {
  const { api } = frameioOf(ctx)
  const file = await api.file(account, fileId)
  let stackId: string | null = null
  let files: FioFile[] = [file]
  let title = file.name
  if (file.parent_id && (await api.isStack(account, file.parent_id))) {
    stackId = file.parent_id
    const kids = await api.stackChildren(account, stackId)
    // Oldest first, as the media canvas counts v1, v2, …: by when each was made, else the stack's order turned over (its newest on top).
    const dated = kids.every((k) => k.created_at)
    files = !kids.length ? [file] : dated ? [...kids].sort((x, y) => Date.parse(x.created_at!) - Date.parse(y.created_at!)) : [...kids].reverse()
  }
  title = files[files.length - 1]?.name ?? title
  const pane = ctx.canvas.paneOf(sessionId)
  const item = ctx.canvas.open(pane, 'media', { at: 'frameio', account, fileId: files[0].id }, title)
  const { store } = mediaOf(ctx)
  // The first version is named for its own file, not for the item.
  store.ensureItem(item.id, item.sessionId, { source: item.source, name: files[0].name, by })
  const have = new Set(store.versions(item.id).flatMap((v) => (v.source.at === 'frameio' ? [v.source.fileId] : [])))
  for (const f of files) if (!have.has(f.id)) store.addVersion(item.id, { source: { at: 'frameio', account, fileId: f.id }, name: f.name, by })
  if (!store.item(item.id)?.shared) store.setShared(item.id, true)
  saveItem(ctx.db, { itemId: item.id, sessionId: item.sessionId, account, stackId, fileIds: files.map((f) => f.id) })
  await syncComments(ctx, item.id).catch((err: unknown) => ctx.log(`frameio: comments of ${title}: ${err instanceof Error ? err.message : err}`))
  pushSoon(ctx, item.id)
  return item
}

/** Where a note sits, with its marks' line widths left out: the same comment read at another picture height has not moved. */
const placeOf = (a: NoteInput['anchor']): string => JSON.stringify({ ...a, shapes: a.shapes?.map((x) => ({ ...x, width: 0 })) })

/**
 * Brings an item's notes in step with Frame.io's comments on each of its
 * versions: new ones in, changed words and resolved marks over, deleted
 * ones out. Notes of TempCode's own (the agent's waiting ones, the person's)
 * are left alone. Answers how many notes changed.
 */
export async function syncComments(ctx: WorkCtx, itemId: string, signal?: AbortSignal): Promise<number> {
  const row = frameioItem(ctx.db, itemId)
  if (!row) return 0
  const live = frameioOf(ctx)
  const { store } = mediaOf(ctx)
  const me = frameioConfig.tokens.read()?.user?.id
  const ours = new Map(store.notes(itemId).flatMap((n) => (n.external?.service === 'frameio' ? [[n.external.id, n] as const] : [])))
  const seen = new Set<string>()
  let changed = 0
  for (const v of store.versions(itemId)) {
    if (v.source.at !== 'frameio') continue
    const fileId = v.source.fileId
    const comments = await live.api.comments(row.account, fileId, signal)
    const height = heightOf(ctx, fileId)
    const put = (c: (typeof comments)[number], parentId?: string, parentAnchor?: NoteInput['anchor']): string => {
      seen.add(c.id)
      const n = noteOfComment(c, { versionId: v.id, me, height })
      const anchor = parentAnchor ?? n.anchor
      const was = ours.get(c.id)
      if (was) {
        // Moved in Frame.io (or read at another picture height): the anchor changes in place, so the note keeps its id and the replies made on it here.
        const moved = placeOf(was.anchor) !== placeOf(anchor)
        if (moved) {
          ctx.db.prepare(`UPDATE work_media_notes SET anchor = ?, updated_at = ? WHERE id = ?`).run(JSON.stringify(anchor), Date.now(), was.id)
          store.bump(itemId)
        }
        if (was.body !== n.body || was.resolved !== n.resolved) store.editNote(was.id, { body: n.body, resolved: n.resolved })
        if (moved || was.body !== n.body || was.resolved !== n.resolved) changed++
        return was.id
      }
      const made = store.addNote(itemId, { anchor, body: n.body, by: n.by, external: n.external, ...(parentId ? { parentId } : {}) })
      if (n.resolved) store.editNote(made.id, { resolved: true })
      changed++
      return made.id
    }
    for (const c of comments) {
      const id = put(c)
      const anchor = store.note(id)?.anchor
      for (const r of c.replies ?? []) put(r, id, anchor)
    }
  }
  for (const [cid, n] of ours) {
    if (seen.has(cid) || !store.note(n.id)) continue
    store.removeNote(n.id)
    changed++
  }
  if (changed) pushSoon(ctx, itemId)
  return changed
}
