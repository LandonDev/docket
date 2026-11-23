import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DOMParser } from '@xmldom/xmldom'
import type { ITableJson } from '@univerjs/sheets-table'
import { headlessSheet } from 'work-kit/sheet/engine'
import { importXlsx, RESOURCE_NAMES } from 'work-kit/sheet/xlsx'
import { expect, test } from 'vitest'
import { patchSheet, type Edit } from './sheet'
import { defaultColumn, fileReferences, SML } from './tables-model'
import {
  cellReferences,
  patchTables,
  readTables,
  TablesRefused,
  type TableModel,
  type TablesEdit
} from './tables'
import { readText, readZip, writeZip, type Entry, type Zip } from './zip'

const FILE = 'xl/worksheets/sheet1.xml'
const REPORT = 'xl/worksheets/sheet2.xml'
const RELS = 'xl/worksheets/_rels/sheet1.xml.rels'
const BOOK = 'xl/workbook.xml'
const BOOK_RELS = 'xl/_rels/workbook.xml.rels'
const CT = '[Content_Types].xml'
const TABLE = (n: number) => `xl/tables/table${n}.xml`
const fixture = (name: string) =>
  new Uint8Array(readFileSync(join(__dirname, '../harness/corpus', name)))
const base = fixture('patch/base.xlsx')
const corpus = fixture('tables.xlsx')
const xml = (bytes: Uint8Array, part = FILE) => readText(readZip(bytes), part)
const enc = new TextEncoder()
const models = (bytes: Uint8Array, name: string) => readTables(bytes, name).sheets[name].tables
const sales = () => models(corpus, 'Sales')
const range = (startRow: number, startColumn: number, endRow: number, endColumn: number) => ({
  startRow,
  startColumn,
  endRow,
  endColumn
})
const model = (name: string, area = range(1, 1, 8, 1)): TableModel => ({
  id: 'new-' + name,
  name,
  range: area,
  options: {},
  columns: [],
  meta: {},
  filters: {}
})
const edit = (tables: TableModel[], sheet = 'Data'): TablesEdit => ({
  kind: 'tables',
  sheet,
  tables
})
const add = (opts: Record<string, string>) =>
  new Map(Object.entries(opts).map(([key, value]) => [key, enc.encode(value)]))
function parts(
  bytes: Uint8Array,
  changes: Record<string, string>,
  added: Record<string, string> = {}
) {
  return writeZip(readZip(bytes), add(changes), new Set(), add(added))
}
const setCells = (bytes: Uint8Array, edits: Edit[], sheet = FILE) =>
  parts(bytes, { [sheet]: patchSheet(xml(bytes, sheet), edits, { strings: 'inline' }).xml })
const text = (row: number, col: number, value: string): Edit => ({
  row,
  col,
  write: { kind: 'text', value }
})

function localRecord(z: Zip, entry: Entry): Buffer {
  const view = new DataView(z.buf.buffer, z.buf.byteOffset, z.buf.byteLength)
  const at = entry.localOffset
  let end = at + 30 + view.getUint16(at + 26, true) + view.getUint16(at + 28, true) + entry.compSize
  if (entry.flags & 8) end += view.getUint32(end, true) === 0x08074b50 ? 16 : 12
  return Buffer.from(z.buf.subarray(at, end))
}

function root(bytes: Uint8Array, part: string) {
  return new DOMParser().parseFromString(xml(bytes, part), 'application/xml').documentElement!
}
const childNames = (el: ReturnType<typeof root>) =>
  Array.from(el.childNodes).flatMap((n) => (n.nodeType === 1 ? [(n as typeof el).localName ?? n.nodeName] : []))
const find = (el: ReturnType<typeof root>, name: string) =>
  Array.from(el.getElementsByTagNameNS(SML, name))

