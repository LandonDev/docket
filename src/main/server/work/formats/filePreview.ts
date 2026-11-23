import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import type { FilePreviewer } from '../files/hooks'
import { madeFromShared, targetOf } from '../docs/target'
import { canonicalPath } from '../service/ctx'
import type { WorkCtx } from '../modules'
import { scratchDir } from './importer'
import { fileDocumentPdf, pagesOf } from './preview'

/**
 * The last few Word and Markdown files' PDFs, in memory alone: paging through one in Quick Look
 * draws the file once, and a library's file still leaves nothing on disk. Keyed by the file as it
 * stands (its size and time), so a saved change is drawn anew.
 */
const RECENT = 4
const RECENT_BYTES = 16 * 1024 * 1024
const recent = new Map<string, Buffer>()

function remember(key: string, pdf: Buffer): void {
  if (pdf.length > RECENT_BYTES) return
  recent.delete(key)
  recent.set(key, pdf)
  while (recent.size > RECENT) recent.delete(recent.keys().next().value!)
}

/** Files has already let the caller reach the source. Draw one page here and answer it with the document's page count. */
export function documentFilePreviewer(ctx: WorkCtx): FilePreviewer {
  return async (source, { page, width, signal }) => {
    if (source.at !== 'file' || source.host !== ctx.host || signal?.aborted) return null
    const ext = extname(source.path).toLowerCase()
    if (ext !== '.tcdoc' && ext !== '.docx' && ext !== '.md') return null
    let dir: string | undefined
    try {
      const path = canonicalPath(source.path)
      const stat = statSync(path)
      if (!stat.isFile()) return null
      const shared = [source, { ...source, path }].some((ref) => madeFromShared(ctx, ref))
      dir = mkdtempSync(join(scratchDir(ctx), 'page-'))
      const pdf = join(dir, 'picture.pdf')
      const job = { here: true, shared, signal }
      let bytes: Buffer
      if (ext === '.tcdoc') {
        // A document's words live in the service, not in its file's time: asked each time (a private one's render is kept by Preview's store).
        const t = await targetOf(ctx, { kind: 'local', caps: [] }, 'work.files.preview', source)
        bytes = await fileDocumentPdf(ctx, t, shared, signal)
        writeFileSync(pdf, bytes)
      } else {
        const key = `${path}\u0000${stat.size}\u0000${stat.mtimeMs}`
        const kept = recent.get(key)
        if (kept) writeFileSync(pdf, kept)
        else {
          let input = path
          if (ext === '.md') {
            const { readMarkdown } = await import('work-kit/formats/markdown')
            const { writeDocx } = await import('work-kit/formats/docx')
            const { blocks, sidecar } = readMarkdown(readFileSync(path, 'utf8'))
            input = join(dir, 'input.docx')
            writeFileSync(input, await writeDocx(blocks, sidecar, { title: basename(path, extname(path)) }))
          }
          await ctx.convert({ ...job, from: 'docx', to: 'pdf', input, output: pdf })
        }
        bytes = kept ?? readFileSync(pdf)
        remember(key, bytes)
      }
      if (signal?.aborted) return null
      const picture = await ctx.convert({ ...job, from: 'pdf', to: 'png', input: pdf, output: join(dir, 'page.png'), options: { page, width } })
      if (signal?.aborted) return null
      const png = readFileSync(picture.output)
      return { png, pages: await pagesOf(bytes) }
    } catch {
      return null
    } finally {
      if (dir) rmSync(dir, { recursive: true, force: true })
    }
  }
}
