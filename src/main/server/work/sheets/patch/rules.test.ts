import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DOMParser } from '@xmldom/xmldom'
import type { IRange, IStyleData, ISheetDataValidationRule } from '@univerjs/core'
import { DataValidationOperator, RANGE_TYPE } from '@univerjs/core'
import type { IConditionFormattingRule } from '@univerjs/sheets-conditional-formatting'
import type { IAutoFilter } from '@univerjs/sheets-filter'
import { importXlsx, RESOURCE_NAMES } from 'work-kit/sheet/xlsx'
import { describe, expect, test } from 'vitest'
import {
  patchRules,
  readRules,
  type ConditionalRule,
  type ValidationRule,
  RulesRefused,
  type DefinedName,
  type RulesEdit,
  type SheetFilter
} from './rules'
import { readEntry, readText, readZip, writeZip, type Entry, type Zip } from './zip'

const corpus = join(__dirname, '../harness/corpus')
const SHEET = 'xl/worksheets/sheet1.xml'
const STYLES = 'xl/styles.xml'
const BOOK = 'xl/workbook.xml'
const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const SHEET_ORDER = (
  'sheetPr dimension sheetViews sheetFormatPr cols sheetData sheetCalcPr sheetProtection ' +
  'protectedRanges scenarios autoFilter sortState dataConsolidate customSheetViews mergeCells ' +
  'phoneticPr conditionalFormatting dataValidations hyperlinks printOptions pageMargins pageSetup ' +
  'headerFooter rowBreaks colBreaks customProperties cellWatches ignoredErrors smartTags drawing ' +
  'legacyDrawing legacyDrawingHF picture oleObjects controls webPublishItems tableParts extLst'
).split(' ')
const STYLE_ORDER =
  'numFmts fonts fills borders cellStyleXfs cellXfs cellStyles dxfs tableStyles colors extLst'.split(
    ' '
  )
const BOOK_ORDER =
  'fileVersion fileSharing workbookPr workbookProtection bookViews sheets functionGroups externalReferences definedNames calcPr oleSize customWorkbookViews pivotCaches pivotTableParts smartTagPr smartTagTypes webPublishing fileRecoveryPr webPublishObjects extLst'.split(
    ' '
  )

const file = (name: string) => new Uint8Array(readFileSync(join(corpus, name)))
const base = file('patch/base.xlsx')
const xml = (bytes: Uint8Array, part = SHEET) => readText(readZip(bytes), part)
const range = (row: number, col: number, endRow = row, endCol = col): IRange => ({
  startRow: row,
  startColumn: col,
  endRow,
  endColumn: endCol
})

const cf = (rules: readonly ConditionalRule[], sheet = 'Data'): RulesEdit => ({
  kind: 'conditional',
  sheet,
  rules
})
const dv = (rules: readonly ValidationRule[], sheet = 'Data'): RulesEdit => ({
  kind: 'validation',
  sheet,
  rules
})
const filt = (filter: SheetFilter | null, sheet = 'Data'): RulesEdit => ({
  kind: 'filter',
  sheet,
  filter
})
const namesEdit = (names: readonly DefinedName[] | Record<string, DefinedName>): RulesEdit => ({
  kind: 'names',
  names
})

function replaceParts(bytes: Uint8Array, parts: Record<string, (prior: string) => string>) {
  const zip = readZip(bytes)
  const replace = new Map(
    Object.entries(parts).map(([name, fn]) => [
      name,
      new TextEncoder().encode(fn(readText(zip, name)))
    ])
  )
  return writeZip(zip, replace, new Set(), new Map())
}

/** A local ZIP record includes the compressed payload and any data descriptor. */
function localRecord(z: Zip, entry: Entry): Buffer {
  const v = new DataView(z.buf.buffer, z.buf.byteOffset, z.buf.byteLength)
  const at = entry.localOffset
  let end = at + 30 + v.getUint16(at + 26, true) + v.getUint16(at + 28, true) + entry.compSize
  if (entry.flags & 8) end += v.getUint32(end, true) === 0x08074b50 ? 16 : 12
  return Buffer.from(z.buf.subarray(at, end))
}

function document(bytes: Uint8Array, part = SHEET) {
  return new DOMParser().parseFromString(xml(bytes, part), 'application/xml').documentElement!
}
const childNodes = (root: ReturnType<typeof document>) =>
  Array.from(root.childNodes).filter((child) => child.nodeType === 1) as Array<
    ReturnType<typeof document>
  >

function checkOrder(bytes: Uint8Array, part: string, order: string[]) {
  const root = document(bytes, part)
  const nodes = childNodes(root).filter((child) => child.namespaceURI === NS)
  const ranks = nodes.map((child) => order.indexOf(child.localName!))
  expect(ranks.every((rank) => rank !== -1)).toBe(true)
  expect(ranks).toEqual([...ranks].sort((a, b) => a - b))
  for (const node of nodes) {
    if (!['dxfs', 'dataValidations'].includes(node.localName!) || !node.hasAttribute('count'))
      continue
    expect(Number(node.getAttribute('count'))).toBe(childNodes(node).length)
  }
}

function output(fileName: string, bytes: Uint8Array) {
  const dir = process.env.RULES_PROOF_DIR
  if (!dir) return
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, fileName), bytes)
}

function checked(input: Uint8Array, edits: RulesEdit[], changed: string[], proof?: string) {
  const result = patchRules(input, edits)
  const before = readZip(input),
    after = readZip(result.bytes)
  expect([...result.report.partsChanged].sort()).toEqual([...changed].sort())
  expect([...before.byName.keys()]).toEqual([...after.byName.keys()])
  if (!changed.length) expect(result.bytes).toBe(input)
  for (const entry of before.entries) {
    if (changed.includes(entry.name))
      expect(
        Buffer.from(readEntry(before, entry.name)).equals(readEntry(after, entry.name)),
        entry.name
      ).toBe(false)
    else
      expect(
        localRecord(before, entry).equals(localRecord(after, after.byName.get(entry.name)!)),
        entry.name
      ).toBe(true)
  }
  for (const part of changed) {
    if (part === STYLES) checkOrder(result.bytes, part, STYLE_ORDER)
    if (part === BOOK) checkOrder(result.bytes, part, BOOK_ORDER)
    if (/\/worksheets\/sheet\d+\.xml$/.test(part)) checkOrder(result.bytes, part, SHEET_ORDER)
  }
  if (proof) output(proof, result.bytes)
  return result
}

function resource<T>(bytes: Uint8Array, name: keyof typeof RESOURCE_NAMES): T | undefined {
  const { workbook } = importXlsx(bytes)
  const found = workbook.resources?.find((res) => res.name === RESOURCE_NAMES[name])
  return found && (JSON.parse(found.data) as T)
}
const importedCF = (bytes: Uint8Array, id = 'sheet1') =>
  resource<Record<string, IConditionFormattingRule[]>>(bytes, 'conditionalFormats')?.[id] ?? []
const importedDV = (bytes: Uint8Array, id = 'sheet1') =>
  resource<Record<string, ISheetDataValidationRule[]>>(bytes, 'validations')?.[id] ?? []
const importedFilter = (bytes: Uint8Array, id = 'sheet1') =>
  resource<Record<string, IAutoFilter>>(bytes, 'filters')?.[id]
const importedNames = (bytes: Uint8Array) =>
  resource<Record<string, DefinedName>>(bytes, 'definedNames') ?? {}
const withoutCFIds = (rules: IConditionFormattingRule[]) =>
  rules.map(({ cfId: _id, ...rest }) => rest)
const withoutDVIds = (rules: ISheetDataValidationRule[]) =>
  rules.map(({ uid: _id, ...rest }) => rest)
const withoutNameIds = (names: Record<string, DefinedName> | DefinedName[]) =>
  Object.values(names)
    .map(({ id: _id, ...rest }) => rest)
    .sort((a, b) => (a.name + a.localSheetId).localeCompare(b.name + b.localSheetId))

const operators = [
  'between',
  'notBetween',
  'equal',
  'notEqual',
  'greaterThan',
  'greaterThanOrEqual',
  'lessThan',
  'lessThanOrEqual'
] as const
const periods = [
  'today',
  'yesterday',
  'tomorrow',
  'last7Days',
  'thisWeek',
  'lastWeek',
  'nextWeek',
  'thisMonth',
  'lastMonth',
  'nextMonth'
]
const richStyle: IStyleData = {
  bl: 1,
  it: 1,
  ul: { s: 1 },
  st: { s: 1 },
  cl: { rgb: '#AA2200' },
  bg: { rgb: '#FFD966' },
  bd: { l: { s: 1, cl: { rgb: '#334455' } }, b: { s: 7, cl: { rgb: '#663377' } } }
}
const highlight = (
  subType: string,
  props: Record<string, unknown> = {},
  style: IStyleData = richStyle
) => ({ type: 'highlightCell', subType, style, ...props }) as IConditionFormattingRule['rule']
const asConfig = (config: Record<string, unknown>) =>
  config as unknown as IConditionFormattingRule['rule']

