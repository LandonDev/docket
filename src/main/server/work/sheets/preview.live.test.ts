import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { decodePDFRawStream, PDFArray, PDFDocument, PDFRawStream, type PDFPage } from 'pdf-lib'
import type { CanvasItem } from '@shared/work'
import { LIBREOFFICE_CONVERTERS } from '../formats/index'
import type { ConvertJob, ConvertResult } from '../formats/jobs'
import { runTool, type Toolchain } from '../formats/tools'
import type { WorkCtx } from '../modules'
import type { Sheets } from './held'
import { readText, readZip, writeZip } from './patch/zip'
import { exportPreview, previewSheet, readSheetPreview, SHEET_PREVIEW_CONVERTERS, withoutBreaksUnderFit } from './preview'
import { SOFFICE } from './testing'

/**
 * Preview behind the real LibreOffice (skipped where it is absent; run
 * through `heavy` on the box). The ten print fixtures of the editors plan:
 * each preview's pages equal LibreOffice's own PDF of the same render input,
 * page for page (their count, their size and what is drawn on each), so the
 * frame shows the render and not something else. Then each format's pairs,
 * the filters and the pairs this pillar adds, once on a real workbook.
 * Excel's own pages of the same fixtures and of the Fit-to probes
 * (print/excel-truth.json, made in the Windows VM) are set beside the
 * preview's in the report: a record for the fixtures (where an automatic
 * break falls differs by a row or two between the programs), and for the
 * probes one thing held, the page count the Fit-to rule gives.
 */
const CORPUS = join(import.meta.dirname, 'harness/corpus')
const EXPECT = JSON.parse(readFileSync(join(CORPUS, 'print/expect.json'), 'utf8')) as { cases: Record<string, { file: string; libreoffice: unknown[]; excelRules: unknown[] }> }
interface TruthPage { size: [number, number]; rows: string; cols: string }
const TRUTH = JSON.parse(readFileSync(join(CORPUS, 'print/excel-truth.json'), 'utf8')) as {
  cases: Record<string, { pages: TruthPage[] }>
  probes: Record<string, { made: { fit: [number, number]; rowBreakAfter: number; colBreakAfter?: number }; pages: TruthPage[] }>
}
const CONVERTERS = [...LIBREOFFICE_CONVERTERS, ...SHEET_PREVIEW_CONVERTERS]
const there = existsSync(SOFFICE)
let dir: string

/** The runner's part, in this process: the converter for the pair, with LibreOffice as the box installs it. */
async function convert(job: ConvertJob): Promise<ConvertResult> {
  const c = CONVERTERS.find((x) => x.from === job.from && x.to === job.to)
  if (!c) throw new Error(`no converter from ${job.from} to ${job.to}`)
  const tmp = mkdtempSync(join(dir, 'job-'))
  try {
    await c.run({ ...job, output: job.output! }, { tools: { bin: () => SOFFICE, dataDir: dir } as unknown as Toolchain, threads: 1, slot: 0, tmp, signal: new AbortController().signal, run: (cmd, args, o) => runTool(cmd, args, o) })
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
  return { output: job.output!, ranOn: 'env_test', warnings: [] }
}

const ctx = (): WorkCtx => ({ dataDir: dir, host: 'env_test', convert } as unknown as WorkCtx)
const sheets = (): Sheets => ({ ctx: ctx(), packages: { open: async () => ({ rev: 0 }), fileAt: (p: string) => p } } as unknown as Sheets)
const itemOf = (path: string, id: string): CanvasItem => ({ id, sessionId: 'thread1', kind: 'sheet', title: path.split('/').pop()!, source: { at: 'file', host: 'env_test', path } }) as unknown as CanvasItem

/** What one page draws: its size and its content streams, decoded. */
function pageOf(page: PDFPage): string {
  const { width, height } = page.getSize()
  const contents = page.node.Contents()
  const streams = contents instanceof PDFArray ? contents.asArray().map((ref) => page.doc.context.lookup(ref)) : [contents]
  const text = streams.map((s) => (s instanceof PDFRawStream ? Buffer.from(decodePDFRawStream(s).decode()).toString('latin1') : '')).join('\n')
  // LibreOffice tags a PDF made with no filter options and not one made with a page range: the tags' marked-content
  // operators draw nothing, so they are left out of what a page is said to draw.
  const drawn = text
    .replace(/\/\w+\s*<<[^>]*>>\s*BDC/g, ' ')
    .replace(/\/\w+\s+BMC/g, ' ')
    .replace(/\bEMC\b/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .join(' ')
  return `${Math.round(width)}x${Math.round(height)}\n${drawn}`
}
const pagesOf = async (bytes: Uint8Array): Promise<string[]> => (await PDFDocument.load(bytes)).getPages().map(pageOf)

const results: Record<string, unknown> = {}
/** Keeps a preview's PDF where `SHEET_PREVIEW_KEEP` names a folder, to read its pages beside Excel's. */
const keep = (name: string, pdf: Uint8Array): void => {
  if (!process.env.SHEET_PREVIEW_KEEP) return
  mkdirSync(process.env.SHEET_PREVIEW_KEEP, { recursive: true })
  writeFileSync(join(process.env.SHEET_PREVIEW_KEEP, `${name}.pdf`), pdf)
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'tc-sheet-preview-live-'))
  mkdirSync(join(dir, 'files'))
})
afterAll(() => {
  if (process.env.SHEET_PREVIEW_REPORT) writeFileSync(process.env.SHEET_PREVIEW_REPORT, JSON.stringify(results, null, 1))
  rmSync(dir, { recursive: true, force: true })
})

