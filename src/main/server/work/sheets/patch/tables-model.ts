import type { ITableJson } from '@univerjs/sheets-table'
import { TableColumnDataTypeEnum } from '@univerjs/sheets-table'
import { boxRef, readRange } from './format-ranges'
import {
  applySplices,
  isOn,
  openTag,
  setNumber,
  valueOf,
  type ElementSpan,
  type Splice
} from './format-xml'
import { lambdaParams, toFileFormula, toUserFormula, tokenize } from './formula'
import { RulePart, inner, tag, xattr, xstring, xunescape } from './rules-xml'
import { escText, removeAttrInTag, setAttrInTag, type Box } from './xml'

export const SML = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
export const TABLE_ORDER = ['autoFilter', 'sortState', 'tableColumns', 'tableStyleInfo', 'extLst']
const COLUMN_ORDER = ['calculatedColumnFormula', 'totalsRowFormula', 'xmlColumnPr', 'extLst']
export const STYLE_FLAGS = [
  'showFirstColumn',
  'showLastColumn',
  'showRowStripes',
  'showColumnStripes'
] as const

export class TablesRefused extends Error {
  override name = 'TablesRefused'
}

export type TableModel = ITableJson & {
  /** Excel table style switches, beside Univer's tableStyleId. */
  options: ITableJson['options'] & Partial<Record<(typeof STYLE_FLAGS)[number], boolean>>
}
export type TableColumn = ITableJson['columns'][number]

export const fold = (name: string) => name.toLowerCase()
export const flag = (value: boolean) => (value ? '1' : '0')
export const headerOn = (model: TableModel) => model.options.showHeader !== false
export const footerOn = (model: TableModel) =>
  model.options.showFooter ?? model.options.hasTotalRow ?? false

export function tableBox(ref: TableModel['range'] | string): Box {
  try {
    if (typeof ref !== 'string' && (ref.startRow > ref.endRow || ref.startColumn > ref.endColumn))
      throw new Error()
    return readRange(ref)
  } catch {
    throw new TablesRefused('A table needs an ordered cell range within the worksheet.')
  }
}

export function defaultColumn(index: number, displayName = `Column${index + 1}`): TableColumn {
  return {
    id: '',
    displayName,
    dataType: TableColumnDataTypeEnum.None,
    formula: '',
    meta: {},
    style: {}
  }
}

/** The table a formula sits in, and every table name the workbook has before and after the edit, folded. */
export interface FormulaContext {
  own: string
  tables: ReadonlySet<string>
}