function checked(
  input: Uint8Array,
  edits: TablesEdit[],
  expected: { changed?: string[]; added?: string[]; removed?: string[] } = {},
  proof?: string
) {
  const { bytes, report } = patchTables(input, edits)
  const { changed = [], added = [], removed = [] } = expected
  expect(report.partsChanged.toSorted()).toEqual(changed.toSorted())
  expect(report.partsAdded.toSorted()).toEqual(added.toSorted())
  expect(report.partsRemoved.toSorted()).toEqual(removed.toSorted())
  const before = readZip(input),
    after = readZip(bytes)
  expect([...after.byName.keys()].toSorted()).toEqual(
    [...before.byName.keys()]
      .filter((part) => !removed.includes(part))
      .concat(added)
      .toSorted()
  )
  for (const entry of before.entries) {
    if (removed.includes(entry.name)) continue
    expect(
      localRecord(before, entry).equals(localRecord(after, after.byName.get(entry.name)!)),
      entry.name
    ).toBe(!changed.includes(entry.name))
  }
  if (!changed.length && !added.length && !removed.length) expect(bytes).toBe(input)
  for (const part of [...changed, ...added]) {
    if (/^xl\/tables\/.*\.xml$/.test(part)) {
      const element = root(bytes, part)
      const columns = find(element, 'tableColumns')[0]
      expect(Number(columns.getAttribute('count'))).toBe(find(columns, 'tableColumn').length)
      const order = ['autoFilter', 'sortState', 'tableColumns', 'tableStyleInfo', 'extLst']
      const actual = childNames(element).map((name) => order.indexOf(name))
      expect(actual).toEqual(actual.toSorted())
      expect(actual).not.toContain(-1)
    } else if (/^xl\/worksheets\/sheet\d+\.xml$/.test(part)) {
      const element = root(bytes, part)
      const tableParts = find(element, 'tableParts')[0]
      if (tableParts) {
        expect(Number(tableParts.getAttribute('count'))).toBe(find(tableParts, 'tablePart').length)
        const names = childNames(element)
        expect(names.indexOf('tableParts')).toBeGreaterThan(names.indexOf('sheetData'))
        if (names.includes('extLst')) expect(names.at(-2)).toBe('tableParts')
      }
    }
  }
  if (proof && process.env.TABLES_PROOF_DIR) {
    mkdirSync(process.env.TABLES_PROOF_DIR, { recursive: true })
    writeFileSync(join(process.env.TABLES_PROOF_DIR, proof + '.xlsx'), bytes)
    writeFileSync(
      join(process.env.TABLES_PROOF_DIR, proof + '.json'),
      JSON.stringify(
        {
          description: proof,
          edits,
          report,
          tables: readTables(bytes).sheets
        },
        null,
        2
      ) + '\n'
    )
  }
  return bytes
}

function imported(bytes: Uint8Array, id = 'sheet1'): ITableJson[] {
  const resource = importXlsx(bytes).workbook.resources?.find(
    (r) => r.name === RESOURCE_NAMES.tables
  )
  const tables: ITableJson[] = resource ? (JSON.parse(resource.data)[id]?.tables ?? []) : []
  // The kit's importer keeps Excel's switches and totals a second time under `meta.excel`, for the grid; the table itself is the same.
  return tables.map((table) => ({ ...table, meta: {} }))
}

function importerProjection(tables: TableModel[]): ITableJson[] {
  return tables.map((table) => ({
    ...table,
    columns: table.columns.map(
      ({ totalsRowFormula: _total, formulaIsArray: _array, ...column }) =>
        Object.fromEntries(
          Object.entries(column).filter(([, value]) => value !== undefined)
        ) as unknown as ITableJson['columns'][number]
    )
  }))
}

test('reads the corpus tables in Univer shape and preserves all original part bytes', () => {
  const tabs = readTables(corpus, undefined, { sheetIds: ['grid-sales', 'grid-report'] }).sheets
  expect(Object.keys(tabs)).toEqual(['Sales', 'Report'])
  expect(tabs.Sales.id).toBe('grid-sales')
  expect(tabs.Report.tables).toEqual([])
  expect(importerProjection(tabs.Sales.tables)).toEqual(imported(corpus))
  expect(tabs.Sales.tables[0].options).toMatchObject({
    tableStyleId: 'TableStyleMedium2',
    showRowStripes: true
  })
  checked(corpus, [edit(imported(corpus), 'Sales'), edit([], 'Report')])
  checked(corpus, [edit(tabs.Sales.tables, 'Sales')])
  expect(() => readTables(corpus, 'Missing')).toThrow(/No worksheet named/)
  expect(() => patchTables(corpus, [edit([], 'Report')], { sheetIds: ['one'] })).toThrow(
    TablesRefused
  )
})

