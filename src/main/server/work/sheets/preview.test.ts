import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PDFDocument } from 'pdf-lib'
import type { CanvasItem } from '@shared/work'
import type { ConvertJob, ConvertResult } from '../formats/jobs'
import type { WorkCtx } from '../modules'
import { sharedPreviews, sharedPreviewsRoot, type Sheets } from './held'
import { readText, readZip, writeZip } from './patch/zip'
import {
  dropSharedPreviewsOf,
  exportPreview,
  moreThan,
  sweepPreviewScratch,
  pageRangeFilter,
  previewsDir,
  previewSheet,
  PreviewStore,
  readDelimited,
  readSheetPreview,
  SHEET_PREVIEW_CONVERTERS,
  sheetFilePreviewer,
  textFilter,
  tsvToCsv,
  withoutBreaksUnderFit
} from './preview'

/**
 * Preview's renders (preview.ts) with a stand-in for the conversion runner:
 * the page range asked, "Draw all", the Fit-to rule, what a shared file
 * keeps and where, the 64 MiB cap of a forwarded draw, the read by range at
 * one rev. LibreOffice's own pages are held by preview.live.test.ts.
 */
/** Every path a write lands at while `on`: what a spy on the pillar's writes finds. */
const writes = vi.hoisted(() => ({ on: false, paths: [] as string[] }))
vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>()
  const seen = (path: unknown): void => void (writes.on && writes.paths.push(String(path)))
  const wrap =
    <A extends unknown[], R>(fn: (...a: A) => R, at: (a: A, r: R) => unknown) =>
    (...a: A): R => {
      const r = fn(...a)
      seen(at(a, r))
      return r
    }
  return {
    ...fs,
    writeFileSync: wrap(fs.writeFileSync as (...a: unknown[]) => void, (a) => a[0]),
    renameSync: wrap(fs.renameSync as (...a: unknown[]) => void, (a) => a[1]),
    copyFileSync: wrap(fs.copyFileSync as (...a: unknown[]) => void, (a) => a[1]),
    mkdirSync: wrap(fs.mkdirSync as (...a: unknown[]) => unknown, (a) => a[0]),
    mkdtempSync: wrap(fs.mkdtempSync as (...a: unknown[]) => string, (_a, r) => r)
  }
})
const { sheets } = await import('./index')

const CORPUS = join(import.meta.dirname, 'harness/corpus')
let dir: string
let jobs: (ConvertJob & { breaks: boolean; rows: boolean; cols: boolean })[]
/** what the stand-in's PDF of any workbook holds */
let total: number
/** a forwarded draw past this many pages comes back over the cap */
let cap: number

async function pdfOf(pages: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  for (let i = 0; i < pages; i++) doc.addPage([612, 792]).drawText(`page ${i + 1}`)
  return doc.save()
}

/** The manual breaks a workbook's sheet parts hold: across its rows, across its columns. */
const breaksIn = (path: string): { rows: boolean; cols: boolean } => {
  try {
    const z = readZip(new Uint8Array(readFileSync(path)))
    const sheets = z.entries.filter((e) => /worksheets\/sheet\d+\.xml$/.test(e.name)).map((e) => readText(z, e.name))
    return { rows: sheets.some((xml) => /<rowBreaks/.test(xml)), cols: sheets.some((xml) => /<colBreaks/.test(xml)) }
  } catch {
    return { rows: false, cols: false }
  }
}
const hasBreaks = (path: string): boolean => breaksIn(path).rows || breaksIn(path).cols

