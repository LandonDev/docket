import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { importXlsx } from 'work-kit/sheet/xlsx'
import { readEntry, readZip, writeZip, type Entry, type Zip } from '../patch/zip'

/**
 * The fixtures the editors plan's sheets lab measured with (sheets-measure.md sections 2 to 4),
 * kept with what was read back from them. Unlike roundtrip.test.ts this runs everywhere: it needs
 * no LibreOffice and no Python. It holds what the plan's patch decision rests on: a part-local
 * patch through the production zip writer changes the parts it names and keeps every other entry
 * byte for byte.
 */
const CORPUS = join(__dirname, 'corpus')
const PATCHES = ['style', 'layout', 'cf', 'validation', 'name', 'filter', 'page', 'page-fixed', 'combined'] as const
/** The parts each patch changes, of the base workbook's 11. */
const CHANGED: Record<(typeof PATCHES)[number], string[]> = {
  style: ['xl/worksheets/sheet1.xml', 'xl/styles.xml'],
  layout: ['xl/worksheets/sheet1.xml'],
  cf: ['xl/worksheets/sheet1.xml', 'xl/styles.xml'],
  validation: ['xl/worksheets/sheet1.xml'],
  name: ['xl/workbook.xml'],
  filter: ['xl/worksheets/sheet1.xml'],
  page: ['xl/worksheets/sheet1.xml', 'xl/workbook.xml'],
  'page-fixed': ['xl/worksheets/sheet1.xml', 'xl/workbook.xml'],
  combined: ['xl/worksheets/sheet1.xml', 'xl/styles.xml', 'xl/workbook.xml']
}

const bytesOf = (file: string): Uint8Array => new Uint8Array(readFileSync(join(CORPUS, file)))
/** An entry's whole local record: header, name, extra field, compressed bytes, data descriptor. */
function localRecord(z: Zip, e: Entry): Buffer {
  const v = new DataView(z.buf.buffer, z.buf.byteOffset, z.buf.byteLength)
  let end = e.localOffset + 30 + v.getUint16(e.localOffset + 26, true) + v.getUint16(e.localOffset + 28, true) + e.compSize
  if (e.flags & 8) end += v.getUint32(end, true) === 0x08074b50 ? 16 : 12
  return Buffer.from(z.buf.subarray(e.localOffset, end))
}

describe('the nine part-local patches', () => {
  const base = readZip(bytesOf('patch/base.xlsx'))

  test('the base workbook has 11 entries', () => {
    expect(base.entries).toHaveLength(11)
  })

  for (const name of PATCHES) {
    test(`${name}: the zip writer changes ${CHANGED[name].length} of 11 entries and keeps the rest byte for byte`, () => {
      const parts = JSON.parse(readFileSync(join(CORPUS, `patch/${name}.parts.json`), 'utf8')) as Record<string, string>
      expect(Object.keys(parts).sort()).toEqual([...CHANGED[name]].sort())
      const replace = new Map(Object.entries(parts).map(([part, xml]) => [part, new Uint8Array(Buffer.from(xml))]))
      const out = readZip(writeZip(base, replace, new Set(), new Map()))
      expect([...out.byName.keys()]).toEqual([...base.byName.keys()])
      const kept = readZip(bytesOf(`patch/${name}.xlsx`))
      for (const e of base.entries) {
        const now = out.byName.get(e.name)!
        if (replace.has(e.name)) expect(Buffer.from(readEntry(out, e.name)).equals(Buffer.from(replace.get(e.name)!)), e.name).toBe(true)
        else expect(localRecord(out, now).equals(localRecord(base, e)), e.name).toBe(true)
        // and it is the workbook the lab measured, part for part
        expect(Buffer.from(readEntry(out, e.name)).equals(Buffer.from(readEntry(kept, e.name))), `${e.name} as kept`).toBe(true)
      }
    })
  }

  test('each patched workbook opens in the grid, with both sheets and the cell the patch left alone', () => {
    for (const name of ['base', ...PATCHES]) {
      const { workbook } = importXlsx(bytesOf(`patch/${name}.xlsx`))
      const sheets = workbook.sheetOrder.map((id) => workbook.sheets[id]!)
      expect(sheets.map((s) => s.name), name).toEqual(['Data', 'Untouched'])
      expect(sheets[0]!.cellData?.[1]?.[1]?.v, name).toBe('keep')
      expect(sheets[0]!.cellData?.[1]?.[2]?.f, name).toBe('=A2*2')
    }
  })

  test('what was read back from each is kept beside it', () => {
    const expected = JSON.parse(readFileSync(join(CORPUS, 'patch/expect.json'), 'utf8')) as { variants: Record<string, { style: unknown[]; names: string[]; filter: string | null }> }
    expect(Object.keys(expected.variants).sort()).toEqual(['base', ...PATCHES].sort())
    expect(expected.variants.base!.style[0]).toBe(false)
    expect(expected.variants.style!.style).toEqual([true, 'FFFFDD66', '0.000" kg"', 'thin'])
    expect(expected.variants.name!.names).toEqual(['Existing', 'Inputs'])
    expect(expected.variants.filter!.filter).toBe('A1:D28')
  })
})