test('adds the first table, relationship and override while taking the shared header cell verbatim', () => {
  const edits = [edit([model('Fresh')])]
  const bytes = checked(
    base,
    edits,
    { changed: [FILE, CT], added: [RELS, TABLE(1)] },
    'first-table'
  )
  const [table] = models(bytes, 'Data')
  expect(table.columns[0].displayName).toBe('keep')
  expect(table.id).toBe('table1')
  expect(table.columns[0].id).toBe('col1')
  expect(xml(bytes)).toContain('<c r="B2" t="s"><v>0</v></c>')
  expect(xml(bytes, TABLE(1))).toContain('<autoFilter ref="B2:B9"/>')
  expect(xml(bytes, RELS)).toContain('Target="../tables/table1.xml"')
  expect(xml(bytes, CT)).toContain('PartName="/xl/tables/table1.xml"')
  expect(imported(bytes)).toEqual(importerProjection([table]))
  checked(bytes, edits)
  checked(bytes, [edit(imported(bytes))])
})

test('adds beside existing tables with fresh package, relationship, table and column IDs', () => {
  const newTable = model('Supplement', range(11, 10, 17, 11))
  const bytes = checked(
    corpus,
    [edit([...sales(), newTable], 'Sales')],
    { changed: [FILE, CT, RELS], added: [TABLE(3)] },
    'added-beside-tables'
  )
  const tables = models(bytes, 'Sales')
  expect(tables.map((table) => table.id)).toEqual(['table1', 'table2', 'table3'])
  expect(tables[2].columns.map((column) => column.id)).toEqual(['col6', 'col7'])
  expect(xml(bytes, RELS)).toContain('Id="rId3"')
  expect(imported(bytes)).toEqual(importerProjection(tables))
})

test('normalizes a blank and repeating header in the cells and in tableColumns', () => {
  const source = setCells(base, [
    text(2, 2, 'Repeat'),
    { row: 2, col: 3, write: { kind: 'clear' } },
    text(2, 4, 'repeat')
  ])
  const bytes = checked(
    source,
    [edit([model('FixedHeaders', range(1, 1, 8, 3))])],
    { changed: [CT, FILE], added: [RELS, TABLE(1)] },
    'repaired-headers'
  )
  expect(models(bytes, 'Data')[0].columns.map(({ displayName }) => displayName)).toEqual([
    'Repeat',
    'Column2',
    'repeat2'
  ])
  const grid = importXlsx(bytes).workbook.sheets.sheet1.cellData
  expect([1, 2, 3].map((col) => grid?.[1]?.[col]?.v)).toEqual(['Repeat', 'Column2', 'repeat2'])
  expect(xml(bytes)).toContain('<c r="D2" t="inlineStr"><is><t>repeat2</t></is></c>')
})