async function convert(job: ConvertJob): Promise<ConvertResult> {
  jobs.push({ ...job, breaks: hasBreaks(job.input), ...breaksIn(job.input) })
  const output = job.output!
  const filter = typeof job.options?.filter === 'string' ? job.options.filter : ''
  if (job.to === 'pdf') {
    const range = /"value":"(\d+)-(\d+)"/.exec(filter)
    const from = range ? Number(range[1]) : 1
    const to = range ? Math.min(Number(range[2]), total) : total
    const count = Math.max(0, to - from + 1)
    if (count > cap) throw new Error(`the pdf that came back is 80 MiB; a job carried from another host takes at most 64 MiB`)
    writeFileSync(output, await pdfOf(count))
  } else if (job.to === 'csv' || job.to === 'tsv') {
    const sep = job.to === 'csv' ? ',' : '\t'
    writeFileSync(output, `Item${sep}Cost\r\n"Hotel, two nights"${sep}240\r\nTaxi${sep}35\r\n`)
  } else if (job.to === 'html') writeFileSync(output, '<html><body><table><tr><td>Hotel</td></tr></table></body></html>')
  else if (job.to === 'png') writeFileSync(output, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  else copyFileSync(job.input, output)
  return { output, ranOn: 'env_test', warnings: [] }
}

const ctxOf = (): WorkCtx => ({ dataDir: dir, host: 'env_test', convert } as unknown as WorkCtx)
const sheetsOf = (): Sheets => ({ ctx: ctxOf(), packages: { open: async () => ({ rev: 3 }), fileAt: (p: string) => p } } as unknown as Sheets)
const itemOf = (path: string, host = 'env_test', id = 'item1'): CanvasItem => ({ id, sessionId: 'thread1', kind: 'sheet', title: 'Budget.xlsx', source: { at: 'file', host, path } }) as unknown as CanvasItem
const book = (name: string): string => {
  const path = join(dir, 'files', name.split('/').pop()!)
  copyFileSync(join(CORPUS, name), path)
  return path
}
/** Every file under the data folder, as paths inside it. */
const tree = (root = dir): string[] => (existsSync(root) ? readdirSync(root, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => relative(dir, join(e.parentPath, e.name))) : [])

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tc-sheet-preview-'))
  mkdirSync(join(dir, 'files'))
  jobs = []
  total = 3
  cap = Infinity
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('the page range', () => {
  it('draws the first 50 pages of a long workbook, and says more follow without a count it has not made', async () => {
    total = 120
    const got = await previewSheet(sheetsOf(), itemOf(book('formulas.xlsx')), { format: 'pdf' })
    // One page past the 50, to learn whether the whole goes on.
    expect(jobs.map((j) => j.options?.filter)).toEqual([pageRangeFilter(1, 51)])
    expect(got).toMatchObject({ kind: 'paged', pages: 50, drawnBy: 'libreoffice' })
    if (got.kind !== 'paged') throw new Error('paged')
    expect(got.shown?.from).toBe(1)
    expect(got.shown?.to).toBe(50)
    // One more than it holds: the frame's count is never a guess at the whole.
    expect(got.shown?.of).toBe(51)
    expect(got.drops).toContain('Prints on more than 50 pages')
    // The whole is said as not counted, and the line as no loss: the frame reads "of 50+" and says it over the first sheet.
    expect(got.uncounted).toBe(true)
    expect(got.notes).toEqual(['Prints on more than 50 pages'])
    expect(moreThan(1200)).toBe('Prints on more than 1,200 pages')
    const bytes = Buffer.from(readSheetPreview(ctxOf(), itemOf(book('formulas.xlsx')), { rev: got.rev, offset: 0, length: got.size }).data, 'base64')
    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(50)
  })

  it('draws every page on "Draw all", with no range and nothing shown in part', async () => {
    total = 120
    const got = await previewSheet(sheetsOf(), itemOf(book('formulas.xlsx')), { format: 'pdf', pages: [1, Number.MAX_SAFE_INTEGER] })
    expect(jobs.map((j) => j.options)).toEqual([undefined])
    expect(got).toMatchObject({ kind: 'paged', pages: 120 })
    expect('shown' in got && got.shown).toBeFalsy()
  })

  it('draws a short workbook whole, and asks again for nothing it keeps', async () => {
    const s = sheetsOf()
    const item = itemOf(book('formulas.xlsx'))
    const first = await previewSheet(s, item, { format: 'xlsx' })
    expect(first).toMatchObject({ kind: 'paged', pages: 3 })
    expect('shown' in first && first.shown).toBeFalsy()
    // Excel, PDF and Print are one render of one file.
    const again = await previewSheet(s, item, { format: 'pdf' })
    expect(again.kind === 'paged' && first.kind === 'paged' && again.rev === first.rev).toBe(true)
    expect(jobs).toHaveLength(1)
  })
})

/**
 * fit-width.xlsx fitted `wide` by `tall` pages (0: as many as it takes), with a manual break after row 19 and after
 * column 6: the probes Excel itself printed (harness/corpus/print/excel-truth.json "probes").
 */
function fitted(wide: number, tall: number): string {
  const z = readZip(new Uint8Array(readFileSync(join(CORPUS, 'print/fit-width.xlsx'))))
  const part = 'xl/worksheets/sheet1.xml'
  const xml = readText(z, part)
    .replace(/<pageSetup [^>]*\/>/, `<pageSetup paperSize="1" fitToWidth="${wide}" fitToHeight="${tall}" orientation="portrait"/>`)
    .replace(/<rowBreaks[\s\S]*<\/rowBreaks>/, '<rowBreaks count="1" manualBreakCount="1"><brk id="19" max="16383" man="1"/></rowBreaks><colBreaks count="1" manualBreakCount="1"><brk id="6" max="1048575" man="1"/></colBreaks>')
  const path = join(dir, 'files', `fit-${wide}x${tall}.xlsx`)
  writeFileSync(path, writeZip(z, new Map([[part, new TextEncoder().encode(xml)]]), new Set(), new Map()))
  return path
}

describe('the Fit-to rule', () => {
  // What Excel prints, measured in Excel (excel-truth.json): a manual break is ignored only along a side fitted to a
  // page count, and prints along a side left automatic.
  it.each([
    { wide: 1, tall: 1, rows: false, cols: false },
    { wide: 1, tall: 2, rows: false, cols: false },
    { wide: 1, tall: 0, rows: true, cols: false },
    { wide: 2, tall: 0, rows: true, cols: false },
    { wide: 0, tall: 1, rows: false, cols: true },
    { wide: 0, tall: 2, rows: false, cols: true }
  ])('draws a sheet fitted $wide by $tall with its manual breaks out along each fitted side alone', async ({ wide, tall, rows, cols }) => {
    const path = fitted(wide, tall)
    const before = readFileSync(path)
    expect(breaksIn(path)).toEqual({ rows: true, cols: true })
    await previewSheet(sheetsOf(), itemOf(path), { format: 'pdf' })
    expect(jobs.map((j) => ({ rows: j.rows, cols: j.cols }))).toEqual([{ rows, cols }])
    // The file keeps its own.
    expect(readFileSync(path).equals(before)).toBe(true)
  })

  it('leaves the row breaks of a sheet fitted one page wide by any tall: Excel prints them', async () => {
    for (const name of ['print/fit-width.xlsx', 'protect_print.xlsx']) {
      jobs = []
      const path = book(name)
      expect(withoutBreaksUnderFit(new Uint8Array(readFileSync(path)))).toBeNull()
      await previewSheet(sheetsOf(), itemOf(path), { format: 'pdf' })
      expect(jobs.map((j) => j.rows)).toEqual([true])
    }
  })

  it('leaves a sheet that is not fitted as it is: its breaks print', async () => {
    const path = book('print/manual-breaks.xlsx')
    expect(withoutBreaksUnderFit(new Uint8Array(readFileSync(path)))).toBeNull()
    await previewSheet(sheetsOf(), itemOf(path), { format: 'pdf' })
    expect(jobs.map((j) => j.breaks)).toEqual([true])
  })

  it('takes out only the breaks: every other part and the rest of the sheet stay', () => {
    const bytes = new Uint8Array(readFileSync(fitted(1, 1)))
    const out = withoutBreaksUnderFit(bytes)!
    const a = readZip(bytes)
    const b = readZip(out)
    expect(b.entries.map((e) => e.name)).toEqual(a.entries.map((e) => e.name))
    const sheet = a.entries.find((e) => /worksheets\/sheet1\.xml$/.test(e.name))!.name
    for (const e of a.entries) if (e.name !== sheet) expect(Buffer.from(readText(b, e.name)).equals(Buffer.from(readText(a, e.name)))).toBe(true)
    expect(readText(b, sheet)).toBe(readText(a, sheet).replace(/<rowBreaks\b[\s\S]*?<\/colBreaks>/, ''))
  })
})

describe('the formats', () => {
  it('draws OpenDocument and Excel 97-2003 from the exported file itself', async () => {
    for (const format of ['ods', 'xls'] as const) {
      jobs = []
      const got = await previewSheet(sheetsOf(), itemOf(book('tables.xlsx')), { format })
      expect(jobs.map((j) => `${j.from}→${j.to}`)).toEqual([`xlsx→${format}`, `${format}→pdf`])
      // The PDF is drawn from the file the first job wrote.
      expect(got.kind).toBe('paged')
    }
    const xls = await previewSheet(sheetsOf(), itemOf(book('tables.xlsx')), { format: 'xls' })
    // tables.xlsx looks a target up with XLOOKUP, which a .xls reads as #NAME?.
    expect(xls.drops).toEqual(['2 tables become plain ranges', '1 formula uses a function Excel 97-2003 does not have'])
  })

  it('draws CSV and TSV as one sheet\'s table, with the sheets to pick from', async () => {
    const item = itemOf(book('formulas.xlsx'))
    const csv = await previewSheet(sheetsOf(), item, { format: 'csv', sheet: 'Calc' })
    expect(jobs[0].options?.filter).toBe(textFilter(44, 2))
    expect(csv).toMatchObject({ kind: 'table', name: 'Calc', rows: [['Item', 'Cost'], ['Hotel, two nights', '240'], ['Taxi', '35']], sheets: ['Data', 'Calc', 'Dynamic', 'Q1', 'Q2', 'Q3'] })
    expect(csv.drops).toEqual(['5 other sheets stay behind', '149 formulas become their values'])
    const tsv = await previewSheet(sheetsOf(), item, { format: 'tsv' })
    expect(jobs[1]).toMatchObject({ from: 'xlsx', to: 'tsv', options: { filter: textFilter(9, 1) } })
    expect(tsv).toMatchObject({ kind: 'table', name: 'Data', rows: [['Item', 'Cost'], ['Hotel, two nights', '240'], ['Taxi', '35']] })
  })

  it('draws the web page as its HTML', async () => {
    const got = await previewSheet(sheetsOf(), itemOf(book('objects.xlsx')), { format: 'html' })
    expect(got).toMatchObject({ kind: 'html' })
    expect(got.kind === 'html' && got.html).toContain('Hotel')
    expect(got.drops).toContain('2 pictures stay behind')
  })

  it('exports the file as it stands; an opened Excel file is its own bytes', async () => {
    const path = book('formulas.xlsx')
    const out = await exportPreview(sheetsOf(), itemOf(path), { format: 'xlsx' })
    expect(out.name).toBe('Budget.xlsx')
    const read = Buffer.from(readSheetPreview(ctxOf(), itemOf(path), { rev: out.rev, offset: 0, length: out.size }).data, 'base64')
    expect(read.equals(readFileSync(path))).toBe(true)
    expect(jobs).toEqual([])
    const csv = await exportPreview(sheetsOf(), itemOf(path), { format: 'csv', sheet: 'Calc' })
    expect(csv.name).toBe('Budget - Calc.csv')
    const pdf = await exportPreview(sheetsOf(), itemOf(path), { format: 'pdf' })
    // The whole PDF: no range.
    expect(jobs.at(-1)?.options).toBeUndefined()
    expect(pdf.name).toBe('Budget.pdf')
  })

  it('refuses Office\'s own picture: no Excel is in reach yet', async () => {
    await expect(previewSheet(sheetsOf(), itemOf(book('formulas.xlsx')), { format: 'pdf', by: 'office' })).rejects.toThrow(/Excel/)
  })
})

describe('a file others can open', () => {
  const ctxOther = (): WorkCtx => ({ ...ctxOf(), canvas: { get: () => null } } as unknown as WorkCtx)

  it('writes only under its item\'s folder in Files\' preview scratch, goes with the item, and forwards nothing', async () => {
    total = 120
    const path = book('formulas.xlsx')
    const item = itemOf(path, 'env_other')
    writes.on = true
    writes.paths.length = 0
    try {
      const got = await previewSheet(sheetsOf(), item, { format: 'pdf' })
      await previewSheet(sheetsOf(), item, { format: 'ods' })
      await previewSheet(sheetsOf(), item, { format: 'csv' })
      await exportPreview(sheetsOf(), item, { format: 'xlsx' })
      // Every write the pillar made lies under the item's folder in the scratch both backups leave out.
      const home = sharedPreviews(dir, item.id)
      expect(writes.paths.length).toBeGreaterThan(0)
      expect(writes.paths.filter((p) => !(p === home || p.startsWith(`${home}/`) || home.startsWith(`${p}/`)))).toEqual([])
      // Every job is marked shared: the runner runs it here or fails, and never carries it to another host.
      expect(jobs.length).toBeGreaterThan(0)
      expect(jobs.every((j) => j.shared === true)).toBe(true)
      expect(existsSync(previewsDir(dir))).toBe(false)
      expect(readdirSync(join(dir, 'files'))).toEqual(['formulas.xlsx'])
      // The item removed: its folder goes at once, and a read of its render is refused.
      expect(got.kind === 'paged' && readSheetPreview(ctxOf(), item, { rev: got.rev, offset: 0, length: 10 }).data.length).toBeGreaterThan(0)
      sheets.itemsRemoved!([item], ctxOther())
      expect(existsSync(home)).toBe(false)
      // Nothing made of the workbook is left anywhere under the data folder: only the file itself.
      expect(tree().filter((f) => !f.startsWith('files/'))).toEqual([])
      expect(() => got.kind === 'paged' && readSheetPreview(ctxOf(), item, { rev: got.rev, offset: 0, length: 10 })).toThrow(/draw it again/)
    } finally {
      writes.on = false
    }
  })

  it('goes with a deleted thread: every shared item the thread held, and no other thread\'s', async () => {
    const path = book('formulas.xlsx')
    const mine = [itemOf(path, 'env_other', 'item1'), itemOf(path, 'env_other', 'item2')]
    const other = { ...itemOf(path, 'env_other', 'item3'), sessionId: 'thread2' } as CanvasItem
    const drawn: Awaited<ReturnType<typeof previewSheet>>[] = []
    for (const item of [...mine, other]) drawn.push(await previewSheet(sheetsOf(), item, { format: 'pdf' }))
    // The frame tells a pillar a deleted thread, not its items.
    dropSharedPreviewsOf(dir, ['thread1'])
    expect(readdirSync(sharedPreviewsRoot(dir))).toEqual(['item3'])
    for (const [i, item] of mine.entries()) expect(() => drawn[i].kind === 'paged' && readSheetPreview(ctxOf(), item, { rev: drawn[i].rev, offset: 0, length: 4 })).toThrow(/draw it again/)
    expect(drawn[2].kind === 'paged' && readSheetPreview(ctxOf(), other, { rev: drawn[2].rev, offset: 0, length: 4 }).data.length).toBeGreaterThan(0)
    dropSharedPreviewsOf(dir, ['thread2', 'never-seen'])
    expect(readdirSync(sharedPreviewsRoot(dir))).toEqual([])
  })

  it('draws again when Files clears its scratch under a draw, or between two', async () => {
    const path = book('formulas.xlsx')
    const item = itemOf(path, 'env_other')
    const first = await previewSheet(sheetsOf(), item, { format: 'pdf' })
    rmSync(sharedPreviewsRoot(dir), { recursive: true, force: true })
    expect(() => first.kind === 'paged' && readSheetPreview(ctxOf(), item, { rev: first.rev, offset: 0, length: 10 })).toThrow(/draw it again/)
    // Gone between the PDF's making and its keeping: the draw is made once more, from the start.
    let once = true
    const ctx = { ...ctxOf(), convert: async (job: ConvertJob) => {
      const got = await convert(job)
      if (once) {
        once = false
        rmSync(sharedPreviewsRoot(dir), { recursive: true, force: true })
      }
      return got
    } } as unknown as WorkCtx
    const again = await previewSheet({ ...sheetsOf(), ctx } as Sheets, item, { format: 'pdf' })
    expect(again.kind === 'paged' && readSheetPreview(ctxOf(), item, { rev: again.rev, offset: 0, length: 4 }).data).toBe(Buffer.from('%PDF').toString('base64'))
  })

  it('never draws fewer pages to fit a forward: a shared file is drawn here or not at all', async () => {
    total = 120
    cap = 10
    await expect(previewSheet(sheetsOf(), itemOf(book('formulas.xlsx'), 'env_other'), { format: 'pdf' })).rejects.toThrow(/takes at most/)
    expect(jobs).toHaveLength(1)
  })

  it('draws a Files picture of a shared file under the preview scratch alone, and leaves nothing', async () => {
    const path = book('formulas.xlsx')
    writes.on = true
    writes.paths.length = 0
    try {
      const shared = await sheetFilePreviewer(ctxOf())({ at: 'file', host: 'env_other', path }, { page: 1, width: 800 })
      expect(shared).toEqual(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))
      const root = sharedPreviewsRoot(dir)
      expect(writes.paths.filter((p) => !(p.startsWith(`${root}/`) || root.startsWith(`${p}/`) || p === root))).toEqual([])
    } finally {
      writes.on = false
    }
    expect(tree().filter((f) => !f.startsWith('files/'))).toEqual([])
    expect(jobs.every((j) => j.shared === true && j.here === true)).toBe(true)
    expect(jobs.map((j) => `${j.from}→${j.to}`)).toEqual(['xlsx→pdf', 'pdf→png'])
    expect(jobs[0].options?.filter).toBe(pageRangeFilter(1, 2))
  })

  it('leaves a thumbnail to Files\' own sources: no LibreOffice for a tile', async () => {
    const path = book('formulas.xlsx')
    for (const width of [192, 288, 416]) expect(await sheetFilePreviewer(ctxOf())({ at: 'file', host: 'env_test', path }, { page: 1, width })).toBeNull()
    expect(jobs).toEqual([])
    // His own file's page picture is kept with his own renders, out of the backups.
    expect(await sheetFilePreviewer(ctxOf())({ at: 'file', host: 'env_test', path }, { page: 1, width: 1024 })).not.toBeNull()
    expect(tree().filter((f) => !f.startsWith('files/')).every((f) => f.startsWith('work-files/previews/sheets/'))).toBe(true)
  })
})

