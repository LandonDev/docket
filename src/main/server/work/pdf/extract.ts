import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { BboxSchema, type Bbox } from '@shared/contract-work-pdf'
import type { Converter, ConvertRun } from '../formats/jobs'
import { EXTRACT_PY } from './extractScript'

/**
 * The box's extract tool (docs/agents/work-pdf.md "The extract job"), as
 * two converters every other part reaches through `ctx.convert`:
 * `pdf→extract` (text in reading order and tables, as `PdfExtract` JSON)
 * and `pdf→png` (one page, or a region of it). A host without `pdf-tools`
 * forwards the job to one that has it. Milestone 21's quality path
 * (Docling) writes the same `PdfExtract`.
 */

export interface PdfExtract {
  /** pages in the file */
  pages: number
  /** every page asked for, with its size in points */
  sizes: Array<{ page: number; width: number; height: number }>
  /** text in reading order: one block a paragraph or a line run */
  blocks: Array<{ page: number; bbox: Bbox; text: string }>
  tables: Array<{ page: number; bbox: Bbox; rows: string[][] }>
  /** one line each: a page with no text layer ("page 12 has no text layer: it is a scan"), pages cut */
  warnings: string[]
}

/** The most pages one extract reads. */
export const EXTRACT_MAX_PAGES = 40

/** Options may come from another host's key: each is checked, and anything else is refused. */
const PAGE_SPEC = /^[\d\s,-]{1,200}$/
export const ExtractOptionsSchema = z
  .object({
    pages: z.string().regex(PAGE_SPEC, 'a page list is like 1-3,7').optional(),
    tables: z.boolean().default(true),
    maxPages: z.number().int().min(1).max(EXTRACT_MAX_PAGES).default(EXTRACT_MAX_PAGES)
  })
  .strict()
export const PngOptionsSchema = z
  .object({
    page: z.number().int().min(1).max(100_000).default(1),
    width: z.number().int().min(64).max(2400).default(1280),
    crop: BboxSchema.refine((b) => b[2] > b[0] && b[3] > b[1], 'a region runs from its top left to its bottom right').optional()
  })
  .strict()