test('writes a total label, SUBTOTAL, calculated column cells and a full recalculation mark', () => {
  const seeded = setCells(base, [text(2, 5, 'Qty'), text(2, 6, 'Amount')])
  const chain = 'xl/calcChain.xml'
  const source = parts(
    seeded,
    {
      [BOOK]: xml(seeded, BOOK).replace('fullCalcOnLoad="1"', 'fullCalcOnLoad="0"'),
      [BOOK_RELS]: xml(seeded, BOOK_RELS).replace(
        '</Relationships>',
        '<Relationship Id="rId99" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/calcChain" Target="calcChain.xml"/></Relationships>'
      ),
      [CT]: xml(seeded, CT).replace(
        '</Types>',
        '<Override PartName="/xl/calcChain.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.calcChain+xml"/></Types>'
      )
    },
    { [chain]: `<calcChain xmlns="${SML}"><c r="C2" i="1"/></calcChain>` }
  )
  const table = model('Totals', range(1, 4, 5, 5))
  table.options.showFooter = true
  table.columns = [
    { ...defaultColumn(0), totalsRowLabel: 'Total' },
    { ...defaultColumn(1), totalsRowFunction: 'sum', formula: '=[@Qty]*2+A3' }
  ]
  const bytes = checked(
    source,
    [edit([table])],
    { changed: [CT, FILE, BOOK, BOOK_RELS], added: [RELS, TABLE(1)], removed: [chain] },
    'total-row'
  )
  expect(xml(bytes, TABLE(1))).toContain('<autoFilter ref="E2:F5"/>')
  // Excel removes a table whose calculated column says [@Qty], and reads [@Qty] in a cell as #REF!.
  expect(xml(bytes, TABLE(1))).toContain(
    'calculatedColumnFormula>Totals[[#This Row],[Qty]]*2+A3<'
  )
  expect(xml(bytes)).toContain('<c r="F4"><f>Totals[[#This Row],[Qty]]*2+A4</f></c>')
  expect(xml(bytes)).toContain('<c r="F6"><f>SUBTOTAL(109,Totals[Amount])</f></c>')
  expect(xml(bytes)).not.toContain('@')
  expect(xml(bytes)).toContain('<c r="E6" t="inlineStr"><is><t>Total</t></is></c>')
  expect(xml(bytes, BOOK)).toContain('fullCalcOnLoad="1"')
  expect(imported(bytes)).toEqual(importerProjection(models(bytes, 'Data')))
  // The same table said again in the words a person types changes nothing.
  const [typed] = models(bytes, 'Data')
  expect(typed.columns[1].formula).toBe('=Totals[[#This Row],[Qty]]*2+A3')
  typed.columns[1].formula = '=[@Qty]*2+A3'
  expect(patchTables(bytes, [edit([typed])]).bytes).toBe(bytes)
  const [next] = models(bytes, 'Data')
  next.options.showFooter = false
  const removed = checked(
    bytes,
    [edit([next])],
    { changed: [FILE, TABLE(1)] },
    'total-row-disabled'
  )
  expect(xml(removed)).not.toContain('SUBTOTAL')
  // The row was shown once: no totalsRowShown="0", and the columns keep what the row said.
  expect(xml(removed, TABLE(1))).not.toMatch(/totalsRowShown|totalsRowCount/)
  expect(xml(removed, TABLE(1))).toContain('name="Qty" totalsRowLabel="Total"')
  expect(xml(removed, TABLE(1))).toContain('totalsRowFunction="sum"')
  expect(xml(removed)).toContain('<c r="F6"><f>Totals[[#This Row],[Qty]]*2+A6</f></c>')
})

test('says a table formula in the words Excel keeps in a file', () => {
  const table = { own: 'Totals', tables: new Set(['totals', 'sales']) }
  const said = (formula: string) => fileReferences(formula, table)
  expect(said('[@Qty]*2')).toBe('Totals[[#This Row],[Qty]]*2')
  expect(said("[@[Unit '[kg']]]+SUM([@])")).toBe(
    "Totals[[#This Row],[Unit '[kg']]]+SUM(Totals[#This Row])"
  )
  expect(said('SUM([@[Jan]:[Mar]])+[ @Qty ]')).toBe(
    'SUM(Totals[[#This Row],[Jan]:[Mar]])+Totals[[#This Row],[Qty]]'
  )
  expect(said('Sales[@Units]+SUM([Amount])')).toBe(
    'Sales[[#This Row],[Units]]+SUM(Totals[Amount])'
  )
  expect(said('ROWS(Sales)+ROWS(totals)')).toBe('ROWS(Sales[])+ROWS(totals[])')
  // Excel's own files drop the mark a person types before an @ inside a name.
  expect(said("[@[x'@y]]+SUM(Sales[x'@y],['@home])")).toBe(
    "Totals[[#This Row],[x@y]]+SUM(Sales[x@y],Totals['@home])"
  )
  for (const kept of [
    'Sales[[#This Row],[Units]]*2',
    'SUM(Sales[Units],Sales[#All])',
    '"[@Qty] and Sales"&A1',
    'LET(Sales,1,Sales+1)',
    'Sheet1!Sales+[1]Sheet1!A1',
    'SUM([Book.xlsx]Sheet1!A:A)',
    '@Sales[Units]',
    'Other+SALES(1)'
  ])
    expect(said(kept), kept).toBe(kept)
})

test('says a cell formula by the table the cell sits in, and leaves a workbook with no table alone', () => {
  const said = cellReferences(corpus)
  // F5 is in Sales (B2:F32), I4 in Targets (H2:I6), L9 in no table; Report has none.
  expect(said('Sales', 5, 6, '[@Units]*2+ROWS(Targets)')).toBe(
    'Sales[[#This Row],[Units]]*2+ROWS(Targets[])'
  )
  expect(said('Sales', 4, 9, 'SUM([Target])-[@Target]')).toBe(
    'SUM(Targets[Target])-Targets[[#This Row],[Target]]'
  )
  expect(said('Sales', 9, 12, 'ROWS(Sales)+SUM(Sales[Units])+[@Units]')).toBe(
    'ROWS(Sales[])+SUM(Sales[Units])+[@Units]'
  )
  expect(said('Report', 1, 2, 'SUM(sales)*2')).toBe('SUM(sales[])*2')
  expect(cellReferences(base)('Data', 2, 3, 'A2*2+[@Qty]')).toBe('A2*2+[@Qty]')
})