describe('a draw carried to another host', () => {
  it('draws fewer pages when the PDF would pass 64 MiB, and says so', async () => {
    total = 120
    cap = 12
    const got = await previewSheet(sheetsOf(), itemOf(book('formulas.xlsx')), { format: 'pdf' })
    expect(jobs.map((j) => j.options?.filter)).toEqual([pageRangeFilter(1, 51), pageRangeFilter(1, 25), pageRangeFilter(1, 12)])
    expect(got).toMatchObject({ kind: 'paged', pages: 12 })
    expect(got.kind === 'paged' && got.shown?.to).toBe(12)
    expect(got.drops).toContain('Drawn on another computer: only the first 12 pages could be sent')
  })
})

describe('the read by range', () => {
  it('reads one render at its rev, and refuses a rev no longer kept or another sheet\'s', async () => {
    const item = itemOf(book('formulas.xlsx'))
    const got = await previewSheet(sheetsOf(), item, { format: 'pdf' })
    if (got.kind !== 'paged') throw new Error('paged')
    const head = Buffer.from(readSheetPreview(ctxOf(), item, { rev: got.rev, offset: 0, length: 4 }).data, 'base64')
    expect(head.toString('latin1')).toBe('%PDF')
    const tail = Buffer.from(readSheetPreview(ctxOf(), item, { rev: got.rev, offset: got.size - 1, length: 10 }).data, 'base64')
    expect(tail.length).toBe(1)
    // Another sheet's item names its own file: this render is not its to read.
    const other = itemOf(book('tables.xlsx'), 'env_test', 'item2')
    expect(() => readSheetPreview(ctxOf(), other, { rev: got.rev, offset: 0, length: 4 })).toThrow(/draw it again/)
    expect(() => readSheetPreview(ctxOf(), item, { rev: 'f'.repeat(32), offset: 0, length: 4 })).toThrow(/draw it again/)
  })

  it('keeps renders bounded by count and bytes, the least used out first', () => {
    const store = new PreviewStore(join(dir, 'store'), { count: 2, bytes: 1000 })
    const put = (rev: string, bytes: number): void => {
      const f = join(dir, `${rev}.tmp`)
      writeFileSync(f, Buffer.alloc(bytes))
      store.put({ rev, ext: 'pdf', key: 'k', size: bytes }, f)
    }
    const revs = ['a', 'b', 'c', 'd'].map((c) => c.repeat(32))
    put(revs[0], 10)
    put(revs[1], 10)
    put(revs[2], 10)
    expect(store.get(revs[0])).toBeNull()
    expect(store.get(revs[1])).not.toBeNull()
    put(revs[3], 995)
    // Past the bytes: the oldest goes, the one just made stays.
    expect(store.get(revs[3])).not.toBeNull()
    expect(readdirSync(join(dir, 'store')).filter((f) => f.endsWith('.json'))).toHaveLength(1)
    expect(statSync(store.fileOf({ rev: revs[3], ext: 'pdf' })).size).toBe(995)
  })
})

