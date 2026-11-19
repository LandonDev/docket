import type { MediaPlay, MediaProbe } from '@shared/contract-work-media'
import type { CanvasSource } from '@shared/work'
import type { WorkCtx } from '../modules'
import type { NoteInput } from './store'

/**
 * Where a media item's pictures can come from besides a file on this host.
 * A file is the media pillar's own; a review service registers an adapter
 * for its `CanvasSource['at']` (Frame.io, milestone 48, from its own
 * module's `start`) and the canvas, the notes, the stepper and the tools
 * work on its items unchanged. The adapter serves its own renditions, so the
 * host makes no proxy for them.
 */
export interface MediaSourceAdapter {
  at: CanvasSource['at']
  /** One version of the item: the rendition to play, its frame table inside `play`, and what is known of it. */
  resolve(source: CanvasSource, ctx: WorkCtx, signal: AbortSignal): Promise<{ name: string; play: MediaPlay; probe?: MediaProbe; shared: boolean }>
  /** The service's notes on it, each with `external` set; read when the item is viewed. */
  notes?(source: CanvasSource, ctx: WorkCtx, signal: AbortSignal): Promise<NoteInput[]>
}

const adapters = new Map<CanvasSource['at'], MediaSourceAdapter>()

/** Registers an adapter; a second one for the same `at` replaces it. Returns its off. */
export function registerMediaSource(adapter: MediaSourceAdapter): () => void {
  adapters.set(adapter.at, adapter)
  return () => {
    if (adapters.get(adapter.at) === adapter) adapters.delete(adapter.at)
  }
}

export const mediaSourceFor = (at: CanvasSource['at']): MediaSourceAdapter | null => adapters.get(at) ?? null
