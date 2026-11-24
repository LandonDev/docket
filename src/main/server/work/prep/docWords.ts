import { existsSync, readFileSync } from 'node:fs'
import { PREP_NOTES_MAX, type PrepPage } from '@shared/contract-work-prep'
import { errorText } from '@shared/work'
import type { WorkCtx } from '../modules'

/**
 * His notes document's words, for a follow-up thread to read in its message and in `prep_read`. The starter is a
 * Word file, and `doc_read` reads only a `.tcdoc`, a LifeOS document or a Google Doc, so the host reads a `.docx`
 * itself with the same reader the formats pillar imports Word through (work-kit's `readDocx`, written out as
 * markdown). Null for no document, or one `doc_read` already reads (a `.tcdoc`); `error` when the file is gone or
 * cannot be read, so a follow-up with nothing else to go on is refused before it starts.
 */
export type DocWords = { text: string } | { error: string } | null

export async function notesDocWords(ctx: Pick<WorkCtx, 'host'>, page: Pick<PrepPage, 'doc'>): Promise<DocWords> {
  const file = page.doc.notes?.file
  if (file?.at !== 'file' || !/\.docx$/i.test(file.path)) return null
  if (file.host !== ctx.host && !existsSync(file.path)) return { error: 'it is on another computer' }
  if (!existsSync(file.path)) return { error: 'it is not there any more' }
  try {
    const [{ readDocx }, { writeMarkdown }] = await Promise.all([import('work-kit/formats/docx'), import('work-kit/formats/markdown')])
    const text = writeMarkdown(readDocx(new Uint8Array(readFileSync(file.path))).blocks).trim()
    // A notes page runs to a few pages; a pasted book is cut where the page's own notes are.
    return { text: text.length > PREP_NOTES_MAX ? `${text.slice(0, PREP_NOTES_MAX)}\n\n(The rest of the document is cut here.)` : text }
  } catch (err) {
    return { error: errorText(err) || 'it could not be read' }
  }
}