test('names a column with brackets, quotes and signs as Excel does, under its own table', () => {
  const heads = ['Units [kg]', "It's", '#Items', 'a,b', 'x@y', 'Calc']
  const seeded = setCells(base, [
    ...heads.map((head, i) => text(31, 1 + i, head)),
    ...[32, 33].flatMap((row) =>
      [1, 2, 3, 4, 5].map((col): Edit => ({ row, col, write: { kind: 'number', value: row * col } }))
    )
  ])
  const table = model('Special', range(30, 0, 33, 5))
  table.options.showFooter = true
  table.columns = heads.map((head, i) => ({
    ...defaultColumn(i, head),
    ...(i === 0 ? { totalsRowLabel: 'Sum' } : { totalsRowFunction: 'sum' }),
    ...(i === 5 ? { formula: "=[@[Units '[kg']]]+[@[x'@y]]+SUM([a,b])" } : {})
  }))
  const bytes = checked(
    seeded,
    [edit([table])],
    { changed: [CT, FILE], added: [RELS, TABLE(1)] },
    'special-headers'
  )
  const sheet = xml(bytes)
  for (const ref of ["[It''s]", "['#Items]", '[a,b]', '[x@y]', '[Calc]'])
    expect(sheet).toContain(`<f>SUBTOTAL(109,Special${ref})</f>`)
  const calc = "Special[[#This Row],[Units '[kg']]]+Special[[#This Row],[x@y]]+SUM(Special[a,b])"
  expect(sheet).toContain(`<c r="F32"><f>${calc}</f></c>`)
  expect(xml(bytes, TABLE(1))).toContain(`<calculatedColumnFormula>${calc}</`)
  expect(models(bytes, 'Data')[0].columns.map((column) => column.displayName)).toEqual(heads)
  expect(patchTables(bytes, [edit(models(bytes, 'Data'))]).bytes).toBe(bytes)
  const [typed] = models(bytes, 'Data')
  typed.columns[5].formula = table.columns[5].formula
  expect(patchTables(bytes, [edit([typed])]).bytes).toBe(bytes)
})

