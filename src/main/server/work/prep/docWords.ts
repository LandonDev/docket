import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import { strFromU8, unzipSync } from 'fflate'
import { PREP_NOTES_MAX, type PrepPage } from '@shared/contract-work-prep'
import { errorText, type CanvasSource } from '@shared/work'
import type { WorkCtx } from '../modules'
import { importFolderOf } from '../files/imports'

/**
 * His notes document as he edits it: the one rule for every read of its path, its words and its version
 * (docs/agents/work-prep.md "A document").
 *
 * Write in a document makes a Word file from the template and keeps the `.tcdoc` the document editor works on
 * (`work.formats.import`). A page kept before that names the Word file; the editor, opening a Word file, writes its
 * edits to a `.tcdoc` it imports beside it (or under this host's data, for a place others can open), `<name>.tcdoc`
 * or `<name> 2.tcdoc` and on, whose sidecar names the Word file it was made of. The newest of those is what he
 * edited last, and stands for the Word file.
 */
export function editableNotes(ctx: Pick<WorkCtx, 'host' | 'dataDir'>, file: CanvasSource | undefined): CanvasSource | undefined {
  if (file?.at !== 'file' || file.host !== ctx.host || !/\.docx$/i.test(file.path)) return file
  const name = basename(file.path)
  const stem = basename(name, extname(name))
  let best: { path: string; at: number } | null = null
  for (const dir of [dirname(file.path), importFolderOf(ctx.dataDir, file)]) {
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry !== `${stem}.tcdoc` && !(entry.startsWith(`${stem} `) && /^ \d+\.tcdoc$/.test(entry.slice(stem.length)))) continue
      const path = join(dir, entry)
      try {
        if (tcdocEntry(path, 'sidecar.json', (text) => (JSON.parse(text) as { source?: { name?: string } }).source?.name) !== name) continue
        const at = statSync(path).mtimeMs
        if (!best || at > best.at) best = { path, at }
      } catch {
        // A file that is not a document of his notes is no candidate.
      }
    }
  }
  return best ? { at: 'file', host: file.host, path: best.path } : file
}

/** One entry of a `.tcdoc` (a zip), read without the rest. */
function tcdocEntry<T>(path: string, entry: string, read: (text: string) => T): T | undefined {
  const got = unzipSync(new Uint8Array(readFileSync(path)), { filter: (f) => f.name === entry })[entry]
  return got ? read(strFromU8(got)) : undefined
}

/** The notes version of a document: when it was last saved, on this host; 0 when it cannot be read here. */
export function notesDocAt(ctx: Pick<WorkCtx, 'host' | 'dataDir'>, file: CanvasSource | undefined): number {
  const doc = editableNotes(ctx, file)
  if (doc?.at !== 'file' || doc.host !== ctx.host) return 0
  try {
    return Math.floor(statSync(doc.path).mtimeMs)
  } catch {
    return 0
  }
}

/**
 * His notes document's words, for a follow-up thread to read in its message and in `prep_read`. A `.tcdoc` keeps
 * its words as markdown beside its state (`preview.md`, rewritten on every save); a Word file with no document made
 * of it is read with the reader the formats pillar imports Word through (work-kit's `readDocx`, as markdown). Null
 * for no document, or one on another host; `error` when it is gone or cannot be read, so a follow-up with nothing
 * else to go on is refused before it starts.
 */
export type DocWords = { text: string } | { error: string } | null

export async function notesDocWords(ctx: Pick<WorkCtx, 'host' | 'dataDir'>, page: Pick<PrepPage, 'doc'>): Promise<DocWords> {
  const file = editableNotes(ctx, page.doc.notes?.file)
  if (file?.at !== 'file') return null
  if (file.host !== ctx.host) return existsSync(file.path) ? null : { error: 'it is on another computer' }
  if (!existsSync(file.path)) return { error: 'it is not there any more' }
  try {
    let text: string
    if (/\.tcdoc$/i.test(file.path)) text = (tcdocEntry(file.path, 'preview.md', (t) => t) ?? '').trim()
    else if (/\.docx$/i.test(file.path)) {
      const [{ readDocx }, { writeMarkdown }] = await Promise.all([import('work-kit/formats/docx'), import('work-kit/formats/markdown')])
      text = writeMarkdown(readDocx(new Uint8Array(readFileSync(file.path))).blocks).trim()
    } else return null
    // A notes page runs to a few pages; a pasted book is cut where the page's own notes are.
    return { text: text.length > PREP_NOTES_MAX ? `${text.slice(0, PREP_NOTES_MAX)}\n\n(The rest of the document is cut here.)` : text }
  } catch (err) {
    return { error: errorText(err) || 'it could not be read' }
  }
}
