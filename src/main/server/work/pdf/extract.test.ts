import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PDFDocument } from 'pdf-lib'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { pdfCiteHref } from '@shared/contract-work-pdf'
import { convertersOf, JobRunner, type ConvertRun } from '../formats/jobs'
import type { WorkModule } from '../modules'
import { EXTRACT_MAX_PAGES, extractMarkdown, parsePages, PDF_CONVERTERS, type PdfExtract } from './extract'
import { EXTRACT_PY } from './extractScript'
import { writePdf } from './form'

describe('parsePages', () => {
  it('reads ranges and single pages, in the file\'s order, each once', () => {
    expect(parsePages('1-3,7', 10, 40)).toEqual({ pages: [1, 2, 3, 7], cut: false })
    expect(parsePages(' 7 , 2-3, 3, 2 ', 10, 40)).toEqual({ pages: [2, 3, 7], cut: false })
    expect(parsePages('8-', 10, 40)).toEqual({ pages: [8, 9, 10], cut: false })
    expect(parsePages('5-5', 10, 40)).toEqual({ pages: [5], cut: false })
  })

  it('takes every page when no spec is given, and cuts at the most a call reads', () => {
    expect(parsePages(undefined, 3, 40)).toEqual({ pages: [1, 2, 3], cut: false })
    expect(parsePages('  ', 2, 40)).toEqual({ pages: [1, 2], cut: false })
    const long = parsePages(undefined, 300, EXTRACT_MAX_PAGES)
    expect(long.cut).toBe(true)
    expect(long.pages).toHaveLength(40)
    expect(long.pages.at(-1)).toBe(40)
    expect(parsePages('1-100', 300, 40)).toMatchObject({ cut: true, pages: expect.arrayContaining([1, 40]) })
  })

  it('refuses a page past the end, a backwards range, page 0 and anything not a list, each with a sentence', () => {
    expect(() => parsePages('12', 9, 40)).toThrow('Page 12 is not in this file: it has 9 pages.')
    expect(() => parsePages('8-12', 9, 40)).toThrow('Page 12 is not in this file: it has 9 pages.')
    expect(() => parsePages('2', 1, 40)).toThrow('it has 1 page.')
    expect(() => parsePages('5-3', 9, 40)).toThrow('5-3 runs backwards: write the first page first.')
    expect(() => parsePages('0', 9, 40)).toThrow('Pages count from 1.')
    expect(() => parsePages('one', 9, 40)).toThrow('"one" is not a page or a range: write pages like 1-3,7.')
    expect(() => parsePages('1,,2', 9, 40)).toThrow('"" is not a page or a range')
  })
})

describe('extractMarkdown', () => {
  const x: PdfExtract = {
    pages: 3,
    sizes: [
      { page: 1, width: 612, height: 792 },
      { page: 2, width: 612, height: 792 }
    ],
    blocks: [
      { page: 1, bbox: [0.1, 0.1, 0.9, 0.2], text: 'Table 3. Tax rates' },
      { page: 1, bbox: [0.1, 0.7, 0.9, 0.8], text: 'After the table.' }
    ],
    tables: [{ page: 1, bbox: [0.1, 0.3, 0.9, 0.6], rows: [['Year', 'Wage base'], ['2025', '$176,100'], ['a | b', 'two\nlines'], ['short']] }],
    warnings: ['page 2 has no text layer: it is a scan']
  }

  it('renders a heading per page, blocks as paragraphs and a table where it sits among them', () => {
    const md = extractMarkdown(x)
    expect(md).toBe(
      [
        '## Page 1',
        '',
        'Table 3. Tax rates',
        '',
        '| Year | Wage base |\n| --- | --- |\n| 2025 | $176,100 |\n| a \\| b | two lines |\n| short |  |',
        '',
        'After the table.',
        '',
        '## Page 2',
        '',
        '(No text on this page.)'
      ].join('\n')
    )
  })

  it('puts the citation code after each passage and each table', () => {
    const md = extractMarkdown(x, (page, bbox) => pdfCiteHref({ itemId: 'it1', page, bbox }))
    expect(md).toContain('Table 3. Tax rates #pdf:it1:1:100,100,900,200')
    expect(md).toContain('| short |  |\n\n#pdf:it1:1:100,300,900,600')
    expect(md).toContain('After the table. #pdf:it1:1:100,700,900,800')
  })
})