test('knows the totals Excel saved under the table name, and clears them with the total row', () => {
  // Excel's own copy of a file says SUBTOTAL(109,Sales[Units]) where the corpus says SUBTOTAL(109,[Units]).
  const saved = parts(corpus, { [FILE]: xml(corpus).replace(/SUBTOTAL\((\d+),\[/g, 'SUBTOTAL($1,Sales[') })
  expect(xml(saved)).toContain('<f>SUBTOTAL(109,Sales[Units])</f>')
  const styled = models(saved, 'Sales')
  styled[0].options.tableStyleId = 'TableStyleLight1'
  checked(saved, [edit(styled, 'Sales')], { changed: [TABLE(1)] })
  const off = models(saved, 'Sales')
  Object.assign(off[0].options, { showFooter: false, hasTotalRow: false })
  off[0].range.endRow--
  const bytes = checked(
    saved,
    [edit(off, 'Sales')],
    { changed: [TABLE(1), FILE] },
    'excel-totals-off'
  )
  expect(xml(bytes)).not.toContain('SUBTOTAL')
  expect(xml(bytes)).not.toMatch(/<c r="B32"[^>]*>[^<]*<(v|is)/)
  expect(xml(bytes, TABLE(1))).toContain('ref="B2:F31"')
})

test('writes built-in style and banding options by changing only the selected table part', () => {
  const tables = sales()
  Object.assign(tables[1].options, {
    tableStyleId: 'table-default-0',
    showFirstColumn: true,
    showLastColumn: true,
    showRowStripes: false,
    showColumnStripes: true
  })
  const bytes = checked(corpus, [edit(tables, 'Sales')], { changed: [TABLE(2)] }, 'styled-table')
  expect(models(bytes, 'Sales')[1].options).toMatchObject({
    tableStyleId: 'TableStyleMedium2',
    showFirstColumn: true,
    showLastColumn: true,
    showRowStripes: false,
    showColumnStripes: true
  })
  expect(imported(bytes)).toEqual(importerProjection(models(bytes, 'Sales')))
})

test('renames a table and updates structured references in names, worksheet and table formulas', () => {
  const source = parts(corpus, {
    [BOOK]: xml(corpus, BOOK).replace(
      '<calcPr',
      '<definedNames><definedName name="UnitsAll">Sales[Units]</definedName></definedNames><calcPr'
    )
  })
  const tables = sales()
  tables[0].name = 'SalesArchive'
  const bytes = checked(
    source,
    [edit(tables, 'Sales')],
    { changed: [TABLE(1), FILE, REPORT, BOOK] },
    'renamed-table'
  )
  expect(xml(bytes, TABLE(1))).toContain('name="SalesArchive" displayName="SalesArchive"')
  expect(xml(bytes, TABLE(1))).toContain('SalesArchive[[#This Row],[Units]]')
  expect(xml(bytes, REPORT)).toContain('SUM(SalesArchive[Units])*2')
  expect(xml(bytes, BOOK)).toContain('>SalesArchive[Units]</definedName>')
  // The corpus says ROWS(Sales): Excel reads a bare table name in a file as #NAME?, so the rename mends it.
  expect(xml(bytes)).toContain('<f>ROWS(SalesArchive[])</f>')
  expect(readTables(bytes, 'Sales').sheets.Sales.tables[0].id).toBe('table1')
  const renameCase = models(bytes, 'Sales')
  renameCase[0].name = 'SALESARCHIVE'
  const caseOnly = checked(bytes, [edit(renameCase, 'Sales')], {
    changed: [TABLE(1), FILE, REPORT, BOOK]
  })
  expect(xml(caseOnly, REPORT)).toContain('SUM(SALESARCHIVE[Units])*2')
  expect(xml(caseOnly)).toContain('<f>ROWS(SALESARCHIVE[])</f>')
})

test('grows rows and columns, then shrinks while keeping the surviving column IDs', () => {
  const tables = sales()
  tables[1].range = range(1, 7, 8, 9)
  const bytes = checked(
    corpus,
    [edit(tables, 'Sales')],
    { changed: [FILE, TABLE(2)] },
    'grown-table'
  )
  const next = models(bytes, 'Sales')
  expect(next[1].columns.map(({ id }) => id)).toEqual(['col1', 'col2', 'col6'])
  expect(next[1].range).toEqual(range(1, 7, 8, 9))
  next[1].range = range(1, 7, 4, 8)
  next[1].columns.pop()
  const shrunk = checked(bytes, [edit(next, 'Sales')], { changed: [TABLE(2)] }, 'shrunk-table')
  expect(xml(shrunk)).toBe(xml(bytes))
  expect(models(shrunk, 'Sales')[1].columns.map(({ id }) => id)).toEqual(['col1', 'col2'])
})

test('turns the header and filter off and on, keeping the worksheet cells intact', () => {
  const [a, b] = sales()
  a.options.showHeader = false
  const bytes = checked(corpus, [edit([a, b], 'Sales')], { changed: [TABLE(1)] }, 'header-disabled')
  expect(xml(bytes, TABLE(1))).toContain('headerRowCount="0"')
  expect(xml(bytes, TABLE(1))).not.toContain('autoFilter')
  expect(models(bytes, 'Sales')[0].options.showHeader).toBe(false)
  // Use the original model to re-enable the header and its AutoFilter.
  const back = checked(bytes, [edit(sales(), 'Sales')], { changed: [TABLE(1)] })
  expect(models(back, 'Sales')[0].options).toMatchObject({ showHeader: true, showAutoFilter: true })
})

test('removes one table, and removes the last relationship part for a table-only sheet', () => {
  const source = setCells(corpus, [{ row: 6, col: 12, write: { kind: 'clear' } }])
  const bytes = checked(
    source,
    [edit([sales()[0]], 'Sales')],
    { changed: [CT, FILE, RELS], removed: [TABLE(2)] },
    'removed-table'
  )
  expect(imported(bytes).map(({ name }) => name)).toEqual(['Sales'])
  expect(xml(bytes, CT)).not.toContain('PartName="/xl/tables/table2.xml"')
  expect(xml(bytes).match(/<sheetData>.*?<\/sheetData>/s)?.[0]).toBe(
    xml(source).match(/<sheetData>.*?<\/sheetData>/s)?.[0]
  )
  const added = patchTables(base, [edit([model('Transient')])]).bytes
  const last = checked(
    added,
    [edit([])],
    { changed: [CT, FILE], removed: [TABLE(1), RELS] },
    'removed-last-table'
  )
  expect(xml(last)).not.toContain('tableParts')
  expect(models(last, 'Data')).toEqual([])
})

test('refuses to remove a table named by an outside formula or by a defined name', () => {
  const clearedSaleReference = setCells(
    corpus,
    [2, 3, 4, 5, 7, 8].map((row) => ({ row, col: 12, write: { kind: 'clear' } }))
  )
  expect(() => patchTables(clearedSaleReference, [edit([sales()[1]], 'Sales')])).toThrow(
    /“Report” refers to table “Sales”/
  )
  expect(() => patchTables(corpus, [edit([sales()[0]], 'Sales')])).toThrow(
    /“Sales” refers to table “Targets”/
  )
  const source = parts(corpus, {
    [BOOK]: xml(corpus, BOOK).replace(
      '<calcPr',
      '<definedNames><definedName name="TargetsAll">Targets[Target]</definedName></definedNames><calcPr'
    )
  })
  expect(() => patchTables(source, [edit([sales()[0]], 'Sales')])).toThrow(
    /“TargetsAll” refers to table “Targets”/
  )
  const quoted = setCells(corpus, [
    { row: 6, col: 12, write: { kind: 'formula', file: 'IF(TRUE,"Targets[Target]","")' } }
  ])
  checked(quoted, [edit([sales()[0]], 'Sales')], { changed: [CT, FILE, RELS], removed: [TABLE(2)] })
})

test('refuses overlaps with merges, worksheet filters, pivots and other tables', () => {
  const merged = parts(base, {
    [FILE]: xml(base).replace(
      '</sheetData>',
      '</sheetData><mergeCells count="1"><mergeCell ref="B3:C3"/></mergeCells>'
    )
  })
  expect(() => patchTables(merged, [edit([model('Merged')])])).toThrow(/overlaps merged cells/)
  expect(() => patchTables(fixture('patch/filter.xlsx'), [edit([model('Filtered')])])).toThrow(
    /overlaps worksheet filter/
  )
  expect(() =>
    patchTables(fixture('pivot.xlsx'), [edit([model('PivotArea', range(5, 0, 11, 6))], 'Pivot')])
  ).toThrow(/overlaps pivot table/)
  expect(() => patchTables(base, [edit([model('OneTable'), model('OtherTable')])])).toThrow(
    /overlap on/
  )
})

test('refuses protected sheets, invalid names, duplicate names and an excessive list', () => {
  expect(() =>
    patchTables(fixture('protect_print.xlsx'), [edit([model('Protected')], 'Report')])
  ).toThrow(/Unprotect the sheet in Excel/)
  for (const name of [
    'A1',
    'R1C1',
    'XFD1048576',
    'Spaces here',
    '1st',
    'Existing',
    'a'.repeat(256)
  ])
    expect(() => patchTables(base, [edit([model(name)])]), name).toThrow(TablesRefused)
  expect(() => patchTables(corpus, [edit([model('sAlEs', range(0, 3, 3, 3))], 'Report')])).toThrow(
    /already names another table/
  )
  expect(() => patchTables(base, [edit(Array(1025).fill(model('TooMany')))])).toThrow(
    /at most 1024 tables/
  )
  expect(() => patchTables(base, [edit([model('BadHeader', range(1, 2, 4, 2))])])).toThrow(
    /header C2 must be text/
  )
})

test('prefixes and other relationship records survive table additions and removals', () => {
  const initialRels =
    '<p:Relationships xmlns:p="http://schemas.openxmlformats.org/package/2006/relationships"><p:Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.test/" TargetMode="External"/></p:Relationships>'
  const source = parts(
    base,
    {
      [FILE]: xml(base)
        .replace(/(<\/?)(\w+)(?=[\s/>])/g, '$1m:$2')
        .replace(`xmlns="${SML}"`, `xmlns:m="${SML}"`)
    },
    { [RELS]: initialRels }
  )
  const bytes = checked(source, [edit([model('Prefixed')])], {
    changed: [CT, FILE, RELS],
    added: [TABLE(1)]
  })
  expect(xml(bytes)).toContain('<m:tableParts')
  expect(xml(bytes, RELS)).toContain('<p:Relationship Id="rId2"')
  const removed = checked(bytes, [edit([])], { changed: [CT, FILE, RELS], removed: [TABLE(1)] })
  expect(xml(removed, RELS)).toBe(initialRels)
})

test('preserves native table filter criteria and existing total formulas on a style-only edit', () => {
  const filter =
    '<autoFilter ref="B2:F31"><filterColumn colId="0"><filters><filter val="North"/></filters></filterColumn></autoFilter>'
  const source = parts(corpus, {
    [TABLE(1)]: xml(corpus, TABLE(1)).replace('<autoFilter ref="B2:F31"/>', filter),
    [FILE]: xml(corpus).replace('SUBTOTAL(109,[Units])', 'SUBTOTAL(109,Sales[Units])')
  })
  const tables = models(source, 'Sales')
  tables[0].options.tableStyleId = 'TableStyleDark4'
  const bytes = checked(source, [edit(tables, 'Sales')], { changed: [TABLE(1)] })
  expect(xml(bytes, TABLE(1))).toContain(filter)
  expect(xml(bytes)).toContain('SUBTOTAL(109,Sales[Units])')
  const grown = models(bytes, 'Sales')
  grown[0].range.endColumn++
  expect(() => patchTables(bytes, [edit(grown, 'Sales')])).toThrow(/Resize the filtered table/)
})

test('refuses a column shrink that would leave a structured reference dangling', () => {
  const tables = sales()
  tables[1].range.endColumn--
  tables[1].columns.pop()
  expect(() => patchTables(corpus, [edit(tables, 'Sales')])).toThrow(
    /refers to table column Targets\[target\]/
  )
})

test('one patch allocates workbook-wide IDs for tables on different tabs', () => {
  const secondRel = 'xl/worksheets/_rels/sheet2.xml.rels'
  const bytes = checked(
    base,
    [edit([model('OneTable')]), edit([model('SecondTable', range(0, 1, 2, 1))], 'Untouched')],
    { changed: [CT, FILE, REPORT], added: [TABLE(1), RELS, TABLE(2), secondRel] }
  )
  const tabs = readTables(bytes).sheets
  expect(tabs.Data.tables[0].id).toBe('table1')
  expect(tabs.Untouched.tables[0].id).toBe('table2')
  expect(tabs.Untouched.tables[0].columns[0].id).toBe('col2')
  expect(imported(bytes, 'sheet2')).toEqual(importerProjection(tabs.Untouched.tables))
})

test('bounds calculated column writes and refuses malformed total options', () => {
  const wide = model('Tall', range(1, 1, 250_003, 1))
  wide.columns = [{ ...defaultColumn(0), formula: '=A1' }]
  expect(() => patchTables(base, [edit([wide])])).toThrow(/250,000 cell writes/)
  const invalid = model('InvalidTotal')
  invalid.columns = [{ ...defaultColumn(0), totalsRowFunction: 'not-an-excel-function' }]
  expect(() => patchTables(base, [edit([invalid])])).toThrow(/not an Excel table total function/)
})

test('accepts a table made by the installed Univer add-table command', async () => {
  const workbook = importXlsx(base).workbook
  const engine = headlessSheet('univer', workbook, { rules: true })
  try {
    expect(
      await engine.api.executeCommand('sheet.command.add-table', {
        unitId: workbook.id,
        subUnitId: 'sheet1',
        id: 'univer-command-table',
        name: 'LiveTable',
        range: range(1, 1, 8, 1),
        options: { showHeader: true, showFooter: false, showAutoFilter: true }
      })
    ).toBe(true)
    await engine.settled()
    const payload = engine.workbook.save().resources!.find((r) => r.name === RESOURCE_NAMES.tables)
    const tables: ITableJson[] = JSON.parse(payload!.data).sheet1.tables
    expect(tables).toHaveLength(1)
    expect(tables[0].id).toBe('univer-command-table')
    const bytes = checked(
      base,
      [edit(tables)],
      { changed: [CT, FILE], added: [RELS, TABLE(1)] },
      'univer-command'
    )
    expect(imported(bytes)).toEqual(importerProjection(models(bytes, 'Data')))
    expect(models(bytes, 'Data')[0].name).toBe('LiveTable')
    checked(bytes, [edit(tables)])
  } finally {
    engine.dispose()
  }
})
