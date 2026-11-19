import type { DatabaseSync } from 'node:sqlite'
import type { MediaNote, MediaView } from '@shared/contract-work-media'
import { agentPrincipal, type CanvasItem, type Principal } from '@shared/work'
import { canvasStoreOf } from '../canvas/store'
import { runnerOf } from '../formats/jobs'
import type { WorkCtx } from '../modules'
import { nameOf, Preparer } from './prepare'
import { MediaStore, type ItemRow } from './store'

/**
 * One host's media pillar at run time: the store, the preparer and the
 * Work-on stretch its jobs belong to, by database (a module gets the context
 * and nothing else). `stop` ends every job when Work turns off.
 */
interface Live {
  store: MediaStore
  preparer: Preparer | null
  abort: AbortController
  pushed: Map<string, NodeJS.Timeout>
}
const lives = new WeakMap<DatabaseSync, Live>()

export function liveOf(ctx: WorkCtx): Live {
  let live = lives.get(ctx.db)
  if (!live) lives.set(ctx.db, (live = { store: new MediaStore(ctx.db), preparer: null, abort: new AbortController(), pushed: new Map() }))
  return live
}

/** Work turned off: abort what runs and forget what was in memory; what was made stays on disk. */
export function stopMedia(ctx: WorkCtx): void {
  const live = lives.get(ctx.db)
  if (!live) return
  live.abort.abort()
  for (const t of live.pushed.values()) clearTimeout(t)
  lives.delete(ctx.db)
}

export async function preparerOf(ctx: WorkCtx): Promise<Preparer> {
  const live = liveOf(ctx)
  if (live.preparer) return live.preparer
  const runner = runnerOf(ctx)
  if (!runner) throw new Error('the conversion tools have not started on this host')
  const r = await runner
  live.preparer ??= new Preparer({
    ctx,
    dataDir: r.tools.dataDir,
    ffprobe: () => r.tools.bin('ffmpeg', 'ffprobe'),
    ffmpeg: () => r.tools.bin('ffmpeg'),
    changed: (itemId) => pushSoon(ctx, itemId),
    signal: live.abort.signal
  })
  return live.preparer
}

/** The canvas item, if it is a media item; a sentence otherwise. */
export function mediaItem(ctx: WorkCtx, itemId: string): CanvasItem {
  const item = canvasStoreOf(ctx.db).get(itemId)
  if (!item) throw new Error(`no canvas item ${itemId}`)
  if (item.kind !== 'media') throw new Error(`${item.title} is not an image or a video`)
  return item
}

/** The item's media row, made with its first version (the file the canvas item names) on first sight. */
export function itemRow(ctx: WorkCtx, item: CanvasItem): ItemRow {
  const name = item.source.at === 'file' ? nameOf(item.source.path) : item.title
  return liveOf(ctx).store.ensureItem(item.id, item.sessionId, { source: item.source, name, by: 'owner' })
}

/** Everything the canvas shows of the item. `plays`: what the asking viewer decodes, which starts the work it needs; absent, nothing new starts. */
export async function viewOf(ctx: WorkCtx, itemId: string, plays?: readonly string[]): Promise<MediaView> {
  const item = mediaItem(ctx, itemId)
  const row = itemRow(ctx, item)
  const { store } = liveOf(ctx)
  const preparer = await preparerOf(ctx)
  const versions = store.versions(item.id).map((v) => (plays ? preparer.view(v, plays) : preparer.peek(v)))
  const kind = versions.some((v) => v.probe?.kind === 'video') ? 'video' : versions.every((v) => v.probe?.kind === 'image') ? 'image' : guessKind(item)
  return {
    itemId: item.id,
    kind,
    versions,
    notes: store.notes(item.id),
    mode: row.mode,
    shared: row.shared,
    ...(row.lastWrite ? { lastWrite: row.lastWrite } : {}),
    rev: row.rev
  }
}

const VIDEO_EXT = /\.(mp4|m4v|mov|webm|mkv|mxf|avi|mts|m2ts|ts|ogv)$/i
const guessKind = (item: CanvasItem): 'video' | 'image' => (item.source.at === 'file' && !VIDEO_EXT.test(item.source.path) ? 'image' : 'video')

/** Pushes the item's view, at most twice a second however often it changes. */
export function pushSoon(ctx: WorkCtx, itemId: string): void {
  const live = liveOf(ctx)
  if (live.pushed.has(itemId)) return
  const t = setTimeout(() => {
    live.pushed.delete(itemId)
    void viewOf(ctx, itemId)
      .then((view) => ctx.push({ push: 'work.media', itemId, view }, { need: 'read' }))
      .catch((err) => ctx.log(`media: push of ${itemId}: ${err instanceof Error ? err.message : err}`))
  }, 500)
  t.unref?.()
  live.pushed.set(itemId, t)
}

/** Who a note is by: the person at any of his clients, or the thread that called the tool. */
export const ownerOrAgent = (ctx: WorkCtx, sessionId?: string): Principal => (sessionId ? agentPrincipal(ctx.host, sessionId) : 'owner')

/** An agent's notes, by the item's mode: waiting for him on a shared item or in Suggests, else written straight on with an Undo. */
export function agentWrite(ctx: WorkCtx, itemId: string, sessionId: string, notes: Array<Omit<Parameters<MediaStore['addNote']>[1], 'by' | 'state' | 'writeId'>>, what: string): { notes: MediaNote[]; suggested: boolean } {
  const item = mediaItem(ctx, itemId)
  const row = itemRow(ctx, item)
  const { store } = liveOf(ctx)
  const suggested = row.shared || row.mode === 'suggests'
  const writeId = suggested ? undefined : `w-${Date.now().toString(36)}`
  const by = agentPrincipal(ctx.host, sessionId)
  const made = notes.map((n) => store.addNote(item.id, { ...n, by, state: suggested ? 'suggested' : 'kept', ...(writeId ? { writeId } : {}) }))
  if (writeId) store.setLastWrite(item.id, { id: writeId, text: what, at: Date.now() })
  pushSoon(ctx, item.id)
  return { notes: made, suggested }
}