describe('what a crash leaves', () => {
  it('is swept at the module\'s start: a call\'s scratch goes, the kept renders stay', async () => {
    const got = await previewSheet(sheetsOf(), itemOf(book('formulas.xlsx')), { format: 'pdf' })
    mkdirSync(join(previewsDir(dir), '.scratch-left'), { recursive: true })
    writeFileSync(join(previewsDir(dir), '.scratch-left', 'half.pdf'), 'x')
    sweepPreviewScratch(dir)
    expect(readdirSync(previewsDir(dir)).filter((f) => f.startsWith('.'))).toEqual([])
    expect(got.kind === 'paged' && readSheetPreview(ctxOf(), itemOf(book('formulas.xlsx')), { rev: got.rev, offset: 0, length: 4 }).data.length).toBeGreaterThan(0)
  })

  it('leaves no scratch behind a workbook that could not be read', async () => {
    const s = { ...sheetsOf(), packages: { open: async () => Promise.reject(new Error('The file is gone')) } } as unknown as Sheets
    for (const host of ['env_test', 'env_other']) await expect(previewSheet(s, itemOf(book('formulas.xlsx'), host), { format: 'pdf' })).rejects.toThrow('The file is gone')
    expect(tree().filter((f) => !f.startsWith('files/'))).toEqual([])
    expect([previewsDir(dir), sharedPreviews(dir, 'item1')].flatMap((d) => readdirSync(d))).toEqual([])
  })
})

