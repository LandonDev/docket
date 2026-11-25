import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { importXlsx } from 'work-kit/sheet/xlsx'
import { reorderSheets } from './format-book'
import { patchFormat, type FormatEdit } from './format'
import { readText, readZip, writeZip } from './zip'

// A sheet's layout written into an opened Excel file by the patch writer: rows and columns hidden and shown, a frozen
// pane, the tabs' order. Each is read back by the importer, as the grid reads the file.

const base = new Uint8Array(readFileSync(join(__dirname, '../harness/corpus/patch/base.xlsx')))
const SHEET = 'xl/worksheets/sheet1.xml'
const read = (bytes: Uint8Array) => importXlsx(bytes).workbook
const data = (bytes: Uint8Array) => {
  const wb = read(bytes)
  return wb.sheets[wb.sheetOrder.find((id) => wb.sheets[id]!.name === 'Data')!]!
}
const patched = (edits: FormatEdit[], bytes = base) => patchFormat(bytes, edits).bytes

test('rows hidden, rows that hold nothing among them, and shown again', () => {
  const bytes = patched([{ kind: 'rowHidden', sheet: 'Data', from: 2, to: 40, hidden: true }])
  const rows = data(bytes).rowData ?? {}
  // the rows the file had and the ones made for it alike
  for (const r of [2, 3, 20, 40]) expect(rows[r]?.hd, `row ${r + 1}`).toBe(1)
  expect(rows[1]?.hd).toBeUndefined()
  expect(rows[41]?.hd).toBeUndefined()
  // the cells in a hidden row are what they were
  expect(data(bytes).cellData?.[2]).toEqual(data(base).cellData?.[2])
  const shown = patched([{ kind: 'rowHidden', sheet: 'Data', from: 3, to: 3, hidden: false }], bytes)
  expect(data(shown).rowData?.[3]?.hd).toBeUndefined()
  expect(data(shown).rowData?.[2]?.hd).toBe(1)
})

test('columns hidden and shown again, their widths kept', () => {
  const bytes = patched([{ kind: 'colWidth', sheet: 'Data', from: 1, to: 1, width: 20 }, { kind: 'colHidden', sheet: 'Data', from: 1, to: 2, hidden: true }])
  const cols = data(bytes).columnData ?? {}
  expect([cols[1]?.hd, cols[2]?.hd, cols[3]?.hd]).toEqual([1, 1, undefined])
  const shown = patched([{ kind: 'colHidden', sheet: 'Data', from: 2, to: 2, hidden: false }], bytes)
  expect([data(shown).columnData?.[1]?.hd, data(shown).columnData?.[2]?.hd]).toEqual([1, undefined])
  // the width he set stays under the hiding
  expect(readText(readZip(shown), SHEET)).toMatch(/<col min="2" max="2" width="20" customWidth="1" hidden="1"\/>/)
})

test('a frozen pane written into the first window, replaced, and taken away', () => {
  // base.xlsx's window is one empty tag: the pane goes in as its first child
  const both = patched([{ kind: 'freeze', sheet: 'Data', rows: 1, columns: 2 }])
  expect(readText(readZip(both), SHEET)).toContain('<sheetView tabSelected="1" workbookViewId="0"><pane xSplit="2" ySplit="1" topLeftCell="C2" activePane="bottomRight" state="frozen"/></sheetView>')
  expect(data(both).freeze).toMatchObject({ xSplit: 2, ySplit: 1, startRow: 1, startColumn: 2 })
  // a selection that names a pane goes with the pane it names
  const withSelection = readText(readZip(both), SHEET).replace('state="frozen"/>', 'state="frozen"/><selection pane="bottomRight" activeCell="D5" sqref="D5"/><selection activeCell="A1" sqref="A1"/>')
  const zip = readZip(both)
  const selected = writeZip(zip, new Map([[SHEET, new TextEncoder().encode(withSelection)]]), new Set(), new Map())
  const top = patched([{ kind: 'freeze', sheet: 'Data', rows: 3, columns: 0 }], selected)
  const view = readText(readZip(top), SHEET).match(/<sheetView\s[^>]*>.*?<\/sheetView>/)![0]
  expect(view).toBe('<sheetView tabSelected="1" workbookViewId="0"><pane ySplit="3" topLeftCell="A4" activePane="bottomLeft" state="frozen"/><selection activeCell="A1" sqref="A1"/></sheetView>')
  expect(data(top).freeze).toMatchObject({ xSplit: 0, ySplit: 3, startRow: 3, startColumn: -1 })
  const none = patched([{ kind: 'freeze', sheet: 'Data', rows: 0, columns: 0 }], top)
  expect(readText(readZip(none), SHEET)).not.toContain('<pane')
  expect(data(none).freeze ?? null).toBeNull()
})