describe.skipIf(!there)('Preview behind LibreOffice', () => {
  for (const [name, c] of Object.entries(EXPECT.cases))
    it(`draws ${name} as LibreOffice prints the same input, page for page`, { timeout: 180_000 }, async () => {
      const path = join(dir, 'files', c.file.split('/').pop()!)
      copyFileSync(join(CORPUS, c.file), path)
      const item = itemOf(path, `item-${name}`)
      const got = await previewSheet(sheets(), item, { format: 'pdf' })
      if (got.kind !== 'paged') throw new Error('paged')
      const shown = Buffer.from(readSheetPreview(ctx(), item, { rev: got.rev, offset: 0, length: got.size }).data, 'base64')
      // LibreOffice's own PDF of the render input: the file, with its breaks taken out where it prints fitted.
      const bytes = new Uint8Array(readFileSync(path))
      const input = join(dir, `${name}.input.xlsx`)
      writeFileSync(input, withoutBreaksUnderFit(bytes) ?? bytes)
      const own = await convert({ from: 'xlsx', to: 'pdf', input, output: join(dir, `${name}.own.pdf`) })
      const ours = await pagesOf(shown)
      const theirs = await pagesOf(new Uint8Array(readFileSync(own.output)))
      keep(name, shown)
      // Excel's own count, where Excel opened the file: null for the one it refused.
      results[name] = { preview: ours.length, libreofficeSameInput: theirs.length, libreofficeFileAsIs: c.libreoffice.length, excelRules: c.excelRules.length, excel: TRUTH.cases[name]?.pages.length || null, breaksTakenOut: withoutBreaksUnderFit(bytes) !== null }
      expect(got.pages).toBe(ours.length)
      expect(ours).toEqual(theirs)
    })

  for (const [name, probe] of Object.entries(TRUTH.probes))
    it(`draws the Fit-to probe ${name} beside Excel's own print of it`, { timeout: 180_000 }, async () => {
      // The probe as Excel was given it: fit-width.xlsx with its fit set and a manual break after a row and a column.
      const z = readZip(new Uint8Array(readFileSync(join(CORPUS, 'print/fit-width.xlsx'))))
      const part = 'xl/worksheets/sheet1.xml'
      const { fit, rowBreakAfter, colBreakAfter } = probe.made
      const breaks =
        `<rowBreaks count="1" manualBreakCount="1"><brk id="${rowBreakAfter}" max="16383" man="1"/></rowBreaks>` +
        (colBreakAfter ? `<colBreaks count="1" manualBreakCount="1"><brk id="${colBreakAfter}" max="1048575" man="1"/></colBreaks>` : '')
      const xml = readText(z, part)
        .replace(/<pageSetup [^>]*\/>/, `<pageSetup paperSize="1" fitToWidth="${fit[0]}" fitToHeight="${fit[1]}" orientation="portrait"/>`)
        .replace(/<rowBreaks[\s\S]*<\/rowBreaks>/, breaks)
      const path = join(dir, 'files', `probe-${name}.xlsx`)
      writeFileSync(path, writeZip(z, new Map([[part, new TextEncoder().encode(xml)]]), new Set(), new Map()))
      const item = itemOf(path, `item-probe-${name}`)
      const got = await previewSheet(sheets(), item, { format: 'pdf' })
      if (got.kind !== 'paged') throw new Error('paged')
      keep(`probe-${name}`, Buffer.from(readSheetPreview(ctx(), item, { rev: got.rev, offset: 0, length: got.size }).data, 'base64'))
      results[`probe-${name}`] = { preview: got.pages, excel: probe.pages.length }
      // As many pages as Excel printed: with LibreOffice as the box installs it, the rule's breaks give Excel's count.
      expect(got.pages).toBe(probe.pages.length)
    })

  it('draws OpenDocument and Excel 97-2003 from the exported file, CSV and TSV as one sheet, and the web page', { timeout: 300_000 }, async () => {
    const path = join(dir, 'files', 'formulas.xlsx')
    copyFileSync(join(CORPUS, 'formulas.xlsx'), path)
    // As Excel saves it: no ask to work it out again on load, so the values kept beside its formulas stand and its sheet
    // of formulas is written as text (the corpus is XlsxWriter's, which asks: jobs.ts `unworkedIn`).
    const z = readZip(new Uint8Array(readFileSync(path)))
    writeFileSync(path, writeZip(z, new Map([['xl/workbook.xml', new TextEncoder().encode(readText(z, 'xl/workbook.xml').replace(/\s*fullCalcOnLoad="1"/, ''))]]), new Set(), new Map()))
    const item = itemOf(path, 'item-formats')
    const ods = await previewSheet(sheets(), item, { format: 'ods' })
    const xls = await previewSheet(sheets(), item, { format: 'xls' })
    expect(ods.kind === 'paged' && ods.pages).toBeGreaterThan(0)
    expect(xls.kind === 'paged' && xls.pages).toBeGreaterThan(0)
    const csv = await previewSheet(sheets(), item, { format: 'csv', sheet: 'Calc' })
    const tsv = await previewSheet(sheets(), item, { format: 'tsv', sheet: 'Calc' })
    if (csv.kind !== 'table' || tsv.kind !== 'table') throw new Error('tables')
    // The sheet asked for, not the first: LibreOffice's text export takes the sheet by its place.
    expect(csv.name).toBe('Calc')
    expect(csv.rows.length).toBeGreaterThan(1)
    expect(tsv.rows).toEqual(csv.rows)
    const first = await previewSheet(sheets(), item, { format: 'csv' })
    expect(first.kind === 'table' && first.rows).not.toEqual(csv.rows)
    const html = await previewSheet(sheets(), item, { format: 'html' })
    expect(html.kind === 'html' && html.html).toMatch(/<table/i)
    const out = await exportPreview(sheets(), item, { format: 'ods' })
    const zip = Buffer.from(readSheetPreview(ctx(), item, { rev: out.rev, offset: 0, length: 64 }).data, 'base64')
    expect(zip.subarray(0, 2).toString('latin1')).toBe('PK')
    results.formats = { ods: ods.kind === 'paged' && ods.pages, xls: xls.kind === 'paged' && xls.pages, csvRows: csv.rows.length, firstSheetRows: first.kind === 'table' && first.rows.length, html: html.kind === 'html' && html.html.length }
  })

  it('runs the pairs this pillar adds: a macro workbook to PDF, a TSV in', { timeout: 300_000 }, async () => {
    const path = join(dir, 'files', 'macro.xlsm')
    copyFileSync(join(CORPUS, 'macro.xlsm'), path)
    const got = await previewSheet(sheets(), itemOf(path, 'item-macro'), { format: 'pdf' })
    expect(got.kind === 'paged' && got.pages).toBeGreaterThan(0)
    const tsv = join(dir, 'in.tsv')
    writeFileSync(tsv, 'Item\tCost\nHotel, two nights\t240\nTaxi\t35\n')
    const made = await convert({ from: 'tsv', to: 'xlsx', input: tsv, output: join(dir, 'in.xlsx') })
    const back = await convert({ from: 'xlsx', to: 'csv', input: made.output, output: join(dir, 'back.csv') })
    expect(readFileSync(back.output, 'utf8').replace(/\r\n/g, '\n')).toBe('Item,Cost\n"Hotel, two nights",240\nTaxi,35\n')
  })
})
