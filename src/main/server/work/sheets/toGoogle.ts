import { rmSync } from 'node:fs'
import type { CanvasItem } from '@shared/work'
import type { WorkCtx } from '../modules'
import { heldOf, sheetsOf, type Sheets } from './held'
import { bookOf } from './preview'
import { offersGoogle, othersOpen } from './toGoogleOffer'

/**
 * "Save to Google Sheets" (docs/agents/work-sheets.md "Save to Google Sheets"): the sheet's side of the google
 * pillar's upload (google/uploads.ts `uploadOfficeFile`, `work.google.upload`). That pillar holds the act: his
 * own press at his own window, never a thread's and never another host's on his behalf, the item's file fence,
 * and no file from a shared library. It asks this file for one thing, the workbook's bytes.
 *
 * The bytes are the workbook as Preview's Excel format draws it: an opened Excel file as it stands on disk, a
 * sheet of ours as the .xlsx the model writer makes, so what that format's line in Preview says it leaves out
 * is what the Google copy lacks before Drive converts it.
 */

const MIME = {
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xlsm: 'application/vnd.ms-excel.sheet.macroEnabled.12'
} as const

/** The words for a workbook that stays here, said again by this pillar should the google pillar's own check ever miss one. */
export const SHARED_STAYS = 'A shared workbook stays on this host.'

/** `offersGoogle` for an item: false too for one whose source this canvas does not open as a sheet. */
export function canSaveToGoogle(ctx: Pick<WorkCtx, 'db' | 'host' | 'dataDir'>, item: CanvasItem): boolean {
  try {
    return offersGoogle(ctx, heldOf(item, ctx.dataDir), item.source)
  } catch {
    return false
  }
}

/** The workbook's bytes as they stand now, for a `Sheets` in hand. */
export async function workbookBytes(s: Sheets, item: CanvasItem, signal?: AbortSignal): Promise<{ bytes: Buffer; mime: string }> {
  if (othersOpen(s.ctx, item.source)) throw new Error(SHARED_STAYS)
  signal?.throwIfAborted()
  // A workbook Excel or Google holds is refused here in `bookOf`'s own words: it is not this host's to send.
  const book = await bookOf(s, item)
  // Nothing is drawn: the scratch folder a read of the workbook makes goes at once.
  rmSync(book.scratch, { recursive: true, force: true })
  return { bytes: Buffer.from(book.bytes), mime: MIME[book.kind] }
}

/** The provider the sheets pillar registers with the google pillar: `registerUploadBytes('sheet', sheetUploadBytes)`. */
export async function sheetUploadBytes(ctx: WorkCtx, item: CanvasItem, signal?: AbortSignal): Promise<{ bytes: Buffer; mime: string }> {
  return workbookBytes(await sheetsOf(ctx), item, signal)
}