test('the tabs in a new order, read back in it', () => {
  const bytes = patched([{ kind: 'sheetOrder', sheet: 'Untouched', to: 0 }])
  const wb = read(bytes)
  expect(wb.sheetOrder.map((id) => wb.sheets[id]!.name)).toEqual(['Untouched', 'Data'])
  // the same place again changes no part
  expect(patchFormat(bytes, [{ kind: 'sheetOrder', sheet: 'Untouched', to: 0 }]).report.partsChanged).toEqual([])
})

test('a name kept to one sheet, the tab in hand and the first tab shown follow their sheets; a chartsheet keeps its place', () => {
  const xml =
    '<workbook xmlns="s"><bookViews><workbookView activeTab="2" firstSheet="1"/></bookViews><sheets>' +
    '<sheet name="A" sheetId="1" r:id="rId1"/><sheet name="Chart" sheetId="2" r:id="rId2"/><sheet name="B" sheetId="3" r:id="rId3"/><sheet name="C &amp; D" sheetId="4" r:id="rId4"/>' +
    '</sheets><definedNames><definedName name="_xlnm.Print_Area" localSheetId="3">\'C &amp; D\'!$A$1:$B$2</definedName><definedName name="Rate" localSheetId="0">A!$B$1</definedName><definedName name="All">A!$A$1</definedName></definedNames></workbook>'
  // "C & D" to the worksheets' first place: the chartsheet (the second <sheet>) stays second
  const out = reorderSheets(xml, '', [{ sheet: 'C & D', to: 0 }], (i) => i !== 1)
  expect([...out.matchAll(/<sheet name="([^"]+)"/g)].map((m) => m[1])).toEqual(['C &amp; D', 'Chart', 'A', 'B'])
  // each sheet's id and part go with it
  expect(out).toContain('<sheet name="C &amp; D" sheetId="4" r:id="rId4"/>')
  expect(out).toContain('<definedName name="_xlnm.Print_Area" localSheetId="0">')
  expect(out).toContain('<definedName name="Rate" localSheetId="2">')
  expect(out).toContain('<definedName name="All">')
  expect(out).toContain('<workbookView activeTab="3" firstSheet="1"/>')
  expect(() => reorderSheets(xml, '', [{ sheet: 'Chart', to: 0 }], (i) => i !== 1)).toThrow('No worksheet named “Chart”')
})

test('a protected sheet still freezes (the window is the reader\'s); hiding needs its format rows and columns allowed', () => {
  const zip = readZip(base)
  // sheetProtection in its place, after sheetData
  const locked = readText(zip, SHEET).replace('</sheetData>', '</sheetData><sheetProtection sheet="1"/>')
  expect(locked).toContain('<sheetProtection')
  const bytes = writeZip(zip, new Map([[SHEET, new TextEncoder().encode(locked)]]), new Set(), new Map())
  expect(data(patched([{ kind: 'freeze', sheet: 'Data', rows: 1, columns: 0 }], bytes)).freeze).toMatchObject({ ySplit: 1 })
  expect(() => patched([{ kind: 'rowHidden', sheet: 'Data', from: 1, to: 1, hidden: true }], bytes)).toThrow('protected')
})