const configs = [
  ...operators.map((operator) =>
    highlight('number', {
      operator,
      value: ['between', 'notBetween'].includes(operator) ? [4, 12] : 6
    })
  ),
  ...['containsText', 'notContainsText', 'beginsWith', 'endsWith'].map((operator) =>
    highlight('text', { operator, value: 'k"*?' })
  ),
  ...['containsBlanks', 'notContainsBlanks', 'containsErrors', 'notContainsErrors'].map(
    (operator) => highlight('text', { operator, value: '' })
  ),
  ...periods.map((operator) => highlight('timePeriod', { operator })),
  highlight('rank', { isBottom: false, isPercent: false, value: 5 }),
  highlight('rank', { isBottom: true, isPercent: false, value: 3 }),
  highlight('rank', { isBottom: false, isPercent: true, value: 20 }),
  highlight('rank', { isBottom: true, isPercent: true, value: 25 }),
  ...['greaterThan', 'greaterThanOrEqual', 'lessThan', 'lessThanOrEqual'].map((operator) =>
    highlight('average', { operator })
  ),
  highlight('duplicateValues'),
  highlight('uniqueValues'),
  highlight('formula', { value: '=AND($A2>0,MOD(ROW(),2)=0)' }),
  asConfig({
    type: 'colorScale',
    config: [
      { index: 0, color: '#FF0000', value: { type: 'min' } },
      { index: 1, color: '#00FF00', value: { type: 'max' } }
    ]
  }),
  asConfig({
    type: 'colorScale',
    config: [
      { index: 0, color: '#FF0000', value: { type: 'num', value: 0 } },
      { index: 1, color: '#FFFF00', value: { type: 'percentile', value: 50 } },
      { index: 2, color: '#00FF00', value: { type: 'formula', value: '=MAX($A$2:$A$28)' } }
    ]
  }),
  asConfig({
    type: 'dataBar',
    isShowValue: false,
    config: {
      min: { type: 'min' },
      max: { type: 'num', value: 50 },
      isGradient: false,
      positiveColor: '#118844',
      nativeColor: '#abd91a'
    }
  }),
  asConfig({
    type: 'iconSet',
    isShowValue: false,
    config: [67, 33, 0].map((value, i) => ({
      operator: i === 1 ? 'greaterThan' : 'greaterThanOrEqual',
      value: { type: 'percent', value },
      iconType: '3Arrows',
      iconId: String(2 - i)
    }))
  })
]
const newHighlight: IConditionFormattingRule = {
  cfId: 'univer-new-highlight',
  ranges: [range(1, 7, 5, 7)],
  stopIfTrue: false,
  rule: highlight('number', { operator: 'greaterThan', value: 3 }, { it: 1 })
}

const allCF = configs.map((rule, i) => ({
  cfId: `input-${i}`,
  ranges: [range(1, i, 26, i), ...(i === 0 ? [range(1, 42, 5, 42)] : [])],
  stopIfTrue: i === 0,
  rule
}))

const comparisonType = [
  'whole',
  'decimal',
  'date',
  'time',
  'textLength',
  'whole',
  'decimal',
  'textLength'
]
const values = [
  ['1', '21'],
  ['-5', '0.5'],
  ['2026-01-01'],
  ['07:12:00'],
  ['8'],
  ['4'],
  ['4.5'],
  ['12']
]
const allDV: ISheetDataValidationRule[] = [
  {
    uid: 'list',
    type: 'list',
    formula1: 'yes,no,he said "hi"',
    ranges: [range(0, 0)],
    showDropDown: false,
    allowBlank: true,
    showErrorMessage: true,
    errorStyle: 2,
    errorTitle: 'List',
    error: 'Pick an item',
    showInputMessage: true,
    promptTitle: 'Hint',
    prompt: 'Choose & save'
  },
  {
    uid: 'name-list',
    type: 'list',
    formula1: '=Allowed',
    showDropDown: true,
    errorStyle: 1,
    ranges: [range(1, 0)]
  },
  {
    uid: 'range-list',
    type: 'list',
    formula1: '=$A$2:$A$12',
    showDropDown: true,
    errorStyle: 1,
    ranges: [range(2, 0)]
  },
  {
    uid: 'custom',
    type: 'custom',
    formula1: '=AND(ISNUMBER(A4),A4>0)',
    errorStyle: 0,
    ranges: [range(3, 0)]
  },
  ...operators.map((operator, i) => ({
    uid: `validation-${i}`,
    type: comparisonType[i],
    operator: operator as ISheetDataValidationRule['operator'],
    formula1: values[i][0],
    ...(values[i][1] ? { formula2: values[i][1] } : {}),
    errorStyle: 1 as const,
    ranges: [range(4 + i, 0), range(4 + i, 5)]
  }))
]

const proofReadbackCF = allCF.map((model) =>
  model.rule.type === 'dataBar'
    ? {
        ...model,
        rule: { ...model.rule, config: { ...model.rule.config, nativeColor: '#ABD91A' } }
      }
    : model
)
const proofReadbackDV = allDV.map((model) => ({
  ...model,
  showErrorMessage: true,
  formula1: model.type === 'date' ? '46023' : model.type === 'time' ? '0.3' : model.formula1
}))

const allNames: DefinedName[] = [
  {
    name: 'Allowed',
    localSheetId: 'AllDefaultWorkbook',
    formulaOrRefString: 'Data!$A$2:$A$12',
    hidden: true,
    comment: 'Original values'
  },
  {
    name: 'Cutoff',
    formulaOrRefString: '=MAX(Data!$D$2:$D$28)',
    localSheetId: 'sheet1',
    comment: 'Local only'
  },
  { name: 'Cutoff', formulaOrRefString: '=12', localSheetId: 'sheet2' }
]

const allFilter: SheetFilter = {
  ref: range(0, 1, 27, 3),
  filterColumns: [
    { colId: 1, filters: { filters: ['keep'], blank: true } },
    {
      colId: 3,
      customFilters: {
        customFilters: [
          {
            operator: 'greaterThan' as NonNullable<
              NonNullable<IAutoFilter['filterColumns']>[number]['customFilters']
            >['customFilters'][0]['operator'],
            val: 5
          }
        ]
      }
    }
  ],
  cachedFilteredOut: [1],
  sortState: {
    ref: range(1, 1, 27, 3),
    caseSensitive: true,
    conditions: [{ ref: range(1, 3, 27, 3), descending: true }]
  }
}
const proofReadbackNames = allNames.map((model) => {
  if (model.localSheetId !== 'AllDefaultWorkbook') return model
  const { localSheetId: _, ...workbook } = model
  return workbook
})