/** `[@Qty]`, `[@[Unit price]]`, `[@]` and `[@[A]:[B]]` as a file says them, less the table's name. */
function thisRow(bracket: string): string | undefined {
  const at = /^\[\s*@/.exec(bracket)
  if (!at) return undefined
  const inner = bracket.slice(at[0].length, -1).trim()
  if (!inner) return '[#This Row]'
  return inner.startsWith('[') ? `[[#This Row],${inner}]` : `[[#This Row],[${inner}]]`
}

/**
 * A stored formula's table references in the words Excel keeps in a file. Excel shows a person
 * `[@Qty]`, `[Qty]` and a bare `Sales`; its files say `Sales[[#This Row],[Qty]]`, `Sales[Qty]` and
 * `Sales[]`. Real Excel removes a table whose calculated column says `[@Qty]`, reads the same words in
 * a cell as #REF!, and reads a bare table name as #NAME? (SHT4-excel-tables-proof.md).
 */
export function fileReferences(formula: string, { own, tables }: FormulaContext): string {
  const tokens = tokenize(formula)
  const params = lambdaParams(tokens)
  const changes: Splice[] = []
  for (const [i, token] of tokens.entries()) {
    const before = tokens[i - 1],
      after = tokens[i + 1]
    if (token.kind === 'bracket') {
      const named = before?.kind === 'name' && before.end === token.start
      // "[Book.xlsx]Sheet1!A1" names a workbook, not a column.
      if (!named && after?.kind === 'sheet' && after.start === token.end) continue
      // Outside every table a column has no table to belong to: Excel refuses the words itself.
      if (!named && !own) continue
      // Excel's files say `[x@y]` where a person types `[x'@y]`; a name that starts with @ keeps its mark.
      const text = (thisRow(token.text) ?? token.text).replace(/(?<!\[)'@/g, '@')
      if (named && text === token.text) continue
      changes.push({ start: token.start, end: token.end, text: (named ? '' : own) + text })
    } else if (
      token.kind === 'name' &&
      tables.has(fold(token.text)) &&
      !params.has(fold(token.text)) &&
      before?.kind !== 'sheet' &&
      !(after?.kind === 'bracket' && after.start === token.end)
    )
      changes.push({ start: token.end, end: token.end, text: '[]' })
  }
  return changes.length ? applySplices(formula, changes) : formula
}

/** With a table, the formula is written as Excel writes it there; without one, as it was typed. */
export function fileFormula(value: string, table?: FormulaContext): string {
  if (!value.replace(/^\s*=/, '').trim() || Buffer.byteLength(value) > 65_536)
    throw new TablesRefused('A table formula must have content and fit within 64 KiB.')
  const typed = toFileFormula(value)
  const formula = table ? fileReferences(typed, table) : typed
  if (Buffer.byteLength(formula) > 65_536)
    throw new TablesRefused('A table formula must fit within 64 KiB.')
  return formula
}

/** Two formulas a file would hold as the same words: `=[@Qty]*2` and `=Totals[[#This Row],[Qty]]*2`. */
export function sameFormula(
  a: string | undefined,
  b: string | undefined,
  table: FormulaContext
): boolean {
  if (a === b || (!a && !b)) return true
  if (!a || !b) return false
  try {
    return fileFormula(a, table) === fileFormula(b, table)
  } catch {
    return false
  }
}

const TOTAL_FUNCTIONS: Readonly<Record<string, number>> = {
  average: 101,
  countNums: 102,
  count: 103,
  max: 104,
  min: 105,
  stdDev: 107,
  sum: 109,
  var: 110
}

/** One column of a table as Excel writes it in a file: `Sales[It''s]`, `Sales['#Items]`, `Sales[x@y]`. */
function columnRef(name: string) {
  const escaped = name.replace(/[\[\]#']/g, (special) => "'" + special).replace(/^@/, "'@")
  return /^ | $/.test(name) ? `[[${escaped}]]` : `[${escaped}]`
}

export function totalFormula(column: TableColumn, table: FormulaContext): string | undefined {
  const { totalsRowFunction: fn, totalsRowFormula: custom } = column
  if (custom && fn && fn !== 'custom')
    throw new TablesRefused(
      `Choose a custom total or a built-in function for “${column.displayName}”.`
    )
  if (custom) return fileFormula(custom, table)
  if (fn === 'custom')
    throw new TablesRefused(`Give “${column.displayName}” a custom total formula.`)
  if (!fn || fn === 'none') return undefined
  const code = TOTAL_FUNCTIONS[fn]
  if (!code) throw new TablesRefused(`“${fn}” is not an Excel table total function.`)
  return `SUBTOTAL(${code},${table.own}${columnRef(column.displayName)})`
}

function tableStyle(name: string): string {
  const preset = /^table-default-([0-5])$/.exec(name)
  if (preset) return 'TableStyleMedium' + [2, 4, 5, 6, 7, 9][Number(preset[1])]
  const builtin = /^(?:TableStyle(Light|Medium|Dark)([1-9]\d*))$/i.exec(name)
  if (builtin) {
    const family = builtin[1][0].toUpperCase() + builtin[1].slice(1).toLowerCase()
    if (
      Number(builtin[2]) <= ({ Light: 21, Medium: 28, Dark: 11 } as Record<string, number>)[family]
    )
      return 'TableStyle' + family + builtin[2]
  }
  throw new TablesRefused(`“${name}” is not a built-in Excel table style.`)
}

export interface SourceTable {
  file: string
  rid: string
  part: RulePart
  model: TableModel
  id: number
  box: Box
  columns: Map<string, ElementSpan>
}

export function parseTable(xml: string, file: string, rid: string): SourceTable {
  const part = new RulePart(xml, 'table', TABLE_ORDER)
  const root = openTag(xml, part.root)
  const id = Number(valueOf(root, 'id'))
  const name = xattr(root, 'displayName') ?? xattr(root, 'name')
  const ref = valueOf(root, 'ref')
  if (!Number.isInteger(id) || id <= 0 || !name || !ref)
    throw new TablesRefused(`The Excel table part “${file}” has no usable name, ID or range.`)
  const box = tableBox(ref)
  const columnsPart = part.first('tableColumns')
  if (!columnsPart) throw new TablesRefused(`The Excel table “${name}” has no column definitions.`)
  const columns = new Map<string, ElementSpan>()
  const models = new RulePart(xml.slice(columnsPart.start, columnsPart.end), 'tableColumns', [
    'tableColumn'
  ])
  const columnModels = models.siblings
    .filter((el) => el.name === part.prefix + 'tableColumn')
    .map((col, i) => {
      const el = shiftSpan(col, columnsPart.start)
      const a = openTag(xml, el)
      const column = defaultColumn(i, xattr(a, 'name'))
      column.id = 'col' + (valueOf(a, 'id') ?? i + 1)
      if (columns.has(column.id)) throw new TablesRefused(`“${name}” has duplicate column IDs.`)
      columns.set(column.id, el)
      const p = new RulePart(xml.slice(el.start, el.end), 'tableColumn', COLUMN_ORDER)
      const calc = p.first('calculatedColumnFormula')
      if (calc) {
        column.formula = toUserFormula(xunescape(inner(p.xml, calc)))
        if (isOn(valueOf(openTag(p.xml, calc), 'array'))) column.formulaIsArray = true
      }
      const total = p.first('totalsRowFormula')
      if (total) column.totalsRowFormula = toUserFormula(xunescape(inner(p.xml, total)))
      column.totalsRowLabel = xattr(a, 'totalsRowLabel')
      column.totalsRowFunction = valueOf(a, 'totalsRowFunction')
      return column
    })
  const totals = Number(valueOf(root, 'totalsRowCount') ?? 0) > 0
  const options: TableModel['options'] = {
    showHeader: valueOf(root, 'headerRowCount') !== '0',
    showFooter: totals,
    hasTotalRow: totals,
    showAutoFilter: !!part.first('autoFilter')
  }
  const style = part.first('tableStyleInfo')
  if (style) {
    const a = openTag(xml, style)
    const styleId = xattr(a, 'name')
    if (styleId !== undefined) options.tableStyleId = styleId
    for (const key of STYLE_FLAGS) {
      const value = valueOf(a, key)
      if (value !== undefined) options[key] = isOn(value)
    }
  }
  return {
    file,
    rid,
    part,
    id,
    box,
    columns,
    model: {
      id: `table${id}`,
      name,
      options,
      range: {
        startRow: box.r1 - 1,
        endRow: box.r2 - 1,
        startColumn: box.c1 - 1,
        endColumn: box.c2 - 1
      },
      columns: columnModels,
      filters: {},
      meta: {}
    }
  }
}

function shiftSpan(el: ElementSpan, offset: number): ElementSpan {
  return {
    name: el.name,
    start: el.start + offset,
    openEnd: el.openEnd + offset,
    close: el.close + offset,
    end: el.end + offset
  }
}

/** Omitted options are the importer's lossy view. Keep the corresponding source XML. */
export function sameTable(
  model: TableModel,
  source: SourceTable,
  box: Box,
  tables: ReadonlySet<string>
): boolean {
  const prev = source.model
  const table = { own: model.name, tables }
  return (
    model.name === prev.name &&
    boxRef(box) === boxRef(source.box) &&
    headerOn(model) === headerOn(prev) &&
    footerOn(model) === footerOn(prev) &&
    (model.options.showAutoFilter ?? prev.options.showAutoFilter) === prev.options.showAutoFilter &&
    (model.options.tableStyleId || prev.options.tableStyleId) === prev.options.tableStyleId &&
    STYLE_FLAGS.every((key) => (model.options[key] ?? prev.options[key]) === prev.options[key]) &&
    model.columns.length === prev.columns.length &&
    model.columns.every((column, i) => {
      const old = prev.columns[i]
      return (
        column.id === old.id &&
        column.displayName === old.displayName &&
        sameFormula(column.formula, old.formula, table) &&
        column.totalsRowFunction === old.totalsRowFunction &&
        column.totalsRowLabel === old.totalsRowLabel &&
        sameFormula(column.totalsRowFormula ?? old.totalsRowFormula, old.totalsRowFormula, table) &&
        (column.formulaIsArray ?? old.formulaIsArray) === old.formulaIsArray
      )
    })
  )
}

function attr(opening: string, name: string, value: string | undefined) {
  const without = removeAttrInTag(opening, name)
  return value === undefined
    ? without
    : without.replace(/(\s*\/?>)$/, (_, end) => ` ${name}="${xstring(value)}"${end}`)
}

function updateOpening(part: RulePart, el: ElementSpan, opening: string) {
  if (opening !== openTag(part.xml, el))
    part.changes.push({ start: el.start, end: el.openEnd, text: opening })
}

function swapChild(part: RulePart, name: string, text: string) {
  const el = part.first(name)
  if (el) part.replace(el, text)
  else if (text) part.add(name, text)
}

function columnXml(
  prefix: string,
  column: TableColumn,
  table: FormulaContext,
  priorXml?: string,
  prior?: TableColumn
): string {
  const calc = (formula: string) =>
    tag(
      prefix + 'calculatedColumnFormula',
      { array: column.formulaIsArray ? '1' : undefined },
      escText(fileFormula(formula, table))
    )
  const total = (formula: string) =>
    tag(prefix + 'totalsRowFormula', {}, escText(fileFormula(formula, table)))
  const attrs = {
    id: column.id.slice(3),
    name: column.displayName,
    totalsRowFunction: column.totalsRowFormula ? 'custom' : column.totalsRowFunction,
    totalsRowLabel: column.totalsRowLabel
  }
  if (!priorXml)
    return tag(
      prefix + 'tableColumn',
      attrs,
      (column.formula ? calc(column.formula) : '') +
        (column.totalsRowFormula ? total(column.totalsRowFormula) : '')
    )
  const part = new RulePart(priorXml, 'tableColumn', COLUMN_ORDER)
  let opening = openTag(priorXml, part.root)
  for (const [key, value] of Object.entries(attrs)) {
    const old = xattr(opening, key)
    if (value !== old) opening = attr(opening, key, value)
  }
  // Render child insertions before touching the opening of a self-closing column.
  if (
    !sameFormula(column.formula, prior?.formula, table) ||
    column.formulaIsArray !== prior?.formulaIsArray
  )
    swapChild(part, 'calculatedColumnFormula', column.formula ? calc(column.formula) : '')
  if (!sameFormula(column.totalsRowFormula, prior?.totalsRowFormula, table))
    swapChild(
      part,
      'totalsRowFormula',
      column.totalsRowFormula ? total(column.totalsRowFormula) : ''
    )
  const result = part.render()
  const expanded = new RulePart(result, 'tableColumn', COLUMN_ORDER).root
  if (expanded.openEnd !== expanded.end) opening = opening.replace(/\s*\/>$/, '>')
  return opening + result.slice(expanded.openEnd)
}

export function renderTable(
  model: TableModel,
  box: Box,
  id: number,
  source: SourceTable | undefined,
  tables: ReadonlySet<string>
): string {
  const table = { own: model.name, tables }
  const original =
    source?.part.xml ??
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<table xmlns="${SML}" id="${id}" displayName="Table${id}" ref="${boxRef(box)}"></table>`
  const part = new RulePart(original, 'table', TABLE_ORDER)
  const { prefix: p, root } = part
  let opening = openTag(original, root)
  if (source && ['xml', 'queryTable'].includes(valueOf(opening, 'tableType') ?? ''))
    throw new TablesRefused(`Change the linked Excel table “${model.name}” in Excel.`)
  if (!source || model.name !== source.model.name) {
    opening = setAttrInTag(opening, 'displayName', model.name)
    opening = setAttrInTag(opening, 'name', model.name)
  }
  opening = setAttrInTag(opening, 'ref', boxRef(box))
  if (!source || headerOn(model) !== headerOn(source.model))
    opening = attr(opening, 'headerRowCount', headerOn(model) ? undefined : '0')
  if (!source || footerOn(model) !== footerOn(source.model)) {
    opening = attr(opening, 'totalsRowCount', footerOn(model) ? '1' : undefined)
    // Excel marks a table whose total row was never shown. One it showed and hid has no mark, and
    // only then does Excel bring a custom total back when the row is shown again.
    const kept = model.columns.some(
      (column) =>
        column.totalsRowLabel !== undefined ||
        !!column.totalsRowFormula ||
        (!!column.totalsRowFunction && column.totalsRowFunction !== 'none')
    )
    opening = attr(opening, 'totalsRowShown', footerOn(model) || kept ? undefined : '0')
  }
  updateOpening(part, root, opening)

  if (source && boxRef(source.box) !== boxRef(box) && part.first('sortState'))
    throw new TablesRefused(
      `Resize the sorted table “${model.name}” in Excel or clear its sort first.`
    )
  const prevFilter = part.first('autoFilter')
  if (headerOn(model) && (model.options.showAutoFilter ?? (!source || !!prevFilter))) {
    const ref = boxRef({ ...box, r2: box.r2 - Number(footerOn(model)) })
    if (prevFilter) {
      const prior = openTag(original, prevFilter)
      if (valueOf(prior, 'ref') !== ref) {
        const old = tableBox(valueOf(prior, 'ref')!)
        if (
          prevFilter.close !== prevFilter.openEnd &&
          (old.c1 !== box.c1 || old.c2 !== box.c2 || /sortState/.test(inner(original, prevFilter)))
        )
          throw new TablesRefused(
            `Resize the filtered table “${model.name}” in Excel or clear its filter first.`
          )
        updateOpening(part, prevFilter, setAttrInTag(prior, 'ref', ref))
      }
    } else part.add('autoFilter', tag(p + 'autoFilter', { ref }))
  } else if (prevFilter) part.replace(prevFilter, '')

  const cols = part.first('tableColumns')
  const priorColumns = new Map(source?.model.columns.map((column) => [column.id, column]))
  const records = model.columns.map((column) => {
    const el = source?.columns.get(column.id)
    return columnXml(
      p,
      column,
      table,
      el && original.slice(el.start, el.end),
      priorColumns.get(column.id)
    )
  })
  if (cols) {
    const start = setNumber(openTag(original, cols), 'count', records.length)
    const spans = [...source!.columns.values()]
    const changes = spans.map((el, index) => ({
      start: el.start,
      end: el.end,
      text: records[index] ?? ''
    }))
    if (records.length > spans.length)
      changes.push({
        start: cols.close,
        end: cols.close,
        text: records.slice(spans.length).join('')
      })
    const next = new RulePart(original.slice(cols.start, cols.end), 'tableColumns', ['tableColumn'])
    next.changes.push(
      ...changes.map((change) => ({
        start: change.start - cols.start,
        end: change.end - cols.start,
        text: change.text
      }))
    )
    const text = next.render()
    part.replace(cols, start + text.slice(next.root.openEnd))
  } else
    part.add('tableColumns', tag(p + 'tableColumns', { count: records.length }, records.join('')))
  const attrs = model.options
  const wantedStyle = attrs.tableStyleId || undefined
  const oldStyle = part.first('tableStyleInfo')
  if (!source || wantedStyle !== undefined || STYLE_FLAGS.some((key) => attrs[key] !== undefined)) {
    const old = oldStyle ? openTag(original, oldStyle) : undefined
    const oldName = old && xattr(old, 'name')
    const name =
      wantedStyle === undefined
        ? (oldName ?? (source ? undefined : 'TableStyleMedium2'))
        : wantedStyle === oldName
          ? oldName
          : tableStyle(wantedStyle)
    const defaults = {
      showFirstColumn: false,
      showLastColumn: false,
      showRowStripes: true,
      showColumnStripes: false
    }
    const flags = Object.fromEntries(
      STYLE_FLAGS.map((key) => [
        key,
        attrs[key] === undefined
          ? old
            ? valueOf(old, key)
            : flag(defaults[key])
          : flag(attrs[key])
      ])
    )
    if (oldStyle && old) {
      let next = oldName === name ? old : attr(old, 'name', name)
      for (const [key, value] of Object.entries(flags))
        if (valueOf(next, key) !== value) next = attr(next, key, value)
      updateOpening(part, oldStyle, next)
    } else part.add('tableStyleInfo', tag(p + 'tableStyleInfo', { name, ...flags }))
  }

  return part.render()
}
