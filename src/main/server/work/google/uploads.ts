import type { CanvasItem } from '@shared/work'
import { madeFromShared } from '../formats/exporter'
import type { Caller, WorkCtx } from '../modules'
import { fenceItem } from '../pdf/file'
import { isTeamsSnapshot } from '../slides/formatsIn'
import { GOOGLE_MIME } from './client'
import { googleOf } from './google'

type UploadKind = 'slides' | 'sheet'
type UploadBytes = (ctx: WorkCtx, item: CanvasItem, signal?: AbortSignal) => Promise<{ bytes: Buffer; mime: string }>
const providers = new Map<UploadKind, UploadBytes>()

/** The editor provides saved Office bytes. Google owns the Drive upload. */
export function registerUploadBytes(kind: UploadKind, read: UploadBytes): () => void {
  providers.set(kind, read)
  return () => {
    if (providers.get(kind) === read) providers.delete(kind)
  }
}

export async function uploadOfficeFile(ctx: WorkCtx, by: Caller, item: CanvasItem, account: string, signal?: AbortSignal): Promise<{ fileId: string; url: string }> {
  const slides = item.kind === 'slides'
  const app = slides ? 'Slides' : 'Sheets'
  if (item.source.at === 'google') throw new Error(`${item.title} is in Google ${app} already.`)
  // His press alone: never a thread, never a call another host of his makes for one of its threads.
  if (by.kind === 'model' || (by.kind === 'remote' && by.peer)) throw new Error('Only the owner saves a file to Google, from his own window.')
  fenceItem(ctx, by, item, 'work.google.upload')
  const read = providers.get(slides ? 'slides' : 'sheet')
  if (!read) throw new Error(slides ? 'Save to Google Slides is not built yet.' : 'Save to Google Sheets is not built yet.')
  // Checked here for every kind's provider: a library's file, and a snapshot the Teams view made of one, stay here.
  if (madeFromShared(ctx, item.source) || isTeamsSnapshot(ctx.dataDir, item.source)) throw new Error('A file from a shared library stays on this host.')
  const { bytes, mime } = await read(ctx, item, signal)

  signal?.throwIfAborted()
  const title = item.title.replace(/\.(pptx|ppt|ppsx|pps|odp|key|xlsx|xlsm|tcsheet|csv)$/i, '')
  const made = await googleOf(ctx).api(account).create(title, slides ? GOOGLE_MIME.slides : GOOGLE_MIME.sheet, bytes, mime)
  const url = made.webViewLink ?? `https://docs.google.com/${slides ? 'presentation' : 'spreadsheets'}/d/${encodeURIComponent(made.id)}/edit`
  ctx.results.add({ sessionId: item.sessionId, kind: slides ? 'google.slides.upload' : 'google.sheet.upload', summary: `Saved ${title} to Google ${app}`, account, ref: { at: 'google', fileId: made.id, url } })
  return { fileId: made.id, url }
}
