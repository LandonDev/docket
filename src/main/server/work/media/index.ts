import { basename } from 'node:path'
import { handled, NOT_HANDLED } from '@shared/work'
import { moveFileKeys } from '../canvas/fileKey'
import { registerFileMoved } from '../files/hooks'
import type { WorkModule } from '../modules'
import { MEDIA_CONVERTERS } from './prepare'
import { ensureMediaTables, MEDIA_KEYED } from './store'
import { mediaTools } from './tools'
import { itemRow, liveOf, mediaItem, ownerOrAgent, preparerOf, pushSoon, stopMedia, viewOf } from './view'

/**
 * The media pillar's server module (docs/agents/work-media.md): an image or a
 * video beside a Work thread, probed and, where the viewer cannot decode it,
 * proxied on the host; its versions; the notes on it, keyed by frame; the
 * agent's tools. A file is the pillar's own source; a review service plugs in
 * through `registerMediaSource` (sources.ts).
 */
export const media: WorkModule = {
  id: 'media',
  ensure: ensureMediaTables,
  convert: MEDIA_CONVERTERS,
  start(ctx) {
    liveOf(ctx)
    // A file renamed or moved in Files: the rows kept by it follow.
    const off = registerFileMoved((from, to, at) => moveFileKeys(at.db, MEDIA_KEYED, from, to))
    return () => {
      off()
      stopMedia(ctx)
    }
  },
  async handle(req, ctx, by) {
    const { store } = liveOf(ctx)
    const after = async (itemId: string) => {
      pushSoon(ctx, itemId)
      return handled(await viewOf(ctx, itemId))
    }
    switch (req.method) {
      case 'work.media.view': {
        // Only a caller who may operate starts work on the host: a read-only key sees what is there.
        const start = by.kind === 'local' || by.caps.includes('operate')
        return handled(await viewOf(ctx, req.params.itemId, { plays: req.params.plays, start, retry: start && req.params.retry }))
      }
      case 'work.media.note': {
        const { itemId, kind, anchor, body, parentId } = req.params
        const kept = itemRow(ctx, mediaItem(ctx, itemId)).itemId
        if (parentId && store.note(parentId)?.itemId !== kept) throw new Error('a reply answers a note on the same item')
        const note = store.addNote(kept, { kind, anchor, body, by: ownerOrAgent(ctx, by.kind === 'model' ? by.sessionId : undefined), ...(parentId ? { parentId } : {}) })
        pushSoon(ctx, itemId)
        return handled(note)
      }
      case 'work.media.edit': {
        const { noteId, body, resolved } = req.params
        const was = store.note(noteId)
        if (!was) throw new Error(`no note ${noteId}`)
        mediaItem(ctx, was.itemId)
        const note = store.editNote(noteId, { ...(body !== undefined ? { body } : {}), ...(resolved !== undefined ? { resolved } : {}) })
        pushSoon(ctx, note.itemId)
        return handled(note)
      }
      case 'work.media.remove': {
        const note = store.note(req.params.noteId)
        if (note) {
          mediaItem(ctx, note.itemId)
          store.removeNote(note.id)
          pushSoon(ctx, note.itemId)
        }
        return handled(null)
      }
      case 'work.media.decide': {
        const { itemId, which, accept } = req.params
        const waiting = store.notes(itemRow(ctx, mediaItem(ctx, itemId)).itemId).filter((n) => n.state === 'suggested' && (which === 'all' || n.id === which))
        if (which !== 'all' && waiting.length === 0) throw new Error('that note is not waiting for you')
        // Accepted, an agent's note is the person's: his words on his file from now on.
        for (const n of waiting) accept ? store.editNote(n.id, { state: 'kept', by: 'owner' }) : store.removeNote(n.id)
        return after(itemId)
      }
      case 'work.media.mode': {
        store.setMode(itemRow(ctx, mediaItem(ctx, req.params.itemId)).itemId, req.params.mode)
        return after(req.params.itemId)
      }
      case 'work.media.undo': {
        const { itemId, writeId } = req.params
        const row = itemRow(ctx, mediaItem(ctx, itemId))
        if (row.lastWrite?.id !== writeId) throw new Error('that write can no longer be taken back')
        store.removeWrite(row.itemId, writeId)
        store.setLastWrite(row.itemId, null)
        return after(itemId)
      }
      case 'work.media.version': {
        const { itemId, source } = req.params
        const kept = itemRow(ctx, mediaItem(ctx, itemId)).itemId
        if (source.at !== 'file') throw new Error('a version is a file on a host')
        store.addVersion(kept, { source, name: basename(source.path), by: 'owner' })
        return after(itemId)
      }
      case 'work.media.segment': {
        const { itemId, versionId, index } = req.params
        if (store.version(versionId)?.itemId !== store.keptOf(mediaItem(ctx, itemId)).id) throw new Error(`no version ${versionId} of this item`)
        const data = (await preparerOf(ctx)).segment(versionId, index)
        if (!data) throw new Error(`segment ${index} is not there yet`)
        return handled({ data: data.toString('base64') })
      }
      case 'work.media.tile': {
        const { itemId, versionId, level, x, y } = req.params
        if (store.version(versionId)?.itemId !== store.keptOf(mediaItem(ctx, itemId)).id) throw new Error(`no version ${versionId} of this item`)
        const data = (await preparerOf(ctx)).tile(versionId, level, x, y)
        if (!data) throw new Error('no such tile')
        return handled({ data: data.toString('base64') })
      }
    }
    return NOT_HANDLED
  },
  tools: () => mediaTools,
  sessionsRemoved(ids, ctx) {
    const versions = liveOf(ctx).store.removeSessions(ids)
    void preparerOf(ctx)
      .then((p) => p.forget(versions))
      .catch(() => undefined)
  },
  itemsRemoved(items, ctx) {
    const versions = liveOf(ctx).store.removeItems(items.map((i) => i.id))
    void preparerOf(ctx)
      .then((p) => p.forget(versions))
      .catch(() => undefined)
  },
  // Nothing: a deleted workspace's threads are removed too, and `sessionsRemoved` clears their rows.
  workspaceRemoved() {}
}