describe('the ten print cases', () => {
  interface Page {
    size: [number, number]
    rows: string
    cols: string
  }
  interface Case {
    file: string
    libreoffice: Page[]
    excelRules: Page[]
    libreofficeRules: Page[]
    match: Record<string, [number, number]>
  }
  const expected = JSON.parse(readFileSync(join(CORPUS, 'print/expect.json'), 'utf8')) as { totals: Record<string, [number, number]>; cases: Record<string, Case> }

  test('ten workbooks, each on disk and opening in the grid', () => {
    expect(Object.keys(expected.cases)).toHaveLength(10)
    for (const [name, c] of Object.entries(expected.cases)) {
      expect(existsSync(join(CORPUS, c.file)), name).toBe(true)
      expect(importXlsx(bytesOf(c.file)).workbook.sheetOrder.length, name).toBeGreaterThan(0)
    }
  })

  test("the lab's figures: Excel's rules matched LibreOffice on 25 of 33 pages, LibreOffice's own on 32 of 34", () => {
    const sum = (key: string): [number, number] => Object.values(expected.cases).reduce<[number, number]>((t, c) => [t[0] + c.match[key]![0], t[1] + c.match[key]![1]], [0, 0])
    expect(sum('excelRules-libreoffice')).toEqual([25, 33])
    expect(sum('libreofficeRules-libreoffice')).toEqual([32, 34])
    expect(sum('excelRules-onlyoffice')).toEqual([6, 35])
    expect(expected.totals).toEqual({ 'excelRules-libreoffice': [25, 33], 'libreofficeRules-libreoffice': [32, 34], 'excelRules-onlyoffice': [6, 35] })
  })

  test('what is exact is kept: manual breaks at 100%, a print area, repeated titles, a fixed scale', () => {
    const rows = (name: string): string[] => expected.cases[name]!.libreoffice.map((p) => `${p.cols}:${p.rows}`)
    // down first: A:C at each row break, then D:H
    expect(rows('manual-breaks')).toEqual(['1-3:1-13', '1-3:14-31', '1-3:32-46', '4-8:1-13', '4-8:14-31', '4-8:32-46'])
    // the print area C2:J38 alone, on one page
    expect(rows('chart-print')).toEqual(['3-10:2-38'])
    // rows 1 and 2 and column A again on every page, across first
    expect(rows('titles')).toEqual(['1-4:1-47', '1,5-6:1-47', '1-4:1-2,48-81', '1,5-6:1-2,48-81'])
    expect(rows('scale-70')).toEqual(['1-9:1-67', '1-9:68-98'])
    // a manual break LibreOffice applies under Fit to, which Excel ignores
    expect(rows('fit-width')).toEqual(['1-12:1-19', '1-12:20-86'])
    expect(expected.cases['fit-width']!.excelRules.map((p) => p.rows)).toEqual(['1-64', '65-86'])
  })
})
