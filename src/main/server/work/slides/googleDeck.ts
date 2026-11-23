import { readFileSync } from 'node:fs'
import type { CanvasItem } from '@shared/work'
import { PPTX_MIME } from '../google/deckMirror'
import type { WorkCtx } from '../modules'
import { deckPath, serial, sharedDeck } from './view'

/** Send only the saved file (an import's snapshot of his own file), never a proposed render or a library's copy. */
export async function deckUploadBytes(ctx: WorkCtx, item: CanvasItem, signal?: AbortSignal): Promise<{ bytes: Buffer; mime: string }> {
  return serial(ctx, item, async () => {
    if (sharedDeck(ctx, item)) throw new Error('A shared deck stays on this host.')
    return { bytes: readFileSync(await deckPath(ctx, item, signal)), mime: PPTX_MIME }
  })
}