describe('the pairs this pillar registers', () => {
  it('adds what the toolchain lacks, each on LibreOffice', () => {
    const pairs = SHEET_PREVIEW_CONVERTERS.map((c) => `${c.from}→${c.to}`)
    for (const pair of ['xlsm→pdf', 'xlsx→html', 'xlsx→tsv', 'tsv→xlsx']) expect(pairs).toContain(pair)
    expect(SHEET_PREVIEW_CONVERTERS.every((c) => c.needs === 'libreoffice')).toBe(true)
    expect(new Set(pairs).size).toBe(pairs.length)
  })

  it('reads a TSV as the CSV it becomes, and a CSV or TSV line as RFC 4180 reads it', () => {
    expect(tsvToCsv('Item\tCost\nHotel, two nights\t240\n')).toBe('Item,Cost\r\n"Hotel, two nights",240\r\n')
    expect(readDelimited('a,"b,""c"""\r\n1,2\n', ',', 10)).toEqual([['a', 'b,"c"'], ['1', '2']])
    expect(readDelimited('a\tb\n1\t2\n3\t4', '\t', 2)).toEqual([['a', 'b'], ['1', '2']])
  })

  it('writes the filters LibreOffice takes: a page range, a sheet by its place', () => {
    expect(pageRangeFilter(1, 50)).toBe('calc_pdf_Export:{"PageRange":{"type":"string","value":"1-50"}}')
    expect(textFilter(9, 3)).toBe('Text - txt - csv (StarCalc):9,34,76,1,,0,false,true,true,false,false,3')
    expect(sharedPreviews('/d', 'item1')).toBe('/d/work-files/preview-scratch/sheets/previews/item1')
    expect(previewsDir('/d')).toBe('/d/work-files/previews/sheets')
    expect(() => sharedPreviews('/d', '../x')).toThrow()
  })
})