function optionsOf<T extends z.ZodTypeAny>(schema: T, raw: unknown, what: string): z.output<T> {
  const parsed = schema.safeParse(raw ?? {})
  if (!parsed.success) throw new Error(`Not ${what} options: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'options'}: ${i.message}`).join('; ')}`)
  return parsed.data
}

/**
 * Which pages a spec like "1-3,7" names, in the file's order, each once.
 * Absent or blank: every page. More than `max`: the first `max`, and `cut`.
 * A page past the end, a range backwards or anything not a list is refused
 * with a sentence.
 */
export function parsePages(spec: string | undefined, total: number, max: number): { pages: number[]; cut: boolean } {
  const all = (n: number): number[] => Array.from({ length: n }, (_, i) => i + 1)
  const plural = `it has ${total} ${total === 1 ? 'page' : 'pages'}`
  let pages: number[]
  if (!spec || !spec.trim()) pages = all(total)
  else {
    const set = new Set<number>()
    for (const raw of spec.split(',')) {
      const part = raw.trim()
      const m = /^(\d{1,6})(?:\s*-\s*(\d{1,6})?)?$/.exec(part)
      if (!m) throw new Error(`"${part}" is not a page or a range: write pages like 1-3,7.`)
      const from = Number(m[1])
      const to = m[2] !== undefined ? Number(m[2]) : part.includes('-') ? total : from
      if (from < 1) throw new Error('Pages count from 1.')
      if (to < from) throw new Error(`${part} runs backwards: write the first page first.`)
      if (to > total) throw new Error(`Page ${from > total ? from : to} is not in this file: ${plural}.`)
      for (let p = from; p <= to; p++) set.add(p)
    }
    pages = [...set].sort((a, b) => a - b)
  }
  return pages.length > max ? { pages: pages.slice(0, max), cut: true } : { pages, cut: false }
}

/** Runs one mode of the script; a refusal comes back as its own sentence. */
async function runScript(run: ConvertRun, mode: 'count' | 'extract' | 'png', input: string, output: string, opts?: unknown, timeoutMs = 5 * 60_000): Promise<void> {
  const py = run.tools.bin('pdf-tools')
  if (!py) throw new Error('pdf-tools is not installed here')
  const script = join(run.tmp, 'tc_pdf.py')
  writeFileSync(script, EXTRACT_PY)
  const args = ['-I', script, mode, input, output]
  if (opts !== undefined) {
    const file = join(run.tmp, `${mode}-options.json`)
    writeFileSync(file, JSON.stringify(opts))
    args.push(file)
  }
  const r = await run.run(py, args, { timeoutMs, cwd: run.tmp })
  if (r.code === 0) return
  const said = /tc-error: (.+)/.exec(r.out)?.[1]?.trim()
  if (said) throw new Error(said)
  throw new Error(`pdf-tools could not ${mode === 'png' ? 'draw' : 'read'} the file: ${r.out.trim().split('\n').slice(-3).join(' ').slice(0, 500) || `exit ${r.code}`}`)
}

const cutNote = (pages: number[], total: number): string => {
  const last = pages[pages.length - 1]
  return `Read ${pages.length} of ${total} pages (to page ${last}): ask for the rest with pages, like ${last + 1}-${Math.min(total, last + EXTRACT_MAX_PAGES)}.`
}

export const PDF_CONVERTERS: Converter[] = [
  {
    from: 'pdf',
    to: 'extract',
    needs: 'pdf-tools',
    threads: 1,
    async run(job, run) {
      const o = optionsOf(ExtractOptionsSchema, job.options, 'extract')
      const counted = join(run.tmp, 'count.json')
      await runScript(run, 'count', job.input, counted, undefined, 60_000)
      const total = (JSON.parse(readFileSync(counted, 'utf8')) as { pages: number }).pages
      const { pages, cut } = parsePages(o.pages, total, o.maxPages)
      if (pages.length === 0) throw new Error('This PDF has no pages.')
      await runScript(run, 'extract', job.input, job.output, { pages, tables: o.tables, notes: cut ? [cutNote(pages, total)] : [] })
      return {}
    }
  },
  {
    from: 'pdf',
    to: 'png',
    needs: 'pdf-tools',
    threads: 1,
    async run(job, run) {
      const o = optionsOf(PngOptionsSchema, job.options, 'page picture')
      await runScript(run, 'png', job.input, job.output, o, 2 * 60_000)
      return {}
    }
  }
]

// ── markdown ──────────────────────────────────────────────────────────

const cell = (s: string): string => s.replace(/\s*\n\s*/g, ' ').replace(/\|/g, '\\|').trim()

function tableMarkdown(rows: string[][]): string {
  const width = Math.max(1, ...rows.map((r) => r.length))
  const line = (r: string[]): string => `| ${Array.from({ length: width }, (_, i) => cell(r[i] ?? '')).join(' | ')} |`
  const [head = [], ...body] = rows
  return [line(head), `|${' --- |'.repeat(width)}`, ...body.map(line)].join('\n')
}

/**
 * The same extract as markdown: per page a `## Page N` heading, each block
 * a paragraph, each table a markdown table where it sits among them.
 * `cite` gives the code put after each passage. A rendering of the JSON,
 * never a second reading of the file.
 */
export function extractMarkdown(x: PdfExtract, cite?: (page: number, bbox: Bbox) => string): string {
  const after = (page: number, bbox: Bbox): string => (cite ? ` ${cite(page, bbox)}` : '')
  const out: string[] = []
  for (const { page } of x.sizes) {
    const parts: string[] = []
    const tables = x.tables.filter((t) => t.page === page)
    const placed = new Set<number>()
    const putTables = (before: Bbox | null): void => {
      tables.forEach((t, i) => {
        if (placed.has(i)) return
        // A table goes before the first block below its top that shares its columns.
        if (before && !(before[1] >= t.bbox[1] && before[0] < t.bbox[2] && before[2] > t.bbox[0])) return
        placed.add(i)
        parts.push(`${tableMarkdown(t.rows)}${cite ? `\n\n${cite(page, t.bbox)}` : ''}`)
      })
    }
    for (const b of x.blocks) {
      if (b.page !== page) continue
      putTables(b.bbox)
      parts.push(`${b.text}${after(page, b.bbox)}`)
    }
    putTables(null)
    out.push(`## Page ${page}\n\n${parts.length ? parts.join('\n\n') : '(No text on this page.)'}`)
  }
  return out.join('\n\n')
}
