import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Converter } from './jobs'
import { tailOf } from './tools'

/**
 * A PDF to markdown, to edit as a document (the formats report, §2 "PDF in"):
 * pymupdf4llm first (0.6 s a document, keeps bold, italic and tables), then
 * Docling where this host has it and pymupdf4llm found next to no text (a
 * scan, a page of pictures). pymupdf4llm and PyMuPDF are AGPL: they run here
 * as a separate, unmodified Python process (scripts/work-tools/formats.json).
 */

const TO_MARKDOWN = 'import sys, pymupdf4llm\nopen(sys.argv[2], "w", encoding="utf-8").write(pymupdf4llm.to_markdown(sys.argv[1]))'

/** Fewer letters than this over the whole file: not text pymupdf4llm could read. */
const MIN_TEXT = 40

export const pdfToMarkdown: Converter = {
  from: 'pdf',
  to: 'md',
  needs: 'pymupdf4llm',
  async run(job, run) {
    const py = run.tools.bin('pymupdf4llm')
    if (!py) throw new Error('pymupdf4llm is not installed here')
    const r = await run.run(py, ['-I', '-c', TO_MARKDOWN, job.input, job.output], { timeoutMs: 5 * 60_000, cwd: run.tmp })
    if (r.code !== 0) throw new Error(`could not read the PDF: ${tailOf(r.out) || `exit ${r.code}`}`)
    if (readFileSync(job.output, 'utf8').replace(/\s/g, '').length >= MIN_TEXT) return {}
    const docling = run.tools.bin('docling')
    if (!docling) return { warnings: ['The PDF holds next to no text (a scan?); reading scans needs Docling, which this host does not have.'] }
    const out = join(run.tmp, 'docling')
    mkdirSync(out, { recursive: true })
    const d = await run.run(docling, ['--to', 'md', '--output', out, job.input], { timeoutMs: 10 * 60_000, cwd: run.tmp })
    const made = d.code === 0 ? readdirSync(out).find((f) => f.endsWith('.md')) : undefined
    if (!made) return { warnings: [`Docling could not read it either: ${tailOf(d.out) || `exit ${d.code}`}`] }
    writeFileSync(job.output, readFileSync(join(out, made)))
    return { warnings: ['Read by Docling: bold and italic are not kept.'] }
  }
}