describe('the converters', () => {
  it('registers pdf→extract and pdf→png, both needing pdf-tools', () => {
    expect(PDF_CONVERTERS.map((c) => [`${c.from}→${c.to}`, c.needs])).toEqual([
      ['pdf→extract', 'pdf-tools'],
      ['pdf→png', 'pdf-tools']
    ])
  })

  it('ships the Python as a String.raw that holds no backtick and no dollar-brace', () => {
    expect(EXTRACT_PY).toContain('def extract(path, out, opts):')
    expect(EXTRACT_PY).toContain('doc.init_forms()')
    expect(EXTRACT_PY).not.toMatch(/`|\$\{/)
    // pymupdf is AGPL: the job never imports it.
    expect(EXTRACT_PY).not.toMatch(/fitz|pymupdf/i)
  })

  it('refuses options that are not its own before it runs anything, since they may come from another host', async () => {
    const ran: string[][] = []
    const run = { tools: { bin: () => '/bin/false' }, tmp: tmpdir(), run: async (_c: string, a: string[]) => (ran.push(a), { code: 0, out: '' }) } as unknown as ConvertRun
    const [extract, png] = PDF_CONVERTERS
    const job = (options: Record<string, unknown>) => ({ from: 'pdf', to: 'x', input: '/a.pdf', output: '/a.out', options })
    await expect(extract.run(job({ pages: '1; rm -rf /' }), run)).rejects.toThrow('Not extract options: pages: a page list is like 1-3,7')
    await expect(extract.run(job({ tables: 'yes' }), run)).rejects.toThrow('Not extract options')
    await expect(extract.run(job({ maxPages: 500 }), run)).rejects.toThrow('Not extract options')
    await expect(extract.run(job({ script: 'x' }), run)).rejects.toThrow('Not extract options')
    await expect(png.run(job({ width: 10_000 }), run)).rejects.toThrow('Not page picture options')
    await expect(png.run(job({ page: 0 }), run)).rejects.toThrow('Not page picture options')
    await expect(png.run(job({ crop: [0.5, 0.5, 0.2, 0.9] }), run)).rejects.toThrow('a region runs from its top left to its bottom right')
    await expect(png.run(job({ crop: [0, 0, 2, 1] }), run)).rejects.toThrow('Not page picture options')
    expect(ran).toEqual([])
  })

  it('passes the script\'s own sentence on when it refuses, and says it is not installed when it is not', async () => {
    const run = (code: number, out: string, bin: string | null = '/py') =>
      ({ tools: { bin: () => bin }, tmp: mkdtempSync(join(tmpdir(), 'tc-pdfx-')), run: async () => ({ code, out }) }) as unknown as ConvertRun
    const [extract, png] = PDF_CONVERTERS
    const job = { from: 'pdf', to: 'png', input: '/a.pdf', output: '/a.png' }
    await expect(png.run(job, run(3, 'Traceback\ntc-error: This PDF is encrypted, so it cannot be read here.\n'))).rejects.toThrow(/^This PDF is encrypted, so it cannot be read here\.$/)
    await expect(png.run(job, run(1, 'boom'))).rejects.toThrow('pdf-tools could not draw the file: boom')
    await expect(extract.run(job, run(0, '', null))).rejects.toThrow('pdf-tools is not installed here')
  })
})

/**
 * The real job, with the box's installed pdf-tools (pdfplumber, pypdfium2):
 * run with TEMP_CODE_WORK_TOOLS_DATA set to a userData the installer filled
 * (`/srv/agents/temp-code-data` on the box).
 */
const REAL = process.env.TEMP_CODE_WORK_TOOLS_DATA
const W9 = new Uint8Array(readFileSync(join(import.meta.dirname, 'fixtures/fw9.pdf')))
const P15 = join(import.meta.dirname, '../../../../../.temp-code/reports/hIIKbJY4UKbv/corpus/pdf/irs-p15-tables-excerpt.pdf')
const P15_MAIN = '/srv/agents/work/temp-code/.temp-code/reports/hIIKbJY4UKbv/corpus/pdf/irs-p15-tables-excerpt.pdf'
const p15 = existsSync(P15) ? P15 : existsSync(P15_MAIN) ? P15_MAIN : null
const P1 = 'topmostSubform[0].Page1[0].'
const TYPED = [
  { key: `${P1}f1_01[0]`, value: 'Ada Exampleton' },
  { key: `${P1}f1_02[0]`, value: 'Exampleton Consulting LLC' },
  { key: `${P1}Address_ReadOrder[0].f1_07[0]`, value: '123 Example Street' },
  { key: `${P1}Address_ReadOrder[0].f1_08[0]`, value: 'Springfield, IL 62701' },
  { key: `${P1}f1_11[0]`, value: '123' },
  { key: `${P1}f1_12[0]`, value: '45' },
  { key: `${P1}f1_13[0]`, value: '6789' }
]
const squash = (s: string): string => s.replace(/\s+/g, '')
const allText = (x: PdfExtract): string => squash([...x.blocks.map((b) => b.text), ...x.tables.flatMap((t) => t.rows.flat())].join(' '))
const pngSize = (b: Buffer): { width: number; height: number } => {
  expect(b.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) }
}
const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex')

describe.skipIf(!REAL)('the pdf-extract job, with the installed pdf-tools', () => {
  let dir: string
  let runner: JobRunner
  const file = (name: string, bytes: Uint8Array): string => {
    const p = join(dir, name)
    writeFileSync(p, bytes)
    return p
  }
  const extract = async (input: string, options: Record<string, unknown> = {}): Promise<PdfExtract> => {
    const done = await runner.convert({ from: 'pdf', to: 'extract', input, output: join(dir, `${Math.random().toString(36).slice(2)}.json`), options })
    return JSON.parse(readFileSync(done.output, 'utf8')) as PdfExtract
  }
  const picture = async (input: string, options: Record<string, unknown> = {}): Promise<Buffer> => {
    const done = await runner.convert({ from: 'pdf', to: 'png', input, output: join(dir, `${Math.random().toString(36).slice(2)}.png`), options })
    return readFileSync(done.output)
  }

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'tc-pdf-extract-'))
    runner = new JobRunner({ host: 'env_test', dataDir: REAL!, converters: convertersOf([{ id: 'pdf', ensure() {}, convert: PDF_CONVERTERS } as unknown as WorkModule]), log: () => {} })
  })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('the W-9 fills, flattens, and our extract gives the typed values back', async () => {
    const filled = await writePdf(W9, { values: TYPED, overlays: [], marks: [], flatten: false })
    const flat = await writePdf(W9, { values: TYPED, overlays: [], marks: [], flatten: true })
    expect(flat.warnings).toEqual([])
    const x = await extract(file('w9-flat.pdf', flat.bytes), { pages: '1' })
    expect(x.pages).toBe(6)
    expect(x.sizes).toEqual([{ page: 1, width: 611.976, height: 791.968 }])
    const text = allText(x)
    for (const { value } of TYPED) expect(text).toContain(squash(value))
    // Where a value is: the name sits in the name line's box, near the top of the page.
    const name = x.blocks.find((b) => b.text.includes('Ada Exampleton'))!
    expect(name.bbox[1]).toBeGreaterThan(0.14)
    expect(name.bbox[3]).toBeLessThan(0.17)
    // "Values set" is not "values shown": the unflattened file's page text has none of them.
    const unflat = allText(await extract(file('w9-filled.pdf', filled.bytes), { pages: '1' }))
    expect(unflat).toContain(squash('Request for Taxpayer'))
    for (const { value } of TYPED.slice(0, 4)) expect(unflat).not.toContain(squash(value))
  })

  it('a filled form\'s page picture shows its values: pdfium draws the fields once forms are up', async () => {
    const filled = file('w9-filled2.pdf', (await writePdf(W9, { values: TYPED, overlays: [], marks: [], flatten: false })).bytes)
    const blank = file('w9-blank.pdf', W9)
    const nameLine = [0.09, 0.14, 0.5, 0.17]
    const a = await picture(blank, { page: 1, width: 400, crop: nameLine })
    const b = await picture(filled, { page: 1, width: 400, crop: nameLine })
    expect(pngSize(b).width).toBe(400)
    expect(sha(a)).not.toBe(sha(b))
  })

  it('draws a page at the width asked, and a region of it at that width with the region\'s shape', async () => {
    const w9 = file('w9.pdf', W9)
    const page = pngSize(await picture(w9))
    expect(page.width).toBe(1280)
    expect(page.height).toBeCloseTo((1280 * 791.968) / 611.976, -1)
    const crop = pngSize(await picture(w9, { page: 1, width: 600, crop: [0, 0, 1, 0.25] }))
    expect(crop.width).toBe(600)
    expect(crop.height).toBeCloseTo((600 * 0.25 * 791.968) / 611.976, -1)
    await expect(picture(w9, { page: 9 })).rejects.toThrow('Page 9 is not in this file: it has 6 pages.')
  })

  it('reads the pages asked for, refuses one past the end, and keeps a long file to 40 pages with the cut said', async () => {
    const w9 = file('w9-2.pdf', W9)
    const two = await extract(w9, { pages: '2-3' })
    expect(two.sizes.map((s) => s.page)).toEqual([2, 3])
    expect(new Set(two.blocks.map((b) => b.page))).toEqual(new Set([2, 3]))
    await expect(extract(w9, { pages: '7' })).rejects.toThrow('Page 7 is not in this file: it has 6 pages.')
    const long = await PDFDocument.create()
    const font = await long.embedFont('Helvetica')
    for (let i = 1; i <= 45; i++) long.addPage([300, 300]).drawText(`Page text ${i}`, { x: 20, y: 250, size: 12, font })
    const x = await extract(file('long.pdf', await long.save()), { tables: false })
    expect(x.pages).toBe(45)
    expect(x.sizes).toHaveLength(40)
    expect(x.warnings).toEqual(['Read 40 of 45 pages (to page 40): ask for the rest with pages, like 41-45.'])
    expect(x.blocks[0]).toEqual({ page: 1, bbox: [expect.any(Number), expect.any(Number), expect.any(Number), expect.any(Number)], text: 'Page text 1' })
  })

  it('says a page with no text layer is a scan', async () => {
    const doc = await PDFDocument.create()
    // A 1×1 PNG drawn over the page: an image and no text, as a scan is.
    const img = await doc.embedPng(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'))
    doc.addPage([200, 200]).drawImage(img, { x: 0, y: 0, width: 200, height: 200 })
    const x = await extract(file('scan.pdf', await doc.save()))
    expect(x.blocks).toEqual([])
    expect(x.warnings).toEqual(['page 1 has no text layer: it is a scan'])
  })

  it('refuses a file that is not a PDF with a sentence', async () => {
    await expect(extract(file('nope.pdf', new TextEncoder().encode('not a pdf')))).rejects.toThrow('This file could not be read as a PDF')
  })

  it.skipIf(!p15)('reads the wage-base table of IRS Publication 15 cell by cell, and keeps its text out of the blocks', async () => {
    const x = await extract(p15!, { pages: '1' })
    const table = x.tables.find((t) => t.rows.some((r) => r[1] === '$176,100'))!
    expect(table).toBeDefined()
    expect(table.page).toBe(1)
    expect(table.rows.slice(1, 7)).toEqual([
      ['2025—social security', '$176,100', '12.4%'],
      ['2025—Medicare', 'All wages', '2.9%'],
      ['2024—social security', '$168,600', '12.4%'],
      ['2024—Medicare', 'All wages', '2.9%'],
      ['2023—social security', '$160,200', '12.4%*'],
      ['2023—Medicare', 'All wages', '2.9%']
    ])
    expect(table.bbox.map((n) => Math.round(n * 100) / 100)).toEqual([0.51, 0.59, 0.93, 0.81])
    expect(x.blocks.some((b) => b.text.includes('$176,100'))).toBe(false)
    // The two columns read as columns: the left one's paragraph is whole, not spliced with the right one's lines.
    const penalties = x.blocks.find((b) => b.text.startsWith('Penalties.'))!
    expect(penalties.bbox[2]).toBeLessThan(0.5)
    // A printer's line above the page box is not on the page.
    expect(x.blocks.some((b) => b.text.includes('Fileid'))).toBe(false)
    const md = extractMarkdown(x)
    expect(md).toContain('| 2025—social security | $176,100 | 12.4% |')
  })
})

describe.skipIf(!REAL)('labels read off the page, with the installed pdf-tools', () => {
  it('labels the W-9\'s fields, which carry no tooltips, from the words printed beside them', async () => {
    const { readForm, labelFields } = await import('./form')
    const dir = mkdtempSync(join(tmpdir(), 'tc-pdf-labels-'))
    try {
      const runner = new JobRunner({ host: 'env_test', dataDir: REAL!, converters: convertersOf([{ id: 'pdf', ensure() {}, convert: PDF_CONVERTERS } as unknown as WorkModule]), log: () => {} })
      const input = join(dir, 'fw9.pdf')
      writeFileSync(input, W9)
      const done = await runner.convert({ from: 'pdf', to: 'extract', input, output: join(dir, 'x.json'), options: { pages: '1', tables: false } })
      const x = JSON.parse(readFileSync(done.output, 'utf8')) as PdfExtract
      expect(x.tables).toEqual([])
      const fields = labelFields((await readForm(W9)).fields, x.blocks)
      const label = (short: string) => fields.find((f) => f.key.endsWith(short))!.label
      expect(label('f1_01[0]')).toMatch(/^1 Name of entity\/individual/)
      expect(label('f1_02[0]')).toMatch(/^2 Business name/)
      expect(label('f1_07[0]')).toMatch(/^5 Address/)
      expect(label('f1_08[0]')).toMatch(/^6 City, state, and ZIP code/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
