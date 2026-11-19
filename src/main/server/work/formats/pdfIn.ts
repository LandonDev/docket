import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Converter } from './jobs'
import { tailOf } from './tools'

/**
 * A PDF to markdown, to edit as a document (the formats report, §2 "PDF in"):
 * pymupdf4llm first (under a second a document, keeps bold, italic and
 * tables), then Docling for what it reads better, tables and scans
 * (`needsDocling`), where the host has it (scripts/work-tools/formats.json:
 * the box). Docling runs offline from the models the installer put beside it.
 * pymupdf4llm and PyMuPDF are AGPL and Docling's closure is permissive; each
 * runs here as a separate, unmodified Python process.
 */

/** Writes the markdown, then says how many tables PyMuPDF finds on the pages. */
const TO_MARKDOWN = [
  'import sys, json, pymupdf, pymupdf4llm',
  'open(sys.argv[2], "w", encoding="utf-8").write(pymupdf4llm.to_markdown(sys.argv[1]))',
  'doc = pymupdf.open(sys.argv[1])',
  'print(json.dumps({"tables": sum(len(p.find_tables().tables) for p in doc)}))'
].join('\n')

/** Fewer letters than this over the whole file: not text pymupdf4llm could read (a scan, a page of pictures). */
const MIN_TEXT = 40

/** Why Docling should read this PDF, or null when pymupdf4llm's reading stands. */
export function needsDocling(markdown: string, tables: number): 'scan' | 'tables' | null {
  if (markdown.replace(/\s/g, '').length < MIN_TEXT) return 'scan'
  return tables > 0 ? 'tables' : null
}

export const pdfToMarkdown: Converter = {
  from: 'pdf',
  to: 'md',
  needs: 'pymupdf4llm',
  async run(job, run) {
    const py = run.tools.bin('pymupdf4llm')
    if (!py) throw new Error('pymupdf4llm is not installed here')
    const r = await run.run(py, ['-I', '-c', TO_MARKDOWN, job.input, job.output], { timeoutMs: 5 * 60_000, cwd: run.tmp })
    if (r.code !== 0) throw new Error(`could not read the PDF: ${tailOf(r.out) || `exit ${r.code}`}`)
    const tables = Number(/"tables":\s*(\d+)/.exec(r.out)?.[1] ?? 0)
    const why = needsDocling(readFileSync(job.output, 'utf8'), tables)
    if (!why) return {}
    const docling = run.tools.bin('docling')
    const models = run.tools.bin('docling-models')
    if (!docling || !models) return why === 'scan' ? { warnings: ['The PDF holds next to no text (a scan?); reading scans needs Docling, which this host does not have.'] } : {}
    const out = join(run.tmp, 'docling')
    mkdirSync(out, { recursive: true })
    // The models' folder is two up from the file the manifest names as their bin (RapidOcr/ppocrv6_dict.txt).
    const d = await run.run(docling, ['--artifacts-path', dirname(dirname(models)), '--to', 'md', '--output', out, job.input], {
      timeoutMs: 10 * 60_000,
      cwd: run.tmp,
      env: { HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', OMP_NUM_THREADS: String(Math.max(2, run.threads)) }
    })
    const made = d.code === 0 ? readdirSync(out).find((f) => f.endsWith('.md')) : undefined
    if (!made) {
      if (why === 'scan') return { warnings: [`Docling could not read it either: ${tailOf(d.out) || `exit ${d.code}`}`] }
      // Tables pymupdf4llm already read: its reading stands.
      return {}
    }
    writeFileSync(job.output, readFileSync(join(out, made)))
    return { warnings: [why === 'scan' ? 'Read from the page pictures by OCR: check the words.' : 'Its tables were read by Docling, which keeps no bold or italic.'] }
  }
}