const extended = (text: string) => text.slice(text.lastIndexOf('<extLst>'))
const reservedNames = (text: string) =>
  text.match(/<definedName name="_xlnm\.[\s\S]*?<\/definedName>/g) ?? []

test('each supported conditional kind, operator, threshold and differential style round-trips', () => {
  const edits = [cf(allCF)]
  const { bytes, report } = checked(base, edits, [SHEET, STYLES])
  expect(withoutCFIds(importedCF(bytes))).toEqual(withoutCFIds(proofReadbackCF))
  expect(report.dxfsAdded).toBe(1)
  expect(xml(bytes, STYLES)).toContain(
    '<dxfs count="2"><dxf><fill><patternFill><bgColor rgb="FF440011"/>'
  )
  const doc = document(bytes)
  const nodes = Array.from(doc.getElementsByTagNameNS(NS, 'cfRule'))
  expect(nodes.map((rule) => Number(rule.getAttribute('priority')))).toEqual(
    allCF.map((_, i) => i + 1)
  )
  expect(
    nodes
      .filter((rule) => rule.hasAttribute('dxfId'))
      .every((rule) => rule.getAttribute('dxfId') === '1')
  ).toBe(true)
  expect(xml(bytes)).toContain('type="notContainsText"')
  expect(xml(bytes)).toContain('operator="notContains"')
  expect(xml(bytes)).toContain('gte="0"')
  const x14 = 'http://schemas.microsoft.com/office/spreadsheetml/2009/9/main'
  const [solid] = Array.from(doc.getElementsByTagNameNS(x14, 'dataBar'))
  // its low end is the lowest value, as the model says (and its high end the model's number): Excel reads autoMin as Automatic, which starts at zero
  expect(Array.from(solid!.getElementsByTagNameNS(x14, 'cfvo')).map((el) => el.getAttribute('type'))).toEqual(['min', 'num'])
  expect(solid.getAttribute('gradient')).toBe('0')
  expect(solid.getElementsByTagNameNS(x14, 'negativeFillColor')[0].getAttribute('rgb')).toBe(
    'FFABD91A'
  )
  const [link] = Array.from(doc.getElementsByTagNameNS(x14, 'id'))
  expect(doc.getElementsByTagNameNS(x14, 'cfRule')[0].getAttribute('id')).toBe(link.textContent)

  checked(bytes, edits, [])
})

test('typed lists, range lists, named lists and every validation kind and operator round-trip', () => {
  const edits = [dv(allDV)]
  const { bytes } = checked(base, edits, [SHEET])
  expect(withoutDVIds(importedDV(bytes))).toEqual(withoutDVIds(proofReadbackDV))
  const vals = Array.from(document(bytes).getElementsByTagNameNS(NS, 'dataValidation'))
  expect(vals[0].getAttribute('showDropDown')).toBe('1')
  expect(vals[0].textContent).toBe('"yes,no,he said ""hi"""')
  expect(vals[1].hasAttribute('showDropDown')).toBe(false)
  expect(vals[1].textContent).toBe('Allowed')
  expect(vals[3].textContent).toBe('AND(ISNUMBER(A4),A4>0)')
  checked(bytes, edits, [])
})

test('all rule models together make the Excel proof workbook and repeat without rewriting', () => {
  const edits = [cf(allCF), dv(allDV), namesEdit(allNames), filt(allFilter)]
  const { bytes } = checked(base, edits, [SHEET, STYLES, BOOK], 'all-rules.xlsx')
  expect(withoutCFIds(importedCF(bytes))).toEqual(withoutCFIds(proofReadbackCF))
  expect(withoutDVIds(importedDV(bytes))).toEqual(withoutDVIds(proofReadbackDV))
  expect(withoutNameIds(importedNames(bytes))).toEqual(withoutNameIds(proofReadbackNames))
  const { sortState: _sort, ...visibleFilter } = allFilter
  expect(importedFilter(bytes)).toEqual(visibleFilter)
  expect(readRules(bytes, 'Data').sheets.Data.filter).toEqual(allFilter)
  expect(xml(bytes)).toContain(
    '<sortState ref="B2:D28" caseSensitive="1"><sortCondition ref="D2:D28" descending="1"/>'
  )
  expect(xml(bytes, BOOK)).toContain(
    `name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">'Data'!$B$1:$D$28`
  )
  checked(bytes, edits, [])
  const dir = process.env.RULES_PROOF_DIR
  if (dir) {
    const rangesOf = (tag: string) =>
      Array.from(document(bytes).getElementsByTagNameNS(NS, tag)).map((el) =>
        el.getAttribute('sqref')
      )
    writeFileSync(
      join(dir, 'all-rules.json'),
      JSON.stringify(
        {
          conditional: allCF.map((model, i) => ({
            sqref: rangesOf('conditionalFormatting')[i],
            ...model
          })),
          validation: allDV.map((model, i) => ({ sqref: rangesOf('dataValidation')[i], ...model })),
          names: allNames,
          filter: allFilter
        },
        null,
        2
      ) + '\n'
    )
  }
})

test('the conditional corpus round-trips while preserving the x14 link, sheet extensions and the other tab', () => {
  const source = file('conditional.xlsx')
  // Add an extension-only record beside the workbook's linked data bar.
  const withOnly = replaceParts(source, {
    [SHEET]: (s) =>
      s.replace(
        '</x14:conditionalFormattings>',
        '<x14:conditionalFormatting xmlns:xm="http://schemas.microsoft.com/office/excel/2006/main">' +
          '<x14:cfRule type="iconSet" priority="99" id="{DA7ABA51-AAAA-BBBB-0001-000000000002}"/>' +
          '<xm:sqref>J2:J41</xm:sqref></x14:conditionalFormatting></x14:conditionalFormattings>'
      )
  })
  const sourceModels = importedCF(source)
  checked(source, [cf(sourceModels, 'Rules')], [])
  const proof = checked(
    source,
    [cf([newHighlight, ...sourceModels], 'Rules')],
    [SHEET, STYLES],
    'conditional-corpus.xlsx'
  )
  expect(withoutCFIds(importedCF(proof.bytes))).toEqual(
    withoutCFIds([newHighlight, ...sourceModels])
  )
  const models = importedCF(withOnly)
  expect(models).toHaveLength(21)
  const edits = [cf(models, 'Rules')]
  const { bytes, report } = checked(withOnly, edits, [])
  expect(withoutCFIds(importedCF(bytes))).toEqual(withoutCFIds(models))
  expect(extended(xml(bytes))).toBe(extended(xml(withOnly)))
  expect(xml(bytes).match(/<x14:id>[^<]+<\/x14:id>/g)).toEqual(
    xml(withOnly).match(/<x14:id>[^<]+<\/x14:id>/g)
  )
  expect(xml(bytes, 'xl/worksheets/sheet2.xml')).toBe(xml(source, 'xl/worksheets/sheet2.xml'))
  expect(report.dxfsAdded).toBe(0)
  checked(bytes, edits, [])
})

test('the validation corpus round-trips and retains its prompt-only rule and container attributes', () => {
  const source = replaceParts(file('validation.xlsx'), {
    [SHEET]: (s) =>
      s.replace('<dataValidations count="513"', '<dataValidations count="513" disablePrompts="1"')
  })
  const models = importedDV(source)
  expect(models).toHaveLength(512)
  checked(source, [dv(models, 'Inputs')], [])
  const edited = models.map((model, i) =>
    i === 0 ? { ...model, prompt: 'Test prompt', showInputMessage: true } : model
  )
  const { bytes } = checked(source, [dv(edited, 'Inputs')], [SHEET], 'validation-corpus.xlsx')
  expect(withoutDVIds(importedDV(bytes))).toEqual(withoutDVIds(edited))
  expect(xml(bytes)).toContain('promptTitle="Hint" prompt="Type anything" sqref="B12"')
  expect(xml(bytes)).toContain('count="513" disablePrompts="1"')
  checked(bytes, [dv(edited, 'Inputs')], [])
  const empty = checked(bytes, [dv([], 'Inputs')], [SHEET])
  expect(document(empty.bytes).getElementsByTagNameNS(NS, 'dataValidation')).toHaveLength(1)
  expect(xml(empty.bytes)).toContain('count="1" disablePrompts="1"')
})

test('x14 validations already present in the importer list are carried without a classic duplicate', () => {
  const source = replaceParts(base, {
    [SHEET]: (s) =>
      s.replace(
        '</worksheet>',
        '<extLst><ext uri="{CCE6A557-97BC-4B89-ADB6-D9C93CAAB3DF}" ' +
          'xmlns:x14="http://schemas.microsoft.com/office/spreadsheetml/2009/9/main" ' +
          'xmlns:xm="http://schemas.microsoft.com/office/excel/2006/main">' +
          '<x14:dataValidations count="1"><x14:dataValidation type="list">' +
          '<x14:formula1><xm:f>$A$2:$A$5</xm:f></x14:formula1><xm:sqref>G6</xm:sqref>' +
          '</x14:dataValidation></x14:dataValidations></ext></extLst></worksheet>'
      )
  })
  const [extension] = importedDV(source)
  expect(extension).toMatchObject({ type: 'list', formula1: '=$A$2:$A$5' })
  const { bytes } = checked(
    source,
    [dv([allDV[0], extension])],
    [SHEET],
    'validation-extension.xlsx'
  )
  expect(withoutDVIds(importedDV(bytes))).toEqual(withoutDVIds([allDV[0], extension]))
  expect(extended(xml(bytes))).toBe(extended(xml(source)))
  expect(Array.from(document(bytes).getElementsByTagNameNS(NS, 'dataValidation'))).toHaveLength(1)
  expect(() => patchRules(source, [dv([{ ...extension, formula1: '=Allowed' }])])).toThrowError(
    /overlaps an Excel extension validation/
  )
})

test('defined names from formulas.xlsx keep sheet scope and the raw LAMBDA when the model stays the same', () => {
  const source = file('formulas.xlsx')
  const models = importedNames(source)
  expect(Object.keys(models)).toHaveLength(6)
  checked(source, [namesEdit(models)], [])
  const newNames = {
    ...models,
    newLocal: {
      name: 'LocalBase',
      formulaOrRefString: '=42',
      localSheetId: 'sheet3',
      comment: 'third scope',
      hidden: true
    }
  }
  const { bytes } = checked(source, [namesEdit(newNames)], [BOOK], 'names-corpus.xlsx')
  expect(withoutNameIds(importedNames(bytes))).toEqual(withoutNameIds(newNames))
  expect(xml(bytes, BOOK)).toContain(
    '<definedName name="DOUBLE">_xlfn.LAMBDA(_xlpm.x,_xlpm.x*2)</definedName>'
  )
  expect(xml(bytes, BOOK)).toContain(
    'name="LocalBase" localSheetId="2" hidden="1" comment="third scope"'
  )
  checked(bytes, [namesEdit(newNames)], [])
})

test('defined-name edits preserve reserved print, filter and future Excel names byte for byte', () => {
  const source = replaceParts(file('protect_print.xlsx'), {
    [BOOK]: (s) =>
      s.replace(
        '</definedNames>',
        '<definedName name="_xlnm.FutureThing" comment="raw">42</definedName>' +
          '<definedName name="_xlnm._FilterDatabase" localSheetId="1" hidden="1">Plain!$A$1:$B$5</definedName></definedNames>'
      )
  })
  const named = allNames.map((item) => ({
    ...item,
    formulaOrRefString: item.formulaOrRefString.replace(/Data!/g, 'Report!')
  }))
  const { bytes } = checked(source, [namesEdit(named)], [BOOK], 'reserved-names.xlsx')
  expect(reservedNames(xml(bytes, BOOK))).toEqual(reservedNames(xml(source, BOOK)))
  expect(withoutNameIds(importedNames(bytes))).toEqual(
    withoutNameIds(
      proofReadbackNames.map((item) => ({
        ...item,
        formulaOrRefString: item.formulaOrRefString.replace(/Data!/g, 'Report!')
      }))
    )
  )
  checked(bytes, [namesEdit(named)], [])
  const empty = checked(bytes, [namesEdit([])], [BOOK])
  expect(reservedNames(xml(empty.bytes, BOOK))).toEqual(reservedNames(xml(source, BOOK)))
  expect(importedNames(empty.bytes)).toEqual({})
})

test('filters round-trip from the lab and update only data rows and their sheet-scoped name', () => {
  const lab = file('patch/filter.xlsx')
  const model = importedFilter(lab)!
  expect(model.ref).toEqual(range(0, 0, 27, 3))
  const { bytes: adopted } = checked(lab, [filt(model)], [BOOK], 'filter-corpus.xlsx')
  expect(importedFilter(adopted)).toEqual(model)
  checked(adopted, [filt(model)], [])

  const source = replaceParts(base, {
    [SHEET]: (s) =>
      s
        .replace('<row r="1"', '<row r="1" hidden="1"')
        .replace('<row r="3"', '<row r="3" hidden="1"')
        .replace('<row r="28"', '<row r="28" hidden="1"')
  })
  const first = {
    ...allFilter,
    ref: range(0, 0, 5, 3),
    cachedFilteredOut: [1],
    sortState: {
      ref: range(1, 0, 5, 3),
      conditions: [{ ref: range(1, 3, 5, 3), descending: true }]
    }
  }
  const { bytes } = checked(source, [filt(first)], [SHEET, BOOK], 'filter-rows.xlsx')
  expect(importedFilter(bytes)?.cachedFilteredOut).toEqual([1])
  expect(xml(bytes)).toMatch(/<row r="1" hidden="1"/)
  expect(xml(bytes)).toMatch(/<row r="28" hidden="1"/)
  expect(xml(bytes)).toMatch(/<row r="3" hidden="1"/)
  expect(xml(bytes)).toContain('<c r="C2"><f>A2*2</f><v>24.69</v></c>')
  checked(bytes, [filt(first)], [])
  const second = { ref: range(0, 0, 5, 3), cachedFilteredOut: [4] }
  const updated = checked(bytes, [filt(second)], [SHEET])
  expect(importedFilter(updated.bytes)?.cachedFilteredOut).toEqual([4])
  expect(xml(updated.bytes)).toContain('<sortState')
  const cleared = checked(updated.bytes, [filt(null)], [SHEET, BOOK])
  expect(importedFilter(cleared.bytes)).toBeUndefined()
  expect(xml(cleared.bytes, BOOK)).not.toContain('_FilterDatabase')
  expect(xml(cleared.bytes)).not.toMatch(/<row r="5"[^>]*hidden/)
  expect(xml(cleared.bytes)).toMatch(/<row r="28" hidden="1"/)
  checked(cleared.bytes, [filt(null)], [])
})

test('a filter appends a missing hidden row in order and retains subsequent implicit coordinates', () => {
  const source = replaceParts(base, {
    [SHEET]: (s) =>
      s.replace(
        /<sheetData>.*?<\/sheetData>/s,
        '<sheetData><row r="1"><c r="A1"><v>1</v></c></row><row r="4"/><row><c t="b"><v>1</v></c></row></sheetData>'
      )
  })
  const model = { ref: range(0, 0, 5, 1), cachedFilteredOut: [2, 4, 5] }
  const { bytes } = checked(source, [filt(model)], [SHEET, BOOK])
  expect(importedFilter(bytes)).toEqual(model)
  expect(xml(bytes)).toContain(
    '<row r="3" hidden="1"/><row r="4"/><row hidden="1"><c t="b"><v>1</v></c></row><row r="6" hidden="1"/>'
  )
  checked(bytes, [filt(model)], [])
})

test('filter outside the table leaves its own filters byte for byte and refuses an overlap', () => {
  const source = file('tables.xlsx')
  const allowed = {
    ref: range(0, 0, 0, 8),
    filterColumns: [{ colId: 0, filters: { filters: ['keep'] } }]
  }
  const { bytes } = checked(
    source,
    [filt(allowed, 'Sales')],
    [SHEET, BOOK],
    'table-safe-filter.xlsx'
  )
  expect(importedFilter(bytes)).toEqual(allowed)
  expect(xml(bytes, 'xl/tables/table1.xml')).toBe(xml(source, 'xl/tables/table1.xml'))
  expect(() => patchRules(source, [filt({ ref: range(1, 1, 8, 5) }, 'Sales')])).toThrowError(
    /overlaps an Excel table/
  )
})

test('unmodelled classic CF and both levels of extension markup keep their original bytes', () => {
  const source = replaceParts(base, {
    [SHEET]: (s) =>
      s
        .replace(
          '</conditionalFormatting>',
          '<cfRule type="cellIs" priority="1"><extLst><ext uri="keep"/></extLst></cfRule></conditionalFormatting>'
        )
        .replace('type="cellIs" priority="1"><extLst', 'type="futureOnly" priority="2"><extLst')
        .replace('</worksheet>', '<extLst><ext uri="keep worksheet"/></extLst></worksheet>')
  })
  const keep = '<cfRule type="futureOnly" priority="2"><extLst><ext uri="keep"/></extLst></cfRule>'
  const { bytes } = checked(source, [cf(allCF.slice(0, 2))], [SHEET, STYLES])
  expect(xml(bytes)).toContain(keep)
  expect(extended(xml(bytes))).toBe(extended(xml(source)))
  expect(
    Array.from(document(bytes).getElementsByTagNameNS(NS, 'cfRule')).map((el) =>
      el.getAttribute('priority')
    )
  ).toEqual(['2', '1', '3'])
  expect(withoutCFIds(importedCF(bytes))).toEqual(withoutCFIds(allCF.slice(0, 2)))
  checked(bytes, [cf(allCF.slice(0, 2))], [])
})

test('rules on prefixed worksheet and style roots keep their prefix and declaration', () => {
  const source = replaceParts(
    base,
    Object.fromEntries(
      [SHEET, STYLES].map((part) => [
        part,
        (text: string) =>
          text
            .replace(/(<\/?)([A-Za-z][A-Za-z0-9]*)(?=[\s/>])/g, '$1m:$2')
            .replace(`xmlns="${NS}"`, `xmlns:m="${NS}"`)
      ])
    )
  )
  const edits = [cf(allCF.slice(0, 1)), dv(allDV.slice(0, 1)), filt({ ref: range(0, 0, 4, 3) })]
  const { bytes } = checked(source, edits, [SHEET, STYLES, BOOK])
  expect(xml(bytes)).toContain('<m:conditionalFormatting')
  expect(xml(bytes)).toContain('<m:dataValidations')
  expect(xml(bytes)).toContain('<m:autoFilter')
  expect(xml(bytes, STYLES)).toContain('<m:dxf><m:font>')
  expect(xml(bytes).split('\n')[0]).toBe(xml(source).split('\n')[0])
  expect(withoutCFIds(importedCF(bytes))).toEqual(withoutCFIds(allCF.slice(0, 1)))
  checked(bytes, edits, [])
})

test('new differential styles are inserted in order and reuse equivalent existing font and fill records', () => {
  const source = replaceParts(base, {
    [STYLES]: (s) =>
      s.replace(
        /<dxfs.*?<\/dxfs>/s,
        '<dxfs count="1"><dxf><font><i val="true"/><b val="1"/></font>' +
          '<fill><patternFill patternType="solid"><bgColor rgb="ffffd966"/></patternFill></fill></dxf></dxfs>'
      )
  })
  const model = {
    ...allCF[0],
    rule: highlight(
      'number',
      { operator: 'equal', value: 6 },
      { bl: 1, it: 1, bg: { rgb: '#FFD966' } }
    )
  }
  const reused = checked(source, [cf([model])], [SHEET])
  expect(reused.report.dxfsAdded).toBe(0)
  expect(xml(reused.bytes)).toContain('dxfId="0"')
  const absent = replaceParts(base, { [STYLES]: (s) => s.replace(/<dxfs.*?<\/dxfs>/s, '') })
  const created = checked(absent, [cf([model])], [SHEET, STYLES])
  expect(created.report.dxfsAdded).toBe(1)
  expect(xml(created.bytes, STYLES)).toContain('</cellStyles><dxfs count="1">')
  checked(created.bytes, [cf([model])], [])
})

test('nested threshold extensions keep their bytes when neighbouring rules change', () => {
  const source = replaceParts(file('conditional.xlsx'), {
    [SHEET]: (s) =>
      s.replace(
        '<cfvo type="min" val="0"/>',
        '<cfvo type="min" val="0"><extLst><ext uri="keep threshold"/></extLst></cfvo>'
      )
  })
  const models = importedCF(source)
  const { bytes } = checked(source, [cf([newHighlight, ...models], 'Rules')], [SHEET, STYLES])
  expect(xml(bytes)).toContain(
    '<cfvo type="min" val="0"><extLst><ext uri="keep threshold"/></extLst></cfvo>'
  )
  expect(withoutCFIds(importedCF(bytes))).toEqual(withoutCFIds([newHighlight, ...models]))
  expect(() => patchRules(bytes, [cf(models.slice(1), 'Rules')])).toThrowError(
    /Keep the rule and its extension together/
  )
})

test('a validation formula edit keeps its worksheet UID and IME setting', () => {
  const seed = patchRules(base, [dv([allDV[3]])]).bytes
  const source = replaceParts(seed, {
    [SHEET]: (s) =>
      s.replace(
        '<dataValidation type="custom"',
        '<dataValidation xmlns:xr="urn:revision" xr:uid="{keep}" imeMode="off" type="custom"'
      )
  })
  const model = { ...importedDV(source)[0], formula1: '=A4>2' }
  const { bytes } = checked(source, [dv([model])], [SHEET])
  expect(xml(bytes)).toContain('xmlns:xr="urn:revision" xr:uid="{keep}" imeMode="off"')
  expect(withoutDVIds(importedDV(bytes))).toEqual(withoutDVIds([model]))
  checked(bytes, [dv([model])], [])
})

test('changing a defined name keeps its hidden flag and escapes comment text once', () => {
  const edit = { name: 'Existing', formulaOrRefString: '=42', hidden: true, comment: 'first' }
  const { bytes } = checked(base, [namesEdit([edit])], [BOOK])
  const next = { name: 'Existing', formulaOrRefString: '=43', comment: '$& &lt; _x005C_' }
  const updated = checked(bytes, [namesEdit([next])], [BOOK])
  expect(Object.values(importedNames(updated.bytes))[0]).toMatchObject({ ...next, hidden: true })
  checked(updated.bytes, [namesEdit([next])], [])
})

describe('refusals give a reason', () => {
  test('active protection, unknown tab and chartsheet', () => {
    const protect = file('protect_print.xlsx')
    for (const edit of [cf([], 'Report'), dv([], 'Report'), filt(null, 'Report')])
      expect(() => patchRules(protect, [edit])).toThrowError(
        /Report.*Unprotect the sheet in Excel first/
      )
    const missing = () => patchRules(base, [cf([], 'Missing')])
    expect(missing).toThrowError(RulesRefused)
    expect(missing).toThrowError(/No worksheet named “Missing”/)
    const chart = replaceParts(base, {
      'xl/_rels/workbook.xml.rels': (s) =>
        s.replace(/\/worksheet(".*?sheet1\.xml")/, '/chartsheet$1')
    })
    expect(() => patchRules(chart, [dv([])])).toThrowError(/a chartsheet/)
  })

  test('bad range, rule limits and formula byte limits', () => {
    expect(() => patchRules(base, [cf([{ ...allCF[0], ranges: [range(-1, 0)] }])])).toThrowError(
      /within the worksheet/
    )
    expect(() => patchRules(base, [dv(Array(2001).fill(allDV[0]))])).toThrowError(
      /at most 2,000 new worksheet rules/
    )
    expect(() =>
      patchRules(base, [dv(Array(1999).fill(allDV[0])), cf(allCF.slice(0, 2))])
    ).toThrowError(/at most 2,000 new worksheet rules/)
    const huge = '=' + 'å'.repeat(32768)
    for (const edit of [
      cf([{ ...allCF[0], rule: highlight('formula', { value: huge }) }]),
      dv([{ ...allDV[3], formula1: huge }]),
      namesEdit([{ ...allNames[0], formulaOrRefString: huge }])
    ])
      expect(() => patchRules(base, [edit])).toThrowError(/exceeds 64 KiB/)
    expect(() => patchRules(base, [dv([{ ...allDV[0], formula1: 'x'.repeat(256) }])])).toThrowError(
      /255 characters/
    )
    expect(() => patchRules(base, [dv([{ ...allDV[0], type: 'checkbox' }])])).toThrowError(
      /validation kind “checkbox”/
    )
    expect(() => patchRules(base, [dv([{ ...allDV[4], formula2: undefined }])])).toThrowError(
      /needs two formulas/
    )
  })

  test('invalid and duplicate scoped names and attempts to edit a reserved name', () => {
    for (const name of ['1Start', 'ABC123', 'R1C1', 'bad name', 'a'.repeat(256)])
      expect(() => patchRules(base, [namesEdit([{ ...allNames[0], name }])])).toThrowError(
        /valid Excel defined name|looks like an Excel cell reference/
      )
    expect(() =>
      patchRules(base, [namesEdit([allNames[0], { ...allNames[0], name: 'aLLOWED' }])])
    ).toThrowError(/duplicated in the same scope/)
    expect(() =>
      patchRules(base, [namesEdit([{ ...allNames[0], name: '_xlnm.Print_Area' }])])
    ).toThrowError(/reserved by Excel/)
    expect(() =>
      patchRules(base, [namesEdit([{ ...allNames[0], localSheetId: 'missing' }])])
    ).toThrowError(/unknown worksheet scope/)
  })

  test('unsupported conditional kinds and invalid scale thresholds are refused', () => {
    expect(() =>
      patchRules(base, [cf([{ ...allCF[0], rule: asConfig({ type: 'sparkline' }) }])])
    ).toThrowError(/rule kind cannot be saved/)
    expect(() =>
      patchRules(base, [cf([{ ...allCF[0], rule: asConfig({ type: 'colorScale', config: [] }) }])])
    ).toThrowError(/two or three indexed stops/)
  })

  test('filter criteria and hidden rows outside the range are refused', () => {
    expect(() =>
      patchRules(base, [filt({ ref: range(0, 0, 5, 1), cachedFilteredOut: [0] })])
    ).toThrowError(/below its header/)
    expect(() =>
      patchRules(base, [
        filt({ ref: range(0, 0, 5, 1), filterColumns: [{ colId: 2, filters: { filters: [] } }] })
      ])
    ).toThrowError(/column is outside the filter range/)
    expect(() =>
      patchRules(base, [
        filt({
          ref: range(0, 0, 5, 1),
          filterColumns: [{ colId: 0, colorFilters: { cellFillColors: ['#FFFFFF'] } }]
        })
      ])
    ).toThrowError(/value filter or a custom comparison/)
  })
})

test('P1 converts Univer date and clock text to serials for both workbook epochs', () => {
  const rules: ValidationRule[] = [
    {
      uid: 'u1',
      type: 'date',
      operator: DataValidationOperator.GREATER_THAN,
      formula1: '2026-01-01',
      ranges: ['E2']
    },
    {
      uid: 'u2',
      type: 'date',
      operator: DataValidationOperator.BETWEEN,
      formula1: '2026-01-01 08:00:00',
      formula2: '2026-12-31 17:00:00',
      ranges: ['E3'],
      bizInfo: { showTime: true }
    },
    {
      uid: 'u3',
      type: 'time',
      operator: DataValidationOperator.BETWEEN,
      formula1: '07:12:00',
      formula2: '5:30 PM',
      ranges: ['E4']
    }
  ]
  const mac = replaceParts(base, {
    [BOOK]: (s) =>
      s.includes('<workbookPr')
        ? s.replace(
            /<workbookPr\b([^>]*?)\s*\/?>/,
            (_, a) => '<workbookPr' + a.replace(/\sdate1904="[^"]*"/, '') + ' date1904="1"/>'
          )
        : s.replace('<bookViews', '<workbookPr date1904="1"/><bookViews')
  })
  for (const [source, delta, proof] of [
    [base, 0, 'validation-dates.xlsx'],
    [mac, 1462, 'validation-1904.xlsx']
  ] as const) {
    const { bytes } = checked(source, [dv(rules)], [SHEET], proof)
    const [date, dateTime, clock] = importedDV(bytes)
    expect(Number(date.formula1)).toBe(46023 - delta)
    expect(Number(dateTime.formula1)).toBeCloseTo(46023 - delta + 8 / 24, 8)
    expect(Number(dateTime.formula2)).toBeCloseTo(46387 - delta + 17 / 24, 8)
    expect(Number(clock.formula1)).toBeCloseTo(0.3, 10)
    expect(Number(clock.formula2)).toBeCloseTo(17.5 / 24, 10)
    expect(xml(bytes)).not.toContain('2026-01-01')
    checked(bytes, [dv(rules)], [])
  }
})

test('P2 and P11 accept Univer workbook scope and Excel name punctuation and use caller sheet IDs', () => {
  const models: DefinedName[] = [
    { name: 'Rate', localSheetId: 'AllDefaultWorkbook', formulaOrRefString: '=Data!$A$1' },
    { name: 'Sales?', localSheetId: '', formulaOrRefString: '=1' },
    { name: 'my\\name', localSheetId: null, formulaOrRefString: '=2' },
    { name: 'x'.repeat(255), formulaOrRefString: '=3' },
    { name: 'Rate', localSheetId: 'custom-b', formulaOrRefString: '=4' }
  ]
  const opts = { sheetIds: ['custom-a', 'custom-b'] }
  const bytes = patchRules(base, [namesEdit(models)], opts).bytes
  const elements = Array.from(
    document(bytes, BOOK).getElementsByTagNameNS(NS, 'definedName')
  ).filter((el) => !el.getAttribute('name')!.startsWith('_xlnm.'))
  expect(elements.map((el) => el.getAttribute('localSheetId'))).toEqual([
    null,
    null,
    null,
    null,
    '1'
  ])
  expect(readRules(bytes, undefined, opts).sheets.Data.id).toBe('custom-a')
  expect(
    Object.values(readRules(bytes, 'Data', opts).names).find((name) => name.localSheetId)
  ).toMatchObject({ name: 'Rate', localSheetId: 'custom-b' })
  expect(patchRules(bytes, [namesEdit(models)], opts).bytes).toBe(bytes)
  for (const name of [
    'TRUE',
    'false',
    'Print_Area',
    'Print_Titles',
    '_FilterDatabase',
    'A1',
    'R1C1',
    'XFD1048576',
    'a b'
  ])
    expect(() => patchRules(base, [namesEdit([{ name, formulaOrRefString: '=1' }])])).toThrow(
      RulesRefused
    )
  expect(() => readRules(bytes, 'Data', { sheetIds: ['same', 'same'] })).toThrow(
    /one distinct Univer ID/
  )
})

test('P3 stores true relative filter column IDs for absolute Univer columns C and D', () => {
  const operator = 'greaterThan' as NonNullable<
    NonNullable<IAutoFilter['filterColumns']>[number]['customFilters']
  >['customFilters'][number]['operator']
  const model: SheetFilter = {
    ref: range(0, 1, 27, 3),
    filterColumns: [
      { colId: 2, customFilters: { customFilters: [{ operator, val: 5 }] } },
      { colId: 3, filters: { filters: ['6'] } }
    ]
  }
  const { bytes } = checked(base, [filt(model)], [SHEET, BOOK], 'relative-filter.xlsx')
  const cols = Array.from(document(bytes).getElementsByTagNameNS(NS, 'filterColumn'))
  expect(cols.map((el) => el.getAttribute('colId'))).toEqual(['1', '2'])
  expect(importedFilter(bytes)).toEqual(model)
  expect(readRules(bytes, 'Data').sheets.Data.filter).toEqual(model)
  expect(() => patchRules(base, [filt({ ...model, filterColumns: [{ colId: 0 }] })])).toThrow(
    /outside the filter range/
  )
})

test('P4 deletes, recolours and moves a linked Excel data bar without rewriting other x14 records', () => {
  const source = file('conditional.xlsx')
  const sourceRules = importedCF(source)
  const bar = sourceRules.findIndex(
    ({ rule, ranges }) => rule.type === 'dataBar' && ranges[0].startColumn === 4
  )
  expect(bar).toBeGreaterThanOrEqual(0)
  const oldXml = xml(source)
  const guid = oldXml.match(/<x14:id>([^<]+)<\/x14:id>/)![1]
  const { bytes: gone } = checked(
    source,
    [
      cf(
        sourceRules.filter((_, i) => i !== bar),
        'Rules'
      )
    ],
    [SHEET],
    'bar-deleted.xlsx'
  )
  expect(xml(gone)).not.toContain(guid)
  const changed = structuredClone(sourceRules)
  const model = changed[bar].rule
  if (model.type !== 'dataBar') throw new Error('Missing data bar')
  model.config.positiveColor = '#FF8800'
  const { bytes: recoloured } = checked(
    source,
    [cf(changed, 'Rules')],
    [SHEET],
    'bar-recoloured.xlsx'
  )
  expect(xml(recoloured)).toContain('<color rgb="FFFF8800"/>')
  // the bar's border, drawn in the bar's old colour, follows it; no blue border is left on an orange bar
  expect(xml(source)).toContain('<x14:borderColor rgb="FF638EC6"/>')
  expect(xml(recoloured)).toContain('<x14:borderColor rgb="FFFF8800"/>')
  expect(xml(recoloured)).not.toContain('<x14:borderColor rgb="FF638EC6"/>')
  expect(xml(recoloured)).toContain(guid)
  expect(withoutCFIds(importedCF(recoloured))).toEqual(withoutCFIds(changed))
  changed[bar].ranges = [range(1, 4, 49, 4)]
  const { bytes: moved } = checked(recoloured, [cf(changed, 'Rules')], [SHEET], 'bar-moved.xlsx')
  expect(xml(moved)).toContain('<xm:sqref>E2:E50</xm:sqref>')
  expect(xml(moved)).toContain(guid)
  expect(withoutCFIds(importedCF(moved))).toEqual(withoutCFIds(changed))
  checked(moved, [cf(changed, 'Rules')], [])
  const bumped = checked(source, [cf([newHighlight, ...sourceRules], 'Rules')], [SHEET, STYLES])
  expect(extended(xml(bumped.bytes))).toBe(extended(oldXml))
  const classic = importedCF(source).find(
    ({ rule, ranges }) => rule.type === 'dataBar' && ranges[0].startColumn !== 4
  )?.rule
  if (classic?.type !== 'dataBar') throw new Error('Missing classic data bar')
  expect(classic.config.nativeColor).toBe(classic.config.positiveColor)
})

test('P5 reads existing F:F and G:G and writes A1 and Univer whole-axis range shapes', () => {
  const originalCF =
    '<conditionalFormatting sqref="F:F"><cfRule type="cellIs" dxfId="0" priority="1" operator="greaterThan"><formula>5</formula></cfRule></conditionalFormatting>'
  const originalDV =
    '<dataValidation type="whole" operator="greaterThan" allowBlank="1" sqref="G:G"><formula1>0</formula1></dataValidation>'
  const source = replaceParts(base, {
    [SHEET]: (s) =>
      s.replace(
        /<conditionalFormatting.*?<\/conditionalFormatting>/s,
        originalCF + '<dataValidations count="1">' + originalDV + '</dataValidations>'
      )
  })
  const fromFileCF = importedCF(source)
  const fromFileDV = importedDV(source)
  expect(fromFileCF[0].ranges).toContainEqual(range(0, 5, 1_048_575, 5))
  expect(fromFileDV[0].ranges).toContainEqual(range(0, 6, 1_048_575, 6))
  const newCF = {
    ...newHighlight,
    ranges: [{ ...range(NaN, 7, NaN, 7), rangeType: RANGE_TYPE.COLUMN }, '3:3']
  }
  const newDV: ValidationRule = {
    uid: 'v',
    type: 'whole',
    operator: DataValidationOperator.GREATER_THAN,
    formula1: '1',
    ranges: [{ ...range(3, NaN, 3, NaN), rangeType: RANGE_TYPE.ROW }, 'I:I']
  }
  const { bytes } = checked(
    source,
    [cf([...fromFileCF, newCF]), dv([...fromFileDV, newDV])],
    [SHEET, STYLES],
    'whole-axis.xlsx'
  )
  expect(xml(bytes)).toContain(originalCF)
  expect(xml(bytes)).toContain(originalDV)
  expect(xml(bytes)).toContain('sqref="H:H 3:3"')
  expect(xml(bytes)).toContain('sqref="4:4 I:I"')
  expect(importedCF(bytes)[1].ranges).toEqual([range(0, 7, 1_048_575, 7), range(2, 0, 2, 16_383)])
  expect(importedDV(bytes)[1].ranges).toEqual([range(3, 0, 3, 16_383), range(0, 8, 1_048_575, 8)])
  checked(bytes, [cf([...fromFileCF, newCF]), dv([...fromFileDV, newDV])], [])
})

test('P6–P8 preserve unchanged number format, theme and text-comparison XML beside another edit', () => {
  const dxf =
    '<dxf><font><b val="0"/><u val="double"/><color theme="5" tint="-0.25"/></font><numFmt numFmtId="164" formatCode="0.0%"/>' +
    '<fill><patternFill><bgColor theme="4" tint="0.6"/></patternFill></fill></dxf>'
  const exact =
    '<conditionalFormatting sqref="B2:B28"><cfRule type="cellIs" dxfId="0" priority="1" operator="equal"><formula>"keep"</formula></cfRule></conditionalFormatting>'
  const source = replaceParts(base, {
    [STYLES]: (s) => s.replace(/<dxf>.*?<\/dxf>/s, dxf),
    [SHEET]: (s) => s.replace(/<conditionalFormatting.*?<\/conditionalFormatting>/s, exact)
  })
  const [existing] = importedCF(source)
  expect(existing.rule).toMatchObject({
    subType: 'text',
    operator: 'equal',
    value: 'keep',
    style: { n: { pattern: '0.0%' } }
  })
  const { bytes, report } = checked(
    source,
    [cf([newHighlight, existing])],
    [SHEET, STYLES],
    'conditional-preserved.xlsx'
  )
  expect(report.dxfsAdded).toBe(1)
  expect(xml(bytes, STYLES)).toContain(dxf)
  expect(xml(bytes)).toContain(exact.replace('priority="1"', 'priority="2"'))
  const edited = { ...existing, ranges: [range(1, 1, 26, 1)] }
  const moved = checked(bytes, [cf([newHighlight, edited])], [SHEET])
  expect(xml(moved.bytes, STYLES)).toBe(xml(bytes, STYLES))
  expect(xml(moved.bytes)).toContain('type="cellIs" dxfId="0"')
  const exactModels = ['equal', 'notEqual'].map((operator, i) => ({
    ...newHighlight,
    cfId: 'exact-' + i,
    ranges: [range(i + 1, 10)],
    rule: highlight('text', { operator, value: 'he said "hi"' })
  }))
  const authored = checked(base, [cf(exactModels)], [SHEET, STYLES], 'exact-text.xlsx')
  const notEqual = Array.from(document(authored.bytes).getElementsByTagNameNS(NS, 'cfRule'))[1]
  expect(notEqual.getAttribute('operator')).toBe('notEqual')
  expect(notEqual.textContent).toBe('"he said ""hi"""')
  expect(withoutCFIds(importedCF(authored.bytes))).toEqual(withoutCFIds(exactModels))
})

test('P9 uses Excel prefixes for validation formulas and CF thresholds and reads them back for Univer', () => {
  const configs = [
    highlight('formula', { value: '=XLOOKUP(H2,A:A,B:B)>1' }),
    asConfig({
      type: 'colorScale',
      config: [
        { index: 0, color: '#FF0000', value: { type: 'min' } },
        { index: 1, color: '#00FF00', value: { type: 'formula', value: '=XLOOKUP(H2,A:A,B:B)' } }
      ]
    })
  ].map((rule, i) => ({ ...newHighlight, cfId: 'formula-' + i, ranges: [range(1, 7 + i)], rule }))
  const validations: ValidationRule[] = [
    { uid: 'v', type: 'custom', formula1: '=XLOOKUP(H2,$A$2:$A$9,$B$2:$B$9)>1', ranges: ['I2'] },
    { uid: 'w', type: 'list', formula1: '=UNIQUE($A$2:$A$9)', ranges: ['J2'] },
    {
      uid: 'x',
      type: 'whole',
      operator: DataValidationOperator.BETWEEN,
      formula1: '1',
      formula2: '=XLOOKUP(H2,A:A,B:B)',
      ranges: ['K2']
    }
  ]
  const edits = [
    cf(configs),
    dv(validations),
    namesEdit([{ name: 'Pick', formulaOrRefString: '=XLOOKUP(1,Data!$A$2:$A$9,Data!$B$2:$B$9)' }])
  ]
  const { bytes } = checked(base, edits, [SHEET, STYLES, BOOK], 'formula-rules.xlsx')
  const sheet = xml(bytes)
  expect(sheet).toContain('<formula>_xlfn.XLOOKUP(H2,A:A,B:B)&gt;1</formula>')
  expect(sheet).toContain('<cfvo type="formula" val="_xlfn.XLOOKUP(H2,A:A,B:B)"/>')
  expect(sheet).toContain('<formula1>_xlfn.XLOOKUP(H2,$A$2:$A$9,$B$2:$B$9)&gt;1</formula1>')
  expect(sheet).toContain('<formula1>_xlfn.UNIQUE($A$2:$A$9)</formula1>')
  expect(sheet).toContain('<formula2>_xlfn.XLOOKUP(H2,A:A,B:B)</formula2>')
  expect(xml(bytes, BOOK)).toContain('<definedName name="Pick">_xlfn.XLOOKUP(')
  const before = importedDV(bytes)
  expect(before.map((rule) => rule.formula1)).toEqual(validations.map((rule) => rule.formula1))
  expect(before[2].formula2).toBe(validations[2].formula2)
  expect(withoutCFIds(importedCF(bytes))).toEqual(withoutCFIds(configs))
  checked(bytes, edits, [])
  const legacy = replaceParts(bytes, {
    [SHEET]: (s) => s.replace(/(<dataValidation type="custom") showErrorMessage="1"/, '$1')
  })
  const legacyRule = importedDV(legacy)[0]
  expect(legacyRule.formula1).toBe(validations[0].formula1)
  expect(legacyRule.showErrorMessage).toBeUndefined()
  const original = xml(legacy).match(/<dataValidation type="custom".*?<\/dataValidation>/s)![0]
  const appended = checked(
    legacy,
    [
      dv([
        ...importedDV(legacy),
        {
          uid: 'new',
          type: 'whole',
          operator: DataValidationOperator.GREATER_THAN,
          formula1: '0',
          ranges: ['L2']
        }
      ])
    ],
    [SHEET]
  )
  expect(xml(appended.bytes)).toContain(original)
})

test('P10 enforces Excel validation message lengths and defaults only new rules to enforcement', () => {
  const edited: ValidationRule = {
    uid: 'v',
    type: 'whole',
    operator: DataValidationOperator.GREATER_THAN,
    formula1: '0',
    ranges: ['I2']
  }
  for (const [field, max] of [
    ['promptTitle', 32],
    ['errorTitle', 32],
    ['prompt', 255],
    ['error', 225]
  ] as const) {
    expect(() => patchRules(base, [dv([{ ...edited, [field]: 'x'.repeat(max + 1) }])])).toThrow(
      new RegExp('at most ' + max + ' characters')
    )
    const { bytes } = checked(base, [dv([{ ...edited, [field]: 'x'.repeat(max) }])], [SHEET])
    expect(importedDV(bytes)[0][field]).toHaveLength(max)
  }
  const { bytes } = checked(
    base,
    [dv([edited, { ...edited, uid: 'w', ranges: ['J2'], showErrorMessage: false }])],
    [SHEET]
  )
  expect(importedDV(bytes).map(({ showErrorMessage }) => showErrorMessage)).toEqual([true, false])
})

test('P12 retains a 4,000-rule tab and can add or update one rule', () => {
  const source = file('conditional.xlsx')
  const many = importedCF(source, 'sheet2')
  const MANY = 'xl/worksheets/sheet2.xml'
  expect(many).toHaveLength(4_000)
  checked(source, [cf(many, 'Many')], [])
  const chronological = checked(
    source,
    [cf([...many, newHighlight], 'Many')],
    [MANY, STYLES],
    'many-rules.xlsx'
  )
  expect(importedCF(chronological.bytes, 'sheet2')).toHaveLength(4_001)
  const edited = many.map((rule, i) => (i === 2 ? { ...rule, stopIfTrue: !rule.stopIfTrue } : rule))
  const updated = checked(source, [cf(edited, 'Many')], [MANY])
  expect(withoutCFIds(importedCF(updated.bytes, 'sheet2'))).toEqual(withoutCFIds(edited))
})

test('P15 and P16 preserve manual hiding while shrinking and removing filter-owned rows', () => {
  const hiddenRows = (bytes: Uint8Array) =>
    [...xml(bytes).matchAll(/<row r="(\d+)"[^>]*hidden="1"/g)].map((match) => Number(match[1]))
  const source = replaceParts(base, {
    [SHEET]: (s) => s.replace('<row r="6"', '<row r="6" hidden="1"')
  })
  const filter: SheetFilter = { ref: range(0, 0, 27, 3), cachedFilteredOut: [2, 5, 9, 19] }
  const before = checked(source, [filt(filter)], [SHEET, BOOK])
  expect(hiddenRows(before.bytes)).toEqual([3, 6, 10, 20])
  const rowData = importXlsx(before.bytes).workbook.sheets.sheet1.rowData
  expect(rowData?.[2]?.hd).toBeUndefined()
  expect(rowData?.[5]?.hd).toBe(1)

  expect(readRules(before.bytes, 'Data').sheets.Data.filter?.cachedFilteredOut).toEqual([
    2, 5, 9, 19
  ])
  const shrank = checked(
    before.bytes,
    [filt({ ref: range(0, 0, 11, 3), cachedFilteredOut: [] })],
    [SHEET, BOOK],
    'filter-shrunk.xlsx'
  )
  expect(hiddenRows(shrank.bytes)).toEqual([6])
  const cleared = checked(before.bytes, [filt(null)], [SHEET, BOOK])
  expect(hiddenRows(cleared.bytes)).toEqual([6])
  const legacy = replaceParts(before.bytes, {
    [SHEET]: (s) =>
      s.replace(
        /<extLst><ext[^>]+tc[^>]*>[\s\S]*?<\/ext><\/extLst>|<extLst><ext[^>]*><tc:filterState[^>]*\/>\s*<\/ext><\/extLst>/,
        ''
      )
  })
  expect(xml(legacy)).not.toContain('tc:filterState')
  const explicit = checked(
    legacy,
    [{ kind: 'filter', sheet: 'Data', filter: null, previousFilteredOut: [2, 9, 19] }],
    [SHEET, BOOK]
  )
  expect(hiddenRows(explicit.bytes)).toEqual([6])
  const unknown = checked(legacy, [filt(null)], [SHEET, BOOK])
  expect(hiddenRows(unknown.bytes)).toEqual([3, 6, 10, 20])
})

test('uses the ten formulas read from Excel for every date period', () => {
  const expected = [
    'FLOOR(Q2,1)=TODAY()',
    'FLOOR(R2,1)=TODAY()-1',
    'FLOOR(S2,1)=TODAY()+1',
    'AND(TODAY()-FLOOR(T2,1)<=6,FLOOR(T2,1)<=TODAY())',
    'AND(TODAY()-ROUNDDOWN(U2,0)<=WEEKDAY(TODAY())-1,ROUNDDOWN(U2,0)-TODAY()<=7-WEEKDAY(TODAY()))',
    'AND(TODAY()-ROUNDDOWN(V2,0)>=(WEEKDAY(TODAY())),TODAY()-ROUNDDOWN(V2,0)<(WEEKDAY(TODAY())+7))',
    'AND(ROUNDDOWN(W2,0)-TODAY()>(7-WEEKDAY(TODAY())),ROUNDDOWN(W2,0)-TODAY()<(15-WEEKDAY(TODAY())))',
    'AND(MONTH(X2)=MONTH(TODAY()),YEAR(X2)=YEAR(TODAY()))',
    'AND(MONTH(Y2)=MONTH(EDATE(TODAY(),0-1)),YEAR(Y2)=YEAR(EDATE(TODAY(),0-1)))',
    'AND(MONTH(Z2)=MONTH(EDATE(TODAY(),0+1)),YEAR(Z2)=YEAR(EDATE(TODAY(),0+1)))'
  ]
  const { bytes } = checked(base, [cf(allCF)], [SHEET, STYLES])
  const rules = [...Array.from(document(bytes).getElementsByTagNameNS(NS, 'cfRule'))].filter(
    (el) => el.getAttribute('type') === 'timePeriod'
  )
  expect(rules.map((el) => el.getAttribute('timePeriod'))).toEqual(periods)
  expect(rules.map((el) => el.textContent)).toEqual(expected)
  expect(xml(bytes)).not.toContain('IFERROR')
})

test('readRules returns importer models on demand and keeps worksheet and filter sort states separate', () => {
  const sort = '<sortState ref="A2:A28"><sortCondition ref="A2:A28"/></sortState>'
  const source = replaceParts(base, {
    [SHEET]: (s) => s.replace('</sheetData>', '</sheetData>' + sort),
    'xl/worksheets/sheet2.xml': () => '<unreadableOtherTab/>'
  })
  const { bytes } = checked(
    source,
    [cf(allCF), dv(allDV), namesEdit(allNames), filt(allFilter)],
    [SHEET, STYLES, BOOK]
  )
  const { sheets, names } = readRules(bytes, 'Data')
  expect(Object.keys(sheets)).toEqual(['Data'])
  expect(withoutCFIds(sheets.Data.conditional)).toEqual(withoutCFIds(proofReadbackCF))
  expect(withoutDVIds(sheets.Data.validation)).toEqual(withoutDVIds(proofReadbackDV))
  expect(withoutNameIds(names)).toEqual(withoutNameIds(proofReadbackNames))
  expect(sheets.Data.filter).toEqual(allFilter)
  expect(xml(bytes)).toContain('</autoFilter>' + sort)
  expect(() => readRules(bytes)).toThrow(/missing its worksheet element/)
})

test('appending a rule leaves an unchanged nonconsecutive priority byte for byte', () => {
  const source = replaceParts(base, {
    [SHEET]: (s) => s.replace(/(<cfRule\b[^>]*priority=")1"/, (_, opening) => opening + '9"')
  })
  expect(xml(source)).toMatch(/<cfRule\b[^>]*priority="9"/)
  const prior = importedCF(source)
  checked(source, [cf(prior)], [])
  const raw = xml(source).match(/<conditionalFormatting.*?<\/conditionalFormatting>/s)![0]
  const { bytes } = checked(source, [cf([...prior, newHighlight])], [SHEET, STYLES])
  expect(xml(bytes)).toContain(raw)
  expect(xml(bytes)).toMatch(/<cfRule\b[^>]*priority="10"/)
})

test('moving a bar out of a shared x14 group keeps that group and its local namespaces', () => {
  const extra =
    '<alias:cfRule type="iconSet" priority="99" id="{DA7ABA51-AAAA-BBBB-0001-000000000002}"/>'
  const x14 = 'http://schemas.microsoft.com/office/spreadsheetml/2009/9/main'
  const source = replaceParts(file('conditional.xlsx'), {
    [SHEET]: (s) =>
      s.replace(/<x14:conditionalFormatting\b[\s\S]*?<\/x14:conditionalFormatting>/, (group) =>
        group
          .replace(/x14:/g, 'alias:')
          .replace(
            '<alias:conditionalFormatting',
            '<alias:conditionalFormatting xmlns:alias="' + x14 + '"'
          )
          .replace('<xm:sqref>', extra + '<xm:sqref>')
      )
  })
  const rules = importedCF(source)
  const bar = rules.find(
    (model) => model.rule.type === 'dataBar' && model.ranges[0].startColumn === 4
  )!
  bar.ranges = [range(1, 4, 49, 4)]
  const { bytes } = checked(source, [cf(rules, 'Rules')], [SHEET])
  expect(xml(bytes)).toContain(extra + '<xm:sqref>E2:E41</xm:sqref>')
  expect(xml(bytes)).toContain('<xm:sqref>E2:E50</xm:sqref>')
  expect(document(bytes).getElementsByTagNameNS(x14, 'conditionalFormatting')).toHaveLength(2)
  expect(withoutCFIds(importedCF(bytes))).toEqual(withoutCFIds(rules))
})
